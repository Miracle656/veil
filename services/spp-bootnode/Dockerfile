# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy manifests first so npm ci can be cached independently.
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# better-sqlite3 uses native bindings compiled for the build platform.
# node:20-slim is Debian-based; the prod image must match the builder OS.
WORKDIR /app

# Create the data directory for SQLite.
RUN mkdir -p /app/data && chown node:node /app/data

COPY package.json package-lock.json* ./
# Install production deps only (no devDeps).
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

USER node

ENV NODE_ENV=production
ENV DB_PATH=/app/data/bootnode.db
ENV PORT=3002

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
