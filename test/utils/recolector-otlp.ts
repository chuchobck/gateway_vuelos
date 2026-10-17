import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';

/** Un span tal como llega por OTLP/HTTP en JSON, ya aplanado. */
export interface SpanRecibido {
  servicio: string;
  recurso: Record<string, unknown>;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  nombre: string;
  /** 1 INTERNAL, 2 SERVER, 3 CLIENT (OTLP SpanKind). */
  tipo: number;
  atributos: Record<string, unknown>;
  /** 0 UNSET, 1 OK, 2 ERROR. */
  estado: { code?: number; message?: string };
}

/**
 * Un recolector OTLP/HTTP falso: recibe POST /v1/traces en JSON (lo que manda
 * @opentelemetry/exporter-trace-otlp-http) y guarda los spans y los cuerpos crudos (para el
 * escaneo). Puede responder lento o no estar.
 */
export class RecolectorOtlp {
  readonly spans: SpanRecibido[] = [];
  readonly cuerpos: string[] = [];
  readonly cabeceras: IncomingHttpHeaders[] = [];
  /** Cuánto tarda en responder cada envío (ms). */
  demoraMs = 0;
  private servidor?: Server;

  async iniciar(): Promise<this> {
    this.servidor = createServer((peticion, respuesta) => {
      const trozos: Buffer[] = [];
      peticion.on('data', (t: Buffer) => trozos.push(t));
      peticion.on('end', () => {
        const responder = () => {
          if (respuesta.destroyed) return;
          respuesta.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        };
        if (peticion.url !== '/v1/traces') {
          respuesta.writeHead(404).end();
          return;
        }
        const texto = Buffer.concat(trozos).toString('utf8');
        this.cuerpos.push(texto);
        this.cabeceras.push(peticion.headers);
        this.guardar(texto);
        if (this.demoraMs > 0) setTimeout(responder, this.demoraMs);
        else responder();
      });
    });
    await new Promise<void>((listo) => this.servidor!.listen(0, '127.0.0.1', listo));
    return this;
  }

  /** Base OTLP (sin /v1/traces), como OTEL_EXPORTER_OTLP_ENDPOINT. */
  get url(): string {
    const { port } = this.servidor!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Espera a que lleguen al menos `cuantos` spans (los lotes salen cada pocos ms en las pruebas). */
  async esperar(cuantos: number, plazoMs = 5000): Promise<SpanRecibido[]> {
    const fin = Date.now() + plazoMs;
    while (this.spans.length < cuantos && Date.now() < fin) {
      await new Promise((listo) => setTimeout(listo, 20));
    }
    return this.spans;
  }

  /** Espera a que lleguen al menos `cuantos` spans de esa traza. */
  async esperarTraza(traceId: string, cuantos: number, plazoMs = 5000): Promise<SpanRecibido[]> {
    const fin = Date.now() + plazoMs;
    while (this.deTraza(traceId).length < cuantos && Date.now() < fin) {
      await new Promise((listo) => setTimeout(listo, 20));
    }
    return this.deTraza(traceId);
  }

  deTraza(traceId: string): SpanRecibido[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  reiniciar(): void {
    this.spans.length = 0;
    this.cuerpos.length = 0;
    this.cabeceras.length = 0;
    this.demoraMs = 0;
  }

  private guardar(texto: string): void {
    const cuerpo = JSON.parse(texto) as {
      resourceSpans?: {
        resource?: { attributes?: Atributo[] };
        scopeSpans?: { spans?: SpanOtlp[] }[];
      }[];
    };
    for (const rs of cuerpo.resourceSpans ?? []) {
      const recurso = aplanar(rs.resource?.attributes ?? []);
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) {
          this.spans.push({
            servicio: String(recurso['service.name']),
            recurso,
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId ?? '',
            nombre: s.name,
            tipo: s.kind,
            atributos: aplanar(s.attributes ?? []),
            estado: s.status ?? {},
          });
        }
      }
    }
  }

  async detener(): Promise<void> {
    if (!this.servidor) return;
    this.servidor.closeAllConnections();
    await new Promise<void>((listo) => this.servidor!.close(() => listo()));
  }
}

interface Atributo {
  key: string;
  value: Record<string, unknown>;
}

interface SpanOtlp {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes?: Atributo[];
  status?: { code?: number; message?: string };
}

function aplanar(atributos: Atributo[]): Record<string, unknown> {
  return Object.fromEntries(
    atributos.map(({ key, value }) => [key, Object.values(value)[0]] as [string, unknown]),
  );
}
