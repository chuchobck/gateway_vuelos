/**
 * La hora del gateway. Quien decide si algo venció (la copia del JWKS, una ventana del límite de
 * peticiones) la pide aquí en lugar de llamar a `new Date()` o `Date.now()`: las pruebas pasan un
 * RelojDePrueba que se puede adelantar, sin esperas reales.
 *
 * Los plazos de red (esperar a un upstream) no son vencimientos: usan temporizadores reales.
 */
export class Reloj {
  ahora(): Date {
    return new Date();
  }
}
