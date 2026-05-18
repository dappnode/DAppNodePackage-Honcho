ARG UPSTREAM_VERSION

FROM python:3.12-slim

ARG UPSTREAM_VERSION

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential postgresql-client libpq5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone upstream Honcho at pinned tag (fall back to main)
RUN git clone --depth 1 --branch ${UPSTREAM_VERSION} \
    https://github.com/plastic-labs/honcho.git . \
    || git clone --depth 1 https://github.com/plastic-labs/honcho.git .

# Install dependencies
ENV UV_LINK_MODE=copy
RUN uv sync --frozen --no-dev 2>/dev/null || uv sync --no-dev

# Activate venv via PATH
ENV PATH="/app/.venv/bin:$PATH"
ENV VIRTUAL_ENV="/app/.venv"

RUN mkdir -p /backup /config

COPY entrypoint.sh /app/dappnode-entrypoint.sh
RUN chmod +x /app/dappnode-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["sh", "/app/dappnode-entrypoint.sh"]
