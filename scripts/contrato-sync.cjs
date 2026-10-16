// npm run contrato:sync [-- --ref <rama>]
// Trae contracts/vuelos-openapi.yaml de main del core. No se edita a mano: es el contrato del
// core y el gateway solo lo copia para sacar de él los scopes de cada operación.
const fs = require('node:fs');
const {
  RUTA_CONTRATO,
  DESTINO,
  REPO_CORE,
  resolverRef,
  bajarContrato,
} = require('./contrato-comun.cjs');

(async () => {
  const ref = resolverRef(process.argv.slice(2));
  const remoto = await bajarContrato(ref);
  const anterior = fs.existsSync(DESTINO) ? fs.readFileSync(DESTINO, 'utf8') : '';
  fs.writeFileSync(DESTINO, remoto);
  console.log(
    anterior === remoto
      ? `${RUTA_CONTRATO} ya estaba al día con ${REPO_CORE}@${ref}`
      : `${RUTA_CONTRATO} actualizado desde ${REPO_CORE}@${ref}. Corre npm test: la prueba de la tabla de scopes dice qué cambió.`,
  );
})().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
