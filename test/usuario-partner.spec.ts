import { GatewayDePrueba, Servicios } from './utils/gateway';

const USUARIO = { 'x-user-id': 'booking-user-42', 'x-user-roles': 'customer' };

/**
 * X-User-Id y X-User-Roles (contrato v2): el usuario final que un partner dice atender. Solo pasan
 * con un token VÁLIDO de partner (claim client_id); sin token, con uno de persona y en toda ruta
 * pública el gateway los borra. Una persona no puede hacerse pasar por otra mandándolos.
 */
describe('X-User-* solo con token de partner', () => {
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

  async function llegaron(
    upstream: 'core' | 'notifier' | 'bff' | 'identity',
    pedido: Parameters<GatewayDePrueba['pedir']>[0],
  ) {
    const respuesta = await gateway.pedir(pedido);
    expect(respuesta.status).toBe(200);
    const recibida = servicios.upstreams[upstream].recibidas[0];
    expect(recibida).toBeDefined();
    return recibida!.cabeceras;
  }

  it('con token de partner pasan intactas (v2 protegida, al core)', async () => {
    const token = await gateway.token({ scope: 'flights:read', clientId: 'booking-prototipo' });
    const cabeceras = await llegaron('core', {
      ruta: '/api/v2/vuelos/bookings',
      cabeceras: { authorization: `Bearer ${token}`, ...USUARIO },
    });
    expect(cabeceras['x-user-id']).toBe('booking-user-42');
    expect(cabeceras['x-user-roles']).toBe('customer');
  });

  it('con token de partner pasan intactas también hacia el notifier', async () => {
    const token = await gateway.token({ scope: 'flights:webhooks', clientId: 'booking-prototipo' });
    const cabeceras = await llegaron('notifier', {
      ruta: '/api/v2/vuelos/webhooks',
      cabeceras: { authorization: `Bearer ${token}`, ...USUARIO },
    });
    expect(cabeceras['x-user-id']).toBe('booking-user-42');
  });

  it('con token de persona (sin client_id) se borran', async () => {
    const token = await gateway.token({ scope: 'flights:read' });
    const cabeceras = await llegaron('core', {
      ruta: '/api/v2/vuelos/bookings',
      cabeceras: { authorization: `Bearer ${token}`, ...USUARIO, 'x-user-email': 'a@b.example' },
    });
    expect(cabeceras['x-user-id']).toBeUndefined();
    expect(cabeceras['x-user-roles']).toBeUndefined();
    expect(cabeceras['x-user-email']).toBeUndefined();
    // Lo demás pasa igual
    expect(cabeceras.authorization).toBe(`Bearer ${token}`);
  });

  it('con token de persona en v1 también se borran', async () => {
    const token = await gateway.token({ scope: 'flights:read' });
    const cabeceras = await llegaron('core', {
      ruta: '/flights/v1/bookings',
      cabeceras: { authorization: `Bearer ${token}`, ...USUARIO },
    });
    expect(cabeceras['x-user-id']).toBeUndefined();
    expect(cabeceras['x-user-roles']).toBeUndefined();
  });

  it.each([
    ['core', 'POST', '/api/v2/vuelos/search'],
    ['core', 'GET', '/api/v2/vuelos/health'],
    ['core', 'GET', '/api/v2/vuelos/flights/EQ101/status'],
    ['core', 'POST', '/flights/v1/search'],
    ['bff', 'POST', '/graphql'],
    ['identity', 'POST', '/api/v2/oauth2/token'],
  ] as const)(
    'en la pública %s %s %s se borran aunque venga un token de partner válido',
    async (upstream, metodo, ruta) => {
      const token = await gateway.token({ scope: 'flights:read', clientId: 'booking-prototipo' });
      const cabeceras = await llegaron(upstream, {
        metodo,
        ruta,
        cabeceras: { authorization: `Bearer ${token}`, ...USUARIO },
      });
      expect(cabeceras['x-user-id']).toBeUndefined();
      expect(cabeceras['x-user-roles']).toBeUndefined();
    },
  );

  it('sin token en una pública se borran', async () => {
    const cabeceras = await llegaron('core', {
      metodo: 'POST',
      ruta: '/api/v2/vuelos/search',
      cabeceras: USUARIO,
    });
    expect(cabeceras['x-user-id']).toBeUndefined();
    expect(cabeceras['x-user-roles']).toBeUndefined();
  });

  it('un token de partner inválido no llega: 401 y nada pasa', async () => {
    const token = await gateway.token({
      scope: 'flights:read',
      clientId: 'booking-prototipo',
      iss: 'https://otro.example',
    });
    const respuesta = await gateway.pedir({
      ruta: '/api/v2/vuelos/bookings',
      cabeceras: { authorization: `Bearer ${token}`, ...USUARIO },
    });
    expect(respuesta.status).toBe(401);
    expect(servicios.totalIniciadas()).toBe(0);
  });
});
