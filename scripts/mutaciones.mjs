#!/usr/bin/env node
// "Rompe a propósito lo que cada prueba cubre": aplica una mutación al código (quitar el bloqueo de
// /internal, aceptar alg none, confiar a ciegas en X-Forwarded-For, reintentar un POST...), corre
// la prueba que la debería detectar y exige que FALLE. Restaura los archivos siempre, también si se
// corta con Ctrl+C. Una prueba que no falla al romper lo que cubre no prueba nada.
//
//   npm run test:mutaciones                 (todas; no necesita nada más que Node)
//   npm run test:mutaciones -- alg-none     (solo las que contienen ese texto en el nombre)
//
// Una mutación cuyo texto ya no está en el código (alguien cambió esa línea) cuenta como fallo
// del script: hay que actualizarla aquí. No corre en CI: tarda un par de minutos.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const APP = 'src/app.ts';
const RESOLVER = 'src/rutas/resolver-ruta.ts';
const NORMALIZAR = 'src/rutas/normalizar-ruta.ts';
const VERIFICADOR = 'src/seguridad/verificador-jwks.ts';
const CLAVES = 'src/seguridad/claves-jwks.ts';
const AUTORIZAR = 'src/seguridad/autorizar.ts';
const CABECERAS = 'src/proxy/cabeceras.ts';
const CLIENTE = 'src/proxy/cliente-upstream.ts';
const REQUEST_ID = 'src/common/request-id.ts';
const TRAZAS = 'src/observabilidad/trazas.ts';
const GANCHO = 'src/observabilidad/fastify.ts';
const TABLA = 'src/rutas/tabla-rutas.ts';
const CORRELACION = 'src/common/correlation-id.ts';

const RUTAS = 'test/rutas.spec.ts';
const AUTH = 'test/auth.spec.ts';
const CABECERAS_PRUEBA = 'test/cabeceras.spec.ts';
const LIMITES = 'test/limites.spec.ts';
const FALLOS = 'test/fallos.spec.ts';
const ESCANEO = 'test/escaneo.spec.ts';
const TRAZAS_PRUEBA = 'test/trazas.spec.ts';
const METRICAS_PRUEBA = 'test/metricas.spec.ts';
const RESILIENCIA = 'test/resiliencia.spec.ts';
const V2_RUTAS = 'test/v2-rutas.spec.ts';
const PARTNER = 'test/usuario-partner.spec.ts';
const CORRELACION_PRUEBA = 'test/correlacion.spec.ts';

/**
 * nombre, cambios por archivo [{ archivo, cambios: [buscar, reemplazar] }], prueba y filtro (-t)
 * que debe fallar.
 */
