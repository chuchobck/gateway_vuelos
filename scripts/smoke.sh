#!/usr/bin/env bash
# Smoke contra un gateway desplegado (o el local del CI): lo que se responde en el borde, sin
# depender de que los servicios de detrás estén arriba.
#
#   scripts/smoke.sh https://api.quinde.example
#
# Sale con 1 al primer fallo. No usa tokens ni secretos.
set -euo pipefail

BASE="${1:?uso: scripts/smoke.sh <BASE_URL>}"
BASE="${BASE%/}"
fallos=0

comprobar() {
  local descripcion="$1" esperado="$2"
  shift 2
  local obtenido
  obtenido=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$@")
  if [ "$obtenido" = "$esperado" ]; then
    echo "ok   $descripcion ($obtenido)"
  else
    echo "MAL  $descripcion: esperaba $esperado, llegó $obtenido"
    fallos=$((fallos + 1))
  fi
}

comprobar 'GET /health' 200 "$BASE/health"
comprobar 'GET /health/ready' 200 "$BASE/health/ready"
comprobar '/internal/v1/events nunca se enruta' 404 -X POST -H 'content-type: application/json' -d '{}' "$BASE/internal/v1/events"
comprobar '/internal codificado' 404 "$BASE/%69nternal/v1/events"
comprobar 'ruta ambigua (..)' 400 "$BASE/flights/v1/%2e%2e/internal/v1/events"
comprobar 'ruta desconocida' 404 "$BASE/api/docs"
comprobar 'ruta protegida sin token' 401 "$BASE/flights/v1/bookings"
comprobar 'token inválido en ruta protegida' 401 -H 'authorization: Bearer x.y.z' "$BASE/flights/v1/bookings"
grande=$(mktemp)
trap 'rm -f "$grande"' EXIT
head -c 110000 /dev/zero | tr '\0' 'a' >"$grande"
comprobar 'cuerpo de más de 100 kB' 413 -X POST -H 'content-type: application/json' --data-binary "@$grande" "$BASE/flights/v1/search"
comprobar 'preflight' 204 -X OPTIONS -H 'origin: https://evil.example' -H 'access-control-request-method: POST' "$BASE/graphql"

cabeceras=$(curl -s -D - -o /dev/null "$BASE/health")
if grep -qi '^x-request-id: [0-9a-f-]\{36\}' <<<"$cabeceras" && grep -qi '^x-content-type-options: nosniff' <<<"$cabeceras"; then
  echo 'ok   X-Request-Id y nosniff'
else
  echo 'MAL  faltan X-Request-Id o nosniff'
  fallos=$((fallos + 1))
fi
if grep -qi '^x-powered-by\|^server:' <<<"$cabeceras"; then
  echo 'MAL  la respuesta dice quién la sirve (Server / X-Powered-By)'
  fallos=$((fallos + 1))
fi

[ "$fallos" -eq 0 ] && echo 'smoke: todo bien' || { echo "smoke: $fallos fallo(s)"; exit 1; }
