# polibrief — container image (works on x64 and ARM64/Raspberry Pi).
#
# Build (on the Pi or with buildx):   docker build -f docker/Dockerfile -t polibrief:1.0.0 .

FROM node:20-slim

WORKDIR /app

# Install dependencies first so Docker caches this layer between code changes.
# better-sqlite3 doesn't always have a prebuilt binary for the image's exact
# Node/ARM64 combination, so install a small compiler toolchain, build, then
# remove the toolchain again to keep the final image lean.
COPY package.json package-lock.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# App code + default config (the live watchlist/.env are seeded into /data on first boot).
COPY src ./src
COPY scripts ./scripts
COPY watchlist.json registry.json .env.example ./

# All mutable data (SQLite DB, briefings, editable watchlist + .env) lives on the volume.
ENV POLIBRIEF_DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 8484

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://localhost:8484/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Web UI + built-in am/pm scheduler — no cron needed inside the container.
CMD ["node", "src/index.js", "serve", "--port", "8484"]