const MUTACIONES = [
  // --- las que pide la fase --------------------------------------------------------------------
  {
    nombre: 'bloqueo-internal: /internal/** deja de evaluarse antes que la tabla',
    archivos: [
      {
        archivo: RESOLVER,
        cambios: [
          [
            'if (RUTAS_BLOQUEADAS.some((patron) => coincide(patron, ruta.clave))) {',
            'if (false) {',
          ],
        ],
      },
    ],
    prueba: RUTAS,
    filtro: 'ni una regla que lo cubriera',
  },
  {
    nombre: 'sin-normalizacion: ., .., %2f y %25 pasan sin rechazarse',
    archivos: [
      {
        archivo: NORMALIZAR,
        cambios: [
          ['      if (DECODIFICADO_PROHIBIDO.test(decodificado)) throw ambigua();\n', ''],
          ["      if (decodificado === '.' || decodificado === '..') throw ambigua();\n", ''],
        ],
      },
    ],
    prueba: RUTAS,
    filtro: 'lo ambiguo es 400',
  },
  {
    nombre: 'alg-none: el verificador acepta un token sin firma',
    archivos: [
      {
        archivo: VERIFICADOR,
        cambios: [
          [
            '    let payload: Record<string, unknown>;\n    try {',
            "    let payload: Record<string, unknown>;\n    const jose = require('jose');\n    if (jose.decodeProtectedHeader(token).alg === 'none') {\n      const c = jose.decodeJwt(token);\n      return { sub: String(c.sub), scopes: String(c.scope).split(' '), jti: 'x' };\n    }\n    try {",
          ],
        ],
      },
    ],
    prueba: AUTH,
    filtro: 'alg none',
  },
  {
    nombre: 'sin-scope: se salta el chequeo de scopes',
    archivos: [{ archivo: AUTORIZAR, cambios: [['  if (!cumple) {', '  if (false) {']] }],
    prueba: AUTH,
    filtro: 'insufficient_scope sin llamar al upstream',
  },
  {
    nombre: 'xff-a-ciegas: la IP del cliente sale de X-Forwarded-For sin mirar los saltos',
    archivos: [
      {
        archivo: APP,
        cambios: [
          [
            "        peticion.headers['x-forwarded-for'],\n        configuracion.saltosProxy,",
            "        peticion.headers['x-forwarded-for'],\n        10,",
          ],
        ],
      },
    ],
    prueba: LIMITES,
    filtro: 'falsificado no cambia la IP',
  },
  {
    nombre: 'cors-upstream: el Access-Control-* del upstream llega al cliente',
    archivos: [
      {
        archivo: CABECERAS,
        cambios: [
          [
            "nombre.startsWith('access-control-')) continue;",
            "nombre.startsWith('acc-nunca-')) continue;",
          ],
        ],
      },
    ],
    prueba: CABECERAS_PRUEBA,
    filtro: 'CORS',
  },
  {
    nombre: 'mensaje-upstream: el 502 lleva el mensaje del error de red (con la URL interna)',
    archivos: [
      {
        archivo: CLIENTE,
        cambios: [
          [
            "rechazar(\n          error instanceof ErrorUpstream ? error : new ErrorUpstream('caido', codigoDe(error)),\n        );",
            "rechazar(\n          error instanceof ErrorUpstream ? error : Object.assign(new ErrorUpstream('caido', codigoDe(error)), { message: (error as Error).message }),\n        );",
          ],
        ],
      },
      {
        archivo: APP,
        cambios: [
          [
            "  return new ErrorBorde(502, 'The upstream service is not available');\n}",
            '  return new ErrorBorde(502, error.message);\n}',
          ],
        ],
      },
    ],
    prueba: FALLOS,
    filtro: 'sin su URL ni su mensaje',
  },
  {
    nombre: 'sin-aud: no se valida la audiencia',
    archivos: [
      { archivo: VERIFICADOR, cambios: [['        audience: this.config.audiencia,\n', '']] },
    ],
    prueba: AUTH,
    filtro: 'aud ajena',
  },
  {
    nombre: 'log-authorization: la línea de acceso lleva el Authorization',
    archivos: [
      {
        archivo: APP,
        cambios: [
          [
            '          ruta: peticion.observacion?.ruta ?? RUTA_SIN_PLANTILLA,',
            '          ruta: peticion.observacion?.ruta ?? RUTA_SIN_PLANTILLA,\n          authorization: peticion.headers.authorization,',
          ],
        ],
      },
    ],
    prueba: ESCANEO,
    filtro: 'los logs no contienen',
  },
  {
    nombre: 'reintento-post: un fallo del upstream se reintenta una vez',
    archivos: [
      {
        archivo: APP,
        cambios: [
          [
            '    } catch (error) {\n      const errorBorde = errorDeUpstream(error, contexto, peticion);',
            "    } catch (primero) {\n      try {\n        respuestaUpstream = await cliente.reenviar({ metodo: peticion.method, rutaYQuery: ruta.ruta, cabeceras: cabecerasHaciaUpstream(peticion.headers, { requestId: peticion.id, ipCliente: contexto.ip, esquema: 'http', hostPublico: undefined, hostUpstream: cliente.host, traceparent: traceparentDe(spanUpstream) }), cuerpo: undefined, cuerpoMaximo: regla.cuerpoMaximo });\n      } catch {\n      const error = primero;\n      const errorBorde = errorDeUpstream(error, contexto, peticion);",
          ],
          [
            "      terminarUpstream('error');\n      throw errorBorde;\n    }",
            "      terminarUpstream('error');\n      throw errorBorde;\n      }\n    }",
          ],
        ],
      },
    ],
    prueba: FALLOS,
    filtro: 'NUNCA se reintenta',
  },

  // --- otras defensas del borde ----------------------------------------------------------------
  {
    nombre: 'hs256: se acepta HS256 con la clave pública como secreto',
    archivos: [
      {
        archivo: VERIFICADOR,
        cambios: [
          ['algorithms: [ALGORITMO_EXTERNO],', "algorithms: [ALGORITMO_EXTERNO, 'HS256'],"],
          [
            '    if (clave === undefined) throw new errors.JWKSNoMatchingKey();\n    return clave;',
            "    if (clave === undefined) throw new errors.JWKSNoMatchingKey();\n    if (cabecera.alg === 'HS256') return new TextEncoder().encode(require('node:crypto').KeyObject.from(clave).export({ type: 'spki', format: 'pem' })) as unknown as CryptoKey;\n    return clave;",
          ],
        ],
      },
    ],
    prueba: AUTH,
    filtro: 'HS256 con la clave pública',
  },
  {
    nombre: 'jwks-caido-pasa: sin claves con qué verificar, se deja pasar',
    archivos: [
      {
        archivo: AUTORIZAR,
        cambios: [
          [
            '    if (error instanceof JwksNoDisponibleError) {\n',
            '    if (error instanceof JwksNoDisponibleError) {\n      return undefined;\n',
          ],
        ],
      },
    ],
    prueba: AUTH,
    filtro: 'JWKS caído',
  },
  {
    nombre: 'sin-enfriamiento: cada kid inventado provoca una descarga del JWKS',
    archivos: [
      {
        archivo: CLAVES,
        cambios: [['export const ENFRIAMIENTO_MS = 10_000;', 'export const ENFRIAMIENTO_MS = 0;']],
      },
    ],
    prueba: AUTH,
    filtro: 'a lo sumo una descarga',
  },
  {
    nombre: 'request-id-sin-validar: cualquier X-Request-Id del cliente se conserva',
    archivos: [
      {
        archivo: REQUEST_ID,
        cambios: [
          [
            "if (typeof recibido === 'string' && FORMATO_REQUEST_ID.test(recibido)) {",
            "if (typeof recibido === 'string') {",
          ],
        ],
      },
    ],
    prueba: CABECERAS_PRUEBA,
    filtro: 'se reemplaza por un uuid nuevo',
  },
  {
    nombre: 'cuerpo-sin-tope: un Content-Length de más llega al upstream',
    archivos: [
      {
        archivo: APP,
        cambios: [['    if (declarado > regla.cuerpoMaximo) {', '    if (false) {']],
      },
    ],
    prueba: LIMITES,
    filtro: 'con Content-Length',
  },
  {
    nombre: 'x-forwarded-del-cliente: los X-Forwarded-* del cliente llegan al upstream',
    archivos: [
      {
        archivo: CABECERAS,
        cambios: [
          [
            "    if (DEL_CLIENTE_QUE_NO_PASAN.has(nombre) || nombre.startsWith('x-forwarded-')) continue;",
            '    if (DEL_CLIENTE_QUE_NO_PASAN.has(nombre)) continue;',
          ],
        ],
      },
    ],
    prueba: CABECERAS_PRUEBA,
    filtro: 'fuera hop-by-hop y lo que el cliente no puede dictar',
  },
  {
    nombre: 'mayusculas: se decide distinguiendo mayúsculas (Express no las distingue)',
    archivos: [
      {
        archivo: NORMALIZAR,
        cambios: [
          [
            "    clave: '/' + segmentos.map((s) => s.toLowerCase()).join('/'),",
            "    clave: '/' + segmentos.join('/'),",
          ],
        ],
      },
    ],
    prueba: RUTAS,
    filtro: 'no cae en el core aunque venga en mayúsculas',
  },
  // --- observabilidad (fase 7a) ----------------------------------------------------------------
  {
    nombre:
      'romper-propagacion: hacia el upstream va el traceparent del cliente, no el del gateway',
    archivos: [
      {
        archivo: APP,
        cambios: [
          [
            '          traceparent: traceparentDe(spanUpstream),',
            "          traceparent: String(peticion.headers.traceparent ?? ''),",
          ],
        ],
      },
    ],
    prueba: TRAZAS_PRUEBA,
    filtro: 'propagación',
  },
  {
    nombre: 'ruta-cruda: la etiqueta route y el nombre del span son la ruta pedida',
    archivos: [
      {
        archivo: APP,
        cambios: [
          [
            "    if (decision.tipo === 'ruta') fijarRuta(peticion, decision.plantilla);",
            '    fijarRuta(peticion, ruta.ruta);',
          ],
        ],
      },
    ],
    prueba: METRICAS_PRUEBA,
    filtro: '1000 rutas distintas',
  },
  {
    nombre: 'confiar-siempre: el traceparent entrante se continúa sin TRACE_TRUST_INCOMING',
    archivos: [
      {
        archivo: TRAZAS,
        cambios: [['    if (!this.config.confiarEntrante) return ROOT_CONTEXT;\n', '']],
      },
    ],
    prueba: TRAZAS_PRUEBA,
    filtro: 'raíz nueva por defecto',
  },
  {
    nombre: 'atributo-sensible: el span raíz lleva el Authorization y la URL con su query',
    archivos: [
      {
        archivo: GANCHO,
        cambios: [
          [
            '  const observacion: ObservacionPeticion = {',
            "  span.setAttribute('http.request.header.authorization', String(peticion.headers.authorization));\n  span.setAttribute('url.full', String(peticion.raw.url));\n  const observacion: ObservacionPeticion = {",
          ],
        ],
      },
    ],
    prueba: TRAZAS_PRUEBA,
    filtro: 'ni los spans ni los logs',
  },
  {
    nombre: 'metrics-publico: /metrics se responde en el puerto principal',
    archivos: [
      {
        archivo: APP,
        cambios: [
          [
            '    const decision = resolver.decidir(peticion.method, ruta);',
            "    if (ruta.clave === '/metrics') return respuesta.send(await metricas.exponer());\n    const decision = resolver.decidir(peticion.method, ruta);",
          ],
        ],
      },
    ],
    prueba: METRICAS_PRUEBA,
    filtro: '/metrics en el puerto aparte',
  },
  {
    nombre: 'exportador-bloquea: cada respuesta espera a que el recolector reciba los spans',
    archivos: [
      {
        archivo: GANCHO,
        cambios: [
          [
            '    const observacion = peticion.observacion;\n    if (observacion) respuesta.header(',
            '    await (trazas as unknown as { proveedor: { forceFlush(): Promise<void> } }).proveedor.forceFlush();\n    const observacion = peticion.observacion;\n    if (observacion) respuesta.header(',
          ],
        ],
      },
    ],
    prueba: RESILIENCIA,
    filtro: 'recolector lento',
  },
  {
    nombre: 'x-user-sin-partner: X-User-Id y X-User-Roles pasan con cualquier token o sin él',
    archivos: [
      {
        archivo: CABECERAS,
        cambios: [
          ['    if (nombre.startsWith(PREFIJO_USUARIO) && !datos.partner) continue;\n', ''],
        ],
      },
    ],
    prueba: PARTNER,
    filtro: 'se borran',
  },
  {
    nombre: 'v2-sin-scopes: las rutas /api/v2 quedan públicas (sin el contrato v2)',
    archivos: [
      {
        archivo: TABLA,
        cambios: [
          [
            "const CONTRATO_V2: Seguridad = { modo: 'contrato', contrato: 'v2', noDeclarada: 'negar' };",
            "const CONTRATO_V2: Seguridad = { modo: 'publica' };",
          ],
        ],
      },
    ],
    prueba: V2_RUTAS,
    filtro: 'sin token → 401',
  },
  {
    nombre: 'v2-no-declarada-pasa: lo que el contrato v2 no declara llega al core con un token',
    archivos: [
      {
        archivo: RESOLVER,
        cambios: [["if (seguridad.noDeclarada === 'negar') return { tipo: 'no-declarada' };", '']],
      },
    ],
    prueba: V2_RUTAS,
    filtro: 'no está en el contrato v2',
  },
  {
    nombre: 'correlation-cambiado: el X-Correlation-Id recibido se "normaliza" a minúsculas',
    archivos: [
      {
        archivo: CORRELACION,
        cambios: [
          [
            'return esCorrelationIdValido(valor) ? valor : `corr-${randomUUID()}`;',
            'return esCorrelationIdValido(valor) ? valor.toLowerCase() : `corr-${randomUUID()}`;',
          ],
        ],
      },
    ],
    prueba: CORRELACION_PRUEBA,
    filtro: 'se conserva sin cambios',
  },
  {
    nombre: 'correlation-sin-error: un error no devuelve el X-Correlation-Id',
    archivos: [
      {
        archivo: GANCHO,
        cambios: [
          [
            '      respuesta.header(CABECERA_CORRELATION_ID, observacion.correlationId);',
            '      if (respuesta.statusCode < 400) {\n        respuesta.header(CABECERA_CORRELATION_ID, observacion.correlationId);\n      }',
          ],
        ],
      },
    ],
    prueba: CORRELACION_PRUEBA,
    filtro: 'en los errores del borde',
  },
];
const filtroNombre = process.argv[2];
const elegidas = MUTACIONES.filter((m) => !filtroNombre || m.nombre.includes(filtroNombre));
const resultados = [];
const originales = new Map();

