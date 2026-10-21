# Verificación local con los cinco servicios

`scripts/e2e-local.sh` levanta los cinco servicios y un receptor de webhooks en local:

- identity
- core (`AUTH_MODE=external`, `WEBHOOKS_MODE=notifier`, gRPC encendido)
- notifier
- bff
- este gateway, exportando trazas y con sus métricas en el 9464
- el receptor de webhooks
- un recolector OTLP/HTTP falso (`scripts/e2e/recolector-otlp.mjs`, en el 4318), en lugar de Jaeger:
  en la sesión de la fase 7a no había Docker

Después entra **solo por el gateway** (`http://localhost:8080`). Ningún paso del recorrido llama a
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
- Puertos libres: 3000 (core), 50051 (gRPC del core), 3001 (identity), 3002 (notifier), 4000 (bff),
  8080 (gateway), 9464 (métricas del gateway), 4010 (receptor) y 4318 (recolector OTLP). Si alguno
  está ocupado, el script se detiene antes de arrancar.

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
`TRUST_PROXY=1` y el gateway con `TRUST_PROXY_HOPS=0`,
`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` y `METRICS_PORT=9464`. Los spans que recibe el
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

Al final, la suscripción de prueba se da de baja (`DELETE /flights/v1/webhooks/{id}`).

## Salida de una corrida (2026-10-17, servicios en `main` y el gateway en `feat/r2-observabilidad`)

