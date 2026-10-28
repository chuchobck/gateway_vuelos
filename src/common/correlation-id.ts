import { randomUUID } from 'node:crypto';

/**
 * X-Correlation-Id (contrato v2, §6): el id de TODO el proceso de negocio (una compra completa,
 * varias llamadas). En minúsculas, como lo entrega Node.
 */
export const CABECERA_CORRELATION_ID = 'x-correlation-id';

/**
 * Formato aceptado (docs/OBSERVABILIDAD.md, sección 7): de 1 a 100 caracteres (el maxLength del
 * contrato), letras, dígitos, punto, guion, guion bajo y dos puntos; el mismo del core. Lo demás
 * podría falsear una línea de log (saltos de línea, espacios, comillas) o una cabecera de salida.
 */
const FORMATO_VALIDO = /^[A-Za-z0-9._:-]{1,100}$/;

export function esCorrelationIdValido(valor: unknown): valor is string {
  return typeof valor === 'string' && FORMATO_VALIDO.test(valor);
}

/**
 * El que llegó, SIN CAMBIOS, si tiene un formato válido; si falta, no es válido o llega repetido
 * (Node junta dos cabeceras con ", "), uno nuevo: `corr-<uuid>`. Nunca se rechaza la petición
 * por esto: el gateway es el primer servicio y, si el cliente no lo trae, lo genera él.
 */
export function correlacionDe(valor: string | string[] | undefined): string {
  return esCorrelationIdValido(valor) ? valor : `corr-${randomUUID()}`;
}
