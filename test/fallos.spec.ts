import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { GatewayDePrueba, Servicios } from './utils/gateway';

/** Un puerto donde no escucha nadie: conexión rechazada. */
async function puertoCerrado(): Promise<number> {
  const servidor = createServer();
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const { port } = servidor.address() as AddressInfo;
  await new Promise<void>((listo) => servidor.close(() => listo()));
  return port;
}

/** Lo que nunca puede aparecer en una respuesta: URLs internas, puertos, mensajes de red. */
function sinFugas(texto: string, puertos: number[]): void {
  expect(texto).not.toMatch(/127\.0\.0\.1|localhost|ECONNREFUSED|ECONNRESET|socket hang up/i);
  for (const puerto of puertos) expect(texto).not.toContain(String(puerto));
  expect(texto).not.toMatch(/at \w+ \(|node:internal/);
}

describe('fallos del upstream', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;
  let cerrado: number;

  beforeAll(async () => {
    await servicios.iniciar();
    cerrado = await puertoCerrado();
    gateway = await new GatewayDePrueba(servicios, {
      UPSTREAM_NOTIFIER_URL: `http://127.0.0.1:${cerrado}`,
      TIMEOUT_BFF_MS: '500',
    }).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });
  beforeEach(() => servicios.reiniciar());

  it('upstream caído → 502 ProblemDetails, sin su URL ni su mensaje', async () => {
    const token = await gateway.token({ scope: 'flights:webhooks' });
    const respuesta = await gateway.pedir({
      ruta: '/flights/v1/webhooks',
      cabeceras: { authorization: `Bearer ${token}` },
    });
    expect(respuesta.status).toBe(502);
    expect(respuesta.json()).toEqual({
      type: 'https://api.booking-hub.com/errors/validation-failed',
      title: 'Bad Gateway',
      status: 502,
      detail: 'The upstream service is not available',
      code: 'VALIDATION_FAILED',
    });
    expect(respuesta.cabeceras['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    sinFugas(respuesta.texto + JSON.stringify(respuesta.cabeceras), [cerrado]);
    // El log dice qué upstream y el código de red, nunca la URL
    const fallo = gateway.registros().find((r) => r.msg === 'Fallo del upstream');
    expect(fallo).toMatchObject({ upstream: 'notifier', tipo: 'caido', codigo: 'ECONNREFUSED' });
    expect(gateway.logs.join('\n')).not.toContain(String(cerrado));
  });

  it('upstream lento → 504 al pasar su plazo', async () => {
    servicios.upstreams.bff.manejador = (_p, r) => {
      setTimeout(() => r.writeHead(200).end('{}'), 1500);
    };
    const inicio = Date.now();
    const respuesta = await gateway.pedir({ metodo: 'POST', ruta: '/graphql', cuerpo: '{}' });
    expect(respuesta.status).toBe(504);
    expect(respuesta.json()).toMatchObject({
      status: 504,
      title: 'Gateway Timeout',
      detail: 'The upstream service did not respond in time',
    });
    expect(Date.now() - inicio).toBeLessThan(1400);
    sinFugas(respuesta.texto, []);
  });

  it('503 del upstream con Retry-After pasa tal cual', async () => {
    servicios.upstreams.core.manejador = (_p, r) => {
      r.writeHead(503, { 'content-type': 'application/problem+json', 'retry-after': '42' });
      r.end('{"status":503,"code":"AUTH_UNAVAILABLE"}');
    };
    const respuesta = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
    expect(respuesta.status).toBe(503);
    expect(respuesta.cabeceras['retry-after']).toBe('42');
    expect(respuesta.texto).toBe('{"status":503,"code":"AUTH_UNAVAILABLE"}');
  });

  it('un corte a mitad de la conexión → 502, y un POST NUNCA se reintenta', async () => {
    servicios.upstreams.core.manejador = (peticion) => peticion.socket.destroy();
    const token = await gateway.token({ scope: 'flights:book' });
    const respuesta = await gateway.pedir({
      metodo: 'POST',
      ruta: '/flights/v1/bookings',
      cabeceras: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '0f8fad5b-d9cb-469f-a165-70867728950e',
      },
      cuerpo: '{"holdId":"x"}',
    });
    expect(respuesta.status).toBe(502);
    expect(servicios.upstreams.core.recibidas).toHaveLength(1);
    sinFugas(respuesta.texto, []);
  });

  it('tampoco se reintenta un GET', async () => {
    servicios.upstreams.core.manejador = (peticion) => peticion.socket.destroy();
    const respuesta = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
    expect(respuesta.status).toBe(502);
    expect(servicios.upstreams.core.recibidas).toHaveLength(1);
  });

  it('un 500 del upstream llega como lo mandó el servicio (ya sanitizado allá)', async () => {
    servicios.upstreams.core.manejador = (_p, r) => {
      r.writeHead(500, { 'content-type': 'application/problem+json' });
      r.end('{"status":500,"title":"Internal Server Error"}');
    };
    const respuesta = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
    expect(respuesta.status).toBe(500);
    expect(respuesta.json()).toEqual({ status: 500, title: 'Internal Server Error' });
  });

  it('un host que no resuelve → 502 sin el nombre del host', async () => {
    const otro = await new GatewayDePrueba(servicios, {
      UPSTREAM_BFF_URL: 'http://servicio-interno-que-no-existe.invalid:4000',
    }).iniciar();
    try {
      const respuesta = await otro.pedir({ metodo: 'POST', ruta: '/graphql', cuerpo: '{}' });
      expect(respuesta.status).toBe(502);
      expect(respuesta.texto).not.toContain('servicio-interno');
      expect(otro.logs.join('\n')).not.toContain('servicio-interno');
    } finally {
      await otro.detener();
    }
  });
});

describe('servidor que acepta y nunca responde', () => {
  let mudo: Server;
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await servicios.iniciar();
    mudo = createServer(() => undefined);
    await new Promise<void>((listo) => mudo.listen(0, '127.0.0.1', listo));
    const { port } = mudo.address() as AddressInfo;
    gateway = await new GatewayDePrueba(servicios, {
      UPSTREAM_IDENTITY_URL: `http://127.0.0.1:${port}`,
      TIMEOUT_IDENTITY_MS: '600',
    }).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    mudo.closeAllConnections();
    await new Promise<void>((listo) => mudo.close(() => listo()));
    await servicios.detener();
  });

  it('504 con requestId', async () => {
    const respuesta = await gateway.pedir({ metodo: 'POST', ruta: '/oauth2/token', cuerpo: 'x' });
    expect(respuesta.status).toBe(504);
    expect(respuesta.cabeceras['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
