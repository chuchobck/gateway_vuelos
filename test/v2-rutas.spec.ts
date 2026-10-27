import { randomUUID } from 'node:crypto';
import { ContratoCore, RUTA_CONTRATO_V2 } from '../src/rutas/contrato-core';
import { GatewayDePrueba, Servicios } from './utils/gateway';

/** Una instancia concreta de la plantilla del contrato (`{bookingId}` → un uuid). */
function rutaDe(plantilla: string): string {
  return plantilla.replace(/\{[^}]+\}/g, () => randomUUID());
}

const v2 = ContratoCore.leer(RUTA_CONTRATO_V2);
const protegidas = v2.operaciones.filter((o) => !o.publica);
const publicas = v2.operaciones.filter((o) => o.publica);

/** A quién va cada operación v2: webhooks y eventos al notifier, el resto al core. */
function upstreamDe(plantilla: string): 'core' | 'notifier' {
  return /^\/api\/v2\/vuelos\/(webhooks|eventos)(\/|$)/.test(plantilla) ? 'notifier' : 'core';
}

/**
 * La tabla v2 (/api/v2, Booking Prototipo): cada prefijo a su upstream sin reescribir la ruta
 * (salvo /api/v2/oauth2/token), los scopes de CADA operación del contrato v2 y lo no declarado
 * negado en el borde.
 */
