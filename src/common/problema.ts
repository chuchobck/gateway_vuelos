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

/** Un error que el gateway responde él mismo, sin llegar a un upstream. */
export class ErrorBorde extends Error {
  constructor(
    readonly status: number,
    readonly detalle: string,
    readonly opciones: { codigo?: CodigoError; cabeceras?: Record<string, string> } = {},
  ) {
    super(detalle);
    this.name = 'ErrorBorde';
  }

  get codigo(): CodigoError {
    return (
      this.opciones.codigo ?? (this.status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'VALIDATION_FAILED')
    );
  }

  get cabeceras(): Record<string, string> {
    return this.opciones.cabeceras ?? {};
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
