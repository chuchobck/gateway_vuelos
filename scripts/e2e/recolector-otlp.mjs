#!/usr/bin/env node
// Recolector OTLP/HTTP falso para scripts/e2e-local.sh: recibe POST /v1/traces en JSON (lo que
// manda @opentelemetry/exporter-trace-otlp-http) y escribe un span por línea en RECOLECTOR_ARCHIVO:
// servicio, traceId, spanId, parentSpanId, nombre, tipo (OTLP: 1 interno, 2 servidor, 3 cliente),
// atributos y estado. Sustituye a Jaeger cuando no hay Docker.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const puerto = Number(process.env.RECOLECTOR_PORT ?? 4318);
const archivo = process.env.RECOLECTOR_ARCHIVO ?? 'spans.jsonl';

const aplanar = (atributos = []) =>
  Object.fromEntries(atributos.map(({ key, value }) => [key, Object.values(value)[0]]));

createServer((peticion, respuesta) => {
  const trozos = [];
  peticion.on('data', (t) => trozos.push(t));
  peticion.on('end', () => {
    if (peticion.method !== 'POST' || peticion.url !== '/v1/traces') {
      respuesta.writeHead(404).end();
      return;
    }
    try {
      const cuerpo = JSON.parse(Buffer.concat(trozos).toString('utf8'));
      for (const rs of cuerpo.resourceSpans ?? []) {
        const recurso = aplanar(rs.resource?.attributes);
        for (const ss of rs.scopeSpans ?? []) {
          for (const s of ss.spans ?? []) {
            const linea = {
              tipoContenido: peticion.headers['content-type'],
              recurso,
              traceId: s.traceId,
              spanId: s.spanId,
              parentSpanId: s.parentSpanId ?? '',
              nombre: s.name,
              tipo: s.kind,
              atributos: aplanar(s.attributes),
              estado: s.status ?? {},
            };
            appendFileSync(archivo, JSON.stringify(linea) + '\n');
          }
        }
      }
      respuesta.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } catch {
      respuesta.writeHead(400).end();
    }
  });
}).listen(puerto, '127.0.0.1', () => console.log(`recolector OTLP en http://127.0.0.1:${puerto}`));
