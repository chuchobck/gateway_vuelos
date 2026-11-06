import { Context, ROOT_CONTEXT, SpanKind, trace, TraceFlags } from '@opentelemetry/api';
import { FastifyBaseLogger } from 'fastify';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { camposDeAcceso } from '../common/acceso';
import { CABECERA_CORRELATION_ID, correlacionDe } from '../common/correlation-id';
import { CONTENT_TYPE_PROBLEMA, ErrorBorde } from '../common/problema';
import { CABECERA_REQUEST_ID, requestIdDe } from '../common/request-id';
import { RUTA_SIN_PLANTILLA } from '../observabilidad/atributos';
import { CABECERA_TRACE_ID } from '../observabilidad/fastify';
import { Metricas } from '../observabilidad/metricas';
import { leerTraceparent } from '../observabilidad/traceparent';
import {
  CLAVE_CORRELATION_ID,
  CLAVE_REQUEST_ID,
  marcarError,
  traceparentDe,
  Trazas,
} from '../observabilidad/trazas';
import { normalizarRuta } from '../rutas/normalizar-ruta';
import { CUERPO_100KB } from '../rutas/tabla-rutas';
import { autorizar } from '../seguridad/autorizar';
import { VerificadorJwks } from '../seguridad/verificador-jwks';
import { MetricasEventos, MOTIVOS_RECHAZO, MotivoRechazo } from './metricas-eventos';
import { ErrorPublicacion, PuenteAmqp } from './puente-amqp';

/** La única ruta del listener: la que el core ya usa contra el notifier (NOTIFIER_URL). */
export const RUTA_EVENTOS = '/internal/v1/events';

/** El scope que identity da al cliente OAuth del core (mismo nombre que exige el notifier). */
export const SCOPE_PUBLICAR_EVENTOS = 'events:publish';

/** Lo que se le dice al core cuando el broker no puede: él reintenta pasado este tiempo. */
const REINTENTAR_EN_SEGUNDOS = 5;

/** `eventType` es la routing key: letras, dígitos y `. _ : -` (sin comodines ni espacios). */
const FORMATO_TIPO = /^[A-Za-z0-9._:-]{1,255}$/;
/** `eventId` es el messageId: un texto corto sin caracteres de control. */
// eslint-disable-next-line no-control-regex
const FORMATO_ID = /^[^\u0000-\u001f\u007f]{1,255}$/;

/** El `operationId` de la línea de acceso (no hay contrato OpenAPI para esta ruta interna). */
const OPERACION = 'publishEvent';

export interface DependenciasServidorEventos {
  puente: PuenteAmqp;
  verificador: VerificadorJwks;
  trazas: Trazas;
  metricas: Metricas;
  metricasEventos: MetricasEventos;
  registro: FastifyBaseLogger;
  /** `service.name`, para la línea de acceso. */
  servicio: string;
  cuerpoMaximo?: number;
}

/**
 * El listener interno de eventos: HTTP → AMQP, y nada más. Recibe el sobre que el core publicaba
 * al notifier (POST /internal/v1/events) y lo deja, byte a byte, en el exchange topic de RabbitMQ.
 * No valida el `data`, no decide a quién va el evento y no conoce las suscripciones: del cuerpo
 * solo mira lo que necesita para traducir (`eventId` y `eventType`).
 *
 * Va en su propio puerto (EVENTOS_PUERTO), igual que /metrics: el ingress no lo expone. En el
 * puerto público, /internal/** sigue siendo 404 (RUTAS_BLOQUEADAS), sin cambios.
 */
export class ServidorEventos {
  private readonly servidor: Server;
  private readonly cuerpoMaximo: number;

  constructor(private readonly deps: DependenciasServidorEventos) {
    this.cuerpoMaximo = deps.cuerpoMaximo ?? CUERPO_100KB;
    this.servidor = createServer((peticion, respuesta) => {
      this.atender(peticion, respuesta).catch(() => {
        // atender() responde sus propios errores; esto es lo que no debería pasar nunca
        respuesta.destroy();
      });
    });
    // El cuerpo es de 100 kB como mucho: quien tarda más de 30 s en mandarlo no lo manda
    this.servidor.requestTimeout = 30_000;
    this.servidor.headersTimeout = 10_000;
  }

