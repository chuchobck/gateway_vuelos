#!/usr/bin/env bash
# =============================================================================
#  Verificación real en local: identity, core (AUTH_MODE=external, WEBHOOKS_MODE=notifier),
#  notifier, bff, este gateway y un receptor de webhooks. Después se entra SOLO por el gateway.
#  La guía, con las salidas de una corrida, está en docs/E2E-LOCAL.md.
#
#  Uso:  scripts/e2e-local.sh --preparar     bases nuevas, claves y cliente core-vuelos; y recorre
#        scripts/e2e-local.sh                usa lo ya preparado: arranca, recorre y apaga
#        scripts/e2e-local.sh --dejar-arriba no apaga los servicios al terminar
#        scripts/e2e-local.sh --detener      apaga lo que haya quedado arriba
#
#  Supone los repos como carpetas vecinas (../backend_vuelos, ../identity_vuelos,
#  ../notifier_vuelos, ../bff_vuelos), en main, con `npm ci` y `npm run build` hechos, y un
#  PostgreSQL en PG_URL (por defecto postgresql://postgres:postgres@localhost:5432) con psql en el
#  PATH. Las tres bases (booking_db, identity_db, notifier_db) se BORRAN con --preparar: solo
#  contra un PostgreSQL local.
#
#  Lo generado (claves, secretos, logs) queda en E2E_DIR (por defecto /var/tmp/quinde-e2e, modo
#  700), nunca en el repo. Lo que se imprime no lleva tokens completos ni secretos.
# =============================================================================
set -euo pipefail

GW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAIZ="$(dirname "$GW_DIR")"
CORE="$RAIZ/backend_vuelos"
IDENTITY="$RAIZ/identity_vuelos"
NOTIFIER="$RAIZ/notifier_vuelos"
BFF="$RAIZ/bff_vuelos"

PG="${PG_URL:-postgresql://postgres:postgres@localhost:5432}"
ESTADO="${E2E_DIR:-/var/tmp/quinde-e2e}"
LOGS="$ESTADO/logs"
GW="http://localhost:8080"
RECEPTOR="http://127.0.0.1:4010"

mkdir -p "$LOGS"
chmod 700 "$ESTADO"

# --- utilidades -----------------------------------------------------------------
titulo() { printf '\n=== %s\n' "$*"; }
corto() { printf '%s…(%s caracteres)' "${1:0:12}" "${#1}"; }
aleatorio() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('base64url'))"; }
uuid() { node -e "process.stdout.write(require('crypto').randomUUID())"; }

# curl contra el gateway: imprime "STATUS" en la primera línea y el cuerpo después
pedir() {
  local metodo="$1" ruta="$2"
  shift 2
  curl -s -X "$metodo" -w '\n%{http_code}' --path-as-is "$@" "$GW$ruta" | {
    local cuerpo status
    cuerpo="$(cat)"
    status="${cuerpo##*$'\n'}"
    cuerpo="${cuerpo%$'\n'*}"
    printf '%s\n%s' "$status" "$cuerpo"
  }
}
status_de() { head -n 1 <<<"$1"; }
cuerpo_de() { tail -n +2 <<<"$1"; }

esperar() {
  local nombre="$1" url="$2" pid
  pid="$(cat "$ESTADO/$nombre.pid")"
  for _ in $(seq 1 60); do
    # Que responda ESE proceso, no uno viejo que haya quedado en el puerto
    kill -0 "$pid" 2>/dev/null || break
    curl -fsS -o /dev/null "$url" 2>/dev/null && { echo "  $nombre arriba (pid $pid)"; return 0; }
    sleep 1
  done
  echo "  $nombre no levantó: ver $LOGS/$nombre.log" >&2
  tail -n 20 "$LOGS/$nombre.log" >&2
  return 1
}

