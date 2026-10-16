import { FastifyInstance } from 'fastify';
import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { construirApp } from '../../src/app';
import { leerEntorno, NombreUpstream, UPSTREAMS } from '../../src/config/entorno';
import { ReglaRuta } from '../../src/rutas/tabla-rutas';
import { AUDIENCIA, EMISOR, IdentidadFalsa, OpcionesToken } from './identidad-falsa';
import { pedir, Pedido, Respuesta } from './http-crudo';
import { RelojDePrueba } from './reloj-de-prueba';
import { UpstreamFalso } from './upstream-falso';

export const ORIGEN_PERMITIDO = 'https://app.quinde.example';

/** Los cuatro servicios falsos y el identity falso, compartidos por las pruebas de un archivo. */
export class Servicios {
  readonly upstreams = Object.fromEntries(
    UPSTREAMS.map((nombre) => [nombre, new UpstreamFalso(nombre)]),
  ) as Record<NombreUpstream, UpstreamFalso>;
  readonly identidad = new IdentidadFalsa();

  async iniciar(): Promise<this> {
    await Promise.all([
      ...Object.values(this.upstreams).map((u) => u.iniciar()),
      this.identidad.iniciar(),
    ]);
    return this;
  }

  reiniciar(): void {
    for (const upstream of Object.values(this.upstreams)) upstream.reiniciar();
    this.identidad.encendida = true;
  }

  /** Cuántas peticiones empezaron a llegarles, entre todos (aunque se cortaran). */
  totalIniciadas(): number {
    return Object.values(this.upstreams).reduce((n, u) => n + u.iniciadas, 0);
  }

  /** Cuántas peticiones recibieron completas, entre todos. */
  totalRecibidas(): number {
    return Object.values(this.upstreams).reduce((n, u) => n + u.recibidas.length, 0);
  }

  async detener(): Promise<void> {
    await Promise.all([
      ...Object.values(this.upstreams).map((u) => u.detener()),
      this.identidad.detener(),
    ]);
  }
}

/** Un gateway real escuchando en un puerto al azar, con sus logs a la vista de la prueba. */
export class GatewayDePrueba {
  readonly logs: string[] = [];
  readonly reloj = new RelojDePrueba();
  app!: FastifyInstance;
  base!: string;

  constructor(
    readonly servicios: Servicios,
    private readonly variables: Record<string, string> = {},
    private readonly tabla?: readonly ReglaRuta[],
  ) {}

  async iniciar(): Promise<this> {
    const { upstreams, identidad } = this.servicios;
    const configuracion = leerEntorno({
      UPSTREAM_CORE_URL: upstreams.core.url,
      UPSTREAM_BFF_URL: upstreams.bff.url,
      UPSTREAM_IDENTITY_URL: upstreams.identity.url,
      UPSTREAM_NOTIFIER_URL: upstreams.notifier.url,
      JWT_ISSUER: EMISOR,
      JWT_AUDIENCE: AUDIENCIA,
      JWKS_URL: identidad.jwksUrl,
      CORS_ORIGINS: `${ORIGEN_PERMITIDO},http://localhost:5173`,
      RATE_LIMIT_MAX: '100000',
      RATE_LIMIT_STRICT_MAX: '100000',
      LOG_LEVEL: 'debug',
      ...this.variables,
    });
    const logs = this.logs;
    const destinoLogs = new Writable({
      write(trozo: Buffer, _codificacion, listo) {
        logs.push(
          ...trozo
            .toString('utf8')
            .split('\n')
            .filter((l) => l !== ''),
        );
        listo();
      },
    });
    this.app = construirApp({
      configuracion,
      reloj: this.reloj,
      destinoLogs,
      ...(this.tabla ? { tabla: this.tabla } : {}),
    });
    await this.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = this.app.server.address() as AddressInfo;
    this.base = `http://127.0.0.1:${port}`;
    return this;
  }

  pedir(pedido: Pedido): Promise<Respuesta> {
    return pedir(this.base, pedido);
  }

  /** Un token de identity falso, emitido a la hora del reloj del gateway. */
  token(opciones: OpcionesToken = {}): Promise<string> {
    return this.servicios.identidad.token({ ahora: this.reloj.ahora(), ...opciones });
  }

  /** Los logs como JSON (una línea por registro). */
  registros(): Record<string, unknown>[] {
    return this.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  async detener(): Promise<void> {
    await this.app.close();
  }
}

export const TODOS_LOS_SCOPES =
  'flights:read flights:hold flights:book flights:cancel flights:webhooks flights:admin';
