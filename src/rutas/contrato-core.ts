import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Las copias de los contratos del core: v1 (contracts/vuelos-openapi.yaml, /flights/v1) y v2
 * (contracts/vuelos-openapi-v2.yaml, /api/v2, el de Booking Prototipo). No se editan a mano:
 * `npm run contrato:sync` las trae de main del core y `npm run contrato:check` las compara.
 * Desde dist/rutas y desde src/rutas, dos niveles arriba está la raíz del proyecto.
 */
export const RUTA_CONTRATO = join(__dirname, '..', '..', 'contracts', 'vuelos-openapi.yaml');
export const RUTA_CONTRATO_V2 = join(__dirname, '..', '..', 'contracts', 'vuelos-openapi-v2.yaml');

const METODOS = ['get', 'put', 'post', 'delete', 'patch'] as const;

/** Una operación del contrato del core y lo que exige en el borde. */
export interface OperacionContrato {
  metodo: string;
  /** Con el prefijo de `servers` y los parámetros como `{bookingId}`. */
  plantilla: string;
  /**
   * `security` de la operación (o la global): alternativas, cada una con los scopes que exige
   * todos juntos. `[[]]`: un token válido sin scopes (`- OAuth2Security: []`).
   */
  alternativas: string[][];
  /** `security: []` o una alternativa sin esquemas (`- {}`): no hace falta token. */
  publica: boolean;
  /** El `operationId` del contrato (createBooking...): la `operation` de la línea de acceso. */
  operationId?: string;
}

export class ContratoCore {
  private constructor(
    readonly prefijo: string,
    readonly version: string,
    readonly operaciones: readonly OperacionContrato[],
  ) {}

  /** Lee y valida el contrato; si no sirve, el gateway no arranca (mejor que adivinar scopes). */
  static leer(ruta = RUTA_CONTRATO): ContratoCore {
    return ContratoCore.desdeTexto(readFileSync(ruta, 'utf8'));
  }

  static desdeTexto(texto: string): ContratoCore {
    const documento = parse(texto) as Record<string, unknown> | null;
    if (typeof documento !== 'object' || documento === null) {
      throw new Error('El contrato del core no es un documento OpenAPI');
    }
    const prefijo = prefijoDe(documento);
    const version = String((documento.info as { version?: unknown } | undefined)?.version ?? '');
    const globales = documento.security;
    const operaciones: OperacionContrato[] = [];

    const rutas = documento.paths as Record<string, Record<string, unknown>> | undefined;
    if (typeof rutas !== 'object' || rutas === null) {
      throw new Error('El contrato del core no tiene paths');
    }
    for (const [ruta, item] of Object.entries(rutas)) {
      for (const metodo of METODOS) {
        const operacion = item[metodo] as { security?: unknown; operationId?: unknown } | undefined;
        if (operacion === undefined) continue;
        const security = operacion.security ?? globales;
        const donde = `${metodo} ${ruta}`;
        operaciones.push({
          metodo: metodo.toUpperCase(),
          plantilla: prefijo + ruta,
          alternativas: alternativasDe(security, donde),
          publica: esPublica(security),
          ...(typeof operacion.operationId === 'string'
            ? { operationId: operacion.operationId }
            : {}),
        });
      }
    }
    if (operaciones.length === 0) throw new Error('El contrato del core no tiene operaciones');
    return new ContratoCore(prefijo, version, operaciones);
  }

  /**
   * La operación del contrato para ese método y esa clave de ruta (en minúsculas), o undefined.
   * HEAD se resuelve como GET. Si dos plantillas coinciden, gana la que tiene más segmentos fijos
   * (`/offers/hold/{holdId}` antes que `/offers/{offerId}/...`).
   */
  buscar(metodo: string, clave: string): OperacionContrato | undefined {
    const pedido = metodo === 'HEAD' ? 'GET' : metodo;
    const segmentos = clave.slice(1).split('/');
    let mejor: { operacion: OperacionContrato; fijos: number } | undefined;
    for (const operacion of this.operaciones) {
      if (operacion.metodo !== pedido) continue;
      const partes = operacion.plantilla.slice(1).split('/');
      if (partes.length !== segmentos.length) continue;
      let fijos = 0;
      const ok = partes.every((parte, i) => {
        if (/^\{[^}]+\}$/.test(parte)) return true;
        fijos++;
        return parte.toLowerCase() === segmentos[i];
      });
      if (ok && (mejor === undefined || fijos > mejor.fijos)) mejor = { operacion, fijos };
    }
    return mejor?.operacion;
  }
}

/**
 * El prefijo de `servers[0].url`: `/flights/v1` de https://api.booking-hub.com/flights/v1, o
 * `/api/v2` tal cual (el v2 la declara relativa: "detrás del gateway").
 */
function prefijoDe(documento: Record<string, unknown>): string {
  const servidores = documento.servers as { url?: unknown }[] | undefined;
  const url = servidores?.[0]?.url;
  if (typeof url !== 'string') throw new Error('El contrato del core no tiene servers');
  const ruta = new URL(url, 'http://relativa.invalid').pathname.replace(/\/+$/, '');
  if (!/^\/[a-z0-9/-]+$/.test(ruta)) throw new Error('El prefijo de servers no es una ruta');
  return ruta;
}

/** Sin `security`, `security: []` o con un requisito sin esquemas (`{}`): anónima. */
function esPublica(security: unknown): boolean {
  if (!Array.isArray(security) || security.length === 0) return true;
  return security.some((r) => typeof r === 'object' && r !== null && Object.keys(r).length === 0);
}

function alternativasDe(security: unknown, donde: string): string[][] {
  if (security === undefined) return [];
  if (!Array.isArray(security)) throw new Error(`security inválido en ${donde}`);
  return security.map((requisito) => {
    if (typeof requisito !== 'object' || requisito === null) {
      throw new Error(`security inválido en ${donde}`);
    }
    return Object.values(requisito as Record<string, unknown>).flatMap((scopes) => {
      if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== 'string')) {
        throw new Error(`scopes inválidos en ${donde}`);
      }
      return scopes as string[];
    });
  });
}
