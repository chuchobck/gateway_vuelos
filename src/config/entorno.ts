import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Entorno del gateway, validado al arrancar: si algo falta o no sirve, el proceso no levanta y
 * dice qué variable revisar. Un mensaje nombra la variable, nunca su valor (puede ser una URL
 * interna o algo que no debería ir al log).
 *
 * Todas las variables están en .env.example y en docs/DEPLOY.md.
 */

export type NombreUpstream = 'core' | 'bff' | 'identity' | 'notifier';

export const UPSTREAMS: readonly NombreUpstream[] = ['core', 'bff', 'identity', 'notifier'];

export interface ConfiguracionUpstream {
  /** Origen del servicio (esquema, host y puerto), sin ruta ni barra final. */
  url: URL;
  /** Plazo hasta recibir las cabeceras de la respuesta (y de inactividad después). */
  plazoMs: number;
}

export interface Configuracion {
  produccion: boolean;
  puerto: number;
  host: string;
  nivelLog: string;
  upstreams: Record<NombreUpstream, ConfiguracionUpstream>;
  jwt: {
    /** `iss` exacto de los tokens de identity (su JWT_ISSUER). */
    emisor: string;
    audiencia: string;
    /** De dónde se baja el JWKS: por defecto, del identity interno (no del origen público). */
    jwksUrl: string;
  };
  corsOrigenes: string[];
  /** Cuántos proxies de confianza hay delante del gateway (0: la IP del socket). */
  saltosProxy: number;
  limites: {
    ventanaSegundos: number;
    global: number;
    estrictoVentanaSegundos: number;
    estricto: number;
  };
  /** Trazas y métricas (docs/OBSERVABILIDAD.md). */
  observabilidad: {
    /** `service.name` (OTEL_SERVICE_NAME): quinde-gateway. */
    servicio: string;
    /** `service.version`: la de package.json. */
    version: string;
    /** `deployment.environment`: NODE_ENV. */
    entorno: string;
    /** OTEL_EXPORTER_OTLP_ENDPOINT: sin valor, las trazas se generan y propagan pero no se exportan. */
    endpointOtlp?: string;
    /** OTEL_TRACES_SAMPLER_ARG: fracción de trazas raíz que se registran. */
    muestreo: number;
    /** TRACE_TRUST_INCOMING: continuar el traceparent del cliente en lugar de abrir una traza nueva. */
    confiarEntrante: boolean;
    /** METRICS_PORT: puerto aparte de /metrics; 0 lo apaga. */
    puertoMetricas: number;
  };
}

/** Lo que el gateway no puede adivinar; lo demás tiene un valor por defecto. */
export const PLAZOS_POR_DEFECTO_MS: Record<NombreUpstream, number> = {
  // El plan gratuito de Render duerme el core: despertarlo tarda ~50 s medidos (e-commerce)
  core: 45_000,
  // Un poco más que el del core: una consulta del BFF puede ser la que despierte al core
  bff: 50_000,
  identity: 10_000,
  notifier: 10_000,
};

export const AUDIENCIA_POR_DEFECTO = 'quinde-vuelos-api';
export const PUERTO_POR_DEFECTO = 8080;
export const LIMITE_GLOBAL_POR_DEFECTO = 300;
export const LIMITE_ESTRICTO_POR_DEFECTO = 20;
export const VENTANA_POR_DEFECTO_SEGUNDOS = 60;
export const SALTOS_MAXIMOS = 10;
export const SERVICIO_POR_DEFECTO = 'quinde-gateway';
export const PUERTO_METRICAS_POR_DEFECTO = 9464;
/** Todas las trazas en desarrollo; una de cada diez en producción. */
export const MUESTREO_POR_DEFECTO = { desarrollo: 1, produccion: 0.1 };

const NIVELES_LOG = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** El entorno no sirve. `errores` nombra cada variable con su problema, sin valores. */
export class ErrorEntorno extends Error {
  constructor(readonly errores: string[]) {
    super(`Entorno inválido:\n  - ${errores.join('\n  - ')}`);
    this.name = 'ErrorEntorno';
  }
}

type Variables = Record<string, string | undefined>;

