import { GatewayDePrueba, Servicios } from './utils/gateway';
import { erroresDeProblema } from './utils/esquemas';
import { Pedido } from './utils/http-crudo';

const CORR = 'corr-booking-combo-77';

/**
 * Los errores que responde el propio gateway: en /api/v2/** con el ProblemDetails v2 (instance,
 * correlation_id, timestamp y los códigos genéricos del contrato v2), validados con Ajv contra el
 * esquema del contrato; en /flights/v1 y el resto, el v1 de siempre (sin campos nuevos).
 */
describe('errores del borde en /api/v2', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = await new GatewayDePrueba(servicios, {
      RATE_LIMIT_STRICT_MAX: '1',
      TIMEOUT_NOTIFIER_MS: '500',
    }).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });
  beforeEach(() => servicios.reiniciar());

  async function esperarV2(
    pedido: Pedido,
    status: number,
    code: string,
    instancia: string,
  ): Promise<Record<string, unknown>> {
    const respuesta = await gateway.pedir({
      ...pedido,
      cabeceras: { ...pedido.cabeceras, 'x-correlation-id': CORR },
    });
    expect(respuesta.status).toBe(status);
    expect(String(respuesta.cabeceras['content-type'])).toMatch(/^application\/problem\+json/);
    expect(respuesta.cabeceras['x-correlation-id']).toBe(CORR);
    const cuerpo = respuesta.json();
    expect(erroresDeProblema('v2', cuerpo)).toEqual([]);
    expect(cuerpo).toEqual({
      type: `https://api.booking-hub.com/errors/${code.toLowerCase().replace(/_/g, '-')}`,
      title: expect.any(String),
      status,
      detail: expect.any(String),
      instance: instancia,
      code,
      correlation_id: CORR,
      timestamp: gateway.reloj.ahora().toISOString(),
    });
    return cuerpo;
  }

  it('401 UNAUTHORIZED sin token (instance sin la query)', async () => {
    await esperarV2(
      { ruta: '/api/v2/vuelos/bookings?page=2&email=a@b.example' },
      401,
      'UNAUTHORIZED',
      '/api/v2/vuelos/bookings',
    );
  });

  it('401 UNAUTHORIZED con un token inválido', async () => {
    await esperarV2(
      { ruta: '/api/v2/vuelos/bookings', cabeceras: { authorization: 'Bearer x.y.z' } },
      401,
      'UNAUTHORIZED',
      '/api/v2/vuelos/bookings',
    );
  });

  it('403 FORBIDDEN sin el scope', async () => {
    const token = await gateway.token({ scope: 'flights:read' });
    await esperarV2(
      {
        metodo: 'POST',
        ruta: '/api/v2/vuelos/bookings/abc/cancel',
        cabeceras: { authorization: `Bearer ${token}` },
      },
      403,
      'FORBIDDEN',
      '/api/v2/vuelos/bookings/abc/cancel',
    );
  });

  it.each([
    ['no declarada en el contrato v2', 'GET', '/api/v2/vuelos/no-existe'],
    ['método no declarado', 'DELETE', '/api/v2/vuelos/search'],
    ['fuera de /api/v2/vuelos', 'GET', '/api/v2/docs'],
    ['/api/v2 a secas', 'GET', '/api/v2'],
  ])('404 NOT_FOUND %s', async (_caso, metodo, ruta) => {
    await esperarV2({ metodo, ruta }, 404, 'NOT_FOUND', ruta);
  });

  it('400 VALIDATION_FAILED con una ruta ambigua', async () => {
    await esperarV2(
      { ruta: '/api/v2/vuelos/%2e%2e/admin' },
      400,
      'VALIDATION_FAILED',
      '/api/v2/vuelos/%2e%2e/admin',
    );
  });

  it('400 VALIDATION_FAILED con una URL que Fastify rechaza', async () => {
    await esperarV2({ ruta: '/api/v2/vuelos/%zz' }, 400, 'VALIDATION_FAILED', '/api/v2/vuelos/%zz');
  });

  it('413 VALIDATION_FAILED con un cuerpo sobre el tope', async () => {
    await esperarV2(
      {
        metodo: 'POST',
        ruta: '/api/v2/vuelos/search',
        cabeceras: { 'content-length': String(200 * 1024), 'content-type': 'application/json' },
      },
      413,
      'VALIDATION_FAILED',
      '/api/v2/vuelos/search',
    );
  });

  it('429 RATE_LIMIT_EXCEEDED en /api/v2/oauth2/token (límite estricto), con Retry-After', async () => {
    await gateway.pedir({ metodo: 'POST', ruta: '/api/v2/oauth2/token' });
    await esperarV2(
      { metodo: 'POST', ruta: '/api/v2/oauth2/token' },
      429,
      'RATE_LIMIT_EXCEEDED',
      '/api/v2/oauth2/token',
    );
  });

  it('503 PROVIDER_UNAVAILABLE sin JWKS (AUTH_UNAVAILABLE en v1), con Retry-After', async () => {
    servicios.identidad.encendida = false;
    const otro = await new GatewayDePrueba(servicios).iniciar();
    try {
      const token = await otro.token({ scope: 'flights:read' });
      const respuesta = await otro.pedir({
        ruta: '/api/v2/vuelos/bookings',
        cabeceras: { authorization: `Bearer ${token}`, 'x-correlation-id': CORR },
      });
      expect(respuesta.status).toBe(503);
      expect(respuesta.cabeceras['retry-after']).toBeDefined();
      const cuerpo = respuesta.json();
      expect(erroresDeProblema('v2', cuerpo)).toEqual([]);
      expect(cuerpo).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', correlation_id: CORR });
    } finally {
      await otro.detener();
    }
  });

  it('504 PROVIDER_UNAVAILABLE si el notifier no responde a tiempo', async () => {
    servicios.upstreams.notifier.manejador = () => undefined;
    const token = await gateway.token({ scope: 'flights:webhooks' });
    await esperarV2(
      { ruta: '/api/v2/vuelos/webhooks', cabeceras: { authorization: `Bearer ${token}` } },
      504,
      'PROVIDER_UNAVAILABLE',
      '/api/v2/vuelos/webhooks',
    );
  });

  it('un error del upstream en /api/v2 pasa tal cual: el borde no lo reescribe', async () => {
    const delCore = { type: 'about:blank', title: 'Gone', status: 410, code: 'HOLD_EXPIRED' };
    servicios.upstreams.core.manejador = (_p, r) => {
      r.writeHead(410, { 'content-type': 'application/problem+json' });
      r.end(JSON.stringify(delCore));
    };
    const respuesta = await gateway.pedir({ ruta: '/api/v2/vuelos/health' });
    expect(respuesta.status).toBe(410);
    expect(respuesta.json()).toEqual(delCore);
  });
});

