# Plan — Quinde · Gateway

Reto 2 de Integración de Sistemas (PUCE). Fase 6a: la puerta única de la arquitectura. Fase 7a:
la observabilidad (trazas, métricas y logs), cuyo estándar define este repo para los cinco
servicios ([OBSERVABILIDAD.md](OBSERVABILIDAD.md)). Fase G2: el contrato v2 (RDA2), por el que
Booking Prototipo entra solo por `https://<gateway>/api/v2/vuelos/*`. Enruta a
core, bff, identity y notifier, aplica las políticas de seguridad en el borde y esconde lo
interno. No tiene lógica de negocio ni base de datos. Los servicios siguen validando todo: el
gateway nunca es la única barrera.

## Avance

| Fase | Estado | Verificación |
| --- | --- | --- |
| 6a. Gateway | Hecha (2026-10-16), en `feat/r2-gateway` | `lint`, `format:check` y `build` en cada commit. `npm test`: 345 pruebas en 10 suites, contra upstreams falsos HTTP reales y un identity falso con JWKS. `npm run test:mutaciones`: 17 de 17 detectadas. `scripts/smoke.sh` contra el gateway compilado y contra la imagen de Docker (uid 1000, `/health/ready` 200). Recorrido real con los cinco servicios en `main`, solo por el gateway: `scripts/e2e-local.sh`, todo en verde (salida en [E2E-LOCAL.md](E2E-LOCAL.md)) |
| G2. Contrato v2 | Hecha (2026-10-27), en `feat/v2-rutas` | `lint`, `format:check` y `build` en cada commit. `npm test`: 571 pruebas en 18 suites (4 nuevas: rutas v2, X-User-*, correlación y errores v2 validados con Ajv contra el contrato). `npm run test:mutaciones`: 29 de 29 (6 nuevas). `scripts/smoke.sh` con 5 comprobaciones v2. Recorrido real con identity, core, bff y notifier de `main` (el notifier v2, falso): pasos 1 a 23 en verde, el mismo `X-Correlation-Id` en las respuestas y en los logs del gateway, el core y el identity (salida en [E2E-LOCAL.md](E2E-LOCAL.md)) |
| 7a. Observabilidad | Hecha (2026-10-17), en `feat/r2-observabilidad` | `lint`, `format:check` y `build` en cada commit. `npm test`: 404 pruebas en 14 suites, con un recolector OTLP falso por HTTP. `npm run test:mutaciones`: 23 de 23 (6 nuevas). `scripts/smoke.sh` con X-Trace-Id y `/metrics` 404. Recorrido real con los cinco servicios: métricas en el 9464 y spans en un recolector OTLP falso, todo en verde (salida en [E2E-LOCAL.md](E2E-LOCAL.md)). Jaeger y Prometheus reales: sin verificar (no había Docker) |

## Dependencias (y por qué cada una)

| Paquete | Para qué | Por qué no otra cosa |
| --- | --- | --- |
| `fastify` 5 | Servidor HTTP, hooks y logger JSON (pino, incluido) | Lo pide la fase. Sin Nest: un proxy delgado no necesita inyección de dependencias ni decoradores. El logger viene con Fastify y no hace falta otra dependencia de logs |
| `jose` 6 | Verificar RS256 con el JWKS | Es la del verificador del core y del notifier. Copiarlo tal cual exige la misma biblioteca |
| `yaml` 2 | Leer `contracts/vuelos-openapi.yaml` al arrancar | El contrato del core es YAML. Sin dependencias propias. Una copia convertida a JSON sería un segundo archivo que mantener en sincronía |
| `@opentelemetry/api` 1.9 | La API de trazas (span, contexto, propagación) | La pide la fase 7a; es la que usarán los otros servicios |
| `@opentelemetry/sdk-trace-node` 2.12 | El proveedor de trazas, el sampler, el BatchSpanProcessor y el contexto con AsyncLocalStorage | Lo pide la fase. Sin `sdk-node` (arrastra instrumentaciones automáticas y métricas OTel que no se usan) |
| `@opentelemetry/exporter-trace-otlp-http` 0.223 | Mandar los spans por OTLP/HTTP en JSON | Lo pide la fase. JSON (y no protobuf): Jaeger y el Collector lo aceptan, y las pruebas lo leen sin otra dependencia |
| `@opentelemetry/resources` 2.12 | `resourceFromAttributes` para `service.name`, `service.version` y `deployment.environment` | Fuera de las nombradas por la fase. Ya es dependencia del SDK (misma versión): importarla directo no agrega código |
| `prom-client` 15 | Métricas Prometheus con un `Registry` propio y las del proceso | Lo pide la fase. Sin las métricas de OpenTelemetry: Prometheus raspa el texto de prom-client sin un Collector |

**No se usó:**

