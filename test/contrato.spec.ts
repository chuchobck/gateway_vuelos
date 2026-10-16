import { readFileSync } from 'node:fs';
import { filasDeRutas } from '../src/cli/listar-rutas';
import { ContratoCore, RUTA_CONTRATO } from '../src/rutas/contrato-core';
import { TABLA_RUTAS } from '../src/rutas/tabla-rutas';

/**
 * La tabla de scopes que el gateway saca del OpenAPI del core. Si el core cambia un scope, agrega
 * o quita una operación, `npm run contrato:sync` trae el YAML nuevo y ESTA prueba falla: alguien
 * tiene que mirar el cambio y actualizar la lista (y docs/RUTAS.md) a conciencia.
 */
const ESPERADA = [
  'POST /flights/v1/search → pública',
  'GET /flights/v1/offers/{offerId}/seatmap → pública',
  'POST /flights/v1/offers/hold → flights:hold',
  'GET /flights/v1/offers/hold/{holdId} → flights:read',
  'DELETE /flights/v1/offers/hold/{holdId} → flights:hold',
  'GET /flights/v1/bookings → flights:read',
  'POST /flights/v1/bookings → flights:book',
  'GET /flights/v1/bookings/{bookingId} → flights:read',
  'GET /flights/v1/bookings/{bookingId}/baggage-options → flights:read',
  'POST /flights/v1/bookings/{bookingId}/baggage → flights:book',
  'POST /flights/v1/bookings/{bookingId}/date-change/search → flights:read',
  'POST /flights/v1/bookings/{bookingId}/date-change → flights:book',
  'GET /flights/v1/bookings/{bookingId}/cancellation-quote → flights:read',
  'POST /flights/v1/bookings/{bookingId}/cancel → flights:cancel',
  'GET /flights/v1/webhooks → flights:webhooks',
  'POST /flights/v1/webhooks → flights:webhooks',
  'DELETE /flights/v1/webhooks/{id} → flights:webhooks',
  'GET /flights/v1/bookings/{bookingId}/tickets → flights:read',
  'GET /flights/v1/bookings/{bookingId}/tickets/{ticketId} → flights:read',
  'POST /flights/v1/bookings/{bookingId}/check-in → flights:book',
  'GET /flights/v1/bookings/{bookingId}/boarding-passes → flights:read',
  'GET /flights/v1/flights/{flightNumber}/status → pública',
];

describe('contrato del core', () => {
  const contrato = ContratoCore.leer();

  it('la tabla de scopes generada es la esperada (si el core la cambia, esto lo nota)', () => {
    const generada = contrato.operaciones.map(
      (o) =>
        `${o.metodo} ${o.plantilla} → ${o.publica ? 'pública' : o.alternativas.map((a) => a.join(' ')).join(' | ')}`,
    );
    expect(generada).toEqual(ESPERADA);
    expect(contrato.prefijo).toBe('/flights/v1');
    expect(contrato.version).toBe('1.5.0.0');
  });

  it('las reglas del notifier exigen lo mismo que el contrato declara para /webhooks', () => {
    const delContrato = new Set(
      contrato.operaciones
        .filter((o) => o.plantilla.startsWith('/flights/v1/webhooks'))
        .flatMap((o) => o.alternativas.flat()),
    );
    const delNotifier = TABLA_RUTAS.filter((r) => r.destino === 'notifier').map((r) =>
      r.seguridad.modo === 'token' ? r.seguridad.scopes.join(' ') : r.seguridad.modo,
    );
    expect([...delContrato]).toEqual(['flights:webhooks']);
    expect(delNotifier).toEqual(['flights:webhooks', 'flights:webhooks']);
  });

  it('rutas:listar muestra cada operación del contrato con su upstream', () => {
    const filas = filasDeRutas(contrato);
    for (const o of contrato.operaciones) {
      if (o.plantilla.startsWith('/flights/v1/webhooks')) continue; // van por la regla del notifier
      expect(filas).toContainEqual(
        expect.objectContaining({ ruta: o.plantilla, metodo: o.metodo, destino: 'core' }),
      );
    }
    expect(filas[0]).toMatchObject({ ruta: '/internal/**', seguridad: 'bloqueada' });
  });

  it('un contrato sin servers, sin paths o con security mal formado no arranca', () => {
    expect(() => ContratoCore.desdeTexto('openapi: 3.0.3\npaths: {}\n')).toThrow('servers');
    expect(() =>
      ContratoCore.desdeTexto('servers:\n  - url: https://x.example/flights/v1\n'),
    ).toThrow('paths');
    expect(() =>
      ContratoCore.desdeTexto(
        'servers:\n  - url: https://x.example/flights/v1\npaths:\n  /a:\n    get:\n      security: nope\n',
      ),
    ).toThrow('security');
  });

  it('distingue "sin token" (security: []) de "token sin scopes" (- OAuth2Security: [])', () => {
    const c = ContratoCore.desdeTexto(
      [
        'servers:',
        '  - url: https://x.example/api/v1',
        'security:',
        '  - OAuth2Security: [a:b]',
        'paths:',
        '  /libre:',
        '    get:',
        '      security: []',
        '  /token:',
        '    get:',
        '      security:',
        '        - OAuth2Security: []',
        '  /global:',
        '    get: {}',
      ].join('\n'),
    );
    expect(c.buscar('GET', '/api/v1/libre')?.publica).toBe(true);
    expect(c.buscar('GET', '/api/v1/token')).toMatchObject({ publica: false, alternativas: [[]] });
    expect(c.buscar('GET', '/api/v1/global')).toMatchObject({
      publica: false,
      alternativas: [['a:b']],
    });
  });

  it('la copia vendored no se edita a mano: es YAML del core con su cabecera', () => {
    const texto = readFileSync(RUTA_CONTRATO, 'utf8');
    expect(texto.startsWith('openapi: 3.0.3\n')).toBe(true);
    expect(texto).toContain('title: GDS Flight Core API');
  });
});
