import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
  LogController,
} from 'fastify';
import { SpanKind } from '@opentelemetry/api';
import { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import { Writable } from 'node:stream';
import { Cors } from './borde/cors';
import { ipCliente } from './borde/ip-cliente';
import { Limitador } from './borde/limitador';
import { MetricasBorde } from './borde/metricas-borde';
import { CONTENT_TYPE_PROBLEMA, ErrorBorde } from './common/problema';
import { Reloj } from './common/reloj';
import { CABECERA_REQUEST_ID, requestIdDe } from './common/request-id';
import { Configuracion, NombreUpstream, UPSTREAMS } from './config/entorno';
import { cabecerasHaciaCliente, cabecerasHaciaUpstream, hostValido } from './proxy/cabeceras';
import { filtrarAtributos, RUTA_SIN_PLANTILLA } from './observabilidad/atributos';
import {
  CABECERA_TRACE_ID,
  fijarRuta,
  instrumentarFastify,
  observar,
} from './observabilidad/fastify';
import { Metricas } from './observabilidad/metricas';
import { camposDeTraza, marcarError, traceparentDe, Trazas } from './observabilidad/trazas';
import { ClienteUpstream, ErrorUpstream } from './proxy/cliente-upstream';
import { ContratoCore, RUTA_CONTRATO_V2 } from './rutas/contrato-core';
import { normalizarRuta, RutaNormalizada } from './rutas/normalizar-ruta';
import { ResolverRutas } from './rutas/resolver-ruta';
import { ReglaRuta, TABLA_RUTAS } from './rutas/tabla-rutas';
import { saludDeUpstreams } from './salud/salud';
import { autorizar } from './seguridad/autorizar';
import { ClavesJwks } from './seguridad/claves-jwks';
import { Registro } from './seguridad/registro';
import { VerificadorJwks } from './seguridad/verificador-jwks';

/** Lo que el gateway anota de cada petición para su línea de log de acceso. */
interface ContextoPeticion {
  inicio: bigint;
  ip: string;
  upstream?: NombreUpstream | 'gateway';
  /** Por qué el borde respondió él mismo (bloqueada, desconocida, ambigua, token, scope...). */
  motivo?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    contexto: ContextoPeticion;
  }
  interface FastifyInstance {
    /** Trazas y métricas del gateway: main.ts arranca con ellas el servidor de /metrics. */
    observabilidad: { trazas: Trazas; metricas: Metricas };
  }
}

export interface OpcionesApp {
  configuracion: Configuracion;
  reloj?: Reloj;
  contrato?: ContratoCore;
  /** El contrato v2 (/api/v2); por defecto, la copia de contracts/vuelos-openapi-v2.yaml. */
  contratoV2?: ContratoCore;
  /** Solo pruebas: otra tabla (p. ej. para comprobar que el bloqueo de /internal va primero). */
  tabla?: readonly ReglaRuta[];
  /** Solo pruebas: a dónde van los logs (una línea JSON por registro). */
  destinoLogs?: Writable;
  /** Solo pruebas: cada cuánto sale un lote de spans al recolector (ms). */
  esperaLoteMs?: number;
}

const NOT_FOUND = 'No route matches the request';

/**
 * Construye el gateway. Una sola ruta comodín: cada petición pasa, en este orden, por
 *   1. X-Request-Id (genReqId): el del cliente si es un uuid; si no, uno nuevo
 *   2. normalización de la ruta (400 si es ambigua) y preflight de CORS (204)
 *   3. decisión: bloqueada o desconocida (404), o la regla de la tabla
 *   4. límite global por IP y, si la regla lo pide, el estricto (429 con Retry-After)
 *   5. salud del gateway, o: Content-Length sobre el tope de la ruta (413)
 *   6. seguridad de la ruta (401/403/503)
 *   7. reenvío en streaming (502 caído, 504 sin respuesta a tiempo)
 * y en onSend: X-Request-Id, X-Trace-Id, CORS y cabeceras de seguridad en TODA respuesta.
 *
 * Observabilidad (docs/OBSERVABILIDAD.md): un span raíz por petición, activo durante todo su ciclo
 * (los logs llevan su traceId y spanId), uno hijo por la verificación del token y uno por la
 * llamada al upstream, cuyo traceparent viaja hacia él. Las métricas van en otro puerto.
 */
