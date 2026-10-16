import { IncomingHttpHeaders, OutgoingHttpHeaders, request } from 'node:http';

export interface Respuesta {
  status: number;
  cabeceras: IncomingHttpHeaders;
  crudas: string[];
  cuerpo: Buffer;
  texto: string;
  json: () => Record<string, unknown>;
}

export interface Pedido {
  metodo?: string;
  /** Tal cual: sin normalizar (fetch resolvería `..` y `%2e` antes de enviar). */
  ruta: string;
  cabeceras?: OutgoingHttpHeaders;
  cuerpo?: Buffer | string;
  /** Enviar el cuerpo en trozos sin Content-Length (Transfer-Encoding: chunked). */
  enTrozos?: boolean;
}

/** Una petición HTTP con la ruta exacta que se le da, como la mandaría un atacante. */
export function pedir(base: string, pedido: Pedido): Promise<Respuesta> {
  const url = new URL(base);
  return new Promise((resolver, rechazar) => {
    const cabeceras: OutgoingHttpHeaders = { ...pedido.cabeceras };
    if (
      pedido.cuerpo !== undefined &&
      !pedido.enTrozos &&
      cabeceras['content-length'] === undefined
    ) {
      cabeceras['content-length'] = Buffer.byteLength(pedido.cuerpo);
    }
    const salida = request(
      {
        hostname: url.hostname,
        port: url.port,
        method: pedido.metodo ?? 'GET',
        path: pedido.ruta,
        headers: cabeceras,
        agent: false,
      },
      (respuesta) => {
        const trozos: Buffer[] = [];
        respuesta.on('data', (t: Buffer) => trozos.push(t));
        respuesta.on('end', () => {
          const cuerpo = Buffer.concat(trozos);
          const texto = cuerpo.toString('utf8');
          resolver({
            status: respuesta.statusCode ?? 0,
            cabeceras: respuesta.headers,
            crudas: respuesta.rawHeaders,
            cuerpo,
            texto,
            json: () => JSON.parse(texto) as Record<string, unknown>,
          });
        });
        respuesta.on('error', rechazar);
      },
    );
    salida.on('error', rechazar);
    if (pedido.cuerpo === undefined) {
      salida.end();
    } else if (pedido.enTrozos) {
      const datos = Buffer.from(pedido.cuerpo);
      const mitad = Math.floor(datos.length / 2);
      salida.write(datos.subarray(0, mitad));
      setImmediate(() => salida.end(datos.subarray(mitad)));
    } else {
      salida.end(pedido.cuerpo);
    }
  });
}
