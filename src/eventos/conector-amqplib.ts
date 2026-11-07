import { connect } from 'amqplib';
import { CanalAmqp, codigoDe, ConectorAmqp, ConexionAmqp } from './puente-amqp';

/** Plazo para abrir el socket al broker: un host que no contesta no retiene el reintento. */
const PLAZO_CONEXION_MS = 5_000;

/** Latido explícito: un broker que muere sin cerrar el socket se detecta en ~30 s. */
const HEARTBEAT_S = 15;

/** amqplib solo lee el latido de la URL. Sin tocar el resto (credenciales incluidas). */
export function conLatido(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('heartbeat')) u.searchParams.set('heartbeat', String(HEARTBEAT_S));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * El único archivo que conoce amqplib. Adapta su conexión y su canal de confirmación a las
 * interfaces mínimas de `puente-amqp.ts`. Los errores de amqplib llevan la URL del broker en el
 * mensaje: aquí solo salen sus códigos.
 */
export const conectorAmqplib: ConectorAmqp = async (url): Promise<ConexionAmqp> => {
  const modelo = await connect(conLatido(url), { timeout: PLAZO_CONEXION_MS });
  // Un 'error' sin escucha tumbaría el proceso: el aviso de cierre ya cubre la reconexión
  modelo.on('error', () => undefined);

  return {
    async crearCanalConfirmacion(): Promise<CanalAmqp> {
      const canal = await modelo.createConfirmChannel();
      canal.on('error', () => undefined);
      return {
        async asegurarExchange(nombre) {
          await canal.assertExchange(nombre, 'topic', { durable: true });
        },
        publicar(exchange, routingKey, contenido, opciones, alTerminar) {
          canal.publish(exchange, routingKey, contenido, opciones, (error: unknown) =>
            alTerminar(error ? new Error('nack') : null),
          );
        },
        alDevolver(escucha) {
          canal.on('return', (mensaje) => escucha(mensaje.properties.messageId));
        },
        alCerrar(escucha) {
          canal.on('close', () => escucha('CHANNEL_CLOSED'));
          canal.on('error', (error) => escucha(codigoDe(error)));
        },
        cerrar: () => canal.close(),
      };
    },
    alCerrar(escucha) {
      modelo.on('close', (error?: unknown) => escucha(error ? codigoDe(error) : 'CLOSED'));
      modelo.on('error', (error) => escucha(codigoDe(error)));
    },
    cerrar: () => modelo.close(),
  };
};
