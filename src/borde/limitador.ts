import { Reloj } from '../common/reloj';

export interface ResultadoLimite {
  permitido: boolean;
  /** Segundos hasta que se abre la ventana siguiente (para Retry-After). */
  reintentarEnSegundos: number;
}

interface Ventana {
  inicio: number;
  cuenta: number;
}

/** Sobre cuántas claves se barren las ventanas vencidas (no crece sin límite). */
const BARRER_CADA = 10_000;

/**
 * Límite de peticiones de ventana fija, en memoria. Es POR RÉPLICA: con dos réplicas del gateway
 * un cliente tiene el doble (docs/DEPLOY.md). Los servicios tienen el suyo detrás.
 *
 * La hora sale del Reloj (las pruebas lo adelantan), nunca de Date.now().
 */
export class Limitador {
  private readonly ventanas = new Map<string, Ventana>();

  constructor(
    private readonly reloj: Reloj,
    private readonly limite: number,
    private readonly ventanaSegundos: number,
  ) {}

  contar(clave: string): ResultadoLimite {
    const ahora = this.reloj.ahora().getTime();
    const duracion = this.ventanaSegundos * 1000;
    if (this.ventanas.size >= BARRER_CADA) this.barrer(ahora, duracion);

    let ventana = this.ventanas.get(clave);
    if (ventana === undefined || ahora - ventana.inicio >= duracion) {
      ventana = { inicio: ahora, cuenta: 0 };
      this.ventanas.set(clave, ventana);
    }
    ventana.cuenta++;
    const reintentarEnSegundos = Math.max(1, Math.ceil((ventana.inicio + duracion - ahora) / 1000));
    return { permitido: ventana.cuenta <= this.limite, reintentarEnSegundos };
  }

  private barrer(ahora: number, duracion: number): void {
    for (const [clave, ventana] of this.ventanas) {
      if (ahora - ventana.inicio >= duracion) this.ventanas.delete(clave);
    }
  }
}
