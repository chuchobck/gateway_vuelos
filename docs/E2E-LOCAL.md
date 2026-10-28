# Verificación local con los cinco servicios

`scripts/e2e-local.sh` levanta los cinco servicios y un receptor de webhooks en local:

- identity
- core (`AUTH_MODE=external`, `WEBHOOKS_MODE=notifier`, gRPC encendido)
- notifier
- bff
- este gateway, exportando trazas y con sus métricas en el 9464
- un notifier v2 falso (`scripts/e2e/notifier-v2-falso.mjs`, en el 3003): responde
  `/api/v2/vuelos/webhooks*` y `/api/v2/vuelos/eventos`, que el notifier de `main` todavía no tiene, y
  pasa todo lo demás al notifier real. El gateway apunta a él (`UPSTREAM_NOTIFIER_URL`)
- el receptor de webhooks
- un recolector OTLP/HTTP falso (`scripts/e2e/recolector-otlp.mjs`, en el 4318), en lugar de Jaeger:
  en la sesión de la fase 7a no había Docker

Después entra **solo por el gateway** (`http://localhost:8080`): primero como los frontends (v1,
pasos 1 a 15) y después como Booking Prototipo (contrato v2, pasos 16 a 23). Ningún paso del recorrido llama a
un servicio directo. Para observar, lee además el puerto de métricas del gateway (9464) y el archivo
del recolector.

## Requisitos

- Los repos como carpetas vecinas, en `main`, con `npm ci` y `npm run build` hechos:

  ```
  ../backend_vuelos  ../identity_vuelos  ../notifier_vuelos  ../bff_vuelos  ./ (gateway_vuelos)
  ```

- Un PostgreSQL **local** en `PG_URL` (por defecto `postgresql://postgres:postgres@localhost:5432`)
  con `psql` en el `PATH`. `--preparar` **borra y vuelve a crear** `booking_db`, `identity_db` y
  `notifier_db`.
- `curl`, `jq` y `openssl`.
- Puertos libres: 3000 (core), 50051 (gRPC del core), 3001 (identity), 3002 (notifier), 3003
  (notifier v2 falso), 4000 (bff), 8080 (gateway), 9464 a 9468 (métricas del gateway, bff, core,
  identity y notifier, la tabla de OBSERVABILIDAD.md), 4010 (receptor) y 4318 (recolector OTLP). Si
  alguno está ocupado, el script se detiene antes de arrancar.

## Uso

```bash
scripts/e2e-local.sh --preparar     # bases nuevas, claves de identity y cliente core-vuelos; y recorre
scripts/e2e-local.sh                # reusa lo preparado: arranca, recorre y apaga
scripts/e2e-local.sh --dejar-arriba # no apaga al terminar (para seguir probando a mano)
scripts/e2e-local.sh --detener      # apaga lo que haya quedado arriba
```

Lo generado queda en `E2E_DIR` (por defecto `/var/tmp/quinde-e2e`, modo 700) y nunca en el repo:

- `estado.env`: la clave de firma de identity, los secretos de los clientes `core-vuelos` y
  `booking-prototipo`, las claves de cifrado de webhooks y la contraseña del administrador.
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
5. **Cliente `booking-prototipo`** en identity, como lo pide su `docs/PARTNER-BOOKING.md`:
   `crear-cliente.js --nombre "Booking Prototipo" --client-id booking-prototipo --scopes
   "flights:read flights:hold flights:book flights:cancel flights:webhooks"`, sin `--permitir-*`.

## Configuración con que arranca cada uno

