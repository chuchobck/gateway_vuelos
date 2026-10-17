import { createServer, Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { metodoNormalizado, RUTA_SIN_PLANTILLA } from './atributos';

/**
 * Cubetas de duración, de 5 ms a 60 s: cubren desde un 304 del gateway hasta el arranque en frío
 * del core en el plan gratuito (~50 s). Las mismas en todos los servicios, para poder sumarlas.
 */
export const CUBETAS_DURACION = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export interface ConfiguracionMetricas {
  servicio: string;
  version: string;
  entorno: string;
}

/**
 * Las métricas comunes a todos los servicios Quinde (docs/OBSERVABILIDAD.md, sección 5), en un
 * Registry propio (no el global de prom-client: dos instancias en un mismo proceso, como en las
 * pruebas, no se pisan).
 *
 * REGLA DE CARDINALIDAD: `route` es siempre una plantilla (`/flights/v1/bookings/{bookingId}`) o
 * `__unmatched__`; `method`, uno de la lista conocida o `_OTHER`; `status`, el código. Nunca ids,
 * IPs, correos ni rutas crudas.
 */
export class Metricas {
  readonly registro = new Registry();

  readonly duracionServidor = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'Duración de las peticiones HTTP atendidas, por método, plantilla de ruta y status',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: CUBETAS_DURACION,
    registers: [this.registro],
  });

  readonly peticionesServidor = new Counter({
    name: 'http_server_requests_total',
    help: 'Peticiones HTTP atendidas, por método, plantilla de ruta y status',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registro],
  });

  readonly duracionCliente = new Histogram({
    name: 'http_client_request_duration_seconds',
    help: 'Duración de las llamadas a otros servicios, por upstream, método y status (o error)',
    labelNames: ['upstream', 'method', 'status'] as const,
    buckets: CUBETAS_DURACION,
    registers: [this.registro],
  });

  constructor(config: ConfiguracionMetricas) {
    new Gauge({
      name: 'quinde_build_info',
      help: 'Siempre 1: servicio, versión y entorno de esta instancia',
      labelNames: ['service', 'version', 'environment'] as const,
      registers: [this.registro],
    })
      .labels(config.servicio, config.version, config.entorno)
      .set(1);
    collectDefaultMetrics({ register: this.registro });
  }

  /** Una petición atendida. `ruta` tiene que ser una plantilla o undefined (→ __unmatched__). */
  registrarServidor(
    metodo: string,
    ruta: string | undefined,
    status: number,
    segundos: number,
  ): void {
    const etiquetas = {
      method: metodoNormalizado(metodo),
      route: ruta ?? RUTA_SIN_PLANTILLA,
      status: String(status),
    };
    this.duracionServidor.observe(etiquetas, segundos);
    this.peticionesServidor.inc(etiquetas);
  }

  /** Una llamada a otro servicio: `status` es el código, o `error` si no hubo respuesta. */
  registrarCliente(
    upstream: string,
    metodo: string,
    status: number | 'error',
    segundos: number,
  ): void {
    this.duracionCliente.observe(
      { upstream, method: metodoNormalizado(metodo), status: String(status) },
      segundos,
    );
  }

  /** El texto de exposición de Prometheus. */
  exponer(): Promise<string> {
    return this.registro.metrics();
  }
}

/**
 * El servidor de métricas, en su PROPIO puerto (METRICS_PORT): solo `GET /metrics`, todo lo demás
 * 404. El ingress nunca lo expone; Prometheus lo raspa por la red interna. Sin dependencias de
 * ningún framework: sirve igual en un servicio Nest.
 */
export function servidorMetricas(metricas: Metricas): Server {
  return createServer((peticion, respuesta) => {
    const ruta = (peticion.url ?? '').split('?')[0];
    if ((peticion.method === 'GET' || peticion.method === 'HEAD') && ruta === '/metrics') {
      metricas
        .exponer()
        .then((texto) => {
          respuesta.writeHead(200, { 'content-type': metricas.registro.contentType });
          respuesta.end(peticion.method === 'HEAD' ? undefined : texto);
        })
        .catch(() => respuesta.writeHead(500).end());
      return;
    }
    respuesta.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
  });
}