describe('rutas v2', () => {
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

  it('el contrato v2 tiene 26 operaciones protegidas y 4 públicas', () => {
    expect(protegidas).toHaveLength(26);
    expect(publicas.map((o) => `${o.metodo} ${o.plantilla}`).sort()).toEqual([
      'GET /api/v2/vuelos/flights/{flightNumber}/status',
      'GET /api/v2/vuelos/health',
      'GET /api/v2/vuelos/offers/{offerId}/seatmap',
      'POST /api/v2/vuelos/search',
    ]);
  });

  describe.each(protegidas.map((o) => [`${o.metodo} ${o.plantilla}`, o] as const))(
    '%s',
    (_nombre, operacion) => {
      const { metodo, plantilla } = operacion;
      const requeridos = operacion.alternativas[0] ?? [];
      const pedirCon = (authorization?: string) =>
        gateway.pedir({
          metodo,
          ruta: rutaDe(plantilla),
          cabeceras: {
            'content-type': 'application/json',
            ...(authorization === undefined ? {} : { authorization }),
          },
          ...(['POST', 'PUT', 'PATCH'].includes(metodo) ? { cuerpo: '{}' } : {}),
        });

      it('sin token → 401 sin tocar el upstream', async () => {
        const respuesta = await pedirCon();
        expect(respuesta.status).toBe(401);
        expect(String(respuesta.cabeceras['www-authenticate'])).toMatch(/^Bearer /);
        expect(servicios.totalIniciadas()).toBe(0);
      });

      it(`sin ${requeridos.join(' ')} → 403 sin tocar el upstream`, async () => {
        const token = await gateway.token({ scope: 'flights:none' });
        const respuesta = await pedirCon(`Bearer ${token}`);
        expect(respuesta.status).toBe(403);
        expect(String(respuesta.cabeceras['www-authenticate'])).toContain(
          'error="insufficient_scope"',
        );
        expect(servicios.totalIniciadas()).toBe(0);
      });

      it(`con ${requeridos.join(' ')} → pasa a ${upstreamDe(plantilla)} con la ruta intacta`, async () => {
        const token = await gateway.token({ scope: requeridos.join(' '), clientId: 'booking' });
        const ruta = rutaDe(plantilla);
        const respuesta = await gateway.pedir({
          metodo,
          ruta: `${ruta}?page=1`,
          cabeceras: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(['POST', 'PUT', 'PATCH'].includes(metodo) ? { cuerpo: '{}' } : {}),
        });
        expect(respuesta.status).toBe(200);
        const destino = servicios.upstreams[upstreamDe(plantilla)];
        expect(destino.recibidas).toHaveLength(1);
        expect(destino.recibidas[0]).toMatchObject({ metodo, url: `${ruta}?page=1` });
        expect(destino.recibidas[0]?.cabeceras.authorization).toBe(`Bearer ${token}`);
        expect(servicios.totalIniciadas()).toBe(1);
      });
    },
  );

  it.each(publicas.map((o) => [`${o.metodo} ${o.plantilla}`, o] as const))(
    '%s es pública: pasa al core sin token',
    async (_nombre, { metodo, plantilla }) => {
      const ruta = rutaDe(plantilla);
      const respuesta = await gateway.pedir({
        metodo,
        ruta,
        ...(metodo === 'POST'
          ? { cabeceras: { 'content-type': 'application/json' }, cuerpo: '{}' }
          : {}),
      });
      expect(respuesta.status).toBe(200);
      expect(servicios.upstreams.core.recibidas[0]).toMatchObject({ metodo, url: ruta });
    },
  );

  it('una pública con un token inválido igual pasa: el core decide', async () => {
    const respuesta = await gateway.pedir({
      metodo: 'POST',
      ruta: '/api/v2/vuelos/search',
      cabeceras: { authorization: 'Bearer basura', 'content-type': 'application/json' },
      cuerpo: '{}',
    });
    expect(respuesta.status).toBe(200);
    expect(servicios.upstreams.core.recibidas).toHaveLength(1);
  });

  it('/api/v2/oauth2/token llega a identity como /oauth2/token, con su query y su cuerpo', async () => {
    const respuesta = await gateway.pedir({
      metodo: 'POST',
      ruta: '/api/v2/oauth2/token?x=1',
      cabeceras: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic Ym9va2luZzpzZWNyZXRv',
      },
      cuerpo: 'grant_type=client_credentials',
    });
    expect(respuesta.status).toBe(200);
    const [recibida] = servicios.upstreams.identity.recibidas;
    expect(recibida).toMatchObject({ metodo: 'POST', url: '/oauth2/token?x=1' });
    expect(recibida?.cuerpo.toString()).toBe('grant_type=client_credentials');
    expect(recibida?.cabeceras.authorization).toBe('Basic Ym9va2luZzpzZWNyZXRv');
    expect(servicios.totalIniciadas()).toBe(1);
  });

  it('/oauth2/token sigue igual', async () => {
    const respuesta = await gateway.pedir({ metodo: 'POST', ruta: '/oauth2/token' });
    expect(respuesta.status).toBe(200);
    expect(servicios.upstreams.identity.recibidas[0]?.url).toBe('/oauth2/token');
  });

  it.each([
    ['GET', '/api/v2/vuelos/no-existe'],
    ['DELETE', '/api/v2/vuelos/bookings/abc'],
    ['PUT', '/api/v2/vuelos/search'],
    ['GET', '/api/v2/vuelos/search'],
    ['PATCH', '/api/v2/vuelos/webhooks'],
    ['GET', '/api/v2/vuelos/webhooks/abc'],
    ['POST', '/api/v2/vuelos/eventos'],
    ['GET', '/api/v2/vuelos/bookings/abc/tickets/def/extra'],
    ['GET', '/api/v2/vuelos'],
    ['GET', '/api/v2/docs'],
    ['GET', '/api/v2/oauth2'],
  ])('%s %s no está en el contrato v2 → 404 sin tocar ningún servicio', async (metodo, ruta) => {
    const token = await gateway.token({ scope: 'flights:read flights:book flights:admin' });
    const respuesta = await gateway.pedir({
      metodo,
      ruta,
      cabeceras: { authorization: `Bearer ${token}` },
    });
    expect(respuesta.status).toBe(404);
    expect(servicios.totalIniciadas()).toBe(0);
  });

  it('HEAD de una operación GET pública del contrato v2 pasa', async () => {
    const respuesta = await gateway.pedir({ metodo: 'HEAD', ruta: '/api/v2/vuelos/health' });
    expect(respuesta.status).toBe(200);
    expect(servicios.upstreams.core.recibidas[0]?.metodo).toBe('HEAD');
  });

  it('el prefijo se compara sin mayúsculas y se reenvía la ruta tal como se decidió', async () => {
    const respuesta = await gateway.pedir({ ruta: '/API/v2/Vuelos/health' });
    expect(respuesta.status).toBe(200);
    expect(servicios.upstreams.core.recibidas[0]?.url).toBe('/API/v2/Vuelos/health');
  });

  it('/flights/v1 sigue con el contrato v1: lo no declarado exige solo un token válido', async () => {
    const token = await gateway.token({ scope: 'flights:none' });
    const respuesta = await gateway.pedir({
      ruta: '/flights/v1/no-declarada',
      cabeceras: { authorization: `Bearer ${token}` },
    });
    expect(respuesta.status).toBe(200);
    expect(servicios.upstreams.core.recibidas).toHaveLength(1);
  });
});

describe('límite estricto del token', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = await new GatewayDePrueba(servicios, { RATE_LIMIT_STRICT_MAX: '3' }).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });

  it('/oauth2/token y /api/v2/oauth2/token comparten el contador (no se duplica el cupo)', async () => {
    const estados: number[] = [];
    for (const ruta of ['/oauth2/token', '/api/v2/oauth2/token', '/oauth2/token']) {
      estados.push((await gateway.pedir({ metodo: 'POST', ruta })).status);
    }
    const cuarta = await gateway.pedir({ metodo: 'POST', ruta: '/api/v2/oauth2/token' });
    expect(estados).toEqual([200, 200, 200]);
    expect(cuarta.status).toBe(429);
    expect(cuarta.cabeceras['retry-after']).toBeDefined();
    expect(servicios.upstreams.identity.recibidas).toHaveLength(3);
  });
});