  escuchar(puerto: number, host: string): Promise<void> {
    return new Promise((listo, fallo) => {
      this.servidor.once('error', fallo);
      this.servidor.listen(puerto, host, () => {
        this.servidor.off('error', fallo);
        listo();
      });
    });
  }

  direccion(): AddressInfo | null {
    const direccion = this.servidor.address();
    return direccion !== null && typeof direccion === 'object' ? direccion : null;
  }

  async cerrar(): Promise<void> {
    if (!this.servidor.listening) return;
    this.servidor.closeAllConnections();
    await new Promise<void>((listo) => this.servidor.close(() => listo()));
  }

  private async atender(peticion: IncomingMessage, respuesta: ServerResponse): Promise<void> {
    const { trazas, metricas, registro } = this.deps;
    const inicio = process.hrtime.bigint();
    const requestId = requestIdDe(peticion.headers[CABECERA_REQUEST_ID]);
    const correlationId = correlacionDe(peticion.headers[CABECERA_CORRELATION_ID]);
    const metodo = peticion.method ?? 'GET';

    // Quien llama es un servicio Quinde por la red interna (el puerto no sale del ingress): se
    // continúa su traza aunque el gateway público no confíe en el traceparent de los clientes
    const padre = contextoPadre(peticion.headers.traceparent);
    const span = trazas.iniciar(
      metodo,
      SpanKind.SERVER,
      {
        'http.request.method': metodo,
        'quinde.request_id': requestId,
        'quinde.correlation_id': correlationId,
      },
      padre,
    );
    const contexto = trace
      .setSpan(padre, span)
      .setValue(CLAVE_REQUEST_ID, requestId)
      .setValue(CLAVE_CORRELATION_ID, correlationId);

    let status = 500;
    let motivo: string | undefined;
    // La plantilla de la ruta, apenas se sabe cuál es (si no coincide con ninguna: __unmatched__)
    const estado: { ruta?: string } = {};
    await trazas.enContexto(contexto, async () => {
      try {
        const cuerpo = await this.procesar(peticion, correlationId, estado);
        status = 202;
        this.deps.metricasEventos.publicados.inc();
        this.responder(respuesta, 202, cuerpo, requestId, correlationId, span);
      } catch (error) {
        const errorBorde = error instanceof ErrorBorde ? error : this.imprevisto(error);
        status = errorBorde.status;
        motivo = errorBorde.motivo;
        if (motivo !== undefined && esMotivoConocido(motivo)) {
          this.deps.metricasEventos.rechazar(motivo);
        }
        // Un cuerpo que no se leyó entero: la conexión no se reutiliza
        if (status === 413) respuesta.setHeader('connection', 'close');
        const cabeceras: Record<string, string> = { ...errorBorde.cabeceras };
        respuesta.statusCode = status;
        for (const [nombre, valor] of Object.entries(cabeceras)) respuesta.setHeader(nombre, valor);
        this.responder(
          respuesta,
          status,
          JSON.stringify(errorBorde.problema()),
          requestId,
          correlationId,
          span,
          CONTENT_TYPE_PROBLEMA,
        );
      }
      const segundos = Number(process.hrtime.bigint() - inicio) / 1e9;
      const ruta = estado.ruta;
      const plantilla = ruta ?? RUTA_SIN_PLANTILLA;
      span.updateName(`${metodo} ${plantilla}`);
      span.setAttributes({ 'http.route': plantilla, 'http.response.status_code': status });
      if (status >= 500) marcarError(span, String(status));
      span.end();
      metricas.registrarServidor(metodo, ruta, status, segundos);
      // Nada del cuerpo ni del evento: ni eventId, ni eventType, ni data
      registro.info(
        {
          ...camposDeAcceso(
            this.deps.servicio,
            correlationId,
            requestId,
            ruta === undefined ? null : OPERACION,
            status,
            segundos * 1000,
          ),
          metodo,
          ruta: plantilla,
          upstream: 'rabbitmq',
          ...(motivo ? { motivo } : {}),
        },
        'acceso',
      );
    });
  }

