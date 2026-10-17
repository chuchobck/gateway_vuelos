import { construirApp } from './app';
import { ErrorEntorno, leerEntorno } from './config/entorno';
import { servidorMetricas } from './observabilidad/metricas';

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
  const { observabilidad } = configuracion;

  // /metrics en su propio puerto (el ingress solo expone PORT); 0 lo apaga
  const metricas =
    observabilidad.puertoMetricas > 0 ? servidorMetricas(app.observabilidad.metricas) : undefined;
  if (metricas) {
    app.addHook('onClose', async () => {
      metricas.closeAllConnections();
      await new Promise<void>((listo) => metricas.close(() => listo()));
    });
  }

  for (const senal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(senal, () => {
      app.log.info(`${senal}: cerrando`);
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ port: configuracion.puerto, host: configuracion.host });
  if (metricas) {
    await new Promise<void>((listo, fallo) => {
      metricas.once('error', fallo);
      metricas.listen(observabilidad.puertoMetricas, configuracion.host, () => listo());
    });
  }
  const destinos = Object.entries(configuracion.upstreams)
    .map(([nombre, { plazoMs }]) => `${nombre} (${plazoMs} ms)`)
    .join(', ');
  app.log.info(
    `Gateway en el puerto ${configuracion.puerto}; upstreams: ${destinos}; ` +
      `TRUST_PROXY_HOPS=${configuracion.saltosProxy}; ${configuracion.corsOrigenes.length} orígenes CORS`,
  );
  app.log.info(
    `Observabilidad: ${observabilidad.servicio} ${observabilidad.version}, muestreo ` +
      `${observabilidad.muestreo}, ${observabilidad.endpointOtlp ? 'exportando trazas por OTLP/HTTP' : 'sin exportar trazas'}, ` +
      `traceparent entrante ${observabilidad.confiarEntrante ? 'de confianza' : 'ignorado'}, ` +
      `métricas ${metricas ? `en el puerto ${observabilidad.puertoMetricas}` : 'apagadas'}`,
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