export function construirApp(opciones: OpcionesApp): FastifyInstance {
  const { configuracion } = opciones;
  const reloj = opciones.reloj ?? new Reloj();
  const contrato = opciones.contrato ?? ContratoCore.leer();
  const contratoV2 = opciones.contratoV2 ?? ContratoCore.leer(RUTA_CONTRATO_V2);
  const resolver = new ResolverRutas(
    { v1: contrato, v2: contratoV2 },
    opciones.tabla ?? TABLA_RUTAS,
  );
  const cors = new Cors(configuracion.corsOrigenes);
  const limiteGlobal = new Limitador(
    reloj,
    configuracion.limites.global,
    configuracion.limites.ventanaSegundos,
  );
  const limiteEstricto = new Limitador(
    reloj,
    configuracion.limites.estricto,
    configuracion.limites.estrictoVentanaSegundos,
  );
  const clientes = Object.fromEntries(
    UPSTREAMS.map((nombre) => [
      nombre,
      new ClienteUpstream(nombre, configuracion.upstreams[nombre]),
    ]),
  ) as Record<NombreUpstream, ClienteUpstream>;

  const { observabilidad } = configuracion;
  const trazas = new Trazas({
    servicio: observabilidad.servicio,
    version: observabilidad.version,
    entorno: observabilidad.entorno,
    muestreo: observabilidad.muestreo,
    confiarEntrante: observabilidad.confiarEntrante,
    ...(observabilidad.endpointOtlp ? { endpointOtlp: observabilidad.endpointOtlp } : {}),
    ...(opciones.esperaLoteMs ? { esperaLoteMs: opciones.esperaLoteMs } : {}),
  });
  const metricas = new Metricas(observabilidad);
  const metricasBorde = new MetricasBorde(metricas);

  const app = Fastify({
    logger: opcionesLogger(configuracion.nivelLog, opciones.destinoLogs),
    // La línea de acceso la escribe el hook onResponse, sin URL con query ni cabeceras
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    genReqId: (peticion) => requestIdDe(peticion.headers[CABECERA_REQUEST_ID]),
    // Sin el binding de Fastify: requestId, traceId y spanId los pone el mixin desde el contexto
    // de la petición, en TODA línea (si no, requestId saldría dos veces en las de peticion.log)
    childLoggerFactory: (logger, _bindings, opciones) => logger.child({}, opciones),
    trustProxy: false,
    // El cuerpo no se lee aquí: pasa en streaming al upstream (ver el parser de abajo)
    bodyLimit: 1024 * 1024,
    return503OnClosing: true,
    frameworkErrors: (error, peticion, respuesta) => {
      const problema = new ErrorBorde(400, 'The request path is ambiguous or malformed');
      // Fastify la rechaza antes del gancho onRequest: aquí se abre su traza
      const observacion = observar(trazas, peticion as unknown as FastifyRequest);
      trazas.enContexto(observacion.contexto, () =>
        peticion.log.info(
          { status: 400, ruta: RUTA_SIN_PLANTILLA, motivo: 'url-invalida', err: error },
          'acceso',
        ),
      );
      void (respuesta as unknown as FastifyReply)
        .code(400)
        .header('content-type', CONTENT_TYPE_PROBLEMA)
        .header('x-request-id', peticion.id)
        .header(CABECERA_TRACE_ID, observacion.span.spanContext().traceId)
        .header('x-content-type-options', 'nosniff')
        .send(JSON.stringify(problema.problema()));
    },
  });

  const logger: Registro = {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
    debug: (m) => app.log.debug(m),
  };
  const verificador = new VerificadorJwks(
    new ClavesJwks(configuracion.jwt.jwksUrl, reloj, logger),
    { emisor: configuracion.jwt.emisor, audiencia: configuracion.jwt.audiencia },
    reloj,
    logger,
  );

  app.decorate('observabilidad', { trazas, metricas });
  // Antes que cualquier otro gancho: el span raíz queda activo para todos los que siguen
  instrumentarFastify(app, trazas, metricas);

  // Ningún parser: el cuerpo queda sin leer en la petición y se reenvía tal cual, en streaming
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_peticion, _cuerpo, listo) => listo(null, undefined));

  app.decorateRequest('contexto', null as unknown as ContextoPeticion);

  app.addHook('onRequest', async (peticion) => {
    peticion.contexto = {
      inicio: process.hrtime.bigint(),
      ip: ipCliente(
        peticion.raw.socket.remoteAddress,
        peticion.headers['x-forwarded-for'],
        configuracion.saltosProxy,
      ),
    };
  });

  // En TODA respuesta, propia o del upstream: request id, CORS del gateway y seguridad
  app.addHook('onSend', async (peticion, respuesta, cuerpo) => {
    respuesta.header('x-request-id', peticion.id);
    const origen = peticion.headers.origin;
    for (const [nombre, valor] of Object.entries(cors.respuesta(origen))) {
      respuesta.header(nombre, valor);
    }
    if (origen !== undefined) agregarVary(respuesta, 'Origin');
    respuesta.header('x-content-type-options', 'nosniff');
    if (configuracion.produccion) {
      respuesta.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return cuerpo;
  });

  app.addHook('onResponse', async (peticion, respuesta) => {
    const contexto = peticion.contexto;
    if (!contexto) return; // un error del framework antes de onRequest: ya se registró
    const ms = Number((process.hrtime.bigint() - contexto.inicio) / 1_000_000n);
    // onResponse corre fuera del contexto de la petición: se vuelve a entrar para el traceId
    const registrar = (trabajo: () => void) =>
      peticion.observacion ? trazas.enContexto(peticion.observacion.contexto, trabajo) : trabajo();
    registrar(() =>
      peticion.log.info(
        {
          metodo: peticion.method,
          // La PLANTILLA, nunca la ruta pedida: una ruta cruda puede traer un id de reserva o un correo
          ruta: peticion.observacion?.ruta ?? RUTA_SIN_PLANTILLA,
          upstream: contexto.upstream ?? null,
          status: respuesta.statusCode,
          ms,
          ...(contexto.motivo ? { motivo: contexto.motivo } : {}),
        },
        'acceso',
      ),
    );
  });

  app.setErrorHandler(async (error, peticion, respuesta) => {
    if (error instanceof ErrorBorde) return responderError(respuesta, error);
    // Lo imprevisto: el log lleva el tipo (no el mensaje, que podría traer una URL interna)
    peticion.log.error({ err: error }, 'Error no controlado');
    peticion.contexto.motivo ??= 'error-interno';
    return responderError(respuesta, new ErrorBorde(500, 'Internal error'));
  });

  app.setNotFoundHandler(async (peticion, respuesta) => {
    peticion.contexto.motivo = 'desconocida';
    return responderError(respuesta, new ErrorBorde(404, NOT_FOUND));
  });

  app.all('*', async (peticion, respuesta) => {
    const contexto = peticion.contexto;

    let ruta;
    try {
      ruta = normalizarRuta(peticion.raw.url ?? '');
    } catch (error) {
      contexto.motivo = 'ambigua';
      throw error;
    }

    const decision = resolver.decidir(peticion.method, ruta);
    // La plantilla nombra el span y etiqueta las métricas; sin regla, queda __unmatched__
    if (decision.tipo === 'ruta') fijarRuta(peticion, decision.plantilla);

    if (cors.esPreflight(peticion.method, peticion.headers)) {
      contexto.motivo = 'preflight';
      limitar(limiteGlobal, `g:${contexto.ip}`, contexto, metricasBorde, 'global');
      return respuesta.code(204).headers(cors.preflight(peticion.headers.origin)).send();
    }

    if (decision.tipo !== 'ruta') {
      // /internal/**, lo desconocido y lo que el contrato v2 no declara responden igual: no se
      // revela qué existe detrás
      contexto.motivo = decision.tipo;
      throw new ErrorBorde(404, NOT_FOUND);
    }
    const { regla } = decision;
    contexto.upstream = regla.destino;
    peticion.observacion?.span.setAttributes(
      filtrarAtributos({
        'quinde.upstream': regla.destino,
        'quinde.auth.mode': decision.seguridad.modo,
      }),
    );

    limitar(limiteGlobal, `g:${contexto.ip}`, contexto, metricasBorde, 'global');
    if (regla.limiteEstricto) {
      limitar(
        limiteEstricto,
        // Por ruta de destino: /oauth2/token y /api/v2/oauth2/token comparten el contador
        `e:${regla.rutaUpstream ?? regla.patron}:${contexto.ip}`,
        contexto,
        metricasBorde,
        'estricto',
      );
    }

    if (regla.destino === 'gateway') {
      return responderSalud(peticion, respuesta, ruta.clave);
    }

    const declarado = Number(peticion.headers['content-length'] ?? 0);
    if (declarado > regla.cuerpoMaximo) {
      contexto.motivo = 'cuerpo';
      throw new ErrorBorde(413, 'The request body is too large');
    }

    // Un span por la verificación del token (solo si la ruta lo exige)
    const spanAuth =
      decision.seguridad.modo === 'token'
        ? trazas.iniciar('auth.verify', SpanKind.INTERNAL, {
            'quinde.auth.mode': 'token',
            'quinde.request_id': peticion.id,
          })
        : undefined;
    try {
      const verificar = () =>
        autorizar(decision.seguridad, peticion.headers.authorization, verificador);
      await (spanAuth ? trazas.conSpan(spanAuth, verificar) : verificar());
    } catch (error) {
      if (error instanceof ErrorBorde) {
        contexto.motivo = motivoDeSeguridad(error.status);
        const motivo = error.motivo ?? 'invalid_token';
        metricasBorde.rechazosAuth.inc({ reason: motivo });
        if (spanAuth) marcarError(spanAuth, motivo);
      }
      throw error;
    } finally {
      spanAuth?.end();
    }

    const cliente = clientes[regla.destino];
    // Un span por la llamada al upstream; su traceparent viaja hacia él
    const metodo = peticion.method;
    const spanUpstream = trazas.iniciar(`${metodo} ${decision.plantilla}`, SpanKind.CLIENT, {
      'http.request.method': metodo,
      'http.route': decision.plantilla,
      'quinde.upstream': regla.destino,
      'quinde.request_id': peticion.id,
    });
    const inicioUpstream = process.hrtime.bigint();
    const terminarUpstream = (status: number | 'error') => {
      const segundos = Number(process.hrtime.bigint() - inicioUpstream) / 1e9;
      metricas.registrarCliente(regla.destino, metodo, status, segundos);
      spanUpstream.end();
    };
    const tieneCuerpo = declarado > 0 || peticion.headers['transfer-encoding'] !== undefined;
    let respuestaUpstream: IncomingMessage;
    try {
      respuestaUpstream = await cliente.reenviar({
        metodo: peticion.method,
        rutaYQuery: rutaHaciaUpstream(regla, ruta),
        cabeceras: cabecerasHaciaUpstream(peticion.headers, {
          requestId: peticion.id,
          ipCliente: contexto.ip,
          esquema: esquemaDe(peticion, configuracion.saltosProxy),
          hostPublico: hostValido(peticion.headers.host),
          hostUpstream: cliente.host,
          traceparent: traceparentDe(spanUpstream),
        }),
        cuerpo: tieneCuerpo ? peticion.raw : undefined,
        cuerpoMaximo: regla.cuerpoMaximo,
      });
    } catch (error) {
      const errorBorde = errorDeUpstream(error, contexto, peticion);
      const tipo = tipoDeFalloUpstream(error);
      if (tipo !== undefined) {
        metricasBorde.erroresUpstream.inc({ upstream: regla.destino, kind: tipo });
        marcarError(spanUpstream, tipo);
      }
      terminarUpstream('error');
      throw errorBorde;
    }

    const statusUpstream = respuestaUpstream.statusCode ?? 502;
    spanUpstream.setAttributes(filtrarAtributos({ 'http.response.status_code': statusUpstream }));
    if (statusUpstream >= 500) marcarError(spanUpstream, String(statusUpstream));
    // El span termina cuando termina el cuerpo (un PDF grande cuenta entero)
    respuestaUpstream.once('close', () => terminarUpstream(statusUpstream));

    return respuesta
      .code(statusUpstream)
      .headers(cabecerasHaciaCliente(respuestaUpstream.headers))
      .send(respuestaUpstream);
  });

  async function responderSalud(
    peticion: FastifyRequest,
    respuesta: FastifyReply,
    clave: string,
  ): Promise<FastifyReply> {
    if (peticion.method !== 'GET' && peticion.method !== 'HEAD') {
      throw new ErrorBorde(405, 'Method not allowed', { cabeceras: { Allow: 'GET, HEAD' } });
    }
    respuesta.header('cache-control', 'no-store');
    if (clave === '/health') return respuesta.send({ status: 'UP' });
    if (clave === '/health/ready') {
      return respuesta.send({
        status: 'UP',
        contract: { version: contrato.version, operations: contrato.operaciones.length },
        contractV2: { version: contratoV2.version, operations: contratoV2.operaciones.length },
      });
    }
    return respuesta.send({
      status: 'UP',
      upstreams: await saludDeUpstreams(clientes, peticion.id),
    });
  }

  return app;
}

