# =============================================================================
# Multi-stage build
#   Stage 1 (client-build): install client deps, compile TypeScript, run Vite
#   Stage 2 (runtime):      install API deps, copy server + built frontend
#
# Build context must be the project root (not ./app):
#   docker build -f app/Dockerfile .
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — Build the React / Vite frontend
# ---------------------------------------------------------------------------
FROM node:20-alpine AS client-build
WORKDIR /build
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
# Use an absolute --outDir so the output location is predictable regardless
# of what vite.config.ts has set for outDir.
RUN npx tsc -b && npx vite build --outDir /client-dist --emptyOutDir

# ---------------------------------------------------------------------------
# Stage 2 — Production runtime (Express API + served React PWA)
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
RUN apk add --no-cache postgresql-client imagemagick imagemagick-jpeg qpdf
WORKDIR /usr/src/app

# Install only production API deps first (better layer caching)
COPY app/package*.json ./
RUN npm ci --omit=dev

# Copy API source (node_modules excluded via .dockerignore)
COPY app/ ./

# Overwrite the placeholder public/ with the real built frontend
COPY --from=client-build /client-dist ./public

EXPOSE 3022
CMD ["node", "server.js"]
