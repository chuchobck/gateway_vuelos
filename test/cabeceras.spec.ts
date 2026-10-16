import { ipCliente } from '../src/borde/ip-cliente';
import { GatewayDePrueba, ORIGEN_PERMITIDO, Servicios } from './utils/gateway';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('cabeceras', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = await new GatewayDePrueba(servicios).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });
  beforeEach(() => servicios.reiniciar());

  describe('X-Request-Id', () => {
    it('uno válido se conserva: en la respuesta, hacia el upstream y en el log', async () => {
      const id = 'b9f1c3a2-5d4e-4f6a-8b7c-0d1e2f3a4b5c';
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { 'x-request-id': id },
        cuerpo: '{}',
      });
      expect(respuesta.cabeceras['x-request-id']).toBe(id);
      expect(servicios.upstreams.bff.ultima().cabeceras['x-request-id']).toBe(id);
      expect(gateway.registros()).toContainEqual(
        expect.objectContaining({ requestId: id, msg: 'acceso', upstream: 'bff', status: 200 }),
      );
    });

    it.each([
      ['falta', undefined],
      ['no es uuid', 'hola'],
      [
        'inyección en el log',
        'b9f1c3a2-5d4e-4f6a-8b7c-0d1e2f3a4b5c\n{"level":60}'.replace('\n', ' '),
      ],
      ['demasiado largo', 'a'.repeat(500)],
    ])('uno que %s se reemplaza por un uuid nuevo', async (_caso, id) => {
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: id === undefined ? {} : { 'x-request-id': id },
        cuerpo: '{}',
      });
      const nuevo = String(respuesta.cabeceras['x-request-id']);
      expect(nuevo).toMatch(UUID);
      expect(nuevo).not.toBe(id);
      expect(servicios.upstreams.bff.ultima().cabeceras['x-request-id']).toBe(nuevo);
    });

    it('el X-Request-Id que mande el upstream no reemplaza al del gateway', async () => {
      servicios.upstreams.core.manejador = (_p, r) => {
        r.writeHead(200, { 'x-request-id': 'otro-id-del-upstream' }).end('{}');
      };
      const respuesta = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
      expect(respuesta.cabeceras['x-request-id']).toMatch(UUID);
    });

    it('un error del borde también lo lleva', async () => {
      const respuesta = await gateway.pedir({ ruta: '/no-existe' });
      expect(respuesta.cabeceras['x-request-id']).toMatch(UUID);
    });
  });

  describe('hacia el upstream', () => {
    it('pasan tal cual Authorization, Idempotency-Key, X-Device-Fingerprint, traceparent y tracestate', async () => {
      const cabeceras = {
        authorization: 'Bearer cualquier.cosa.aqui',
        'idempotency-key': '0f8fad5b-d9cb-469f-a165-70867728950e',
        'x-device-fingerprint': 'huella-de-prueba-123',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        tracestate: 'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7',
        'if-none-match': '"abc"',
        'accept-encoding': 'gzip, br',
        'content-type': 'application/json',
      };
      await gateway.pedir({ metodo: 'POST', ruta: '/flights/v1/search', cabeceras, cuerpo: '{}' });
      const recibidas = servicios.upstreams.core.ultima().cabeceras;
      for (const [nombre, valor] of Object.entries(cabeceras)) {
        expect(recibidas[nombre]).toBe(valor);
      }
    });

    it('fuera hop-by-hop y lo que el cliente no puede dictar; X-Forwarded-* son del gateway', async () => {
      await gateway.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: {
          connection: 'keep-alive, x-secreto-de-conexion',
          'x-secreto-de-conexion': '1',
          'keep-alive': 'timeout=5',
          te: 'trailers',
          upgrade: 'websocket',
          'proxy-authorization': 'Basic Zm9vOmJhcg==',
          'proxy-connection': 'keep-alive',
          forwarded: 'for=6.6.6.6;proto=https',
          'x-forwarded-for': '6.6.6.6',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
          'x-forwarded-port': '443',
          'x-real-ip': '6.6.6.6',
          host: 'gateway.quinde.example',
        },
        cuerpo: '{}',
      });
      const recibida = servicios.upstreams.bff.ultima();
      const nombres = Object.keys(recibida.cabeceras);
      for (const prohibida of [
        'x-secreto-de-conexion',
        'keep-alive',
        'te',
        'upgrade',
        'proxy-authorization',
        'proxy-connection',
        'forwarded',
        'x-real-ip',
        'x-forwarded-port',
      ]) {
        expect(nombres).not.toContain(prohibida);
      }
      expect(recibida.cabeceras['x-forwarded-for']).toBe('127.0.0.1');
      expect(recibida.cabeceras['x-forwarded-proto']).toBe('http');
      expect(recibida.cabeceras['x-forwarded-host']).toBe('gateway.quinde.example');
      expect(recibida.cabeceras.host).toBe(new URL(servicios.upstreams.bff.url).host);
      // Un solo X-Forwarded-For, sin la cadena del cliente
      expect(recibida.crudas.filter((c) => c.toLowerCase() === 'x-forwarded-for')).toHaveLength(1);
    });
  });

  describe('hacia el cliente', () => {
    it('fuera hop-by-hop, Server y X-Powered-By; pasan Retry-After, ETag, Cache-Control', async () => {
      servicios.upstreams.core.manejador = (_p, r) => {
        r.writeHead(200, {
          'content-type': 'application/json',
          server: 'Express/4',
          'x-powered-by': 'Express',
          'keep-alive': 'timeout=99',
          'x-hop': '1',
          connection: 'x-hop',
          'retry-after': '7',
          etag: '"v1"',
          'cache-control': 'no-store',
          'x-ratelimit-remaining': '9',
        });
        r.end('{}');
      };
      const respuesta = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
      expect(respuesta.cabeceras.server).toBeUndefined();
      expect(respuesta.cabeceras['x-powered-by']).toBeUndefined();
      expect(respuesta.cabeceras['x-hop']).toBeUndefined();
      expect(respuesta.cabeceras['keep-alive']).not.toBe('timeout=99');
      expect(respuesta.cabeceras['retry-after']).toBe('7');
      expect(respuesta.cabeceras.etag).toBe('"v1"');
      expect(respuesta.cabeceras['cache-control']).toBe('no-store');
      expect(respuesta.cabeceras['x-ratelimit-remaining']).toBe('9');
      expect(respuesta.cabeceras['x-content-type-options']).toBe('nosniff');
      expect(respuesta.cabeceras['strict-transport-security']).toBeUndefined();
    });

    it('en producción, HSTS', async () => {
      const prod = await new GatewayDePrueba(servicios, {
        NODE_ENV: 'production',
        JWT_ISSUER: 'https://gateway.quinde.example',
      }).iniciar();
      try {
        const respuesta = await prod.pedir({ ruta: '/health' });
        expect(respuesta.cabeceras['strict-transport-security']).toBe(
          'max-age=31536000; includeSubDomains',
        );
      } finally {
        await prod.detener();
      }
    });
  });

  describe('CORS', () => {
    beforeEach(() => {
      // Un upstream con su propio CORS (como el core con su CORS_ORIGINS): se borra entero
      for (const upstream of Object.values(servicios.upstreams)) {
        upstream.manejador = (_p, r) => {
          r.writeHead(200, {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'access-control-allow-credentials': 'true',
            'access-control-expose-headers': 'X-RateLimit-Limit',
            vary: 'Accept-Encoding',
          });
          r.end('{}');
        };
      }
    });

    it('origen permitido: el CORS del gateway, sin comodín ni credenciales, y el del upstream fuera', async () => {
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { origin: ORIGEN_PERMITIDO, 'content-type': 'application/json' },
        cuerpo: '{}',
      });
      expect(respuesta.status).toBe(200);
      const acao = respuesta.crudas.filter(
        (c) => c.toLowerCase() === 'access-control-allow-origin',
      );
      expect(acao).toHaveLength(1);
      expect(respuesta.cabeceras['access-control-allow-origin']).toBe(ORIGEN_PERMITIDO);
      expect(respuesta.cabeceras['access-control-allow-credentials']).toBeUndefined();
      expect(respuesta.cabeceras['access-control-expose-headers']).toBe(
        'x-request-id, retry-after',
      );
      expect(respuesta.cabeceras.vary).toBe('Accept-Encoding, Origin');
    });

    it('origen no permitido: ninguna Access-Control-*, tampoco la del upstream', async () => {
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { origin: 'https://evil.example' },
        cuerpo: '{}',
      });
      const acc = Object.keys(respuesta.cabeceras).filter((c) => c.startsWith('access-control-'));
      expect(acc).toEqual([]);
    });

    it('un error del borde también lleva CORS (el navegador puede leer el 401)', async () => {
      const respuesta = await gateway.pedir({
        ruta: '/flights/v1/bookings',
        cabeceras: { origin: ORIGEN_PERMITIDO },
      });
      expect(respuesta.status).toBe(401);
      expect(respuesta.cabeceras['access-control-allow-origin']).toBe(ORIGEN_PERMITIDO);
    });

    it('preflight permitido: 204 sin llegar al upstream', async () => {
      const respuesta = await gateway.pedir({
        metodo: 'OPTIONS',
        ruta: '/flights/v1/bookings',
        cabeceras: {
          origin: ORIGEN_PERMITIDO,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type, idempotency-key',
        },
      });
      expect(respuesta.status).toBe(204);
      expect(respuesta.cabeceras['access-control-allow-origin']).toBe(ORIGEN_PERMITIDO);
      expect(respuesta.cabeceras['access-control-allow-methods']).toBe(
        'GET, HEAD, POST, PUT, PATCH, DELETE',
      );
      const permitidas = String(respuesta.cabeceras['access-control-allow-headers']).split(', ');
      expect(permitidas).toEqual(
        expect.arrayContaining([
          'authorization',
          'content-type',
          'idempotency-key',
          'x-request-id',
          'x-device-fingerprint',
          'traceparent',
          'tracestate',
        ]),
      );
      expect(respuesta.cabeceras['access-control-max-age']).toBe('600');
      expect(respuesta.cabeceras['access-control-allow-credentials']).toBeUndefined();
      expect(servicios.totalIniciadas()).toBe(0);
    });

    it('preflight denegado: 204 sin Access-Control-* (el navegador bloquea)', async () => {
      const respuesta = await gateway.pedir({
        metodo: 'OPTIONS',
        ruta: '/graphql',
        cabeceras: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      expect(respuesta.status).toBe(204);
      expect(
        Object.keys(respuesta.cabeceras).filter((c) => c.startsWith('access-control-')),
      ).toEqual([]);
      expect(servicios.totalIniciadas()).toBe(0);
    });

    it('un preflight no se salta el bloqueo ni la normalización', async () => {
      const ambigua = await gateway.pedir({
        metodo: 'OPTIONS',
        ruta: '/flights/v1/%2e%2e/internal',
        cabeceras: { origin: ORIGEN_PERMITIDO, 'access-control-request-method': 'POST' },
      });
      expect(ambigua.status).toBe(400);
    });
  });

  describe('IP real (ipCliente)', () => {
    it('con 0 saltos: el socket, X-Forwarded-For se ignora', () => {
      expect(ipCliente('10.1.1.1', '6.6.6.6', 0)).toBe('10.1.1.1');
      expect(ipCliente('::ffff:10.1.1.1', undefined, 0)).toBe('10.1.1.1');
    });

    it('con N saltos: la N-ésima desde la derecha; lo de más a la izquierda no se mira', () => {
      expect(ipCliente('10.0.0.9', '6.6.6.6, 200.1.1.1', 1)).toBe('200.1.1.1');
      expect(ipCliente('10.0.0.9', '6.6.6.6, 200.1.1.1, 10.0.0.8', 2)).toBe('200.1.1.1');
      expect(ipCliente('10.0.0.9', ['6.6.6.6', '200.1.1.1'], 1)).toBe('200.1.1.1');
    });

    it('cadena más corta que N o entrada inválida: la más lejana de confianza', () => {
      expect(ipCliente('10.0.0.9', undefined, 1)).toBe('10.0.0.9');
      expect(ipCliente('10.0.0.9', '200.1.1.1', 3)).toBe('200.1.1.1');
      expect(ipCliente('10.0.0.9', 'no-es-ip', 1)).toBe('10.0.0.9');
      expect(ipCliente('10.0.0.9', 'no-es-ip, 200.1.1.1', 2)).toBe('200.1.1.1');
    });
  });
});
