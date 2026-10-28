# Rutas del gateway

La tabla vive en un solo archivo, [`src/rutas/tabla-rutas.ts`](../src/rutas/tabla-rutas.ts), y la
seguridad de cada operación del core sale al arrancar de las copias vendored de sus dos OpenAPI:
el v1 ([`contracts/vuelos-openapi.yaml`](../contracts/vuelos-openapi.yaml), `/flights/v1`) y el v2
([`contracts/vuelos-openapi-v2.yaml`](../contracts/vuelos-openapi-v2.yaml), `/api/v2`, el que usa
Booking Prototipo). Esta página es la salida de:

```bash
npm run rutas:listar               # en texto
npm run rutas:listar -- --markdown # esta tabla
```

## Cómo se decide

Para cada petición, en este orden:

1. **Normalizar** la ruta (`src/rutas/normalizar-ruta.ts`). Si se puede leer de dos maneras, la
   respuesta es **400** y no se decide nada más.
2. **`/internal/**` y `/metrics`**: **404** sin tocar ningún upstream. Esto pasa antes que la tabla:
   aunque una regla los cubriera, no se enrutan. Las métricas van en su propio puerto
   (`METRICS_PORT`), que el ingress no expone ([OBSERVABILIDAD.md](OBSERVABILIDAD.md)).
3. **Primera regla que coincide**. `*` es un segmento; `**`, cero o más. La comparación es en
   minúsculas. Si ninguna coincide: **404**. Ahí caen también `/api/docs` de cada servicio y el
   gRPC del core, que no se exponen.
4. **Seguridad de la regla**:
   - `publica`: el gateway no mira el token. El `Authorization`, válido o no, pasa intacto y el
     servicio decide.
   - `token`: exige un token de identity con todos los scopes de la regla.
   - `contrato`: la operación del OpenAPI del core (v1 o v2, según la regla) por método y
     plantilla. HEAD se resuelve como GET. Lo que el contrato no declara (otro método, otra ruta):
     - en v1 (`/flights/v1/**`), exige un token válido sin scopes;
     - en v2 (`/api/v2/**`), **404** sin llegar a ningún servicio. Booking solo ve lo que el contrato
       v2 publica; `/api/v2/docs` tampoco se expone.
5. **Reenviar sin reescribir**: cada servicio conserva su prefijo. Una sola excepción:
   `/api/v2/oauth2/token` llega a identity como `/oauth2/token` (abajo).
6. **Cabeceras de identidad**: `X-User-Id`, `X-User-Roles` y cualquier `X-User-*` del cliente
   solo pasan si la regla exigió token y el token válido es de un **partner** (trae el claim
   `client_id`). Sin token, con un token de persona y en toda ruta pública se borran.
7. **`X-Correlation-Id`**: el válido pasa sin cambios; si falta o no sirve, el gateway lo genera
   (`corr-<uuid>`). Va al upstream y vuelve en toda respuesta
   ([OBSERVABILIDAD.md](OBSERVABILIDAD.md), sección 7).

La plantilla de la regla (o la de la operación del contrato) nombra el span de la petición y etiqueta
sus métricas y su línea de acceso: `*` se escribe `{id}` (`/flights/v1/webhooks/{id}`) y `**` se deja.
Lo que no coincide con ninguna regla (404, bloqueada, ambigua) es `__unmatched__`. La ruta pedida no
va nunca a un span, una métrica ni un log.

Lo que se reenvía es la ruta canónica que se decidió: decodificada una vez, re-codificada y sin
barra final. La query va tal cual.

## Tabla

Contrato v1 del core: 1.5.0.0 (22 operaciones)
Contrato v2 del core: 2.0.0 (30 operaciones)

