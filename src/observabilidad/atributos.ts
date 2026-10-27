/**
 * Los únicos atributos que un servicio Quinde pone en un span (docs/OBSERVABILIDAD.md, sección 3).
 * Todo lo demás se descarta aquí, aunque el código lo pida: es la última barrera contra un
 * Authorization, una cookie, un cuerpo, una query, un correo, un id de reserva o una IP en las trazas.
 *
 * - `http.request.method`: el método (de la lista conocida, ver `metodoNormalizado`).
 * - `http.route`: la PLANTILLA de la ruta (`/flights/v1/bookings/{bookingId}`) o `__unmatched__`.
 * - `http.response.status_code`: el status.
 * - `quinde.upstream`: core, bff, identity, notifier (solo el gateway).
 * - `quinde.auth.mode`: publica o token.
 * - `quinde.request_id`: el X-Request-Id (un uuid generado o validado por el servicio).
 * - `quinde.correlation_id`: el X-Correlation-Id (validado o generado, sección 7). Solo en spans
 *   y logs: NUNCA como etiqueta de una métrica (cardinalidad sin tope).
 * - `error.type`: un valor de una lista cerrada (timeout, unavailable, 5xx, invalid_token...).
 */
export const ATRIBUTOS_PERMITIDOS = new Set([
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'quinde.upstream',
  'quinde.auth.mode',
  'quinde.request_id',
  'quinde.correlation_id',
  'error.type',
]);

/** Valores que pueden ir en `error.type`. */
export const TIPOS_DE_ERROR = new Set([
  'timeout',
  'unavailable',
  'invalid_token',
  'missing_token',
  'expired_token',
  'insufficient_scope',
  'jwks_unavailable',
  '500',
  '501',
  '502',
  '503',
  '504',
]);

/** Ruta que no corresponde a ninguna plantilla (404, bloqueada, ambigua): una sola serie. */
export const RUTA_SIN_PLANTILLA = '__unmatched__';

const METODOS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** El método si es uno de los conocidos; si no, `_OTHER` (cardinalidad acotada). */
export function metodoNormalizado(metodo: string): string {
  return METODOS.has(metodo) ? metodo : '_OTHER';
}

type Valor = string | number | boolean;

/** Solo los atributos permitidos, con un valor primitivo; `error.type` solo de la lista cerrada. */
export function filtrarAtributos(
  atributos: Record<string, Valor | undefined>,
): Record<string, Valor> {
  const salida: Record<string, Valor> = {};
  for (const [nombre, valor] of Object.entries(atributos)) {
    if (valor === undefined || !ATRIBUTOS_PERMITIDOS.has(nombre)) continue;
    if (nombre === 'error.type' && !TIPOS_DE_ERROR.has(String(valor))) continue;
    salida[nombre] = valor;
  }
  return salida;
}