describe('errores del borde en /api/v2 con el upstream caído', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = await new GatewayDePrueba(servicios, {
      UPSTREAM_CORE_URL: 'http://127.0.0.1:9',
    }).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });

  it('502 PROVIDER_UNAVAILABLE en /api/v2; 502 VALIDATION_FAILED v1 en /flights/v1', async () => {
    const v2 = await gateway.pedir({
      ruta: '/api/v2/vuelos/health',
      cabeceras: { 'x-correlation-id': CORR },
    });
    expect(v2.status).toBe(502);
    expect(erroresDeProblema('v2', v2.json())).toEqual([]);
    expect(v2.json()).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      correlation_id: CORR,
      instance: '/api/v2/vuelos/health',
    });

    const v1 = await gateway.pedir({ ruta: '/flights/v1/health' });
    expect(v1.status).toBe(502);
    expect(erroresDeProblema('v1', v1.json())).toEqual([]);
    expect(Object.keys(v1.json()).sort()).toEqual(['code', 'detail', 'status', 'title', 'type']);
  });
});

describe('errores del borde fuera de /api/v2 (sin cambios)', () => {
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

  it.each([
    ['401', 401, { ruta: '/flights/v1/bookings' }, 'VALIDATION_FAILED'],
    ['404', 404, { ruta: '/no-existe' }, 'VALIDATION_FAILED'],
    ['404 /api/v1', 404, { ruta: '/api/v1/vuelos/health' }, 'VALIDATION_FAILED'],
    ['404 /internal', 404, { ruta: '/internal/v1/events' }, 'VALIDATION_FAILED'],
    ['400', 400, { ruta: '/flights/v1/%2e%2e/x' }, 'VALIDATION_FAILED'],
  ] as const)('%s con el ProblemDetails v1', async (_caso, status, pedido, code) => {
    const respuesta = await gateway.pedir({
      ...pedido,
      cabeceras: { 'x-correlation-id': CORR },
    });
    expect(respuesta.status).toBe(status);
    const cuerpo = respuesta.json();
    expect(erroresDeProblema('v1', cuerpo)).toEqual([]);
    expect(Object.keys(cuerpo).sort()).toEqual(['code', 'detail', 'status', 'title', 'type']);
    expect(cuerpo.code).toBe(code);
    // El correlation id va en la cabecera: el esquema v1 no admite campos extra
    expect(respuesta.cabeceras['x-correlation-id']).toBe(CORR);
  });

  it('un cuerpo v2 no pasa el esquema v1 (la prueba de arriba distingue de verdad)', () => {
    expect(
      erroresDeProblema('v1', {
        type: 'x',
        title: 'x',
        status: 401,
        code: 'UNAUTHORIZED',
        correlation_id: 'c',
      }).length,
    ).toBeGreaterThan(0);
  });
});
