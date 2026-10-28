/**
 * Los únicos atributos que un servicio Quinde pone en un span (docs/OBSERVABILIDAD.md, sección 3).
 * Todo lo demás se descarta aquí, aunque el código lo pida: es la última barrera contra un
 * Authorization, una cookie, un cuerpo, una query, un correo, un id de reserva o una IP en las trazas.
 *
 * - `http.request.method`: el método (de la lista conocida, ver `metodoNormalizado`).
 * - `http.route`: la PLANTILLA de la ruta (`/flights/v1/bookings/{bookingId}`) o `__unmatched__`.
 * - `http.response.status_code`: el status.
 * - `quinde.upstream`: core, bff, identity, notifier y payments (la Payment API, desde el core).
 * - `quinde.auth.mode`: publica o token.
 * - `quinde.request_id`: el X-Request-Id (un uuid generado o validado por el servicio).
 * - `quinde.correlation_id`: el X-Correlation-Id (validado o generado, sección 7). Solo en spans
 *   y logs: NUNCA como etiqueta de una métrica (cardinalidad sin tope).
 * - `error.type`: un valor de una lista cerrada (timeout, unavailable, 5xx, invalid_token...).
 * - `rpc.system`, `rpc.service`, `rpc.method`, `rpc.grpc.status_code`: una llamada gRPC (el core
 *   la recibe, el BFF la hace). Solo `grpc`, nombres con la forma del proto y un código de 0 a 16.
 * - `graphql.operation.type`: query, mutation o subscription (el BFF).
 *
 * `graphql.root_fields` NO está aquí: su conjunto cerrado es el esquema de cada BFF y lo valida su
 * propio filtro (atributos-bff.ts), que se suma a este.
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
  'rpc.system',
  'rpc.service',
  'rpc.method',
  'rpc.grpc.status_code',
  'graphql.operation.type',
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

type Valor = string | number | boolean;

/**
 * Los atributos cuyo VALOR también se restringe: el nombre solo no basta para que un texto del
 * cliente no termine en una traza. `rpc.service` y `rpc.method` tienen la forma de un nombre del
 * proto (`quinde.flights.v1.FlightsService`, `SearchFlights`); cada servicio los toma de su proto,
 * nunca de la petición.
 */
const VALORES: Record<string, (valor: Valor) => boolean> = {
  'error.type': (v) => TIPOS_DE_ERROR.has(String(v)),
  'rpc.system': (v) => v === 'grpc',
  'rpc.service': (v) =>
    typeof v === 'string' && /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.[A-Z][A-Za-z0-9]{0,63}$/.test(v),
  'rpc.method': (v) => typeof v === 'string' && /^[A-Z][A-Za-z0-9]{0,63}$/.test(v),
  'rpc.grpc.status_code': (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 16,
  'graphql.operation.type': (v) => v === 'query' || v === 'mutation' || v === 'subscription',
};

/** Ruta que no corresponde a ninguna plantilla (404, bloqueada, ambigua): una sola serie. */
export const RUTA_SIN_PLANTILLA = '__unmatched__';

const METODOS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** El método si es uno de los conocidos; si no, `_OTHER` (cardinalidad acotada). */
export function metodoNormalizado(metodo: string): string {
  return METODOS.has(metodo) ? metodo : '_OTHER';
}

/** Solo los atributos permitidos, con un valor primitivo; los de `VALORES`, solo con uno válido. */
export function filtrarAtributos(
  atributos: Record<string, Valor | undefined>,
): Record<string, Valor> {
  const salida: Record<string, Valor> = {};
  for (const [nombre, valor] of Object.entries(atributos)) {
    if (valor === undefined || !ATRIBUTOS_PERMITIDOS.has(nombre)) continue;
    if (VALORES[nombre] && !VALORES[nombre](valor)) continue;
    salida[nombre] = valor;
  }
  return salida;
}
