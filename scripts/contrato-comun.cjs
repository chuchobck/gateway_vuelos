// Lo que comparten contrato:sync y contrato:check: de dónde salen los OpenAPI del core y cómo se bajan.
const path = require('node:path');

const REPO_CORE = process.env.CORE_REPO || 'chuchobck/backend_vuelos';

/** Las dos copias: el contrato v1 (/flights/v1) y el v2 (/api/v2, el de Booking Prototipo). */
const CONTRATOS = [
  { nombre: 'v1', ruta: 'contracts/vuelos-openapi.yaml' },
  { nombre: 'v2', ruta: 'contracts/vuelos-openapi-v2.yaml' },
].map((c) => ({ ...c, destino: path.join(__dirname, '..', c.ruta) }));

/** La rama del core: `--ref <rama>` o CORE_CONTRACT_REF; por defecto, main. */
function resolverRef(argv) {
  const i = argv.indexOf('--ref');
  if (i !== -1) {
    if (!argv[i + 1]) throw new Error('--ref necesita un valor (rama, etiqueta o commit)');
    return argv[i + 1];
  }
  return process.env.CORE_CONTRACT_REF || 'main';
}

/** Cuáles: `--contrato v1|v2`; por defecto, los dos. */
function resolverContratos(argv) {
  const i = argv.indexOf('--contrato');
  if (i === -1) return CONTRATOS;
  const elegido = CONTRATOS.filter((c) => c.nombre === argv[i + 1]);
  if (elegido.length === 0) throw new Error('--contrato tiene que ser v1 o v2');
  return elegido;
}

/** Baja un contrato de esa ref del core. CORE_CONTRACT_TOKEN es opcional (repo privado). */
async function bajarContrato(ref, ruta) {
  const url = `https://raw.githubusercontent.com/${REPO_CORE}/${ref.split('/').map(encodeURIComponent).join('/')}/${ruta}`;
  const cabeceras = process.env.CORE_CONTRACT_TOKEN
    ? { Authorization: `Bearer ${process.env.CORE_CONTRACT_TOKEN}` }
    : {};
  const respuesta = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(15_000) });
  if (!respuesta.ok) {
    throw new Error(`No se pudo bajar ${ruta} de ${REPO_CORE}@${ref} (HTTP ${respuesta.status}).`);
  }
  return normalizar(await respuesta.text());
}

/** Compara sin que un CRLF de Windows cuente como diferencia. */
function normalizar(texto) {
  return texto.replace(/\r\n/g, '\n');
}

module.exports = {
  REPO_CORE,
  CONTRATOS,
  resolverRef,
  resolverContratos,
  bajarContrato,
  normalizar,
};
