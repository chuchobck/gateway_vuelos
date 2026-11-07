import { ErrorEntorno, leerEntorno } from '../src/config/entorno';

const BASE = {
  UPSTREAM_CORE_URL: 'http://core.interno:3000',
  UPSTREAM_BFF_URL: 'http://bff.interno:4000',
  UPSTREAM_IDENTITY_URL: 'http://identity.interno:3001',
  UPSTREAM_NOTIFIER_URL: 'http://notifier.interno:3002',
  JWT_ISSUER: 'https://api.quinde.example',
};

function errores(variables: Record<string, string>): string[] {
  try {
    leerEntorno(variables);
  } catch (error) {
    if (error instanceof ErrorEntorno) return error.errores;
    throw error;
  }
  return [];
}

describe('entorno', () => {
  it('con lo mínimo arranca con los valores por defecto', () => {
    const c = leerEntorno(BASE);
    expect(c.puerto).toBe(8080);
    expect(c.saltosProxy).toBe(0);
    expect(c.jwt).toEqual({
      emisor: 'https://api.quinde.example',
      audiencia: 'quinde-vuelos-api',
      // Por la red interna, no por el origen público
      jwksUrl: 'http://identity.interno:3001/.well-known/jwks.json',
    });
    expect(c.upstreams.core.plazoMs).toBe(45_000);
    expect(c.upstreams.bff.plazoMs).toBe(50_000);
    expect(c.upstreams.identity.plazoMs).toBe(10_000);
    expect(c.upstreams.notifier.plazoMs).toBe(10_000);
    expect(c.limites).toEqual({
      ventanaSegundos: 60,
      global: 300,
      estrictoVentanaSegundos: 60,
      estricto: 20,
    });
  });

  it('sin las obligatorias: un error por variable', () => {
    expect(errores({})).toEqual([
      'UPSTREAM_CORE_URL es obligatoria',
      'UPSTREAM_BFF_URL es obligatoria',
      'UPSTREAM_IDENTITY_URL es obligatoria',
      'UPSTREAM_NOTIFIER_URL es obligatoria',
      'JWT_ISSUER es obligatoria',
    ]);
  });

  it('un error nombra la variable, nunca su valor', () => {
    const secreto = 'https://usuario:clave-super-secreta@core.interno/ruta?token=abc';
    const lista = errores({
      ...BASE,
      UPSTREAM_CORE_URL: secreto,
      JWKS_URL: 'ftp://clave-super-secreta',
      CORS_ORIGINS: '*,https://ok.example',
      TRUST_PROXY_HOPS: 'true',
      PORT: '99999',
      RATE_LIMIT_MAX: '-1',
      TIMEOUT_CORE_MS: 'mucho',
      LOG_LEVEL: 'ruidoso',
    });
    expect(lista).toHaveLength(8);
    for (const nombre of [
      'UPSTREAM_CORE_URL',
      'JWKS_URL',
      'CORS_ORIGINS',
      'TRUST_PROXY_HOPS',
      'PORT',
      'RATE_LIMIT_MAX',
      'TIMEOUT_CORE_MS',
      'LOG_LEVEL',
    ]) {
      expect(lista.some((e) => e.startsWith(nombre))).toBe(true);
    }
    const todo = lista.join('\n');
    expect(todo).not.toContain('clave-super-secreta');
    expect(todo).not.toContain('99999');
    expect(todo).not.toContain('mucho');
    expect(todo).not.toContain('ruidoso');
  });

  it('en producción JWT_ISSUER es https', () => {
    expect(
      errores({ ...BASE, NODE_ENV: 'production', JWT_ISSUER: 'http://api.quinde.example' }),
    ).toEqual(['JWT_ISSUER debe ser https en producción']);
  });

  it('JWT_ISSUER con ruta o barra final no sirve (iss se compara texto a texto)', () => {
    expect(errores({ ...BASE, JWT_ISSUER: 'https://api.quinde.example/' })).toEqual([
      'JWT_ISSUER debe ser un origen http(s) sin ruta',
    ]);
  });

  it('TRUST_PROXY_HOPS de 0 a 10', () => {
    expect(leerEntorno({ ...BASE, TRUST_PROXY_HOPS: '1' }).saltosProxy).toBe(1);
    expect(errores({ ...BASE, TRUST_PROXY_HOPS: '11' })).toHaveLength(1);
  });

  describe('puente de eventos (RABBITMQ_URL)', () => {
    const URL_BROKER = 'amqp://quinde:clave-super-secreta@127.0.0.1:5672';

    it('sin RABBITMQ_URL no hay puente y EVENTOS_* se ignoran', () => {
      expect(leerEntorno(BASE).eventos).toBeUndefined();
      expect(leerEntorno({ ...BASE, EVENTOS_PUERTO: '9470' }).eventos).toBeUndefined();
    });

    it('con RABBITMQ_URL y EVENTOS_PUERTO: el exchange vuelos.eventos por defecto', () => {
      expect(
        leerEntorno({ ...BASE, RABBITMQ_URL: URL_BROKER, EVENTOS_PUERTO: '9470' }).eventos,
      ).toEqual({ rabbitmqUrl: URL_BROKER, puerto: 9470, exchange: 'vuelos.eventos' });
      expect(
        leerEntorno({
          ...BASE,
          RABBITMQ_URL: 'amqps://broker.interno:5671/quinde',
          EVENTOS_PUERTO: '9470',
          EVENTOS_EXCHANGE: 'otro.exchange',
        }).eventos,
      ).toMatchObject({ exchange: 'otro.exchange' });
    });

    it('EVENTOS_PUERTO es obligatoria con RABBITMQ_URL, y distinta de PORT y METRICS_PORT', () => {
      expect(errores({ ...BASE, RABBITMQ_URL: URL_BROKER })).toEqual([
        'EVENTOS_PUERTO es obligatoria con RABBITMQ_URL',
      ]);
      expect(errores({ ...BASE, RABBITMQ_URL: URL_BROKER, EVENTOS_PUERTO: '8080' })).toEqual([
        'EVENTOS_PUERTO debe ser distinto de PORT y de METRICS_PORT',
      ]);
      expect(errores({ ...BASE, RABBITMQ_URL: URL_BROKER, EVENTOS_PUERTO: '9464' })).toEqual([
        'EVENTOS_PUERTO debe ser distinto de PORT y de METRICS_PORT',
      ]);
      expect(errores({ ...BASE, RABBITMQ_URL: URL_BROKER, EVENTOS_PUERTO: '0' })).toHaveLength(1);
    });

    it('una URL que no es amqp(s) o un exchange raro no sirve, y el error no trae el valor', () => {
      const lista = errores({
        ...BASE,
        RABBITMQ_URL: 'http://usuario:clave-super-secreta@127.0.0.1:5672',
        EVENTOS_PUERTO: '9470',
        EVENTOS_EXCHANGE: 'con espacio/clave-super-secreta',
      });
      expect(lista).toEqual([
        'EVENTOS_EXCHANGE debe usar solo letras, dígitos, punto, guion y guion bajo',
        'RABBITMQ_URL debe ser una URL amqp:// o amqps://',
      ]);
      expect(lista.join('\n')).not.toContain('clave-super-secreta');
    });
  });
});
