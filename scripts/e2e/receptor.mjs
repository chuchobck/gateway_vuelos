#!/usr/bin/env node
// Receptor de webhooks para scripts/e2e-local.sh: escucha en RECEPTOR_PORT (4010) y anota cada
// POST (cabeceras X-Webhook-* y el cuerpo crudo en base64) como una línea JSON en RECEPTOR_ARCHIVO.
// Responde 200. No verifica la firma: eso lo hace el script, con openssl, para no confiar en él.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const puerto = Number(process.env.RECEPTOR_PORT ?? 4010);
const archivo = process.env.RECEPTOR_ARCHIVO ?? 'receptor.jsonl';

createServer((peticion, respuesta) => {
  const trozos = [];
  peticion.on('data', (t) => trozos.push(t));
  peticion.on('end', () => {
    const cuerpo = Buffer.concat(trozos);
    const cabeceras = Object.fromEntries(
      Object.entries(peticion.headers).filter(([n]) => n.startsWith('x-webhook-')),
    );
    appendFileSync(
      archivo,
      JSON.stringify({ ruta: peticion.url, cabeceras, cuerpo: cuerpo.toString('base64') }) + '\n',
    );
    respuesta.writeHead(200, { 'content-type': 'application/json' }).end('{"received":true}');
  });
}).listen(puerto, '127.0.0.1', () => console.log(`receptor en http://127.0.0.1:${puerto}`));