```
=== Arrancar (todos con TRUST_PROXY=1: el gateway va delante)
  identity arriba (pid 4285)
  notifier arriba (pid 4355)
  core arriba (pid 4381)
  bff arriba (pid 4416)
  gateway arriba (pid 4443)

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
{"totalOffers":8,"primera":{"total":"94.38","currency":"USD"},"errors":0}

=== 4. Ruta protegida de /flights/v1, sin token y con token
  ok   GET /flights/v1/bookings sin token (401 en el borde) → 401
  ok   GET /flights/v1/bookings con token → 200
  X-Request-Id enviado: 040ee23e-1998-4e8a-b2ec-8d32d5c206e9

=== 5. /identity/v1/admin/users: persona (403 en el borde) y administrador
  ok   persona sin flights:admin → 403
{"status":403,"detail":"Missing required scopes: flights:admin"}
  ok   administrador → 200
  administradores: 1

=== 6. Suscripción por /flights/v1/webhooks (llega al notifier)
  ok   POST /flights/v1/webhooks → 201
{"id":"8d66252e-7086-4090-b9d9-950325f46dce","events":["booking.confirmed","booking.ticket_issued"],"secret":"****Vcgw"}

=== 7. Una reserva real por el gateway (search → hold → booking)
  ok   POST /flights/v1/search → 200
  ok   POST /flights/v1/offers/hold → 201
  ok   POST /flights/v1/bookings → 201
{"bookingId":"7515830d-5c0d-4ab2-9438-c12bb0ece1a9","pnr":"ZWSKF7","status":"CONFIRMED"}

=== 8. El webhook firmado en el receptor (la firma se recalcula con openssl)
{"ruta":"/hooks/quinde","evento":"booking.confirmed","id":"138649cf-8db6-48e5-bde3-b1da048d7963"}
  reserva del evento: 7515830d-5c0d-4ab2-9438-c12bb0ece1a9 (la creada: 7515830d-5c0d-4ab2-9438-c12bb0ece1a9)
  ok   firma recalculada = X-Webhook-Signature → sha256=e6071d18c7c61f517f7fb56075eb58494eabc7f2d63e7bce0004c1ed8a47af30

=== 9. /internal/v1/events por el gateway
  ok   POST /internal/v1/events → 404
  ok   POST /%69nternal/v1/events → 404
  ok   POST /INTERNAL/v1/events → 404
  ok   POST /flights/v1/%2e%2e/%2e%2e/internal/v1/events → 400
  ok   intentos que llegaron al notifier → 0
  gateway: {"level":30,"time":"2026-10-17T00:37:26.615Z","servicio":"gateway","requestId":"f3777b40-e308-48a7-bb43-865b934f2386","traceId":"0e6cc5b14f1da5cae14a9b406f432382","spanId":"729680a8a478d1f1","metodo":"POST","ruta":"__unmatched__","upstream":null,"status":404,"ms":0,"motivo":"bloqueada","msg":"acceso"}

=== 10. Preflight de CORS
  ok   OPTIONS /flights/v1/bookings → 204
  access-control-allow-origin: http://localhost:5173
  access-control-allow-methods: GET, HEAD, POST, PUT, PATCH, DELETE
  access-control-allow-headers: authorization, content-type, idempotency-key, x-request-id, x-device-fingerprint, traceparent, tracestate
  access-control-max-age: 600
  access-control-expose-headers: x-request-id, x-trace-id, retry-after

=== 11. El mismo X-Request-Id en la respuesta y en los logs del gateway y del core
  ok   X-Request-Id de la respuesta → 040ee23e-1998-4e8a-b2ec-8d32d5c206e9
  ok   líneas del gateway con 040ee23e-1998-4e8a-b2ec-8d32d5c206e9 → alguna
  ok   líneas del core con 040ee23e-1998-4e8a-b2ec-8d32d5c206e9 → alguna
  gateway: {"level":30,"time":"2026-10-17T00:37:15.466Z","servicio":"gateway","requestId":"040ee23e-1998-4e8a-b2ec-8d32d5c206e9","traceId":"79c0f535607e695aad1dc769b388e0fd","spanId":"fe7c37c142a97e1e","msg":"JWKS descargado: 1 claves (kid -QyOn3V-z0O3WGZG45F2goo5Tv11yAvvmkqTV2oQlhU), vigente 300 s"}
  core:    [Nest] 4381  - 10/17/2026, 12:37:15 AM     LOG [HTTP] [040ee23e-1998-4e8a-b2ec-8d32d5c206e9] GET /flights/v1/bookings 200 88.2ms ip=127.0.0.1 user=2e3f019c-82b8-4b8d-8ae7-8465ea3c4586

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
  X-Trace-Id: 48bf7a3314c5d647b7213fd6de2ea4fb
  ok   traza nueva (no la del cliente) → sí
  {"tipo":1,"nombre":"auth.verify","padre":"2e9cf1397fcf2299","spanId":"d0397d726c4912c4","atributos":{"quinde.auth.mode":"token","quinde.request_id":"c961eeaf-96eb-48cc-ac39-80bfab27663c"},"estado":0}
  {"tipo":2,"nombre":"GET /flights/v1/bookings/{bookingId}","padre":"-","spanId":"2e9cf1397fcf2299","atributos":{"http.request.method":"GET","quinde.request_id":"c961eeaf-96eb-48cc-ac39-80bfab27663c","quinde.upstream":"core","quinde.auth.mode":"token","http.route":"/flights/v1/bookings/{bookingId}","http.response.status_code":200},"estado":0}
  {"tipo":3,"nombre":"GET /flights/v1/bookings/{bookingId}","padre":"2e9cf1397fcf2299","spanId":"af5b282603f3bb81","atributos":{"http.request.method":"GET","http.route":"/flights/v1/bookings/{bookingId}","quinde.upstream":"core","quinde.request_id":"c961eeaf-96eb-48cc-ac39-80bfab27663c","http.response.status_code":200},"estado":0}
  {"tipoContenido":"application/json","recurso":{"service.name":"quinde-gateway","service.version":"0.1.0","deployment.environment":"development"}}
  ok   span raíz SERVER con la plantilla → GET /flights/v1/bookings/{bookingId}
  ok   hijos de la raíz: auth.verify (INTERNAL) y el upstream (CLIENT) → 1 3
  ok   service.name → quinde-gateway
  gateway: {"level":30,"time":"2026-10-17T00:37:27.099Z","servicio":"gateway","requestId":"c961eeaf-96eb-48cc-ac39-80bfab27663c","traceId":"48bf7a3314c5d647b7213fd6de2ea4fb","spanId":"2e9cf1397fcf2299","metodo":"GET","ruta":"/flights/v1/bookings/{bookingId}","upstream":"core","status":200,"ms":22,"msg":"acceso"}
  ok   X-Trace-Id = traceId del log del gateway → 48bf7a3314c5d647b7213fd6de2ea4fb
  ok   spans con la reserva, el correo, Authorization o una IP → 0
  spans recibidos en total: 49

=== 15. Ningún token completo en los logs de los seis procesos ni en los spans
  ok   tokens en los logs → 0

=== Resultado: todo bien (logs en /var/tmp/quinde-e2e/logs)
```