| Ruta | Método | Upstream | Seguridad | Scopes |
| --- | --- | --- | --- | --- |
| `/internal/**` | `*` | `— (404)` | `bloqueada` |  |
| `/metrics/**` | `*` | `— (404)` | `bloqueada` |  |
| `/health` | `GET` | `gateway` | `publica` |  |
| `/health/ready` | `GET` | `gateway` | `publica` |  |
| `/health/upstreams` | `GET` | `gateway` | `publica` |  |
| `/graphql` | `*` | `bff` | `publica` |  |
| `/flights/v1/webhooks` | `*` | `notifier` | `token` | `flights:webhooks` |
| `/flights/v1/webhooks/*` | `*` | `notifier` | `token` | `flights:webhooks` |
| `/flights/v1/admin/**` | `*` | `core` | `token` | `flights:admin` |
| `/flights/v1/health` | `*` | `core` | `publica` |  |
| `/flights/v1/auth/**` | `*` | `core` | `publica` |  |
| `/flights/v1/search` | `POST` | `core` | `publica (contrato v1)` |  |
| `/flights/v1/offers/{offerId}/seatmap` | `GET` | `core` | `publica (contrato v1)` |  |
| `/flights/v1/offers/hold` | `POST` | `core` | `token (contrato v1)` | `flights:hold` |
| `/flights/v1/offers/hold/{holdId}` | `GET` | `core` | `token (contrato v1)` | `flights:read` |
| `/flights/v1/offers/hold/{holdId}` | `DELETE` | `core` | `token (contrato v1)` | `flights:hold` |
| `/flights/v1/bookings` | `GET` | `core` | `token (contrato v1)` | `flights:read` |
| `/flights/v1/bookings` | `POST` | `core` | `token (contrato v1)` | `flights:book` |
| `/flights/v1/bookings/{bookingId}` | `GET` | `core` | `token (contrato v1)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/baggage-options` | `GET` | `core` | `token (contrato v1)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/baggage` | `POST` | `core` | `token (contrato v1)` | `flights:book` |
| `/flights/v1/bookings/{bookingId}/date-change/search` | `POST` | `core` | `token (contrato v1)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/date-change` | `POST` | `core` | `token (contrato v1)` | `flights:book` |
| `/flights/v1/bookings/{bookingId}/cancellation-quote` | `GET` | `core` | `token (contrato v1)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/cancel` | `POST` | `core` | `token (contrato v1)` | `flights:cancel` |
| `/flights/v1/bookings/{bookingId}/tickets` | `GET` | `core` | `token (contrato v1)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/tickets/{ticketId}` | `GET` | `core` | `token (contrato v1)` | `flights:read` |
| `/flights/v1/bookings/{bookingId}/check-in` | `POST` | `core` | `token (contrato v1)` | `flights:book` |
| `/flights/v1/bookings/{bookingId}/boarding-passes` | `GET` | `core` | `token (contrato v1)` | `flights:read` |
| `/flights/v1/flights/{flightNumber}/status` | `GET` | `core` | `publica (contrato v1)` |  |
| `/flights/v1/**` | `*` | `core` | `token (fuera del contrato v1)` |  |
| `/api/v2/vuelos/webhooks` | `GET` | `notifier` | `token (contrato v2)` | `flights:webhooks` |
| `/api/v2/vuelos/webhooks` | `POST` | `notifier` | `token (contrato v2)` | `flights:webhooks` |
| `/api/v2/vuelos/webhooks` | `*` | `— (404)` | `negada (fuera del contrato v2)` |  |
| `/api/v2/vuelos/webhooks/{id}` | `DELETE` | `notifier` | `token (contrato v2)` | `flights:webhooks` |
| `/api/v2/vuelos/webhooks/*` | `*` | `— (404)` | `negada (fuera del contrato v2)` |  |
| `/api/v2/vuelos/eventos` | `GET` | `notifier` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/eventos` | `*` | `— (404)` | `negada (fuera del contrato v2)` |  |
| `/api/v2/vuelos/health` | `GET` | `core` | `publica (contrato v2)` |  |
| `/api/v2/vuelos/promociones/contrato` | `GET` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/promociones/contrato` | `PUT` | `core` | `token (contrato v2)` | `flights:admin` |
| `/api/v2/vuelos/search` | `POST` | `core` | `publica (contrato v2)` |  |
| `/api/v2/vuelos/offers/{offerId}/seatmap` | `GET` | `core` | `publica (contrato v2)` |  |
| `/api/v2/vuelos/flights/{flightNumber}/status` | `GET` | `core` | `publica (contrato v2)` |  |
| `/api/v2/vuelos/flights/{flightNumber}/status` | `PATCH` | `core` | `token (contrato v2)` | `flights:ops` |
| `/api/v2/vuelos/operaciones/vuelos` | `GET` | `core` | `token (contrato v2)` | `flights:ops` |
| `/api/v2/vuelos/offers/hold` | `POST` | `core` | `token (contrato v2)` | `flights:hold` |
| `/api/v2/vuelos/offers/hold/{holdId}` | `GET` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/offers/hold/{holdId}` | `DELETE` | `core` | `token (contrato v2)` | `flights:hold` |
| `/api/v2/vuelos/bookings` | `GET` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/bookings` | `POST` | `core` | `token (contrato v2)` | `flights:book` |
| `/api/v2/vuelos/bookings/{bookingId}` | `GET` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/bookings/{bookingId}/tickets` | `GET` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/bookings/{bookingId}/tickets` | `POST` | `core` | `token (contrato v2)` | `flights:book` |
| `/api/v2/vuelos/bookings/{bookingId}/tickets/{ticketId}` | `GET` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/bookings/{bookingId}/seats` | `PUT` | `core` | `token (contrato v2)` | `flights:book` |
| `/api/v2/vuelos/bookings/{bookingId}/check-in` | `POST` | `core` | `token (contrato v2)` | `flights:book` |
| `/api/v2/vuelos/bookings/{bookingId}/boarding-passes` | `GET` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/bookings/{bookingId}/baggage-options` | `GET` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/bookings/{bookingId}/baggage` | `POST` | `core` | `token (contrato v2)` | `flights:book` |
| `/api/v2/vuelos/bookings/{bookingId}/date-change/search` | `POST` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/bookings/{bookingId}/date-change` | `POST` | `core` | `token (contrato v2)` | `flights:book` |
| `/api/v2/vuelos/bookings/{bookingId}/cancellation-quote` | `GET` | `core` | `token (contrato v2)` | `flights:read` |
| `/api/v2/vuelos/bookings/{bookingId}/cancel` | `POST` | `core` | `token (contrato v2)` | `flights:cancel` |
| `/api/v2/vuelos/**` | `*` | `— (404)` | `negada (fuera del contrato v2)` |  |
| `/api/v2/oauth2/token` | `*` | `identity → /oauth2/token` | `publica + límite estricto` |  |
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

