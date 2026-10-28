# Despliegue del gateway

El gateway es la **única entrada pública** de Quinde. Los demás servicios (core, bff, identity y
notifier) quedan detrás, sin ingress público. No tiene base de datos ni secretos propios: lo único
sensible que maneja son los tokens que pasan, y nunca los guarda ni los registra.

## 1. Imagen

```bash
docker build -t quinde-gateway .
docker run --rm -p 8080:8080 --env-file .env.produccion quinde-gateway
```

- Imagen multi-etapa `node:22-bookworm-slim`. Corre como el usuario `node` (uid 1000), sin
  privilegios, y nada en `/app` le pertenece.
- Trae `contracts/vuelos-openapi.yaml` (v1) y `contracts/vuelos-openapi-v2.yaml` (v2), de donde
  salen los scopes al arrancar. Sin alguno de los dos, o con uno inválido, no arranca.
  `/health/ready` dice la versión y las operaciones de cada uno (`contract` y `contractV2`).
- `HEALTHCHECK` a `/health`.

## 2. Variables

Un error de validación nombra la variable, nunca su valor, y el proceso sale con 1.

| Variable | Obligatoria | Por defecto | Ejemplo de producción | Qué hace |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | `production` | En `production` se exige `JWT_ISSUER` https y se manda HSTS |
| `PORT` | No | `8080` | `8080` | Puerto de escucha |
| `HOST` | No | `0.0.0.0` | `0.0.0.0` | Interfaz de escucha |
| `LOG_LEVEL` | No | `info` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` o `silent` |
| `UPSTREAM_CORE_URL` | Sí | — | `http://core-vuelos` | Origen del core, sin ruta ni barra final |
| `UPSTREAM_BFF_URL` | Sí | — | `http://bff-vuelos` | Origen del BFF |
| `UPSTREAM_IDENTITY_URL` | Sí | — | `http://identity-vuelos` | Origen de identity |
| `UPSTREAM_NOTIFIER_URL` | Sí | — | `http://notifier-vuelos` | Origen del notifier |
| `TIMEOUT_CORE_MS` | No | `45000` | `45000` | Plazo hasta recibir las cabeceras del core. Es largo porque el plan gratuito de Render tarda ~50 s en despertar |
| `TIMEOUT_BFF_MS` | No | `50000` | `50000` | Un poco más que el del core: una consulta del BFF puede ser la que lo despierte |
| `TIMEOUT_IDENTITY_MS` | No | `10000` | `10000` | Plazo de identity |
| `TIMEOUT_NOTIFIER_MS` | No | `10000` | `10000` | Plazo del notifier |
| `JWT_ISSUER` | Sí | — | `https://api.quinde.example` | `iss` exacto de los tokens: el `JWT_ISSUER` de identity, que en producción es el **origen público de este gateway** (ver la sección 4) |
| `JWT_AUDIENCE` | No | `quinde-vuelos-api` | `quinde-vuelos-api` | `aud` de los tokens |
| `JWKS_URL` | No | `{UPSTREAM_IDENTITY_URL}/.well-known/jwks.json` | (vacía) | De dónde se baja el JWKS. Por defecto va por la red interna, no por el origen público |
| `CORS_ORIGINS` | No | (ninguno) | `https://quinde.example,https://backoffice.quinde.example` | Orígenes de navegador separados por coma, sin ruta ni `*` |
| `TRUST_PROXY_HOPS` | No | `0` | `1` | Proxies de confianza delante del gateway: 0 usa la IP del socket; 1 es el ingress de Azure Container Apps (o Render) |
| `RATE_LIMIT_MAX` | No | `300` | `300` | Peticiones por IP y por ventana, todas las rutas juntas |
| `RATE_LIMIT_WINDOW_SECONDS` | No | `60` | `60` | Ventana del límite global |
| `RATE_LIMIT_STRICT_MAX` | No | `20` | `20` | Por IP y por ruta, en `/oauth2/token` (el mismo contador que `/api/v2/oauth2/token`), `/identity/v1/auth/login` y `/register` |
| `RATE_LIMIT_STRICT_WINDOW_SECONDS` | No | `60` | `60` | Ventana del límite estricto |
| `OTEL_SERVICE_NAME` | No | `quinde-gateway` | `quinde-gateway` | `service.name` de las trazas y de `quinde_build_info` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | (vacía: no se exporta) | `http://otel-collector:4318` | Base OTLP/HTTP; los spans van a `{base}/v1/traces`. Sin valor, las trazas igual se generan y se propagan |
| `OTEL_TRACES_SAMPLER_ARG` | No | `1.0` en desarrollo, `0.1` en producción | `0.1` | Fracción de trazas raíz que se registran (0 a 1) |
| `TRACE_TRUST_INCOMING` | No | `false` | `false` | `true` continúa el `traceparent` del cliente. Solo si delante hay un proxy de confianza que lo genera |
| `METRICS_PORT` | No | `9464` | `9464` | Puerto APARTE de `GET /metrics` (Prometheus); 0 lo apaga. Tiene que ser distinto de `PORT` |

