import { randomUUID } from 'node:crypto';
import { filasDeRutas } from '../src/cli/listar-rutas';
import { ContratoCore, RUTA_CONTRATO_V2 } from '../src/rutas/contrato-core';
import { GatewayDePrueba, ORIGEN_PERMITIDO, Servicios } from './utils/gateway';
import { Pedido } from './utils/http-crudo';
import { RecolectorOtlp } from './utils/recolector-otlp';

const BOOKING = '0b6f5f0e-5d6b-4c7e-9a3c-8e2f1f4a7c11';
const SESION_KIOSKO = 'Kiosk k1_7Hq2VxN8sZpL4wTgYb6RcD0eFaUo3JmI';

interface RutaNueva {
  nombre: string;
  metodo: string;
  ruta: string;
  plantilla: string;
  /** Tope por IP y minuto del core (lo que el gateway no puede superar); undefined: solo el global. */
  tope?: number;
}

const RUTAS: RutaNueva[] = [
  {
    nombre: 'lookup',
    metodo: 'POST',
    ruta: '/flights/v1/kiosk/lookup',
    plantilla: '/flights/v1/kiosk/lookup',
    tope: 10,
  },
  {
    nombre: 'check-in',
    metodo: 'POST',
    ruta: `/flights/v1/kiosk/bookings/${BOOKING}/check-in`,
    plantilla: '/flights/v1/kiosk/bookings/{bookingId}/check-in',
    tope: 20,
  },
  {
    nombre: 'pases de abordar',
    metodo: 'GET',
    ruta: `/flights/v1/kiosk/bookings/${BOOKING}/boarding-passes`,
    plantilla: '/flights/v1/kiosk/bookings/{bookingId}/boarding-passes',
    tope: 60,
  },
  {
    nombre: 'salidas',
    metodo: 'GET',
    ruta: '/flights/v1/airports/UIO/departures',
    plantilla: '/flights/v1/airports/{iataCode}/departures',
  },
];

