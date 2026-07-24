# Multi-stage build producing a single image that serves the API + built SPA.
# Node 26 is required: the app uses the built-in node:sqlite module (no native
# build step), which is available without a flag on this version.

# --- Frontend build ---
FROM node:26-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Backend build ---
FROM node:26-bookworm-slim AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# --- Runtime ---
FROM node:26-bookworm-slim AS runtime
# Stamped by CI from the release tag; shown in the UI and /api/system/status so a
# bug report can name a build. Defaults to "dev" for a plain local build.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=frontend /app/frontend/dist /app/frontend/dist
EXPOSE 8080
# Liveness: any HTTP response from the API (even 401) means the server is up.
# Uses Node's built-in fetch so no curl/wget is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/system/status').then(()=>process.exit(0)).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
