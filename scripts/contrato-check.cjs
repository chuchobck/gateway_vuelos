// npm run contrato:check [-- --ref <rama>]
// Compara la copia local del OpenAPI del core con la de main del core. Sale con 0 si son iguales,
// con 1 si difieren y con 2 si no pudo bajar la del core.
const fs = require('node:fs');
const {
  RUTA_CONTRATO,
  DESTINO,
  REPO_CORE,
  resolverRef,
  bajarContrato,
  normalizar,
} = require('./contrato-comun.cjs');

(async () => {
  const ref = resolverRef(process.argv.slice(2));
  const remoto = await bajarContrato(ref);
  const local = normalizar(fs.readFileSync(DESTINO, 'utf8'));
  if (local === remoto) {
    console.log(`${RUTA_CONTRATO} es igual al de ${REPO_CORE}@${ref}`);
    return;
  }
  const lineasLocal = local.split('\n');
  const lineasRemoto = remoto.split('\n');
  const primera = lineasLocal.findIndex((linea, i) => linea !== lineasRemoto[i]);
  const donde = primera === -1 ? Math.min(lineasLocal.length, lineasRemoto.length) : primera;
  console.error(
    `${RUTA_CONTRATO} DIFIERE del de ${REPO_CORE}@${ref}; primera diferencia en la línea ${donde + 1}.`,
  );
  console.error('No se edita a mano: npm run contrato:sync lo vuelve a traer del core.');
  process.exit(1);
})().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
