import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
  LogController,
} from 'fastify';
import { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import { Writable } from 'node:stream';
import { Cors } from './borde/cors';
import { ipCliente } from './borde/ip-cliente';
import { Limitador } from './borde/limitador';
import { CONTENT_TYPE_PROBLEMA, ErrorBorde } from './common/problema';
import { Reloj } from './common/reloj';
import { CABECERA_REQUEST_ID, requestIdDe } from './common/request-id';
import { Configuracion, NombreUpstream, UPSTREAMS } from './config/entorno';
import { cabecerasHaciaCliente, cabecerasHaciaUpstream, hostValido } from './proxy/cabeceras';
import { ClienteUpstream, ErrorUpstream } from './proxy/cliente-upstream';
import { ContratoCore } from './rutas/contrato-core';
import { normalizarRuta } from './rutas/normalizar-ruta';
import { ResolverRutas } from './rutas/resolver-ruta';
import { ReglaRuta, TABLA_RUTAS } from './rutas/tabla-rutas';
import { saludDeUpstreams } from './salud/salud';
import { autorizar } from './seguridad/autorizar';
import { ClavesJwks } from './seguridad/claves-jwks';
import { Registro } from './seguridad/registro';
import { VerificadorJwks } from './seguridad/verificador-jwks';

/** Lo que el gateway anota de cada petición para su línea de log de acceso. */
interface ContextoPeticion {
  inicio: bigint;
  ip: string;
  /** Ruta canónica sin query, o undefined si no se pudo normalizar. */
  ruta?: string;
  upstream?: NombreUpstream | 'gateway';
  /** Por qué el borde respondió él mismo (bloqueada, desconocida, ambigua, token, scope...). */
  motivo?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    contexto: ContextoPeticion;
  }
}

export interface OpcionesApp {
  configuracion: Configuracion;
  reloj?: Reloj;
  contrato?: ContratoCore;
  /** Solo pruebas: otra tabla (p. ej. para comprobar que el bloqueo de /internal va primero). */
  tabla?: readonly ReglaRuta[];
  /** Solo pruebas: a dónde van los logs (una línea JSON por registro). */
  destinoLogs?: Writable;
}

const NOT_FOUND = 'No route matches the request';

/**
 * Construye el gateway. Una sola ruta comodín: cada petición pasa, en este orden, por
 *   1. X-Request-Id (genReqId): el del cliente si es un uuid; si no, uno nuevo
 *   2. normalización de la ruta (400 si es ambigua) y preflight de CORS (204)
 *   3. decisión: bloqueada o desconocida (404), o la regla de la tabla
 *   4. límite global por IP y, si la regla lo pide, el estricto (429 con Retry-After)
 *   5. salud del gateway, o: Content-Length sobre el tope de la ruta (413)
 *   6. seguridad de la ruta (401/403/503)
 *   7. reenvío en streaming (502 caído, 504 sin respuesta a tiempo)
 * y en onSend: X-Request-Id, CORS y cabeceras de seguridad en TODA respuesta.
 */