/** Una petición a una de las rutas nuevas, con cuerpo JSON si es POST. */
function pedido(r: RutaNueva, cabeceras: Record<string, string> = {}): Pedido {
  return {
    metodo: r.metodo,
    ruta: r.ruta,
    cabeceras: {
      ...(r.metodo === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...cabeceras,
    },
    ...(r.metodo === 'POST' ? { cuerpo: '{}' } : {}),
  };
}

/**
 * Fase F1c: las rutas del kiosko y las salidas que el core agregó bajo /flights/v1 y el contrato
 * no declara. Son públicas solo con sus métodos exactos; las de kiosko, con el límite estricto
 * (con el tope del core) y su propia sesión `Authorization: Kiosk <token>`, que el gateway no mira.
 */
describe('rutas de kiosko y salidas', () => {
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

  describe.each(RUTAS)('$metodo $plantilla', (r) => {
    it('pasa sin token al core, con la ruta intacta', async () => {
      const respuesta = await gateway.pedir(pedido(r));
      expect(respuesta.status).toBe(200);
      expect(servicios.upstreams.core.recibidas).toHaveLength(1);
      expect(servicios.upstreams.core.recibidas[0]).toMatchObject({
        metodo: r.metodo,
        url: r.ruta,
      });
    });

    it('con la query también (sigue siendo la misma ruta)', async () => {
      const respuesta = await gateway.pedir({ ...pedido(r), ruta: `${r.ruta}?x=1` });
      expect(respuesta.status).toBe(200);
      expect(servicios.upstreams.core.recibidas[0]?.url).toBe(`${r.ruta}?x=1`);
    });

    it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].filter((m) => m !== r.metodo))(
      'con %s NO es pública: 401 sin token y no llega al core',
      async (metodo) => {
        const respuesta = await gateway.pedir({ ...pedido(r), metodo });
        expect(respuesta.status).toBe(401);
        expect(String(respuesta.cabeceras['www-authenticate'])).toMatch(/^Bearer /);
        expect(servicios.totalIniciadas()).toBe(0);
      },
    );

    it('con otro método y un token válido pasa por la regla de /flights/v1/** (decide el core)', async () => {
      const token = await gateway.token({ scope: '' });
      const metodo = r.metodo === 'GET' ? 'DELETE' : 'GET';
      const respuesta = await gateway.pedir({
        ...pedido(r),
        metodo,
        cabeceras: { authorization: `Bearer ${token}` },
      });
      expect(respuesta.status).toBe(200);
      expect(servicios.upstreams.core.recibidas[0]?.metodo).toBe(metodo);
    });
  });

  describe('lo parecido NO es público', () => {
    it.each([
      ['GET', '/flights/v1/kioskx'],
      ['POST', '/flights/v1/kioskx/lookup'],
      ['GET', '/flights/v1/kiosk'],
      ['POST', '/flights/v1/kiosk/lookup/extra'],
      ['POST', '/flights/v1/kiosk/lookups'],
      ['POST', `/flights/v1/kiosk/bookings/${BOOKING}/check-in/extra`],
      ['POST', '/flights/v1/kiosk/bookings/check-in'],
      ['POST', `/flights/v1/kiosk/bookings/${BOOKING}/checkin`],
      ['GET', `/flights/v1/kiosk/bookings/${BOOKING}`],
      ['GET', `/flights/v1/kiosk/bookings/${BOOKING}/boarding-passes/extra`],
      ['GET', '/flights/v1/airports/UIO/departures/extra'],
      ['GET', '/flights/v1/airports/departures'],
      ['GET', '/flights/v1/airports/UIO'],
      ['GET', '/flights/v1/airports'],
      ['GET', '/flights/v1/airports/UIO/arrivals'],
      ['GET', '/flights/v1/admin/airports/UIO/departures'],
      ['GET', '/flights/v1/admin/boarding/anything'],
      ['GET', '/flights/v1/bookings'],
      ['GET', `/flights/v1/bookings/${BOOKING}`],
      ['POST', '/flights/v1/bookings'],
      ['GET', '/flights/v1/webhooks'],
    ])('%s %s → 401 sin token y no llega al core', async (metodo, ruta) => {
      const respuesta = await gateway.pedir({
        metodo,
        ruta,
        ...(metodo === 'POST'
          ? { cabeceras: { 'content-type': 'application/json' }, cuerpo: '{}' }
          : {}),
      });
      expect(respuesta.status).toBe(401);
      expect(servicios.totalIniciadas()).toBe(0);
    });

    it.each([
      '/flights/v1/kiosk/../admin/users',
      '/flights/v1/kiosk/%2e%2e/admin/users',
      '/flights/v1/kiosk/lookup/..',
      '/flights/v1/airports/UIO/departures/..%2fadmin',
      '/flights/v1/kiosk//lookup',
    ])('una ruta ambigua (%s) es 400 y no llega al core', async (ruta) => {
      const respuesta = await gateway.pedir({ metodo: 'POST', ruta });
      expect(respuesta.status).toBe(400);
      expect(servicios.totalIniciadas()).toBe(0);
    });

    it('un token de otra regla no cambia nada: el resto de /flights/v1/** sigue pidiendo token', async () => {
      // Con una sesión de kiosko en lugar de un JWT, una ruta protegida sigue siendo 401
      const respuesta = await gateway.pedir({
        ruta: '/flights/v1/bookings',
        cabeceras: { authorization: SESION_KIOSKO },
      });
      expect(respuesta.status).toBe(401);
      expect(servicios.totalIniciadas()).toBe(0);
    });
  });

  describe('Authorization: Kiosk <token>', () => {
    it.each(RUTAS.slice(1, 3))('llega intacta al core en $nombre, sin tocar el JWKS', async (r) => {
      // El JWKS se baja al arrancar el gateway; lo que cuenta es que la petición no lo vuelva a pedir
      const antes = servicios.identidad.descargas;
      const respuesta = await gateway.pedir(pedido(r, { authorization: SESION_KIOSKO }));
      expect(respuesta.status).toBe(200);
      const recibida = servicios.upstreams.core.recibidas[0]!;
      expect(recibida.cabeceras.authorization).toBe(SESION_KIOSKO);
      // El gateway no la valida como JWT: ni la rechaza ni consulta el JWKS por ella
      expect(servicios.identidad.descargas).toBe(antes);
    });

    it('no depende de identity: con el JWKS caído sigue pasando (no es 503)', async () => {
      servicios.identidad.encendida = false;
      const sinIdentity = await new GatewayDePrueba(servicios).iniciar();
      try {
        const respuesta = await sinIdentity.pedir(
          pedido(RUTAS[0]!, { authorization: SESION_KIOSKO }),
        );
        expect(respuesta.status).toBe(200);
        expect(servicios.upstreams.core.recibidas[0]?.cabeceras.authorization).toBe(SESION_KIOSKO);
      } finally {
        await sinIdentity.detener();
      }
    });

    it('cualquier valor (vacío, basura, Bearer inválido) pasa tal cual: el core decide', async () => {
      for (const valor of [
        'Kiosk',
        'Kiosk ',
        'Bearer x.y.z',
        'basura sin forma',
        'kiosk minuscula',
      ]) {
        servicios.upstreams.core.recibidas.length = 0;
        const respuesta = await gateway.pedir(pedido(RUTAS[1]!, { authorization: valor }));
        expect(respuesta.status).toBe(200);
        expect(servicios.upstreams.core.recibidas[0]?.cabeceras.authorization).toBe(valor.trim());
      }
    });

    it('si el core responde 401 de su sesión, pasa tal cual (con su WWW-Authenticate)', async () => {
      servicios.upstreams.core.manejador = (_p, res) => {
        res.writeHead(401, {
          'content-type': 'application/problem+json',
          'www-authenticate': 'Kiosk realm="quinde-kiosko"',
        });
        res.end('{"status":401,"title":"Unauthorized","code":"VALIDATION_FAILED"}');
      };
      const respuesta = await gateway.pedir(pedido(RUTAS[2]!, { authorization: SESION_KIOSKO }));
      expect(respuesta.status).toBe(401);
      expect(respuesta.cabeceras['www-authenticate']).toBe('Kiosk realm="quinde-kiosko"');
    });
  });

  describe('CORS desde el e-commerce', () => {
    it.each(RUTAS.slice(0, 3))(
      'el preflight de $nombre deja pasar Authorization y Content-Type',
      async (r) => {
        const respuesta = await gateway.pedir({
          metodo: 'OPTIONS',
          ruta: r.ruta,
          cabeceras: {
            origin: ORIGEN_PERMITIDO,
            'access-control-request-method': r.metodo,
            'access-control-request-headers': 'authorization, content-type',
          },
        });
        expect(respuesta.status).toBe(204);
        expect(respuesta.cabeceras['access-control-allow-origin']).toBe(ORIGEN_PERMITIDO);
        const permitidas = String(respuesta.cabeceras['access-control-allow-headers']).split(', ');
        expect(permitidas).toEqual(expect.arrayContaining(['authorization', 'content-type']));
        expect(String(respuesta.cabeceras['access-control-allow-methods'])).toContain(r.metodo);
        expect(servicios.totalIniciadas()).toBe(0);
      },
    );

    it('la respuesta lleva el CORS del gateway para el origen del e-commerce y no para otro', async () => {
      const buena = await gateway.pedir(
        pedido(RUTAS[0]!, { origin: ORIGEN_PERMITIDO, authorization: SESION_KIOSKO }),
      );
      expect(buena.cabeceras['access-control-allow-origin']).toBe(ORIGEN_PERMITIDO);
      expect(buena.cabeceras['access-control-allow-credentials']).toBeUndefined();
      const ajena = await gateway.pedir(
        pedido(RUTAS[0]!, { origin: 'https://evil.example', authorization: SESION_KIOSKO }),
      );
      expect(ajena.cabeceras['access-control-allow-origin']).toBeUndefined();
    });
  });

  it('rutas:listar muestra las cuatro con su método, su plantilla y su tope', () => {
    const filas = filasDeRutas({
      v1: ContratoCore.leer(),
      v2: ContratoCore.leer(RUTA_CONTRATO_V2),
    });
    for (const r of RUTAS) {
      expect(filas).toContainEqual(
        expect.objectContaining({
          ruta: r.plantilla,
          metodo: r.metodo,
          destino: 'core',
          seguridad: r.tope ? `publica + límite estricto (tope ${r.tope}/min)` : 'publica',
        }),
      );
    }
  });
});