fallos=0
verificar() {
  local descripcion="$1" esperado="$2" obtenido="$3"
  if [[ "$obtenido" == "$esperado" ]]; then
    echo "  ok   $descripcion → $obtenido"
  else
    echo "  MAL  $descripcion → $obtenido (esperaba $esperado)"
    fallos=$((fallos + 1))
  fi
}

detener() {
  local archivo pid
  for archivo in "$ESTADO"/*.pid; do
    [[ -e "$archivo" ]] || continue
    pid="$(cat "$archivo")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$archivo"
  done
}

puertos_libres() {
  local puerto ocupados=()
  for puerto in 3000 3001 3002 4000 4010 4318 8080 9464 50051; do
    (echo >"/dev/tcp/127.0.0.1/$puerto") 2>/dev/null && ocupados+=("$puerto")
  done
  if [[ ${#ocupados[@]} -gt 0 ]]; then
    echo "Puertos ocupados por otro proceso: ${ocupados[*]}. Apágalo (o scripts/e2e-local.sh --detener)." >&2
    exit 1
  fi
}

# --- 1. preparar: bases, claves y el cliente del core ------------------------------
preparar() {
  titulo 'Preparar: bases nuevas, claves de identity y el cliente core-vuelos'
  for bd in booking_db identity_db notifier_db; do
    psql "$PG/postgres" -q -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS $bd WITH (FORCE)" -c "CREATE DATABASE $bd"
  done

  # core: lo mismo que su db/reset.sh (que usa docker exec), con el psql local
  for archivo in esquema_vuelos.sql esquema_seguridad.sql semilla_vuelos.sql semilla_seguridad.sql; do
    psql "$PG/booking_db" -q -v ON_ERROR_STOP=1 -f "$CORE/db/$archivo" >/dev/null
  done
  echo "  core: esquema y semilla cargados"

  local admin_clave
  admin_clave="Adm-$(aleatorio 18)"
  (cd "$IDENTITY" && DATABASE_URL="$PG/identity_db?schema=identidad" \
    SEED_ADMIN_EMAIL=admin@e2e.quinde.example SEED_ADMIN_PASSWORD="$admin_clave" \
    ./db/reset.sh >/dev/null && DATABASE_URL="$PG/identity_db?schema=identidad" ./db/migrar.sh)
  echo "  identity: reset.sh y migrar.sh aplicados (administrador admin@e2e.quinde.example)"

  (cd "$NOTIFIER" && DATABASE_URL="$PG/notifier_db?schema=notificaciones" ./db/reset.sh >/dev/null)
  echo "  notifier: esquema cargado"

  local clave_firma cliente
  clave_firma="$(cd "$IDENTITY" && node dist/cli/generar-claves.js | sed -n 's/^JWT_SIGNING_KEY=//p')"
  cliente="$(cd "$IDENTITY" && DATABASE_URL="$PG/identity_db?schema=identidad" \
    node dist/cli/crear-cliente.js --nombre "Core eventos (e2e)" --scopes "events:publish" \
    --permitir-eventos)"
  umask 077
  cat >"$ESTADO/estado.env" <<EOF
ADMIN_EMAIL=admin@e2e.quinde.example
ADMIN_PASSWORD=$admin_clave
JWT_SIGNING_KEY=$clave_firma
NOTIFIER_CLIENT_ID=$(sed -n 's/^client_id: *//p' <<<"$cliente")
NOTIFIER_CLIENT_SECRET=$(sed -n 's/^client_secret: *//p' <<<"$cliente")
CORE_WEBHOOK_SECRET_KEY=$(aleatorio 32)
NOTIFIER_WEBHOOK_SECRET_KEY=$(aleatorio 32)
BOARDING_PASS_SECRET=$(aleatorio 48)
EOF
  echo "  secretos en $ESTADO/estado.env (modo 600, fuera del repo)"
}

