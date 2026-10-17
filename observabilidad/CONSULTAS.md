# Consultas PromQL

Las métricas siguen el estándar de [docs/OBSERVABILIDAD.md](../docs/OBSERVABILIDAD.md). La etiqueta
`service` la pone `prometheus.yml` en cada objetivo. `quinde_build_info` ya trae una `service` propia:
con `honor_labels: false` (el valor por defecto), Prometheus la guarda como `exported_service`.

**No verificado aquí:** en la sesión de la fase 7a no había Docker ni Prometheus. Las consultas se
escribieron contra los nombres y etiquetas que el gateway expone de verdad, y que comprueban
`test/metricas.spec.ts` y `scripts/e2e-local.sh`.

## Tráfico y errores

```promql
# Peticiones por segundo, por servicio
sum by (service) (rate(http_server_requests_total[5m]))

# Peticiones por segundo por ruta (plantilla) en el gateway
sum by (route) (rate(http_server_requests_total{service="quinde-gateway"}[5m]))

# Proporción de 5xx por servicio
sum by (service) (rate(http_server_requests_total{status=~"5.."}[5m]))
  / sum by (service) (rate(http_server_requests_total[5m]))

# Proporción de 4xx en el gateway (clientes con problemas, sondeos)
sum(rate(http_server_requests_total{service="quinde-gateway",status=~"4.."}[5m]))
  / sum(rate(http_server_requests_total{service="quinde-gateway"}[5m]))

# Lo que no corresponde a ninguna ruta (404, /internal, /metrics, rutas ambiguas)
sum(rate(http_server_requests_total{route="__unmatched__"}[5m]))
```

## Latencia

```promql
# p95 por ruta en el gateway
histogram_quantile(0.95,
  sum by (le, route) (rate(http_server_request_duration_seconds_bucket{service="quinde-gateway"}[5m])))

# p50 y p99 de todo el gateway
histogram_quantile(0.5, sum by (le) (rate(http_server_request_duration_seconds_bucket{service="quinde-gateway"}[5m])))
histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service="quinde-gateway"}[5m])))

# p95 de cada upstream visto desde el gateway (incluye la red y el arranque en frío)
histogram_quantile(0.95,
  sum by (le, upstream) (rate(http_client_request_duration_seconds_bucket{service="quinde-gateway"}[5m])))

# Lo que el gateway agrega encima del upstream (p95 del servidor menos p95 del cliente, por ruta)
histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_seconds_bucket{service="quinde-gateway",route!="__unmatched__"}[5m])))
  - on (route) histogram_quantile(0.95, sum by (le, route) (rate(http_client_request_duration_seconds_bucket{service="quinde-gateway"}[5m])))
```

La última consulta solo cuadra si `http_client_request_duration_seconds` lleva `route`. Hoy no la
lleva (sus etiquetas son `upstream`, `method` y `status`), así que es un ejemplo para la fase 7d:
agregar `route` al cliente es parte del análisis de latencia.

## Seguridad en el borde

```promql
# Rechazos de token por motivo
sum by (reason) (rate(gateway_auth_rejections_total[5m]))

# Un pico de invalid_token (tokens robados, clientes con reloj mal, otro iss)
sum(rate(gateway_auth_rejections_total{reason="invalid_token"}[5m])) > 1

# JWKS no disponible: identity caído y sin copia vigente
sum(increase(gateway_auth_rejections_total{reason="jwks_unavailable"}[5m])) > 0

# Peticiones cortadas por el límite, por política
sum by (policy) (rate(gateway_rate_limited_total[5m]))
```

## Upstreams

```promql
# Fallos de upstream por tipo (unavailable = 502, timeout = 504)
sum by (upstream, kind) (rate(gateway_upstream_errors_total[5m]))

# 5xx que devuelve cada upstream
sum by (upstream) (rate(http_client_request_duration_seconds_count{status=~"5.."}[5m]))
```

## Proceso

```promql
# Versión desplegada de cada servicio
quinde_build_info

# Memoria y lag del event loop
process_resident_memory_bytes
nodejs_eventloop_lag_p99_seconds
```
