/**
 * Lo mínimo que el gateway le pide a un logger (el de Fastify, pino, lo cumple). Lo que se pasa
 * aquí ya viene limpio: nunca un token, un JWKS, un Authorization ni un cuerpo.
 */
export interface Registro {
  info(mensaje: string): void;
  warn(mensaje: string): void;
  debug(mensaje: string): void;
}