/**
 * Logs JSON (pino, el de Fastify), uno por línea. Nada de la petición va al log por su cuenta: ni
 * cabeceras (Authorization), ni la URL con su query, ni el cuerpo. De un error, solo su tipo y su
 * código: el mensaje de un error de red trae la URL interna del upstream.
 */
function opcionesLogger(nivel: string, destino?: Writable): FastifyServerOptions['logger'] {
  return {
    level: nivel,
    base: { servicio: 'gateway' },
    // traceId y spanId del span activo en TODA línea escrita durante una petición
    mixin: camposDeTraza,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    serializers: {
      req: () => ({}),
      res: () => ({}),
      err: (error: Error & { code?: unknown }) =>
        ({
          type: error.name,
          ...(typeof error.code === 'string' ? { code: error.code } : {}),
        }) as unknown as { type: string; message: string; stack: string },
    },
    ...(destino ? { stream: destino } : {}),
  };
}

function limitar(
  limitador: Limitador,
  clave: string,
  contexto: ContextoPeticion,
  metricasBorde: MetricasBorde,
  politica: 'global' | 'estricto',
): void {
  const { permitido, reintentarEnSegundos } = limitador.contar(clave);
  if (permitido) return;
  contexto.motivo = 'limite';
  metricasBorde.limitadas.inc({ policy: politica });
  throw new ErrorBorde(429, 'Too many requests; retry later', {
    cabeceras: { 'Retry-After': String(reintentarEnSegundos) },
  });
}

