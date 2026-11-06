import { Registro } from '../seguridad/registro';

/**
 * Lo mínimo que el puente necesita de una conexión AMQP. `conector-amqplib.ts` lo implementa con
 * amqplib; las pruebas, con un fake sin broker. Nada de lo de abajo habla de eventos de negocio:
 * el puente solo lleva bytes de un protocolo a otro.
 */
export interface CanalAmqp {
  /** Declara el exchange topic durable (idempotente; falla si existe con otra definición). */
  asegurarExchange(nombre: string): Promise<void>;
  /**
   * Publica y avisa con `alTerminar` cuando el broker confirma (`null`) o rechaza (un error). Con
   * `mandatory`, un mensaje que ninguna cola recibe vuelve por `alDevolver` ANTES de la confirmación.
   */
  publicar(
    exchange: string,
    routingKey: string,
    contenido: Buffer,
    opciones: OpcionesPublicacion,
    alTerminar: (error: Error | null) => void,
  ): void;
  /** Se llama con el messageId de cada mensaje que el broker devolvió por no tener a quién entregarlo. */
  alDevolver(escucha: (messageId: string | undefined) => void): void;
  alCerrar(escucha: (codigo: string) => void): void;
  cerrar(): Promise<void>;
}

export interface OpcionesPublicacion {
  persistent: true;
  mandatory: true;
  messageId: string;
  type: string;
  contentType: 'application/json';
  correlationId: string;
  headers: Record<string, string>;
}

export interface ConexionAmqp {
  crearCanalConfirmacion(): Promise<CanalAmqp>;
  alCerrar(escucha: (codigo: string) => void): void;
  cerrar(): Promise<void>;
}

export type ConectorAmqp = (url: string) => Promise<ConexionAmqp>;

/** Un mensaje listo para publicar: el cuerpo son los bytes que llegaron, sin tocar. */
export interface MensajeEvento {
  routingKey: string;
  contenido: Buffer;
  messageId: string;
  correlationId: string;
  traceparent: string;
}

/** Por qué no se pudo publicar. `kind` es una lista cerrada (métricas y spans). */
export class ErrorPublicacion extends Error {
  constructor(
    readonly kind: 'unavailable' | 'timeout' | 'rejected' | 'unroutable',
    readonly codigo?: string,
  ) {
    super(`No se pudo publicar el evento (${kind})`);
    this.name = 'ErrorPublicacion';
  }
}

/** Cuánto se espera la confirmación del broker antes de responder 503 (el core reintenta). */
export const PLAZO_CONFIRMACION_MS = 5_000;
/** Reconexión: de 1 s a 30 s, doblando en cada intento fallido. */
export const ESPERA_INICIAL_MS = 1_000;
export const ESPERA_MAXIMA_MS = 30_000;
/** Publicaciones esperando confirmación a la vez: más que esto, 503 en lugar de acumular. */
export const PENDIENTES_MAXIMOS = 1_000;

export interface OpcionesPuente {
  /** RABBITMQ_URL: lleva credenciales, así que NUNCA se registra ni va a un mensaje de error. */
  url: string;
  exchange: string;
  conector: ConectorAmqp;
  registro: Registro;
  plazoConfirmacionMs?: number;
  esperaInicialMs?: number;
  esperaMaximaMs?: number;
}

/**
 * La conexión al broker: una conexión con un canal de confirmación, que se reabre sola con backoff
 * si se cae. Un broker caído nunca tumba el gateway: `publicar` falla con 'unavailable' y el core
 * reintenta. Los temporizadores son reales (son plazos de red, no vencimientos: ver el Reloj).
 *
 * El estado del broker es un dato informativo (`conectado`, y el gauge de las métricas): ninguna
 * ruta de salud depende de él.
 */
export class PuenteAmqp {
  private conexion?: ConexionAmqp;
  private canal?: CanalAmqp;
  private detenido = false;
  private intentos = 0;
  private temporizador?: NodeJS.Timeout;
  private pendientes = 0;
  /** messageId de lo devuelto por el broker (sin cola que lo reciba), hasta que llegue su confirmación. */
  private readonly devueltos = new Set<string>();
  private readonly oyentes: ((conectado: boolean) => void)[] = [];

  constructor(private readonly opciones: OpcionesPuente) {}

  get conectado(): boolean {
    return this.canal !== undefined;
  }

  get exchange(): string {
    return this.opciones.exchange;
  }

  /** Avisa cada vez que cambia el estado de la conexión (para el gauge). */
  alCambiarEstado(oyente: (conectado: boolean) => void): void {
    this.oyentes.push(oyente);
  }

  /** Empieza a conectar sin esperar: el arranque del gateway no depende del broker. */
  iniciar(): void {
    this.detenido = false;
    void this.conectar();
  }

  /** Cierra sin colgar el proceso: lo que el broker no cierre en 2 s se abandona. */
  async cerrar(): Promise<void> {
    this.detenido = true;
    clearTimeout(this.temporizador);
    const canal = this.canal;
    const conexion = this.conexion;
    this.soltar();
    const cerrar = async () => {
      await canal?.cerrar().catch(() => undefined);
      await conexion?.cerrar().catch(() => undefined);
    };
    let tope: NodeJS.Timeout | undefined;
    await Promise.race([
      cerrar(),
      new Promise<void>((listo) => {
        tope = setTimeout(listo, 2_000);
        tope.unref();
      }),
    ]);
    clearTimeout(tope);
  }

