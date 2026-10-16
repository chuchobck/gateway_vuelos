# Rutas del gateway

La tabla vive en un solo archivo, [`src/rutas/tabla-rutas.ts`](../src/rutas/tabla-rutas.ts), y la
seguridad de cada operación del core sale al arrancar de la copia vendored de su OpenAPI
([`contracts/vuelos-openapi.yaml`](../contracts/vuelos-openapi.yaml)). Esta página es la salida de:

```bash
npm run rutas:listar               # en texto
npm run rutas:listar -- --markdown # esta tabla
```

## Cómo se decide

Para cada petición, en este orden:

1. **Normalizar** la ruta (`src/rutas/normalizar-ruta.ts`). Si se puede leer de dos maneras, la
   respuesta es **400** y no se decide nada más.
2. **`/internal/**`**: **404** sin tocar ningún upstream. Esto pasa antes que la tabla: aunque una
   regla lo cubriera, `/internal` no se enruta.
3. **Primera regla que coincide**. `*` es un segmento; `**`, cero o más. La comparación es en
   minúsculas. Si ninguna coincide: **404**. Ahí caen también `/api/docs` de cada servicio y el
   gRPC del core, que no se exponen.
4. **Seguridad de la regla**:
   - `publica`: el gateway no mira el token. El `Authorization`, válido o no, pasa intacto y el
     servicio decide.
   - `token`: exige un token de identity con todos los scopes de la regla.
   - `contrato`: la operación del OpenAPI del core por método y plantilla. HEAD se resuelve como
     GET. Lo que el contrato no declara (otro método, otra ruta) exige un token válido sin scopes:
     se niega por defecto.
5. **Reenviar sin reescribir**: cada servicio conserva su prefijo.

Ninguna regla reescribe la ruta. Lo que se reenvía es la ruta canónica que se decidió: decodificada
una vez, re-codificada y sin barra final. La query va tal cual.

## Tabla

Contrato del core: 1.5.0.0 (22 operaciones).

| Ruta | Método | Upstream | Seguridad | Scopes |
| --- | --- | --- | --- | --- |
| `/internal/**` | `*` | `— (404)` | `bloqueada` |  |
| `/health` | `GET` | `gateway` | `publica` |  |
| `/health/ready` | `GET` | `gateway` | `publica` |  |
| `/health/upstreams` | `GET` | `gateway` | `publica` |  |
| `/graphql` | `*` | `bff` | `publica` |  |
| `/flights/v1/webhooks` | `*` | `notifier` | `token` | `flights:webhooks` |
| `/flights/v1/webhooks/*` | `*` | `notifier` | `token` | `flights:webhooks` |
| `/flights/v1/admin/**` | `*` | `core` | `token` | `flights:admin` |
| `/flights/v1/health` | `*` | `core` | `publica` |  |
| `/flights/v1/auth/**` | `*` | `core` | `publica` |  |
| `/flights/v1/search` | `POST` | `core` | `publica (contrato)` |  |
| `/flights/v1/offers/{offerId}/seatmap` | `GET` | `core` | `publica (contrato)` |  |
| `/flights/v1/offers/hold` | `POST` | `core` | `token (contrato)` | `flights:hold` |
| `/flights/v1/offers/hold/{holdId}` | `GET` | `core` | `token (contrato)` | `flights:read` |
| `/flights/v1/offers/hold/{holdId}` | `DELETE` | `core` | `token (contrato)` | `flights:hold` |
| `/flights/v1/bookings` | `GET` | `core` | `token (contrato)` | `flights:read` |
| `/flights/v1/bookings` | `POST` | `core` | `token (contrato)` | `flights:book` |
| `/flights/v1/bookings/{bookingId}` | `GET` | `core` | `token (contrato)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/baggage-options` | `GET` | `core` | `token (contrato)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/baggage` | `POST` | `core` | `token (contrato)` | `flights:book` |
| `/flights/v1/bookings/{bookingId}/date-change/search` | `POST` | `core` | `token (contrato)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/date-change` | `POST` | `core` | `token (contrato)` | `flights:book` |
| `/flights/v1/bookings/{bookingId}/cancellation-quote` | `GET` | `core` | `token (contrato)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/cancel` | `POST` | `core` | `token (contrato)` | `flights:cancel` |
| `/flights/v1/bookings/{bookingId}/tickets` | `GET` | `core` | `token (contrato)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/tickets/{ticketId}` | `GET` | `core` | `token (contrato)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/check-in` | `POST` | `core` | `token (contrato)` | `flights:book` |
| `/flights/v1/bookings/{bookingId}/boarding-passes` | `GET` | `core` | `token (contrato)` | `flights:read` |
| `/flights/v1/flights/{flightNumber}/status` | `GET` | `core` | `publica (contrato)` |  |
| `/flights/v1/**` | `*` | `core` | `token (fuera del contrato)` |  |
| `/identity/v1/admin/**` | `*` | `identity` | `token` | `flights:admin` |
| `/identity/v1/auth/login` | `*` | `identity` | `publica + límite estricto` |  |
| `/identity/v1/auth/register` | `*` | `identity` | `publica + límite estricto` |  |
| `/identity/v1/**` | `*` | `identity` | `publica` |  |
| `/oauth2/token` | `*` | `identity` | `publica + límite estricto` |  |
| `/.well-known/**` | `*` | `identity` | `publica` |  |
| `(cualquier otra)` | `*` | `— (404)` |  |  |

