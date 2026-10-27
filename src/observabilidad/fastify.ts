import { Context, Span, SpanKind, trace } from '@opentelemetry/api';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { RUTA_SIN_PLANTILLA, metodoNormalizado } from './atributos';
import { Metricas } from './metricas';
import { CABECERA_CORRELATION_ID, correlacionDe } from '../common/correlation-id';
import { CLAVE_CORRELATION_ID, CLAVE_REQUEST_ID, marcarError, Trazas } from './trazas';

/**
 * El único archivo del módulo atado a Fastify: abre el span raíz de cada petición, lo deja activo
 * durante todo su ciclo, pone X-Trace-Id en la respuesta y, al terminar, cierra el span y registra
 * las métricas del servidor. En un servicio Nest, lo mismo va en un middleware de Express (ver el
 * README del módulo).
 */

/** Lo que la observabilidad sabe de una petición. */
export interface ObservacionPeticion {
  span: Span;
  contexto: Context;
  inicio: bigint;
  /** El X-Correlation-Id de la petición: el recibido si es válido, si no uno generado. */
  correlationId: string;
  /** La plantilla de la ruta, cuando la aplicación la conoce (si no, __unmatched__). */
  ruta?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    observacion: ObservacionPeticion | null;
  }
}

export const CABECERA_TRACE_ID = 'x-trace-id';

/**
 * Abre el span raíz de la petición (o lo devuelve si ya existe). Lo usa el gancho onRequest y,
 * para las peticiones que Fastify rechaza antes de ese gancho (una URL mal formada), el manejador
 * de frameworkErrors.
 */
export function observar(trazas: Trazas, peticion: FastifyRequest): ObservacionPeticion {
  if (peticion.observacion) return peticion.observacion;
  const padre = trazas.contextoEntrante(peticion.headers.traceparent);
  const correlationId = correlacionDe(peticion.headers[CABECERA_CORRELATION_ID]);
  // El nombre definitivo ("METHOD /plantilla") se pone al terminar, cuando se conoce la plantilla
  const span = trazas.iniciar(
    metodoNormalizado(peticion.method),
    SpanKind.SERVER,
    {
      'http.request.method': metodoNormalizado(peticion.method),
      'quinde.request_id': peticion.id,
      'quinde.correlation_id': correlationId,
    },
    padre,
  );
  const observacion: ObservacionPeticion = {
    span,
    // El request id y el correlation id viajan en el contexto: el logger los agrega a cada línea
    contexto: trace
      .setSpan(padre, span)
      .setValue(CLAVE_REQUEST_ID, peticion.id)
      .setValue(CLAVE_CORRELATION_ID, correlationId),
    inicio: process.hrtime.bigint(),
    correlationId,
  };
  peticion.observacion = observacion;
  return observacion;
}

/** La aplicación avisa la plantilla de la ruta en cuanto la decide. */
export function fijarRuta(peticion: FastifyRequest, plantilla: string | undefined): void {
  if (peticion.observacion && plantilla !== undefined) peticion.observacion.ruta = plantilla;
}

/** Registra los ganchos. Va antes que cualquier otro gancho de la aplicación. */
export function instrumentarFastify(
  app: FastifyInstance,
  trazas: Trazas,
  metricas: Metricas,
): void {
  app.decorateRequest('observacion', null);

  // Con callback y no async: `listo()` se llama DENTRO del contexto del span, y todo lo que sigue
  // (ganchos, handler, verificación del token, proxy) corre con él activo, también tras cada await.
  app.addHook('onRequest', (peticion, _respuesta, listo) => {
    const { contexto } = observar(trazas, peticion);
    trazas.enContexto(contexto, listo);
  });

  app.addHook('onSend', async (peticion, respuesta, cuerpo) => {
    const observacion = peticion.observacion;
    if (observacion) {
      respuesta.header(CABECERA_TRACE_ID, observacion.span.spanContext().traceId);
      // En TODA respuesta, también en los errores del borde (contrato v2, §6, regla 2)
      respuesta.header(CABECERA_CORRELATION_ID, observacion.correlationId);
    }
    return cuerpo;
  });

  app.addHook('onResponse', async (peticion, respuesta) => {
    const observacion = peticion.observacion;
    if (!observacion) return;
    const metodo = metodoNormalizado(peticion.method);
    const ruta = observacion.ruta ?? RUTA_SIN_PLANTILLA;
    const status = respuesta.statusCode;
    const { span } = observacion;
    span.updateName(`${metodo} ${ruta}`);
    span.setAttributes({ 'http.route': ruta, 'http.response.status_code': status });
    // En un span de servidor, solo un 5xx es error (un 4xx es culpa del cliente)
    if (status >= 500) marcarError(span, String(status));
    span.end();
    const segundos = Number(process.hrtime.bigint() - observacion.inicio) / 1e9;
    metricas.registrarServidor(metodo, observacion.ruta, status, segundos);
  });

  // Al cerrar la app: lo que quede en la cola sale (con tope de tiempo)
  app.addHook('onClose', async () => {
    await trazas.cerrar();
  });
}
