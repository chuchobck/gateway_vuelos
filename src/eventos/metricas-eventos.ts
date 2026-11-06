import { Counter, Gauge } from 'prom-client';
import { Metricas } from '../observabilidad/metricas';

/** Por qué se rechazó un evento: una lista cerrada (cardinalidad acotada, nada del cliente). */
export const MOTIVOS_RECHAZO = [
  'missing_token',
  'invalid_token',
  'expired_token',
  'insufficient_scope',
  'jwks_unavailable',
  'content_type',
  'too_large',
  'invalid_json',
  'invalid_event',
  'not_found',
  'invalid_path',
  'method_not_allowed',
  'internal_error',
  'broker_unavailable',
  'broker_timeout',
  'broker_rejected',
  'unroutable',
] as const;

export type MotivoRechazo = (typeof MOTIVOS_RECHAZO)[number];

/**
 * Las métricas del puente de eventos (fase 4a), además de las comunes. Ninguna etiqueta lleva un
 * eventId, un tipo de evento ni nada del cuerpo: solo el motivo, de la lista cerrada de arriba.
 */
export class MetricasEventos {
  readonly publicados: Counter;
  readonly rechazados: Counter<'reason'>;
  /** 1 con la conexión al broker abierta, 0 sin ella. Dato informativo: nada depende de él. */
  readonly broker: Gauge;

  constructor(metricas: Metricas) {
    const registers = [metricas.registro];
    this.publicados = new Counter({
      name: 'gateway_events_published_total',
      help: 'Eventos publicados en RabbitMQ y confirmados por el broker (202)',
      registers,
    });
    this.rechazados = new Counter({
      name: 'gateway_events_rejected_total',
      help: 'Eventos que no se publicaron, por motivo (token, formato o broker)',
      labelNames: ['reason'],
      registers,
    });
    this.broker = new Gauge({
      name: 'gateway_events_broker_up',
      help: 'Si la conexión al broker de eventos está abierta (1) o no (0); solo informativo',
      registers,
    });
    this.broker.set(0);
  }

  rechazar(motivo: MotivoRechazo): void {
    this.rechazados.inc({ reason: motivo });
  }
}
