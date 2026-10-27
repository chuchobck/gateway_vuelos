# Quinde · Gateway

La puerta única de la arquitectura de vuelos Quinde (Reto 2 de Integración de Sistemas, PUCE, fases
6a, 7a y G2). Es la **única entrada pública**: enruta a los cuatro servicios, aplica la seguridad en el borde
y esconde lo interno. No tiene lógica de negocio ni base de datos, y los servicios siguen validando
todo (defensa en profundidad).

```text
                 ┌──────────── gateway (público) ────────────┐
navegador ──────▶│ normaliza → decide → limita → token/scopes │──▶ /graphql            → bff ──gRPC──▶ core
apps, B2B        │ CORS · X-Request-Id · IP real · streaming  │──▶ /flights/v1/webhooks → notifier
Booking (v2)     │ X-Correlation-Id · X-User-* solo partner   │──▶ /flights/v1/**       → core
                 └────────────────────────────────────────────┘──▶ /api/v2/vuelos/webhooks*, /eventos → notifier
                                                                ──▶ /api/v2/vuelos/**   → core
                                                                ──▶ /identity/v1/**, /oauth2/token, /api/v2/oauth2/token, /.well-known/** → identity
                    /internal/** → 404 (nunca se enruta)          core ──▶ notifier /internal/v1/events (red interna)
```

- **Rutas**: una tabla declarativa, sin reescribir prefijos (salvo `/api/v2/oauth2/token` →
  `/oauth2/token`) ([`src/rutas/tabla-rutas.ts`](src/rutas/tabla-rutas.ts),
  [`docs/RUTAS.md`](docs/RUTAS.md), `npm run rutas:listar`). Una ruta ambigua (`..`, `%2f`, `//`, doble codificación) es 400.
  `/internal/**`, Swagger y el gRPC de los servicios no se exponen.
- **Seguridad**: el verificador de la fase 4b/5a (RS256 fijo, `typ` at+jwt, `iss` y `aud` exactos,
  JWKS de identity). Hay rutas públicas, donde el `Authorization` pasa intacto y el servicio decide,
  y rutas que exigen token con scopes. Los scopes del core se sacan al arrancar de las copias
  vendored de sus dos OpenAPI: v1 ([`contracts/vuelos-openapi.yaml`](contracts/vuelos-openapi.yaml))
  y v2 ([`contracts/vuelos-openapi-v2.yaml`](contracts/vuelos-openapi-v2.yaml)); lo que el v2 no
  declara es 404.
- **Contrato v2 (Booking Prototipo)**: `X-User-Id` y `X-User-Roles` solo pasan con un token de
  partner (`client_id`); en `/api/v2/**` los errores del borde son el ProblemDetails v2 (con
  `instance`, `correlation_id` y `timestamp`).
- **Borde**:
  - CORS único (borra el del upstream).
  - IP real según `TRUST_PROXY_HOPS`.
  - Límite global y estricto por IP.
  - 100 kB por cuerpo.
  - `X-Request-Id`, `nosniff` y HSTS en producción.
- **Proxy**: en streaming, sin buffer ni recompresión. Plazo por upstream (502 caído, 504 lento) y
  sin reintentos.
- **Salud**: `/health`, `/health/ready` (no depende de los upstreams) y `/health/upstreams`
  (informativo).
- **Observabilidad**:
  - Trazas W3C con OpenTelemetry: el gateway es la raíz y propaga `traceparent` a cada upstream.
  - `X-Trace-Id` en cada respuesta y `traceId` en cada línea de log.
  - `X-Correlation-Id` (el proceso de negocio): se conserva o se genera, va a cada upstream y vuelve
    en toda respuesta; la línea de acceso lleva los campos del contrato v2 (§6.4).
  - Métricas Prometheus en un puerto aparte (`METRICS_PORT`, 9464).
  - El estándar que siguen los demás servicios está en
    [`docs/OBSERVABILIDAD.md`](docs/OBSERVABILIDAD.md); Jaeger y Prometheus locales, en
    [`observabilidad/`](observabilidad/).

Node 22, TypeScript estricto y Fastify 5, sin Nest. Dependencias: `fastify`, `jose`, `yaml`,
OpenTelemetry (`api`, `sdk-trace-node`, `exporter-trace-otlp-http`, `resources`) y `prom-client`
(en desarrollo, además, `ajv` para validar los errores contra el contrato), justificadas en
[`docs/PLAN.md`](docs/PLAN.md). Reglas en [`CLAUDE.md`](CLAUDE.md);
despliegue y variables en [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Empezar en local

```bash
nvm use                 # Node 22 (.nvmrc)
npm ci
cp .env.example .env    # y ajusta las UPSTREAM_*_URL y JWT_ISSUER
npm run build
node --env-file=.env dist/main.js
curl -s localhost:8080/health/upstreams | jq
curl -s localhost:9464/metrics | grep '^http_server_requests_total'
```

Con los cinco servicios de verdad (identity, core, notifier, bff y este gateway) y un recorrido
completo solo por el gateway, ver [`docs/E2E-LOCAL.md`](docs/E2E-LOCAL.md):

```bash
scripts/e2e-local.sh --preparar
```

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run build` | Compila a `dist/` |
| `npm run lint` / `format:check` / `typecheck` | Calidad (también corren en CI) |
| `npm test` | Pruebas contra upstreams falsos HTTP reales y un identity falso con JWKS |
| `npm run test:mutaciones` | Rompe a propósito lo que cubre cada prueba y exige que falle (17 mutaciones) |
| `npm run rutas:listar` | Imprime la tabla de rutas: ruta, método, upstream, seguridad y scopes |
| `npm run contrato:sync` / `contrato:check` | Trae o compara el OpenAPI del core (de `main` de backend_vuelos) |
| `scripts/smoke.sh <URL>` | Lo que el borde responde sin depender de los servicios |
| `scripts/e2e-local.sh` | El recorrido real con los cinco servicios |

## Frontends detrás del gateway

| Frontend | Configuración |
| --- | --- |
| e-commerce_vuelos | `VITE_API_URL=https://<gateway>/flights/v1` y `VITE_GRAPHQL_URL=https://<gateway>/graphql`. La cuenta va a `https://<gateway>/identity/v1/auth/*` (cambio pendiente en ese repo) |
| backoffice_vuelos | `public/config.js` → `API_URL: "https://<gateway>/flights/v1"`. Login y administradores van a `/identity/v1/auth/*` y `/identity/v1/admin/users` (cambio pendiente en ese repo) |

El `CORS_ORIGINS` del gateway lleva los orígenes de los dos.