**Los límites son en memoria, por réplica.** Con N réplicas, un cliente tiene N veces el límite (y
el balanceador puede repartirlo distinto). Cada servicio sigue teniendo su propio límite detrás,
así que es una primera barrera, no la única. Si hace falta un límite global exacto, se reemplaza
`Limitador` por uno con almacén compartido (Redis). Hoy no hace falta.

Los estrictos quedan por encima de los de identity (login 5/min, register 10/10 min) para no
adelantarse a ellos: el borde corta las ráfagas grandes y identity sigue decidiendo el detalle.

## 3. Azure Container Apps

- **Gateway**: ingress **externo**, puerto de destino 8080, `TRUST_PROXY_HOPS=1` (el ingress de
  ACA agrega la IP real a la derecha de `X-Forwarded-For`). Si delante hay además Front Door o
  App Gateway, el valor es 2.
- **core, bff, identity, notifier**: ingress **interno** (solo dentro del entorno de Container
  Apps). Las `UPSTREAM_*_URL` del gateway son sus nombres internos
  (`http://<app>`, o el FQDN interno `http://<app>.internal.<entorno>.<región>.azurecontainerapps.io`).
- El **gRPC del core** (50051) solo lo usa el BFF, por la red interna. No se publica.
- `/internal/v1/events` del notifier lo llama el core directo por la red interna
  (`NOTIFIER_URL` del core = nombre interno del notifier). El gateway lo bloquea.
- **core y notifier bajan el JWKS de identity por la red interna**: `JWKS_URL=http://identity-vuelos/.well-known/jwks.json`.
  Si no, irían por el origen público, darían la vuelta por el gateway y dependerían de él.
- **Sondas**: liveness a `/health` y readiness a `/health/ready`. `/health/ready` no depende de
  los upstreams: un servicio caído no saca de rotación al gateway. `/health/upstreams` es solo
  informativo.
- Escalado: cualquier número de réplicas sirve (sin estado), pero el límite por IP es por réplica.
- **Métricas**: el ingress apunta solo al 8080. El 9464 (`METRICS_PORT`) queda para la red interna:
  se declara como puerto adicional TCP del contenedor (`additionalPortMappings`, sin `external`) y
  Prometheus raspa `http://gateway-vuelos:9464/metrics`. En el puerto público, `/metrics` es 404.
- **Trazas**: `OTEL_EXPORTER_OTLP_ENDPOINT` apunta a un recolector interno (un OpenTelemetry Collector
  o Jaeger como Container App interna). Sin él, no se exporta nada y nada se rompe: el gateway sigue
  generando trace-ids para los logs y `X-Trace-Id`.

La fase G2 (contrato v2) no agrega variables: las rutas `/api/v2` y el `X-Correlation-Id` no se
configuran.

## 4. Lo que cambia en los otros servicios

No se toca desde este repo. Es configuración, salvo lo que se marca:

