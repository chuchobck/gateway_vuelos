# CLAUDE.md

Reglas permanentes del proyecto. Léelas antes de tocar código.

## Proyecto

Quinde · Gateway: la puerta única del sistema de vuelos (Reto 2 de Integración de Sistemas, PUCE,
fase 6a). Node 22 + TypeScript estricto + Fastify 5, **sin Nest**. Es la única entrada pública:
enruta a core (`backend_vuelos`), bff (`bff_vuelos`), identity (`identity_vuelos`) y notifier
(`notifier_vuelos`), aplica la seguridad en el borde y esconde lo interno. Sin lógica de negocio ni
base de datos. El plan y las decisiones están en `docs/PLAN.md`; las rutas, en `docs/RUTAS.md`; el
despliegue, en `docs/DEPLOY.md`; la verificación local, en `docs/E2E-LOCAL.md`; el estándar de
observabilidad de los cinco servicios (fase 7a), en `docs/OBSERVABILIDAD.md`.

## Alcance

- Solo el borde: rutas, normalización, token y scopes, CORS, límites, cabeceras y proxy. Nada que
  necesite estado de negocio.
- Los servicios siguen validando todo. El gateway nunca es la única barrera ni le pasa identidad a
  nadie: el `Authorization` se reenvía intacto y el gateway no escribe `X-User-*`. Las `X-User-*`
  del cliente (`X-User-Id`, `X-User-Roles`) solo pasan con un token VÁLIDO de partner (claim
  `client_id`); sin token, con uno de persona y en toda ruta pública se borran.
- Desde este repo no se tocan los otros servicios ni los frontends: lo que necesitan va a
  `docs/PLAN.md` ("Lo que necesitan los otros repos").

## Idioma

- Código, carpetas y comentarios en español.
- Rutas y JSON hacia afuera en inglés, como el contrato del core.

## Estructura

- `src/config/entorno.ts`: el entorno validado al arrancar. Un error nombra la variable, nunca su
  valor.
- `src/rutas/`:
  - `tabla-rutas.ts`: **la única tabla de rutas**, declarativa, más `RUTAS_BLOQUEADAS`.
  - `normalizar-ruta.ts`
  - `resolver-ruta.ts`
  - `contrato-core.ts`: los scopes salen del OpenAPI.
- `src/seguridad/`: el verificador copiado del notifier (`claves-jwks.ts`,
  `verificador-jwks.ts`) y `autorizar.ts`.
- `src/borde/`: IP real, limitador y CORS. `src/proxy/`: cabeceras y el cliente `node:http`.
  `src/salud/`.
- `src/observabilidad/`: trazas (OpenTelemetry) y métricas (prom-client), pensado para copiarse a
  los otros servicios: solo `fastify.ts` depende de un framework (ver su README). Las métricas
  propias del borde están en `src/borde/metricas-borde.ts`.
- `observabilidad/`: Jaeger y Prometheus locales (docker-compose) y las consultas PromQL.
- `src/app.ts` arma todo en una ruta comodín; `src/main.ts` arranca. `src/cli/listar-rutas.ts` es
  `npm run rutas:listar`.
- `contracts/vuelos-openapi.yaml` y `contracts/vuelos-openapi-v2.yaml`: copias de los contratos v1
  y v2 del core. **No se editan a mano**: `npm run contrato:sync` las trae de `main` del core y
  `npm run contrato:check` las compara.

## Rutas

- Ninguna regla reescribe la ruta: cada servicio conserva su prefijo. Única excepción, con
  `rutaUpstream`: `/api/v2/oauth2/token` → `/oauth2/token` de identity (el `tokenUrl` relativo del
  contrato v2). No se agrega otra sin anotarla aquí y en `docs/RUTAS.md`.
- Se normaliza ANTES de decidir. Lo ambiguo se rechaza con 400, no se arregla. Se reenvía la ruta
  canónica que se decidió, nunca la cruda.
- `/internal/**` y `/metrics` se evalúan antes que la tabla y responden igual que una ruta
  desconocida (404). Nunca se agrega una regla que lleve a ellos.
- La seguridad de `/flights/v1/**` sale del OpenAPI del core. Lo que el contrato no declara exige un
  token válido. La de `/api/v2/**` sale del contrato v2 (`contracts/vuelos-openapi-v2.yaml`) y lo que
  no declara se niega (404) sin llegar a ningún servicio. Una regla manual nueva lleva su `nota` y
  va a `docs/RUTAS.md`.
- Si `contrato:sync` cambia los scopes, `test/contrato.spec.ts` falla a propósito: se revisa el
  cambio y se actualiza la lista esperada y `docs/RUTAS.md`.

## Seguridad

- Verificador: RS256 fijo (nunca se lee del token), `typ` at+jwt, `iss` y `aud` texto a texto,
  `exp` con 30 s de tolerancia, y un `kid` desconocido con enfriamiento. Sin claves: 503
  `AUTH_UNAVAILABLE` con `Retry-After`, nunca 401 ni dejar pasar.
