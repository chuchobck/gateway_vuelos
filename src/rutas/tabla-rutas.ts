import { NombreUpstream } from '../config/entorno';

/**
 * Seguridad de una ruta en el borde:
 *
 * - `publica`: el gateway no mira el token. El Authorization (si viene) pasa intacto y el servicio
 *   decide. Un token inválido en una ruta pública NO se rechaza aquí: es el servicio el que sabe
 *   si la ruta lo usa (p. ej. /identity/v1/auth/me lo exige; /graphql lo ignora).
 * - `token`: exige un token válido de identity con todos los `scopes` (vacío: solo un token
 *   válido). Sin él, 401/403/503 en el borde y la petición no llega al servicio.
 * - `contrato`: la seguridad sale del OpenAPI del core (copia en contracts/), operación por
 *   operación. Lo que el contrato no declara exige un token válido sin scopes (ver
 *   resolver-ruta.ts).
 */
export type Seguridad =
  { modo: 'publica' } | { modo: 'token'; scopes: readonly string[] } | { modo: 'contrato' };

export interface ReglaRuta {
  /**
   * Segmentos separados por `/`, comparados en minúsculas. `*` es un segmento cualquiera y `**`
   * (solo al final) cero o más segmentos.
   */
  patron: string;
  /** A quién va. `gateway`: lo responde el propio gateway (salud). */
  destino: NombreUpstream | 'gateway';
  seguridad: Seguridad;
  /** Además del global, un contador más estricto por IP y por ruta (fuerza bruta). */
  limiteEstricto?: boolean;
  /** Tope del cuerpo en bytes: el del servicio de destino (más grande, 413 sin llegar a él). */
  cuerpoMaximo: number;
  /** Por qué la regla es así, para `npm run rutas:listar` y docs/RUTAS.md. */
  nota: string;
}

/** 100 kB, como `LIMITE_CUERPO = '100kb'` del core, el BFF, identity y el notifier. */
export const CUERPO_100KB = 100 * 1024;

const PUBLICA: Seguridad = { modo: 'publica' };

/**
 * Lo que nunca se enruta, se evalúe antes que la tabla y pase lo que pase en ella. Responde 404,
 * igual que una ruta que no existe, sin tocar ningún upstream:
 * - /internal/**: la API interna del notifier (core → notifier).
 * - /metrics: las métricas van en su propio puerto (METRICS_PORT), que el ingress no expone; en el
 *   puerto público no existen, ni las del gateway ni las de ningún servicio.
 */
export const RUTAS_BLOQUEADAS: readonly string[] = ['/internal/**', '/metrics/**'];

/**
 * La tabla de rutas del gateway: la primera regla que coincide decide. Ninguna reescribe la
 * ruta: cada servicio conserva su prefijo. Lo que no está aquí es 404 (también /api/docs de cada
 * servicio y el gRPC del core, que no se exponen).
 */
