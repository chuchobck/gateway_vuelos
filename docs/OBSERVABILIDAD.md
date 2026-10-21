# Observabilidad de Quinde: el estándar

Fase 7a del Reto 2. Este documento define cómo emiten trazas, métricas y logs **los cinco
servicios**. El gateway lo implementa primero (`src/observabilidad/`). En la fase 7b lo copian el BFF y
el core; en la 7c, identity, el notifier y la bandeja del core. Lo que aquí dice "debe" vale para
todos.

Términos: un **servicio** es cada proceso (gateway, bff, core, identity, notifier). **Upstream** es el
servicio al que otro llama. **Tercero** es alguien fuera de Quinde (el receptor de un webhook).

## 1. Identidad de cada servicio

| Servicio | `service.name` (`OTEL_SERVICE_NAME`) | Puerto de métricas local |
| --- | --- | --- |
| gateway | `quinde-gateway` | 9464 |
| bff | `quinde-bff` | 9465 |
| core | `quinde-core` | 9466 |
| identity | `quinde-identity` | 9467 |
| notifier | `quinde-notifier` | 9468 |

- `service.version`: la de `package.json`. `deployment.environment`: `NODE_ENV` (`development`,
  `production`).
- En un contenedor, todos usan `METRICS_PORT=9464`; los puertos de la tabla son para correr los cinco
  en una sola máquina (`scripts/e2e-local.sh`, `observabilidad/prometheus.yml`).

## 2. Trazas

