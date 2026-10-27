import { GatewayDePrueba, ORIGEN_PERMITIDO, Servicios } from './utils/gateway';

const GENERADO = /^corr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CORR = 'corr-vuelos-7f3a9c';

/**
 * X-Correlation-Id (contrato v2, §6; docs/OBSERVABILIDAD.md, sección 7): el válido se conserva SIN
 * cambios, el que falta o no sirve se genera (`corr-<uuid>`), va al upstream, vuelve en TODA
 * respuesta (también en los errores del borde) y aparece en cada línea de log.
 */
describe('X-Correlation-Id', () => {
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
  beforeEach(() => {
    servicios.reiniciar();
    gateway.logs.length = 0;
  });

  /** La línea de acceso de la última petición. */
  function lineaDeAcceso(): Record<string, unknown> {
    const accesos = gateway.registros().filter((r) => r.msg === 'acceso');
    expect(accesos.length).toBeGreaterThan(0);
    return accesos[accesos.length - 1]!;
  }

  it.each([
    CORR,
    '7f3a9c2e-1b4d-4e8a-9c3f-2a1b4d8e9c3f',
    '01JB2Z3Y4X5W6V7U8T9S0R1Q2P',
    'Booking:combo.42_A-b',
    'a',
    'x'.repeat(100),
  ])('el válido %s se conserva sin cambios, llega al upstream y vuelve', async (id) => {
    const respuesta = await gateway.pedir({
      metodo: 'POST',
      ruta: '/api/v2/vuelos/search',
      cabeceras: { 'x-correlation-id': id, 'content-type': 'application/json' },
      cuerpo: '{}',
    });
    expect(respuesta.status).toBe(200);
    expect(respuesta.cabeceras['x-correlation-id']).toBe(id);
    expect(servicios.upstreams.core.recibidas[0]?.cabeceras['x-correlation-id']).toBe(id);
  });

  it('sin cabecera, el gateway genera uno y es el mismo hacia el upstream y en la respuesta', async () => {
    const respuesta = await gateway.pedir({ ruta: '/api/v2/vuelos/health' });
    const generado = String(respuesta.cabeceras['x-correlation-id']);
    expect(generado).toMatch(GENERADO);
    expect(servicios.upstreams.core.recibidas[0]?.cabeceras['x-correlation-id']).toBe(generado);
    const otra = await gateway.pedir({ ruta: '/api/v2/vuelos/health' });
    expect(otra.cabeceras['x-correlation-id']).not.toBe(generado);
  });

  it.each([
    ['con espacio', 'corr 123'],
    ['de 101 caracteres', 'x'.repeat(101)],
    ['con comillas', 'corr"123'],
    ['con barra', 'corr/123'],
    ['con coma', 'corr,123'],
    ['con un no ASCII', 'corrñ123'],
    ['vacío', ''],
  ])('uno %s se descarta y se genera otro (la petición no se rechaza)', async (_caso, id) => {
    const respuesta = await gateway.pedir({
      ruta: '/api/v2/vuelos/health',
      cabeceras: { 'x-correlation-id': Buffer.from(id, 'utf8').toString('latin1') },
    });
    expect(respuesta.status).toBe(200);
    const generado = String(respuesta.cabeceras['x-correlation-id']);
    expect(generado).toMatch(GENERADO);
    const recibidas = servicios.upstreams.core.recibidas[0]?.crudas ?? [];
    const enviadas = recibidas.filter((_v, i) => i % 2 === 0 && /^x-correlation-id$/i.test(_v));
    expect(enviadas).toHaveLength(1);
    expect(servicios.upstreams.core.recibidas[0]?.cabeceras['x-correlation-id']).toBe(generado);
  });

  it('repetido (dos cabeceras) se descarta: no se elige uno al azar', async () => {
    const respuesta = await gateway.pedir({
      ruta: '/api/v2/vuelos/health',
      cabeceras: { 'x-correlation-id': ['corr-a', 'corr-b'] },
    });
    expect(String(respuesta.cabeceras['x-correlation-id'])).toMatch(GENERADO);
  });

  it('el que manda el upstream no reemplaza al del gateway en la respuesta', async () => {
    servicios.upstreams.core.manejador = (_p, r) => {
      r.writeHead(200, { 'x-correlation-id': 'otro-del-upstream' });
      r.end('{}');
    };
    const respuesta = await gateway.pedir({
      ruta: '/api/v2/vuelos/health',
      cabeceras: { 'x-correlation-id': CORR },
    });
    expect(respuesta.cabeceras['x-correlation-id']).toBe(CORR);
    expect(respuesta.crudas.filter((n) => /^x-correlation-id$/i.test(n))).toHaveLength(1);
  });

  it('también en v1 y hacia identity, el BFF y el notifier', async () => {
    const token = await gateway.token({ scope: 'flights:webhooks' });
    await gateway.pedir({ ruta: '/flights/v1/health', cabeceras: { 'x-correlation-id': CORR } });
    await gateway.pedir({
      ruta: '/.well-known/jwks.json',
      cabeceras: { 'x-correlation-id': CORR },
    });
    await gateway.pedir({
      metodo: 'POST',
      ruta: '/graphql',
      cabeceras: { 'x-correlation-id': CORR },
    });
    await gateway.pedir({
      ruta: '/flights/v1/webhooks',
      cabeceras: { 'x-correlation-id': CORR, authorization: `Bearer ${token}` },
    });
    for (const upstream of ['core', 'identity', 'bff', 'notifier'] as const) {
      expect(servicios.upstreams[upstream].recibidas[0]?.cabeceras['x-correlation-id']).toBe(CORR);
    }
  });

  describe('en los errores del borde', () => {
    it.each([
      ['401 sin token', 401, { ruta: '/api/v2/vuelos/bookings' }],
      ['404 desconocida', 404, { ruta: '/no-existe' }],
      ['404 bloqueada', 404, { ruta: '/internal/v1/events' }],
      ['404 no declarada en v2', 404, { ruta: '/api/v2/vuelos/no-existe' }],
      ['400 ambigua', 400, { ruta: '/api/v2/vuelos/%2e%2e/x' }],
      ['400 de Fastify (URL mal formada)', 400, { ruta: '/api/v2/vuelos/%zz' }],
      [
        '413 cuerpo grande',
        413,
        {
          metodo: 'POST',
          ruta: '/api/v2/vuelos/search',
          cabeceras: { 'content-length': String(200 * 1024) },
        },
      ],
    ] as const)('%s', async (_caso, status, pedido) => {
      const respuesta = await gateway.pedir({
        ...pedido,
        cabeceras: { ...('cabeceras' in pedido ? pedido.cabeceras : {}), 'x-correlation-id': CORR },
      });
      expect(respuesta.status).toBe(status);
      expect(respuesta.cabeceras['x-correlation-id']).toBe(CORR);
      expect(servicios.totalIniciadas()).toBe(0);
      expect(lineaDeAcceso().correlation_id).toBe(CORR);
    });

    it('403 sin el scope', async () => {
      const token = await gateway.token({ scope: 'flights:read' });
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/api/v2/vuelos/offers/hold',
        cabeceras: { authorization: `Bearer ${token}`, 'x-correlation-id': CORR },
      });
      expect(respuesta.status).toBe(403);
      expect(respuesta.cabeceras['x-correlation-id']).toBe(CORR);
    });

    it('un error del upstream (409) pasa con el correlation id del gateway', async () => {
      servicios.upstreams.core.manejador = (_p, r) => {
        r.writeHead(409, { 'content-type': 'application/problem+json' });
        r.end('{}');
      };
      const respuesta = await gateway.pedir({
        ruta: '/api/v2/vuelos/health',
        cabeceras: { 'x-correlation-id': CORR },
      });
      expect(respuesta.status).toBe(409);
      expect(respuesta.cabeceras['x-correlation-id']).toBe(CORR);
    });
  });

  it('la línea de acceso lleva los campos de §6.4 y toda línea de la petición su correlationId', async () => {
    const token = await gateway.token({ scope: 'flights:book', clientId: 'booking-prototipo' });
    const respuesta = await gateway.pedir({
      metodo: 'POST',
      ruta: '/api/v2/vuelos/bookings',
      cabeceras: {
        authorization: `Bearer ${token}`,
        'x-correlation-id': CORR,
        'content-type': 'application/json',
      },
      cuerpo: '{}',
    });
    expect(respuesta.status).toBe(200);
    const acceso = lineaDeAcceso();
    expect(acceso).toMatchObject({
      correlation_id: CORR,
      request_id: respuesta.cabeceras['x-request-id'],
      service: 'quinde-gateway',
      operation: 'createBooking',
      status: 200,
      correlationId: CORR,
    });
    expect(typeof acceso.latency_ms).toBe('number');
    expect(new Date(String(acceso.timestamp)).toISOString()).toBe(acceso.timestamp);
    // Cada línea escrita durante la petición (también las del verificador) lo lleva
    const dePeticion = gateway.registros().filter((r) => r.requestId === acceso.request_id);
    expect(dePeticion.length).toBeGreaterThan(0);
    for (const linea of dePeticion) expect(linea.correlationId).toBe(CORR);
  });

  it('una ruta fuera de los contratos deja operation en null', async () => {
    await gateway.pedir({ ruta: '/health' });
    expect(lineaDeAcceso()).toMatchObject({ operation: null, status: 200 });
  });

  it('CORS: se permite como cabecera de entrada y se expone, junto a Idempotent-Replayed y Location', async () => {
    const preflight = await gateway.pedir({
      metodo: 'OPTIONS',
      ruta: '/api/v2/vuelos/bookings',
      cabeceras: {
        origin: ORIGEN_PERMITIDO,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-correlation-id',
      },
    });
    expect(String(preflight.cabeceras['access-control-allow-headers'])).toContain(
      'x-correlation-id',
    );
    const respuesta = await gateway.pedir({
      ruta: '/api/v2/vuelos/health',
      cabeceras: { origin: ORIGEN_PERMITIDO },
    });
    const expuestas = String(respuesta.cabeceras['access-control-expose-headers']).split(', ');
    expect(expuestas).toEqual(
      expect.arrayContaining(['x-correlation-id', 'idempotent-replayed', 'location']),
    );
  });
});

describe('X-Correlation-Id en 429 y 502', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = await new GatewayDePrueba(servicios, {
      RATE_LIMIT_MAX: '2',
      UPSTREAM_CORE_URL: 'http://127.0.0.1:9',
    }).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });

  it('502 con el upstream caído y 429 al pasar el límite, los dos con el mismo id', async () => {
    const caido = await gateway.pedir({
      ruta: '/api/v2/vuelos/health',
      cabeceras: { 'x-correlation-id': CORR },
    });
    expect(caido.status).toBe(502);
    expect(caido.cabeceras['x-correlation-id']).toBe(CORR);
    await gateway.pedir({ ruta: '/api/v2/vuelos/health' });
    const limitada = await gateway.pedir({
      ruta: '/api/v2/vuelos/health',
      cabeceras: { 'x-correlation-id': CORR },
    });
    expect(limitada.status).toBe(429);
    expect(limitada.cabeceras['x-correlation-id']).toBe(CORR);
  });
});