### Contrato v2 (`/api/v2`), en resumen

| Ruta | Upstream | Seguridad |
| --- | --- | --- |
| `/api/v2/vuelos/webhooks`, `/api/v2/vuelos/webhooks/{id}` | notifier | `flights:webhooks` (del contrato v2) |
| `/api/v2/vuelos/eventos` | notifier | `flights:read` (del contrato v2) |
| `GET /api/v2/vuelos/health`, `POST /search`, `GET /offers/{offerId}/seatmap`, `GET /flights/{n}/status` | core | pública |
| El resto de las 30 operaciones de `/api/v2/vuelos/**` | core | el scope de cada una en el contrato v2 |
| `/api/v2/oauth2/token` | identity (`/oauth2/token`) | pública + límite estricto |
| Cualquier otra bajo `/api/v2` (otro método, otra ruta, `/api/v2/docs`) | — | 404 v2 en el borde |

Las dos tablas de scopes (v1 y v2) están fijadas en `test/contrato.spec.ts`: si `contrato:sync` trae
un cambio, la prueba falla a propósito.

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
- **`/api/v2/oauth2/token`**: el `tokenUrl` del contrato v2 es relativo (`/oauth2/token`) y se
  resuelve contra su server `/api/v2`. El gateway lo publica ahí y lo manda a `/oauth2/token` de
  identity (la query pasa igual). Es la **única** regla que reescribe la ruta (`rutaUpstream` en la
  tabla). `/oauth2/token` sigue igual.
