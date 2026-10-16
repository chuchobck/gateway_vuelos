import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { GatewayDePrueba, Servicios } from './utils/gateway';

const sha256 = (datos: Buffer) => createHash('sha256').update(datos).digest('hex');

/** El proxy no transforma: lo que manda el upstream llega byte a byte, sin buffer ni recompresión. */
describe('streaming', () => {
  const servicios = new Servicios();
  let gateway: GatewayDePrueba;

  beforeAll(async () => {
    await servicios.iniciar();
    gateway = await new GatewayDePrueba(servicios).iniciar();
  });
  afterAll(async () => {
    await gateway.detener();
    await servicios.detener();
  });
  beforeEach(() => servicios.reiniciar());

  it('un archivo grande (8 MB) llega idéntico, en trozos', async () => {
    const grande = randomBytes(8 * 1024 * 1024);
    servicios.upstreams.core.manejador = (_p, r) => {
      r.writeHead(200, { 'content-type': 'application/octet-stream' });
      // En trozos y sin Content-Length: el gateway no puede esperar a tenerlo entero
      let i = 0;
      const escribir = () => {
        while (i < grande.length) {
          const trozo = grande.subarray(i, i + 256 * 1024);
          i += trozo.length;
          if (!r.write(trozo)) return void r.once('drain', escribir);
        }
        r.end();
      };
      escribir();
    };
    const respuesta = await gateway.pedir({ ruta: '/flights/v1/flights/QN1/status' });
    expect(respuesta.status).toBe(200);
    expect(respuesta.cuerpo.length).toBe(grande.length);
    expect(sha256(respuesta.cuerpo)).toBe(sha256(grande));
  });

  it('un PDF y una imagen llegan idénticos y con su Content-Type y Content-Length', async () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      randomBytes(300_000),
      Buffer.from('%%EOF'),
    ]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(50_000),
    ]);
    for (const [tipo, datos] of [
      ['application/pdf', pdf],
      ['image/png', png],
    ] as const) {
      servicios.upstreams.core.manejador = (_p, r) => {
        r.writeHead(200, {
          'content-type': tipo,
          'content-length': datos.length,
          'content-disposition': 'attachment; filename="pase.pdf"',
        });
        r.end(datos);
      };
      const token = await gateway.token({ scope: 'flights:read' });
      const respuesta = await gateway.pedir({
        ruta: '/flights/v1/bookings/1b4e28ba-2fa1-11d2-883f-0016d3cca427/boarding-passes',
        cabeceras: { authorization: `Bearer ${token}` },
      });
      expect(respuesta.cabeceras['content-type']).toBe(tipo);
      expect(respuesta.cabeceras['content-length']).toBe(String(datos.length));
      expect(respuesta.cabeceras['content-disposition']).toBe('attachment; filename="pase.pdf"');
      expect(sha256(respuesta.cuerpo)).toBe(sha256(datos));
    }
  });

  it('gzip no se descomprime ni se recomprime', async () => {
    const comprimido = gzipSync(Buffer.from(JSON.stringify({ texto: 'quinde '.repeat(5000) })));
    servicios.upstreams.bff.manejador = (_p, r) => {
      r.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': comprimido.length,
      });
      r.end(comprimido);
    };
    const respuesta = await gateway.pedir({
      metodo: 'POST',
      ruta: '/graphql',
      cabeceras: { 'accept-encoding': 'gzip' },
      cuerpo: '{}',
    });
    expect(respuesta.cabeceras['content-encoding']).toBe('gzip');
    expect(respuesta.cabeceras['content-length']).toBe(String(comprimido.length));
    expect(sha256(respuesta.cuerpo)).toBe(sha256(comprimido));
    expect(servicios.upstreams.bff.ultima().cabeceras['accept-encoding']).toBe('gzip');
  });

  it('el cuerpo de la petición llega idéntico (binario, con y sin Content-Length)', async () => {
    const cuerpo = randomBytes(90_000);
    for (const enTrozos of [false, true]) {
      servicios.reiniciar();
      const respuesta = await gateway.pedir({
        metodo: 'POST',
        ruta: '/flights/v1/search',
        cabeceras: { 'content-type': 'application/octet-stream' },
        cuerpo,
        enTrozos,
      });
      expect(respuesta.status).toBe(200);
      const recibida = servicios.upstreams.core.ultima();
      expect(sha256(recibida.cuerpo)).toBe(sha256(cuerpo));
      if (!enTrozos) expect(recibida.cabeceras['content-length']).toBe(String(cuerpo.length));
    }
  });

  it('204 y 304 pasan sin cuerpo; HEAD también', async () => {
    servicios.upstreams.core.manejador = (p, r) => {
      if (p.method === 'HEAD') {
        r.writeHead(200, { 'content-type': 'application/json', 'content-length': '123' }).end();
        return;
      }
      r.writeHead(p.url?.includes('QN304') ? 304 : 204, { etag: '"v2"' }).end();
    };
    const sinContenido = await gateway.pedir({ ruta: '/flights/v1/flights/QN204/status' });
    expect(sinContenido.status).toBe(204);
    expect(sinContenido.cuerpo.length).toBe(0);
    const noModificado = await gateway.pedir({
      ruta: '/flights/v1/flights/QN304/status',
      cabeceras: { 'if-none-match': '"v2"' },
    });
    expect(noModificado.status).toBe(304);
    expect(noModificado.cabeceras.etag).toBe('"v2"');
    const cabeza = await gateway.pedir({ metodo: 'HEAD', ruta: '/flights/v1/flights/QN1/status' });
    expect(cabeza.status).toBe(200);
    expect(cabeza.cabeceras['content-length']).toBe('123');
  });
});
