// npm run contrato:check [-- --ref <rama>] [-- --contrato v1|v2]
// Compara las copias locales de los OpenAPI del core (v1 y v2) con las de main del core. Sale con
// 0 si son iguales, con 1 si alguna difiere y con 2 si no pudo bajar alguna.
const fs = require('node:fs');
const {
  REPO_CORE,
  resolverRef,
  resolverContratos,
  bajarContrato,
  normalizar,
} = require('./contrato-comun.cjs');

(async () => {
  const argv = process.argv.slice(2);
  const ref = resolverRef(argv);
  let difiere = false;
  for (const { ruta, destino } of resolverContratos(argv)) {
    const remoto = await bajarContrato(ref, ruta);
    const local = normalizar(fs.readFileSync(destino, 'utf8'));
    if (local === remoto) {
      console.log(`${ruta} es igual al de ${REPO_CORE}@${ref}`);
      continue;
    }
    const lineasLocal = local.split('\n');
    const lineasRemoto = remoto.split('\n');
    const primera = lineasLocal.findIndex((linea, i) => linea !== lineasRemoto[i]);
    const donde = primera === -1 ? Math.min(lineasLocal.length, lineasRemoto.length) : primera;
    console.error(
      `${ruta} DIFIERE del de ${REPO_CORE}@${ref}; primera diferencia en la línea ${donde + 1}.`,
    );
    difiere = true;
  }
  if (difiere) {
    console.error('No se editan a mano: npm run contrato:sync los vuelve a traer del core.');
    process.exit(1);
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