/** El límite estricto por IP y ruta, con el tope del core: nunca más permisivo que él. */
describe('límite estricto de kiosko', () => {
  const servicios = new Servicios();
  beforeAll(() => servicios.iniciar());
  afterAll(() => servicios.detener());
  beforeEach(() => servicios.reiniciar());

  /** Cuántas peticiones seguidas pasan antes del primer 429 (hasta `maximo`). */
  async function hastaElPrimer429(
    gateway: GatewayDePrueba,
    r: RutaNueva,
    maximo: number,
    ruta: (i: number) => string = () => r.ruta,
  ): Promise<number> {
    for (let i = 0; i < maximo; i++) {
      const respuesta = await gateway.pedir({ ...pedido(r), ruta: ruta(i) });
      if (respuesta.status === 429) return i;
      expect(respuesta.status).toBe(200);
    }
    return maximo;
  }

  describe.each([
    ['por defecto (20)', {}, { lookup: 10, checkin: 20, pases: 20 }],
    [
      'con 100 configurado: gana el tope del core',
      { RATE_LIMIT_STRICT_MAX: '100' },
      { lookup: 10, checkin: 20, pases: 60 },
    ],
    [
      'con 5 configurado: gana el configurado',
      { RATE_LIMIT_STRICT_MAX: '5' },
      { lookup: 5, checkin: 5, pases: 5 },
    ],
  ])('%s', (_caso, variables, esperados) => {
    let gateway: GatewayDePrueba;
    beforeEach(async () => {
      gateway = await new GatewayDePrueba(servicios, {
        RATE_LIMIT_MAX: '100000',
        // Los defaults de GatewayDePrueba (100000) se pisan: aquí se prueba el valor real
        RATE_LIMIT_STRICT_MAX: '20',
        ...variables,
      }).iniciar();
    });
    afterEach(() => gateway.detener());

    it('lookup, check-in y pases cortan con 429 en su tope, y cada ruta cuenta aparte', async () => {
      const [lookup, checkin, pases] = RUTAS as [RutaNueva, RutaNueva, RutaNueva];
      expect(await hastaElPrimer429(gateway, lookup, 200)).toBe(esperados.lookup);
      // El contador de lookup agotado no toca los otros
      expect(await hastaElPrimer429(gateway, checkin, 200)).toBe(esperados.checkin);
      expect(await hastaElPrimer429(gateway, pases, 200)).toBe(esperados.pases);
      // Y los 429 no llegaron al core
      expect(servicios.upstreams.core.recibidas).toHaveLength(
        esperados.lookup + esperados.checkin + esperados.pases,
      );
    });
  });

  describe('con la configuración por defecto', () => {
    let gateway: GatewayDePrueba;
    beforeEach(async () => {
      gateway = await new GatewayDePrueba(servicios, {
        RATE_LIMIT_MAX: '100000',
        RATE_LIMIT_STRICT_MAX: '20',
        TRUST_PROXY_HOPS: '1',
      }).iniciar();
    });
    afterEach(() => gateway.detener());

    it('429 RATE_LIMIT_EXCEEDED con Retry-After de la ventana, y se abre al pasarla', async () => {
      const lookup = RUTAS[0]!;
      await hastaElPrimer429(gateway, lookup, 50);
      const limitada = await gateway.pedir(pedido(lookup));
      expect(limitada.status).toBe(429);
      expect(limitada.json()).toMatchObject({ status: 429, code: 'RATE_LIMIT_EXCEEDED' });
      expect(limitada.cabeceras['retry-after']).toBe('60');
      expect(servicios.upstreams.core.recibidas).toHaveLength(10);
      gateway.reloj.adelantar(60_000);
      expect((await gateway.pedir(pedido(lookup))).status).toBe(200);
    });

    it('el contador de una ruta con id es uno solo: cambiar de bookingId no lo reinicia', async () => {
      const checkin = RUTAS[1]!;
      const ruta = (i: number) => `/flights/v1/kiosk/bookings/${randomUUID()}-${i}/check-in`;
      expect(await hastaElPrimer429(gateway, checkin, 100, ruta)).toBe(20);
    });

    it('cada IP tiene el suyo', async () => {
      const lookup = RUTAS[0]!;
      for (let i = 0; i < 10; i++) {
        await gateway.pedir(pedido(lookup, { 'x-forwarded-for': '192.0.2.10' }));
      }
      expect(
        (await gateway.pedir(pedido(lookup, { 'x-forwarded-for': '192.0.2.10' }))).status,
      ).toBe(429);
      expect(
        (await gateway.pedir(pedido(lookup, { 'x-forwarded-for': '192.0.2.11' }))).status,
      ).toBe(200);
    });

    it('las salidas no llevan el estricto: solo el global', async () => {
      const salidas = RUTAS[3]!;
      expect(await hastaElPrimer429(gateway, salidas, 60)).toBe(60);
    });

    it('lo que no es kiosko tampoco lo gasta: el contador de lookup no cuenta otras rutas', async () => {
      for (let i = 0; i < 15; i++) await gateway.pedir(pedido(RUTAS[3]!));
      expect(await hastaElPrimer429(gateway, RUTAS[0]!, 50)).toBe(10);
    });
  });
});

