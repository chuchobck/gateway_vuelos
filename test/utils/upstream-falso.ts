import {
  createServer,
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

/** Lo que recibió un upstream falso: lo que de verdad le llegó por la red. */
export interface PeticionRecibida {
  metodo: string;
  url: string;
  cabeceras: IncomingHttpHeaders;
  /** Las cabeceras crudas, para ver duplicados y nombres tal como llegaron. */
  crudas: string[];
  cuerpo: Buffer;
}

export type Manejador = (
  peticion: IncomingMessage,
  respuesta: ServerResponse,
  cuerpo: Buffer,
) => void;

/** Por defecto: 200 JSON con el método y la ruta que le llegaron. */
const ECO: Manejador = (peticion, respuesta) => {
  respuesta.writeHead(200, { 'content-type': 'application/json' });
  respuesta.end(JSON.stringify({ metodo: peticion.method, url: peticion.url }));
};

/**
 * Un servicio HTTP real en un puerto al azar que anota cada petición. Las pruebas cambian su
 * manejador para simular lentitud, 503, binarios o un corte de conexión.
 */
export class UpstreamFalso {
  readonly recibidas: PeticionRecibida[] = [];
  /** Peticiones que empezaron a llegar (con o sin el cuerpo completo). */
  iniciadas = 0;
  manejador: Manejador = ECO;
  private servidor?: Server;

  constructor(readonly nombre: string) {}

  async iniciar(): Promise<this> {
    this.servidor = createServer((peticion, respuesta) => {
      this.iniciadas++;
      const trozos: Buffer[] = [];
      peticion.on('data', (trozo: Buffer) => trozos.push(trozo));
      peticion.on('end', () => {
        const cuerpo = Buffer.concat(trozos);
        this.recibidas.push({
          metodo: peticion.method ?? '',
          url: peticion.url ?? '',
          cabeceras: peticion.headers,
          crudas: peticion.rawHeaders,
          cuerpo,
        });
        this.manejador(peticion, respuesta, cuerpo);
      });
    });
    this.servidor.keepAliveTimeout = 500;
    await new Promise<void>((listo) => this.servidor!.listen(0, '127.0.0.1', listo));
    return this;
  }

  get url(): string {
    const { port } = this.servidor!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  ultima(): PeticionRecibida {
    const ultima = this.recibidas[this.recibidas.length - 1];
    if (!ultima) throw new Error(`${this.nombre} no recibió ninguna petición`);
    return ultima;
  }

  reiniciar(): void {
    this.recibidas.length = 0;
    this.iniciadas = 0;
    this.manejador = ECO;
  }

  async detener(): Promise<void> {
    if (!this.servidor) return;
    this.servidor.closeAllConnections();
    await new Promise<void>((listo) => this.servidor!.close(() => listo()));
  }
}
