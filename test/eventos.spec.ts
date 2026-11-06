import { randomUUID } from 'node:crypto';
import { conLatido } from '../src/eventos/conector-amqplib';
import { PuenteAmqp } from '../src/eventos/puente-amqp';
import { BrokerFalso, esperarHasta, URL_BROKER } from './utils/amqp-falso';
import { GatewayDePrueba, Servicios } from './utils/gateway';

const CORR = 'corr-evento-7f3a9c';
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

/** Un sobre como el que publica el core: el orden de las claves y los espacios importan. */
function sobre(cambios: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: randomUUID(),
    eventType: 'booking.confirmed',
    schemaVersion: '1.0',
    occurredAt: '2026-11-06T10:00:00.000Z',
    ownerId: randomUUID(),
    data: { bookingId: randomUUID(), pnr: 'ABC123', nota: 'Ñandú · 日本語 · é' },
    ...cambios,
  });
}

const JSON_UTF8 = { 'content-type': 'application/json' };

/**
 * El puente de eventos (fase 4a): HTTP → AMQP sin lógica de negocio. Se prueba contra un broker
 * falso (sin red) y el identity falso de las demás pruebas, por el listener interno.
 */
describe('listener de eventos', () => {
  const servicios = new Servicios();
  const broker = new BrokerFalso();
  const avisos: string[] = [];
  let gateway: GatewayDePrueba;
  let tokenCore: string;

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = new GatewayDePrueba(servicios, {
      RABBITMQ_URL: URL_BROKER,
      EVENTOS_PUERTO: '9470',
    });
    gateway.puenteEventos = new PuenteAmqp({
      url: URL_BROKER,
      exchange: 'vuelos.eventos',
      conector: broker.conector,
      registro: {
        info: (m) => avisos.push(m),
        warn: (m) => avisos.push(m),
        debug: (m) => avisos.push(m),
      },
      plazoConfirmacionMs: 300,
      esperaInicialMs: 10,
      esperaMaximaMs: 40,
    });
    await gateway.iniciar();
    await esperarHasta(() => gateway.puenteEventos!.conectado);
    tokenCore = await gateway.token({ scope: 'events:publish', clientId: 'core-vuelos' });
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });
  beforeEach(() => {
    servicios.reiniciar();
    broker.modo = 'confirmar';
    broker.publicaciones.length = 0;
    gateway.logs.length = 0;
  });

  const publicar = (
    cuerpo: string | Buffer,
    cabeceras: Record<string, string> = {},
    token: string | null = tokenCore,
  ) =>
    gateway.pedirEventos({
      metodo: 'POST',
      ruta: '/internal/v1/events',
      cabeceras: {
        ...JSON_UTF8,
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...cabeceras,
      },
      cuerpo,
    });

  describe('publicación', () => {
    it('202 solo con la confirmación, y declara el exchange topic durable al conectar', async () => {
      const cuerpo = sobre();
      const respuesta = await publicar(cuerpo, { 'x-correlation-id': CORR });
      expect(respuesta.status).toBe(202);
      expect(respuesta.json()).toEqual({ status: 'ACCEPTED' });
      expect(broker.publicaciones).toHaveLength(1);
      expect(broker.exchanges).toContain('vuelos.eventos');
      expect(broker.urls[0]).toBe(URL_BROKER);
    });

    it('el cuerpo publicado es idéntico byte a byte (espacios, orden, unicode y salto final)', async () => {
      const cuerpos = [
        sobre(),
        `  ${sobre()}\n`,
        '{"eventType" :"booking.confirmed",\n  "eventId":"e-1","data":{"b":1,"a":[1,2,3],"x":1.10,"y":1e3,"z":"\\u00e9\\n"}}',
        // Claves repetidas y números que JSON.stringify cambiaría: un re-serializado los alteraría
        '{"eventId":"e-2","eventType":"flight.status_changed","eventId":"e-3","n":12345678901234567890}',
      ];
      for (const cuerpo of cuerpos) {
        broker.publicaciones.length = 0;
        const respuesta = await publicar(Buffer.from(cuerpo, 'utf8'));
        expect(respuesta.status).toBe(202);
        expect(Buffer.compare(broker.publicaciones[0]!.contenido, Buffer.from(cuerpo))).toBe(0);
      }
    });

    it('exchange, routing key, mensaje persistente, messageId, type y contentType', async () => {
      const eventId = randomUUID();
      const respuesta = await publicar(sobre({ eventId, eventType: 'booking.ticket_issued' }), {
        'x-correlation-id': CORR,
      });
      expect(respuesta.status).toBe(202);
      const [publicacion] = broker.publicaciones;
      expect(publicacion).toMatchObject({
        exchange: 'vuelos.eventos',
        routingKey: 'booking.ticket_issued',
        opciones: {
          persistent: true,
          messageId: eventId,
          type: 'booking.ticket_issued',
          contentType: 'application/json',
        },
      });
    });

    it('X-Correlation-Id válido sin cambios, como propiedad AMQP y como cabecera', async () => {
      const respuesta = await publicar(sobre(), { 'x-correlation-id': CORR });
      expect(respuesta.cabeceras['x-correlation-id']).toBe(CORR);
      const { opciones } = broker.publicaciones[0]!;
      expect(opciones.correlationId).toBe(CORR);
      expect(opciones.headers['x-correlation-id']).toBe(CORR);
    });

    it('sin X-Correlation-Id (o inválido) el gateway genera uno y lo publica', async () => {
      const sinId: Record<string, string>[] = [{}, { 'x-correlation-id': 'con espacios no' }];
      for (const cabeceras of sinId) {
        broker.publicaciones.length = 0;
        const respuesta = await publicar(sobre(), cabeceras);
        const generado = String(respuesta.cabeceras['x-correlation-id']);
        expect(generado).toMatch(/^corr-[0-9a-f-]{36}$/);
        expect(broker.publicaciones[0]!.opciones.correlationId).toBe(generado);
      }
    });

    it('lleva un traceparent que continúa el del core y X-Trace-Id es de la misma traza', async () => {
      const traza = '4bf92f3577b34da6a3ce929d0e0e4736';
      const respuesta = await publicar(sobre(), {
        traceparent: `00-${traza}-00f067aa0ba902b7-01`,
      });
      const traceparent = broker.publicaciones[0]!.opciones.headers.traceparent!;
      expect(traceparent).toMatch(TRACEPARENT);
      expect(traceparent.split('-')[1]).toBe(traza);
      expect(respuesta.cabeceras['x-trace-id']).toBe(traza);
      // Sin traceparent propio, una traza nueva
      broker.publicaciones.length = 0;
      const otra = await publicar(sobre());
      const nuevo = broker.publicaciones[0]!.opciones.headers.traceparent!;
      expect(nuevo).toMatch(TRACEPARENT);
      expect(nuevo.split('-')[1]).toBe(otra.cabeceras['x-trace-id']);
      expect(nuevo.split('-')[1]).not.toBe(traza);
    });

    it('acepta application/json con charset utf-8', async () => {
      const respuesta = await publicar(sobre(), {
        'content-type': 'application/json; charset=utf-8',
      });
      expect(respuesta.status).toBe(202);
    });

    it('el mismo eventId dos veces se publica dos veces: el notifier es el idempotente', async () => {
      const cuerpo = sobre();
      expect((await publicar(cuerpo)).status).toBe(202);
      expect((await publicar(cuerpo)).status).toBe(202);
      expect(broker.publicaciones).toHaveLength(2);
    });
  });

  describe('fallos del broker: 503 con Retry-After', () => {
    it('sin confirmación en el plazo', async () => {
      broker.modo = 'silencio';
      const respuesta = await publicar(sobre());
      expect(respuesta.status).toBe(503);
      expect(respuesta.cabeceras['retry-after']).toBe('5');
      expect(respuesta.cabeceras['x-correlation-id']).toBeDefined();
      expect(broker.publicaciones).toHaveLength(1);
    });

    it('el broker rechaza (nack)', async () => {
      broker.modo = 'rechazar';
      const respuesta = await publicar(sobre());
      expect(respuesta.status).toBe(503);
      expect(respuesta.cabeceras['retry-after']).toBe('5');
    });

    it('ninguna cola recibe el mensaje (basic.return): no se da por publicado', async () => {
      broker.modo = 'sin-cola';
      const respuesta = await publicar(sobre());
      expect(respuesta.status).toBe(503);
      expect(respuesta.cabeceras['retry-after']).toBe('5');
      // Cuando hay a quién entregárselo, el reintento del core sí se publica
      broker.modo = 'confirmar';
      expect((await publicar(sobre())).status).toBe(202);
    });

    it('el plazo de confirmación es de 5 s', async () => {
      const { PLAZO_CONFIRMACION_MS } = await import('../src/eventos/puente-amqp');
      expect(PLAZO_CONFIRMACION_MS).toBe(5_000);
    });
  });

  describe('lo mínimo para traducir', () => {
    const invalidos: [string, string | Buffer][] = [
      ['cuerpo vacío', ''],
      ['JSON mal formado', '{"eventId":'],
      ['texto que no es JSON', 'hola'],
      ['un arreglo', '[{"eventId":"a","eventType":"b"}]'],
      ['null', 'null'],
      ['un número', '42'],
      ['sin eventId', '{"eventType":"booking.confirmed"}'],
      ['sin eventType', '{"eventId":"e-1"}'],
      ['eventId numérico', '{"eventId":1,"eventType":"booking.confirmed"}'],
      ['eventType numérico', '{"eventId":"e-1","eventType":7}'],
      ['eventId vacío', '{"eventId":"","eventType":"booking.confirmed"}'],
      ['eventId de más de 255', `{"eventId":"${'a'.repeat(256)}","eventType":"x"}`],
      ['eventType con espacios', '{"eventId":"e-1","eventType":"booking confirmed"}'],
      ['eventType con comodín', '{"eventId":"e-1","eventType":"booking.*"}'],
      ['eventType de más de 255', `{"eventId":"e-1","eventType":"${'a'.repeat(256)}"}`],
      ['eventId con salto de línea', '{"eventId":"a\\nb","eventType":"x"}'],
      ['UTF-8 inválido', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])],
      ['con BOM', '﻿{"eventId":"e-1","eventType":"x"}'],
    ];

    it.each(invalidos)('400: %s', async (_caso, cuerpo) => {
      const respuesta = await publicar(cuerpo);
      expect(respuesta.status).toBe(400);
      expect(respuesta.json()).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(respuesta.cabeceras['content-type']).toMatch(/^application\/problem\+json/);
      expect(broker.publicaciones).toHaveLength(0);
    });

    it.each([
      ['sin Content-Type', {}],
      ['text/plain', { 'content-type': 'text/plain' }],
      [
        'application/x-www-form-urlencoded',
        { 'content-type': 'application/x-www-form-urlencoded' },
      ],
      ['application/json con otro charset', { 'content-type': 'application/json; charset=latin1' }],
      ['application/jsonp', { 'content-type': 'application/jsonp' }],
    ])('415: %s', async (_caso, cabeceras) => {
      const respuesta = await gateway.pedirEventos({
        metodo: 'POST',
        ruta: '/internal/v1/events',
        cabeceras: { authorization: `Bearer ${tokenCore}`, ...cabeceras },
        cuerpo: sobre(),
      });
      expect(respuesta.status).toBe(415);
      expect(broker.publicaciones).toHaveLength(0);
    });

    it('413: Content-Length mayor de 100 kB, sin leer el cuerpo', async () => {
      const respuesta = await publicar('{}', { 'content-length': String(200 * 1024) });
      expect(respuesta.status).toBe(413);
      expect(respuesta.cabeceras.connection).toBe('close');
      expect(broker.publicaciones).toHaveLength(0);
    });

    it('413: cuerpo de más de 100 kB mandado en trozos', async () => {
      const grande = sobre({ data: { relleno: 'a'.repeat(110 * 1024) } });
      const respuesta = await gateway.pedirEventos({
        metodo: 'POST',
        ruta: '/internal/v1/events',
        cabeceras: { ...JSON_UTF8, authorization: `Bearer ${tokenCore}` },
        cuerpo: grande,
        enTrozos: true,
      });
      expect(respuesta.status).toBe(413);
      expect(broker.publicaciones).toHaveLength(0);
    });

    it('justo en el tope de 100 kB se publica; un byte más es 413', async () => {
      const armar = (relleno: number) =>
        `{"eventId":"e-justo","eventType":"x","data":"${'a'.repeat(relleno)}"}`;
      const vacio = Buffer.byteLength(armar(0));
      const justo = armar(100 * 1024 - vacio);
      expect(Buffer.byteLength(justo)).toBe(100 * 1024);
      const aceptado = await publicar(justo);
      expect(aceptado.status).toBe(202);
      expect(Buffer.byteLength(broker.publicaciones[0]!.contenido)).toBe(100 * 1024);

      broker.publicaciones.length = 0;
      const pasado = await publicar(armar(100 * 1024 - vacio + 1));
      expect(pasado.status).toBe(413);
      expect(broker.publicaciones).toHaveLength(0);
    });
  });

  describe('seguridad: cliente OAuth con events:publish', () => {
    it('sin token → 401 con WWW-Authenticate, y nada se publica', async () => {
      const respuesta = await publicar(sobre(), {}, null);
      expect(respuesta.status).toBe(401);
      expect(String(respuesta.cabeceras['www-authenticate'])).toMatch(/^Bearer realm=/);
      expect(broker.publicaciones).toHaveLength(0);
    });

    it('la seguridad va antes que el formato: sin token, un cuerpo inválido también es 401', async () => {
      const respuesta = await publicar('no es json', { 'content-type': 'text/plain' }, null);
      expect(respuesta.status).toBe(401);
    });

    it.each([
      ['mal firmado', 'eyJhbGciOiJSUzI1NiJ9.e30.firma'],
      ['basura', 'x.y.z'],
    ])('token %s → 401', async (_caso, token) => {
      const respuesta = await publicar(sobre(), {}, token);
      expect(respuesta.status).toBe(401);
      expect(broker.publicaciones).toHaveLength(0);
    });

    it('token vencido, de otro emisor o de otra audiencia → 401', async () => {
      for (const opciones of [
        { expiraEn: -3600 },
        { iss: 'https://otro.example' },
        { aud: 'otra-api' },
      ]) {
        const token = await gateway.token({
          scope: 'events:publish',
          clientId: 'core-vuelos',
          ...opciones,
        });
        expect((await publicar(sobre(), {}, token)).status).toBe(401);
      }
      expect(broker.publicaciones).toHaveLength(0);
    });

    it('cliente OAuth sin events:publish → 403 insufficient_scope', async () => {
      const token = await gateway.token({ scope: 'flights:read', clientId: 'core-vuelos' });
      const respuesta = await publicar(sobre(), {}, token);
      expect(respuesta.status).toBe(403);
      expect(String(respuesta.cabeceras['www-authenticate'])).toContain('insufficient_scope');
      expect(broker.publicaciones).toHaveLength(0);
    });

    it('token de una persona (sin client_id) → 403 aunque traiga events:publish', async () => {
      const token = await gateway.token({ scope: 'events:publish' });
      const respuesta = await publicar(sobre(), {}, token);
      expect(respuesta.status).toBe(403);
      expect(broker.publicaciones).toHaveLength(0);
    });

    it('sin claves con que verificar → 503 AUTH_UNAVAILABLE, nunca 401 ni dejar pasar', async () => {
      servicios.identidad.encendida = false;
      const sinJwks = new GatewayDePrueba(servicios, {
        RABBITMQ_URL: URL_BROKER,
        EVENTOS_PUERTO: '9470',
      });
      sinJwks.puenteEventos = new PuenteAmqp({
        url: URL_BROKER,
        exchange: 'vuelos.eventos',
        conector: broker.conector,
        registro: { info: () => undefined, warn: () => undefined, debug: () => undefined },
      });
      await sinJwks.iniciar();
      try {
        const token = await sinJwks.token({ scope: 'events:publish', clientId: 'core-vuelos' });
        const respuesta = await sinJwks.pedirEventos({
          metodo: 'POST',
          ruta: '/internal/v1/events',
          cabeceras: { ...JSON_UTF8, authorization: `Bearer ${token}` },
          cuerpo: sobre(),
        });
        expect(respuesta.status).toBe(503);
        expect(respuesta.json()).toMatchObject({ code: 'AUTH_UNAVAILABLE' });
        expect(respuesta.cabeceras['retry-after']).toBeDefined();
      } finally {
        await sinJwks.detener();
      }
      expect(broker.publicaciones).toHaveLength(0);
    });

    it('los errores también devuelven X-Request-Id, X-Trace-Id y X-Correlation-Id', async () => {
      const respuesta = await publicar('{', { 'x-correlation-id': CORR });
      expect(respuesta.status).toBe(400);
      expect(respuesta.cabeceras['x-correlation-id']).toBe(CORR);
      expect(respuesta.cabeceras['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(respuesta.cabeceras['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('la ruta', () => {
    it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('%s → 405 con Allow: POST', async (metodo) => {
      const respuesta = await gateway.pedirEventos({
        metodo,
        ruta: '/internal/v1/events',
        cabeceras: { authorization: `Bearer ${tokenCore}` },
      });
      expect(respuesta.status).toBe(405);
      expect(respuesta.cabeceras.allow).toBe('POST');
    });

    it.each([
      '/',
      '/internal/v1',
      '/internal/v1/events/x',
      '/flights/v1/search',
      '/metrics',
      '/health',
    ])('cualquier otra ruta (%s) → 404 sin publicar', async (ruta) => {
      const respuesta = await gateway.pedirEventos({
        metodo: 'POST',
        ruta,
        cabeceras: { ...JSON_UTF8, authorization: `Bearer ${tokenCore}` },
        cuerpo: sobre(),
      });
      expect(respuesta.status).toBe(404);
      expect(broker.publicaciones).toHaveLength(0);
    });

    it.each(['/internal/v1/%2e%2e/v1/events', '/internal//v1/events', '/internal/v1/%65vents%2f'])(
      'una ruta ambigua (%s) → 400',
      async (ruta) => {
        const respuesta = await gateway.pedirEventos({ metodo: 'POST', ruta });
        expect(respuesta.status).toBe(400);
      },
    );

    it('la barra final y la query no cambian la ruta', async () => {
      const respuesta = await gateway.pedirEventos({
        metodo: 'POST',
        ruta: '/internal/v1/events/?x=1',
        cabeceras: { ...JSON_UTF8, authorization: `Bearer ${tokenCore}` },
        cuerpo: sobre(),
      });
      expect(respuesta.status).toBe(202);
    });

    it('en el puerto público /internal/** sigue siendo 404 y no llega al broker', async () => {
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/internal/v1/events',
        cabeceras: { ...JSON_UTF8, authorization: `Bearer ${tokenCore}` },
        cuerpo: sobre(),
      });
      expect(respuesta.status).toBe(404);
      expect(broker.publicaciones).toHaveLength(0);
      expect(servicios.totalIniciadas()).toBe(0);
    });
  });

  describe('observabilidad', () => {
    it('cuenta publicados y rechazados por motivo (lista cerrada, nada del evento)', async () => {
      const antes = (await gateway.valorMetrica('gateway_events_published_total')) ?? 0;
      await publicar(sobre());
      await publicar('no es json');
      await publicar(sobre(), {}, null);
      broker.modo = 'silencio';
      await publicar(sobre());
      const texto = await gateway.textoMetricas();
      expect(await gateway.valorMetrica('gateway_events_published_total')).toBe(antes + 1);
      for (const motivo of ['invalid_json', 'missing_token', 'broker_timeout']) {
        expect(
          await gateway.valorMetrica(`gateway_events_rejected_total{reason="${motivo}"}`),
        ).toBeGreaterThanOrEqual(1);
      }
      expect(await gateway.valorMetrica('gateway_events_broker_up')).toBe(1);
      expect(texto).toMatch(/http_server_requests_total\{[^}]*route="\/internal\/v1\/events"/);
    });

    it('la línea de acceso lleva los campos de §6.4 y ni el evento ni el token', async () => {
      const cuerpo = sobre();
      const { eventId, ownerId } = JSON.parse(cuerpo) as { eventId: string; ownerId: string };
      await publicar(cuerpo, { 'x-correlation-id': CORR });
      const acceso = gateway
        .registros()
        .filter((r) => r.msg === 'acceso')
        .pop()!;
      expect(acceso).toMatchObject({
        service: 'quinde-gateway',
        correlation_id: CORR,
        operation: 'publishEvent',
        status: 202,
        upstream: 'rabbitmq',
        ruta: '/internal/v1/events',
      });
      const todo = gateway.logs.join('\n');
      for (const secreto of [tokenCore, eventId, ownerId, 'ABC123', 'Ñandú', 'clave-secreta-123']) {
        expect(todo).not.toContain(secreto);
      }
    });
  });
});

/**
 * El broker no es parte de la salud del gateway, y el gateway sobrevive a sus caídas: arranca sin
 * él, sigue enrutando, responde 503 mientras no esté y se recupera solo.
 */
describe('broker caído o intermitente', () => {
  const servicios = new Servicios();
  const broker = new BrokerFalso();
  const avisos: string[] = [];
  let gateway: GatewayDePrueba;
  let token: string;

  beforeAll(async () => {
    await servicios.iniciar();
    broker.disponible = false;
    gateway = new GatewayDePrueba(servicios, { RABBITMQ_URL: URL_BROKER, EVENTOS_PUERTO: '9470' });
    gateway.puenteEventos = new PuenteAmqp({
      url: URL_BROKER,
      exchange: 'vuelos.eventos',
      conector: broker.conector,
      registro: {
        info: (m) => avisos.push(m),
        warn: (m) => avisos.push(m),
        debug: (m) => avisos.push(m),
      },
      plazoConfirmacionMs: 300,
      esperaInicialMs: 10,
      esperaMaximaMs: 40,
    });
    await gateway.iniciar();
    token = await gateway.token({ scope: 'events:publish', clientId: 'core-vuelos' });
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });

  const publicar = () =>
    gateway.pedirEventos({
      metodo: 'POST',
      ruta: '/internal/v1/events',
      cabeceras: { ...JSON_UTF8, authorization: `Bearer ${token}` },
      cuerpo: sobre(),
    });

  it('arranca sin broker: 503 con Retry-After, y /health y el enrutado siguen bien', async () => {
    const respuesta = await publicar();
    expect(respuesta.status).toBe(503);
    expect(respuesta.cabeceras['retry-after']).toBe('5');

    expect((await gateway.pedir({ ruta: '/health' })).status).toBe(200);
    expect((await gateway.pedir({ ruta: '/health/ready' })).status).toBe(200);
    expect((await gateway.pedir({ ruta: '/flights/v1/health' })).status).toBe(200);
    expect(await gateway.valorMetrica('gateway_events_broker_up')).toBe(0);
  });

  it('reintenta con backoff, sin la URL ni su clave en los avisos', async () => {
    await esperarHasta(() => broker.intentos >= 3);
    expect(avisos.some((a) => a.includes('ECONNREFUSED'))).toBe(true);
    const todo = avisos.join('\n') + gateway.logs.join('\n');
    expect(todo).not.toContain('clave-secreta-123');
    expect(todo).not.toContain(URL_BROKER);
  });

  it('cuando el broker vuelve, se conecta solo y publica; si se cae, se reconecta', async () => {
    broker.disponible = true;
    await esperarHasta(() => gateway.puenteEventos!.conectado);
    expect(await gateway.valorMetrica('gateway_events_broker_up')).toBe(1);
    expect((await publicar()).status).toBe(202);

    const antes = broker.intentos;
    broker.disponible = false;
    broker.tirarConexion();
    await esperarHasta(() => !gateway.puenteEventos!.conectado);
    expect((await publicar()).status).toBe(503);
    expect(await gateway.valorMetrica('gateway_events_broker_up')).toBe(0);

    broker.disponible = true;
    await esperarHasta(() => gateway.puenteEventos!.conectado);
    expect(broker.intentos).toBeGreaterThan(antes);
    expect((await publicar()).status).toBe(202);
  });

  it('el backoff duplica la espera hasta el tope y se reinicia al conectar', async () => {
    broker.disponible = false;
    broker.tirarConexion();
    await esperarHasta(() => !gateway.puenteEventos!.conectado);
    const intentos = avisos.filter((a) => a.includes('se reintenta en'));
    const esperas = intentos.slice(-6).map((a) => Number(/en (\d+) ms/.exec(a)![1]));
    expect(Math.max(...esperas)).toBeLessThanOrEqual(40);
    broker.disponible = true;
    await esperarHasta(() => gateway.puenteEventos!.conectado);
  });
});

describe('sin RABBITMQ_URL', () => {
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

  it('el listener de eventos no existe y el gateway funciona igual', async () => {
    expect(gateway.app.eventos).toBeNull();
    expect(gateway.baseEventos).toBeUndefined();
    expect((await gateway.pedir({ ruta: '/health' })).status).toBe(200);
    expect(await gateway.valorMetrica('gateway_events_broker_up')).toBeUndefined();
  });
});

describe('intento de conexión colgado', () => {
  const registro = { info: () => undefined, warn: () => undefined, debug: () => undefined };
  const opciones = { url: URL_BROKER, exchange: 'vuelos.eventos', registro };

  it('un conector que nunca resuelve vence el plazo y se reintenta hasta conectar', async () => {
    const broker = new BrokerFalso();
    let llamadas = 0;
    const puente = new PuenteAmqp({
      ...opciones,
      conector: (url) => {
        llamadas++;
        return llamadas <= 2 ? new Promise(() => undefined) : broker.conector(url);
      },
      plazoIntentoMs: 30,
      esperaInicialMs: 5,
      esperaMaximaMs: 10,
    });
    puente.iniciar();
    await esperarHasta(() => puente.conectado);
    expect(llamadas).toBe(3);
    await puente.cerrar();
  });

  it('si la conexión llega después del plazo, se cierra y no queda doble conexión', async () => {
    const broker = new BrokerFalso();
    let cerradas = 0;
    let llamadas = 0;
    const puente = new PuenteAmqp({
      ...opciones,
      conector: async (url) => {
        llamadas++;
        if (llamadas > 1) return broker.conector(url);
        await new Promise((r) => setTimeout(r, 80));
        const tarde = await broker.conector(url);
        return { ...tarde, cerrar: async () => void cerradas++ };
      },
      plazoIntentoMs: 30,
      esperaInicialMs: 5,
      esperaMaximaMs: 10,
    });
    puente.iniciar();
    await esperarHasta(() => puente.conectado);
    await esperarHasta(() => cerradas === 1);
    expect(puente.conectado).toBe(true);
    expect(llamadas).toBe(2);
    await puente.cerrar();
  });
});

describe('latido del conector', () => {
  it('añade heartbeat=15 sin tocar credenciales, y respeta uno ya puesto', () => {
    expect(conLatido('amqp://u:p%40x@h:5672/')).toBe('amqp://u:p%40x@h:5672/?heartbeat=15');
    expect(conLatido('amqp://u:p@h:5672/?heartbeat=5')).toBe('amqp://u:p@h:5672/?heartbeat=5');
  });
});
