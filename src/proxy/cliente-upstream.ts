import {
  Agent as AgenteHttp,
  IncomingMessage,
  OutgoingHttpHeaders,
  request as pedirHttp,
} from 'node:http';
import { Agent as AgenteHttps, request as pedirHttps } from 'node:https';
import { Readable, Transform, TransformCallback } from 'node:stream';
import { ConfiguracionUpstream, NombreUpstream } from '../config/entorno';

/** Lo que salió mal hablando con un upstream. Nunca lleva su URL ni su mensaje. */
export class ErrorUpstream extends Error {
  constructor(
    readonly tipo: 'caido' | 'plazo' | 'cuerpo-grande',
    readonly codigo?: string,
  ) {
    super(tipo);
    this.name = 'ErrorUpstream';
  }
}

export interface PeticionUpstream {
  metodo: string;
  /** Ruta canónica más la query tal como llegó. */
  rutaYQuery: string;
  cabeceras: OutgoingHttpHeaders;
  /** El cuerpo en streaming (la petición del cliente), o undefined si no trae. */
  cuerpo: Readable | undefined;
  /** Tope del cuerpo en bytes; si un cuerpo sin Content-Length lo pasa, ErrorUpstream. */
  cuerpoMaximo: number;
  /** Plazo de esta petición; por defecto el del upstream. */
  plazoMs?: number;
}

/**
 * Habla con un upstream por HTTP, sin transformar nada: el cuerpo va y vuelve en streaming, sin
 * buffer, sin descomprimir ni recomprimir (node:http no toca Content-Encoding).
 *
 * - Plazo: si las cabeceras de la respuesta no llegan a tiempo, ErrorUpstream('plazo') → 504.
 *   Después, el mismo plazo es de inactividad del socket (un archivo grande puede tardar más
 *   en total, pero no quedarse quieto).
 * - Conexión rechazada, cortada o el host que no resuelve: ErrorUpstream('caido') → 502.
 * - SIN reintentos automáticos: un POST repetido podría duplicar una reserva. Quien reintenta es
 *   el cliente, con su Idempotency-Key.
 */
export class ClienteUpstream {
  private readonly agente: AgenteHttp;
  private readonly https: boolean;

  constructor(
    readonly nombre: NombreUpstream,
    private readonly config: ConfiguracionUpstream,
  ) {
    this.https = config.url.protocol === 'https:';
    const opciones = { keepAlive: true, maxSockets: 256 };
    this.agente = this.https ? new AgenteHttps(opciones) : new AgenteHttp(opciones);
  }

  get host(): string {
    return this.config.url.host;
  }

  reenviar(peticion: PeticionUpstream): Promise<IncomingMessage> {
    const plazoMs = peticion.plazoMs ?? this.config.plazoMs;
    return new Promise((resolver, rechazar) => {
      let resuelto = false;
      const pedir = this.https ? pedirHttps : pedirHttp;
      const salida = pedir({
        protocol: this.config.url.protocol,
        hostname: this.config.url.hostname.replace(/^\[|\]$/g, ''),
        port: this.config.url.port || (this.https ? 443 : 80),
        method: peticion.metodo,
        path: peticion.rutaYQuery,
        headers: peticion.cabeceras,
        agent: this.agente,
      });

      const plazo = setTimeout(() => salida.destroy(new ErrorUpstream('plazo')), plazoMs);
      salida.setTimeout(plazoMs, () => salida.destroy(new ErrorUpstream('plazo')));

      salida.on('response', (respuesta) => {
        clearTimeout(plazo);
        resuelto = true;
        resolver(respuesta);
      });
      salida.on('error', (error) => {
        clearTimeout(plazo);
        if (resuelto) return;
        resuelto = true;
        rechazar(
          error instanceof ErrorUpstream ? error : new ErrorUpstream('caido', codigoDe(error)),
        );
      });

      if (peticion.cuerpo === undefined) {
        salida.end();
        return;
      }
      const contador = new ContadorBytes(peticion.cuerpoMaximo);
      contador.on('error', (error) => salida.destroy(error));
      // Si el cliente corta a mitad del cuerpo, el upstream no recibe un cuerpo incompleto
      peticion.cuerpo.on('aborted', () => salida.destroy(new ErrorUpstream('caido')));
      peticion.cuerpo.pipe(contador).pipe(salida);
    });
  }
}

/** Deja pasar los bytes tal cual hasta el tope; uno más y corta con ErrorUpstream (→ 413). */
class ContadorBytes extends Transform {
  private bytes = 0;

  constructor(private readonly maximo: number) {
    super();
  }

  override _transform(
    trozo: Buffer,
    _codificacion: BufferEncoding,
    listo: TransformCallback,
  ): void {
    this.bytes += trozo.length;
    if (this.bytes > this.maximo) {
      listo(new ErrorUpstream('cuerpo-grande'));
      return;
    }
    listo(null, trozo);
  }
}

/** El código de un error de red (ECONNREFUSED...), para el log; nunca el mensaje (trae la URL). */
function codigoDe(error: unknown): string | undefined {
  const codigo = (error as { code?: unknown } | null)?.code;
  return typeof codigo === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(codigo) ? codigo : undefined;
}
