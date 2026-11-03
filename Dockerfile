# syntax=docker/dockerfile:1
# Multi-stage build: small final image, non-root user, health check.

# --- stage 1: build the React frontend ---
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --include=dev
COPY frontend/ ./
RUN npm run build

# --- stage 2: production dependencies only ---
FROM node:22-alpine AS backend-deps
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

# --- stage 3: runtime image ---
FROM node:22-alpine
ENV NODE_ENV=production PORT=4000 RUNNING_IN_DOCKER=true DATABASE_PATH=/data/queueless.db
WORKDIR /app
COPY --from=backend-deps /app/backend/node_modules backend/node_modules
COPY backend/package.json backend/
COPY backend/src backend/src
COPY --from=frontend /app/frontend/dist frontend/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/api/health >/dev/null || exit 1
CMD ["node", "backend/src/server.js"]