export const TABLA_RUTAS: readonly ReglaRuta[] = [
  // --- el propio gateway ---------------------------------------------------------------------
  {
    patron: '/health',
    destino: 'gateway',
    seguridad: PUBLICA,
    cuerpoMaximo: 0,
    nota: 'Vivo',
  },
  {
    patron: '/health/ready',
    destino: 'gateway',
    seguridad: PUBLICA,
    cuerpoMaximo: 0,
    nota: 'Configuración cargada (no depende de los upstreams)',
  },
  {
    patron: '/health/upstreams',
    destino: 'gateway',
    seguridad: PUBLICA,
    cuerpoMaximo: 0,
    nota: 'Informativo: la salud de cada servicio, con 2 s de plazo',
  },

  // --- bff -----------------------------------------------------------------------------------
  {
    patron: '/graphql',
    destino: 'bff',
    seguridad: PUBLICA,
    cuerpoMaximo: CUERPO_100KB,
    nota: 'Lecturas públicas (searchFlights, seatMap, flightStatus); el BFF limita por operación',
  },

  // --- notifier ------------------------------------------------------------------------------
  {
    patron: '/flights/v1/webhooks',
    destino: 'notifier',
    seguridad: { modo: 'token', scopes: ['flights:webhooks'] },
    cuerpoMaximo: CUERPO_100KB,
    nota: 'Suscripciones (contrato del core 1.5.0.0); el core con WEBHOOKS_MODE=notifier da 404',
  },
  {
    patron: '/flights/v1/webhooks/*',
    destino: 'notifier',
    seguridad: { modo: 'token', scopes: ['flights:webhooks'] },
    cuerpoMaximo: CUERPO_100KB,
    nota: 'DELETE /webhooks/{id}',
  },

  // --- core ----------------------------------------------------------------------------------
  {
    patron: '/flights/v1/admin/**',
    destino: 'core',
    seguridad: { modo: 'token', scopes: ['flights:admin'] },
    cuerpoMaximo: CUERPO_100KB,
    nota: 'Catálogo y administración: fuera del contrato; el core exige flights:admin',
  },
  {
    patron: '/flights/v1/health',
    destino: 'core',
    seguridad: PUBLICA,
    cuerpoMaximo: CUERPO_100KB,
    nota: 'Salud del core (fuera del contrato), la que usa scripts/smoke.sh del core',
  },
  {
    patron: '/flights/v1/auth/**',
    destino: 'core',
    seguridad: PUBLICA,
    cuerpoMaximo: CUERPO_100KB,
    nota: 'Login local del core: con AUTH_MODE=external no existe (404 del core)',
  },
  {
    patron: '/flights/v1/**',
    destino: 'core',
    seguridad: { modo: 'contrato' },
    cuerpoMaximo: CUERPO_100KB,
    nota: 'Scopes del OpenAPI del core; lo que el contrato no declara exige un token válido',
  },

  // --- identity ------------------------------------------------------------------------------
  {
    patron: '/identity/v1/admin/**',
    destino: 'identity',
    seguridad: { modo: 'token', scopes: ['flights:admin'] },
    cuerpoMaximo: CUERPO_100KB,
    nota: 'Administradores (/admin/users); identity también exige flights:admin',
  },
  {
    patron: '/identity/v1/auth/login',
    destino: 'identity',
    seguridad: PUBLICA,
    limiteEstricto: true,
    cuerpoMaximo: CUERPO_100KB,
    nota: 'Adivinar contraseñas: límite estricto en el borde además del de identity',
  },
  {
    patron: '/identity/v1/auth/register',
    destino: 'identity',
    seguridad: PUBLICA,
    limiteEstricto: true,
    cuerpoMaximo: CUERPO_100KB,
    nota: 'Cuentas en masa: límite estricto en el borde además del de identity',
  },
  {
    patron: '/identity/v1/**',
    destino: 'identity',
    seguridad: PUBLICA,
    cuerpoMaximo: CUERPO_100KB,
    nota: 'refresh, logout y me: identity decide (logout y me exigen el token de una persona)',
  },
  {
    patron: '/oauth2/token',
    destino: 'identity',
    seguridad: PUBLICA,
    limiteEstricto: true,
    cuerpoMaximo: CUERPO_100KB,
    nota: 'client_credentials (formulario); límite estricto en el borde',
  },
  {
    patron: '/.well-known/**',
    destino: 'identity',
    seguridad: PUBLICA,
    cuerpoMaximo: CUERPO_100KB,
    nota: 'jwks.json y openid-configuration: el issuer es el origen público de este gateway',
  },
];

/** ¿La clave de la ruta (en minúsculas) coincide con el patrón? */
export function coincide(patron: string, clave: string): boolean {
  const partes = patron === '/' ? [] : patron.slice(1).split('/');
  const segmentos = clave === '/' ? [] : clave.slice(1).split('/');
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    if (parte === '**') return true;
    const segmento = segmentos[i];
    if (segmento === undefined) return false;
    if (parte !== '*' && parte !== segmento) return false;
  }
  return partes.length === segmentos.length;
}

/**
 * La plantilla de una regla, para nombres de span y etiquetas de métricas: `*` es `{id}` y `**` se
 * deja como está. Siempre de la tabla, nunca de la ruta pedida: la cardinalidad queda acotada.
 */
export function plantillaDePatron(patron: string): string {
  return patron.replace(/\/\*(?=\/|$)/g, '/{id}');
}