# --- 2. arrancar los seis procesos ---------------------------------------------------
arrancar() {
  titulo 'Arrancar (todos con TRUST_PROXY=1: el gateway va delante)'
  # shellcheck disable=SC1091
  source "$ESTADO/estado.env"
  : >"$ESTADO/receptor.jsonl"

  RECEPTOR_PORT=4010 RECEPTOR_ARCHIVO="$ESTADO/receptor.jsonl" \
    node "$GW_DIR/scripts/e2e/receptor.mjs" >"$LOGS/receptor.log" 2>&1 &
  echo $! >"$ESTADO/receptor.pid"

  # En lugar de Jaeger (sin Docker): un recolector OTLP/HTTP falso que guarda cada span
  : >"$ESTADO/spans.jsonl"
  RECOLECTOR_PORT=4318 RECOLECTOR_ARCHIVO="$ESTADO/spans.jsonl" \
    node "$GW_DIR/scripts/e2e/recolector-otlp.mjs" >"$LOGS/recolector.log" 2>&1 &
  echo $! >"$ESTADO/recolector.pid"

  (cd "$IDENTITY" && exec env -i PATH="$PATH" NODE_ENV=development PORT=3001 \
    DATABASE_URL="$PG/identity_db?schema=identidad" JWT_ISSUER="$GW" \
    JWT_AUDIENCE=quinde-vuelos-api JWT_SIGNING_KEY="$JWT_SIGNING_KEY" TRUST_PROXY=1 \
    node dist/main.js) >"$LOGS/identity.log" 2>&1 &
  echo $! >"$ESTADO/identity.pid"
  esperar identity http://localhost:3001/identity/v1/health

  (cd "$NOTIFIER" && exec env -i PATH="$PATH" NODE_ENV=development PORT=3002 \
    DATABASE_URL="$PG/notifier_db?schema=notificaciones" \
    WEBHOOK_SECRET_KEY="$NOTIFIER_WEBHOOK_SECRET_KEY" JWT_ISSUER="$GW" \
    JWT_AUDIENCE=quinde-vuelos-api JWKS_URL=http://localhost:3001/.well-known/jwks.json \
    TRUST_PROXY=1 NOTIFIER_DELIVERY_JOB_INTERVAL_SECONDS=5 \
    node dist/main.js) >"$LOGS/notifier.log" 2>&1 &
  echo $! >"$ESTADO/notifier.pid"
  esperar notifier http://localhost:3002/health

  (cd "$CORE" && exec env -i PATH="$PATH" NODE_ENV=development PORT=3000 \
    DATABASE_URL="$PG/booking_db?schema=vuelos" AUTH_MODE=external JWT_ISSUER="$GW" \
    JWT_AUDIENCE=quinde-vuelos-api JWKS_URL=http://localhost:3001/.well-known/jwks.json \
    BOARDING_PASS_SECRET="$BOARDING_PASS_SECRET" WEBHOOK_SECRET_KEY="$CORE_WEBHOOK_SECRET_KEY" \
    WEBHOOKS_MODE=notifier NOTIFIER_URL=http://localhost:3002 \
    IDENTITY_TOKEN_URL=http://localhost:3001/oauth2/token \
    NOTIFIER_CLIENT_ID="$NOTIFIER_CLIENT_ID" NOTIFIER_CLIENT_SECRET="$NOTIFIER_CLIENT_SECRET" \
    GRPC_ENABLED=true GRPC_PORT=50051 TRUST_PROXY=1 \
    node dist/main.js) >"$LOGS/core.log" 2>&1 &
  echo $! >"$ESTADO/core.pid"
  esperar core http://localhost:3000/flights/v1/health

  (cd "$BFF" && exec env -i PATH="$PATH" NODE_ENV=development PORT=4000 CORE_TRANSPORT=grpc \
    CORE_GRPC_URL=localhost:50051 TRUST_PROXY=1 \
    node dist/main.js) >"$LOGS/bff.log" 2>&1 &
  echo $! >"$ESTADO/bff.pid"
  esperar bff http://localhost:4000/health

  (cd "$GW_DIR" && exec env -i PATH="$PATH" NODE_ENV=development PORT=8080 \
    UPSTREAM_CORE_URL=http://localhost:3000 UPSTREAM_BFF_URL=http://localhost:4000 \
    UPSTREAM_IDENTITY_URL=http://localhost:3001 UPSTREAM_NOTIFIER_URL=http://localhost:3002 \
    JWT_ISSUER="$GW" CORS_ORIGINS=http://localhost:5173 TRUST_PROXY_HOPS=0 \
    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 METRICS_PORT=9464 \
    node dist/main.js) >"$LOGS/gateway.log" 2>&1 &
  echo $! >"$ESTADO/gateway.pid"
  esperar gateway "$GW/health"
}