Todos usan `JWT_ISSUER=http://localhost:8080`, el origen público del gateway, y
`JWT_AUDIENCE=quinde-vuelos-api`. Core y notifier bajan el JWKS de identity por la red interna
(`JWKS_URL=http://localhost:3001/.well-known/jwks.json`). Los cuatro servicios corren con
`TRUST_PROXY=1` y su `METRICS_PORT` de la tabla del estándar (bff 9465, core 9466, identity 9467,
notifier 9468), y el gateway con `TRUST_PROXY_HOPS=0`,
`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, `METRICS_PORT=9464` y
`UPSTREAM_NOTIFIER_URL=http://localhost:3003` (el notifier v2 falso). Los spans que recibe el
recolector quedan en `$E2E_DIR/spans.jsonl`, uno por línea.

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
| 13 | Métricas: `/metrics` da 404 en el 8080. En el 9464 están `http_server_requests_total` por plantilla, las cubetas (de 5 ms a 60 s), `http_client_request_duration_seconds` por upstream, los rechazos de auth y `quinde_build_info`, y ninguna etiqueta lleva ids, correos ni uuid |
| 14 | Trazas: con un `traceparent` del cliente, el gateway abre una traza nueva. Al recolector llegan `GET /flights/v1/bookings/{bookingId}` (SERVER) con sus hijos `auth.verify` (INTERNAL) y la llamada al core (CLIENT), en OTLP/HTTP JSON, con `service.name` `quinde-gateway`. `X-Trace-Id` es igual al `traceId` de la línea de acceso. Ningún span lleva la reserva, el correo, `Authorization` ni una IP |
| 15 | Ningún token completo en los logs de los seis procesos ni en los spans |
| 16 | **Contrato v2, todo con el MISMO `X-Correlation-Id`**: el token de `booking-prototipo` por `POST /api/v2/oauth2/token` (llega a identity `/oauth2/token`). Trae `client_id` y sus cinco scopes |
| 17 | `GET /api/v2/vuelos/health` y `POST /api/v2/vuelos/search`, sin token |
| 18 | `offers/hold`, `bookings` con un `paymentReference` de Booking y `X-User-Id`, y `tickets`. En la base, la reserva queda con `id_cliente=booking-prototipo` y el `X-User-Id`: llegó porque el token es de partner |
| 19 | `cancel` con `reasonCode` `SAGA_COMPENSATION`: `CANCELLED`, reembolso `CALCULATED` |
| 20 | Errores del borde v2: 401 sin token, 403 sin `flights:ops`, 404 no declarada; ProblemDetails v2 con el mismo `correlation_id` |
| 21 | `/api/v2/vuelos/webhooks` y `/eventos` llegan al notifier (el falso) con el correlation id. Con un token de persona, el `X-User-Id` no le llega |
| 22 | El correlation id en las líneas del gateway (con los campos de §6.4), del core y del identity |
| 23 | El correlation id como `quinde.correlation_id` en los spans del gateway; ningún token de Booking en logs ni spans |

En cada paso de 16 a 21 se comprueba que la respuesta trae el mismo `X-Correlation-Id`.

Al final, la suscripción de prueba se da de baja (`DELETE /flights/v1/webhooks/{id}`).

## Salida de una corrida (2026-10-27, servicios en `main` y el gateway en `feat/v2-rutas`)