| Servicio | Cambio | Por qué |
| --- | --- | --- |
| identity | `JWT_ISSUER=https://api.quinde.example` (el origen público del gateway) | Su `/.well-known/openid-configuration` arma `issuer`, `jwks_uri` y `token_endpoint` desde `JWT_ISSUER`. Detrás del gateway tienen que apuntar al gateway. Verificado en local: `{"issuer":"http://localhost:8080","jwks_uri":"http://localhost:8080/.well-known/jwks.json","token_endpoint":"http://localhost:8080/oauth2/token"}` |
| core, notifier | `JWT_ISSUER` igual al de identity y al del gateway, y `JWKS_URL` interna | `iss` se compara texto a texto en los tres verificadores |
| core, bff, identity, notifier | `TRUST_PROXY=1` | Los cuatro leen la IP de `X-Forwarded-For` solo con `TRUST_PROXY` (por defecto `false`). Sin ella, detrás del gateway todos ven la IP del gateway y su límite por IP es uno solo para todo el mundo. El gateway escribe un único `X-Forwarded-For` con la IP real, así que 1 es el valor correcto aunque delante del gateway haya más proxies. Core y BFF ya lo traen en `render.yaml`; identity y notifier no lo fijan en ningún lado |
| core, bff, identity, notifier | `CORS_ORIGINS` vacía | El navegador solo habla con el gateway. Con el CORS de un servicio encendido no se rompe nada (el gateway borra los `Access-Control-*` del upstream), pero sobra |
| core, bff, identity, notifier | Ingress interno | Si siguen públicos, se puede entrar sin pasar por el borde (los servicios igual validan todo) |

**Booking Prototipo (contrato v2)**: su base es `https://<gateway>/api/v2` y pide el token por
`POST https://<gateway>/api/v2/oauth2/token` con `client_credentials` (el gateway lo manda a
`/oauth2/token` de identity). Antes, en identity, se crea el cliente `booking-prototipo` como dice su
`docs/PARTNER-BOOKING.md`. El gateway borra `X-User-Id` y `X-User-Roles` si el token no es de partner
(sin `client_id`), y devuelve `X-Correlation-Id` en toda respuesta: si Booking no lo manda, lo genera.

**Cambiar `JWT_ISSUER` invalida los tokens de acceso ya emitidos** (traen el `iss` anterior; duran
15 minutos). Conviene hacerlo en una ventana: identity, core, notifier y gateway con el mismo valor,
y reiniciados juntos. Un cliente que reciba 401 refresca o vuelve a iniciar sesión.

## 5. Verificación

```bash
scripts/smoke.sh https://api.quinde.example   # lo que el borde responde sin depender de los servicios
curl -s https://api.quinde.example/health/upstreams | jq
```

La verificación completa, con los cinco servicios en local, está en [E2E-LOCAL.md](E2E-LOCAL.md).

## 6. Problemas comunes

| Síntoma | Causa |
| --- | --- |
| El proceso sale con `Entorno inválido: - JWT_ISSUER ...` | Falta la variable o no es un origen (sin ruta ni barra final; https en producción) |
| Todo lo protegido da 503 `AUTH_UNAVAILABLE` | El gateway no baja el JWKS. El log dice `No se pudo bajar el JWKS (<motivo>)`: revisar `UPSTREAM_IDENTITY_URL` o `JWKS_URL` |
| Todo token da 401 | El log dice el motivo: `Token rechazado: iss-check_failed` es un `JWT_ISSUER` que no es igual al de identity; `aud-check_failed`, el `JWT_AUDIENCE`; `kid-desconocido`, un token de otro identity |
| 429 enseguida para todos | `TRUST_PROXY_HOPS=0` detrás de un ingress: todos cuentan como la IP del ingress |
| Un servicio limita a todos juntos | Ese servicio no tiene `TRUST_PROXY=1` |
| 504 en la primera petición del día | El core del plan gratuito estaba dormido más de `TIMEOUT_CORE_MS` |
| No llegan trazas al recolector | `OTEL_EXPORTER_OTLP_ENDPOINT` es la base (`http://host:4318`), no `.../v1/traces`; el recolector tiene que aceptar OTLP/HTTP en JSON. Un envío que falla se descarta sin log por petición |
| `/metrics` da 404 | Es lo esperado en el puerto público: las métricas están en `METRICS_PORT` |
| El core ignora el `X-User-Id` de Booking | El token no es de partner (no trae `client_id`): el gateway borra las `X-User-*`. Booking tiene que usar el token de `client_credentials`, no el de una persona |
| Una ruta de `/api/v2` da 404 en el borde | El contrato v2 vendored no la declara con ese método. `npm run rutas:listar` muestra lo que sí; si el core publicó un contrato nuevo, `npm run contrato:sync` |
| `/api/v2/vuelos/webhooks` o `/eventos` dan 404 | Los sirve el notifier y su versión todavía no tiene las rutas v2 |
| El `X-Correlation-Id` de la respuesta no es el que se mandó | No cumplía `^[A-Za-z0-9._:-]{1,100}$` (o llegó repetido): el gateway generó uno nuevo |
