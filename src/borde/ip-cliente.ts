import { isIP } from 'node:net';

/**
 * La IP del cliente, la que cuenta para el límite de peticiones y la que el gateway escribe en
 * X-Forwarded-For hacia los servicios. Nunca se confía a ciegas en lo que mande el cliente:
 *
 * - `saltos = 0` (sin proxy delante): la IP del socket. X-Forwarded-For se ignora.
 * - `saltos = N`: hay N proxies de confianza delante (el ingress de Azure Container Apps, por
 *   ejemplo, es 1). Cada uno agrega a la derecha la IP que vio, así que la del cliente es la N-ésima
 *   desde la derecha de X-Forwarded-For. Lo que hay más a la izquierda lo escribió el cliente y no
 *   se mira. Si la cadena es más corta que N, o esa entrada no es una IP, se usa la más lejana que
 *   sí agregó un proxy de confianza (o el socket).
 *
 * Es la regla de `trust proxy = N` de Express, la que usan el core, el BFF, identity y el notifier.
 */
export function ipCliente(
  ipSocket: string | undefined,
  xForwardedFor: string | string[] | undefined,
  saltos: number,
): string {
  const socket = limpiar(ipSocket) ?? '0.0.0.0';
  if (saltos === 0) return socket;

  const recibido = Array.isArray(xForwardedFor) ? xForwardedFor.join(',') : (xForwardedFor ?? '');
  const cadena = [
    ...recibido
      .split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip !== ''),
    socket,
  ];
  // De derecha a izquierda: socket (salto 0), la que agregó el primer proxy (1), ...
  let ip = socket;
  for (let salto = 1; salto <= saltos; salto++) {
    const candidata = limpiar(cadena[cadena.length - 1 - salto]);
    if (candidata === undefined) break;
    ip = candidata;
  }
  return ip;
}

/** Una IP válida, sin el prefijo IPv4-mapeado (`::ffff:10.0.0.1` es `10.0.0.1`); si no, undefined. */
function limpiar(valor: string | undefined): string | undefined {
  if (valor === undefined) return undefined;
  const ip = valor.startsWith('::ffff:') && isIP(valor.slice(7)) === 4 ? valor.slice(7) : valor;
  return isIP(ip) === 0 ? undefined : ip;
}
