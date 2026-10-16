# Quinde · Gateway

La puerta única de la arquitectura de vuelos Quinde (Reto 2 de Integración de Sistemas, PUCE, fase
6a). Es la **única entrada pública**: enruta a los cuatro servicios, aplica la seguridad en el borde
y esconde lo interno. No tiene lógica de negocio ni base de datos, y los servicios siguen validando
todo (defensa en profundidad).

```text
                 ┌──────────── gateway (público) ────────────┐
navegador ──────▶│ normaliza → decide → limita → token/scopes │──▶ /graphql            → bff ──gRPC──▶ core
apps, B2B        │ CORS · X-Request-Id · IP real · streaming  │──▶ /flights/v1/webhooks → notifier
                 └────────────────────────────────────────────┘──▶ /flights/v1/**       → core
                                                                ──▶ /identity/v1/**, /oauth2/token, /.well-known/** → identity
                    /internal/** → 404 (nunca se enruta)          core ──▶ notifier /internal/v1/events (red interna)
```

- **Rutas**: una tabla declarativa, sin reescribir prefijos
  ([`src/rutas/tabla-rutas.ts`](src/rutas/tabla-rutas.ts), [`docs/RUTAS.md`](docs/RUTAS.md),
  `npm run rutas:listar`). Una ruta ambigua (`..`, `%2f`, `//`, doble codificación) es 400.
  `/internal/**`, Swagger y el gRPC de los servicios no se exponen.
- **Seguridad**: el verificador de la fase 4b/5a (RS256 fijo, `typ` at+jwt, `iss` y `aud` exactos,
  JWKS de identity). Hay rutas públicas, donde el `Authorization` pasa intacto y el servicio decide,
  y rutas que exigen token con scopes. Los scopes del core se sacan al arrancar de la copia vendored
  de su OpenAPI ([`contracts/vuelos-openapi.yaml`](contracts/vuelos-openapi.yaml)).
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

Node 22, TypeScript estricto y Fastify 5, sin Nest. Las únicas dependencias son `fastify`, `jose` y
`yaml`, justificadas en [`docs/PLAN.md`](docs/PLAN.md). Reglas en [`CLAUDE.md`](CLAUDE.md);
despliegue y variables en [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Empezar en local

```bash
nvm use                 # Node 22 (.nvmrc)
npm ci
cp .env.example .env    # y ajusta las UPSTREAM_*_URL y JWT_ISSUER
npm run build
node --env-file=.env dist/main.js
curl -s localhost:8080/health/upstreams | jq
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
