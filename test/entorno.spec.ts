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
});
