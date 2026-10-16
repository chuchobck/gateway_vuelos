// Lo que comparten contrato:sync y contrato:check: de dónde sale el OpenAPI del core y cómo se baja.
const path = require('node:path');

const REPO_CORE = process.env.CORE_REPO || 'chuchobck/backend_vuelos';
const RUTA_CONTRATO = 'contracts/vuelos-openapi.yaml';
const DESTINO = path.join(__dirname, '..', RUTA_CONTRATO);

/** La rama del core: `--ref <rama>` o CORE_CONTRACT_REF; por defecto, main. */
function resolverRef(argv) {
  const i = argv.indexOf('--ref');
  if (i !== -1) {
    if (!argv[i + 1]) throw new Error('--ref necesita un valor (rama, etiqueta o commit)');
    return argv[i + 1];
  }
  return process.env.CORE_CONTRACT_REF || 'main';
}

/** Baja el contrato de esa ref del core. CORE_CONTRACT_TOKEN es opcional (repo privado). */
async function bajarContrato(ref) {
  const url = `https://raw.githubusercontent.com/${REPO_CORE}/${ref.split('/').map(encodeURIComponent).join('/')}/${RUTA_CONTRATO}`;
  const cabeceras = process.env.CORE_CONTRACT_TOKEN
    ? { Authorization: `Bearer ${process.env.CORE_CONTRACT_TOKEN}` }
    : {};
  const respuesta = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(15_000) });
  if (!respuesta.ok) {
    throw new Error(
      `No se pudo bajar ${RUTA_CONTRATO} de ${REPO_CORE}@${ref} (HTTP ${respuesta.status}).`,
    );
  }
  return normalizar(await respuesta.text());
}

/** Compara sin que un CRLF de Windows cuente como diferencia. */
function normalizar(texto) {
  return texto.replace(/\r\n/g, '\n');
}

module.exports = { REPO_CORE, RUTA_CONTRATO, DESTINO, resolverRef, bajarContrato, normalizar };
