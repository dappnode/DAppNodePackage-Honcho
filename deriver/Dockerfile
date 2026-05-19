ARG UPSTREAM_VERSION

FROM python:3.13-slim-bookworm AS source

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

ARG UPSTREAM_VERSION
WORKDIR /src
RUN git clone --depth 1 --branch ${UPSTREAM_VERSION} \
    https://github.com/plastic-labs/honcho.git . \
    || git clone --depth 1 https://github.com/plastic-labs/honcho.git .

# ── Build ──────────────────────────────────────────────────────
FROM python:3.13-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.9.24 /uv /bin/uv

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client libpq5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Copy source from clone
COPY --from=source /src/uv.lock /src/pyproject.toml /app/
RUN uv sync --frozen --no-install-project --no-group dev

COPY --from=source /src /app/
RUN uv sync --frozen --no-group dev

ENV PATH="/app/.venv/bin:$PATH"
ENV HOME=/app

RUN mkdir -p /backup /config

COPY entrypoint.sh /app/dappnode-entrypoint.sh
RUN chmod +x /app/dappnode-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["sh", "/app/dappnode-entrypoint.sh"]