- `@fastify/http-proxy` ni `@fastify/reply-from`: reescriben y agregan cabeceras a su manera. El
  reenvío con `node:http` son unas 100 líneas (`src/proxy/`) que se controlan enteras: sin buffer,
  sin descomprimir, sin reintentos y sin filtrar mensajes.
- `@fastify/cors` y `@fastify/rate-limit`: el CORS tiene que borrar el del upstream, y el límite
  tiene que contar con el `Reloj` (las pruebas lo adelantan) y con la IP calculada por el gateway.
  Los dos son unas 50 líneas propias.
- `undici`: `fetch` descomprime gzip, y `node:http` no toca `Content-Encoding`.

Desarrollo: TypeScript, ESLint, Prettier, Jest con ts-jest, husky y commitlint, con la misma
configuración que el resto de repos.

## Qué se copió y qué cambió

| De | Qué | Cambios |
| --- | --- | --- |
| notifier (fase 5a), que es el del core (4b) | `ClavesJwks`, `VerificadorJwks`, `desafioBearer`, el regex de `Bearer` y el `realm` | Sin Nest: el logger es la interfaz `Registro` (pino). No filtra scopes contra una lista: el gateway solo los compara con los de la ruta |
| core | Forma del ProblemDetails (`type` `https://api.booking-hub.com/errors/...`, `code` `VALIDATION_FAILED` de respaldo, `RATE_LIMIT_EXCEEDED`, `AUTH_UNAVAILABLE`), CORS por lista exacta, 100 kB | El request id va solo en `X-Request-Id`: el esquema del contrato no admite campos extra |
| BFF | `proto:sync`/`proto:check` | Pasan a ser `contrato:sync`/`contrato:check` para el OpenAPI, con un job informativo de CI |
| todos | `TRUST_PROXY` | Pasa a ser `TRUST_PROXY_HOPS` (solo números: es lo único que necesita un borde) |
| notifier | `scripts/mutaciones.mjs` | Admite mutaciones de varios archivos |

## Decisiones (tomadas sin consultar)

1. **El request id en la cabecera, no en el cuerpo.** El contrato del core declara su
   ProblemDetails con `additionalProperties: false`. Si el borde agregara `requestId` al cuerpo,
   un 401 del gateway rompería el esquema que validan los clientes. Todo error del gateway lleva
   `X-Request-Id`, y la línea del log lleva el mismo id.
2. **Sin códigos propios.** 502, 504, 400, 404 y 413 usan `VALIDATION_FAILED`, el respaldo del
   core. 429 usa `RATE_LIMIT_EXCEEDED` y el 503 sin JWKS `AUTH_UNAVAILABLE`. El `status` dice qué
   pasó, como en el core y el notifier.
3. **Lo que el contrato del core no declara exige un token válido, sin scopes.** Incluye otro
   método en una ruta conocida y una ruta desconocida bajo `/flights/v1`: se niega por defecto.
   Hay tres excepciones fuera del contrato:
   - `/flights/v1/admin/**` exige `flights:admin`, como el core.
   - `/flights/v1/health` es pública.
   - `/flights/v1/auth/**` es pública, para que un frontend sin migrar reciba el 404 del core y no
     un 401 del borde.
4. **`/flights/v1/webhooks/*` es un solo nivel**, como pide el plan: `/webhooks` y `/webhooks/{id}`.
   Algo más profundo cae en el core, que con `WEBHOOKS_MODE=notifier` responde 404.
5. **Una ruta ambigua no se arregla: se rechaza (400).** Hay cuatro casos:
   - `.` y `..`, también codificados, no se resuelven: el upstream podría resolverlos distinto.
   - `//` no se colapsa.
   - `%2f`, `%5c` y `%25` son 400.
   - Una barra final se quita. Las mayúsculas se aceptan: se decide en minúsculas, porque Express
     no distingue, y se reenvía tal cual.

   Lo que se reenvía es la ruta canónica que se decidió, no la cruda.
6. **`/internal/**` responde igual que una ruta desconocida** (404 con el mismo cuerpo), para no
   revelar que existe. Se evalúa antes que la tabla: una regla que lo cubriera no lo deja pasar.
   Hay una prueba con una tabla con comodín.
7. **Preflight**: se responde después de normalizar y antes de decidir la ruta. Con un origen no
   permitido, 204 sin `Access-Control-*`: el navegador bloquea, sin revelar nada. Los preflights
   cuentan en el límite global, no en el estricto.
8. **Cabeceras expuestas solo `x-request-id` y `retry-after`**, como pide la fase y como el BFF. El
   core exponía además `X-RateLimit-*`: el gateway las deja pasar en la respuesta, pero un
   navegador ya no puede leerlas. Ningún frontend las usa hoy.