- **`/api/v2/vuelos/webhooks*` y `/eventos`**: los sirve el notifier, no el core. El notifier de
  `main` todavía no tiene sus rutas v2 (llegan en su fase v2): hasta entonces responde su 404.
- **`/api/v2/vuelos/**` no implementado en el core**: `promociones/contrato`, `operaciones/vuelos`,
  `PATCH flights/{n}/status` y `PUT bookings/{id}/seats` están en el contrato v2 pero no en la fase
  V1 del core. El borde exige igual su scope y el core responde 404.
- **Límite estricto**: `/oauth2/token`, `/api/v2/oauth2/token`, `/identity/v1/auth/login` y
  `/register` llevan un contador por IP y por ruta, además del global. `/oauth2/token` y
  `/api/v2/oauth2/token` **comparten** el contador (se cuenta por la ruta de destino): usar los dos
  no duplica el cupo. Ver `RATE_LIMIT_STRICT_*` en [DEPLOY.md](DEPLOY.md).
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

Todos son `application/problem+json` y siempre llevan `X-Request-Id`, `X-Trace-Id` y
`X-Correlation-Id` en cabeceras. El cuerpo depende de la ruta pedida:

- **En `/api/v2/**`**: el `ProblemDetails` del contrato v2: `type`, `title`, `status`, `detail`,
  `instance` (la ruta pedida, sin la query), `code` (del enum v2), `correlation_id` y `timestamp`.
  `test/errores-v2.spec.ts` lo valida con Ajv contra el esquema del contrato.
- **En el resto** (`/flights/v1`, `/identity/v1`...): el de v1, sin cambios: `type`, `title`,
  `status`, `detail` y `code`. El esquema v1 no admite campos extra, por eso el correlation id va
  solo en la cabecera.

`type` es `https://api.booking-hub.com/errors/<code en minúsculas con guiones>`, en v1 y en v2.

| Status | `code` v1 | `code` v2 | Cuándo |
| --- | --- | --- | --- |
| 400 | `VALIDATION_FAILED` | `VALIDATION_FAILED` | Ruta ambigua o mal formada |
| 401 | `VALIDATION_FAILED` | `UNAUTHORIZED` | Sin token, o token inválido. Lleva `WWW-Authenticate: Bearer realm="quinde-vuelos-api"` y, si hay token, `error="invalid_token"` |
| 403 | `VALIDATION_FAILED` | `FORBIDDEN` | Faltan scopes. Lleva `error="insufficient_scope"` y `scope="..."` |
| 404 | `VALIDATION_FAILED` | `NOT_FOUND` | Ruta desconocida, `/internal/**` o (en v2) no declarada: la misma respuesta |
| 405 | `VALIDATION_FAILED` | — | Un método distinto de GET y HEAD en `/health*` (fuera de v2) |
| 413 | `VALIDATION_FAILED` | `VALIDATION_FAILED` | Cuerpo de más de 100 kB |
| 429 | `RATE_LIMIT_EXCEEDED` | `RATE_LIMIT_EXCEEDED` | Límite global o estricto. Lleva `Retry-After` |
| 500 | `VALIDATION_FAILED` | `INTERNAL_ERROR` | Un error imprevisto del gateway |
| 502 | `VALIDATION_FAILED` | `PROVIDER_UNAVAILABLE` | Upstream caído o conexión cortada |
| 503 | `AUTH_UNAVAILABLE` | `PROVIDER_UNAVAILABLE` | Sin JWKS con qué verificar. Lleva `Retry-After` |
| 504 | `VALIDATION_FAILED` | `PROVIDER_UNAVAILABLE` | El upstream no respondió dentro de su plazo |

Los `code` v2 son los mismos que da el core en `/api/v2` para ese status (`codigoV2PorDefecto`):
Booking no nota si el error lo dio el borde o el servicio. Una respuesta del upstream, incluido un
503 con su `Retry-After`, pasa tal cual.
