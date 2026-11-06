import {
  CanalAmqp,
  ConectorAmqp,
  ConexionAmqp,
  OpcionesPublicacion,
} from '../../src/eventos/puente-amqp';

/** Lo que el broker falso recibió en un publish. */
export interface PublicacionFalsa {
  exchange: string;
  routingKey: string;
  contenido: Buffer;
  opciones: OpcionesPublicacion;
}

/** Qué hace el broker con cada publish. */
export type ModoBroker = 'confirmar' | 'rechazar' | 'silencio' | 'sin-cola';

/** Una URL con credenciales, como la de producción: ningún log ni error puede llevarla. */
export const URL_BROKER = 'amqp://quinde:clave-secreta-123@127.0.0.1:5672';

/**
 * Un RabbitMQ falso, sin red: el mismo contrato que `conector-amqplib.ts` le da al puente. Se
 * puede apagar (el conector falla con ECONNREFUSED), dejar sin confirmar, hacer que rechace o que
 * devuelva el mensaje por no tener cola, y tirar la conexión abierta.
 */
export class BrokerFalso {
  disponible = true;
  modo: ModoBroker = 'confirmar';
  /** Los exchanges declarados, con su tipo. */
  readonly exchanges: string[] = [];
  readonly publicaciones: PublicacionFalsa[] = [];
  /** Cuántas veces se intentó conectar (con éxito o sin él). */
  intentos = 0;
  /** Las URLs con que se intentó (para comprobar que llega la que se configuró). */
  readonly urls: string[] = [];
  private cierres: ((codigo: string) => void)[] = [];

  readonly conector: ConectorAmqp = async (url) => {
    this.intentos++;
    this.urls.push(url);
    if (!this.disponible) {
      // El mensaje de un error real de red/amqplib trae la URL: no puede llegar a ningún log
      throw Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: 'ECONNREFUSED' });
    }
    return this.nuevaConexion();
  };

  /** Cierra la conexión abierta como lo haría un reinicio del broker. */
  tirarConexion(codigo = 'CONNECTION_FORCED'): void {
    const cierres = this.cierres;
    this.cierres = [];
    for (const cierre of cierres) cierre(codigo);
  }

  private nuevaConexion(): ConexionAmqp {
    const escuchasConexion: ((codigo: string) => void)[] = [];
    const escuchasCanal: ((codigo: string) => void)[] = [];
    this.cierres.push(
      (codigo) => escuchasConexion.forEach((e) => e(codigo)),
      (codigo) => escuchasCanal.forEach((e) => e(codigo)),
    );
    return {
      crearCanalConfirmacion: async (): Promise<CanalAmqp> => {
        let devolver: (messageId: string | undefined) => void = () => undefined;
        return {
          asegurarExchange: async (nombre) => {
            this.exchanges.push(nombre);
          },
          publicar: (exchange, routingKey, contenido, opciones, alTerminar) => {
            this.publicaciones.push({
              exchange,
              routingKey,
              // Una copia: el broker real recibe los bytes por el socket, no la misma referencia
              contenido: Buffer.from(contenido),
              opciones,
            });
            if (this.modo === 'confirmar') setImmediate(() => alTerminar(null));
            else if (this.modo === 'rechazar') setImmediate(() => alTerminar(new Error('nack')));
            else if (this.modo === 'sin-cola') {
              // basic.return llega antes que la confirmación
              setImmediate(() => {
                devolver(opciones.messageId);
                alTerminar(null);
              });
            }
            // 'silencio': nunca confirma
          },
          alDevolver: (escucha) => {
            devolver = escucha;
          },
          alCerrar: (escucha) => {
            escuchasCanal.push(escucha);
          },
          cerrar: async () => undefined,
        };
      },
      alCerrar: (escucha) => {
        escuchasConexion.push(escucha);
      },
      cerrar: async () => undefined,
    };
  }
}

/** Espera (con el reloj real) a que `condicion` sea cierta; falla con el tope. */
export async function esperarHasta(condicion: () => boolean, topeMs = 2_000): Promise<void> {
  const limite = Date.now() + topeMs;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('esperarHasta: la condición no se cumplió a tiempo');
    await new Promise((listo) => setTimeout(listo, 5));
  }
}
