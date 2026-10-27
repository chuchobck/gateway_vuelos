// npm run contrato:sync [-- --ref <rama>] [-- --contrato v1|v2]
// Trae de main del core contracts/vuelos-openapi.yaml (v1) y contracts/vuelos-openapi-v2.yaml
// (v2). No se editan a mano: son los contratos del core y el gateway solo los copia para sacar de
// ellos los scopes de cada operación.
const fs = require('node:fs');
const {
  REPO_CORE,
  resolverRef,
  resolverContratos,
  bajarContrato,
} = require('./contrato-comun.cjs');

(async () => {
  const argv = process.argv.slice(2);
  const ref = resolverRef(argv);
  for (const { ruta, destino } of resolverContratos(argv)) {
    const remoto = await bajarContrato(ref, ruta);
    const anterior = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : '';
    fs.writeFileSync(destino, remoto);
    console.log(
      anterior === remoto
        ? `${ruta} ya estaba al día con ${REPO_CORE}@${ref}`
        : `${ruta} actualizado desde ${REPO_CORE}@${ref}. Corre npm test: la prueba de la tabla de scopes dice qué cambió.`,
    );
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
