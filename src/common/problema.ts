import { STATUS_CODES } from 'node:http';

export const CONTENT_TYPE_PROBLEMA = 'application/problem+json';

/** Base de los `type`: la misma del core, para que un error del borde se lea igual que uno suyo. */
export const TIPO_ERROR_BASE = 'https://api.booking-hub.com/errors/';

/**
 * `code` de los ProblemDetails del gateway. Son los del core: un cliente no debe notar si el
 * error lo dio el borde o el servicio. No se agregan códigos propios: el `status` dice qué pasó
 * (VALIDATION_FAILED es el de respaldo del core para todo lo que no tiene uno).
 */
export type CodigoError = 'VALIDATION_FAILED' | 'RATE_LIMIT_EXCEEDED' | 'AUTH_UNAVAILABLE';

/**
 * Cuerpo de un error del gateway (RFC 9457), con la forma del ProblemDetails del contrato del
 * core, que no admite campos extra (additionalProperties: false). Por eso el request id no va en
 * el cuerpo: va siempre en la cabecera X-Request-Id.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: CodigoError;
}

/**
 * `code` del ProblemDetails v2 (contrato v2, components.schemas.ProblemDetails): los genéricos
 * que puede dar el borde. Los mismos que da el core en /api/v2 para ese status
 * (`codigoV2PorDefecto`), para que Booking no note si respondió el borde o el servicio.
 */
export type CodigoErrorV2 =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMIT_EXCEEDED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/**
 * Cuerpo de un error del gateway en /api/v2/**: exactamente el ProblemDetails del contrato v2
 * (additionalProperties: false), los de v1 más `instance`, `correlation_id` y `timestamp`.
 */
export interface ProblemDetailsV2 {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: CodigoErrorV2;
  correlation_id: string;
  timestamp: string;
}

/** ¿La ruta (la pedida, sin normalizar) es de la API v2? Sus errores salen con ProblemDetailsV2. */
export function esRutaV2(urlCruda: string): boolean {
  const ruta = (urlCruda.split('?')[0] ?? '').toLowerCase();
  return ruta === '/api/v2' || ruta.startsWith('/api/v2/');
}

/** Un error que el gateway responde él mismo, sin llegar a un upstream. */
export class ErrorBorde extends Error {
  constructor(
    readonly status: number,
    readonly detalle: string,
    readonly opciones: {
      codigo?: CodigoError;
      cabeceras?: Record<string, string>;
      /** Por qué, de una lista cerrada (missing_token, insufficient_scope...): métricas y spans. */
      motivo?: string;
    } = {},
  ) {
    super(detalle);
    this.name = 'ErrorBorde';
  }

  get codigo(): CodigoError {
    return (
      this.opciones.codigo ?? (this.status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'VALIDATION_FAILED')
    );
  }

  get motivo(): string | undefined {
    return this.opciones.motivo;
  }

  get cabeceras(): Record<string, string> {
    return this.opciones.cabeceras ?? {};
  }

  /**
   * El `code` v2 del status: el mismo mapa que el core (401 UNAUTHORIZED, 403 FORBIDDEN, 404
   * NOT_FOUND, 429 RATE_LIMIT_EXCEEDED, 502/503/504 PROVIDER_UNAVAILABLE, otro 5xx INTERNAL_ERROR
   * y el resto, 400, 405 y 413, VALIDATION_FAILED). AUTH_UNAVAILABLE de v1 es PROVIDER_UNAVAILABLE.
   */
  get codigoV2(): CodigoErrorV2 {
    if (this.status === 401) return 'UNAUTHORIZED';
    if (this.status === 403) return 'FORBIDDEN';
    if (this.status === 404) return 'NOT_FOUND';
    if (this.status === 429) return 'RATE_LIMIT_EXCEEDED';
    if (this.status === 502 || this.status === 503 || this.status === 504) {
      return 'PROVIDER_UNAVAILABLE';
    }
    if (this.status >= 500) return 'INTERNAL_ERROR';
    return 'VALIDATION_FAILED';
  }

  /**
   * El cuerpo v2. `instance` es la ruta pedida sin la query (como el core); `correlation_id`, el
   * X-Correlation-Id de la petición; `timestamp`, la hora del error en UTC.
   */
  problemaV2(datos: { urlCruda: string; correlationId: string; ahora: Date }): ProblemDetailsV2 {
    return {
      type: TIPO_ERROR_BASE + this.codigoV2.toLowerCase().replace(/_/g, '-'),
      title: STATUS_CODES[this.status] ?? 'Error',
      status: this.status,
      detail: this.detalle,
      instance: datos.urlCruda.split('?')[0] ?? '/',
      code: this.codigoV2,
      correlation_id: datos.correlationId,
      timestamp: datos.ahora.toISOString(),
    };
  }

  problema(): ProblemDetails {
    return {
      type: TIPO_ERROR_BASE + this.codigo.toLowerCase().replace(/_/g, '-'),
      title: STATUS_CODES[this.status] ?? 'Error',
      status: this.status,
      detail: this.detalle,
      code: this.codigo,
    };
  }
}
