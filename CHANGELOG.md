# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con
[SemVer](https://semver.org/lang/es/).

## [0.1.0] - 2026-10-16

Primera versión (Reto 2, fase 6a): la puerta única de la arquitectura.

### Agregado

- **Tabla de rutas** declarativa: `/graphql` va al bff; `/flights/v1/webhooks` y
  `/flights/v1/webhooks/{id}` al notifier; el resto de `/flights/v1/**` al core; y
  `/identity/v1/**`, `/oauth2/token` y `/.well-known/**` a identity. Sin reescribir prefijos.
  `/internal/**` es 404 antes que la tabla, sin tocar ningún upstream. Lo desconocido es 404
  ProblemDetails. `npm run rutas:listar` y `docs/RUTAS.md`.
- **Normalización** antes de decidir: `//`, `.`, `..`, `%2e`, `%2f`, `%5c`, `%25` y escapes mal
  formados son 400. Se decide en minúsculas y se reenvía la ruta canónica que se decidió.
- **Seguridad en el borde** con el verificador de identity de la fase 4b/5a:
  - RS256 fijo, `typ` at+jwt, `iss` exacto, `aud` y `exp` con 30 s de tolerancia.
  - Un `kid` desconocido refresca el JWKS con enfriamiento.
  - Sin claves: 503 `AUTH_UNAVAILABLE` con `Retry-After`.
  - Rutas públicas (el `Authorization` pasa intacto) y rutas que exigen token con scopes. Los
    scopes del core se generan al arrancar desde la copia vendored de su OpenAPI.
  - 401 con `WWW-Authenticate: Bearer` (`invalid_token`) y 403 `insufficient_scope`.
- **Cabeceras**:
  - `X-Request-Id` (un uuid; si falta o no sirve, uno nuevo) en la respuesta, hacia el upstream y
    en el log.
  - `traceparent` y `tracestate` pasan intactos.
  - `X-Forwarded-For`, `-Proto` y `-Host` los escribe el gateway con la IP real según
    `TRUST_PROXY_HOPS`.
  - Fuera: hop-by-hop, `Server`, `X-Powered-By` y los `X-Forwarded-*`, `X-Real-IP` y `Forwarded`
    del cliente.
- **CORS único**: preflight 204, lista exacta sin comodín ni credenciales. Los `Access-Control-*`
  del upstream se borran.
- **Límites**: global y estricto (en `/oauth2/token`, `/identity/v1/auth/login` y `/register`) por
  IP y en memoria (por réplica), 429 con `Retry-After`. Cuerpo máximo de 100 kB (413).
  `nosniff`, y HSTS en producción.
- **Proxy en streaming** con `node:http`: sin buffer ni recompresión. Plazo por upstream (core 45 s,
  bff 50 s, identity y notifier 10 s). Sin reintentos. 502 y 504 sin URL ni mensajes internos.
- **Salud**: `/health`, `/health/ready` y `/health/upstreams` (informativo, 2 s por servicio).
- **Contrato**: `contracts/vuelos-openapi.yaml` con `contrato:sync` y `contrato:check`, y un job
  informativo en CI.
- **Operación**:
  - Logs JSON de acceso: requestId, método, ruta sin query, upstream, status y ms. Sin
    `Authorization`, tokens ni cuerpos.
  - Dockerfile multi-etapa sin privilegios.
  - CI: lint, formato, tipos, build, pruebas, smoke, contrato e imagen.
  - `scripts/smoke.sh` y `scripts/e2e-local.sh`.
- **Pruebas**: 345 en 10 suites contra upstreams falsos reales y un identity falso con JWKS.
  `scripts/mutaciones.mjs` con 17 mutaciones, todas detectadas.
