/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/): leer y escribir `traceparent` y
 * acotar `tracestate`. Funciones puras, sin OpenTelemetry ni framework: se copian tal cual a
 * cualquier servicio.
 */

/** Lo que trae un `traceparent` válido. */
export interface Traceparent {
  traceId: string;
  /** El span del emisor: será el padre del primer span de quien lo recibe. */
  parentId: string;
  /** El bit de muestreo (`01`): el emisor registró su parte de la traza. */
  muestreado: boolean;
}

/**
 * Solo la versión `00`, exacta: `00-<32 hex>-<16 hex>-<2 hex>`, en minúsculas y sin nada más.
 * Es más estricto que la regla de W3C para versiones futuras (que admite campos extra detrás):
 * en el borde, lo que no es exactamente lo que sabemos leer se descarta.
 */
const FORMATO = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const CEROS_TRAZA = '0'.repeat(32);
const CEROS_SPAN = '0'.repeat(16);

/**
 * El `traceparent` recibido, o undefined si falta o no es válido: versión distinta de `00`
 * (incluida `ff`, prohibida), mayúsculas, largo o separadores malos, campos extra, ids en ceros
 * o la cabecera repetida. Nunca lanza: un valor inválido se ignora y la petición sigue.
 */
export function leerTraceparent(valor: string | string[] | undefined): Traceparent | undefined {
  if (typeof valor !== 'string') return undefined;
  const partes = FORMATO.exec(valor.trim());
  if (!partes) return undefined;
  const [, traceId, parentId, banderas] = partes as unknown as [string, string, string, string];
  if (traceId === CEROS_TRAZA || parentId === CEROS_SPAN) return undefined;
  return { traceId, parentId, muestreado: (parseInt(banderas, 16) & 0x01) === 0x01 };
}

/** `00-<traceId>-<spanId>-<01|00>`: lo que se manda a un upstream. */
export function escribirTraceparent(traceId: string, spanId: string, muestreado: boolean): string {
  return `00-${traceId}-${spanId}-${muestreado ? '01' : '00'}`;
}

/** Tope de `tracestate` (W3C, sección 3.3.1.5): 512 caracteres y 32 miembros. */
export const TRACESTATE_MAXIMO_CARACTERES = 512;
export const TRACESTATE_MAXIMO_MIEMBROS = 32;

/**
 * El `tracestate` recibido, tal cual, si cabe en el tope de W3C y solo trae caracteres
 * imprimibles; si no, undefined (se descarta entero: no se recorta ni se reescribe). No se
 * interpreta: es de los proveedores que lo escribieron.
 */
export function tracestateAcotado(valor: string | string[] | undefined): string | undefined {
  if (typeof valor !== 'string' || valor === '') return undefined;
  if (valor.length > TRACESTATE_MAXIMO_CARACTERES) return undefined;
  if (!/^[\x20-\x7e]+$/.test(valor)) return undefined;
  if (valor.split(',').length > TRACESTATE_MAXIMO_MIEMBROS) return undefined;
  return valor;
}
