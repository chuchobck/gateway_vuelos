import { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { tracestateAcotado } from '../observabilidad/traceparent';

/** Hop-by-hop (RFC 9110, 7.6.1): valen para una conexión, no se reenvían. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Lo que el cliente no puede dictar hacia los servicios: quién es (IP, esquema, host) lo escribe
 * el gateway. `expect` tampoco pasa: el gateway no negocia 100-continue con el upstream.
 */
const DEL_CLIENTE_QUE_NO_PASAN = new Set([
  'host',
  'forwarded',
  'x-real-ip',
  'x-request-id',
  'expect',
  // La traza la abre el gateway: el traceparent del cliente nunca llega tal cual a un servicio
  'traceparent',
  'tracestate',
]);

/** Lo que el upstream no le dice al cliente: quién es, ni su CORS (el del gateway es el único). */
const DEL_UPSTREAM_QUE_NO_PASAN = new Set(['server', 'x-powered-by', 'x-request-id']);

/** Las cabeceras que `Connection` declara hop-by-hop en este mensaje. */
function nombradasEnConnection(cabeceras: IncomingHttpHeaders): Set<string> {
  const valor = cabeceras.connection;
  return new Set(
    (Array.isArray(valor) ? valor.join(',') : (valor ?? ''))
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n !== ''),
  );
}

export interface DatosReenvio {
  requestId: string;
  ipCliente: string;
  esquema: 'http' | 'https';
  /** El Host que pidió el cliente (validado), para X-Forwarded-Host; undefined si no sirve. */
  hostPublico: string | undefined;
  /** El host:puerto del upstream, para Host. */
  hostUpstream: string;
  /** El traceparent del span del gateway hacia este upstream (mismo trace-id, otro parent-id). */
  traceparent: string;
}

/**
 * Cabeceras de la petición hacia el upstream: las del cliente tal cual (Authorization, Content-*,
 * Accept-*, Idempotency-Key, X-Device-Fingerprint, ETag condicionales...) menos las hop-by-hop y
 * las que dicen quién es el cliente o de qué traza viene, que el gateway escribe: X-Forwarded-For
 * (solo la IP real), X-Forwarded-Proto, X-Forwarded-Host, X-Request-Id y traceparent (el de su
 * span hacia ese upstream). tracestate pasa sin tocar, con su tope.
 * El gateway no inventa cabeceras de identidad (nada de X-User-*).
 */
export function cabecerasHaciaUpstream(
  recibidas: IncomingHttpHeaders,
  datos: DatosReenvio,
): OutgoingHttpHeaders {
  const conexion = nombradasEnConnection(recibidas);
  const salida: OutgoingHttpHeaders = {};
  for (const [nombre, valor] of Object.entries(recibidas)) {
    if (valor === undefined) continue;
    if (HOP_BY_HOP.has(nombre) || conexion.has(nombre)) continue;
    if (DEL_CLIENTE_QUE_NO_PASAN.has(nombre) || nombre.startsWith('x-forwarded-')) continue;
    salida[nombre] = valor;
  }
  salida.host = datos.hostUpstream;
  salida['x-forwarded-for'] = datos.ipCliente;
  salida['x-forwarded-proto'] = datos.esquema;
  if (datos.hostPublico !== undefined) salida['x-forwarded-host'] = datos.hostPublico;
  salida['x-request-id'] = datos.requestId;
  salida.traceparent = datos.traceparent;
  // tracestate pasa intacto si cabe en el tope de W3C; si no, se descarta entero
  const tracestate = tracestateAcotado(recibidas.tracestate);
  if (tracestate !== undefined) salida.tracestate = tracestate;
  return salida;
}

/**
 * Cabeceras de la respuesta del upstream hacia el cliente: todas (Content-Type, Content-Encoding,
 * Content-Length, Retry-After, ETag, Cache-Control, Location, Set-Cookie...) menos las hop-by-hop,
 * Server, X-Powered-By y Access-Control-*. X-Request-Id, CORS y las de seguridad las pone el
 * gateway después.
 */
export function cabecerasHaciaCliente(recibidas: IncomingHttpHeaders): OutgoingHttpHeaders {
  const conexion = nombradasEnConnection(recibidas);
  const salida: OutgoingHttpHeaders = {};
  for (const [nombre, valor] of Object.entries(recibidas)) {
    if (valor === undefined) continue;
    if (HOP_BY_HOP.has(nombre) || conexion.has(nombre)) continue;
    if (DEL_UPSTREAM_QUE_NO_PASAN.has(nombre) || nombre.startsWith('access-control-')) continue;
    salida[nombre] = valor;
  }
  return salida;
}

/** Un Host razonable (nombre o IP, con puerto opcional); lo demás no se reenvía. */
export function hostValido(host: string | undefined): string | undefined {
  return host !== undefined &&
    /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)
    ? host
    : undefined;
}
