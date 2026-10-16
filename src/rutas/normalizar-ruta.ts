import { ErrorBorde } from '../common/problema';

/**
 * La ruta de una petición, lista para decidir y para reenviar. La decisión (bloqueo, upstream,
 * seguridad) y el reenvío usan la MISMA ruta: lo que el gateway revisó es exactamente lo que le
 * llega al servicio, sin una segunda interpretación en el camino.
 */
export interface RutaNormalizada {
  /** Segmentos ya decodificados, con sus mayúsculas. */
  segmentos: string[];
  /** Para decidir: `/` + segmentos en minúsculas (Express no distingue mayúsculas). */
  clave: string;
  /** Para reenviar: segmentos re-codificados de forma canónica, sin barra final. */
  ruta: string;
  /** La query tal como llegó, sin el `?` ('' si no hay). No se mira ni se registra. */
  query: string;
}

/** Caracteres que puede llevar un segmento crudo (pchar de RFC 3986, más `%` de los escapes). */
const SEGMENTO_CRUDO = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%]+$/;
const ESCAPE_MAL_FORMADO = /%(?![0-9A-Fa-f]{2})/;
/** Lo que un segmento decodificado no puede traer: separadores, `%` (doble codificación), control. */
// eslint-disable-next-line no-control-regex
const DECODIFICADO_PROHIBIDO = /[/\\%\u0000-\u001f\u007f]/;
/** Lo que encodeURIComponent escapa pero un segmento admite tal cual (sub-delims, `:` y `@`). */
const RESTAURAR = /%(24|26|2B|2C|3B|3D|3A|40)/g;

function ambigua(): ErrorBorde {
  return new ErrorBorde(400, 'The request path is ambiguous or malformed');
}

/**
 * Normaliza la ruta de la petición (`request.raw.url`) ANTES de decidir nada. Una ruta que
 * podría leerse de dos maneras no se arregla: se rechaza con 400.
 *
 * - Debe empezar con `/` (nada de `http://host/...` ni `*`) y no traer `\` ni `#`.
 * - `//` (segmento vacío) → 400. Una sola barra final se quita: `/a/b/` es `/a/b`.
 * - Cada segmento se decodifica UNA vez. Un escape mal formado, un `%2f`/`%5c` (separador
 *   codificado), un `%25` (doble codificación) o un carácter de control → 400.
 * - `.` y `..` (también como `%2e`, `%2E%2e`...) → 400: no se resuelven, porque el upstream
 *   podría resolverlos distinto que el gateway.
 * - Mayúsculas: se decide en minúsculas (Express, en los cuatro servicios, no las distingue) y se
 *   reenvía la ruta con sus mayúsculas, que es la misma ruta para el servicio.
 */
export function normalizarRuta(urlCruda: string): RutaNormalizada {
  if (!urlCruda.startsWith('/')) throw ambigua();
  const corte = urlCruda.indexOf('?');
  let crudo = corte === -1 ? urlCruda : urlCruda.slice(0, corte);
  const query = corte === -1 ? '' : urlCruda.slice(corte + 1);
  if (crudo.includes('\\') || crudo.includes('#') || query.includes('#')) throw ambigua();

  if (crudo.length > 1 && crudo.endsWith('/')) crudo = crudo.slice(0, -1);
  if (crudo === '/') return { segmentos: [], clave: '/', ruta: '/', query };

  const segmentos = crudo
    .slice(1)
    .split('/')
    .map((segmento) => {
      if (!SEGMENTO_CRUDO.test(segmento) || ESCAPE_MAL_FORMADO.test(segmento)) throw ambigua();
      let decodificado: string;
      try {
        decodificado = decodeURIComponent(segmento);
      } catch {
        throw ambigua();
      }
      if (DECODIFICADO_PROHIBIDO.test(decodificado)) throw ambigua();
      if (decodificado === '.' || decodificado === '..') throw ambigua();
      return decodificado;
    });

  return {
    segmentos,
    clave: '/' + segmentos.map((s) => s.toLowerCase()).join('/'),
    ruta:
      '/' +
      segmentos
        .map((s) =>
          encodeURIComponent(s).replace(RESTAURAR, (_e, hex: string) =>
            decodeURIComponent(`%${hex}`),
          ),
        )
        .join('/'),
    query,
  };
}
