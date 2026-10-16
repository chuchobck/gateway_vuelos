import { CryptoKey, importJWK } from 'jose';
import { Reloj } from '../common/reloj';
import { Registro } from './registro';

/** Plazo de una descarga del JWKS: más que esto y se da por fallida. */
export const PLAZO_DESCARGA_MS = 3000;

/**
 * Espera mínima entre dos descargas que no hacen falta por vencimiento: la de un `kid`
 * desconocido con una copia vigente, y el reintento después de una descarga fallida. Así un
 * atacante con `kid` inventados provoca a lo sumo una descarga cada 10 s, y un servicio de
 * identidad caído no recibe una petición por cada petición a la API.
 */
export const ENFRIAMIENTO_MS = 10_000;

/** Vigencia de una copia: el `max-age` de la respuesta, entre estos topes (en segundos). */
export const VIGENCIA_MINIMA_S = 30;
export const VIGENCIA_MAXIMA_S = 3600;
/** Si la respuesta no trae un `max-age` usable. Es el que publica identity_vuelos. */
export const VIGENCIA_SIN_CABECERA_S = 300;

/** Un JWKS legítimo tiene dos o tres claves; más de esto no se lee. */
const TAMANO_MAXIMO_BYTES = 64 * 1024;

/** Un `kid` que se puede guardar y registrar en el log sin riesgo (las huellas RFC 7638 lo cumplen). */
export const FORMATO_KID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * No hay un JWKS con el que verificar: no se pudo bajar (servicio de identidad caído, lento o
 * respondiendo mal) y no hay una copia vigente. El guard responde 503 AUTH_UNAVAILABLE, nunca 401:
 * el cliente no hizo nada mal.
 */
export class JwksNoDisponibleError extends Error {
  constructor(readonly reintentarEnSegundos: number) {
    super('The identity service keys are not available');
    this.name = 'JwksNoDisponibleError';
  }
}

/** Una JWK que sirve para verificar RS256: RSA, sin parámetros privados, con un `kid` usable. */
interface JwkRsa {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
}

function esJwkRs256(jwk: unknown): jwk is JwkRsa & { alg?: unknown; use?: unknown } {
  if (typeof jwk !== 'object' || jwk === null) return false;
  const { kty, n, e, kid, alg, use } = jwk as Record<string, unknown>;
  return (
    kty === 'RSA' &&
    typeof n === 'string' &&
    typeof e === 'string' &&
    typeof kid === 'string' &&
    FORMATO_KID.test(kid) &&
    (alg === undefined || alg === 'RS256') &&
    (use === undefined || use === 'sig')
  );
}

/** El `max-age` de Cache-Control acotado a [mínima, máxima]; sin él, el valor por defecto. */
export function vigenciaDe(cacheControl: string | null): number {
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i.exec(cacheControl ?? '')?.[1];
  const segundos = maxAge === undefined ? VIGENCIA_SIN_CABECERA_S : Number(maxAge);
  return Math.min(VIGENCIA_MAXIMA_S, Math.max(VIGENCIA_MINIMA_S, segundos));
}

/**
 * Las claves públicas del servicio de identidad, bajadas de su JWKS y guardadas por `kid` (copia
 * de la del notifier, fase 5a, que es la del core, fase 4b; solo cambia el logger). Todos
 * los tiempos salen del Reloj (las pruebas lo adelantan); el plazo de la descarga es real.
 *
 * - Sin copia, o con la copia vencida (`max-age` de la respuesta): se baja antes de verificar.
 *   Si falla, JwksNoDisponibleError. Una copia vencida no se usa: una clave quitada del JWKS (por
 *   ejemplo, después de una filtración) deja de valer a más tardar al vencer la copia.
 * - Con una copia vigente, un corte del servicio de identidad no se nota: no se le pide nada.
 * - Un `kid` que la copia vigente no tiene (una clave nueva tras rotar, o uno inventado): se
 *   vuelve a bajar solo si pasó el enfriamiento desde la última descarga.
 * - Después de una descarga fallida no se reintenta hasta que pase el enfriamiento.
 * - Descargas simultáneas se juntan en una sola.
 *
 * Al log van los `kid` y el motivo de un fallo, nunca el JWKS.
 */
export class ClavesJwks {
  private claves = new Map<string, CryptoKey>();
  private hayCopia = false;
  /** Instante (ms, del Reloj) en que vence la copia. */
  private vigenteHasta = 0;
  /** Instante de la última descarga, buena o fallida. */
  private ultimoIntento = Number.NEGATIVE_INFINITY;
  private ultimoFallo = false;
  private enCurso: Promise<void> | undefined;