  /**
   * Publica y espera la confirmación del broker. Resuelve solo cuando RabbitMQ confirma; si no
   * llega en `plazoConfirmacionMs`, el broker rechaza, no hay cola que reciba el mensaje o no hay
   * conexión, rechaza con un `ErrorPublicacion`.
   *
   * Si vence el plazo, el mensaje igual puede llegar a publicarse después: el reintento del core
   * lo repite con el mismo eventId y el notifier lo trata como idempotente.
   */
  publicar(mensaje: MensajeEvento): Promise<void> {
    const canal = this.canal;
    if (canal === undefined || this.pendientes >= PENDIENTES_MAXIMOS) {
      return Promise.reject(new ErrorPublicacion('unavailable'));
    }
    const plazo = this.opciones.plazoConfirmacionMs ?? PLAZO_CONFIRMACION_MS;
    this.pendientes++;
    return new Promise<void>((resolver, rechazar) => {
      let terminado = false;
      const terminar = (error?: ErrorPublicacion) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(vencimiento);
        this.pendientes--;
        this.devueltos.delete(mensaje.messageId);
        if (error) rechazar(error);
        else resolver();
      };
      const vencimiento = setTimeout(() => terminar(new ErrorPublicacion('timeout')), plazo);
      try {
        canal.publicar(
          this.opciones.exchange,
          mensaje.routingKey,
          mensaje.contenido,
          {
            persistent: true,
            mandatory: true,
            messageId: mensaje.messageId,
            type: mensaje.routingKey,
            contentType: 'application/json',
            correlationId: mensaje.correlationId,
            headers: {
              'x-correlation-id': mensaje.correlationId,
              traceparent: mensaje.traceparent,
            },
          },
          (error) => {
            if (error) terminar(new ErrorPublicacion('rejected'));
            // El broker confirmó, pero la devolución llega antes: nadie recibió el mensaje
            else if (this.devueltos.has(mensaje.messageId)) {
              terminar(new ErrorPublicacion('unroutable'));
            } else terminar();
          },
        );
      } catch {
        // El canal se cerró entre la comprobación y el envío
        terminar(new ErrorPublicacion('unavailable'));
      }
    });
  }

  private async conectar(): Promise<void> {
    if (this.detenido) return;
    let conexion: ConexionAmqp | undefined;
    try {
      conexion = await this.opciones.conector(this.opciones.url);
      const canal = await conexion.crearCanalConfirmacion();
      await canal.asegurarExchange(this.opciones.exchange);
      if (this.detenido) {
        await canal.cerrar().catch(() => undefined);
        await conexion.cerrar().catch(() => undefined);
        return;
      }
      this.conexion = conexion;
      this.canal = canal;
      const alCaer = (codigo: string) => this.alCaer(conexion, codigo);
      conexion.alCerrar(alCaer);
      canal.alCerrar(alCaer);
      canal.alDevolver((messageId) => {
        if (messageId !== undefined) this.devueltos.add(messageId);
      });
      this.intentos = 0;
      this.opciones.registro.info(
        `RabbitMQ conectado (exchange ${this.opciones.exchange}, topic durable)`,
      );
      this.avisar(true);
    } catch (error) {
      await conexion?.cerrar().catch(() => undefined);
      this.programarReconexion(codigoDe(error));
    }
  }

  /** La conexión o el canal se cayeron: se descarta todo y se vuelve a intentar. */
  private alCaer(conexion: ConexionAmqp | undefined, codigo: string): void {
    // Un aviso viejo (de una conexión que ya se reemplazó) no tira la actual
    if (this.detenido || (conexion !== undefined && conexion !== this.conexion)) return;
    const conexionCaida = this.conexion;
    this.soltar();
    void conexionCaida?.cerrar().catch(() => undefined);
    this.programarReconexion(codigo);
  }

  private soltar(): void {
    const habia = this.canal !== undefined;
    this.canal = undefined;
    this.conexion = undefined;
    this.devueltos.clear();
    if (habia) this.avisar(false);
  }

  private programarReconexion(codigo: string): void {
    if (this.detenido) return;
    const inicial = this.opciones.esperaInicialMs ?? ESPERA_INICIAL_MS;
    const maxima = this.opciones.esperaMaximaMs ?? ESPERA_MAXIMA_MS;
    const espera = Math.min(inicial * 2 ** this.intentos, maxima);
    this.intentos++;
    // Solo el código del error: el mensaje de uno de red o de amqplib puede traer la URL con sus credenciales
    this.opciones.registro.warn(
      `RabbitMQ no disponible (${codigo}); se reintenta en ${espera} ms (intento ${this.intentos})`,
    );
    clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => void this.conectar(), espera);
    this.temporizador.unref();
  }

  private avisar(conectado: boolean): void {
    for (const oyente of this.oyentes) oyente(conectado);
  }
}

/** Un código corto del error (ECONNREFUSED, 406...), nunca su mensaje. */
export function codigoDe(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, replyCode } = error as { code?: unknown; replyCode?: unknown };
    if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
    if (typeof replyCode === 'number') return String(replyCode);
  }
  return error instanceof Error ? error.name.slice(0, 40) : 'ERROR';
}
