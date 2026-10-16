import { normalizarRuta } from '../src/rutas/normalizar-ruta';
import { TABLA_RUTAS } from '../src/rutas/tabla-rutas';
import { GatewayDePrueba, Servicios, TODOS_LOS_SCOPES } from './utils/gateway';

/**
 * Rutas: cada prefijo llega a su upstream sin reescribir; /internal/** nunca llega a ninguno,
 * ni codificado ni disfrazado; lo desconocido es 404 y lo ambiguo, 400.
 */
describe('rutas', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;
  let token: string;

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = await new GatewayDePrueba(servicios).iniciar();
    token = await gateway.token({ scope: TODOS_LOS_SCOPES });
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });
  beforeEach(() => servicios.reiniciar());

  describe('cada prefijo llega a su upstream, con su ruta intacta', () => {
    const casos: [string, string, string][] = [
      ['POST', '/graphql', 'bff'],
      ['GET', '/flights/v1/webhooks', 'notifier'],
      ['POST', '/flights/v1/webhooks', 'notifier'],
      ['DELETE', '/flights/v1/webhooks/7d3c0f8e-2b1a-4c5d-9e6f-0a1b2c3d4e5f', 'notifier'],
      ['POST', '/flights/v1/search', 'core'],
      ['GET', '/flights/v1/bookings', 'core'],
      ['GET', '/flights/v1/flights/QN123/status', 'core'],
      ['GET', '/flights/v1/admin/countries', 'core'],
      ['GET', '/flights/v1/health', 'core'],
      ['POST', '/flights/v1/auth/login', 'core'],
      ['POST', '/identity/v1/auth/login', 'identity'],
      ['POST', '/identity/v1/auth/register', 'identity'],
      ['GET', '/identity/v1/auth/me', 'identity'],
      ['GET', '/identity/v1/admin/users', 'identity'],
      ['POST', '/oauth2/token', 'identity'],
      ['GET', '/.well-known/jwks.json', 'identity'],
      ['GET', '/.well-known/openid-configuration', 'identity'],
    ];

    it.each(casos)('%s %s → %s', async (metodo, ruta, destino) => {
      const respuesta = await gateway.pedir({
        metodo,
        ruta,
        cabeceras: { authorization: `Bearer ${token}` },
      });
      expect(respuesta.status).toBe(200);
      expect(servicios.totalRecibidas()).toBe(1);
      const recibida = servicios.upstreams[destino as keyof typeof servicios.upstreams].ultima();
      expect(recibida.metodo).toBe(metodo);
      expect(recibida.url).toBe(ruta);
    });

    it('la query llega tal cual y la barra final se quita', async () => {
      await gateway.pedir({
        ruta: '/flights/v1/bookings/?status=CONFIRMED&page=2',
        cabeceras: { authorization: `Bearer ${token}` },
      });
      expect(servicios.upstreams.core.ultima().url).toBe(
        '/flights/v1/bookings?status=CONFIRMED&page=2',
      );
    });

    it('/flights/v1/webhooks no cae en el core aunque venga en mayúsculas o codificado', async () => {
      for (const ruta of [
        '/FLIGHTS/V1/WEBHOOKS',
        '/flights/v1/%77ebhooks',
        '/flights/v1/webhooks/',
      ]) {
        servicios.reiniciar();
        const respuesta = await gateway.pedir({
          ruta,
          cabeceras: { authorization: `Bearer ${token}` },
        });
        expect(respuesta.status).toBe(200);
        expect(servicios.upstreams.notifier.recibidas).toHaveLength(1);
        expect(servicios.upstreams.core.recibidas).toHaveLength(0);
      }
      // Se reenvía la ruta que se decidió (decodificada y canónica), no otra
      expect(servicios.upstreams.notifier.ultima().url).toBe('/flights/v1/webhooks');
    });
  });

  describe('/internal/** nunca se enruta', () => {
    const variantes = [
      '/internal/v1/events',
      '/internal',
      '/internal/',
      '/INTERNAL/v1/events',
      '/Internal/V1/Events',
      '/%69nternal/v1/events',
      '/%49NTERNAL/v1/events',
      '/internal/v1/events?x=1',
      '/internal/v1/events/',
    ];

    it.each(variantes)('POST %s → 404 sin tocar ningún upstream', async (ruta) => {
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta,
        cabeceras: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        cuerpo: '{}',
      });
      expect(respuesta.status).toBe(404);
      expect(respuesta.cabeceras['content-type']).toMatch(/^application\/problem\+json/);
      expect(servicios.totalRecibidas()).toBe(0);
    });

    const disfrazadas = [
      '/flights/v1/../../internal/v1/events',
      '/flights/v1/%2e%2e/%2e%2e/internal/v1/events',
      '/flights/v1/%2E%2E/%2e%2E/internal/v1/events',
      '/graphql/..%2f..%2finternal/v1/events',
      '/flights/v1/webhooks/%252e%252e/internal',
      '/flights/v1/webhooks%2f..%2f..%2f..%2finternal%2fv1%2fevents',
      '//internal/v1/events',
      '/./internal/v1/events',
      '/flights/v1/./../../internal/v1/events',
      '/identity/v1/%5c..%5c..%5cinternal',
    ];

    it.each(disfrazadas)('%s → 400 o 404, nunca un upstream', async (ruta) => {
      const respuesta = await gateway.pedir({ metodo: 'POST', ruta, cuerpo: '{}' });
      expect([400, 404]).toContain(respuesta.status);
      expect(servicios.totalRecibidas()).toBe(0);
    });

    it('va antes que la tabla: ni una regla que lo cubriera lo deja pasar', async () => {
      const comodin = new GatewayDePrueba(servicios, {}, [
        ...TABLA_RUTAS,
        {
          patron: '/**',
          destino: 'notifier',
          seguridad: { modo: 'publica' },
          cuerpoMaximo: 1024,
          nota: 'solo para esta prueba',
        },
      ]);
      await comodin.iniciar();
      try {
        for (const ruta of variantes) {
          const respuesta = await comodin.pedir({ metodo: 'POST', ruta, cuerpo: '{}' });
          expect(respuesta.status).toBe(404);
        }
        expect(servicios.totalRecibidas()).toBe(0);
        // La regla comodín sí funciona para lo demás
        expect((await comodin.pedir({ ruta: '/otra/cosa' })).status).toBe(200);
        expect(servicios.upstreams.notifier.recibidas).toHaveLength(1);
      } finally {
        await comodin.detener();
      }
    });
  });

  describe('lo que no está en la tabla es 404', () => {
    it.each([
      '/',
      '/api/docs',
      '/api/docs-json',
      '/flights',
      '/flights/v2/search',
      '/identity',
      '/oauth2/authorize',
      '/flights.v1.FlightsService/SearchFlights',
      '/graphql/extra',
      '/favicon.ico',
    ])('%s → 404 ProblemDetails, sin upstream', async (ruta) => {
      const respuesta = await gateway.pedir({ ruta });
      expect(respuesta.status).toBe(404);
      expect(respuesta.json()).toEqual({
        type: 'https://api.booking-hub.com/errors/validation-failed',
        title: 'Not Found',
        status: 404,
        detail: 'No route matches the request',
        code: 'VALIDATION_FAILED',
      });
      expect(respuesta.cabeceras['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(servicios.totalRecibidas()).toBe(0);
    });
  });

  describe('lo ambiguo es 400', () => {
    it.each([
      '/flights/v1//bookings',
      '/flights/v1/./bookings',
      '/flights/v1/bookings/..',
      '/flights/v1/%2e/bookings',
      '/flights/v1/bookings%2fabc',
      '/flights/v1/bookings%5cabc',
      '/flights/v1/%252e%252e',
      '/flights/v1/a%zz',
      '/flights/v1/a%',
      '/flights/v1/%00',
      '/flights/v1/a\\b',
    ])('%s → 400 sin upstream', async (ruta) => {
      const respuesta = await gateway.pedir({
        ruta,
        cabeceras: { authorization: `Bearer ${token}` },
      });
      expect(respuesta.status).toBe(400);
      expect(respuesta.cabeceras['content-type']).toMatch(/^application\/problem\+json/);
      expect(respuesta.cabeceras['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(servicios.totalRecibidas()).toBe(0);
    });
  });

  describe('normalizarRuta', () => {
    it('decodifica una vez, decide en minúsculas y reenvía la forma canónica', () => {
      expect(normalizarRuta('/Flights/V1/%77ebhooks/?a=%2F')).toEqual({
        segmentos: ['Flights', 'V1', 'webhooks'],
        clave: '/flights/v1/webhooks',
        ruta: '/Flights/V1/webhooks',
        query: 'a=%2F',
      });
      expect(normalizarRuta('/').ruta).toBe('/');
      expect(normalizarRuta('/flights/v1/cities/Quito%20Norte').ruta).toBe(
        '/flights/v1/cities/Quito%20Norte',
      );
      expect(normalizarRuta('/flights/v1/cities/Ca%C3%B1ar').segmentos[3]).toBe('Cañar');
      expect(normalizarRuta('/a/b:c@d').ruta).toBe('/a/b:c@d');
    });

    it.each(['http://evil/internal', '*', 'internal', '/a#b', '/a/b?c#d'])('rechaza %s', (url) => {
      expect(() => normalizarRuta(url)).toThrow('ambiguous');
    });
  });
});