export function construirApp(opciones: OpcionesApp): FastifyInstance {
  const { configuracion } = opciones;
  const reloj = opciones.reloj ?? new Reloj();
  const contrato = opciones.contrato ?? ContratoCore.leer();
  const resolver = new ResolverRutas(contrato, opciones.tabla ?? TABLA_RUTAS);
  const cors = new Cors(configuracion.corsOrigenes);
  const limiteGlobal = new Limitador(
    reloj,
    configuracion.limites.global,
    configuracion.limites.ventanaSegundos,
  );
  const limiteEstricto = new Limitador(
    reloj,
    configuracion.limites.estricto,
    configuracion.limites.estrictoVentanaSegundos,
  );
  const clientes = Object.fromEntries(
    UPSTREAMS.map((nombre) => [
      nombre,
      new ClienteUpstream(nombre, configuracion.upstreams[nombre]),
    ]),
  ) as Record<NombreUpstream, ClienteUpstream>;

  const app = Fastify({
    logger: opcionesLogger(configuracion.nivelLog, opciones.destinoLogs),
    // La línea de acceso la escribe el hook onResponse, sin URL con query ni cabeceras
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    genReqId: (peticion) => requestIdDe(peticion.headers[CABECERA_REQUEST_ID]),
    trustProxy: false,
    // El cuerpo no se lee aquí: pasa en streaming al upstream (ver el parser de abajo)
    bodyLimit: 1024 * 1024,
    return503OnClosing: true,
    frameworkErrors: (error, peticion, respuesta) => {
      const problema = new ErrorBorde(400, 'The request path is ambiguous or malformed');
      peticion.log.info({ status: 400, motivo: 'url-invalida', err: error }, 'acceso');
      void (respuesta as unknown as FastifyReply)
        .code(400)
        .header('content-type', CONTENT_TYPE_PROBLEMA)
        .header('x-request-id', peticion.id)
        .header('x-content-type-options', 'nosniff')
        .send(JSON.stringify(problema.problema()));
    },
  });

  const logger: Registro = {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
    debug: (m) => app.log.debug(m),
  };
  const verificador = new VerificadorJwks(
    new ClavesJwks(configuracion.jwt.jwksUrl, reloj, logger),
    { emisor: configuracion.jwt.emisor, audiencia: configuracion.jwt.audiencia },
    reloj,
    logger,
  );

  // Ningún parser: el cuerpo queda sin leer en la petición y se reenvía tal cual, en streaming
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_peticion, _cuerpo, listo) => listo(null, undefined));

  app.decorateRequest('contexto', null as unknown as ContextoPeticion);

  app.addHook('onRequest', async (peticion) => {
    peticion.contexto = {
      inicio: process.hrtime.bigint(),
      ip: ipCliente(
        peticion.raw.socket.remoteAddress,
        peticion.headers['x-forwarded-for'],
        configuracion.saltosProxy,
      ),
    };
  });

  // En TODA respuesta, propia o del upstream: request id, CORS del gateway y seguridad
  app.addHook('onSend', async (peticion, respuesta, cuerpo) => {
    respuesta.header('x-request-id', peticion.id);
    const origen = peticion.headers.origin;
    for (const [nombre, valor] of Object.entries(cors.respuesta(origen))) {
      respuesta.header(nombre, valor);
    }
    if (origen !== undefined) agregarVary(respuesta, 'Origin');
    respuesta.header('x-content-type-options', 'nosniff');
    if (configuracion.produccion) {
      respuesta.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return cuerpo;
  });

  app.addHook('onResponse', async (peticion, respuesta) => {
    const contexto = peticion.contexto;
    if (!contexto) return; // un error del framework antes de onRequest: ya se registró
    const ms = Number((process.hrtime.bigint() - contexto.inicio) / 1_000_000n);
    peticion.log.info(
      {
        metodo: peticion.method,
        ruta: contexto.ruta ?? '-',
        upstream: contexto.upstream ?? null,
        status: respuesta.statusCode,
        ms,
        ...(contexto.motivo ? { motivo: contexto.motivo } : {}),
      },
      'acceso',
    );
  });

  app.setErrorHandler(async (error, peticion, respuesta) => {
    if (error instanceof ErrorBorde) return responderError(respuesta, error);
    // Lo imprevisto: el log lleva el tipo (no el mensaje, que podría traer una URL interna)
    peticion.log.error({ err: error }, 'Error no controlado');
    peticion.contexto.motivo ??= 'error-interno';
    return responderError(respuesta, new ErrorBorde(500, 'Internal error'));
  });

  app.setNotFoundHandler(async (peticion, respuesta) => {
    peticion.contexto.motivo = 'desconocida';
    return responderError(respuesta, new ErrorBorde(404, NOT_FOUND));
  });

  app.all('*', async (peticion, respuesta) => {
    const contexto = peticion.contexto;

    let ruta;
    try {
      ruta = normalizarRuta(peticion.raw.url ?? '');
    } catch (error) {
      contexto.motivo = 'ambigua';
      throw error;
    }
    contexto.ruta = ruta.ruta;

    if (cors.esPreflight(peticion.method, peticion.headers)) {
      contexto.motivo = 'preflight';
      limitar(limiteGlobal, `g:${contexto.ip}`, contexto);
      return respuesta.code(204).headers(cors.preflight(peticion.headers.origin)).send();
    }

    const decision = resolver.decidir(peticion.method, ruta);
    if (decision.tipo !== 'ruta') {
      // /internal/** y lo desconocido responden igual: no se revela qué existe detrás
      contexto.motivo = decision.tipo;
      throw new ErrorBorde(404, NOT_FOUND);
    }
    const { regla } = decision;
    contexto.upstream = regla.destino;

    limitar(limiteGlobal, `g:${contexto.ip}`, contexto);
    if (regla.limiteEstricto) limitar(limiteEstricto, `e:${regla.patron}:${contexto.ip}`, contexto);

    if (regla.destino === 'gateway') {
      return responderSalud(peticion, respuesta, ruta.clave);
    }

    const declarado = Number(peticion.headers['content-length'] ?? 0);
    if (declarado > regla.cuerpoMaximo) {
      contexto.motivo = 'cuerpo';
      throw new ErrorBorde(413, 'The request body is too large');
    }

    try {
      await autorizar(decision.seguridad, peticion.headers.authorization, verificador);
    } catch (error) {
      if (error instanceof ErrorBorde) contexto.motivo = motivoDeSeguridad(error.status);
      throw error;
    }

    const cliente = clientes[regla.destino];
    const tieneCuerpo = declarado > 0 || peticion.headers['transfer-encoding'] !== undefined;
    let respuestaUpstream: IncomingMessage;
    try {
      respuestaUpstream = await cliente.reenviar({
        metodo: peticion.method,
        rutaYQuery: ruta.query === '' ? ruta.ruta : `${ruta.ruta}?${ruta.query}`,
        cabeceras: cabecerasHaciaUpstream(peticion.headers, {
          requestId: peticion.id,
          ipCliente: contexto.ip,
          esquema: esquemaDe(peticion, configuracion.saltosProxy),
          hostPublico: hostValido(peticion.headers.host),
          hostUpstream: cliente.host,
        }),
        cuerpo: tieneCuerpo ? peticion.raw : undefined,
        cuerpoMaximo: regla.cuerpoMaximo,
      });
    } catch (error) {
      throw errorDeUpstream(error, contexto, peticion);
    }

    return respuesta
      .code(respuestaUpstream.statusCode ?? 502)
      .headers(cabecerasHaciaCliente(respuestaUpstream.headers))
      .send(respuestaUpstream);
  });

  async function responderSalud(
    peticion: FastifyRequest,
    respuesta: FastifyReply,
    clave: string,
  ): Promise<FastifyReply> {
    if (peticion.method !== 'GET' && peticion.method !== 'HEAD') {
      throw new ErrorBorde(405, 'Method not allowed', { cabeceras: { Allow: 'GET, HEAD' } });
    }
    respuesta.header('cache-control', 'no-store');
    if (clave === '/health') return respuesta.send({ status: 'UP' });
    if (clave === '/health/ready') {
      return respuesta.send({
        status: 'UP',
        contract: { version: contrato.version, operations: contrato.operaciones.length },
      });
    }
    return respuesta.send({
      status: 'UP',
      upstreams: await saludDeUpstreams(clientes, peticion.id),
    });
  }

  return app;
}