```
=== Arrancar (todos con TRUST_PROXY=1: el gateway va delante)
  identity arriba (pid 5442)
  notifier arriba (pid 5473)
  core arriba (pid 5493)
  bff arriba (pid 5512)
  notifier-v2-falso arriba (pid 5528)
  gateway arriba (pid 5540)

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
  X-Request-Id enviado: 25f25280-6e68-46a5-a01e-4d3446051049

=== 5. /identity/v1/admin/users: persona (403 en el borde) y administrador
  ok   persona sin flights:admin → 403
{"status":403,"detail":"Missing required scopes: flights:admin"}
  ok   administrador → 200
  administradores: 1

=== 6. Suscripción por /flights/v1/webhooks (llega al notifier)
  ok   POST /flights/v1/webhooks → 201
{"id":"988af526-8e4a-4bc9-a989-89967b34d6d7","events":["booking.confirmed","booking.ticket_issued"],"secret":"****X_3e"}

=== 7. Una reserva real por el gateway (search → hold → booking)
  ok   POST /flights/v1/search → 200
  ok   POST /flights/v1/offers/hold → 201
  ok   POST /flights/v1/bookings → 201
{"bookingId":"01cf6165-b4cd-4406-88ef-986bf99670e7","pnr":"4MXART","status":"CONFIRMED"}

=== 8. El webhook firmado en el receptor (la firma se recalcula con openssl)
{"ruta":"/hooks/quinde","evento":"booking.confirmed","id":"14705295-3178-4a56-9b55-105734f63a92"}
  reserva del evento: 01cf6165-b4cd-4406-88ef-986bf99670e7 (la creada: 01cf6165-b4cd-4406-88ef-986bf99670e7)
  ok   firma recalculada = X-Webhook-Signature → sha256=f5739f1573399bed843f60fdbeb15ce1310625ea2a40a41db1b3a33cbbfb7a49

=== 9. /internal/v1/events por el gateway
  ok   POST /internal/v1/events → 404
  ok   POST /%69nternal/v1/events → 404
  ok   POST /INTERNAL/v1/events → 404
  ok   POST /flights/v1/%2e%2e/%2e%2e/internal/v1/events → 400
  ok   intentos que llegaron al notifier → 0
  gateway: {"level":30,"time":"2026-10-27T04:07:46.701Z","servicio":"gateway","requestId":"59aaf4d7-821d-4ddb-8d0f-cd57cb0f4ec8","correlationId":"corr-4d4268be-8371-42b8-b4dd-848e52e4fabc","traceId":"17cb7ed4e8de47126e912b23b4661864","spanId":"0bbcb1127619f53a","timestamp":"2026-10-27T04:07:46.701Z","service":"quinde-gateway","correlation_id":"corr-4d4268be-8371-42b8-b4dd-848e52e4fabc","request_id":"59aaf4d7-821d-4ddb-8d0f-cd57cb0f4ec8","operation":null,"status":404,"latency_ms":1.1,"metodo":"POST","ruta":"__unmatched__","upstream":null,"ms":1,"motivo":"bloqueada","msg":"acceso"}

=== 10. Preflight de CORS
  ok   OPTIONS /flights/v1/bookings → 204
  access-control-allow-origin: http://localhost:5173
  access-control-allow-methods: GET, HEAD, POST, PUT, PATCH, DELETE
  access-control-allow-headers: authorization, content-type, idempotency-key, x-request-id, x-device-fingerprint, traceparent, tracestate, x-correlation-id
  access-control-max-age: 600
  access-control-expose-headers: x-request-id, x-trace-id, retry-after, x-correlation-id, idempotent-replayed, location

=== 11. El mismo X-Request-Id en la respuesta y en los logs del gateway y del core
  ok   X-Request-Id de la respuesta → 25f25280-6e68-46a5-a01e-4d3446051049
  ok   líneas del gateway con 25f25280-6e68-46a5-a01e-4d3446051049 → alguna
  ok   líneas del core con 25f25280-6e68-46a5-a01e-4d3446051049 → alguna
  gateway: {"level":30,"time":"2026-10-27T04:07:37.326Z","servicio":"gateway","requestId":"25f25280-6e68-46a5-a01e-4d3446051049","correlationId":"corr-a99ddf13-318f-42f8-8e5f-6f1279796280","traceId":"95253b63a004d6d07b1cee9ccec2ba2b","spanId":"7cbff592bb275a12","msg":"JWKS descargado: 1 claves (kid ujPQO6Ojl4Cm1FRL4q79Ioe67Kfys7PAbi9p1fdivTs), vigente 300 s"}
  core:    [Nest] 5493  - 10/27/2026, 4:07:37 AM     LOG [HTTP] [25f25280-6e68-46a5-a01e-4d3446051049] [traceId=95253b63a004d6d07b1cee9ccec2ba2b spanId=94c7e00ccba6f7c2] GET /flights/v1/bookings 200 71.6ms ip=127.0.0.1 user=0c85f55

=== 12. IP real: un X-Forwarded-For del cliente no llega al core
  ok   ip que registró el core (TRUST_PROXY=1) → ip=127.0.0.1

=== 13. Métricas en el puerto aparte (9464)
  ok   GET /metrics en el puerto público → 404
  ok   GET /flights/v1/bookings 200 contadas (pasos 4, 11 y 12: 3 o más) → sí
  http_server_requests_total{method="GET",route="/health",status="200"} 1
  http_server_requests_total{method="POST",route="/identity/v1/auth/register",status="201"} 1
  http_server_requests_total{method="POST",route="/identity/v1/auth/login",status="200"} 2
  http_server_requests_total{method="GET",route="/.well-known/**",status="200"} 2
  http_server_requests_total{method="POST",route="/graphql",status="200"} 1
  http_server_requests_total{method="GET",route="/flights/v1/bookings",status="401"} 1
  http_server_requests_total{method="GET",route="/flights/v1/bookings",status="200"} 3
  http_server_requests_total{method="GET",route="/identity/v1/admin/**",status="403"} 1
  http_server_requests_total{method="GET",route="/identity/v1/admin/**",status="200"} 1
  http_server_requests_total{method="POST",route="/flights/v1/webhooks",status="201"} 1
  http_server_requests_total{method="POST",route="/flights/v1/search",status="200"} 1
  http_server_requests_total{method="POST",route="/flights/v1/offers/hold",status="201"} 1
  http_server_requests_total{method="POST",route="/flights/v1/bookings",status="201"} 1
  http_server_requests_total{method="POST",route="__unmatched__",status="404"} 3
  http_server_requests_total{method="POST",route="__unmatched__",status="400"} 1
  http_server_requests_total{method="OPTIONS",route="/flights/v1/**",status="204"} 1
  http_server_requests_total{method="GET",route="__unmatched__",status="404"} 1
  quinde_build_info{service="quinde-gateway",version="0.1.0",environment="development"} 1
  gateway_auth_rejections_total{reason="missing_token"} 1
  gateway_auth_rejections_total{reason="insufficient_scope"} 1
  cubetas de GET /flights/v1/bookings 200:
    http_server_request_duration_seconds_bucket{le="0.005",method="GET",route="/flights/v1/bookings",status="200"} 0
    http_server_request_duration_seconds_bucket{le="0.01",method="GET",route="/flights/v1/bookings",status="200"} 0
    http_server_request_duration_seconds_bucket{le="0.025",method="GET",route="/flights/v1/bookings",status="200"} 2
    http_server_request_duration_seconds_bucket{le="0.05",method="GET",route="/flights/v1/bookings",status="200"} 2
    http_server_request_duration_seconds_bucket{le="0.1",method="GET",route="/flights/v1/bookings",status="200"} 2
    http_server_request_duration_seconds_bucket{le="0.25",method="GET",route="/flights/v1/bookings",status="200"} 3
    http_server_request_duration_seconds_bucket{le="0.5",method="GET",route="/flights/v1/bookings",status="200"} 3
    http_server_request_duration_seconds_bucket{le="1",method="GET",route="/flights/v1/bookings",status="200"} 3
    http_server_request_duration_seconds_bucket{le="2.5",method="GET",route="/flights/v1/bookings",status="200"} 3
    http_server_request_duration_seconds_bucket{le="5",method="GET",route="/flights/v1/bookings",status="200"} 3
    http_server_request_duration_seconds_bucket{le="10",method="GET",route="/flights/v1/bookings",status="200"} 3
    http_server_request_duration_seconds_bucket{le="30",method="GET",route="/flights/v1/bookings",status="200"} 3
    http_server_request_duration_seconds_bucket{le="60",method="GET",route="/flights/v1/bookings",status="200"} 3
    http_server_request_duration_seconds_bucket{le="+Inf",method="GET",route="/flights/v1/bookings",status="200"} 3
  http_client_request_duration_seconds_count{upstream="identity",method="POST",status="201"} 1
  http_client_request_duration_seconds_count{upstream="identity",method="POST",status="200"} 2
  http_client_request_duration_seconds_count{upstream="identity",method="GET",status="200"} 3
  http_client_request_duration_seconds_count{upstream="bff",method="POST",status="200"} 1
  http_client_request_duration_seconds_count{upstream="core",method="GET",status="200"} 3
  http_client_request_duration_seconds_count{upstream="notifier",method="POST",status="201"} 1
  http_client_request_duration_seconds_count{upstream="core",method="POST",status="200"} 1
  http_client_request_duration_seconds_count{upstream="core",method="POST",status="201"} 2
  ok   rechazos missing_token (paso 4) contados → sí
  ok   histograma con la cubeta de 60 s → sí
  ok   etiquetas con ids, correos o uuid → 0

=== 14. Trazas del gateway en el recolector OTLP (en lugar de Jaeger)
  X-Trace-Id: 1da166ebf1d582e3e2feac1da457e96e
  ok   traza nueva (no la del cliente) → sí
  {"tipo":1,"nombre":"auth.verify","padre":"f5fafb399db0d546","spanId":"091f689f2e6bef06","atributos":{"quinde.auth.mode":"token","quinde.request_id":"0cb4d0da-96ed-4ad6-9425-ce9bba2162bb"},"estado":0}
  {"tipo":2,"nombre":"GET /flights/v1/bookings/{bookingId}","padre":"-","spanId":"f5fafb399db0d546","atributos":{"http.request.method":"GET","quinde.request_id":"0cb4d0da-96ed-4ad6-9425-ce9bba2162bb","quinde.correlation_id":"corr-472da89c-7bba-4ed1-aad3-9d5b1b50771b","quinde.upstream":"core","quinde.auth.mode":"token","http.route":"/flights/v1/bookings/{bookingId}","http.response.status_code":200},"estado":0}
  {"tipo":3,"nombre":"GET /flights/v1/bookings/{bookingId}","padre":"f5fafb399db0d546","spanId":"bc519536a7cb386b","atributos":{"http.request.method":"GET","http.route":"/flights/v1/bookings/{bookingId}","quinde.upstream":"core","quinde.request_id":"0cb4d0da-96ed-4ad6-9425-ce9bba2162bb","quinde.correlation_id":"corr-472da89c-7bba-4ed1-aad3-9d5b1b50771b","http.response.status_code":200},"estado":0}
  {"tipoContenido":"application/json","recurso":{"service.name":"quinde-gateway","service.version":"0.1.0","deployment.environment":"development"}}
  ok   span raíz SERVER con la plantilla → GET /flights/v1/bookings/{bookingId}
  ok   hijos de la raíz: auth.verify (INTERNAL) y el upstream (CLIENT) → 1 3
  ok   service.name → quinde-gateway
  gateway: {"level":30,"time":"2026-10-27T04:07:47.161Z","servicio":"gateway","requestId":"0cb4d0da-96ed-4ad6-9425-ce9bba2162bb","correlationId":"corr-472da89c-7bba-4ed1-aad3-9d5b1b50771b","traceId":"1da166ebf1d582e3e2feac1da457e96e","spanId":"f5fafb399db0d546","timestamp":"2026-10-27T04:07:47.161Z","service":"quinde-gateway","correlation_id":"corr-472da89c-7bba-4ed1-aad3-9d5b1b50771b","request_id":"0cb4d0da-96ed-4ad6-9425-ce9bba2162bb","operation":null,"status":200,"latency_ms":20.9,"metodo":"GET","ruta":"/flights/v1/bookings/{bookingId}","upstream":"core","ms":20,"msg":"acceso"}
  ok   X-Trace-Id = traceId del log del gateway → 1da166ebf1d582e3e2feac1da457e96e
  ok   spans con la reserva, el correo, Authorization o una IP → 0
  spans recibidos en total: 49

=== 15. Ningún token completo en los logs de los seis procesos ni en los spans
  ok   tokens en los logs → 0

=== 16. Token de Booking por /api/v2/oauth2/token (X-Correlation-Id: corr-e2e-g2-5PcWFgFB5G)
  ok   POST /api/v2/oauth2/token (→ identity /oauth2/token) → 200
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  access_token: eyJhbGciOiJS…(846 caracteres), expires_in 900
  claims: {"client_id":"booking-prototipo","scope":"flights:read flights:hold flights:book flights:cancel flights:webhooks","iss":"http://localhost:8080"}

=== 17. health → search (públicas, sin token)
  ok   GET /api/v2/vuelos/health → 200
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  {"status":"HEALTHY","service":null}
  ok   POST /api/v2/vuelos/search → 200
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  ofertas: 8, la elegida: ee58b0bf-8325-47d4-b683-96338261e77f

=== 18. hold → booking (paymentReference de Booking, X-User-Id del usuario final) → tickets
  ok   POST /api/v2/vuelos/offers/hold → 201
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  ok   POST /api/v2/vuelos/bookings → 201
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  {"bookingId":"4010a405-4166-4a43-ac44-4d99739f3614","pnr":"WGU992","status":"CONFIRMED","links":["baggage-options","boarding-passes","cancel","cancellation-quote","check-in","date-change","self","tickets"]}
  en la base (el core recibió X-User-Id porque el token es de partner):
    id_cliente=booking-prototipo id_usuario_externo=booking-user-e2e-42
  ok   POST /api/v2/vuelos/bookings/{bookingId}/tickets → 200
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  {"issued":0,"tickets":1}

=== 19. cancel con SAGA_COMPENSATION (Booking compensa el combo)
  ok   POST /api/v2/vuelos/bookings/{bookingId}/cancel → 200
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  {"status":"CANCELLED","reasonCode":"SAGA_COMPENSATION","refund":{"status":"CALCULATED","amount":"94.38"}}

=== 20. Errores del borde v2 (ProblemDetails v2 con el mismo correlation_id)
  ok   GET /api/v2/vuelos/bookings sin token → 401
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  {"type":"https://api.booking-hub.com/errors/unauthorized","title":"Unauthorized","status":401,"detail":"A bearer access token is required","instance":"/api/v2/vuelos/bookings","code":"UNAUTHORIZED","correlation_id":"corr-e2e-g2-5PcWFgFB5G","timestamp":"2026-10-27T04:07:50.258Z"}
  ok   PATCH .../flights/{n}/status sin flights:ops → 403
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  {"code":"FORBIDDEN","correlation_id":"corr-e2e-g2-5PcWFgFB5G","instance":"/api/v2/vuelos/flights/EQ101/status"}
  ok   GET /api/v2/vuelos/no-declarada → 404
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  {"code":"NOT_FOUND","correlation_id":"corr-e2e-g2-5PcWFgFB5G","instance":"/api/v2/vuelos/no-declarada"}
  ok     correlation_id del cuerpo → corr-e2e-g2-5PcWFgFB5G

=== 21. webhooks y eventos v2 (al notifier: hoy el falso) y X-User-* de una persona
  ok   GET /api/v2/vuelos/webhooks → 200
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  ok   GET /api/v2/vuelos/eventos → 200
  ok     X-Correlation-Id de la respuesta → corr-e2e-g2-5PcWFgFB5G
  notifier falso: {"metodo":"GET","ruta":"/api/v2/vuelos/webhooks","correlationId":"corr-e2e-g2-5PcWFgFB5G","conAuthorization":true,"conXUserId":true}
  notifier falso: {"metodo":"GET","ruta":"/api/v2/vuelos/eventos","correlationId":"corr-e2e-g2-5PcWFgFB5G","conAuthorization":true,"conXUserId":false}
  ok   GET /api/v2/vuelos/webhooks con token de persona → 200
  ok     X-User-Id que le llegó al notifier (persona: se borra) → false

=== 22. El mismo corr-e2e-g2-5PcWFgFB5G en los logs del gateway, del core y del identity
  líneas con corr-e2e-g2-5PcWFgFB5G: gateway 13, core 12, identity 1
  ok   gateway → alguna
  ok   core → alguna
  ok   identity → alguna
  gateway (líneas de acceso, campos de §6.4):
    {"timestamp":"2026-10-27T04:07:49.464Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"23613e92-d331-477f-ba81-3431ffce5e3e","operation":null,"status":200,"latency_ms":54.4,"ruta":"/api/v2/oauth2/token","upstream":"identity"}
    {"timestamp":"2026-10-27T04:07:49.524Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"82650c18-2c8e-439d-99d9-1eefbf53d587","operation":"getHealth","status":200,"latency_ms":15.5,"ruta":"/api/v2/vuelos/health","upstream":"core"}
    {"timestamp":"2026-10-27T04:07:49.597Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"bc6b5c9b-7c43-43fb-80b6-60205589531a","operation":"searchFlights","status":200,"latency_ms":40.6,"ruta":"/api/v2/vuelos/search","upstream":"core"}
    {"timestamp":"2026-10-27T04:07:49.705Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"c635745e-2e9b-4c73-a862-c43944ba885f","operation":"createHold","status":201,"latency_ms":31,"ruta":"/api/v2/vuelos/offers/hold","upstream":"core"}
    {"timestamp":"2026-10-27T04:07:49.889Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"a891e4dd-ffbd-448a-93ae-788bf97c2de5","operation":"createBooking","status":201,"latency_ms":106.3,"ruta":"/api/v2/vuelos/bookings","upstream":"core"}
    {"timestamp":"2026-10-27T04:07:50.003Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"dffa8140-1323-4f9b-9d61-21dbd5b83453","operation":"issueTickets","status":200,"latency_ms":28.9,"ruta":"/api/v2/vuelos/bookings/{bookingId}/tickets","upstream":"core"}
    {"timestamp":"2026-10-27T04:07:50.221Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"594039ac-ee6f-47d2-9e1e-c4b2efbe02cb","operation":"cancelBooking","status":200,"latency_ms":136.2,"ruta":"/api/v2/vuelos/bookings/{bookingId}/cancel","upstream":"core"}
    {"timestamp":"2026-10-27T04:07:50.259Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"1755f9f6-194d-4981-adb4-c327136c7d19","operation":"listBookings","status":401,"latency_ms":1.6,"ruta":"/api/v2/vuelos/bookings","upstream":"core"}
    {"timestamp":"2026-10-27T04:07:50.287Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"3f2ea079-7004-4bef-8b56-b457c38fe162","operation":"updateFlightStatus","status":403,"latency_ms":1.8,"ruta":"/api/v2/vuelos/flights/{flightNumber}/status","upstream":"core"}
    {"timestamp":"2026-10-27T04:07:50.313Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"5765692b-1462-4565-8b54-7e2358f0b79c","operation":null,"status":404,"latency_ms":0.8,"ruta":"__unmatched__","upstream":null}
    {"timestamp":"2026-10-27T04:07:50.349Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"13771beb-51ef-4b5d-bb5c-a4b9567159ee","operation":"listWebhooks","status":200,"latency_ms":4.1,"ruta":"/api/v2/vuelos/webhooks","upstream":"notifier"}
    {"timestamp":"2026-10-27T04:07:50.378Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"d31fd5d4-74d6-4bc3-836f-aed2efaa273d","operation":"listOutboxEvents","status":200,"latency_ms":3.3,"ruta":"/api/v2/vuelos/eventos","upstream":"notifier"}
    {"timestamp":"2026-10-27T04:07:50.471Z","service":"quinde-gateway","correlation_id":"corr-e2e-g2-5PcWFgFB5G","request_id":"2af1e7cb-8fb5-4cb5-8fe2-5a5ab02c2401","operation":"listWebhooks","status":200,"latency_ms":3.5,"ruta":"/api/v2/vuelos/webhooks","upstream":"notifier"}
  core (líneas de acceso):
    {"timestamp":"2026-10-27T04:07:49.522Z","service":"core-vuelos","correlation_id":"corr-e2e-g2-5PcWFgFB5G","operation":"getHealth","method":"GET","status":200,"latency_ms":11.6,"client_id":null}
    {"timestamp":"2026-10-27T04:07:49.596Z","service":"core-vuelos","correlation_id":"corr-e2e-g2-5PcWFgFB5G","operation":"searchFlights","method":"POST","status":200,"latency_ms":37.1,"client_id":null}
    {"timestamp":"2026-10-27T04:07:49.703Z","service":"core-vuelos","correlation_id":"corr-e2e-g2-5PcWFgFB5G","operation":"createHold","method":"POST","status":201,"latency_ms":27.5,"client_id":"booking-prototipo"}
    {"timestamp":"2026-10-27T04:07:49.887Z","service":"core-vuelos","correlation_id":"corr-e2e-g2-5PcWFgFB5G","operation":"createBooking","method":"POST","status":201,"latency_ms":102.8,"client_id":"booking-prototipo"}
    {"timestamp":"2026-10-27T04:07:50.002Z","service":"core-vuelos","correlation_id":"corr-e2e-g2-5PcWFgFB5G","operation":"issueTickets","method":"POST","status":200,"latency_ms":25.8,"client_id":"booking-prototipo"}
    {"timestamp":"2026-10-27T04:07:50.220Z","service":"core-vuelos","correlation_id":"corr-e2e-g2-5PcWFgFB5G","operation":"cancelBooking","method":"POST","status":200,"latency_ms":132.5,"client_id":"booking-prototipo"}
  identity:
    {"time":"2026-10-27T04:07:49.463Z","level":"log","context":"HTTP","requestId":"23613e92-d331-477f-ba81-3431ffce5e3e","correlationId":"corr-e2e-g2-5PcWFgFB5G","traceId":"cdad2ff3f0ed0dae9297475f1bb2d2f3","spanId":"4c38a5b2ddb8c380","message":"POST /oauth2/token

=== 23. El correlation id en el span del gateway (recolector OTLP)
  ok   spans con quinde.correlation_id=corr-e2e-g2-5PcWFgFB5G → alguno
  {"nombre":"POST /api/v2/oauth2/token","atributos":{"http.request.method":"POST","quinde.request_id":"23613e92-d331-477f-ba81-3431ffce5e3e","quinde.correlation_id":"corr-e2e-g2-5PcWFgFB5G","quinde.upstream":"identity","quinde.auth.mode":"publica","http.route":"/api/v2/oauth2/token","http.response.status_code":200}}
  {"nombre":"GET /api/v2/vuelos/health","atributos":{"http.request.method":"GET","quinde.request_id":"82650c18-2c8e-439d-99d9-1eefbf53d587","quinde.correlation_id":"corr-e2e-g2-5PcWFgFB5G","quinde.upstream":"core","quinde.auth.mode":"publica","http.route":"/api/v2/vuelos/health","http.response.status_code":200}}
  {"nombre":"POST /api/v2/vuelos/search","atributos":{"http.request.method":"POST","quinde.request_id":"bc6b5c9b-7c43-43fb-80b6-60205589531a","quinde.correlation_id":"corr-e2e-g2-5PcWFgFB5G","quinde.upstream":"core","quinde.auth.mode":"publica","http.route":"/api/v2/vuelos/search","http.response.status_code":200}}
  ok   tokens de Booking en los logs y los spans → 0

=== Resultado: todo bien (logs en /var/tmp/quinde-e2e/logs)
```
