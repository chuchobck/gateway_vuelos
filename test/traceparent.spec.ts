import {
  escribirTraceparent,
  leerTraceparent,
  tracestateAcotado,
} from '../src/observabilidad/traceparent';
import { filtrarAtributos, metodoNormalizado } from '../src/observabilidad/atributos';
import { plantillaDePatron } from '../src/rutas/tabla-rutas';

const TRAZA = '4bf92f3577b34da6a3ce929d0e0e4736';
const PADRE = '00f067aa0ba902b7';

describe('traceparent (W3C Trace Context)', () => {
  it('lee la versión 00 con su bit de muestreo', () => {
    expect(leerTraceparent(`00-${TRAZA}-${PADRE}-01`)).toEqual({
      traceId: TRAZA,
      parentId: PADRE,
      muestreado: true,
    });
    expect(leerTraceparent(`00-${TRAZA}-${PADRE}-00`)?.muestreado).toBe(false);
    // Otros bits de banderas no cambian el de muestreo
    expect(leerTraceparent(`00-${TRAZA}-${PADRE}-03`)?.muestreado).toBe(true);
    expect(leerTraceparent(`00-${TRAZA}-${PADRE}-02`)?.muestreado).toBe(false);
  });

  it.each([
    ['falta', undefined],
    ['vacío', ''],
    ['versión ff (prohibida)', `ff-${TRAZA}-${PADRE}-01`],
    ['versión 01 (no la sabemos leer)', `01-${TRAZA}-${PADRE}-01`],
    ['trace-id en ceros', `00-${'0'.repeat(32)}-${PADRE}-01`],
    ['parent-id en ceros', `00-${TRAZA}-${'0'.repeat(16)}-01`],
    ['mayúsculas', `00-${TRAZA.toUpperCase()}-${PADRE}-01`],
    ['trace-id corto', `00-${TRAZA.slice(1)}-${PADRE}-01`],
    ['parent-id largo', `00-${TRAZA}-${PADRE}0-01`],
    ['banderas de un dígito', `00-${TRAZA}-${PADRE}-1`],
    ['campos extra', `00-${TRAZA}-${PADRE}-01-extra`],
    ['separadores malos', `00_${TRAZA}_${PADRE}_01`],
    ['no hex', `00-${'g'.repeat(32)}-${PADRE}-01`],
    [
      'cabecera repetida (Node las une con coma)',
      `00-${TRAZA}-${PADRE}-01, 00-${TRAZA}-${PADRE}-01`,
    ],
    ['un arreglo', [`00-${TRAZA}-${PADRE}-01`]],
    ['basura', '}{"level":60}'],
  ])('%s → se descarta sin error', (_caso, valor) => {
    expect(() => leerTraceparent(valor as string)).not.toThrow();
    expect(leerTraceparent(valor as string)).toBeUndefined();
  });

  it('escribe 00-<traza>-<span>-<01|00>', () => {
    expect(escribirTraceparent(TRAZA, PADRE, true)).toBe(`00-${TRAZA}-${PADRE}-01`);
    expect(escribirTraceparent(TRAZA, PADRE, false)).toBe(`00-${TRAZA}-${PADRE}-00`);
    expect(leerTraceparent(escribirTraceparent(TRAZA, PADRE, true))).toBeDefined();
  });
});

describe('tracestate', () => {
  it('pasa tal cual dentro del tope', () => {
    expect(tracestateAcotado('congo=t61rcWkgMzE,rojo=00f067aa0ba902b7')).toBe(
      'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7',
    );
    const justo = `a=${'x'.repeat(510)}`;
    expect(tracestateAcotado(justo)).toBe(justo);
  });

  it.each([
    ['más de 512 caracteres', `a=${'x'.repeat(511)}`],
    ['más de 32 miembros', Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(',')],
    ['caracteres de control', 'a=b\u0000c'],
    ['no ASCII', 'a=ñ'],
    ['vacío', ''],
  ])('%s → se descarta entero', (_caso, valor) => {
    expect(tracestateAcotado(valor)).toBeUndefined();
  });
});

describe('atributos y plantillas', () => {
  it('solo pasan los atributos permitidos, y error.type de la lista cerrada', () => {
    expect(
      filtrarAtributos({
        'http.route': '/flights/v1/bookings/{bookingId}',
        'http.request.header.authorization': 'Bearer x',
        'url.query': 'a=1',
        'client.address': '10.0.0.1',
        'user.email': 'ana@example.com',
        'error.type': 'ECONNREFUSED 10.0.0.5:3000',
        'quinde.upstream': 'core',
      }),
    ).toEqual({ 'http.route': '/flights/v1/bookings/{bookingId}', 'quinde.upstream': 'core' });
    expect(filtrarAtributos({ 'error.type': 'timeout' })).toEqual({ 'error.type': 'timeout' });
  });

  it('métodos fuera de la lista son _OTHER', () => {
    expect(metodoNormalizado('GET')).toBe('GET');
    expect(metodoNormalizado('PROPFIND')).toBe('_OTHER');
  });

  it('la plantilla de una regla: * es {id} y ** se deja', () => {
    expect(plantillaDePatron('/flights/v1/webhooks/*')).toBe('/flights/v1/webhooks/{id}');
    expect(plantillaDePatron('/identity/v1/**')).toBe('/identity/v1/**');
    expect(plantillaDePatron('/graphql')).toBe('/graphql');
  });
});