9. **`X-Forwarded-For` con una sola IP**, la real. El gateway no reenvía la cadena del cliente.
   Por eso a los servicios les basta `TRUST_PROXY=1`, haya los proxies que haya delante del
   gateway. `X-Real-IP` y `Forwarded` del cliente se borran y no se escriben (ningún servicio los
   lee). `X-Forwarded-Proto` y `X-Forwarded-Host` sí se escriben.
10. **`X-Request-Id` válido = un uuid.** Lo demás se reemplaza: vacío, otro formato, con
    caracteres de control o largo. El id viaja a los logs de todos los servicios y no puede servir
    para inyectar líneas. Se conserva tal cual, sin pasarlo a minúsculas.
11. **Plazos.** core 45 s; bff 50 s (el plan pedía "un poco más que el del core": se leyó como el
    plazo del gateway para el core, 45 s, porque una consulta del BFF también puede despertar al
    core); identity y notifier 10 s. El plazo cuenta hasta recibir las cabeceras. Después, el mismo
    valor es de inactividad del socket, para que un PDF grande no se corte a los 45 s.
12. **Las respuestas del upstream pasan tal cual**, también un 500 (ya sanitizado en el servicio) y
    un 503 con su `Retry-After`. "Nunca se filtran mensajes internos" se aplica a los errores que
    arma el gateway (502 y 504): no llevan URL, host, puerto ni el mensaje del error de red. El log
    lleva el nombre del upstream y el código (`ECONNREFUSED`).
13. **Límites por defecto**: global 300/min por IP, por encima del de cada servicio (100), porque
    el gateway ve todo el tráfico. Estricto 20/min por IP y por ruta, por encima del de identity
    (login 5/min), para no adelantarse a él.
14. **Límites de cuerpo**: 100 kB en todas las rutas, el `LIMITE_CUERPO` de los cuatro servicios.
    Con `Content-Length` se decide antes de abrir el upstream. En trozos, se corta al pasar el tope.
15. **`/health/upstreams` siempre responde 200** e informa cada servicio como `UP` o `DOWN`, con el
    status HTTP y los ms. No lleva URLs. Pregunta a cada servicio en su ruta de vivo
    (`/flights/v1/health`, `/health`, `/identity/v1/health`, `/health`) con 2 s de plazo.
16. **`/graphql` es pública y no se limita por operación en el borde**: eso ya lo hace el BFF.
17. **El JWKS se baja del identity interno** (`{UPSTREAM_IDENTITY_URL}/.well-known/jwks.json`) y no
    del origen público, para que el gateway no se llame a sí mismo.
18. **Rama**: se pidió `feat/r2-gateway` y la sesión tenía asignada `claude/stoic-carson-rfzywk`.
    El push a `feat/r2-gateway` se aceptó, así que todo está en esa rama y el pull request sale de
    ella.

## Commits de la fase 6a

| Commit | Qué |
| --- | --- |
| `chore: crear el proyecto base del gateway con Fastify y el entorno validado al arrancar` | package, TypeScript, ESLint, Prettier, commitlint, Jest y `src/config/entorno.ts` |
| `feat(rutas): agregar la tabla de rutas, la normalización y los scopes del contrato del core` | `src/rutas/`, `contracts/vuelos-openapi.yaml`, `contrato:sync/check`, `rutas:listar` |
| `feat(seguridad): copiar el verificador de tokens del notifier y aplicar los scopes en el borde` | `src/seguridad/` |
| `feat(proxy): reenviar en streaming con la seguridad, el CORS y los límites del borde` | `app.ts`, `proxy/`, `borde/`, `salud/`, `main.ts` y `.env.example` |
| `test: probar rutas, auth por operación, cabeceras, límites, fallos, streaming y escaneo` | `test/` |
| `test(mutaciones): ...` | `scripts/mutaciones.mjs` y las pruebas que había que endurecer |
| `build(despliegue): agregar Dockerfile sin privilegios, CI y scripts/smoke.sh` | Imagen, CI y smoke |
| `test(e2e): agregar scripts/e2e-local.sh ...` | El recorrido real |
| `docs: ...` | README, CLAUDE.md, CHANGELOG y `docs/` |

## Qué no se pudo verificar

- **El CI en GitHub Actions** hasta que corra en el pull request. En local pasaron los mismos pasos
  (lint, formato, tipos, build, pruebas, tabla de rutas, smoke y la imagen).
- **La imagen se construyó** con una copia del Dockerfile que solo agrega la CA del proxy de la
  sesión, porque los contenedores de este entorno no salen a internet sin ella. El Dockerfile del
  repo es el mismo sin esas dos líneas.
- **Nada desplegado**: ni Azure Container Apps ni Render. La nota de ACA (ingress externo solo
  en el gateway, internos los demás, `TRUST_PROXY_HOPS=1`) no se probó en Azure.
