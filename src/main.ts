import { construirApp } from './app';
import { ErrorEntorno, leerEntorno } from './config/entorno';

/**
 * Arranque: el entorno se valida antes de nada (si falta algo, el proceso sale con 1 y dice qué
 * variable revisar, sin su valor) y el contrato del core se lee y se valida al construir la app.
 */
async function arrancar(): Promise<void> {
  let configuracion;
  try {
    configuracion = leerEntorno();
  } catch (error) {
    if (error instanceof ErrorEntorno) {
      process.stderr.write(
        `${JSON.stringify({ level: 60, servicio: 'gateway', msg: error.message })}\n`,
      );
      process.exit(1);
    }
    throw error;
  }

  const app = construirApp({ configuracion });
  for (const senal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(senal, () => {
      app.log.info(`${senal}: cerrando`);
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ port: configuracion.puerto, host: configuracion.host });
  const destinos = Object.entries(configuracion.upstreams)
    .map(([nombre, { plazoMs }]) => `${nombre} (${plazoMs} ms)`)
    .join(', ');
  app.log.info(
    `Gateway en el puerto ${configuracion.puerto}; upstreams: ${destinos}; ` +
      `TRUST_PROXY_HOPS=${configuracion.saltosProxy}; ${configuracion.corsOrigenes.length} orígenes CORS`,
  );
}

arrancar().catch((error: unknown) => {
  const tipo = error instanceof Error ? error.name : typeof error;
  const mensaje = error instanceof Error ? error.message : '';
  process.stderr.write(
    `${JSON.stringify({ level: 60, servicio: 'gateway', msg: `No arrancó: ${tipo} ${mensaje}` })}\n`,
  );
  process.exit(1);
});
