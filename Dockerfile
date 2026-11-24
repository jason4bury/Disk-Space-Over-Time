# Disk Space Over Time v1.00. Build with: docker build -t jason4bury/disk-space-over-time:1.00 .
# Node.js is pinned to an exact version so every build is the same; bump it here on purpose.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

# --- Build stage: install production dependencies from package-lock.json ---
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=optional skips ssh2's optional native speed-ups, so no build tools are needed.
RUN npm ci --omit=dev --omit=optional

# --- Runtime stage ---
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Disk Space Over Time" \
      org.opencontainers.image.description="Records the free space on your NAS or PC drives every day and charts it, so you can see when a drive is filling up" \
      org.opencontainers.image.version="1.00" \
      org.opencontainers.image.source="https://github.com/jason4bury/Disk-Space-Over-Time" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Jason Rhodes"
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3060

# The readings, the drives added in Settings and the SSH key.
ENV DATA_DIR=/data
# Drives on this machine are mounted read-only in folders under here (see docker-compose.yml).
ENV DRIVES_ROOT=/drives
VOLUME ["/data"]

# Backs Docker's own health status with GET /healthz, using Node itself (the slim image has no curl).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3060)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
