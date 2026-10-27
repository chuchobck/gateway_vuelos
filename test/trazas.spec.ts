import { leerTraceparent } from '../src/observabilidad/traceparent';
import { ATRIBUTOS_PERMITIDOS } from '../src/observabilidad/atributos';
import { GatewayDePrueba, ORIGEN_PERMITIDO, Servicios, TODOS_LOS_SCOPES } from './utils/gateway';
import { RecolectorOtlp, SpanRecibido } from './utils/recolector-otlp';

const TRAZA_CLIENTE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PADRE_CLIENTE = '00f067aa0ba902b7';
const TRACEPARENT_CLIENTE = `00-${TRAZA_CLIENTE}-${PADRE_CLIENTE}-01`;
const RESERVA = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

/** OTLP SpanKind (el del cable): 1 INTERNAL, 2 SERVER, 3 CLIENT. */
const SERVER = 2;
const CLIENT = 3;
const INTERNAL = 1;
const ERROR = 2;

describe('trazas', () => {
  const servicios = new Servicios();
  const recolector = new RecolectorOtlp();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await Promise.all([servicios.iniciar(), recolector.iniciar()]);
    gateway = await new GatewayDePrueba(servicios, {
      OTEL_EXPORTER_OTLP_ENDPOINT: recolector.url,
    }).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await Promise.all([servicios.detener(), recolector.detener()]);
  });
  beforeEach(() => {
    servicios.reiniciar();
    recolector.reiniciar();
  });

  describe('propagación', () => {
    it('raíz nueva por defecto: el upstream recibe otra traza, y X-Trace-Id es esa', async () => {
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { traceparent: TRACEPARENT_CLIENTE },
        cuerpo: '{}',
      });
      const recibido = leerTraceparent(servicios.upstreams.bff.ultima().cabeceras.traceparent);
      expect(recibido).toBeDefined();
      expect(recibido!.traceId).not.toBe(TRAZA_CLIENTE);
      expect(recibido!.parentId).not.toBe(PADRE_CLIENTE);
      expect(recibido!.muestreado).toBe(true);
      expect(respuesta.cabeceras['x-trace-id']).toBe(recibido!.traceId);
    });

    it('sin traceparent del cliente, también abre una y la manda', async () => {
      const respuesta = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
      const recibido = leerTraceparent(servicios.upstreams.core.ultima().cabeceras.traceparent);
      expect(recibido?.traceId).toBe(respuesta.cabeceras['x-trace-id']);
    });

    it('cada llamada a un upstream lleva su propio parent-id (el span del gateway hacia él)', async () => {
      await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
      const recibido = leerTraceparent(servicios.upstreams.core.ultima().cabeceras.traceparent)!;
      const spans = await recolector.esperarTraza(recibido.traceId, 2);
      const cliente = spans.find((s) => s.tipo === CLIENT && s.traceId === recibido.traceId);
      const raiz = spans.find((s) => s.tipo === SERVER && s.traceId === recibido.traceId);
      expect(cliente?.spanId).toBe(recibido.parentId);
      expect(raiz?.spanId).not.toBe(recibido.parentId);
    });

    it('tracestate pasa intacto; uno fuera del tope no pasa', async () => {
      await gateway.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { traceparent: TRACEPARENT_CLIENTE, tracestate: 'congo=t61rcWkgMzE,rojo=00f0' },
        cuerpo: '{}',
      });
      expect(servicios.upstreams.bff.ultima().cabeceras.tracestate).toBe(
        'congo=t61rcWkgMzE,rojo=00f0',
      );
      await gateway.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { tracestate: `a=${'x'.repeat(600)}` },
        cuerpo: '{}',
      });
      expect(servicios.upstreams.bff.ultima().cabeceras.tracestate).toBeUndefined();
    });

    it('/health/upstreams y las respuestas propias no rompen nada sin upstream', async () => {
      const respuesta = await gateway.pedir({ ruta: '/no-existe' });
      expect(respuesta.status).toBe(404);
      expect(respuesta.cabeceras['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('TRACE_TRUST_INCOMING', () => {
    let confiado: GatewayDePrueba;
    beforeAll(async () => {
      confiado = await new GatewayDePrueba(servicios, {
        OTEL_EXPORTER_OTLP_ENDPOINT: recolector.url,
        TRACE_TRUST_INCOMING: 'true',
      }).iniciar();
    });
    afterAll(() => confiado.detener());

    it('con true continúa la traza del cliente (mismo trace-id, otro parent-id)', async () => {
      const respuesta = await confiado.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { traceparent: TRACEPARENT_CLIENTE },
        cuerpo: '{}',
      });
      const recibido = leerTraceparent(servicios.upstreams.bff.ultima().cabeceras.traceparent)!;
      expect(recibido.traceId).toBe(TRAZA_CLIENTE);
      expect(recibido.parentId).not.toBe(PADRE_CLIENTE);
      expect(respuesta.cabeceras['x-trace-id']).toBe(TRAZA_CLIENTE);
      // El span raíz del gateway cuelga del span del cliente
      const spans = await recolector.esperarTraza(TRAZA_CLIENTE, 2);
      const raiz = spans.find((s) => s.tipo === SERVER && s.traceId === TRAZA_CLIENTE);
      expect(raiz?.parentSpanId).toBe(PADRE_CLIENTE);
    });

    it('respeta el bit de muestreo del cliente: 00 sigue sin muestrear y no se exporta', async () => {
      // Otra traza: la de la prueba anterior todavía puede estar llegando al recolector
      const sinMuestrear = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
      await confiado.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { traceparent: `00-${sinMuestrear}-${PADRE_CLIENTE}-00` },
        cuerpo: '{}',
      });
      const recibido = leerTraceparent(servicios.upstreams.bff.ultima().cabeceras.traceparent)!;
      expect(recibido.traceId).toBe(sinMuestrear);
      expect(recibido.muestreado).toBe(false);
      await new Promise((listo) => setTimeout(listo, 300));
      expect(recolector.deTraza(sinMuestrear)).toEqual([]);
    });

    it.each([
      `ff-${TRAZA_CLIENTE}-${PADRE_CLIENTE}-01`,
      `00-${'0'.repeat(32)}-${PADRE_CLIENTE}-01`,
      `00-${TRAZA_CLIENTE.toUpperCase()}-${PADRE_CLIENTE}-01`,
      `00-${TRAZA_CLIENTE}-${PADRE_CLIENTE}-01-extra`,
      `00-${TRAZA_CLIENTE}`,
      'no-es-un-traceparent',
    ])('uno inválido (%s) se ignora: traza nueva, sin error', async (traceparent) => {
      const respuesta = await confiado.pedir({
        metodo: 'POST',
        ruta: '/graphql',
        cabeceras: { traceparent },
        cuerpo: '{}',
      });
      expect(respuesta.status).toBe(200);
      const recibido = leerTraceparent(servicios.upstreams.bff.ultima().cabeceras.traceparent)!;
      expect(recibido.traceId).not.toBe(TRAZA_CLIENTE);
      expect(recibido.muestreado).toBe(true);
    });
  });

  describe('sin exportador y con muestreo 0', () => {
    it('la propagación y X-Trace-Id funcionan igual', async () => {
      const otro = await new GatewayDePrueba(servicios, { OTEL_TRACES_SAMPLER_ARG: '0' }).iniciar();
      try {
        const respuesta = await otro.pedir({ metodo: 'POST', ruta: '/graphql', cuerpo: '{}' });
        const recibido = leerTraceparent(servicios.upstreams.bff.ultima().cabeceras.traceparent);
        expect(recibido).toBeDefined();
        expect(recibido!.muestreado).toBe(false);
        expect(respuesta.cabeceras['x-trace-id']).toBe(recibido!.traceId);
        // Los logs llevan el traceId aunque no se registre la traza
        expect(otro.registros().find((r) => r.msg === 'acceso')?.traceId).toBe(recibido!.traceId);
      } finally {
        await otro.detener();
      }
    });
  });

  describe('logs y X-Trace-Id', () => {
    it('todas las líneas de una petición llevan el mismo traceId y requestId', async () => {
      const otro = await new GatewayDePrueba(servicios, {
        UPSTREAM_CORE_URL: 'http://127.0.0.1:9',
      }).iniciar();
      try {
        const token = await otro.token({ scope: 'flights:read' });
        const requestId = 'b9f1c3a2-5d4e-4f6a-8b7c-0d1e2f3a4b5c';
        const respuesta = await otro.pedir({
          ruta: `/flights/v1/bookings/${RESERVA}`,
          cabeceras: {
            authorization: `Bearer ${token}`,
            'x-request-id': requestId,
            origin: ORIGEN_PERMITIDO,
          },
        });
        expect(respuesta.status).toBe(502);
        const traceId = respuesta.cabeceras['x-trace-id'];
        expect(traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(respuesta.cabeceras['access-control-expose-headers']).toContain('x-trace-id');

        const deLaPeticion = otro.registros().filter((r) => r.traceId === traceId);
        const mensajes = deLaPeticion.map((r) => r.msg);
        // JWKS (escrito por el verificador, que no recibe la petición), el fallo y el acceso
        expect(mensajes).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^JWKS descargado/),
            'Fallo del upstream',
            'acceso',
          ]),
        );
        for (const linea of deLaPeticion) {
          expect(linea.requestId).toBe(requestId);
          expect(linea.spanId).toMatch(/^[0-9a-f]{16}$/);
        }
        // Y ninguna línea de esa petición se quedó sin traceId
        const sinTraza = otro.registros().filter((r) => r.requestId === requestId && !r.traceId);
        expect(sinTraza).toEqual([]);
      } finally {
        await otro.detener();
      }
    });

    it('una URL que Fastify rechaza (400) también tiene traza', async () => {
      const respuesta = await gateway.pedir({ ruta: '/flights/v1/a%zz' });
      expect(respuesta.status).toBe(400);
      const traceId = respuesta.cabeceras['x-trace-id'];
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(gateway.registros().find((r) => r.traceId === traceId)?.status).toBe(400);
    });
  });

  describe('spans en el recolector', () => {
    async function trazaDe(respuesta: { cabeceras: Record<string, unknown> }, cuantos: number) {
      const traceId = String(respuesta.cabeceras['x-trace-id']);
      const fin = Date.now() + 5000;
      while (recolector.deTraza(traceId).length < cuantos && Date.now() < fin) {
        await new Promise((listo) => setTimeout(listo, 20));
      }
      return recolector.deTraza(traceId);
    }

    it('raíz → auth.verify y raíz → upstream, con plantillas y atributos permitidos', async () => {
      const token = await gateway.token({ scope: 'flights:read' });
      const respuesta = await gateway.pedir({
        ruta: `/flights/v1/bookings/${RESERVA}?include=tickets`,
        cabeceras: { authorization: `Bearer ${token}` },
      });
      const spans = await trazaDe(respuesta, 3);
      expect(spans).toHaveLength(3);
      const raiz = spans.find((s) => s.tipo === SERVER)!;
      const auth = spans.find((s) => s.tipo === INTERNAL)!;
      const upstream = spans.find((s) => s.tipo === CLIENT)!;

      expect(raiz.nombre).toBe('GET /flights/v1/bookings/{bookingId}');
      expect(raiz.parentSpanId).toBe('');
      expect(raiz.atributos).toEqual({
        'http.request.method': 'GET',
        'http.route': '/flights/v1/bookings/{bookingId}',
        'http.response.status_code': 200,
        'quinde.upstream': 'core',
        'quinde.auth.mode': 'token',
        'quinde.request_id': respuesta.cabeceras['x-request-id'],
        'quinde.correlation_id': respuesta.cabeceras['x-correlation-id'],
      });
      expect(auth.nombre).toBe('auth.verify');
      expect(auth.parentSpanId).toBe(raiz.spanId);
      expect(upstream.nombre).toBe('GET /flights/v1/bookings/{bookingId}');
      expect(upstream.parentSpanId).toBe(raiz.spanId);
      expect(upstream.atributos['quinde.upstream']).toBe('core');
      expect(upstream.atributos['quinde.correlation_id']).toBe(
        respuesta.cabeceras['x-correlation-id'],
      );
      expect(upstream.atributos['http.response.status_code']).toBe(200);

      for (const span of spans) {
        expect(span.servicio).toBe('quinde-gateway');
        expect(span.recurso['service.version']).toBe('0.1.0');
        expect(span.recurso['deployment.environment']).toBe('development');
        for (const atributo of Object.keys(span.atributos)) {
          expect(ATRIBUTOS_PERMITIDOS.has(atributo)).toBe(true);
        }
        expect(span.estado.code ?? 0).not.toBe(ERROR);
      }
    });

    it('una ruta pública no tiene span de auth; una regla sin contrato usa su patrón', async () => {
      const respuesta = await gateway.pedir({
        metodo: 'DELETE',
        ruta: `/flights/v1/webhooks/${RESERVA}`,
        cabeceras: {
          authorization: `Bearer ${await gateway.token({ scope: 'flights:webhooks' })}`,
        },
      });
      const spans = await trazaDe(respuesta, 3);
      expect(spans.find((s) => s.tipo === SERVER)?.nombre).toBe('DELETE /flights/v1/webhooks/{id}');

      const publica = await gateway.pedir({ metodo: 'POST', ruta: '/graphql', cuerpo: '{}' });
      const dePublica = await trazaDe(publica, 2);
      expect(dePublica.map((s) => s.tipo).sort()).toEqual([SERVER, CLIENT]);
      expect(dePublica.find((s) => s.tipo === SERVER)?.atributos['quinde.auth.mode']).toBe(
        'publica',
      );
    });

    it('lo desconocido o bloqueado es __unmatched__, sin la ruta pedida', async () => {
      const respuesta = await gateway.pedir({ ruta: '/internal/v1/events/secreto' });
      const [raiz] = await trazaDe(respuesta, 1);
      expect(raiz?.nombre).toBe('GET __unmatched__');
      expect(raiz?.atributos['http.route']).toBe('__unmatched__');
    });

    it('auth rechazado: error en auth.verify (invalid_token), la raíz 401 no es error', async () => {
      const respuesta = await gateway.pedir({
        ruta: '/flights/v1/bookings',
        cabeceras: { authorization: 'Bearer x.y.z' },
      });
      expect(respuesta.status).toBe(401);
      const spans = await trazaDe(respuesta, 2);
      const auth = spans.find((s) => s.tipo === INTERNAL)!;
      expect(auth.estado.code).toBe(ERROR);
      expect(auth.estado.message ?? '').toBe('');
      expect(auth.atributos['error.type']).toBe('invalid_token');
      expect(spans.find((s) => s.tipo === SERVER)?.estado.code ?? 0).not.toBe(ERROR);
    });

    it('502 y 504: error marcado con su tipo, sin el mensaje interno del upstream', async () => {
      const otro = await new GatewayDePrueba(servicios, {
        OTEL_EXPORTER_OTLP_ENDPOINT: recolector.url,
        UPSTREAM_NOTIFIER_URL: 'http://127.0.0.1:9',
        TIMEOUT_BFF_MS: '500',
      }).iniciar();
      try {
        const caido = await otro.pedir({
          ruta: '/flights/v1/webhooks',
          cabeceras: { authorization: `Bearer ${await otro.token({ scope: 'flights:webhooks' })}` },
        });
        expect(caido.status).toBe(502);
        const spans502 = await trazaDe(caido, 3);
        const cliente502 = spans502.find((s) => s.tipo === CLIENT)!;
        expect(cliente502.estado.code).toBe(ERROR);
        expect(cliente502.atributos['error.type']).toBe('unavailable');
        const raiz502 = spans502.find((s) => s.tipo === SERVER)!;
        expect(raiz502.estado.code).toBe(ERROR);
        expect(raiz502.atributos['error.type']).toBe('502');

        servicios.upstreams.bff.manejador = (_p, r) => {
          setTimeout(() => r.writeHead(200).end('{}'), 1500);
        };
        const lento = await otro.pedir({ metodo: 'POST', ruta: '/graphql', cuerpo: '{}' });
        expect(lento.status).toBe(504);
        const spans504 = await trazaDe(lento, 2);
        expect(spans504.find((s) => s.tipo === CLIENT)?.atributos['error.type']).toBe('timeout');
        expect(spans504.find((s) => s.tipo === SERVER)?.atributos['error.type']).toBe('504');

        const todo = JSON.stringify([...spans502, ...spans504]);
        expect(todo).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|socket|not available|in time/i);
        for (const span of [...spans502, ...spans504]) {
          expect(span.estado.message ?? '').toBe('');
        }
      } finally {
        await otro.detener();
      }
    });

    it('un 5xx del upstream marca el span del upstream', async () => {
      servicios.upstreams.core.manejador = (_p, r) =>
        r.writeHead(503, { 'retry-after': '5' }).end();
      const respuesta = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
      expect(respuesta.status).toBe(503);
      const spans = await trazaDe(respuesta, 2);
      const cliente = spans.find((s) => s.tipo === CLIENT)!;
      expect(cliente.estado.code).toBe(ERROR);
      expect(cliente.atributos['error.type']).toBe('503');
    });
  });

  describe('escaneo de todo lo emitido', () => {
    it('ni los spans ni los logs llevan Authorization, query, cuerpo, correo, id de reserva ni IP', async () => {
      const token = await gateway.token({ scope: TODOS_LOS_SCOPES });
      const correo = 'ana.perez@e2e.quinde.example';
      const secreto = 'whsec-escaneo-9f8e7d6c5b4a';
      const peticiones = [
        {
          ruta: `/flights/v1/bookings/${RESERVA}?email=${encodeURIComponent(correo)}&t=${token}`,
          cabeceras: { authorization: `Bearer ${token}`, cookie: `sesion=${secreto}` },
        },
        {
          metodo: 'POST',
          ruta: '/flights/v1/webhooks',
          cabeceras: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          cuerpo: JSON.stringify({
            url: 'https://tercero.example/hook',
            secret: secreto,
            email: correo,
          }),
        },
        {
          metodo: 'POST',
          ruta: '/identity/v1/auth/login',
          cabeceras: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
          cuerpo: JSON.stringify({ email: correo, password: secreto }),
        },
        { ruta: `/flights/v1/bookings/${RESERVA}`, cabeceras: { authorization: 'Bearer x.y.z' } },
        { ruta: `/no-existe/${RESERVA}?password=${secreto}` },
      ];
      const ids: string[] = [];
      for (const p of peticiones) {
        const r = await gateway.pedir({ metodo: 'GET', ...p });
        ids.push(String(r.cabeceras['x-trace-id']));
      }
      const fin = Date.now() + 5000;
      while (ids.some((id) => recolector.deTraza(id).length === 0) && Date.now() < fin) {
        await new Promise((listo) => setTimeout(listo, 20));
      }
      const spans: SpanRecibido[] = ids.flatMap((id) => recolector.deTraza(id));
      expect(spans.length).toBeGreaterThanOrEqual(peticiones.length * 2);

      const emitido = [...recolector.cuerpos, ...gateway.logs].join('\n');
      // Las IPs se buscan en lo de las peticiones: la línea de arranque dice dónde escucha el gateway
      const dePeticiones = [
        ...recolector.cuerpos,
        ...gateway.logs.filter((l) => l.includes('"requestId"')),
      ].join('\n');
      for (const ip of ['203.0.113.77', '127.0.0.1']) expect(dePeticiones).not.toContain(ip);
      for (const prohibido of [
        token,
        token.split('.')[2]!,
        secreto,
        correo,
        RESERVA,
        'tercero.example',
        '203.0.113.77',
        'password',
        'Bearer',
        'cookie',
        '?email',
      ]) {
        expect(emitido).not.toContain(prohibido);
      }
      expect(emitido).not.toMatch(/authorization/i);
    });
  });
});
