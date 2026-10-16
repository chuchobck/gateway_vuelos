# Verificación local con los cinco servicios

`scripts/e2e-local.sh` levanta los cinco servicios y un receptor de webhooks en local:

- identity
- core (`AUTH_MODE=external`, `WEBHOOKS_MODE=notifier`, gRPC encendido)
- notifier
- bff
- este gateway
- el receptor de webhooks

Después entra **solo por el gateway** (`http://localhost:8080`). Ningún paso del recorrido llama a
un servicio directo.

## Requisitos

- Los repos como carpetas vecinas, en `main`, con `npm ci` y `npm run build` hechos:

  ```
  ../backend_vuelos  ../identity_vuelos  ../notifier_vuelos  ../bff_vuelos  ./ (gateway_vuelos)
  ```

- Un PostgreSQL **local** en `PG_URL` (por defecto `postgresql://postgres:postgres@localhost:5432`)
  con `psql` en el `PATH`. `--preparar` **borra y vuelve a crear** `booking_db`, `identity_db` y
  `notifier_db`.
- `curl`, `jq` y `openssl`.
- Puertos libres: 3000 (core), 50051 (gRPC del core), 3001 (identity), 3002 (notifier), 4000 (bff),
  8080 (gateway) y 4010 (receptor). Si alguno está ocupado, el script se detiene antes de arrancar.

## Uso

```bash
scripts/e2e-local.sh --preparar     # bases nuevas, claves de identity y cliente core-vuelos; y recorre
scripts/e2e-local.sh                # reusa lo preparado: arranca, recorre y apaga
scripts/e2e-local.sh --dejar-arriba # no apaga al terminar (para seguir probando a mano)
scripts/e2e-local.sh --detener      # apaga lo que haya quedado arriba
```

Lo generado queda en `E2E_DIR` (por defecto `/var/tmp/quinde-e2e`, modo 700) y nunca en el repo:

- `estado.env`: la clave de firma de identity, el secreto del cliente `core-vuelos`, las claves
  de cifrado de webhooks y la contraseña del administrador.
- `logs/`: un archivo por proceso.
- `receptor.jsonl`: lo que recibió el receptor.

La salida no lleva tokens completos ni secretos.

## Preparar (`--preparar`)

1. **core**: carga `esquema_vuelos.sql`, `esquema_seguridad.sql`, `semilla_vuelos.sql` y
   `semilla_seguridad.sql`, lo mismo que hace su `db/reset.sh` (que usa `docker exec`), pero con el
   `psql` local.
2. **identity**: `db/reset.sh`, con el administrador `admin@e2e.quinde.example` y una contraseña al
   azar, y después **`db/migrar.sh`**. Su clave de firma sale de `generar-claves.js`.
3. **notifier**: `db/reset.sh`.
4. **Cliente `core-vuelos`** en identity: `crear-cliente.js --scopes "events:publish"
   --permitir-eventos`. Con él, el core publica sus eventos al notifier.

## Configuración con que arranca cada uno

Todos usan `JWT_ISSUER=http://localhost:8080`, el origen público del gateway, y
`JWT_AUDIENCE=quinde-vuelos-api`. Core y notifier bajan el JWKS de identity por la red interna
(`JWKS_URL=http://localhost:3001/.well-known/jwks.json`). Los cuatro servicios corren con
`TRUST_PROXY=1` y el gateway con `TRUST_PROXY_HOPS=0`.

## El recorrido

| Paso | Qué hace y qué se espera |
| --- | --- |
| 1 | Registro y login de una persona por `/identity/v1/auth`. El token trae `iss` = el gateway |
| 2 | `/.well-known/openid-configuration` por el gateway: `issuer`, `jwks_uri` y `token_endpoint` apuntan al gateway |
| 3 | `/graphql` con `searchFlights`: el bff le pregunta al core por gRPC |
| 4 | `GET /flights/v1/bookings` sin token: 401 en el borde. Con token: 200 |
| 5 | `GET /identity/v1/admin/users` con la persona: 403 en el borde. Con el administrador: 200 |
| 6 | `POST /flights/v1/webhooks` (llega al notifier) apuntando al receptor |
| 7 | Una reserva real: `search`, `offers/hold` y `bookings` con `PAY-OK-...` |
| 8 | El receptor recibe `booking.confirmed` de esa reserva. La firma se recalcula con `openssl` (HMAC-SHA256 de `"<timestamp>.<cuerpo>"` con el secreto de la suscripción) |
| 9 | `/internal/v1/events`, `/%69nternal/...` y `/INTERNAL/...`: 404. `/flights/v1/%2e%2e/%2e%2e/internal/...`: 400. Ninguno de esos request id aparece en el log del notifier |
| 10 | Preflight de CORS desde `http://localhost:5173`: 204 con los `Access-Control-*` del gateway |
| 11 | El mismo `X-Request-Id` en la respuesta, en el log del gateway y en el del core |
| 12 | Con un `X-Forwarded-For` y un `X-Real-IP` falsos, el core registra la IP real |
| 13 | Ningún token completo en los logs de los seis procesos |

Al final, la suscripción de prueba se da de baja (`DELETE /flights/v1/webhooks/{id}`).

## Salida de una corrida (2026-10-16, todo en `main`)