function responderError(respuesta: FastifyReply, error: ErrorBorde): FastifyReply {
  return respuesta
    .code(error.status)
    .headers(error.cabeceras)
    .header('content-type', CONTENT_TYPE_PROBLEMA)
    .header('cache-control', 'no-store')
    .send(JSON.stringify(error.problema()));
}

/** La ruta canónica que se decidió (o la fija de la regla) y la query tal cual. */
function rutaHaciaUpstream(regla: ReglaRuta, ruta: RutaNormalizada): string {
  const destino = regla.rutaUpstream ?? ruta.ruta;
  return ruta.query === '' ? destino : `${destino}?${ruta.query}`;
}

function motivoDeSeguridad(status: number): string {
  if (status === 401) return 'token';
  if (status === 403) return 'scope';
  return 'jwks';
}

/** Un fallo hablando con el upstream, en un error del borde sin su URL ni su mensaje. */
function errorDeUpstream(
  error: unknown,
  contexto: ContextoPeticion,
  peticion: FastifyRequest,
): ErrorBorde {
  if (!(error instanceof ErrorUpstream)) {
    contexto.motivo = 'caido';
    return new ErrorBorde(502, 'The upstream service is not available');
  }
  contexto.motivo = error.tipo;
  if (error.tipo === 'cuerpo-grande') return new ErrorBorde(413, 'The request body is too large');
  peticion.log.warn(
    {
      upstream: contexto.upstream,
      tipo: error.tipo,
      ...(error.codigo ? { codigo: error.codigo } : {}),
    },
    'Fallo del upstream',
  );
  if (error.tipo === 'plazo') {
    return new ErrorBorde(504, 'The upstream service did not respond in time');
  }
  return new ErrorBorde(502, 'The upstream service is not available');
}

