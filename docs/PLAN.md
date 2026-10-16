# Plan — Quinde · Gateway

Reto 2 de Integración de Sistemas (PUCE). Fase 6a: la puerta única de la arquitectura. Enruta a
core, bff, identity y notifier, aplica las políticas de seguridad en el borde y esconde lo
interno. No tiene lógica de negocio ni base de datos. Los servicios siguen validando todo: el
gateway nunca es la única barrera.

## Avance

| Fase | Estado | Verificación |
| --- | --- | --- |
| 6a. Gateway | Hecha (2026-10-16), en `feat/r2-gateway` | `lint`, `format:check` y `build` en cada commit. `npm test`: 345 pruebas en 10 suites, contra upstreams falsos HTTP reales y un identity falso con JWKS. `npm run test:mutaciones`: 17 de 17 detectadas. `scripts/smoke.sh` contra el gateway compilado y contra la imagen de Docker (uid 1000, `/health/ready` 200). Recorrido real con los cinco servicios en `main`, solo por el gateway: `scripts/e2e-local.sh`, todo en verde (salida en [E2E-LOCAL.md](E2E-LOCAL.md)) |

## Dependencias (y por qué cada una)

| Paquete | Para qué | Por qué no otra cosa |
| --- | --- | --- |
| `fastify` 5 | Servidor HTTP, hooks y logger JSON (pino, incluido) | Lo pide la fase. Sin Nest: un proxy delgado no necesita inyección de dependencias ni decoradores. El logger viene con Fastify y no hace falta otra dependencia de logs |
| `jose` 6 | Verificar RS256 con el JWKS | Es la del verificador del core y del notifier. Copiarlo tal cual exige la misma biblioteca |
| `yaml` 2 | Leer `contracts/vuelos-openapi.yaml` al arrancar | El contrato del core es YAML. Sin dependencias propias. Una copia convertida a JSON sería un segundo archivo que mantener en sincronía |

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
18. **Rama**: se pidió `feat/r2-gateway` y la sesión tenía asignada `claude/stoic-carson-rfzywk`. El
    trabajo se hizo en `feat/r2-gateway`. Si el push a esa rama no se permitiera, iría a la de la
    sesión (lo dice el reporte del PR).

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
