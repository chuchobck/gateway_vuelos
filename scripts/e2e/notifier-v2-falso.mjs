#!/usr/bin/env node
// Notifier v2 falso para scripts/e2e-local.sh, mientras el notifier real no tenga sus rutas v2:
// escucha en NOTIFIER_FALSO_PORT (3003), responde él mismo /api/v2/vuelos/webhooks* y
// /api/v2/vuelos/eventos y reenvía todo lo demás al notifier real (NOTIFIER_REAL_URL, el 3002).
// De lo que responde anota una línea JSON por petición en NOTIFIER_FALSO_ARCHIVO, solo con lo que
// el recorrido comprueba: método, ruta sin query, X-Correlation-Id y si llegaron Authorization y
// X-User-Id (nunca sus valores).
import { appendFileSync } from 'node:fs';
import { createServer, request } from 'node:http';

const puerto = Number(process.env.NOTIFIER_FALSO_PORT ?? 3003);
const real = new URL(process.env.NOTIFIER_REAL_URL ?? 'http://127.0.0.1:3002');
const archivo = process.env.NOTIFIER_FALSO_ARCHIVO ?? 'notifier-v2.jsonl';
const PROPIAS = /^\/api\/v2\/vuelos\/(webhooks(\/[^/?]+)?|eventos)(\?|$)/;

createServer((peticion, respuesta) => {
  if (!PROPIAS.test(peticion.url ?? '')) {
    // Lo demás (/flights/v1/webhooks, /health) va al notifier real tal cual
    const salida = request(
      {
        host: real.hostname,
        port: real.port,
        method: peticion.method,
        path: peticion.url,
        headers: peticion.headers,
      },
      (r) => {
        respuesta.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(respuesta);
      },
    );
    salida.on('error', () => respuesta.writeHead(502).end());
    peticion.pipe(salida);
    return;
  }
  peticion.resume();
  peticion.on('end', () => {
    const anotada = {
      metodo: peticion.method,
      ruta: (peticion.url ?? '').split('?')[0],
      correlationId: peticion.headers['x-correlation-id'] ?? null,
      conAuthorization: peticion.headers.authorization !== undefined,
      conXUserId: peticion.headers['x-user-id'] !== undefined,
    };
    appendFileSync(archivo, JSON.stringify(anotada) + '\n');
    const correlacion = String(peticion.headers['x-correlation-id'] ?? '');
    respuesta.writeHead(200, {
      'content-type': 'application/json',
      'x-correlation-id': correlacion,
    });
    respuesta.end(
      JSON.stringify(
        anotada.ruta.endsWith('/eventos')
          ? { eventos: [], next_cursor: null, servido_por: 'notifier-v2-falso' }
          : { data: [], servido_por: 'notifier-v2-falso' },
      ),
    );
  });
}).listen(puerto, '127.0.0.1', () =>
  console.log(`notifier v2 falso en http://127.0.0.1:${puerto}`),
);