/**
 * Logs JSON (pino, el de Fastify), uno por línea. Nada de la petición va al log por su cuenta: ni
 * cabeceras (Authorization), ni la URL con su query, ni el cuerpo. De un error, solo su tipo y su
 * código: el mensaje de un error de red trae la URL interna del upstream.
 */
function opcionesLogger(nivel: string, destino?: Writable): FastifyServerOptions['logger'] {
  return {
    level: nivel,
    base: { servicio: 'gateway' },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    serializers: {
      req: () => ({}),
      res: () => ({}),
      err: (error: Error & { code?: unknown }) =>
        ({
          type: error.name,
          ...(typeof error.code === 'string' ? { code: error.code } : {}),
        }) as unknown as { type: string; message: string; stack: string },
    },
    ...(destino ? { stream: destino } : {}),
  };
}

function limitar(limitador: Limitador, clave: string, contexto: ContextoPeticion): void {
  const { permitido, reintentarEnSegundos } = limitador.contar(clave);
  if (permitido) return;
  contexto.motivo = 'limite';
  throw new ErrorBorde(429, 'Too many requests; retry later', {
    cabeceras: { 'Retry-After': String(reintentarEnSegundos) },
  });
}

function responderError(respuesta: FastifyReply, error: ErrorBorde): FastifyReply {
  return respuesta
    .code(error.status)
    .headers(error.cabeceras)
    .header('content-type', CONTENT_TYPE_PROBLEMA)
    .header('cache-control', 'no-store')
    .send(JSON.stringify(error.problema()));
}

function motivoDeSeguridad(status: number): string {
  if (status === 401) return 'token';
  if (status === 403) return 'scope';
  return 'jwks';
}

/** Un fallo hablando con el upstream, en un error del borde sin su URL ni su mensaje. */
function errorDeUpstream(
  error: unknown,
  contexto: ContextoPeticion,
  peticion: FastifyRequest,
): ErrorBorde {
  if (!(error instanceof ErrorUpstream)) {
    contexto.motivo = 'caido';
    return new ErrorBorde(502, 'The upstream service is not available');
  }
  contexto.motivo = error.tipo;
  if (error.tipo === 'cuerpo-grande') return new ErrorBorde(413, 'The request body is too large');
  peticion.log.warn(
    {
      upstream: contexto.upstream,
      tipo: error.tipo,
      ...(error.codigo ? { codigo: error.codigo } : {}),
    },
    'Fallo del upstream',
  );
  if (error.tipo === 'plazo') {
    return new ErrorBorde(504, 'The upstream service did not respond in time');
  }
  return new ErrorBorde(502, 'The upstream service is not available');
}

/**
 * El esquema con que llegó el cliente: con proxies de confianza delante (TLS termina en el
 * ingress), el X-Forwarded-Proto que agregó el más cercano; sin ellos, el del socket.
 */
function esquemaDe(peticion: FastifyRequest, saltos: number): 'http' | 'https' {
  if (saltos > 0) {
    const valor = peticion.headers['x-forwarded-proto'];
    const ultimo = (Array.isArray(valor) ? valor.join(',') : (valor ?? ''))
      .split(',')
      .pop()
      ?.trim()
      .toLowerCase();
    if (ultimo === 'http' || ultimo === 'https') return ultimo;
  }
  return peticion.raw.socket instanceof TLSSocket ? 'https' : 'http';
}

function agregarVary(respuesta: FastifyReply, valor: string): void {
  const actual = respuesta.getHeader('vary');
  const lista = String(actual ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (lista.some((v) => v === '*' || v.toLowerCase() === valor.toLowerCase())) return;
  respuesta.header('vary', [...lista, valor].join(', '));
}
