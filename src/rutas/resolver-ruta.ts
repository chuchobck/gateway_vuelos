import { ContratoCore } from './contrato-core';
import { RutaNormalizada } from './normalizar-ruta';
import {
  coincide,
  plantillaDePatron,
  ReglaRuta,
  RUTAS_BLOQUEADAS,
  TABLA_RUTAS,
} from './tabla-rutas';

/** Lo que exige el borde para dejar pasar la petición. */
export type SeguridadEfectiva =
  | { modo: 'publica' }
  /** Basta con cumplir una alternativa (todos sus scopes). `[[]]`: solo un token válido. */
  | { modo: 'token'; alternativas: readonly (readonly string[])[] };

export type Decision =
  | { tipo: 'bloqueada' }
  | { tipo: 'desconocida' }
  | {
      tipo: 'ruta';
      regla: ReglaRuta;
      seguridad: SeguridadEfectiva;
      /** La plantilla (`/flights/v1/bookings/{bookingId}`): la del contrato o la de la regla. */
      plantilla: string;
      operacion?: string;
    };

/** Lo que el contrato del core no declara (otro método, otra ruta): un token válido, sin scopes. */
const SOLO_TOKEN: SeguridadEfectiva = { modo: 'token', alternativas: [[]] };

/**
 * Decide qué hacer con una petición ya normalizada. El orden es fijo:
 *   1. RUTAS_BLOQUEADAS (/internal/**): 404, aunque alguna regla de la tabla la cubriera.
 *   2. La primera regla de la tabla que coincide. Ninguna: 404.
 *   3. Con `contrato`, la seguridad de la operación del OpenAPI del core.
 */
export class ResolverRutas {
  constructor(
    private readonly contrato: ContratoCore,
    private readonly tabla: readonly ReglaRuta[] = TABLA_RUTAS,
  ) {}

  decidir(metodo: string, ruta: RutaNormalizada): Decision {
    if (RUTAS_BLOQUEADAS.some((patron) => coincide(patron, ruta.clave))) {
      return { tipo: 'bloqueada' };
    }

    const regla = this.tabla.find((r) => coincide(r.patron, ruta.clave));
    if (regla === undefined) return { tipo: 'desconocida' };

    const { seguridad } = regla;
    const plantilla = plantillaDePatron(regla.patron);
    if (seguridad.modo === 'publica') return { tipo: 'ruta', regla, seguridad, plantilla };
    if (seguridad.modo === 'token') {
      return {
        tipo: 'ruta',
        regla,
        seguridad: { modo: 'token', alternativas: [seguridad.scopes] },
        plantilla,
      };
    }

    const operacion = this.contrato.buscar(metodo, ruta.clave);
    if (operacion === undefined) return { tipo: 'ruta', regla, seguridad: SOLO_TOKEN, plantilla };
    const nombre = `${operacion.metodo} ${operacion.plantilla}`;
    if (operacion.publica) {
      return {
        tipo: 'ruta',
        regla,
        seguridad: { modo: 'publica' },
        plantilla: operacion.plantilla,
        operacion: nombre,
      };
    }
    return {
      tipo: 'ruta',
      regla,
      seguridad: { modo: 'token', alternativas: operacion.alternativas },
      plantilla: operacion.plantilla,
      operacion: nombre,
    };
  }
}