/** Nada de la sesión, del PNR, del bookingId ni del apellido va a un log, un span ni una métrica. */
describe('nada sensible en logs, trazas ni métricas', () => {
  const servicios = new Servicios();
  const recolector = new RecolectorOtlp();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await Promise.all([servicios.iniciar(), recolector.iniciar()]);
    gateway = await new GatewayDePrueba(servicios, {
      OTEL_EXPORTER_OTLP_ENDPOINT: recolector.url,
      LOG_LEVEL: 'trace',
    }).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await Promise.all([servicios.detener(), recolector.detener()]);
  });

  it('la ruta es siempre la plantilla, y ni la sesión, el PNR, el bookingId ni el apellido salen', async () => {
    const pnr = 'QZK7PX';
    const apellido = 'Villacís-Albán';
    const reserva = randomUUID();
    const sesion = `Kiosk k1_${randomUUID().replace(/-/g, '')}`;
    const peticiones: Pedido[] = [
      {
        metodo: 'POST',
        ruta: `/flights/v1/kiosk/lookup?pnr=${pnr}&lastName=${encodeURIComponent(apellido)}`,
        cabeceras: { 'content-type': 'application/json', authorization: sesion },
        cuerpo: JSON.stringify({ pnr, lastName: apellido }),
      },
      {
        metodo: 'POST',
        ruta: `/flights/v1/kiosk/bookings/${reserva}/check-in`,
        cabeceras: { 'content-type': 'application/json', authorization: sesion },
        cuerpo: '{}',
      },
      {
        ruta: `/flights/v1/kiosk/bookings/${reserva}/boarding-passes`,
        cabeceras: { authorization: sesion },
      },
      { ruta: '/flights/v1/airports/UIO/departures?date=2026-11-12' },
      // Un error del borde y uno del core también se escanean
      {
        metodo: 'POST',
        ruta: `/flights/v1/kiosk/bookings/${reserva}/check-in/x`,
        cabeceras: { authorization: sesion },
      },
    ];
    // El core falso no devuelve lo que recibe (por defecto repite la URL): se escanea lo del gateway
    servicios.upstreams.core.manejador = (_p, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    const ids: string[] = [];
    const respuestas: string[] = [];
    for (const p of peticiones) {
      const r = await gateway.pedir(p);
      ids.push(String(r.cabeceras['x-trace-id']));
      respuestas.push(JSON.stringify(r.cabeceras), r.texto);
    }
    const fin = Date.now() + 5000;
    while (ids.some((id) => recolector.deTraza(id).length === 0) && Date.now() < fin) {
      await new Promise((listo) => setTimeout(listo, 20));
    }
    const spans = ids.flatMap((id) => recolector.deTraza(id));
    expect(spans.length).toBeGreaterThanOrEqual(8);

    // Las plantillas con nombre, en spans, métricas y líneas de acceso
    const nombres = spans.map((s) => s.nombre);
    for (const plantilla of [
      'POST /flights/v1/kiosk/lookup',
      'POST /flights/v1/kiosk/bookings/{bookingId}/check-in',
      'GET /flights/v1/kiosk/bookings/{bookingId}/boarding-passes',
      'GET /flights/v1/airports/{iataCode}/departures',
    ]) {
      expect(nombres).toContain(plantilla);
    }
    const accesos = gateway.registros().filter((r) => r.msg === 'acceso');
    expect(accesos.map((a) => a.ruta)).toEqual(
      expect.arrayContaining([
        '/flights/v1/kiosk/lookup',
        '/flights/v1/kiosk/bookings/{bookingId}/check-in',
        '/flights/v1/kiosk/bookings/{bookingId}/boarding-passes',
        '/flights/v1/airports/{iataCode}/departures',
      ]),
    );
    const metricas = await gateway.textoMetricas();
    expect(metricas).toContain('route="/flights/v1/kiosk/bookings/{bookingId}/check-in"');

    const emitido = [...recolector.cuerpos, ...gateway.logs, metricas, ...respuestas].join('\n');
    for (const prohibido of [
      pnr,
      apellido,
      encodeURIComponent(apellido),
      reserva,
      sesion,
      sesion.slice(6),
      'Kiosk',
      'UIO',
    ]) {
      expect(emitido).not.toContain(prohibido);
    }
    expect(emitido).not.toMatch(/authorization/i);
    expect(emitido).not.toContain('lastName');
  });
});