function restaurar() {
  for (const [archivo, contenido] of originales) writeFileSync(archivo, contenido);
  originales.clear();
}

// Ctrl+C a mitad de una mutación: se restauran los archivos antes de salir
process.on('SIGINT', () => {
  restaurar();
  process.exit(130);
});

for (const mutacion of elegidas) {
  const mutados = [];
  let aplicable = true;
  for (const { archivo, cambios } of mutacion.archivos) {
    const original = readFileSync(archivo, 'utf8');
    if (cambios.some(([buscar]) => original.split(buscar).length !== 2)) {
      aplicable = false;
      break;
    }
    let mutado = original;
    for (const [buscar, reemplazar] of cambios) mutado = mutado.replace(buscar, () => reemplazar);
    mutados.push({ archivo, original, mutado });
  }
  if (!aplicable) {
    resultados.push({ ...mutacion, estado: 'NO APLICABLE (el texto ya no está una sola vez)' });
    continue;
  }

  try {
    for (const { archivo, original, mutado } of mutados) {
      originales.set(archivo, original);
      writeFileSync(archivo, mutado);
    }
    const corrida = spawnSync(
      'npx',
      ['jest', '--runInBand', '--forceExit', mutacion.prueba, '-t', mutacion.filtro],
      { encoding: 'utf8', timeout: 180_000 },
    );
    const salida = `${corrida.stdout}${corrida.stderr}`;
    const fallidas = salida.match(/Tests:\s+(\d+) failed/)?.[1] ?? '0';
    resultados.push({
      ...mutacion,
      estado:
        corrida.status !== 0 && fallidas !== '0'
          ? `DETECTADA (${fallidas} prueba(s) fallan)`
          : 'SOBREVIVIÓ',
    });
  } finally {
    restaurar();
  }
}

for (const r of resultados) {
  console.log(
    `${r.estado.startsWith('DETECTADA') ? 'ok ' : 'MAL'}  ${r.nombre}\n     ${r.prueba} -t "${r.filtro}" → ${r.estado}`,
  );
}
const malas = resultados.filter((r) => !r.estado.startsWith('DETECTADA'));
console.log(`\n${resultados.length - malas.length} de ${resultados.length} mutaciones detectadas`);
process.exit(malas.length === 0 ? 0 : 1);