  /**
   * Del primer byte a la confirmación del broker. Devuelve el cuerpo de la 202 y deja en `estado`
   * la plantilla de la ruta cuando la resuelve; cualquier fallo es un ErrorBorde con su motivo
   * (de la lista cerrada de las métricas).
   */
  private async procesar(
    peticion: IncomingMessage,
    correlationId: string,
    estado: { ruta?: string },
  ): Promise<string> {
    const { trazas, verificador, puente } = this.deps;

    // 1. Ruta y método
    let clave: string;
    try {
      clave = normalizarRuta(peticion.url ?? '/').clave;
    } catch {
      throw new ErrorBorde(400, 'The request path is ambiguous or malformed', {
        motivo: 'invalid_path',
      });
    }
    if (clave !== RUTA_EVENTOS) {
      throw new ErrorBorde(404, 'No route matches the request', { motivo: 'not_found' });
    }
    estado.ruta = RUTA_EVENTOS;
    if (peticion.method !== 'POST') {
      throw new ErrorBorde(405, 'Method not allowed', {
        motivo: 'method_not_allowed',
        cabeceras: { Allow: 'POST' },
      });
    }

    // 2. Token: de un cliente OAuth (client_credentials) con events:publish
    const spanAuth = trazas.iniciar('auth.verify', SpanKind.INTERNAL, {
      'quinde.auth.mode': 'token',
    });
    try {
      const identidad = await trazas.conSpan(spanAuth, () =>
        autorizar(
          { modo: 'token', alternativas: [[SCOPE_PUBLICAR_EVENTOS]] },
          peticion.headers.authorization,
          verificador,
        ),
      );
      // El token de una persona no publica aunque traiga el scope (igual que el notifier)
      if (identidad?.clienteId === undefined) {
        throw new ErrorBorde(403, 'Only OAuth clients can publish events', {
          motivo: 'insufficient_scope',
        });
      }
    } catch (error) {
      if (error instanceof ErrorBorde) marcarError(spanAuth, error.motivo ?? 'invalid_token');
      throw error;
    } finally {
      spanAuth.end();
    }

    // 3. Lo mínimo para traducir: tipo de contenido, tamaño, JSON y los dos campos
    if (!esJson(peticion.headers['content-type'])) {
      throw new ErrorBorde(415, 'The request body must be application/json', {
        motivo: 'content_type',
      });
    }
    const declarado = Number(peticion.headers['content-length'] ?? 0);
    if (declarado > this.cuerpoMaximo) {
      throw new ErrorBorde(413, 'The request body is too large', { motivo: 'too_large' });
    }
    const contenido = await leerCuerpo(peticion, this.cuerpoMaximo);
    const { eventId, eventType } = leerSobre(contenido);

    // 4. Publicar los MISMOS bytes y esperar la confirmación del broker
    const spanPublicacion = trazas.iniciar(`PUBLISH ${puente.exchange}`, SpanKind.PRODUCER, {
      'quinde.upstream': 'rabbitmq',
      'quinde.correlation_id': correlationId,
    });
    try {
      await puente.publicar({
        routingKey: eventType,
        contenido,
        messageId: eventId,
        correlationId,
        traceparent: traceparentDe(spanPublicacion),
      });
    } catch (error) {
      const falla = error instanceof ErrorPublicacion ? error : new ErrorPublicacion('unavailable');
      marcarError(spanPublicacion, falla.kind === 'timeout' ? 'timeout' : 'unavailable');
      throw errorDeBroker(falla);
    } finally {
      spanPublicacion.end();
    }
    return JSON.stringify({ status: 'ACCEPTED' });
  }

  private imprevisto(error: unknown): ErrorBorde {
    // El log lleva el tipo del error, no su mensaje (podría traer la URL del broker)
    this.deps.registro.error(
      { err: error instanceof Error ? { type: error.name } : { type: typeof error } },
      'Error no controlado en el listener de eventos',
    );
    return new ErrorBorde(500, 'Internal error', { motivo: 'internal_error' });
  }

