import { request } from 'node:http';
import { CUERPO_100KB } from '../src/rutas/tabla-rutas';
import { GatewayDePrueba, Servicios } from './utils/gateway';

const pedirDesde = (gateway: GatewayDePrueba, xff: string | undefined, ruta = '/graphql') =>
  gateway.pedir({
    metodo: 'POST',
    ruta,
    cabeceras: {
      'content-type': 'application/json',
      ...(xff === undefined ? {} : { 'x-forwarded-for': xff }),
    },
    cuerpo: '{}',
  });

describe('límites', () => {
  const servicios = new Servicios();
  beforeAll(() => servicios.iniciar());
  afterAll(() => servicios.detener());
  beforeEach(() => servicios.reiniciar());

  describe('global, con 0 saltos', () => {
    let gateway: GatewayDePrueba;
    beforeEach(async () => {
      gateway = await new GatewayDePrueba(servicios, {
        RATE_LIMIT_MAX: '3',
        RATE_LIMIT_WINDOW_SECONDS: '60',
        TRUST_PROXY_HOPS: '0',
      }).iniciar();
    });
    afterEach(() => gateway.detener());

    it('429 RATE_LIMIT_EXCEEDED con Retry-After, sin llegar al upstream; se abre al pasar la ventana', async () => {
      for (let i = 0; i < 3; i++) expect((await pedirDesde(gateway, undefined)).status).toBe(200);
      const limitada = await pedirDesde(gateway, undefined);
      expect(limitada.status).toBe(429);
      expect(limitada.json()).toMatchObject({ status: 429, code: 'RATE_LIMIT_EXCEEDED' });
      expect(limitada.cabeceras['retry-after']).toBe('60');
      expect(servicios.upstreams.bff.recibidas).toHaveLength(3);

      gateway.reloj.adelantar(30_000);
      expect((await pedirDesde(gateway, undefined)).cabeceras['retry-after']).toBe('30');
      gateway.reloj.adelantar(30_000);
      expect((await pedirDesde(gateway, undefined)).status).toBe(200);
    });

    it('un X-Forwarded-For falsificado no cambia la IP que cuenta', async () => {
      for (let i = 0; i < 3; i++) {
        expect((await pedirDesde(gateway, `203.0.113.${i}`)).status).toBe(200);
      }
      expect((await pedirDesde(gateway, '203.0.113.99')).status).toBe(429);
      // Y hacia el upstream va la IP real, no la inventada
      expect(servicios.upstreams.bff.ultima().cabeceras['x-forwarded-for']).toBe('127.0.0.1');
    });

    it('el límite es uno para todas las rutas (no uno por ruta)', async () => {
      await pedirDesde(gateway, undefined, '/graphql');
      await pedirDesde(gateway, undefined, '/flights/v1/search');
      await gateway.pedir({ ruta: '/health' });
      expect((await pedirDesde(gateway, undefined, '/identity/v1/auth/refresh')).status).toBe(429);
    });
  });

  describe('global, con 1 salto (un proxy de confianza delante)', () => {
    let gateway: GatewayDePrueba;
    beforeEach(async () => {
      gateway = await new GatewayDePrueba(servicios, {
        RATE_LIMIT_MAX: '2',
        TRUST_PROXY_HOPS: '1',
      }).iniciar();
    });
    afterEach(() => gateway.detener());

    it('cuenta la IP que agregó el proxy; lo que el cliente puso antes no cambia nada', async () => {
      // El proxy agrega la IP real (198.51.100.7) a la derecha de lo que mandó el cliente
      expect((await pedirDesde(gateway, '6.6.6.1, 198.51.100.7')).status).toBe(200);
      expect((await pedirDesde(gateway, '6.6.6.2, 198.51.100.7')).status).toBe(200);
      expect((await pedirDesde(gateway, '6.6.6.3, 198.51.100.7')).status).toBe(429);
      expect(servicios.upstreams.bff.ultima().cabeceras['x-forwarded-for']).toBe('198.51.100.7');
    });

    it('cada IP distinta tiene su propio contador', async () => {
      expect((await pedirDesde(gateway, '198.51.100.1')).status).toBe(200);
      expect((await pedirDesde(gateway, '198.51.100.1')).status).toBe(200);
      expect((await pedirDesde(gateway, '198.51.100.1')).status).toBe(429);
      expect((await pedirDesde(gateway, '198.51.100.2')).status).toBe(200);
    });
  });

  describe('estricto en /oauth2/token, /identity/v1/auth/login y /register', () => {
    let gateway: GatewayDePrueba;
    beforeEach(async () => {
      gateway = await new GatewayDePrueba(servicios, {
        RATE_LIMIT_STRICT_MAX: '2',
        RATE_LIMIT_STRICT_WINDOW_SECONDS: '120',
        TRUST_PROXY_HOPS: '1',
      }).iniciar();
    });
    afterEach(() => gateway.detener());

    it.each(['/oauth2/token', '/identity/v1/auth/login', '/identity/v1/auth/register'])(
      '%s: 429 al pasar el estricto, por IP',
      async (ruta) => {
        expect((await pedirDesde(gateway, '192.0.2.10', ruta)).status).toBe(200);
        expect((await pedirDesde(gateway, '192.0.2.10', ruta)).status).toBe(200);
        const limitada = await pedirDesde(gateway, '192.0.2.10', ruta);
        expect(limitada.status).toBe(429);
        expect(limitada.cabeceras['retry-after']).toBe('120');
        // Otra IP no está limitada, y la misma IP sigue pudiendo usar el resto
        expect((await pedirDesde(gateway, '192.0.2.11', ruta)).status).toBe(200);
        expect((await pedirDesde(gateway, '192.0.2.10', '/identity/v1/auth/refresh')).status).toBe(
          200,
        );
        expect(servicios.upstreams.identity.recibidas).toHaveLength(4);
      },
    );

    it('cada ruta estricta lleva su contador', async () => {
      await pedirDesde(gateway, '192.0.2.20', '/identity/v1/auth/login');
      await pedirDesde(gateway, '192.0.2.20', '/identity/v1/auth/login');
      expect((await pedirDesde(gateway, '192.0.2.20', '/identity/v1/auth/register')).status).toBe(
        200,
      );
    });
  });

  describe('cuerpo máximo', () => {
    let gateway: GatewayDePrueba;
    beforeAll(async () => {
      gateway = await new GatewayDePrueba(servicios).iniciar();
    });
    afterAll(() => gateway.detener());

    it('con Content-Length sobre 100 kB: 413 sin llegar al upstream', async () => {
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/flights/v1/search',
        cabeceras: { 'content-type': 'application/json' },
        cuerpo: Buffer.alloc(CUERPO_100KB + 1, 'a'),
      });
      expect(respuesta.status).toBe(413);
      expect(respuesta.json()).toMatchObject({ status: 413, title: 'Payload Too Large' });
      // Ni siquiera empieza a llegarle: se decide con Content-Length, antes de abrir la conexión
      expect(servicios.totalIniciadas()).toBe(0);
    });

    it('con Content-Length de 1 MB: 413 enseguida, sin esperar el cuerpo ni abrir el upstream', async () => {
      const url = new URL(gateway.base);
      const status = await new Promise<number>((resolver, rechazar) => {
        const salida = request({
          hostname: url.hostname,
          port: url.port,
          method: 'POST',
          path: '/flights/v1/search',
          headers: { 'content-type': 'application/json', 'content-length': 1024 * 1024 },
          agent: false,
        });
        const plazo = setTimeout(() => {
          salida.destroy();
          rechazar(new Error('el gateway esperó el cuerpo en lugar de responder 413'));
        }, 2000);
        salida.on('response', (respuesta) => {
          clearTimeout(plazo);
          respuesta.resume();
          salida.destroy();
          resolver(respuesta.statusCode ?? 0);
        });
        salida.on('error', () => undefined);
        // Solo 1 KB de lo declarado: el resto nunca llega
        salida.write(Buffer.alloc(1024, 'a'));
      });
      expect(status).toBe(413);
      expect(servicios.totalIniciadas()).toBe(0);
    });

    it('en trozos (sin Content-Length) sobre 100 kB: 413 y el upstream no lo procesa', async () => {
      servicios.upstreams.bff.manejador = (_p, r) => r.writeHead(200).end('{}');
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { 'content-type': 'application/json' },
        cuerpo: Buffer.alloc(CUERPO_100KB + 10, 'a'),
        enTrozos: true,
      });
      expect(respuesta.status).toBe(413);
      // Llega a lo sumo una petición cortada, nunca un cuerpo completo de más de 100 kB
      for (const recibida of servicios.upstreams.bff.recibidas) {
        expect(recibida.cuerpo.length).toBeLessThanOrEqual(CUERPO_100KB);
      }
    });

    it('exactamente 100 kB pasa', async () => {
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/flights/v1/search',
        cabeceras: { 'content-type': 'application/json' },
        cuerpo: Buffer.alloc(CUERPO_100KB, 'a'),
      });
      expect(respuesta.status).toBe(200);
      expect(servicios.upstreams.core.ultima().cuerpo.length).toBe(CUERPO_100KB);
    });
  });
});
