import { createHmac, createPublicKey, randomUUID } from 'node:crypto';
import { exportSPKI } from 'jose';
import { ContratoCore } from '../src/rutas/contrato-core';
import { AUDIENCIA, EMISOR } from './utils/identidad-falsa';
import { GatewayDePrueba, Servicios, TODOS_LOS_SCOPES } from './utils/gateway';

const base64url = (valor: unknown) =>
  Buffer.from(typeof valor === 'string' ? valor : JSON.stringify(valor)).toString('base64url');

/** Una instancia concreta de la plantilla del contrato (`{bookingId}` → un uuid). */
function rutaDe(plantilla: string): string {
  return plantilla.replace(/\{[^}]+\}/g, () => randomUUID());
}

const contrato = ContratoCore.leer();
const protegidas = contrato.operaciones.filter((o) => !o.publica);
const publicas = contrato.operaciones.filter((o) => o.publica);

/**
 * Seguridad en el borde para CADA operación con `security` del OpenAPI vendored del core: sin
 * token, con alg none, HS256 con la clave pública como secreto, vencido, iss y aud ajenos, kid
 * desconocido → 401; sin el scope → 403; válido → pasa con el Authorization intacto.
 */
describe('autenticación en el borde', () => {
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

  it('el contrato vendored tiene operaciones protegidas y públicas', () => {
    expect(protegidas.length).toBeGreaterThanOrEqual(19);
    expect(publicas.map((o) => `${o.metodo} ${o.plantilla}`).sort()).toEqual([
      'GET /flights/v1/flights/{flightNumber}/status',
      'GET /flights/v1/offers/{offerId}/seatmap',
      'POST /flights/v1/search',
    ]);
  });

  /** Lo que se espera de un rechazo en el borde: 401 Bearer y ningún upstream tocado. */
  async function esperar401(
    metodo: string,
    plantilla: string,
    authorization: string | undefined,
    error: 'invalid_token' | undefined,
  ) {
    const respuesta = await gateway.pedir({
      metodo,
      ruta: rutaDe(plantilla),
      cabeceras: {
        'content-type': 'application/json',
        ...(authorization === undefined ? {} : { authorization }),
      },
      ...(metodo === 'POST' ? { cuerpo: '{}' } : {}),
    });
    expect(respuesta.status).toBe(401);
    const desafio = String(respuesta.cabeceras['www-authenticate']);
    expect(desafio).toMatch(/^Bearer realm="quinde-vuelos-api"/);
    if (error) expect(desafio).toContain(`error="${error}"`);
    else expect(desafio).not.toContain('error=');
    expect(respuesta.json().status).toBe(401);
    expect(servicios.totalIniciadas()).toBe(0);
  }

  describe.each(protegidas.map((o) => [`${o.metodo} ${o.plantilla}`, o] as const))(
    '%s',
    (_nombre, operacion) => {
      const { metodo, plantilla } = operacion;
      const requeridos = operacion.alternativas[0] ?? [];

      it('sin token → 401', () => esperar401(metodo, plantilla, undefined, undefined));

      it('con otro esquema (Basic) → 401', () =>
        esperar401(metodo, plantilla, 'Basic dXN1YXJpbzpjbGF2ZQ==', undefined));

      it('alg none → 401', async () => {
        const sinFirma = `${base64url({ alg: 'none', typ: 'at+jwt', kid: servicios.identidad.kid })}.${base64url(
          {
            iss: EMISOR,
            aud: AUDIENCIA,
            sub: randomUUID(),
            jti: randomUUID(),
            scope: TODOS_LOS_SCOPES,
            iat: Math.floor(gateway.reloj.ahora().getTime() / 1000),
            exp: Math.floor(gateway.reloj.ahora().getTime() / 1000) + 900,
          },
        )}.`;
        await esperar401(metodo, plantilla, `Bearer ${sinFirma}`, 'invalid_token');
      });

      it('HS256 con la clave pública como secreto → 401', async () => {
        const pem = await exportSPKI(servicios.identidad.publica);
        const ahora = Math.floor(gateway.reloj.ahora().getTime() / 1000);
        const cabecera = base64url({ alg: 'HS256', typ: 'at+jwt', kid: servicios.identidad.kid });
        const cuerpo = base64url({
          iss: EMISOR,
          aud: AUDIENCIA,
          sub: randomUUID(),
          jti: randomUUID(),
          scope: TODOS_LOS_SCOPES,
          iat: ahora,
          exp: ahora + 900,
        });
        // La clave pública usada como secreto HMAC, el ataque clásico, en cada forma en que un
        // atacante la encuentra: PEM con y sin salto final (jose, node:crypto) y DER
        const publica = createPublicKey(pem);
        const formas = [
          pem.trimEnd(),
          `${pem.trimEnd()}\n`,
          publica.export({ type: 'spki', format: 'der' }),
        ];
        for (const secreto of formas) {
          const firma = createHmac('sha256', secreto).update(`${cabecera}.${cuerpo}`).digest();
          await esperar401(
            metodo,
            plantilla,
            `Bearer ${cabecera}.${cuerpo}.${firma.toString('base64url')}`,
            'invalid_token',
          );
        }
      });

      it('vencido (más de 30 s) → 401', async () => {
        const token = await gateway.token({ scope: TODOS_LOS_SCOPES, expiraEn: -31 });
        await esperar401(metodo, plantilla, `Bearer ${token}`, 'invalid_token');
      });

      it('iss ajeno → 401', async () => {
        const token = await gateway.token({
          scope: TODOS_LOS_SCOPES,
          iss: 'https://otro-identity.example',
        });
        await esperar401(metodo, plantilla, `Bearer ${token}`, 'invalid_token');
      });

      it('aud ajena → 401', async () => {
        const token = await gateway.token({ scope: TODOS_LOS_SCOPES, aud: 'otra-api' });
        await esperar401(metodo, plantilla, `Bearer ${token}`, 'invalid_token');
      });

      it('kid desconocido → 401', async () => {
        const token = await gateway.token({ scope: TODOS_LOS_SCOPES, kid: 'kid-inventado' });
        await esperar401(metodo, plantilla, `Bearer ${token}`, 'invalid_token');
      });

      it(`sin ${requeridos.join(' ')} → 403 insufficient_scope sin llamar al upstream`, async () => {
        const otros = TODOS_LOS_SCOPES.split(' ').filter((s) => !requeridos.includes(s));
        const token = await gateway.token({ scope: otros.join(' ') });
        const respuesta = await gateway.pedir({
          metodo,
          ruta: rutaDe(plantilla),
          cabeceras: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(metodo === 'POST' ? { cuerpo: '{}' } : {}),
        });
        expect(respuesta.status).toBe(403);
        expect(respuesta.cabeceras['www-authenticate']).toContain('error="insufficient_scope"');
        expect(respuesta.cabeceras['www-authenticate']).toContain(
          `scope="${requeridos.join(' ')}"`,
        );
        expect(respuesta.json().detail).toBe(`Missing required scopes: ${requeridos.join(' ')}`);
        expect(servicios.totalIniciadas()).toBe(0);
      });

      it('con el scope justo → pasa con el Authorization intacto', async () => {
        const token = await gateway.token({ scope: requeridos.join(' ') });
        const ruta = rutaDe(plantilla);
        const respuesta = await gateway.pedir({
          metodo,
          ruta,
          cabeceras: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(metodo === 'POST' ? { cuerpo: '{}' } : {}),
        });
        expect(respuesta.status).toBe(200);
        const destino = plantilla.startsWith('/flights/v1/webhooks') ? 'notifier' : 'core';
        const recibida = servicios.upstreams[destino].ultima();
        expect(recibida.url).toBe(ruta);
        expect(recibida.cabeceras.authorization).toBe(`Bearer ${token}`);
        // El gateway no inventa cabeceras de identidad
        expect(Object.keys(recibida.cabeceras).filter((c) => c.startsWith('x-user'))).toEqual([]);
      });
    },
  );

  it('exp dentro de los 30 s de tolerancia todavía pasa', async () => {
    const token = await gateway.token({ scope: 'flights:read', expiraEn: -20 });
    const respuesta = await gateway.pedir({
      ruta: '/flights/v1/bookings',
      cabeceras: { authorization: `Bearer ${token}` },
    });
    expect(respuesta.status).toBe(200);
  });

  it('typ distinto de at+jwt (un id token) → 401', async () => {
    const token = await gateway.token({ scope: 'flights:read', typ: 'JWT' });
    await esperar401('GET', '/flights/v1/bookings', `Bearer ${token}`, 'invalid_token');
  });

  it('firma de otra clave con el mismo kid → 401', async () => {
    const token = await gateway.token({ scope: 'flights:read' });
    const [cabecera, cuerpo] = token.split('.');
    const otra = await gateway.token({ scope: 'flights:read flights:admin' });
    const firmaAjena = otra.split('.')[2];
    await esperar401(
      'GET',
      '/flights/v1/bookings',
      `Bearer ${cabecera}.${cuerpo}.${firmaAjena}`,
      'invalid_token',
    );
  });

  describe('reglas fuera del contrato', () => {
    it.each([
      ['GET', '/identity/v1/admin/users', 'identity'],
      ['POST', '/identity/v1/admin/users', 'identity'],
      ['GET', '/flights/v1/admin/countries', 'core'],
      ['GET', '/flights/v1/admin/audit-log', 'core'],
    ])('%s %s exige flights:admin', async (metodo, ruta, destino) => {
      const persona = await gateway.token({
        scope: 'flights:read flights:hold flights:book flights:cancel flights:webhooks',
      });
      const sinAdmin = await gateway.pedir({
        metodo,
        ruta,
        cabeceras: { authorization: `Bearer ${persona}` },
      });
      expect(sinAdmin.status).toBe(403);
      expect(servicios.totalIniciadas()).toBe(0);

      const admin = await gateway.token({ scope: 'flights:admin' });
      const conAdmin = await gateway.pedir({
        metodo,
        ruta,
        cabeceras: { authorization: `Bearer ${admin}` },
      });
      expect(conAdmin.status).toBe(200);
      expect(servicios.upstreams[destino as 'core' | 'identity'].recibidas).toHaveLength(1);
    });

    it('un método o ruta de /flights/v1 que el contrato no declara exige un token válido', async () => {
      const sinToken = await gateway.pedir({ metodo: 'PUT', ruta: '/flights/v1/bookings' });
      expect(sinToken.status).toBe(401);
      const otra = await gateway.pedir({ ruta: '/flights/v1/no-existe' });
      expect(otra.status).toBe(401);
      expect(servicios.totalIniciadas()).toBe(0);

      const token = await gateway.token({ scope: '' });
      const conToken = await gateway.pedir({
        ruta: '/flights/v1/no-existe',
        cabeceras: { authorization: `Bearer ${token}` },
      });
      expect(conToken.status).toBe(200);
      expect(servicios.upstreams.core.recibidas).toHaveLength(1);
    });

    it('HEAD se trata como GET', async () => {
      const sinToken = await gateway.pedir({ metodo: 'HEAD', ruta: '/flights/v1/bookings' });
      expect(sinToken.status).toBe(401);
      const publica = await gateway.pedir({
        metodo: 'HEAD',
        ruta: '/flights/v1/flights/QN100/status',
      });
      expect(publica.status).toBe(200);
    });
  });

  describe('rutas públicas', () => {
    const casos: [string, string, string][] = [
      ...publicas.map((o) => [o.metodo, rutaDe(o.plantilla), 'core'] as [string, string, string]),
      ['POST', '/graphql', 'bff'],
      ['POST', '/identity/v1/auth/login', 'identity'],
      ['POST', '/identity/v1/auth/register', 'identity'],
      ['POST', '/identity/v1/auth/refresh', 'identity'],
      ['GET', '/identity/v1/auth/me', 'identity'],
      ['POST', '/oauth2/token', 'identity'],
      ['GET', '/.well-known/jwks.json', 'identity'],
    ];

    it.each(casos)(
      '%s %s: un token inválido pasa sin tocar (el servicio decide)',
      async (metodo, ruta, destino) => {
        const invalido = 'Bearer esto.no.es-un-token';
        const respuesta = await gateway.pedir({
          metodo,
          ruta,
          cabeceras: { authorization: invalido, 'content-type': 'application/json' },
          ...(metodo === 'POST' ? { cuerpo: '{}' } : {}),
        });
        expect(respuesta.status).toBe(200);
        const recibida = servicios.upstreams[destino as 'core'].ultima();
        expect(recibida.cabeceras.authorization).toBe(invalido);
      },
    );

    it('sin token también pasan', async () => {
      for (const [metodo, ruta] of casos) {
        const respuesta = await gateway.pedir({ metodo, ruta });
        expect(respuesta.status).toBe(200);
      }
      expect(servicios.totalRecibidas()).toBe(casos.length);
    });
  });

  describe('JWKS caído', () => {
    it('503 AUTH_UNAVAILABLE con Retry-After en rutas protegidas; las públicas siguen', async () => {
      // Un gateway nuevo: sin copia del JWKS
      const otro = await new GatewayDePrueba(servicios).iniciar();
      servicios.identidad.encendida = false;
      try {
        const token = await otro.token({ scope: TODOS_LOS_SCOPES });
        const protegida = await otro.pedir({
          ruta: '/flights/v1/bookings',
          cabeceras: { authorization: `Bearer ${token}` },
        });
        expect(protegida.status).toBe(503);
        expect(protegida.json().code).toBe('AUTH_UNAVAILABLE');
        expect(Number(protegida.cabeceras['retry-after'])).toBeGreaterThanOrEqual(1);

        const webhooks = await otro.pedir({
          ruta: '/flights/v1/webhooks',
          cabeceras: { authorization: `Bearer ${token}` },
        });
        expect(webhooks.status).toBe(503);
        expect(servicios.totalIniciadas()).toBe(0);

        // Sin token sigue siendo 401 (no hace falta el JWKS para saberlo)
        expect((await otro.pedir({ ruta: '/flights/v1/bookings' })).status).toBe(401);

        const publica = await otro.pedir({
          metodo: 'POST',
          ruta: '/flights/v1/search',
          cabeceras: { 'content-type': 'application/json' },
          cuerpo: '{}',
        });
        expect(publica.status).toBe(200);
        expect((await otro.pedir({ metodo: 'POST', ruta: '/graphql', cuerpo: '{}' })).status).toBe(
          200,
        );

        // Vuelve identity y pasa el enfriamiento: se recupera solo
        servicios.identidad.encendida = true;
        otro.reloj.adelantar(11_000);
        const recuperada = await otro.pedir({
          ruta: '/flights/v1/bookings',
          cabeceras: { authorization: `Bearer ${await otro.token({ scope: 'flights:read' })}` },
        });
        expect(recuperada.status).toBe(200);
      } finally {
        await otro.detener();
      }
    });

    it('con una copia vigente, un corte de identity no se nota', async () => {
      const otro = await new GatewayDePrueba(servicios).iniciar();
      try {
        const token = await otro.token({ scope: 'flights:read' });
        const pedir = () =>
          otro.pedir({
            ruta: '/flights/v1/bookings',
            cabeceras: { authorization: `Bearer ${token}` },
          });
        expect((await pedir()).status).toBe(200);
        servicios.identidad.encendida = false;
        expect((await pedir()).status).toBe(200);
      } finally {
        await otro.detener();
      }
    });

    it('kid desconocido: a lo sumo una descarga del JWKS por enfriamiento', async () => {
      const otro = await new GatewayDePrueba(servicios).iniciar();
      try {
        const valido = await otro.token({ scope: 'flights:read' });
        await otro.pedir({
          ruta: '/flights/v1/bookings',
          cabeceras: { authorization: `Bearer ${valido}` },
        });
        const antes = servicios.identidad.descargas;
        for (let i = 0; i < 5; i++) {
          const inventado = await otro.token({ scope: 'flights:read', kid: `kid-${i}` });
          const r = await otro.pedir({
            ruta: '/flights/v1/bookings',
            cabeceras: { authorization: `Bearer ${inventado}` },
          });
          expect(r.status).toBe(401);
        }
        expect(servicios.identidad.descargas - antes).toBeLessThanOrEqual(1);
      } finally {
        await otro.detener();
      }
    });
  });
});