```
=== Arrancar (todos con TRUST_PROXY=1: el gateway va delante)
  identity arriba (pid 10764)
  notifier arriba (pid 10787)
  core arriba (pid 10804)
  bff arriba (pid 10823)
  gateway arriba (pid 10842)

=== 1. Registro y login de una persona por /identity/v1/auth
  ok   POST /identity/v1/auth/register → 201
  ok   POST /identity/v1/auth/login → 200
  access_token: eyJhbGciOiJS…(804 caracteres)
  scope: flights:read flights:hold flights:book flights:cancel flights:webhooks
  iss: http://localhost:8080

=== 2. Descubrimiento detrás del gateway
  ok   GET /.well-known/openid-configuration → 200
{"issuer":"http://localhost:8080","jwks_uri":"http://localhost:8080/.well-known/jwks.json","token_endpoint":"http://localhost:8080/oauth2/token"}
  ok   GET /.well-known/jwks.json → 200

=== 3. /graphql: una búsqueda (bff → core por gRPC)
  ok   POST /graphql searchFlights → 200
{"totalOffers":8,"primera":{"total":"85.80","currency":"USD"},"errors":0}

=== 4. Ruta protegida de /flights/v1, sin token y con token
  ok   GET /flights/v1/bookings sin token (401 en el borde) → 401
  ok   GET /flights/v1/bookings con token → 200
  X-Request-Id enviado: 67f76cb7-3fad-48cd-9104-6118b3a36f7c

=== 5. /identity/v1/admin/users: persona (403 en el borde) y administrador
  ok   persona sin flights:admin → 403
{"status":403,"detail":"Missing required scopes: flights:admin"}
  ok   administrador → 200
  administradores: 1

=== 6. Suscripción por /flights/v1/webhooks (llega al notifier)
  ok   POST /flights/v1/webhooks → 201
{"id":"daf6310f-4082-4ba7-b3ef-1eff7d2236d8","events":["booking.confirmed","booking.ticket_issued"],"secret":"****UO24"}

=== 7. Una reserva real por el gateway (search → hold → booking)
  ok   POST /flights/v1/search → 200
  ok   POST /flights/v1/offers/hold → 201
  ok   POST /flights/v1/bookings → 201
{"bookingId":"02a83ba4-fdb1-49b7-8b0d-bc0f1135dd8b","pnr":"PVNUNH","status":"CONFIRMED"}

=== 8. El webhook firmado en el receptor (la firma se recalcula con openssl)
{"ruta":"/hooks/quinde","evento":"booking.confirmed","id":"0b8d3cb8-f936-4f71-88f1-079617e2c264"}
  reserva del evento: 02a83ba4-fdb1-49b7-8b0d-bc0f1135dd8b (la creada: 02a83ba4-fdb1-49b7-8b0d-bc0f1135dd8b)
  ok   firma recalculada = X-Webhook-Signature → sha256=e07bd6bea0ee9d8db22d5d8ded12521307cb947053f4622b95ac6e1f15047d08

=== 9. /internal/v1/events por el gateway
  ok   POST /internal/v1/events → 404
  ok   POST /%69nternal/v1/events → 404
  ok   POST /INTERNAL/v1/events → 404
  ok   POST /flights/v1/%2e%2e/%2e%2e/internal/v1/events → 400
  ok   intentos que llegaron al notifier → 0
  gateway: {"level":30,"time":"2026-10-16T18:22:11.313Z","servicio":"gateway","requestId":"ba4420a2-0201-456f-bddc-fe55e83be93f","metodo":"POST","ruta":"/internal/v1/events","upstream":null,"status":404,"ms":0,"motivo":"bloqueada","msg":"acceso"}

=== 10. Preflight de CORS
  ok   OPTIONS /flights/v1/bookings → 204
  access-control-allow-origin: http://localhost:5173
  access-control-allow-methods: GET, HEAD, POST, PUT, PATCH, DELETE
  access-control-allow-headers: authorization, content-type, idempotency-key, x-request-id, x-device-fingerprint, traceparent, tracestate
  access-control-max-age: 600
  access-control-expose-headers: x-request-id, retry-after

=== 11. El mismo X-Request-Id en la respuesta y en los logs del gateway y del core
  ok   X-Request-Id de la respuesta → 67f76cb7-3fad-48cd-9104-6118b3a36f7c
  ok   líneas del gateway con 67f76cb7-3fad-48cd-9104-6118b3a36f7c → alguna
  ok   líneas del core con 67f76cb7-3fad-48cd-9104-6118b3a36f7c → alguna
  gateway: {"level":30,"time":"2026-10-16T18:22:05.460Z","servicio":"gateway","requestId":"67f76cb7-3fad-48cd-9104-6118b3a36f7c","metodo":"GET","ruta":"/flights/v1/bookings","upstream":"core","status":200,"ms":111,"msg":"acceso"}
  core:    [Nest] 10804  - 10/16/2026, 6:22:05 PM     LOG [HTTP] [67f76cb7-3fad-48cd-9104-6118b3a36f7c] GET /flights/v1/bookings 200 65.8ms ip=127.0.0.1 user=11d179da-4644-4009-b8a4-dbb3158c1cd2

=== 12. IP real: un X-Forwarded-For del cliente no llega al core
  ok   ip que registró el core (TRUST_PROXY=1) → ip=127.0.0.1

=== 13. Ningún token completo en los logs de los seis procesos
  ok   tokens en los logs → 0

=== Resultado: todo bien (logs en /var/tmp/quinde-e2e/logs)
```
