ARG UPSTREAM_VERSION

# ── Stage 1: Clone upstream Honcho source ─────────────────────
FROM python:3.12-slim AS source

ARG UPSTREAM_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Clone upstream Honcho at pinned tag (fall back to main)
RUN git clone --depth 1 --branch ${UPSTREAM_VERSION} \
    https://github.com/plastic-labs/honcho.git . \
    || git clone --depth 1 https://github.com/plastic-labs/honcho.git .

# Clone honcho-self-hosted config overlay
RUN git clone --depth 1 \
    https://github.com/elkimek/honcho-self-hosted.git /overlay

# Overlay the proven config.toml from honcho-self-hosted
# This routes ALL workers through the "vllm" transport slot
# and prevents the "Missing client for Summary: google" error
RUN cp /overlay/config.toml /src/config.toml

# ── Stage 2: Build using upstream Honcho's own Dockerfile ─────
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    postgresql-client \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=source /src /app

# Install dependencies
ENV UV_LINK_MODE=copy
RUN uv sync --frozen --no-dev 2>/dev/null || uv sync --no-dev

# Activate venv via PATH (avoids broken shebang issues from multi-stage)
ENV PATH="/app/.venv/bin:$PATH"
ENV VIRTUAL_ENV="/app/.venv"

# Create backup output directory
RUN mkdir -p /backup

COPY entrypoint.sh /app/dappnode-entrypoint.sh
RUN chmod +x /app/dappnode-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["sh", "/app/dappnode-entrypoint.sh"]
