import { randomUUID } from 'node:crypto';

/**
 * X-Request-Id aceptable: un uuid (cualquier versión), como el que generan el gateway, el core y
 * los frontends. Otra cosa (vacío, largo, con espacios o caracteres de control) se reemplaza: el
 * id viaja a los logs de todos los servicios y no puede ser un vector de inyección.
 */
const FORMATO_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CABECERA_REQUEST_ID = 'x-request-id';

export function requestIdDe(recibido: string | string[] | undefined): string {
  if (typeof recibido === 'string' && FORMATO_REQUEST_ID.test(recibido)) {
    return recibido;
  }
  return randomUUID();
}
