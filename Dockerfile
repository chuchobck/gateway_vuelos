# syntax=docker/dockerfile:1
# Imagen de Quinde · Gateway. No lleva credenciales ni claves: todo llega por variables de
# entorno (ver docs/DEPLOY.md). Corre como el usuario node, sin privilegios.
#
#   docker build -t quinde-gateway .
#   docker run --rm -p 8080:8080 --env-file .env.produccion quinde-gateway

ARG NODE_VERSION=22

# --- 1. compilación: dependencias completas y dist/ ------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS compilacion
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- 2. ejecución: solo dependencias de producción, lo compilado y el contrato ---
FROM node:${NODE_VERSION}-bookworm-slim AS ejecucion
ENV NODE_ENV=production
WORKDIR /app

# --ignore-scripts: husky es de desarrollo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=compilacion /app/dist ./dist
# La copia del OpenAPI del core: de ahí salen los scopes al arrancar (y no levanta sin ella).
# Se lee desde dist/rutas, dos niveles arriba: /app/contracts/vuelos-openapi.yaml
COPY contracts ./contracts

# Sin privilegios: el usuario node de la imagen oficial (uid 1000). Nada en /app es suyo, así
# que el proceso no puede reescribir su propio código ni el contrato.
USER node
# 8080 es el público (ingress); 9464 son las métricas (METRICS_PORT): solo la red interna
EXPOSE 8080 9464

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
