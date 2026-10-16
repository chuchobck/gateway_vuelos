import { Reloj } from '../../src/common/reloj';

/** Un Reloj que solo avanza cuando la prueba lo pide: sin esperas reales. */
export class RelojDePrueba extends Reloj {
  private actual = new Date('2026-10-16T12:00:00.000Z').getTime();

  override ahora(): Date {
    return new Date(this.actual);
  }

  adelantar(ms: number): void {
    this.actual += ms;
  }

  fijar(fecha: Date): void {
    this.actual = fecha.getTime();
  }
}
