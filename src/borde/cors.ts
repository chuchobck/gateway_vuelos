/**
 * CORS único, en el borde. Los servicios tienen el suyo, pero detrás del gateway el navegador solo
 * ve este: las cabeceras Access-Control-* que traiga un upstream se borran (si no, quedan
 * duplicadas y el navegador rechaza la respuesta).
 *
 * Sin cookies ni `credentials`: los tokens van en Authorization. Nunca `*`: CORS_ORIGINS es una
 * lista de orígenes exactos.
 */

/**
 * La unión de lo que aceptan hoy los servicios (core: Authorization, Content-Type,
 * Idempotency-Key, X-Device-Fingerprint, X-Request-Id; identity: Authorization, Content-Type,
 * X-Request-Id; BFF: content-type, x-request-id, x-device-fingerprint) más traceparent y
 * tracestate para la fase 7.
 */
export const CABECERAS_PERMITIDAS = [
  'authorization',
  'content-type',
  'idempotency-key',
  'x-request-id',
  'x-device-fingerprint',
  'traceparent',
  'tracestate',
];

export const CABECERAS_EXPUESTAS = ['x-request-id', 'retry-after'];

export const METODOS_PERMITIDOS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Lo que el navegador puede guardar la respuesta del preflight (segundos), como los servicios. */
export const MAX_AGE_PREFLIGHT = 600;

export class Cors {
  private readonly origenes: ReadonlySet<string>;

  constructor(origenes: readonly string[]) {
    this.origenes = new Set(origenes);
  }

  permitido(origen: string | undefined): origen is string {
    return origen !== undefined && this.origenes.has(origen);
  }

  /** Un preflight: OPTIONS con Origin y Access-Control-Request-Method. No llega a ningún upstream. */
  esPreflight(metodo: string, cabeceras: Record<string, unknown>): boolean {
    return (
      metodo === 'OPTIONS' &&
      typeof cabeceras.origin === 'string' &&
      typeof cabeceras['access-control-request-method'] === 'string'
    );
  }

  /** Cabeceras del preflight (204). Con un origen no permitido, ninguna Access-Control-*. */
  preflight(origen: string | undefined): Record<string, string> {
    if (!this.permitido(origen)) return {};
    return {
      'access-control-allow-origin': origen,
      'access-control-allow-methods': METODOS_PERMITIDOS.join(', '),
      'access-control-allow-headers': CABECERAS_PERMITIDAS.join(', '),
      'access-control-max-age': String(MAX_AGE_PREFLIGHT),
    };
  }

  /** Cabeceras de una respuesta normal (propia o de un upstream) para ese origen. */
  respuesta(origen: string | undefined): Record<string, string> {
    if (!this.permitido(origen)) return {};
    return {
      'access-control-allow-origin': origen,
      'access-control-expose-headers': CABECERAS_EXPUESTAS.join(', '),
    };
  }
}
