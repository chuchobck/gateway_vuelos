import { GatewayDePrueba, Servicios } from './utils/gateway';

describe('salud', () => {
  const servicios = new Servicios();
  beforeAll(() => servicios.iniciar());
  afterAll(() => servicios.detener());

  it('/health y /health/ready responden aunque no haya ningún upstream', async () => {
    const gateway = await new GatewayDePrueba(servicios, {
      UPSTREAM_CORE_URL: 'http://127.0.0.1:9',
      UPSTREAM_BFF_URL: 'http://127.0.0.1:9',
      UPSTREAM_IDENTITY_URL: 'http://127.0.0.1:9',
      UPSTREAM_NOTIFIER_URL: 'http://127.0.0.1:9',
    }).iniciar();
    try {
      const vivo = await gateway.pedir({ ruta: '/health' });
      expect(vivo.status).toBe(200);
      expect(vivo.json()).toEqual({ status: 'UP' });
      const listo = await gateway.pedir({ ruta: '/health/ready' });
      expect(listo.status).toBe(200);
      expect(listo.json()).toEqual({
        status: 'UP',
        contract: { version: '1.5.0.0', operations: 22 },
        contractV2: { version: '2.0.0', operations: 30 },
      });
      expect(listo.cabeceras['cache-control']).toBe('no-store');
    } finally {
      await gateway.detener();
    }
  });

  it('/health/upstreams es informativo: 200 aunque uno esté caído, sin URLs', async () => {
    servicios.upstreams.notifier.manejador = (_p, r) => r.writeHead(503).end();
    const gateway = await new GatewayDePrueba(servicios, {
      UPSTREAM_BFF_URL: 'http://127.0.0.1:9',
    }).iniciar();
    try {
      const respuesta = await gateway.pedir({ ruta: '/health/upstreams' });
      expect(respuesta.status).toBe(200);
      const cuerpo = respuesta.json() as { status: string; upstreams: Record<string, unknown> };
      expect(cuerpo.status).toBe('UP');
      expect(cuerpo.upstreams.core).toMatchObject({ status: 'UP', httpStatus: 200 });
      expect(cuerpo.upstreams.identity).toMatchObject({ status: 'UP', httpStatus: 200 });
      expect(cuerpo.upstreams.notifier).toMatchObject({ status: 'DOWN', httpStatus: 503 });
      expect(cuerpo.upstreams.bff).toMatchObject({ status: 'DOWN' });
      expect(respuesta.texto).not.toMatch(/127\.0\.0\.1|http:/);
      // A cada servicio se le pregunta en su ruta de salud
      expect(servicios.upstreams.core.ultima().url).toBe('/flights/v1/health');
      expect(servicios.upstreams.identity.ultima().url).toBe('/identity/v1/health');
      expect(servicios.upstreams.notifier.ultima().url).toBe('/health');
    } finally {
      await gateway.detener();
      servicios.reiniciar();
    }
  });

  it('un upstream que no contesta en 2 s cuenta como DOWN', async () => {
    servicios.upstreams.core.manejador = () => undefined;
    const gateway = await new GatewayDePrueba(servicios).iniciar();
    try {
      const inicio = Date.now();
      const respuesta = await gateway.pedir({ ruta: '/health/upstreams' });
      expect(Date.now() - inicio).toBeLessThan(3500);
      expect((respuesta.json().upstreams as Record<string, unknown>).core).toMatchObject({
        status: 'DOWN',
      });
    } finally {
      await gateway.detener();
      servicios.reiniciar();
    }
  });

  it('solo GET y HEAD', async () => {
    const gateway = await new GatewayDePrueba(servicios).iniciar();
    try {
      const respuesta = await gateway.pedir({ metodo: 'POST', ruta: '/health', cuerpo: '{}' });
      expect(respuesta.status).toBe(405);
      expect(respuesta.cabeceras.allow).toBe('GET, HEAD');
    } finally {
      await gateway.detener();
    }
  });
});
