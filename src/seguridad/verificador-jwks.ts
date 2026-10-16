import { CryptoKey, decodeProtectedHeader, errors, JWTHeaderParameters, jwtVerify } from 'jose';
import { Reloj } from '../common/reloj';
import { ClavesJwks, FORMATO_KID, JwksNoDisponibleError } from './claves-jwks';
import { Registro } from './registro';

/** Único algoritmo aceptado, fijado aquí: nunca se lee del token (ni `none` ni HS256). */
export const ALGORITMO_EXTERNO = 'RS256';

/** `typ` de un token de acceso JWT (RFC 9068, sección 2.1). */
export const TIPO_TOKEN_ACCESO = 'at+jwt';

/**
 * Diferencia de reloj tolerada con el servicio de identidad al mirar `exp` (y `nbf` si viene).
 * Pequeña a propósito: un token vencido vale a lo sumo 30 s más, y los dos servicios sincronizan
 * su hora (NTP).
 */
export const TOLERANCIA_RELOJ_SEGUNDOS = 30;

/** `client_id` de un cliente OAuth: lo que admite identity_vuelos (ck_cliente_oauth_codigo). */
const FORMATO_CLIENT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** `sub` de identity: siempre un uuid (usuario.id o cliente_oauth.id). */
const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que el borde saca de un token válido: solo para decidir; no se reenvía ni se registra. */
export interface IdentidadToken {
  sub: string;
  scopes: string[];
  jti: string;
  /** Solo en tokens de un cliente OAuth (client_credentials). */
  clienteId?: string;
}

export type MotivoTokenInvalido = 'expirado' | 'invalido';

/** El token no sirve: 401 en el borde. El mensaje no lleva el token. */
export class TokenInvalidoError extends Error {
  constructor(readonly motivo: MotivoTokenInvalido) {
    super(motivo === 'expirado' ? 'The access token expired' : 'The access token is invalid');
    this.name = 'TokenInvalidoError';
  }
}

/** Las condiciones que fija la configuración: iss y aud texto a texto. */
export interface ConfiguracionVerificador {
  emisor: string;
  audiencia: string;
}

/**
 * Verifica los tokens del servicio de identidad con su JWKS. Es el del notifier (fase 5a), que es
 * el del core (fase 4b): RS256 con la clave de su `kid`, cabecera `typ` at+jwt, `iss` igual a
 * JWT_ISSUER (texto a texto), `aud` con JWT_AUDIENCE, y `exp`, `iat`, `jti` y `sub` presentes;
 * `exp` con 30 s de tolerancia. Además: `sub` uuid, `scope` texto y, si viene, `client_id`.
 *
 * El gateway no recalcula ni filtra scopes: los compara con los que exige la ruta. El token,
 * válido o no, se reenvía intacto; el servicio lo vuelve a verificar (defensa en profundidad).
 *
 * Un rechazo deja en el log el `kid` y el motivo, nunca el token.
 */
export class VerificadorJwks {
  constructor(
    private readonly claves: ClavesJwks,
    private readonly config: ConfiguracionVerificador,
    private readonly reloj: Reloj,
    private readonly logger: Registro,
  ) {}

  async verificar(token: string): Promise<IdentidadToken> {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, (cabecera) => this.claveDe(cabecera), {
        algorithms: [ALGORITMO_EXTERNO],
        typ: TIPO_TOKEN_ACCESO,
        issuer: this.config.emisor,
        audience: this.config.audiencia,
        requiredClaims: ['exp', 'iat', 'jti', 'sub'],
        clockTolerance: TOLERANCIA_RELOJ_SEGUNDOS,
        currentDate: this.reloj.ahora(),
      }));
    } catch (error) {
      if (error instanceof JwksNoDisponibleError) throw error;
      throw this.rechazar(token, motivoDeJose(error));
    }

    const { sub, scope, jti, client_id: clientId } = payload;
    if (typeof sub !== 'string' || !FORMATO_UUID.test(sub))
      throw this.rechazar(token, 'sub-no-uuid');
    if (typeof scope !== 'string') throw this.rechazar(token, 'scope-no-texto');
    if (typeof jti !== 'string' || jti === '') throw this.rechazar(token, 'jti-invalido');
    if (
      clientId !== undefined &&
      (typeof clientId !== 'string' || !FORMATO_CLIENT_ID.test(clientId))
    ) {
      throw this.rechazar(token, 'client_id-invalido');
    }

    return {
      sub,
      scopes: scope.split(' ').filter((s) => s !== ''),
      jti,
      ...(typeof clientId === 'string' ? { clienteId: clientId } : {}),
    };
  }

  /** Sin `kid`, o con uno que el JWKS no tiene, no hay con qué verificar: 401. */
  private async claveDe(cabecera: JWTHeaderParameters): Promise<CryptoKey> {
    const kid = cabecera.kid;
    if (typeof kid !== 'string' || !FORMATO_KID.test(kid)) throw new errors.JWKSNoMatchingKey();
    const clave = await this.claves.clave(kid);
    if (clave === undefined) throw new errors.JWKSNoMatchingKey();
    return clave;
  }

  private rechazar(token: string, motivo: string): TokenInvalidoError {
    const kid = kidLegible(token);
    const linea = `Token rechazado: ${motivo} (kid ${kid})`;
    if (motivo === 'expirado') this.logger.debug(linea);
    else this.logger.warn(linea);
    const tipo: MotivoTokenInvalido = motivo === 'expirado' ? 'expirado' : 'invalido';
    return new TokenInvalidoError(tipo);
  }
}

/** El `kid` de la cabecera si se puede leer y es seguro escribirlo en el log. */
function kidLegible(token: string): string {
  try {
    const { kid } = decodeProtectedHeader(token);
    return typeof kid === 'string' && FORMATO_KID.test(kid) ? kid : '-';
  } catch {
    return '-';
  }
}

/** Un motivo corto y fijo por cada error de jose (alg-no-permitido, iss-check_failed...). */
function motivoDeJose(error: unknown): string {
  if (error instanceof errors.JWTExpired) return 'expirado';
  if (error instanceof errors.JWTClaimValidationFailed) return `${error.claim}-${error.reason}`;
  if (error instanceof errors.JOSEAlgNotAllowed) return 'alg-no-permitido';
  if (error instanceof errors.JWKSNoMatchingKey) return 'kid-desconocido';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'firma-invalida';
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) {
    return 'formato-invalido';
  }
  return 'invalido';
}