  constructor(
    private readonly url: string,
    private readonly reloj: Reloj,
    private readonly logger: Registro,
  ) {}

  /**
   * La clave de ese `kid`, o undefined si el JWKS vigente no la tiene. Lanza
   * JwksNoDisponibleError si no hay un JWKS vigente con el que contestar.
   */
  async clave(kid: string): Promise<CryptoKey | undefined> {
    const ahora = this.ahora();
    if (!this.hayCopia || ahora >= this.vigenteHasta) {
      await this.refrescar();
      return this.claves.get(kid);
    }

    const clave = this.claves.get(kid);
    if (clave !== undefined || ahora - this.ultimoIntento < ENFRIAMIENTO_MS) return clave;
    await this.refrescar();
    return this.claves.get(kid);
  }

  private ahora(): number {
    return this.reloj.ahora().getTime();
  }

  private refrescar(): Promise<void> {
    if (this.enCurso) return this.enCurso;
    const ahora = this.ahora();
    if (this.ultimoFallo && ahora - this.ultimoIntento < ENFRIAMIENTO_MS) {
      return Promise.reject(new JwksNoDisponibleError(this.segundosHastaReintento(ahora)));
    }
    this.ultimoIntento = ahora;
    this.enCurso = this.descargar().finally(() => {
      this.enCurso = undefined;
    });
    return this.enCurso;
  }

  private segundosHastaReintento(ahora: number): number {
    return Math.max(1, Math.ceil((this.ultimoIntento + ENFRIAMIENTO_MS - ahora) / 1000));
  }

  private async descargar(): Promise<void> {
    try {
      const respuesta = await fetch(this.url, {
        headers: { accept: 'application/json' },
        // Una redirección no se sigue: el JWKS está donde se configuró
        redirect: 'error',
        signal: AbortSignal.timeout(PLAZO_DESCARGA_MS),
      });
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      const texto = await respuesta.text();
      if (texto.length > TAMANO_MAXIMO_BYTES) throw new Error('respuesta demasiado grande');
      const claves = await importarClaves(JSON.parse(texto));

      const vigencia = vigenciaDe(respuesta.headers.get('cache-control'));
      this.claves = claves;
      this.hayCopia = true;
      this.vigenteHasta = this.ahora() + vigencia * 1000;
      this.ultimoFallo = false;
      const kids = [...claves.keys()].join(', ') || 'ninguna';
      this.logger.info(
        `JWKS descargado: ${claves.size} claves (kid ${kids}), vigente ${vigencia} s`,
      );
    } catch (error) {
      this.ultimoFallo = true;
      // Una copia que sigue vigente se conserva: solo faltaba una clave nueva
      const vigente = this.hayCopia && this.ahora() < this.vigenteHasta;
      this.logger.warn(
        `No se pudo bajar el JWKS (${motivoDelFallo(error)}); ` +
          (vigente ? 'se sigue con la copia vigente' : 'no hay una copia vigente'),
      );
      throw new JwksNoDisponibleError(this.segundosHastaReintento(this.ahora()));
    }
  }
}

/** Las claves RS256 de un JWKS por `kid`; lo demás (EC, privadas, otros usos) se ignora. */
async function importarClaves(jwks: unknown): Promise<Map<string, CryptoKey>> {
  const lista = (jwks as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(lista)) throw new Error('no es un JWKS');
  const claves = new Map<string, CryptoKey>();
  for (const jwk of lista) {
    if (!esJwkRs256(jwk)) continue;
    // Solo los parámetros públicos: aunque llegara `d`, nunca se importa una privada
    const clave = await importJWK({ kty: 'RSA', n: jwk.n, e: jwk.e }, 'RS256');
    claves.set(jwk.kid, clave as CryptoKey);
  }
  return claves;
}

/**
 * Un motivo corto para el log, sin la URL ni el contenido de la respuesta. Mira `name` y no
 * `instanceof`: los errores de fetch (DOMException, TypeError de undici) pueden venir de otro
 * realm, y ahí `instanceof Error` da false.
 */
function motivoDelFallo(error: unknown): string {
  const { name, message, cause } = (error ?? {}) as {
    name?: unknown;
    message?: unknown;
    cause?: { code?: unknown };
  };
  if (name === 'TimeoutError') return `más de ${PLAZO_DESCARGA_MS} ms`;
  if (name === 'SyntaxError') return 'no es JSON';
  if (typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(cause.code)) {
    return cause.code;
  }
  if (
    typeof message === 'string' &&
    /^(HTTP \d{3}|respuesta demasiado grande|no es un JWKS)$/.test(message)
  ) {
    return message;
  }
  return 'error de red';
}
