import { Counter } from 'prom-client';
import { Metricas } from '../observabilidad/metricas';

/**
 * Las métricas propias del gateway, además de las comunes (docs/OBSERVABILIDAD.md, sección 5).
 * Todas las etiquetas salen de listas cerradas.
 */
export class MetricasBorde {
  /** policy: global o estricto. */
  readonly limitadas: Counter<'policy'>;
  /** reason: missing_token, invalid_token, expired_token, insufficient_scope, jwks_unavailable. */
  readonly rechazosAuth: Counter<'reason'>;
  /** upstream: core, bff, identity, notifier; kind: unavailable o timeout. */
  readonly erroresUpstream: Counter<'upstream' | 'kind'>;

  constructor(metricas: Metricas) {
    const registers = [metricas.registro];
    this.limitadas = new Counter({
      name: 'gateway_rate_limited_total',
      help: 'Peticiones cortadas por el límite de peticiones del borde (429), por política',
      labelNames: ['policy'],
      registers,
    });
    this.rechazosAuth = new Counter({
      name: 'gateway_auth_rejections_total',
      help: 'Peticiones rechazadas en el borde por el token (401, 403, 503), por motivo',
      labelNames: ['reason'],
      registers,
    });
    this.erroresUpstream = new Counter({
      name: 'gateway_upstream_errors_total',
      help: 'Llamadas a un upstream sin respuesta (502 caído, 504 plazo), por upstream y tipo',
      labelNames: ['upstream', 'kind'],
      registers,
    });
  }
}
