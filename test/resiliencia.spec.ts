import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { PLAZO_CIERRE_MS } from '../src/observabilidad/trazas';
import { GatewayDePrueba, Servicios } from './utils/gateway';
import { RecolectorOtlp } from './utils/recolector-otlp';

async function puertoCerrado(): Promise<number> {
  const servidor = createServer();
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const { port } = servidor.address() as AddressInfo;
  await new Promise<void>((listo) => servidor.close(() => listo()));
  return port;
}

/** Duración de cada una de `n` peticiones públicas seguidas (ms) y sus status. */
async function medir(gateway: GatewayDePrueba, n: number) {
  const duraciones: number[] = [];
  const status: number[] = [];
  for (let i = 0; i < n; i++) {
    const inicio = Date.now();
    const r = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
    duraciones.push(Date.now() - inicio);
    status.push(r.status);
  }
  return { duraciones, status };
}

/**
 * El recolector nunca retrasa ni rompe una petición: la petición solo encola el span; el envío va
 * aparte, con cola, plazo (3 s) y descarte.
 */
describe('resiliencia del exportador', () => {
  const servicios = new Servicios();
  beforeAll(() => servicios.iniciar());
  afterAll(() => servicios.detener());

  it('con el recolector caído, todo responde igual y a tiempo', async () => {
    const gateway = await new GatewayDePrueba(servicios, {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${await puertoCerrado()}`,
    }).iniciar();
    try {
      const { duraciones, status } = await medir(gateway, 30);
      expect(status.every((s) => s === 200)).toBe(true);
      expect(Math.max(...duraciones)).toBeLessThan(300);
    } finally {
      await gateway.detener();
    }
  });

  it('con un recolector lento (5 s por envío), las peticiones no lo esperan', async () => {
    const lento = await new RecolectorOtlp().iniciar();
    lento.demoraMs = 5000;
    const gateway = await new GatewayDePrueba(servicios, {
      OTEL_EXPORTER_OTLP_ENDPOINT: lento.url,
    }).iniciar();
    try {
      // Los lotes salen cada 20 ms: durante la prueba siempre hay un envío colgado
      const { duraciones, status } = await medir(gateway, 30);
      expect(status.every((s) => s === 200)).toBe(true);
      expect(Math.max(...duraciones)).toBeLessThan(300);
      expect(lento.cuerpos.length).toBeGreaterThan(0);
    } finally {
      const inicio = Date.now();
      await gateway.detener();
      // Y cerrar no se cuelga esperando al recolector
      expect(Date.now() - inicio).toBeLessThan(PLAZO_CIERRE_MS + 1000);
      await lento.detener();
    }
  });

  it('al cerrar, los spans que quedaban en la cola salen', async () => {
    const recolector = await new RecolectorOtlp().iniciar();
    const gateway = new GatewayDePrueba(servicios, { OTEL_EXPORTER_OTLP_ENDPOINT: recolector.url });
    // Un lote cada minuto: lo único que puede hacerlos salir antes es el cierre
    gateway.esperaLoteMs = 60_000;
    await gateway.iniciar();
    const respuesta = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
    const traceId = String(respuesta.cabeceras['x-trace-id']);
    await new Promise((listo) => setTimeout(listo, 200));
    expect(recolector.deTraza(traceId)).toEqual([]);
    await gateway.detener();
    expect(recolector.deTraza(traceId).length).toBe(2);
    await recolector.detener();
  });

  it('un endpoint mal configurado no levanta el gateway (el entorno lo valida)', async () => {
    await expect(() =>
      new GatewayDePrueba(servicios, { OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://x' }).iniciar(),
    ).rejects.toThrow('OTEL_EXPORTER_OTLP_ENDPOINT');
  });
});
