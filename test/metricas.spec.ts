import { CUBETAS_DURACION } from '../src/observabilidad/metricas';
import { GatewayDePrueba, Servicios } from './utils/gateway';

const RESERVA = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

/** Las series de una métrica como { etiquetas: valor }. */
function series(texto: string, nombre: string): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const linea of texto.split('\n')) {
    if (!linea.startsWith(`${nombre}{`) && !linea.startsWith(`${nombre} `)) continue;
    const espacio = linea.lastIndexOf(' ');
    mapa.set(linea.slice(nombre.length, espacio), Number(linea.slice(espacio + 1)));
  }
  return mapa;
}

describe('métricas', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = await new GatewayDePrueba(servicios, {
      RATE_LIMIT_STRICT_MAX: '1',
      UPSTREAM_NOTIFIER_URL: 'http://127.0.0.1:9',
    }).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });
  beforeEach(() => servicios.reiniciar());

  it('contadores e histogramas tras una secuencia de peticiones', async () => {
    const token = await gateway.token({ scope: 'flights:read' });
    for (const id of [RESERVA, 'e8b5a51d-11c4-4e2a-9d5f-111111111111']) {
      await gateway.pedir({
        ruta: `/flights/v1/bookings/${id}`,
        cabeceras: { authorization: `Bearer ${token}` },
      });
    }
    await gateway.pedir({ metodo: 'POST', ruta: '/graphql', cuerpo: '{}' });

    const texto = await gateway.textoMetricas();
    const reservas = '{method="GET",route="/flights/v1/bookings/{bookingId}",status="200"}';
    expect(series(texto, 'http_server_requests_total').get(reservas)).toBe(2);
    expect(series(texto, 'http_server_request_duration_seconds_count').get(reservas)).toBe(2);
    expect(
      series(texto, 'http_server_requests_total').get(
        '{method="POST",route="/graphql",status="200"}',
      ),
    ).toBe(1);

    // Las cubetas son las del estándar (5 ms a 60 s) y acumulan
    const cubetas = [...series(texto, 'http_server_request_duration_seconds_bucket').entries()]
      .filter(([etiquetas]) => etiquetas.includes('route="/flights/v1/bookings/{bookingId}"'))
      .map(([etiquetas, valor]) => [/le="([^"]+)"/.exec(etiquetas)?.[1], valor]);
    expect(cubetas.map(([le]) => le)).toEqual([...CUBETAS_DURACION.map(String), '+Inf']);
    expect(cubetas.at(-1)?.[1]).toBe(2);
    expect(cubetas.map(([, v]) => v)).toEqual(
      [...cubetas.map(([, v]) => v)].sort((a, b) => Number(a) - Number(b)),
    );

    // Cliente: por upstream, método y status
    expect(
      series(texto, 'http_client_request_duration_seconds_count').get(
        '{upstream="core",method="GET",status="200"}',
      ),
    ).toBe(2);
    expect(
      series(texto, 'http_client_request_duration_seconds_count').get(
        '{upstream="bff",method="POST",status="200"}',
      ),
    ).toBe(1);

    expect(texto).toMatch(
      /quinde_build_info\{service="quinde-gateway",version="0\.1\.0",environment="development"\} 1/,
    );
    // Las métricas por defecto del proceso
    expect(texto).toContain('process_cpu_seconds_total');
    expect(texto).toContain('nodejs_eventloop_lag_seconds');
  });

  it('1000 rutas distintas son una sola serie (__unmatched__ o la plantilla)', async () => {
    for (let i = 0; i < 1000; i++) {
      await gateway.pedir({ ruta: `/ruta-inventada-${i}/ana${i}@example.com` });
    }
    const texto = await gateway.textoMetricas();
    const sinPlantilla = [...series(texto, 'http_server_requests_total').keys()].filter((k) =>
      k.includes('__unmatched__'),
    );
    expect(sinPlantilla).toEqual(['{method="GET",route="__unmatched__",status="404"}']);
    expect(
      series(texto, 'http_server_requests_total').get(sinPlantilla[0]!),
    ).toBeGreaterThanOrEqual(1000);
    expect(texto).not.toContain('ruta-inventada');

    // Una plantilla con miles de ids sigue siendo una serie
    const rutas = new Set(
      [...series(texto, 'http_server_requests_total').keys()].map(
        (k) => /route="([^"]+)"/.exec(k)?.[1],
      ),
    );
    expect(rutas.size).toBeLessThan(10);
  });

  it('/metrics en el puerto aparte; en el principal, 404 sin tocar un upstream', async () => {
    for (const ruta of ['/metrics', '/metrics/', '/METRICS', '/metrics/extra', '/%6detrics']) {
      const principal = await gateway.pedir({ ruta });
      expect(principal.status).toBe(404);
      expect(principal.texto).not.toContain('http_server_requests_total');
    }
    expect(servicios.totalIniciadas()).toBe(0);

    const propio = await gateway.textoMetricas();
    expect(propio).toContain('# TYPE http_server_requests_total counter');
    const { pedir } = await import('./utils/http-crudo');
    expect((await pedir(gateway.baseMetricas, { ruta: '/otra' })).status).toBe(404);
    expect((await pedir(gateway.baseMetricas, { ruta: '/metrics', metodo: 'POST' })).status).toBe(
      404,
    );
  });

  it('las del borde: límites, rechazos de auth y errores de upstream', async () => {
    const pedirLogin = () =>
      gateway.pedir({ metodo: 'POST', ruta: '/identity/v1/auth/login', cuerpo: '{}' });
    await pedirLogin();
    expect((await pedirLogin()).status).toBe(429);

    await gateway.pedir({ ruta: '/flights/v1/bookings' });
    await gateway.pedir({
      ruta: '/flights/v1/bookings',
      cabeceras: { authorization: 'Bearer x.y.z' },
    });
    const sinScope = await gateway.token({ scope: 'flights:read' });
    await gateway.pedir({
      ruta: '/flights/v1/webhooks',
      cabeceras: { authorization: `Bearer ${sinScope}` },
    });
    const vencido = await gateway.token({ scope: 'flights:read', expiraEn: -60 });
    await gateway.pedir({
      ruta: '/flights/v1/bookings',
      cabeceras: { authorization: `Bearer ${vencido}` },
    });
    const conScope = await gateway.token({ scope: 'flights:webhooks' });
    const caido = await gateway.pedir({
      ruta: '/flights/v1/webhooks',
      cabeceras: { authorization: `Bearer ${conScope}` },
    });
    expect(caido.status).toBe(502);

    expect(await gateway.valorMetrica('gateway_rate_limited_total{policy="estricto"}')).toBe(1);
    for (const motivo of [
      'missing_token',
      'invalid_token',
      'insufficient_scope',
      'expired_token',
    ]) {
      expect(
        await gateway.valorMetrica(`gateway_auth_rejections_total{reason="${motivo}"}`),
      ).toBeGreaterThanOrEqual(1);
    }
    expect(
      await gateway.valorMetrica(
        'gateway_upstream_errors_total{upstream="notifier",kind="unavailable"}',
      ),
    ).toBe(1);
    expect(
      await gateway.valorMetrica(
        'http_client_request_duration_seconds_count{upstream="notifier",method="GET",status="error"}',
      ),
    ).toBe(1);
  });

  it('ninguna etiqueta lleva valores sensibles', async () => {
    const token = await gateway.token({ scope: 'flights:read' });
    await gateway.pedir({
      ruta: `/flights/v1/bookings/${RESERVA}?email=ana%40example.com&token=${token}`,
      cabeceras: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.9' },
    });
    const texto = await gateway.textoMetricas();
    for (const prohibido of [
      token,
      RESERVA,
      'ana',
      'example.com',
      '203.0.113.9',
      '127.0.0.1',
      '?',
    ]) {
      expect(texto).not.toContain(prohibido);
    }
    // Ninguna etiqueta tiene un uuid ni un correo
    const etiquetas = texto
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n');
    expect(etiquetas).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(etiquetas).not.toMatch(/@/);
  });
});