- Ruta pública: el token no se mira. Si es inválido, igual pasa sin tocar y el servicio decide.
- Errores del borde: ProblemDetails con la forma del contrato del core (sin campos extra) y siempre
  `X-Request-Id`. 401 con `WWW-Authenticate: Bearer`; 403 `insufficient_scope`.
- Nunca al log, a un span, a una métrica ni a una respuesta: `Authorization`, tokens, la query,
  cuerpos, URLs internas ni mensajes de error de red (solo su código). La línea de acceso lleva
  requestId, traceId, spanId, método, plantilla de la ruta, upstream, status y ms.
  `test/escaneo.spec.ts` y `test/trazas.spec.ts` lo comprueban.
- La IP del cliente sale de `ipCliente()` con `TRUST_PROXY_HOPS`. Nunca se confía a ciegas en
  `X-Forwarded-For`. Hacia los servicios va un solo `X-Forwarded-For` con la IP real.
- CORS solo en el gateway: los `Access-Control-*` del upstream se borran. Nunca `*` ni credenciales.
- Sin reintentos automáticos hacia un upstream: un POST repetido puede duplicar una reserva.
- Un vencimiento (copia del JWKS, ventana del límite) se decide con la hora del `Reloj`
  (`src/common/reloj.ts`), no con `Date.now()`: las pruebas lo adelantan. Los plazos de red usan
  temporizadores reales.

## Observabilidad

- El estándar es `docs/OBSERVABILIDAD.md`: un cambio de nombres, etiquetas, atributos o propagación
  se hace allí primero, porque lo copian los otros cuatro servicios.
- El SDK de trazas siempre arranca; el exportador, solo con `OTEL_EXPORTER_OTLP_ENDPOINT`. Una
  petición nunca espera al recolector: solo encola su span.
- El gateway es la raíz: el `traceparent` del cliente no se continúa (salvo
  `TRACE_TRUST_INCOMING=true`) ni se reenvía; hacia cada upstream va el del span cliente.
- Spans manuales, sin instrumentaciones automáticas, con atributos de `ATRIBUTOS_PERMITIDOS` (los
  pone `filtrarAtributos`). Un error lleva `error.type` de la lista cerrada, nunca un mensaje.
- `route` (etiqueta, `http.route`, nombre del span y línea de acceso) es siempre la plantilla o
  `__unmatched__`, nunca la ruta pedida: ni ids, ni correos, ni IPs en spans, métricas o logs.
- Las métricas van en `METRICS_PORT`, nunca en el puerto público.
- Las pruebas de trazas usan el recolector falso (`test/utils/recolector-otlp.ts`) y miran el
  JSON que de verdad sale.

## Proxy

- El cuerpo va y vuelve en streaming: sin buffer, sin parsear, sin descomprimir ni recomprimir. No
  se registra ningún parser de contenido de Fastify.
- Plazo por upstream. Caído: 502; sin respuesta a tiempo: 504. Una respuesta del upstream, incluido
  un 503 con `Retry-After`, pasa tal cual.

## Pruebas

- Jest contra servidores HTTP reales: upstreams falsos (`test/utils/upstream-falso.ts`) y un
  identity falso con su JWKS (`test/utils/identidad-falsa.ts`). Las peticiones salen con la ruta
  exacta (`test/utils/http-crudo.ts`): `fetch` normalizaría `..` y `%2e`.
- "Sin tocar el upstream" se comprueba con `totalIniciadas()`, que cuenta también las peticiones
  cortadas.
- Una prueba nueva se comprueba rompiendo a propósito lo que cubre. Si es de seguridad, su mutación
  va a `scripts/mutaciones.mjs` (`npm run test:mutaciones`).

## Git

- Commits en Conventional Commits y en español: `tipo(ámbito): verbo en infinitivo y qué cambia`.
- Un commit por paso, y cada uno pasa `npm run lint`, `npm run format:check` y `npm run build`.
- Una rama por fase. Push solo de esa rama, al cerrar la fase y ya verificada; nunca a `main`,
  nunca `--force`, nunca reescribir commits subidos. El merge lo hace el dueño del repo.
- Nunca claves, secretos ni `.env` en git: solo `.env.example`.

## Verificación

- Verificar con `curl` o pruebas, no solo compilando. CI (`.github/workflows/ci.yml`) corre lint,
  formato, tipos, build, pruebas, el smoke y la imagen en cada push y pull request a `main`.
  `contrato:check` es informativo.
- Contra un despliegue: `scripts/smoke.sh <BASE_URL>`. Con los cinco servicios en local:
  `scripts/e2e-local.sh` (`docs/E2E-LOCAL.md`).
- Una variable de entorno nueva va en `src/config/entorno.ts`, `.env.example` y `docs/DEPLOY.md`.
- Al terminar cada fase: actualizar `docs/PLAN.md` y entregar un resumen con qué se verificó, qué
  no se pudo verificar y qué se decidió sin consultar.
