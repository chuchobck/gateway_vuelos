import { NombreUpstream, UPSTREAMS } from '../config/entorno';
import { ClienteUpstream } from '../proxy/cliente-upstream';

/** Plazo de cada consulta de /health/upstreams. */
export const PLAZO_SALUD_MS = 2000;

/** Dónde responde su salud cada servicio (la de vivo; no la de listo, que mira su base). */
export const RUTA_SALUD: Record<NombreUpstream, string> = {
  core: '/flights/v1/health',
  bff: '/health',
  identity: '/identity/v1/health',
  notifier: '/health',
};

export interface EstadoUpstream {
  status: 'UP' | 'DOWN';
  /** El status HTTP que respondió, si respondió. */
  httpStatus?: number;
  ms: number;
}

/**
 * /health/upstreams: informativo. Pregunta a cada servicio con 2 s de plazo, en paralelo, y
 * responde siempre 200: el gateway está bien aunque un servicio no (eso lo dice /health/ready,
 * que NO depende de ellos). No lleva URLs, mensajes de error ni secretos: solo nombre, estado,
 * status HTTP y milisegundos.
 */
export async function saludDeUpstreams(
  clientes: Record<NombreUpstream, ClienteUpstream>,
  requestId: string,
): Promise<Record<NombreUpstream, EstadoUpstream>> {
  const resultados = await Promise.all(
    UPSTREAMS.map(async (nombre): Promise<[NombreUpstream, EstadoUpstream]> => {
      const inicio = process.hrtime.bigint();
      const ms = () => Number((process.hrtime.bigint() - inicio) / 1_000_000n);
      try {
        const respuesta = await clientes[nombre].reenviar({
          metodo: 'GET',
          rutaYQuery: RUTA_SALUD[nombre],
          cabeceras: {
            host: clientes[nombre].host,
            accept: 'application/json',
            'x-request-id': requestId,
          },
          cuerpo: undefined,
          cuerpoMaximo: 0,
          plazoMs: PLAZO_SALUD_MS,
        });
        respuesta.resume();
        const httpStatus = respuesta.statusCode ?? 0;
        return [nombre, { status: httpStatus === 200 ? 'UP' : 'DOWN', httpStatus, ms: ms() }];
      } catch {
        return [nombre, { status: 'DOWN', ms: ms() }];
      }
    }),
  );
  return Object.fromEntries(resultados) as Record<NombreUpstream, EstadoUpstream>;
}