Las operaciones del contrato bajo `/flights/v1/webhooks` (GET y POST `/webhooks`, DELETE
`/webhooks/{id}`) van al notifier por sus dos reglas, que van antes. Exigen el mismo scope que el
contrato declara. Una prueba lo compara: `test/contrato.spec.ts`.

## Notas por regla

- **`/graphql`**: es pública. El BFF limita por operación, rechaza lotes y fija la profundidad
  máxima. Una ruta bajo `/graphql/...` es 404.
- **`/flights/v1/webhooks/*`**: solo un nivel (`DELETE /webhooks/{id}`), como pide el plan. Algo
  más profundo (`/webhooks/x/y`) cae en `/flights/v1/**` y llega al core, que con
  `WEBHOOKS_MODE=notifier` responde 404.
- **`/flights/v1/admin/**`**: el catálogo, `audit-log` y `bookings` de administración del core.
  Están fuera del contrato y el core exige `flights:admin`.
- **`/flights/v1/auth/**`**: es el login local del core. Con `AUTH_MODE=external` no existe y el
  core responde 404. Se deja pública para que un frontend sin migrar reciba ese 404 claro y no un
  401 del borde.
- **`/identity/v1/**`**: refresh, logout y me. Identity decide: logout y me exigen el token de una
  persona.
- **Límite estricto**: `/oauth2/token`, `/identity/v1/auth/login` y `/register` llevan un contador
  por IP y por ruta, además del global. Ver `RATE_LIMIT_STRICT_*` en [DEPLOY.md](DEPLOY.md).
- **Cuerpo máximo**: 100 kB en todas las rutas, el `LIMITE_CUERPO` de los cuatro servicios. Con un
  `Content-Length` mayor, 413 sin abrir el upstream. En trozos, el gateway corta al pasar el tope
  y también responde 413.

## Normalización: qué es 400

| Entrada | Resultado |
| --- | --- |
| `//`, segmento vacío | 400 |
| `.` o `..`, también `%2e`, `%2E%2e` | 400 (no se resuelven) |
| `%2f`, `%5c` (separador codificado) | 400 |
| `%25` (doble codificación) | 400 |
| `%zz`, `%` suelto, `%00` y controles | 400 |
| `\`, `#` | 400 |
| Una ruta que no empieza con `/` (`http://host/...`, `*`) | 400 |
| `/A/B` | Se decide como `/a/b` y se reenvía `/A/B` (Express no distingue mayúsculas) |
| `/%77ebhooks` | Se decide y se reenvía como `/webhooks` |
| `/a/b/` | Se decide y se reenvía como `/a/b` |

## Errores del borde

Todos son `application/problem+json`, con el mismo cuerpo que los ProblemDetails del contrato del
core: `type`, `title`, `status`, `detail` y `code`. Siempre llevan `X-Request-Id`. El request id va
en la cabecera y no en el cuerpo, porque el esquema del contrato no admite campos extra.

| Status | `code` | Cuándo |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | Ruta ambigua o mal formada |
| 401 | `VALIDATION_FAILED` | Sin token, o token inválido. Lleva `WWW-Authenticate: Bearer realm="quinde-vuelos-api"` y, si hay token, `error="invalid_token"` |
| 403 | `VALIDATION_FAILED` | Faltan scopes. Lleva `error="insufficient_scope"` y `scope="..."` |
| 404 | `VALIDATION_FAILED` | Ruta desconocida o `/internal/**`: la misma respuesta para las dos |
| 405 | `VALIDATION_FAILED` | Un método distinto de GET y HEAD en `/health*` |
| 413 | `VALIDATION_FAILED` | Cuerpo de más de 100 kB |
| 429 | `RATE_LIMIT_EXCEEDED` | Límite global o estricto. Lleva `Retry-After` |
| 502 | `VALIDATION_FAILED` | Upstream caído o conexión cortada |
| 503 | `AUTH_UNAVAILABLE` | Sin JWKS con qué verificar. Lleva `Retry-After` |
| 504 | `VALIDATION_FAILED` | El upstream no respondió dentro de su plazo |

Una respuesta del upstream, incluido un 503 con su `Retry-After`, pasa tal cual.