  private responder(
    respuesta: ServerResponse,
    status: number,
    cuerpo: string,
    requestId: string,
    correlationId: string,
    span: ReturnType<Trazas['iniciar']>,
    tipo = 'application/json',
  ): void {
    respuesta.statusCode = status;
    respuesta.setHeader('content-type', tipo);
    respuesta.setHeader('cache-control', 'no-store');
    respuesta.setHeader('x-content-type-options', 'nosniff');
    respuesta.setHeader(CABECERA_REQUEST_ID, requestId);
    respuesta.setHeader(CABECERA_CORRELATION_ID, correlationId);
    respuesta.setHeader(CABECERA_TRACE_ID, span.spanContext().traceId);
    respuesta.setHeader('content-length', Buffer.byteLength(cuerpo));
    respuesta.end(cuerpo);
  }
}

function esMotivoConocido(motivo: string): motivo is MotivoRechazo {
  return (MOTIVOS_RECHAZO as readonly string[]).includes(motivo);
}

/** El broker no pudo: 503 con Retry-After para que el core reintente. */
function errorDeBroker(falla: ErrorPublicacion): ErrorBorde {
  const motivo: Record<ErrorPublicacion['kind'], MotivoRechazo> = {
    unavailable: 'broker_unavailable',
    timeout: 'broker_timeout',
    rejected: 'broker_rejected',
    unroutable: 'unroutable',
  };
  return new ErrorBorde(503, 'The event bus did not confirm the event; retry later', {
    motivo: motivo[falla.kind],
    cabeceras: { 'Retry-After': String(REINTENTAR_EN_SEGUNDOS) },
  });
}

/** `application/json`, con o sin parámetros; el `charset`, si viene, tiene que ser utf-8. */
function esJson(valor: string | undefined): boolean {
  if (valor === undefined) return false;
  const [tipo, ...parametros] = valor.split(';').map((parte) => parte.trim().toLowerCase());
  if (tipo !== 'application/json') return false;
  return parametros.every((p) => !p.startsWith('charset=') || p === 'charset=utf-8');
}

/** Lee el cuerpo entero hasta `maximo` bytes; uno más y se corta con 413 sin seguir leyendo. */
async function leerCuerpo(peticion: IncomingMessage, maximo: number): Promise<Buffer> {
  const trozos: Buffer[] = [];
  let total = 0;
  for await (const trozo of peticion as AsyncIterable<Buffer>) {
    total += trozo.length;
    if (total > maximo) {
      peticion.pause();
      throw new ErrorBorde(413, 'The request body is too large', { motivo: 'too_large' });
    }
    trozos.push(trozo);
  }
  return Buffer.concat(trozos);
}

/**
 * Del cuerpo solo se lee lo que hace falta para traducir: que sea JSON bien formado (un objeto) y
 * que traiga `eventId` y `eventType` como texto. El resto (`data`, versiones, dueño) es del
 * notifier. Los bytes que se publican son los recibidos, no esta lectura.
 */
function leerSobre(contenido: Buffer): { eventId: string; eventType: string } {
  let sobre: unknown;
  try {
    const texto = new TextDecoder('utf-8', { fatal: true }).decode(contenido);
    sobre = JSON.parse(texto);
  } catch {
    throw new ErrorBorde(400, 'The request body is not valid JSON', { motivo: 'invalid_json' });
  }
  if (typeof sobre !== 'object' || sobre === null || Array.isArray(sobre)) {
    throw new ErrorBorde(400, 'The request body must be a JSON object', { motivo: 'invalid_json' });
  }
  const { eventId, eventType } = sobre as Record<string, unknown>;
  if (typeof eventId !== 'string' || !FORMATO_ID.test(eventId)) {
    throw new ErrorBorde(400, 'eventId must be a string of 1 to 255 characters', {
      motivo: 'invalid_event',
    });
  }
  if (typeof eventType !== 'string' || !FORMATO_TIPO.test(eventType)) {
    throw new ErrorBorde(400, 'eventType must be a string of letters, digits and . _ : -', {
      motivo: 'invalid_event',
    });
  }
  return { eventId, eventType };
}

/** El contexto de un `traceparent` válido (de otro servicio Quinde); si no, una traza nueva. */
function contextoPadre(traceparent: string | string[] | undefined): Context {
  const leido = leerTraceparent(traceparent);
  if (!leido) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: leido.traceId,
    spanId: leido.parentId,
    traceFlags: leido.muestreado ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  });
}
