// npm run rutas:listar [-- --markdown]
// Imprime la tabla de rutas del gateway tal como la aplica: ruta, método, destino, seguridad y
// scopes. Las operaciones del core salen de las copias de sus OpenAPI v1 y v2 (contracts/), igual
// que al arrancar. Con --markdown, la tabla de docs/RUTAS.md.
import { ContratoCore, RUTA_CONTRATO_V2 } from '../rutas/contrato-core';
import { Contratos } from '../rutas/resolver-ruta';
import { RUTAS_BLOQUEADAS, TABLA_RUTAS } from '../rutas/tabla-rutas';

interface Fila {
  ruta: string;
  metodo: string;
  destino: string;
  seguridad: string;
  scopes: string;
}

export function filasDeRutas(contratos: Contratos): Fila[] {
  const filas: Fila[] = RUTAS_BLOQUEADAS.map((patron) => ({
    ruta: patron,
    metodo: '*',
    destino: '— (404)',
    seguridad: 'bloqueada',
    scopes: '',
  }));

  for (const regla of TABLA_RUTAS) {
    const extra = regla.limiteEstricto ? ' + límite estricto' : '';
    if (regla.seguridad.modo !== 'contrato') {
      filas.push({
        ruta: regla.patron,
        metodo: regla.destino === 'gateway' ? 'GET' : '*',
        destino: regla.rutaUpstream ? `${regla.destino} → ${regla.rutaUpstream}` : regla.destino,
        seguridad: regla.seguridad.modo + extra,
        scopes: regla.seguridad.modo === 'token' ? regla.seguridad.scopes.join(' ') : '',
      });
      continue;
    }
    // Las operaciones del contrato que caen primero en esta regla (las de /webhooks van al notifier)
    const { contrato, noDeclarada } = regla.seguridad;
    for (const operacion of contratos[contrato].operaciones) {
      const clave = operacion.plantilla.toLowerCase();
      const primera = TABLA_RUTAS.find((r) => coincideConPlantilla(r.patron, clave));
      if (primera !== regla) continue;
      filas.push({
        ruta: operacion.plantilla,
        metodo: operacion.metodo,
        destino: regla.destino,
        seguridad: operacion.publica
          ? `publica (contrato ${contrato})`
          : `token (contrato ${contrato})`,
        scopes: operacion.publica ? '' : operacion.alternativas.map((a) => a.join(' ')).join(' | '),
      });
    }
    filas.push({
      ruta: regla.patron,
      metodo: '*',
      destino: noDeclarada === 'negar' ? '— (404)' : regla.destino,
      seguridad: `${noDeclarada === 'negar' ? 'negada' : 'token'} (fuera del contrato ${contrato})`,
      scopes: '',
    });
  }
  filas.push({
    ruta: '(cualquier otra)',
    metodo: '*',
    destino: '— (404)',
    seguridad: '',
    scopes: '',
  });
  return filas;
}

/** Una plantilla `{param}` se compara como un segmento cualquiera. */
function coincideConPlantilla(patron: string, plantilla: string): boolean {
  const partes = patron.slice(1).split('/');
  const segmentos = plantilla.slice(1).split('/');
  for (let i = 0; i < partes.length; i++) {
    if (partes[i] === '**') return true;
    if (segmentos[i] === undefined) return false;
    if (partes[i] !== '*' && partes[i] !== segmentos[i]) return false;
  }
  return partes.length === segmentos.length;
}

function imprimir(filas: Fila[], markdown: boolean): void {
  const columnas: (keyof Fila)[] = ['ruta', 'metodo', 'destino', 'seguridad', 'scopes'];
  const titulos: Record<keyof Fila, string> = {
    ruta: 'Ruta',
    metodo: 'Método',
    destino: 'Upstream',
    seguridad: 'Seguridad',
    scopes: 'Scopes',
  };
  if (markdown) {
    console.log(`| ${columnas.map((c) => titulos[c]).join(' | ')} |`);
    console.log(`|${columnas.map(() => ' --- ').join('|')}|`);
    for (const fila of filas) {
      console.log(`| ${columnas.map((c) => (fila[c] ? `\`${fila[c]}\`` : '')).join(' | ')} |`);
    }
    return;
  }
  const anchos = columnas.map((c) => Math.max(titulos[c].length, ...filas.map((f) => f[c].length)));
  const linea = (valores: string[]) =>
    valores
      .map((v, i) => v.padEnd(anchos[i] ?? 0))
      .join('  ')
      .trimEnd();
  console.log(linea(columnas.map((c) => titulos[c])));
  console.log(linea(anchos.map((a) => '-'.repeat(a))));
  for (const fila of filas) console.log(linea(columnas.map((c) => fila[c])));
}

if (require.main === module) {
  const contratos: Contratos = {
    v1: ContratoCore.leer(),
    v2: ContratoCore.leer(RUTA_CONTRATO_V2),
  };
  for (const [nombre, contrato] of Object.entries(contratos)) {
    console.log(
      `Contrato ${nombre} del core: ${contrato.version} (${contrato.operaciones.length} operaciones)`,
    );
  }
  console.log('');
  imprimir(filasDeRutas(contratos), process.argv.includes('--markdown'));
}