/** El tipo de fallo para métricas y spans: unavailable (502) o timeout (504); 413 no cuenta. */
function tipoDeFalloUpstream(error: unknown): 'unavailable' | 'timeout' | undefined {
  if (!(error instanceof ErrorUpstream)) return 'unavailable';
  if (error.tipo === 'plazo') return 'timeout';
  if (error.tipo === 'caido') return 'unavailable';
  return undefined;
}

/**
 * El esquema con que llegó el cliente: con proxies de confianza delante (TLS termina en el
 * ingress), el X-Forwarded-Proto que agregó el más cercano; sin ellos, el del socket.
 */
function esquemaDe(peticion: FastifyRequest, saltos: number): 'http' | 'https' {
  if (saltos > 0) {
    const valor = peticion.headers['x-forwarded-proto'];
    const ultimo = (Array.isArray(valor) ? valor.join(',') : (valor ?? ''))
      .split(',')
      .pop()
      ?.trim()
      .toLowerCase();
    if (ultimo === 'http' || ultimo === 'https') return ultimo;
  }
  return peticion.raw.socket instanceof TLSSocket ? 'https' : 'http';
}

function agregarVary(respuesta: FastifyReply, valor: string): void {
  const actual = respuesta.getHeader('vary');
  const lista = String(actual ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (lista.some((v) => v === '*' || v.toLowerCase() === valor.toLowerCase())) return;
  respuesta.header('vary', [...lista, valor].join(', '));
}
