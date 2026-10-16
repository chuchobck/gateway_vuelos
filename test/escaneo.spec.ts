import { GatewayDePrueba, Servicios, TODOS_LOS_SCOPES } from './utils/gateway';

/**
 * Escaneo: después de un recorrido con tokens válidos, inválidos y vencidos, secretos en la query y
 * en el cuerpo, ni los logs ni las respuestas del gateway contienen un token, un Authorization, un
 * secreto ni la query.
 */
describe('escaneo de logs y respuestas', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;
  const respuestas: string[] = [];
  const secretos: string[] = [];

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = await new GatewayDePrueba(servicios, { LOG_LEVEL: 'trace' }).iniciar();
    // Los servicios falsos no devuelven nada de lo que reciben: lo que se escanea es del gateway
    for (const upstream of Object.values(servicios.upstreams)) {
      upstream.manejador = (_p, r) =>
        r.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    }

    const valido = await gateway.token({ scope: TODOS_LOS_SCOPES });
    const sinScope = await gateway.token({ scope: 'flights:read' });
    const vencido = await gateway.token({ scope: TODOS_LOS_SCOPES, expiraEn: -3600 });
    const otroKid = await gateway.token({ scope: TODOS_LOS_SCOPES, kid: 'kid-inventado' });
    const clienteSecreto = 'cs_supersecreto_9f8e7d6c5b4a';
    const contrasena = 'Contrasena-Muy-Secreta-2026!';
    secretos.push(valido, sinScope, vencido, otroKid, clienteSecreto, contrasena);
    // La firma sola tampoco puede aparecer
    secretos.push(...[valido, vencido].map((t) => t.split('.')[2] as string));

    const recorrido = [
      { ruta: '/flights/v1/bookings', cabeceras: { authorization: `Bearer ${valido}` } },
      { ruta: '/flights/v1/bookings', cabeceras: { authorization: `Bearer ${vencido}` } },
      { ruta: '/flights/v1/bookings', cabeceras: { authorization: `Bearer ${otroKid}` } },
      { ruta: '/flights/v1/webhooks', cabeceras: { authorization: `Bearer ${sinScope}` } },
      { ruta: '/flights/v1/bookings', cabeceras: { authorization: `Basic ${clienteSecreto}` } },
      { ruta: `/flights/v1/bookings?access_token=${valido}`, cabeceras: {} },
      {
        ruta: `/graphql?token=${valido}&client_secret=${clienteSecreto}`,
        metodo: 'POST',
        cuerpo: '{}',
      },
      {
        ruta: `/internal/v1/events?access_token=${valido}`,
        cabeceras: { authorization: `Bearer ${valido}` },
      },
      { ruta: `/no-existe?password=${contrasena}`, cabeceras: {} },
      { ruta: `/flights/v1/%2e%2e?t=${valido}`, cabeceras: {} },
      {
        ruta: '/oauth2/token',
        metodo: 'POST',
        cabeceras: { 'content-type': 'application/x-www-form-urlencoded' },
        cuerpo: `grant_type=client_credentials&client_id=core-vuelos&client_secret=${clienteSecreto}`,
      },
      {
        ruta: '/identity/v1/auth/login',
        metodo: 'POST',
        cabeceras: { 'content-type': 'application/json' },
        cuerpo: JSON.stringify({ email: 'ana@e2e.quinde.example', password: contrasena }),
      },
    ];
    for (const paso of recorrido) {
      const r = await gateway.pedir({ metodo: 'GET', cabeceras: {}, ...paso });
      respuestas.push(JSON.stringify(r.cabeceras), r.texto);
    }

    // Un fallo de upstream y un JWKS caído también pasan por el escaneo
    servicios.upstreams.core.manejador = (p) => p.socket.destroy();
    const r1 = await gateway.pedir({
      ruta: `/flights/v1/flights/QN1/status?x=${valido}`,
      cabeceras: { authorization: `Bearer ${valido}` },
    });
    respuestas.push(JSON.stringify(r1.cabeceras), r1.texto);
  });

  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });

  it('el recorrido dejó logs de acceso (el escaneo mira algo)', () => {
    const accesos = gateway.registros().filter((r) => r.msg === 'acceso');
    expect(accesos.length).toBeGreaterThanOrEqual(12);
    // La línea de acceso: requestId, método, ruta SIN query, upstream, status y ms
    for (const acceso of accesos) {
      expect(Object.keys(acceso)).toEqual(
        expect.arrayContaining(['requestId', 'metodo', 'ruta', 'upstream', 'status', 'ms']),
      );
      expect(String(acceso.ruta)).not.toContain('?');
    }
  });

  it('los logs no contienen tokens, Authorization, secretos ni la query', () => {
    const logs = gateway.logs.join('\n');
    for (const secreto of secretos) expect(logs).not.toContain(secreto);
    expect(logs).not.toMatch(/bearer\s/i);
    expect(logs).not.toMatch(/authorization/i);
    expect(logs).not.toMatch(/access_token|client_secret|password=/);
    expect(logs).not.toMatch(/ana@e2e/);
    expect(logs).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // nada con forma de JWT
  });

  it('las respuestas del gateway no devuelven tokens ni secretos', () => {
    const todo = respuestas.join('\n');
    for (const secreto of secretos) expect(todo).not.toContain(secreto);
    expect(todo).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});
