# src/observabilidad

Trazas (OpenTelemetry, W3C Trace Context) y métricas (prom-client) con el estándar de Quinde
([docs/OBSERVABILIDAD.md](../../docs/OBSERVABILIDAD.md)). Está pensado para copiarse a los otros
servicios: todo es CommonJS y solo `fastify.ts` depende de un framework.

| Archivo | Qué hace | Depende de |
| --- | --- | --- |
| `traceparent.ts` | Lee y escribe `traceparent` (solo `00`, estricto) y acota `tracestate` | nada |
| `atributos.ts` | Lista cerrada de atributos de span (con `rpc.*`, `graphql.operation.type` y `quinde.correlation_id` desde la fase G2) y la de valores de `error.type` y `rpc.*`, `__unmatched__` y métodos | nada |
| `trazas.ts` | Proveedor de trazas (siempre arranca), sampler, exportador OTLP/HTTP opcional, `camposDeTraza()` para el logger (`requestId`, `correlationId`, `traceId`, `spanId`) y cierre con tope | `@opentelemetry/*` |
| `metricas.ts` | Métricas comunes en un `Registry` propio y el servidor de `/metrics` en su puerto | `prom-client` |
| `fastify.ts` | Span raíz por petición, X-Trace-Id, X-Correlation-Id y métricas del servidor | `fastify` |

## Copiarlo a un servicio NestJS 10 (bff, core, identity, notifier)

1. Copiar `traceparent.ts`, `atributos.ts`, `trazas.ts` y `metricas.ts` tal cual, a
   `src/observabilidad/`.
2. Instalar las mismas versiones:
   `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`,
   `@opentelemetry/resources` y `prom-client` (ver `package.json` de este repo).
3. En `main.ts`, antes de crear la app, crear `new Trazas({...})` y `new Metricas({...})` con
   `OTEL_SERVICE_NAME` (`quinde-bff`, `quinde-core`...), y arrancar `servidorMetricas(metricas)` en
   `METRICS_PORT`. En `app.enableShutdownHooks()`/`onApplicationShutdown`, `trazas.cerrar()`.
4. En lugar de `fastify.ts`, un middleware de Express, el primero de todos, que haga lo mismo:
   - `const padre = trazas.contextoEntrante(req.headers.traceparent)`. En un servicio interno,
     `TRACE_TRUST_INCOMING=true`: el que llama es el gateway.
   - Abrir el span `SERVER`, poner `X-Trace-Id` y llamar a `next()` dentro de
     `trazas.enContexto(...)`.
   - El `X-Correlation-Id` (docs/OBSERVABILIDAD.md, sección 7): en el contexto con
     `CLAVE_CORRELATION_ID`, en el span como `quinde.correlation_id` y en la respuesta.
   - En `res.on('finish')`, nombrar el span `METHOD /plantilla` con la ruta de Nest
     (`req.route?.path`, nunca `req.url`), cerrarlo y `metricas.registrarServidor(...)`.
5. Logger: agregar `traceId`, `spanId` y `correlationId` de `camposDeTraza()` a cada línea, junto
   al requestId.
6. Hacia otro servicio:
   - Abrir un span `CLIENT` y mandar `traceparentDe(span)` en la cabecera HTTP `traceparent`, o en
     la metadata gRPC `traceparent`.
   - Hacia un tercero (webhooks), nunca.

No agregar instrumentaciones automáticas ni atributos fuera de `ATRIBUTOS_PERMITIDOS`:
`filtrarAtributos` descarta el resto. Al volver a copiar `atributos.ts` (fase G2), el core ya no
necesita su divergencia `rpc.*`: queda en el estándar.