export function leerEntorno(variables: Variables = process.env): Configuracion {
  const errores: string[] = [];
  const texto = (nombre: string) => {
    const valor = variables[nombre]?.trim();
    return valor === undefined || valor === '' ? undefined : valor;
  };

  const entero = (nombre: string, defecto: number, minimo: number, maximo: number): number => {
    const valor = texto(nombre);
    if (valor === undefined) return defecto;
    if (!/^\d+$/.test(valor) || Number(valor) < minimo || Number(valor) > maximo) {
      errores.push(`${nombre} debe ser un entero entre ${minimo} y ${maximo}`);
      return defecto;
    }
    return Number(valor);
  };

  const origen = (nombre: string, obligatoria: boolean): URL | undefined => {
    const valor = texto(nombre);
    if (valor === undefined) {
      if (obligatoria) errores.push(`${nombre} es obligatoria`);
      return undefined;
    }
    if (!esOrigen(valor)) {
      errores.push(`${nombre} debe ser un origen http(s) sin ruta ni barra final`);
      return undefined;
    }
    return new URL(valor);
  };

  const nodeEnv = texto('NODE_ENV') ?? 'development';
  const produccion = nodeEnv === 'production';

  const upstreams = {} as Record<NombreUpstream, ConfiguracionUpstream>;
  for (const nombre of UPSTREAMS) {
    const sufijo = nombre.toUpperCase();
    const url = origen(`UPSTREAM_${sufijo}_URL`, true);
    const plazoMs = entero(`TIMEOUT_${sufijo}_MS`, PLAZOS_POR_DEFECTO_MS[nombre], 500, 120_000);
    if (url) upstreams[nombre] = { url, plazoMs };
  }

  // iss texto a texto: el JWT_ISSUER de identity, que es el origen público (el de este gateway)
  const emisor = texto('JWT_ISSUER');
  if (emisor === undefined) errores.push('JWT_ISSUER es obligatoria');
  else if (!esOrigen(emisor)) errores.push('JWT_ISSUER debe ser un origen http(s) sin ruta');
  else if (produccion && !emisor.startsWith('https://')) {
    errores.push('JWT_ISSUER debe ser https en producción');
  }

  const jwksExplicita = texto('JWKS_URL');
  let jwksUrl = '';
  if (jwksExplicita !== undefined) {
    if (!esUrlHttp(jwksExplicita)) errores.push('JWKS_URL debe ser una URL http(s)');
    else jwksUrl = jwksExplicita;
  } else if (upstreams.identity) {
    jwksUrl = new URL('/.well-known/jwks.json', upstreams.identity.url).toString();
  }

  const corsOrigenes = (texto('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  if (corsOrigenes.some((o) => !esOrigen(o))) {
    errores.push('CORS_ORIGINS debe ser una lista de orígenes http(s) separados por coma, sin *');
  }

  const nivelLog = texto('LOG_LEVEL') ?? 'info';
  if (!NIVELES_LOG.includes(nivelLog)) {
    errores.push(`LOG_LEVEL debe ser uno de: ${NIVELES_LOG.join(', ')}`);
  }

  const servicio = texto('OTEL_SERVICE_NAME') ?? SERVICIO_POR_DEFECTO;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(servicio)) {
    errores.push('OTEL_SERVICE_NAME debe ser un nombre en minúsculas, dígitos y guiones');
  }

  const endpointOtlp = texto('OTEL_EXPORTER_OTLP_ENDPOINT');
  if (endpointOtlp !== undefined && !esUrlHttp(endpointOtlp)) {
    errores.push('OTEL_EXPORTER_OTLP_ENDPOINT debe ser una URL http(s) sin credenciales');
  }

  let muestreo = produccion ? MUESTREO_POR_DEFECTO.produccion : MUESTREO_POR_DEFECTO.desarrollo;
  const fraccion = texto('OTEL_TRACES_SAMPLER_ARG');
  if (fraccion !== undefined) {
    if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(fraccion)) {
      errores.push('OTEL_TRACES_SAMPLER_ARG debe ser una fracción entre 0 y 1');
    } else {
      muestreo = Number(fraccion);
    }
  }

  const confiar = texto('TRACE_TRUST_INCOMING') ?? 'false';
  if (confiar !== 'true' && confiar !== 'false') {
    errores.push('TRACE_TRUST_INCOMING debe ser true o false');
  }

  const puerto = entero('PORT', PUERTO_POR_DEFECTO, 1, 65_535);
  const puertoMetricas = entero('METRICS_PORT', PUERTO_METRICAS_POR_DEFECTO, 0, 65_535);
  if (puertoMetricas !== 0 && puertoMetricas === puerto) {
    errores.push('METRICS_PORT debe ser distinto de PORT (el ingress solo expone PORT)');
  }

  const configuracion: Configuracion = {
    produccion,
    puerto,
    host: texto('HOST') ?? '0.0.0.0',
    nivelLog,
    upstreams,
    jwt: {
      emisor: emisor ?? '',
      audiencia: texto('JWT_AUDIENCE') ?? AUDIENCIA_POR_DEFECTO,
      jwksUrl,
    },
    corsOrigenes,
    saltosProxy: entero('TRUST_PROXY_HOPS', 0, 0, SALTOS_MAXIMOS),
    limites: {
      ventanaSegundos: entero('RATE_LIMIT_WINDOW_SECONDS', VENTANA_POR_DEFECTO_SEGUNDOS, 1, 86_400),
      global: entero('RATE_LIMIT_MAX', LIMITE_GLOBAL_POR_DEFECTO, 1, 1_000_000),
      estrictoVentanaSegundos: entero(
        'RATE_LIMIT_STRICT_WINDOW_SECONDS',
        VENTANA_POR_DEFECTO_SEGUNDOS,
        1,
        86_400,
      ),
      estricto: entero('RATE_LIMIT_STRICT_MAX', LIMITE_ESTRICTO_POR_DEFECTO, 1, 1_000_000),
    },
    observabilidad: {
      servicio,
      version: versionDelPaquete(),
      entorno: nodeEnv,
      ...(endpointOtlp !== undefined && esUrlHttp(endpointOtlp) ? { endpointOtlp } : {}),
      muestreo,
      confiarEntrante: confiar === 'true',
      puertoMetricas,
    },
  };

  if (errores.length > 0) throw new ErrorEntorno(errores);
  return configuracion;
}

/** `https://app.example.com`: sin ruta, sin barra final, sin credenciales ni comodín. */
export function esOrigen(valor: string): boolean {
  try {
    const url = new URL(valor);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === valor;
  } catch {
    return false;
  }
}

function esUrlHttp(valor: string): boolean {
  try {
    const url = new URL(valor);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/** La versión de package.json (dos niveles arriba desde src/config o dist/config). */
function versionDelPaquete(): string {
  try {
    const paquete = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof paquete.version === 'string' ? paquete.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
