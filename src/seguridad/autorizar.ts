import { ErrorBorde } from '../common/problema';
import { SeguridadEfectiva } from '../rutas/resolver-ruta';
import { JwksNoDisponibleError } from './claves-jwks';
import { IdentidadToken, TokenInvalidoError, VerificadorJwks } from './verificador-jwks';

/**
 * `realm` de WWW-Authenticate (RFC 6750): el del core y el notifier. Los tokens son los mismos
 * (mismo `aud`), así que un 401 del borde se lee igual que uno del servicio.
 */
export const REALM = 'quinde-vuelos-api';

/** `Bearer <token>`; el esquema no distingue mayúsculas (RFC 7235). El del core y el notifier. */
const CABECERA_BEARER = /^Bearer[ ]+([A-Za-z0-9._~+/-]+=*)[ ]*$/i;

type ErrorBearer = 'invalid_token' | 'insufficient_scope';

/** Sin `error` es la respuesta a una petición sin credenciales (RFC 6750, sección 3.1). */
export function desafioBearer(
  error?: ErrorBearer,
  descripcion?: string,
  scopes?: readonly string[],
): string {
  const partes = [`realm="${REALM}"`];
  if (error) partes.push(`error="${error}"`);
  if (descripcion) partes.push(`error_description="${descripcion}"`);
  if (scopes && scopes.length > 0) partes.push(`scope="${scopes.join(' ')}"`);
  return `Bearer ${partes.join(', ')}`;
}

/**
 * Aplica la seguridad de la ruta en el borde. Una ruta pública no se mira (el Authorization pasa
 * intacto y el servicio decide). Una que exige token:
 *
 * - sin `Authorization: Bearer ...` → 401 con `WWW-Authenticate: Bearer realm=...`
 * - token vencido, mal firmado, `alg` distinto de RS256, de otro `iss` o `aud`, `kid`
 *   desconocido → 401 con `error="invalid_token"`
 * - sin claves con qué verificar (identity caído y sin copia vigente del JWKS) → 503
 *   AUTH_UNAVAILABLE con Retry-After. Nunca 401 ni dejar pasar.
 * - sin los scopes de ninguna alternativa → 403 con `error="insufficient_scope"`
 *
 * Devuelve la identidad solo para el log de decisión (sin datos personales: nada se registra
 * de ella). El gateway no la reenvía: nada de X-User-*; el servicio vuelve a verificar el token.
 */
export async function autorizar(
  seguridad: SeguridadEfectiva,
  authorization: string | undefined,
  verificador: VerificadorJwks,
): Promise<IdentidadToken | undefined> {
  if (seguridad.modo === 'publica') return undefined;

  const coincidencia = CABECERA_BEARER.exec(authorization ?? '');
  const token = coincidencia?.[1];
  if (token === undefined) {
    throw new ErrorBorde(401, 'A bearer access token is required', {
      motivo: 'missing_token',
      cabeceras: { 'WWW-Authenticate': desafioBearer() },
    });
  }

  let identidad: IdentidadToken;
  try {
    identidad = await verificador.verificar(token);
  } catch (error) {
    if (error instanceof JwksNoDisponibleError) {
      throw new ErrorBorde(
        503,
        'The identity service is not available to verify the access token; retry later',
        {
          codigo: 'AUTH_UNAVAILABLE',
          motivo: 'jwks_unavailable',
          cabeceras: { 'Retry-After': String(error.reintentarEnSegundos) },
        },
      );
    }
    if (error instanceof TokenInvalidoError) {
      throw new ErrorBorde(401, error.message, {
        motivo: error.motivo === 'expirado' ? 'expired_token' : 'invalid_token',
        cabeceras: { 'WWW-Authenticate': desafioBearer('invalid_token', error.message) },
      });
    }
    throw error;
  }

  const { alternativas } = seguridad;
  const cumple = alternativas.some((scopes) => scopes.every((s) => identidad.scopes.includes(s)));
  if (!cumple) {
    // Con una sola alternativa (siempre, hoy) se dice cuáles faltan, como el ScopesGuard del core
    const requeridos = alternativas[0] ?? [];
    const faltantes = requeridos.filter((s) => !identidad.scopes.includes(s));
    const detalle = `Missing required scopes: ${faltantes.join(' ')}`;
    throw new ErrorBorde(403, detalle, {
      motivo: 'insufficient_scope',
      cabeceras: { 'WWW-Authenticate': desafioBearer('insufficient_scope', detalle, requeridos) },
    });
  }
  return identidad;
}