- **Más de una réplica**: el límite es por réplica (documentado), y no se probó con dos.
- **Los frontends** detrás del gateway: no se tocan desde aquí (ver "Lo que necesitan los otros
  repos").
- **HTTP/2 y WebSockets**: el gateway habla HTTP/1.1 y no hay WebSockets en la arquitectura. Un
  `Upgrade` del cliente se descarta como hop-by-hop.

## Hallazgos

- **Identity y notifier no confían hoy en `X-Forwarded-For`**: los dos leen `TRUST_PROXY` (por
  defecto `false`) y no lo fijan en ningún lado. Core y BFF lo traen en `render.yaml`
  (`TRUST_PROXY=1`). Detrás del gateway, sin `TRUST_PROXY=1`, sus límites por IP serían uno solo
  para todos. En la verificación local, con `TRUST_PROXY=1`, el core registró la IP real aunque el
  cliente mandara un `X-Forwarded-For` falso.
- **Los dos frontends hacen login en el core** (`{API}/auth/login`, `/auth/refresh`, `/auth/me`,
  y el backoffice también `/admin/users`). Con `AUTH_MODE=external` esas rutas dan 404. Tienen que
  pasar a `/identity/v1/auth/*` y `/identity/v1/admin/users`.
- **El CORS del BFF no admite `Authorization`.** Detrás del gateway no importa (el CORS es el del
  gateway), pero un cliente que reenvíe el token por `/graphql` ya puede.
- **El descubrimiento de identity sale correcto detrás del gateway** si `JWT_ISSUER` es el origen
  del gateway: `issuer`, `jwks_uri` y `token_endpoint` se arman desde `JWT_ISSUER` (verificado en
  local).
- En las pruebas, un cliente HTTP de Node con la cabecera `Trailer` y un `Content-Length` se queda
  colgado. Es del cliente de prueba, no del gateway; esa cabecera se sacó de la prueba de
  hop-by-hop.

## Pendientes

- Fase 7: generar `traceparent` y `tracestate` en el gateway. Hoy pasan intactos.
- Un límite compartido entre réplicas (Redis) si se escala a más de una y hace falta exactitud.
- Quitar `/flights/v1/auth/**` de la tabla cuando ningún frontend lo use.

## Lo que necesitan los otros repos (no se hizo desde aquí)

| Repo | Cambio mínimo |
| --- | --- |
| backend_vuelos | `TRUST_PROXY=1` (ya en `render.yaml`); `JWT_ISSUER` = origen público del gateway; `JWKS_URL` interna; `CORS_ORIGINS` vacía; ingress interno |
| identity_vuelos | **`TRUST_PROXY=1`** (no está en ningún lado); `JWT_ISSUER` = origen público del gateway (cambia el `issuer` del descubrimiento y el `iss` de los tokens); `CORS_ORIGINS` vacía; ingress interno |
| notifier_vuelos | **`TRUST_PROXY=1`** (no está en ningún lado); `JWT_ISSUER` = el mismo; `JWKS_URL` interna; `CORS_ORIGINS` vacía; ingress interno. `/internal/v1/events` solo por la red interna |
| bff_vuelos | `TRUST_PROXY=1` (ya en `render.yaml`); `CORS_ORIGINS` vacía; ingress interno |
| e-commerce_vuelos | `VITE_API_URL=https://<gateway>/flights/v1` y `VITE_GRAPHQL_URL=https://<gateway>/graphql`. Cuenta (register, login, refresh, logout, me) a `https://<gateway>/identity/v1/auth/*`: hoy usa `{VITE_API_URL}/auth/*`. Hace falta una base nueva para identity (por ejemplo `VITE_IDENTITY_URL=https://<gateway>/identity/v1`) o derivarla del origen |
| backoffice_vuelos | `public/config.js`: `API_URL: "https://<gateway>/flights/v1"` (no usa `VITE_*`: se configura en tiempo de ejecución). Login, refresh, me y administradores a `https://<gateway>/identity/v1/auth/*` y `/identity/v1/admin/users`. En desarrollo, el proxy de Vite (`BACKEND_URL`) apunta al gateway y agrega `/identity` y `/graphql` a las rutas que reenvía |

## Fase 7a: observabilidad

### Qué se hizo

- El estándar de los cinco servicios: [OBSERVABILIDAD.md](OBSERVABILIDAD.md).
- El módulo `src/observabilidad/`, copiable:
  - `traceparent.ts`, `atributos.ts`, `trazas.ts` y `metricas.ts`, sin framework;
  - `fastify.ts`, el gancho a Fastify.
- La integración en el gateway:
  - un span raíz por petición, activo durante todo su ciclo;
  - `auth.verify` y un span cliente por upstream;
  - `traceparent` nuevo hacia cada upstream;
  - X-Trace-Id;
  - logs con requestId, traceId y spanId;
  - métricas en `METRICS_PORT`;
  - `/metrics` bloqueado en el puerto público.
- `observabilidad/` con Jaeger, Prometheus y las consultas PromQL.

### Decisiones (tomadas sin consultar)

1. **`traceparent` estricto: solo la versión `00` exacta.** W3C admite campos extra en versiones
   futuras; en el borde, lo que no se sabe leer se descarta y se abre una traza nueva. Se descartan
   también la cabecera repetida (Node la une con coma) y cualquier id en ceros.
2. **`tracestate` pasa intacto aunque el gateway abra una traza nueva**, como pide la fase. W3C
   sugiere descartarlo cuando se reinicia la traza: es de los proveedores y el gateway no lo
   interpreta. Uno fuera del tope (512 caracteres, 32 miembros, imprimible) se descarta **entero**;
   no se recorta.
3. **Muestreo por defecto: 1.0 en desarrollo y 0.1 en producción.** La fase pedía "1.0 en
   desarrollo"; se leyó que en producción hace falta otro valor.
4. **`error.type` se agregó a los atributos permitidos**, con una lista cerrada de valores
   (`timeout`, `unavailable`, motivos de auth y `500` a `504`). Es el atributo de la convención
   semántica para el tipo de error y no lleva datos de nadie.
5. **El requestId viaja en el contexto de OpenTelemetry** y lo agrega el `mixin` del logger. Así
   llega también a las líneas de quien no recibe la petición (el verificador de tokens). Se quitó
   el binding propio del child logger de Fastify para que no salga dos veces.
6. **La línea de acceso registra la plantilla de la ruta, no la ruta canónica** (cambio respecto de
   la 6a). La regla nueva prohíbe ids de reserva y correos en los logs, y una ruta cruda los puede
   traer. Para ligar un caso concreto están el requestId y el traceId.
7. **La plantilla de una regla sin contrato es su patrón**, con `*` como `{id}`
   (`/flights/v1/webhooks/{id}`) y `**` tal cual (`/identity/v1/**`). Es una tabla finita: la
   cardinalidad queda acotada.
8. **El span cliente termina cuando termina el cuerpo de la respuesta**, no al llegar las cabeceras:
   un PDF grande cuenta entero en `http_client_request_duration_seconds`. Un 5xx del upstream marca
   error en ese span; en el raíz, solo un 5xx del gateway.
9. **`http_client_request_duration_seconds` lleva `status="error"`** cuando no hubo respuesta (502 o
   504 del borde). El tipo exacto va en `gateway_upstream_errors_total{kind}`.
10. **Preflight**: ahora se decide la ruta antes de responderlo, solo para su plantilla (métrica y
    span); la respuesta no cambia.
11. **El exportador manda JSON** (el formato por defecto de `exporter-trace-otlp-http`). Lotes cada
    2 s, cola de 2048, 3 s de plazo, cierre con tope de 5 s.
12. **Las pruebas pasan el exportador por el transformador de Jest.** Carga `http` con `import()`
    dinámico, que la VM de Jest rechaza sin `--experimental-vm-modules`. El transformador de `jose`
    (ahora `test/utils/transformar-a-commonjs.js`) lo pasa a `require`. En producción no hace
    falta: se verificó con el gateway compilado.
13. **Puertos de métricas locales**: gateway 9464, bff 9465, core 9466, identity 9467 y notifier
    9468. En contenedores, todos el 9464.
14. **Sin versión nueva en `package.json`**: el CHANGELOG lo deja en "Sin publicar", como hacen el
    core y el BFF con sus fases sin publicar. `service.version` sigue siendo 0.1.0.

### Commits de la fase 7a

| Commit | Qué |
| --- | --- |
| `feat(observabilidad): agregar el módulo de trazas W3C y métricas, y sus variables de entorno` | `src/observabilidad/`, el entorno y las dependencias |
| `feat(observabilidad): integrar trazas y métricas en el ciclo de la petición, el proxy y el token` | `app.ts`, proxy, auth, CORS, `/metrics` bloqueado, `main.ts` |
| `feat(observabilidad): poner requestId en toda línea de la petición y la plantilla en la de acceso` | `mixin`, child logger, X-Trace-Id en el 400 de Fastify |
| `test(observabilidad): probar traceparent, propagación, spans, logs, métricas y resiliencia` | 4 suites nuevas y el recolector falso |
| `test(mutaciones): agregar las seis de observabilidad y poner al día las de log y reintento` | 23 de 23 |
| `docs(observabilidad): definir el estándar de trazas, métricas y logs para los cinco servicios` | `docs/OBSERVABILIDAD.md` y `observabilidad/` |
| `build(observabilidad): exponer el puerto de métricas en la imagen y comprobarlo en el smoke y el CI` | Dockerfile, smoke y CI |
| `test(e2e): verificar métricas y trazas del gateway en el recorrido local con los cinco servicios` | `scripts/e2e-local.sh` y el recolector falso |
| `docs: ...` | RUTAS, DEPLOY, E2E-LOCAL, README, CLAUDE.md, CHANGELOG y este plan |

### Qué no se pudo verificar

- **Jaeger y Prometheus reales.** La sesión no tenía Docker: `observabilidad/docker-compose.yml`,
  `prometheus.yml` y las consultas de `CONSULTAS.md` no se probaron. Sí se verificó lo que emite el
  gateway:
  - los spans en OTLP/HTTP JSON (`application/json`, ids en hex, `kind` OTLP), contra el recolector
    falso, en Jest y en el recorrido real;
  - el texto de `/metrics`, con prom-client.
- **La imagen de Docker** con el puerto 9464: el CI la construye y raspa `/metrics`; en local no hubo
  Docker.
- **La continuidad de la traza en el BFF y el core**: todavía no leen `traceparent` (fases 7b y 7c).
  Hoy la traza termina en el span cliente del gateway.
- **Un despliegue** con el 9464 interno en Azure Container Apps.

### Hallazgos

- El `exporter-trace-otlp-http` carga `http` con `import()` dinámico aunque el paquete sea CommonJS.
  Funciona en Node, pero no dentro de la VM de Jest sin `--experimental-vm-modules`. Los otros
  servicios (Jest + ts-jest) se van a encontrar lo mismo: copien el transformador.
- Con el `traceparent` ignorado por defecto, un frontend que genere uno no se liga con la traza del
  gateway. Para eso está `X-Trace-Id` en la respuesta.
- El `prometheus.yml` pone una etiqueta `service` por objetivo y `quinde_build_info` trae la suya:
  Prometheus guarda la del servicio como `exported_service`.

### Pendientes

- Fase 7b: copiar el módulo al BFF y al core (HTTP y gRPC).
- Fase 7c: identity, notifier y el `traceparent` en la bandeja del core.
- Fase 7d: el análisis de latencia; agregar `route` a `http_client_request_duration_seconds` para
  restar la latencia del upstream a la del gateway por ruta.
- Verificar `observabilidad/docker-compose.yml` donde haya Docker.

### Lo que deben copiar el BFF y el core (fase 7b)

| Qué | Detalle |
| --- | --- |
| Módulo | `src/observabilidad/{traceparent,atributos,trazas,metricas}.ts` tal cual; el gancho, como middleware de Express (`docs/OBSERVABILIDAD.md`, sección 5) |
| Dependencias | `@opentelemetry/api` 1.9.0, `@opentelemetry/sdk-trace-node` 2.12.0, `@opentelemetry/exporter-trace-otlp-http` 0.223.0, `@opentelemetry/resources` 2.12.0, `prom-client` 15.1.3, y en Jest el transformador de `otlp-exporter-base` |
| Variables | `OTEL_SERVICE_NAME` (`quinde-bff`, `quinde-core`), `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER_ARG`, `TRACE_TRUST_INCOMING=true` (los llama el gateway) y `METRICS_PORT` (9464 en contenedor; 9465 y 9466 en local) |
| Métricas obligatorias | `http_server_request_duration_seconds`, `http_server_requests_total`, `http_client_request_duration_seconds` (bff → core), `quinde_build_info`, las del proceso; `route` siempre plantilla o `__unmatched__` (en gRPC, el nombre de la RPC) |
| Propagación gRPC | El BFF abre un span cliente por llamada al core y manda `traceparent` (y `tracestate`) en la metadata, junto a `x-request-id`. El core lo lee en su interceptor de contexto gRPC y abre su span `SERVER` como hijo |
| Logs | `traceId` y `spanId` de `camposDeTraza()` en cada línea, junto al requestId que ya ponen |
| Respuesta | `X-Trace-Id` en las respuestas HTTP. En GraphQL, además, en `extensions` del error, junto al `requestId` |
| Webhooks y bandeja (7c) | El notifier no manda `traceparent` a terceros. El core guarda el `traceparent` en `evento_saliente` y el relevo continúa esa traza |

## Fase G2: contrato v2 (RDA2)

### Qué se hizo

- **Contrato v2 vendored**: `contracts/vuelos-openapi-v2.yaml`, con el mismo `contrato:sync` y
  `contrato:check` del v1 (los dos, o uno con `--contrato v1|v2`) y el job informativo de CI. Los
  scopes de sus 30 operaciones salen de ahí al arrancar; `test/contrato.spec.ts` fija la tabla.
- **Rutas v2**: `/api/v2/vuelos/webhooks`, `/webhooks/{id}` y `/eventos` al notifier; el resto de
  `/api/v2/vuelos/**` al core. Públicas: `health`, `search`, `seatmap` y `GET flights/{n}/status`.
  Lo que el contrato v2 no declara es 404 en el borde. `/api/v2/oauth2/token` va a `/oauth2/token`
  de identity con el límite estricto; `/oauth2/token` sigue igual.
- **`X-User-*`**: se borran salvo con un token válido de partner (claim `client_id`).
- **`X-Correlation-Id`**: se conserva el válido, se genera el que falta, va a cada upstream, vuelve
  en toda respuesta, es atributo de los spans, va en cada línea de log y la línea de acceso suma
  los campos de §6.4. Es la sección 7 del estándar.
- **Errores del borde v2**: en `/api/v2/**`, el ProblemDetails v2; en el resto, el v1 sin cambios.
- **Estándar**: suben `rpc.*`, `graphql.operation.type` y el upstream `payments`.
- `scripts/e2e-local.sh` recorre el contrato v2 como Booking Prototipo; el smoke suma lo de v2.

### Decisiones (tomadas sin consultar)

1. **`/api/v2/oauth2/token` reescribe la ruta**: es la única excepción a "ninguna regla reescribe la
   ruta", con su campo propio en la tabla (`rutaUpstream`), solo para patrones sin comodines.
   Identity no tiene `/api/v2/oauth2/token` y el contrato lo pide (su `tokenUrl` es relativo al
   server `/api/v2`). Se anotó en CLAUDE.md y en RUTAS.md.
2. **`/oauth2/token` y `/api/v2/oauth2/token` comparten el contador estricto** (se cuenta por la
   ruta de destino). Si no, un atacante tendría el doble de intentos contra el mismo endpoint.
3. **"Se niega por defecto" en v2 es 404, no 401**: lo no declarado (otro método, otra ruta,
   `/api/v2/docs`) responde como una ruta desconocida, sin llegar a ningún servicio y aunque traiga
   un token válido. En v1 sigue como antes (token válido sin scopes) para no romper el backoffice.
4. **Se borra toda `X-User-*`**, no solo `X-User-Id` y `X-User-Roles`: una cabecera de identidad
   nueva que alguien agregue mañana tampoco debe pasar sin partner. Con partner pasan todas
   intactas y el core las valida.
5. **Partner = token válido con `client_id`**, igual que el core e identity. Un token de cliente con
   `client_id` que no sea Booking (por ejemplo `core-vuelos`) también cuenta como partner en el
   borde; sus scopes ya le impiden entrar a lo de v2, y el core decide.
6. **El correlation id del upstream no reemplaza al del gateway** en la respuesta: el gateway borra
   el que manda el servicio y pone el suyo (el mismo que le mandó).
7. **Formato del correlation id: el del core** (`^[A-Za-z0-9._:-]{1,100}$`). Identity exige además
   que empiece con letra o dígito; se anotó como divergencia en el estándar y en lo que necesitan
   los otros repos.
8. **CORS**: `X-Correlation-Id` permitida y expuesta; `Idempotent-Replayed` y `Location`
   expuestas (lo pide `V2-DIFERENCIAS.md` del core). `X-User-*` no se permite en CORS: solo cuenta
   con un token de partner, que es de servidor a servidor.
9. **La línea de acceso conserva sus campos de la 7a** (`metodo`, `ruta`, `upstream`, `ms`,
   `motivo`) y suma los de §6.4 en `snake_case` (`correlation_id`, `request_id`, `service`,
   `operation`, `status`, `latency_ms`, `timestamp`). `operation` es el `operationId` del contrato
   (v1 o v2) o `null`. Las demás líneas llevan `correlationId` (camelCase, como `requestId`), igual
   que identity.
10. **`instance` es la ruta pedida sin la query**, sin normalizar, como el core. **`timestamp`** sale
    del `Reloj` (las pruebas lo fijan).
11. **El 503 sin JWKS es `PROVIDER_UNAVAILABLE` en v2** (el core hace lo mismo con
    `AUTH_UNAVAILABLE`). El 413 y el 405 son `VALIDATION_FAILED`.
12. **Un error del upstream en `/api/v2` pasa tal cual**: el borde solo arma los suyos.
13. **`graphql.root_fields` no entra a la lista común**: su conjunto cerrado es el esquema de cada
    BFF. Si `filtrarAtributos` lo aceptara con cualquier nombre, el filtro del BFF (que se suma al
    común) dejaría pasar alias. `rpc.service` y `rpc.method` sí entran, con su valor validado por
    forma: los servicios los toman de su proto, no de la petición.
14. **Ajv y ajv-formats** como dependencias de desarrollo (las mismas versiones que el core): los
    errores v2 se validan contra el esquema del contrato, no contra una lista escrita a mano.
15. **Verificación real con un notifier v2 falso** (`scripts/e2e/notifier-v2-falso.mjs`): responde
    `/api/v2/vuelos/webhooks*` y `/eventos` y pasa el resto al notifier real, para que v1 siga
    verificándose contra el de verdad.
16. **Cada servicio con su `METRICS_PORT` en el recorrido local**: el BFF (7b) ya abre métricas y
    chocaba con el 9464 del gateway.

### Commits de la fase G2

| Commit | Qué |
| --- | --- |
| `feat(contrato): copiar el contrato v2 del core con sync y check` | El YAML, los scripts, `RUTA_CONTRATO_V2`, el server relativo, CI e imagen |
| `feat(rutas): enrutar /api/v2 con los scopes del contrato v2` | La tabla, el resolver con dos contratos, `rutaUpstream`, `rutas:listar` |
| `feat(seguridad): borrar X-User-* salvo con un token válido de partner` | Cabeceras, pruebas y tres mutaciones |
| `feat(observabilidad): propagar X-Correlation-Id y registrarlo en el acceso` | Contexto, span, logs, CORS, upstream y la sección 7 del estándar |
| `feat(errores): responder los errores del borde en /api/v2 con el ProblemDetails v2` | `problemaV2`, Ajv y la mutación del error v1 |
| `feat(observabilidad): subir al estándar rpc.*, graphql.* y el upstream payments` | `atributos.ts` y el estándar |
| `test(e2e): recorrer el contrato v2 como Booking Prototipo con un X-Correlation-Id` | El recorrido 16 a 23 y el notifier falso |
| `test(mutaciones): poner al día reintento-post, ruta-cruda y exportador-bloquea` | Las anclas que movió la fase; 29 de 29 |
| `docs: ...` | RUTAS, DEPLOY, README, CHANGELOG, smoke y este plan |

### Qué no se pudo verificar

- **El notifier v2 real**: no existe todavía. `/api/v2/vuelos/webhooks*` y `/eventos` se
  verificaron contra el notifier falso; contra el de `main` darían 404.
- **Las operaciones v2 que el core todavía no implementa** (`promociones/contrato`,
  `operaciones/vuelos`, `PATCH flights/{n}/status`, `PUT bookings/{id}/seats`): el borde exige su
  scope (probado), pero el core responde 404.
- **Un despliegue** detrás de Azure Container Apps con Booking de verdad, y la imagen de Docker con
  los dos contratos en local (no hay Docker; el CI la construye y comprueba los dos archivos).

### Hallazgos

- El BFF de `main` (7b) abre su servidor de métricas en el 9464 por defecto: en una sola máquina
  choca con el gateway. En contenedores no pasa (cada uno tiene el suyo).
- Identity y el core no aceptan exactamente el mismo `X-Correlation-Id` (identity exige el primer
  carácter alfanumérico). Detrás del gateway, uno como `-abc` llega igual al core e identity lo
  reemplaza: el proceso queda partido en los logs de identity.
- Una mutación que no compila cuenta como sobreviviente en `scripts/mutaciones.mjs` (no hay
  pruebas que fallen, hay una suite que no corre). Así se vio que `reintento-post` había quedado
  vieja al sumar campos a `DatosReenvio`: conviene correr todas las mutaciones al cerrar cada fase.
- Un `X-User-Id` que manda una persona hoy no hace daño en el core (lo ignora sin `client_id`),
  pero el notifier todavía no tiene la regla: borrarlo en el borde cierra esa puerta mientras tanto.

### Pendientes

- Cuando el notifier publique sus rutas v2, quitar el notifier falso del recorrido local.
- Si el contrato v2 agrega `/api/v2/docs` o una ruta transversal, declararla en la tabla.

### Lo que necesitan los otros repos (no se hizo desde aquí)

| Repo | Cambio mínimo |
| --- | --- |
| notifier_vuelos | `GET`/`POST /api/v2/vuelos/webhooks`, `DELETE /api/v2/vuelos/webhooks/{id}` y `GET /api/v2/vuelos/eventos` con el contrato v2 (el gateway ya los enruta y exige sus scopes); leer y propagar `X-Correlation-Id` (sección 7 del estándar); ProblemDetails v2 en esas rutas |
| identity_vuelos | Alinear el formato del `X-Correlation-Id` con el estándar (`^[A-Za-z0-9._:-]{1,100}$`); `docs/PARTNER-BOOKING.md` ya puede decir que el gateway publica `/api/v2/oauth2/token` |
| backend_vuelos | Volver a copiar `atributos.ts` y `trazas.ts` del gateway: `rpc.*` ya está en el estándar (se quita la divergencia) y `camposDeTraza()` devuelve `correlationId` |
| bff_vuelos | Volver a copiar `atributos.ts` y `trazas.ts`; propagar `X-Correlation-Id` al core en la metadata `x-correlation-id` |
| Booking Prototipo | Base `https://<gateway>/api/v2`; token por `POST https://<gateway>/api/v2/oauth2/token` (`client_credentials`); mandar `X-Correlation-Id` (si no, el gateway lo genera y lo devuelve) |