# --- 3. el recorrido, solo por el gateway ---------------------------------------------
recorrer() {
  # shellcheck disable=SC1091
  source "$ESTADO/estado.env"
  local r correo clave token admin_token

  titulo '1. Registro y login de una persona por /identity/v1/auth'
  correo="e2e-$(aleatorio 6 | tr -dc 'a-z0-9' | head -c 8)@e2e.quinde.example"
  clave="Clave-e2e-$(aleatorio 12)"
  r="$(pedir POST /identity/v1/auth/register -H 'content-type: application/json' \
    -d "{\"email\":\"$correo\",\"password\":\"$clave\"}")"
  verificar 'POST /identity/v1/auth/register' 201 "$(status_de "$r")"
  r="$(pedir POST /identity/v1/auth/login -H 'content-type: application/json' \
    -d "{\"email\":\"$correo\",\"password\":\"$clave\"}")"
  verificar 'POST /identity/v1/auth/login' 200 "$(status_de "$r")"
  token="$(cuerpo_de "$r" | jq -r .access_token)"
  echo "  access_token: $(corto "$token")"
  echo "  scope: $(cut -d. -f2 <<<"$token" | base64 -d 2>/dev/null | jq -r .scope || true)"
  echo "  iss: $(cut -d. -f2 <<<"$token" | base64 -d 2>/dev/null | jq -r .iss || true)"

  titulo '2. Descubrimiento detrás del gateway'
  r="$(pedir GET /.well-known/openid-configuration)"
  verificar 'GET /.well-known/openid-configuration' 200 "$(status_de "$r")"
  cuerpo_de "$r" | jq -c '{issuer, jwks_uri, token_endpoint}'
  verificar 'GET /.well-known/jwks.json' 200 "$(status_de "$(pedir GET /.well-known/jwks.json)")"

  titulo '3. /graphql: una búsqueda (bff → core por gRPC)'
  local fecha
  fecha="$(date -u -d '+1 day' +%F)"
  r="$(pedir POST /graphql -H 'content-type: application/json' \
    -H 'x-device-fingerprint: e2e-gateway-0001' \
    -d "{\"query\":\"query { searchFlights(input: {itineraries: [{origin: \\\"UIO\\\", destination: \\\"GYE\\\", departureDate: \\\"$fecha\\\"}], passengers: {adults: 1}}) { totalOffers offers { offerId grandTotal { total currency } } } }\"}")"
  verificar 'POST /graphql searchFlights' 200 "$(status_de "$r")"
  cuerpo_de "$r" | jq -c '{totalOffers: .data.searchFlights.totalOffers, primera: .data.searchFlights.offers[0].grandTotal, errors: (.errors // [] | length)}'

  titulo '4. Ruta protegida de /flights/v1, sin token y con token'
  local id_peticion
  id_peticion="$(uuid)"
  verificar 'GET /flights/v1/bookings sin token (401 en el borde)' 401 \
    "$(status_de "$(pedir GET /flights/v1/bookings)")"
  r="$(pedir GET '/flights/v1/bookings?limit=5' -H "authorization: Bearer $token" \
    -H "x-request-id: $id_peticion")"
  verificar 'GET /flights/v1/bookings con token' 200 "$(status_de "$r")"
  echo "  X-Request-Id enviado: $id_peticion"

  titulo '5. /identity/v1/admin/users: persona (403 en el borde) y administrador'
  r="$(pedir GET /identity/v1/admin/users -H "authorization: Bearer $token")"
  verificar 'persona sin flights:admin' 403 "$(status_de "$r")"
  cuerpo_de "$r" | jq -c '{status, detail}'
  r="$(pedir POST /identity/v1/auth/login -H 'content-type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
  admin_token="$(cuerpo_de "$r" | jq -r .access_token)"
  r="$(pedir GET /identity/v1/admin/users -H "authorization: Bearer $admin_token")"
  verificar 'administrador' 200 "$(status_de "$r")"
  echo "  administradores: $(cuerpo_de "$r" | jq -c 'if type == "array" then length else (.data // .items | length) end')"

  titulo '6. Suscripción por /flights/v1/webhooks (llega al notifier)'
  local secreto_webhook suscripcion
  secreto_webhook="whsec-e2e-$(aleatorio 24)"
  r="$(pedir POST /flights/v1/webhooks -H "authorization: Bearer $token" \
    -H 'content-type: application/json' \
    -d "{\"url\":\"$RECEPTOR/hooks/quinde\",\"events\":[\"booking.confirmed\",\"booking.ticket_issued\"],\"secret\":\"$secreto_webhook\"}")"
  verificar 'POST /flights/v1/webhooks' 201 "$(status_de "$r")"
  suscripcion="$(cuerpo_de "$r" | jq -r .id)"
  cuerpo_de "$r" | jq -c '{id, events, secret}'

  titulo '7. Una reserva real por el gateway (search → hold → booking)'
  local busqueda oferta itinerario hold reserva
  busqueda="$(pedir POST /flights/v1/search -H 'content-type: application/json' \
    -H 'x-device-fingerprint: e2e-gateway-0001' \
    -d "{\"itineraries\":[{\"origin\":\"UIO\",\"destination\":\"GYE\",\"departureDate\":\"$fecha\"}],\"passengers\":{\"adults\":1}}")"
  verificar 'POST /flights/v1/search' 200 "$(status_de "$busqueda")"
  oferta="$(cuerpo_de "$busqueda" | jq -r '.offers[0].offerId')"
  itinerario="$(cuerpo_de "$busqueda" | jq -r '.offers[0].itineraries[0].itineraryId')"
  r="$(pedir POST /flights/v1/offers/hold -H "authorization: Bearer $token" \
    -H 'content-type: application/json' -H "idempotency-key: $(uuid)" \
    -d "{\"offerId\":\"$oferta\",\"itinerarySelections\":[{\"itineraryId\":\"$itinerario\",\"cabinClass\":\"ECONOMY\",\"fareBrand\":\"CLASSIC\"}],\"passengersBreakdown\":{\"adults\":1}}")"
  verificar 'POST /flights/v1/offers/hold' 201 "$(status_de "$r")"
  hold="$(cuerpo_de "$r" | jq -r .holdId)"
  r="$(pedir POST /flights/v1/bookings -H "authorization: Bearer $token" \
    -H 'content-type: application/json' -H "idempotency-key: $(uuid)" \
    -d "{\"holdId\":\"$hold\",\"passengers\":[{\"passengerId\":\"ADU1\",\"passengerType\":\"ADULT\",\"firstName\":\"Ana\",\"lastName\":\"Prueba\",\"documentType\":\"NATIONAL_ID\",\"documentNumber\":\"1710034065\",\"nationality\":\"EC\",\"birthDate\":\"1990-04-15\",\"gender\":\"F\",\"contact\":{\"email\":\"$correo\",\"phone\":\"+593991234567\"}}],\"payment\":{\"paymentReference\":\"PAY-OK-E2E$(date +%s)\"}}")"
  verificar 'POST /flights/v1/bookings' 201 "$(status_de "$r")"
  reserva="$(cuerpo_de "$r" | jq -r .bookingId)"
  cuerpo_de "$r" | jq -c '{bookingId, pnr, status}'

  titulo '8. El webhook firmado en el receptor (la firma se recalcula con openssl)'
  local linea=''
  for _ in $(seq 1 60); do
    linea="$(grep -m1 '"booking.confirmed"' "$ESTADO/receptor.jsonl" || true)"
    [[ -n "$linea" ]] && break
    sleep 1
  done
  if [[ -z "$linea" ]]; then
    verificar 'webhook booking.confirmed en el receptor' 'recibido' 'no llegó en 60 s'
  else
    local marca firma cuerpo calculada
    marca="$(jq -r '.cabeceras["x-webhook-timestamp"]' <<<"$linea")"
    firma="$(jq -r '.cabeceras["x-webhook-signature"]' <<<"$linea")"
    cuerpo="$(jq -r .cuerpo <<<"$linea" | base64 -d)"
    calculada="sha256=$(printf '%s.%s' "$marca" "$cuerpo" | openssl dgst -sha256 -hmac "$secreto_webhook" -hex | sed 's/^.* //')"
    jq -c '{ruta, evento: .cabeceras["x-webhook-event"], id: .cabeceras["x-webhook-id"]}' <<<"$linea"
    echo "  reserva del evento: $(jq -r '.data.bookingId // .data.booking.bookingId // empty' <<<"$cuerpo") (la creada: $reserva)"
    verificar 'firma recalculada = X-Webhook-Signature' "$firma" "$calculada"
  fi

  titulo '9. /internal/v1/events por el gateway'
  # Cada intento lleva su X-Request-Id: el gateway lo registra (404/400, sin upstream) y el
  # notifier no debe verlo nunca. (Su log sí tiene /internal: las publicaciones del core, directas.)
  local intento ids_internos=()
  for intento in /internal/v1/events /%69nternal/v1/events /INTERNAL/v1/events \
    /flights/v1/%2e%2e/%2e%2e/internal/v1/events; do
    id_peticion_interna="$(uuid)"
    ids_internos+=("$id_peticion_interna")
    r="$(pedir POST "$intento" -H 'content-type: application/json' -H "x-request-id: $id_peticion_interna" \
      -H "authorization: Bearer $token" -d '{}')"
    if [[ "$intento" == *%2e%2e* ]]; then
      verificar "POST $intento" 400 "$(status_de "$r")"
    else
      verificar "POST $intento" 404 "$(status_de "$r")"
    fi
  done
  local vistos=0
  for id_peticion_interna in "${ids_internos[@]}"; do
    grep -q "$id_peticion_interna" "$LOGS/notifier.log" && vistos=$((vistos + 1))
  done
  verificar 'intentos que llegaron al notifier' 0 "$vistos"
  grep "${ids_internos[0]}" "$LOGS/gateway.log" | sed 's/^/  gateway: /'

  titulo '10. Preflight de CORS'
  local cabeceras
  cabeceras="$(curl -s -D - -o /dev/null -X OPTIONS "$GW/flights/v1/bookings" \
    -H 'origin: http://localhost:5173' -H 'access-control-request-method: POST' \
    -H 'access-control-request-headers: authorization, content-type, idempotency-key')"
  verificar 'OPTIONS /flights/v1/bookings' 204 "$(head -n1 <<<"$cabeceras" | awk '{print $2}')"
  grep -i '^access-control-' <<<"$cabeceras" | tr -d '\r' | sed 's/^/  /'

  titulo '11. El mismo X-Request-Id en la respuesta y en los logs del gateway y del core'
  local en_gateway en_core en_respuesta
  en_respuesta="$(curl -s -D - -o /dev/null "$GW/flights/v1/bookings?limit=5" \
    -H "authorization: Bearer $token" -H "x-request-id: $id_peticion" |
    tr -d '\r' | sed -n 's/^x-request-id: //Ip')"
  verificar 'X-Request-Id de la respuesta' "$id_peticion" "$en_respuesta"
  en_gateway="$(grep -c "$id_peticion" "$LOGS/gateway.log" || true)"
  en_core="$(grep -c "$id_peticion" "$LOGS/core.log" || true)"
  verificar "líneas del gateway con $id_peticion" 'alguna' "$([[ $en_gateway -gt 0 ]] && echo alguna || echo ninguna)"
  verificar "líneas del core con $id_peticion" 'alguna' "$([[ $en_core -gt 0 ]] && echo alguna || echo ninguna)"
  grep -m1 "$id_peticion" "$LOGS/gateway.log" | sed 's/^/  gateway: /'
  # La línea de acceso del core (sin los colores del logger de Nest en desarrollo)
  grep "$id_peticion" "$LOGS/core.log" | grep -m1 'HTTP' | sed 's/\x1b\[[0-9;]*m//g' |
    cut -c1-220 | sed 's/^/  core:    /'

  titulo '12. IP real: un X-Forwarded-For del cliente no llega al core'
  local id_ip
  id_ip="$(uuid)"
  pedir GET /flights/v1/bookings -H "authorization: Bearer $token" -H "x-request-id: $id_ip" \
    -H 'x-forwarded-for: 203.0.113.66' -H 'x-real-ip: 203.0.113.66' >/dev/null
  local linea_ip
  linea_ip="$(grep "$id_ip" "$LOGS/core.log" | grep -m1 'HTTP' | sed 's/\x1b\[[0-9;]*m//g')"
  verificar 'ip que registró el core (TRUST_PROXY=1)' 'ip=127.0.0.1' "$(grep -o 'ip=[0-9a-f.:]*' <<<"$linea_ip")"

  titulo '13. Métricas en el puerto aparte (9464)'
  verificar 'GET /metrics en el puerto público' 404 "$(status_de "$(pedir GET /metrics)")"
  local metricas
  metricas="$(curl -s http://localhost:9464/metrics)"
  local serie_reservas='http_server_requests_total{method="GET",route="/flights/v1/bookings",status="200"}'
  local reservas_ok
  reservas_ok="$(grep -F "$serie_reservas " <<<"$metricas" | awk '{print $2}')"
  verificar 'GET /flights/v1/bookings 200 contadas (pasos 4, 11 y 12: 3 o más)' 'sí' \
    "$([[ ${reservas_ok:-0} -ge 3 ]] && echo sí || echo "no (${reservas_ok:-0})")"
  grep -E '^(http_server_requests_total|gateway_auth_rejections_total|gateway_rate_limited_total|gateway_upstream_errors_total|quinde_build_info)' <<<"$metricas" |
    sed 's/^/  /'
  echo '  cubetas de GET /flights/v1/bookings 200:'
  grep -F 'http_server_request_duration_seconds_bucket{le=' <<<"$metricas" |
    grep -F 'route="/flights/v1/bookings",status="200"' | sed 's/^/    /'
  grep -E '^http_client_request_duration_seconds_count' <<<"$metricas" | sed 's/^/  /'
  local sin_401
  sin_401="$(grep -F 'gateway_auth_rejections_total{reason="missing_token"} ' <<<"$metricas" | awk '{print $2}')"
  verificar 'rechazos missing_token (paso 4) contados' 'sí' "$([[ ${sin_401:-0} -ge 1 ]] && echo sí || echo no)"
  local con_cubetas
  con_cubetas="$(grep -c 'http_server_request_duration_seconds_bucket{le="60"' <<<"$metricas")"
  verificar 'histograma con la cubeta de 60 s' 'sí' "$([[ $con_cubetas -gt 0 ]] && echo sí || echo no)"
  local etiquetas_sensibles
  etiquetas_sensibles="$(grep -v '^#' <<<"$metricas" | grep -cE "$reserva|$correo|@|[0-9a-f]{8}-[0-9a-f]{4}-" || true)"
  verificar 'etiquetas con ids, correos o uuid' 0 "$etiquetas_sensibles"

  titulo '14. Trazas del gateway en el recolector OTLP (en lugar de Jaeger)'
  local id_traza traza_cab
  id_traza="$(uuid)"
  traza_cab="$(curl -s -D - -o /dev/null "$GW/flights/v1/bookings/$reserva" \
    -H "authorization: Bearer $token" -H "x-request-id: $id_traza" \
    -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' |
    tr -d '\r' | sed -n 's/^x-trace-id: //Ip')"
  echo "  X-Trace-Id: $traza_cab"
  verificar 'traza nueva (no la del cliente)' 'sí' \
    "$([[ -n $traza_cab && $traza_cab != 4bf92f3577b34da6a3ce929d0e0e4736 ]] && echo sí || echo no)"
  local spans=''
  for _ in $(seq 1 30); do
    spans="$(grep -F "\"traceId\":\"$traza_cab\"" "$ESTADO/spans.jsonl" || true)"
    [[ $(grep -c . <<<"$spans") -ge 3 ]] && break
    sleep 0.5
  done
  jq -c '{tipo, nombre, padre: (if .parentSpanId == "" then "-" else .parentSpanId end), spanId, atributos, estado: .estado.code}' <<<"$spans" | sed 's/^/  /'
  head -n1 <<<"$spans" | jq -c '{tipoContenido, recurso}' | sed 's/^/  /'
  local raiz
  raiz="$(jq -r 'select(.tipo == 2) | .spanId' <<<"$spans")"
  verificar 'span raíz SERVER con la plantilla' 'GET /flights/v1/bookings/{bookingId}' \
    "$(jq -r 'select(.tipo == 2) | .nombre' <<<"$spans")"
  verificar 'hijos de la raíz: auth.verify (INTERNAL) y el upstream (CLIENT)' '1 3' \
    "$(jq -r --arg r "$raiz" 'select(.parentSpanId == $r) | .tipo' <<<"$spans" | sort | tr '\n' ' ' | sed 's/ $//')"
  verificar 'service.name' 'quinde-gateway' "$(head -n1 <<<"$spans" | jq -r '.recurso["service.name"]')"
  local linea_log
  linea_log="$(grep -F "\"requestId\":\"$id_traza\"" "$LOGS/gateway.log" | grep -F '"msg":"acceso"')"
  echo "  gateway: $linea_log"
  verificar 'X-Trace-Id = traceId del log del gateway' "$traza_cab" "$(jq -r .traceId <<<"$linea_log")"
  verificar 'spans con la reserva, el correo, Authorization o una IP' 0 \
    "$(grep -cE "$reserva|$correo|[Aa]uthorization|Bearer|127\.0\.0\.1" "$ESTADO/spans.jsonl" || true)"
  echo "  spans recibidos en total: $(grep -c . "$ESTADO/spans.jsonl")"

  titulo '15. Ningún token completo en los logs de los seis procesos ni en los spans'
  local con_token=0
  for archivo in "$LOGS"/*.log "$ESTADO/spans.jsonl"; do
    if grep -qF "$token" "$archivo" || grep -qF "$admin_token" "$archivo"; then
      echo "  MAL  $(basename "$archivo") tiene un token"
      con_token=1
    fi
  done
  verificar 'tokens en los logs' 0 "$con_token"

  # Baja de la suscripción de prueba (las pruebas no borran: dan de baja)
  pedir DELETE "/flights/v1/webhooks/$suscripcion" -H "authorization: Bearer $token" >/dev/null || true
}

case "${1:-}" in
  --detener)
    detener
    exit 0
    ;;
esac

trap '[[ "${1:-}" == "--dejar-arriba" ]] || detener' EXIT
[[ "${1:-}" == "--preparar" || ! -f "$ESTADO/estado.env" ]] && preparar
detener
puertos_libres
arrancar
recorrer

titulo "Resultado: $([[ $fallos -eq 0 ]] && echo 'todo bien' || echo "$fallos fallo(s)") (logs en $LOGS)"
exit "$fallos"
