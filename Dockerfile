FROM node:22.22.2-bookworm-slim AS frontend

WORKDIR /app/apps/desktop

COPY apps/desktop/package.json apps/desktop/package-lock.json ./
COPY apps/desktop/vendor/brace-expansion-compat ./vendor/brace-expansion-compat
RUN npm ci

COPY apps/desktop/ ./
RUN npm run build

FROM rust:1.95.0-bookworm AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates build-essential pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

COPY . .
COPY --from=frontend /app/apps/desktop/out /app/apps/desktop/out
RUN cargo build --locked --release -p fnzero-safe-desktop-api

FROM debian:bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 fnzero-safe \
  && useradd --uid 10001 --gid 10001 --home-dir /app --no-create-home --no-log-init --shell /usr/sbin/nologin fnzero-safe \
  && install -d -o 10001 -g 10001 /app/data

COPY --from=builder /app/build-cache-fnzsafe/release/fnzero-safe-desktop-api /usr/local/bin/fnzero-safe-desktop-api

# The wallet API is intentionally local-only. Run with host networking when a
# container is required; publishing this loopback port with -p will not work.
ENV HOST=127.0.0.1
ENV PORT=3841
ENV FNZERO_SAFE_DB_PATH=/app/data/fnzero-safe.sqlite3

VOLUME ["/app/data"]

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:3841/api/health >/dev/null || exit 1

CMD ["fnzero-safe-desktop-api"]