**Formato:** [W3C Trace Context](https://www.w3.org/TR/trace-context/): `traceparent` y `tracestate`.

**Biblioteca:**
- Usa `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`,
  `@opentelemetry/exporter-trace-otlp-http` y `@opentelemetry/resources`, con las versiones de
  `package.json` de este repo.
- **Sin instrumentaciones automáticas**: los spans se abren a mano, para decidir qué se registra.

**Arranque:**
- **El SDK siempre arranca**, aunque no se exporte nada. Así cada petición tiene un trace-id que se
  propaga, que va en los logs y que se devuelve en `X-Trace-Id`.
- **El exportador es opcional**: solo con `OTEL_EXPORTER_OTLP_ENDPOINT`. Funciona así:
  - OTLP/HTTP en JSON a `{endpoint}/v1/traces`, por un `BatchSpanProcessor`.
  - La petición solo encola su span; el envío va aparte, en lotes cada 2 s.
  - La cola es de 2048 spans: lo que no cabe se descarta.
  - Cada envío tiene 3 s de plazo. Un recolector caído o lento **nunca retrasa ni rompe una petición**.
  - Al cerrar, se envía lo que quede, con un tope de 5 s: el proceso no se cuelga.

**Muestreo:**
- `OTEL_TRACES_SAMPLER_ARG` es la fracción de trazas **raíz** que se registran: 1.0 por defecto en
  desarrollo y 0.1 en producción.
- Un span hijo sigue la decisión de su padre (`ParentBased`).
- Una traza no muestreada igual tiene ids y se propaga con el bit `00`.

### Variables

| Variable | Por defecto | Qué hace |
| --- | --- | --- |
| `OTEL_SERVICE_NAME` | el de la tabla de la sección 1 | `service.name` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (vacía: no se exporta) | Base OTLP/HTTP, por ejemplo `http://jaeger:4318` |
| `OTEL_TRACES_SAMPLER_ARG` | 1.0 en desarrollo, 0.1 en producción | Fracción de trazas raíz que se registran (0 a 1) |
| `TRACE_TRUST_INCOMING` | `false` en el gateway, `true` en los internos | Continuar el `traceparent` entrante |
| `METRICS_PORT` | 9464 | Puerto aparte de `/metrics`; 0 lo apaga |

### Quién abre la traza

- **El gateway es la raíz.** Aunque el cliente mande `traceparent`, abre una traza **nueva**. Solo con
  `TRACE_TRUST_INCOMING=true` continúa la del cliente, si es válida, y respeta su bit de muestreo.
  Úsese solo si delante hay un proxy de confianza que la genere.
- **Los servicios internos** (bff, core, identity, notifier) sí continúan la traza que reciben, con
  `TRACE_TRUST_INCOMING=true`. Solo los alcanza el gateway u otro servicio Quinde (ingress interno).

**Un `traceparent` válido es solo `00-<32 hex>-<16 hex>-<2 hex>`**: en minúsculas, sin nada más, con
trace-id y parent-id distintos de cero. Todo lo demás se descarta, **nunca rompe la petición** y abre
una traza nueva. Entra ahí:

- una versión distinta de `00`, incluida `ff`;
- mayúsculas, un largo malo o campos extra;
- la cabecera repetida.

Es más estricto que la regla de W3C para versiones futuras, que admite campos extra después; en un
borde, lo que no se sabe leer se descarta.

### Propagación

| Canal | Qué viaja |
| --- | --- |
| HTTP entre servicios | Cabecera `traceparent` nueva: mismo trace-id; parent-id = el span **cliente** de quien llama hacia ese servicio; el bit de muestreo de la traza. `tracestate` intacto si cabe en el tope de W3C (512 caracteres, 32 miembros, imprimible); si no, se descarta entero. |
| gRPC (bff → core) | La metadata `traceparent`, con las mismas reglas. `tracestate` también como metadata, si viene. |
| Respuesta al cliente | Cabecera `X-Trace-Id` (el trace-id), expuesta por CORS en el gateway |
| Webhooks a terceros | **Nada**: la entrega del notifier a un tercero no lleva `traceparent` ni `tracestate` (no se les revela la estructura interna) |
| Bandeja del core → notifier (fase 7c) | El core guarda el `traceparent` de la petición junto a cada fila de `evento_saliente`; el relevo abre su span como hijo de ese contexto, y su POST a `/internal/v1/events` lleva un `traceparent` nuevo. La traza de una reserva llega hasta el notifier |

El `traceparent` del cliente nunca se reenvía tal cual: cada salto lo reescribe con su propio span.

### Spans

Cada servicio abre:

- **Uno `SERVER` por petición recibida**, con nombre `METHOD /plantilla`: `GET
  /flights/v1/bookings/{bookingId}`. **Nunca la ruta pedida**. Lo que no corresponde a ninguna
  plantilla es `__unmatched__`.
- **Uno `CLIENT` por cada llamada a otro servicio**, con el mismo nombre de la operación y
  `quinde.upstream`. Termina cuando termina el cuerpo de la respuesta.
- **Uno `INTERNAL` por trabajo con duración propia que interese medir.** En el gateway, `auth.verify`
  (la verificación del token). En el core, por ejemplo, la transacción de la reserva.

**Atributos permitidos**, y no otros: `filtrarAtributos` descarta el resto.

| Atributo | Qué lleva |
| --- | --- |
| `http.request.method` | El método, de la lista conocida, o `_OTHER` |
| `http.route` | La **plantilla**, o `__unmatched__` |
| `http.response.status_code` | El status |
| `quinde.upstream` | `core`, `bff`, `identity` o `notifier` |
| `quinde.auth.mode` | `publica` o `token` |
| `quinde.request_id` | El X-Request-Id |
| `error.type` | Uno de una lista cerrada: `timeout`, `unavailable`, `invalid_token`, `missing_token`, `expired_token`, `insufficient_scope`, `jwks_unavailable`, `500` a `504` |

**Prohibido en spans, logs y métricas:**

- `Authorization`, tokens y cookies;
- cuerpos y query string;
- correos, nombres, documentos y teléfonos;
- ids de reserva, de boleto o de pasajero;
- IPs y secretos.

**Errores:**
- `status = ERROR` y `error.type`. **Nunca el mensaje** del error ni el del upstream, que puede traer
  URLs internas.
- En un span `SERVER`, solo un 5xx es error; un 4xx es del cliente.
- En un span `CLIENT`, sin respuesta (`timeout`, `unavailable`) o con un 5xx del upstream.

## 3. Logs

Cada línea es JSON y lleva:

- `requestId`, `traceId` y `spanId` en **toda** línea escrita durante una petición, también en las de
  código que no recibe la petición (el verificador de tokens, un repositorio). Se toman del contexto
  activo (`camposDeTraza()`), no de la petición.
- La línea de acceso: `requestId`, `traceId`, `spanId`, método, **plantilla** de la ruta (no la ruta
  pedida), upstream si lo hay, status y ms.

Fuera de una petición (el arranque, una tarea programada) no hay `traceId`, salvo que la tarea abra
su propio span.

## 4. Métricas

Con `prom-client`, en un `Registry` propio, en el puerto `METRICS_PORT`, que **el ingress nunca
expone**. Solo `GET /metrics`; cualquier otra cosa es 404. En el puerto público, `/metrics` no
existe: el gateway lo bloquea como `/internal`.

### Comunes a los cinco servicios (obligatorias)

| Métrica | Tipo | Etiquetas |
| --- | --- | --- |
| `http_server_request_duration_seconds` | histograma | `method`, `route`, `status` |
| `http_server_requests_total` | contador | `method`, `route`, `status` |
| `http_client_request_duration_seconds` | histograma | `upstream`, `method`, `status` (código o `error`) |
| `quinde_build_info` | gauge (siempre 1) | `service`, `version`, `environment` |
| por defecto de `prom-client` | varias | `process_*`, `nodejs_*` |

**Cubetas de duración:** 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30 y 60 s, las mismas
en todos los servicios, para poder sumarlas.

**Regla de cardinalidad:**
- `route` es **siempre** la plantilla (`/flights/v1/bookings/{bookingId}`) o `__unmatched__`.
- `method` es de la lista conocida (GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS) o `_OTHER`.
- `status` es el código. Nunca ids, IPs, correos ni rutas crudas.

Con esto, una ruta inventada mil veces es **una** serie.

### Del gateway

| Métrica | Etiquetas |
| --- | --- |
| `gateway_rate_limited_total` | `policy`: `global`, `estricto` |
| `gateway_auth_rejections_total` | `reason`: `missing_token`, `invalid_token`, `expired_token`, `insufficient_scope`, `jwks_unavailable` |
| `gateway_upstream_errors_total` | `upstream`; `kind`: `unavailable` (502), `timeout` (504) |

Las específicas de cada servicio, como la bandeja del core o las entregas del notifier, llevan su
prefijo (`core_`, `notifier_`...) y las mismas reglas de cardinalidad.

## 5. Cómo se copia a un servicio NestJS (fases 7b y 7c)

1. **Módulo:** copiar `src/observabilidad/{traceparent,atributos,trazas,metricas}.ts` tal cual. Son
   CommonJS y no dependen de Fastify. Las dependencias son las de la sección 2, más `prom-client`.
2. **`main.ts`:**
   - `new Trazas({ servicio, version, entorno, endpointOtlp, muestreo, confiarEntrante })` antes de
     `NestFactory.create`.
   - `new Metricas(...)` y `servidorMetricas(metricas).listen(METRICS_PORT)`.
   - En el cierre (`enableShutdownHooks`), `trazas.cerrar()` y cerrar el servidor de métricas.
3. **Middleware de Express, el primero de todos** (el equivalente de `src/observabilidad/fastify.ts`):
   - abrir el span `SERVER` con `trazas.contextoEntrante(req.headers.traceparent)` como padre;
   - poner el requestId en el contexto (`CLAVE_REQUEST_ID`) y la cabecera `X-Trace-Id`;
   - llamar a `next()` dentro de `trazas.enContexto(...)`;
   - en `res.on('finish')`: plantilla = `req.route?.path` con el prefijo y la versión, o
     `__unmatched__`. Nombrar el span, cerrarlo y `metricas.registrarServidor(...)`.
4. **gRPC (core):** en el interceptor de contexto gRPC, lo mismo con la metadata `traceparent`. La
   plantilla es el nombre de la RPC: `flights.v1.FlightsService/SearchFlights`.
5. **Logger** (`LoggerPorPeticion` del core, el del BFF): agregar `traceId` y `spanId` de
   `camposDeTraza()` a cada línea.
6. **Llamadas salientes:**
   - abrir un span `CLIENT` y mandar `traceparentDe(span)`: en la cabecera HTTP o en la metadata gRPC
     (BFF → core);
   - el relevo del core al notifier, el BFF al core;
   - la entrega del notifier a terceros: **no**.
7. **Pruebas:** las mismas de `test/trazas.spec.ts` y `test/metricas.spec.ts`, con un recolector OTLP
   falso, y las mutaciones de propagación, ruta cruda y atributo sensible.

Los servicios internos van con `TRACE_TRUST_INCOMING=true` y el gateway con `false`.

## 6. Recolección local

`observabilidad/docker-compose.yml` levanta Jaeger all-in-one (UI en 16686, OTLP/HTTP en 4318) y
Prometheus (9090), que raspa los cinco puertos de métricas (`observabilidad/prometheus.yml`). Las
consultas útiles están en [`observabilidad/CONSULTAS.md`](../observabilidad/CONSULTAS.md).

**No verificado en la fase 7a:** en esa sesión no había Docker. Sí se verificó el formato de lo que
emite el gateway:

- los spans en OTLP/HTTP JSON, contra un recolector falso;
- el texto de `/metrics`.

Las dos verificaciones están en las pruebas y en el recorrido local (`docs/E2E-LOCAL.md`).
