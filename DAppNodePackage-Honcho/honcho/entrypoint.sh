#!/bin/sh
set -e

ROLE="${HONCHO_ROLE:-api}"

echo "=== Honcho Dappnode — ${ROLE} ==="

# ── 1. Resolve LLM provider into vllm slot env vars ──────────
# honcho-self-hosted routes ALL workers through the "vllm" transport.
# The config.toml (from honcho-self-hosted overlay) reads these env vars:
#   LLM_VLLM_API_KEY    — API key for the provider
#   LLM_VLLM_BASE_URL   — OpenAI-compatible base URL
#   LLM_OPENAI_API_KEY   — needed for client init + embeddings
#   LLM_EMBEDDING_API_KEY — embeddings key
#
# Our setup wizard sets: LLM_PROVIDER, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL

case "${LLM_PROVIDER}" in
  local_ollama)
    export LLM_VLLM_BASE_URL="http://ollama.dappnode:11434/v1"
    export LLM_VLLM_API_KEY="ollama"
    echo "[LLM] Provider: Local Ollama at ${LLM_VLLM_BASE_URL}"
    ;;
  openrouter)
    export LLM_VLLM_BASE_URL="https://openrouter.ai/api/v1"
    export LLM_VLLM_API_KEY="${LLM_API_KEY}"
    echo "[LLM] Provider: OpenRouter"
    ;;
  openai)
    export LLM_VLLM_BASE_URL="https://api.openai.com/v1"
    export LLM_VLLM_API_KEY="${LLM_API_KEY}"
    echo "[LLM] Provider: OpenAI"
    ;;
  anthropic)
    export LLM_VLLM_BASE_URL="https://api.anthropic.com/v1"
    export LLM_VLLM_API_KEY="${LLM_API_KEY}"
    echo "[LLM] Provider: Anthropic"
    ;;
  custom)
    export LLM_VLLM_BASE_URL="${LLM_BASE_URL}"
    export LLM_VLLM_API_KEY="${LLM_API_KEY:-none}"
    echo "[LLM] Provider: Custom at ${LLM_VLLM_BASE_URL}"
    ;;
  *)
    echo "[LLM] WARNING: Unknown provider '${LLM_PROVIDER}', defaulting to local_ollama"
    export LLM_VLLM_BASE_URL="http://ollama.dappnode:11434/v1"
    export LLM_VLLM_API_KEY="ollama"
    ;;
esac

# These are required by honcho-self-hosted's env.example pattern
export LLM_OPENAI_API_KEY="${LLM_VLLM_API_KEY}"
export LLM_OPENAI_COMPATIBLE_API_KEY="${LLM_VLLM_API_KEY}"
export LLM_EMBEDDING_API_KEY="${LLM_VLLM_API_KEY}"

# Auth disabled — internal Dappnode network only
export AUTH_USE_AUTH=false

echo "[LLM] Model: ${LLM_MODEL:-default}"

# ── 2. Override model names in config.toml if LLM_MODEL is set ─
# The honcho-self-hosted config.toml has placeholder model names.
# If the user specified a model in the wizard, override them.
if [ -n "${LLM_MODEL}" ] && [ -f /app/config.toml ]; then
  # Use sed to replace model names in all worker sections
  sed -i "s|model = \".*\"|model = \"${LLM_MODEL}\"|g" /app/config.toml
  echo "[Config] Updated config.toml model to: ${LLM_MODEL}"
fi

# ── 3. Role-based startup ────────────────────────────────────
if [ "${ROLE}" = "api" ]; then

  # Wait for PostgreSQL
  echo "[DB] Waiting for PostgreSQL ..."
  until pg_isready -h database -U honcho -q 2>/dev/null; do
    sleep 2
  done
  echo "[DB] PostgreSQL is ready."

  # Backup existing data (if any) for Dappnode backup button
  pg_dump -h database -U honcho -d honcho --clean --if-exists \
    -f /backup/honcho.sql 2>/dev/null || \
    echo "[Backup] No existing data to dump (first boot)."

  # Run migrations
  echo "[Migrations] Running ..."
  cd /app
  python -m alembic upgrade head 2>&1 || \
    echo "[Migrations] Alembic failed — may already be up to date."
  echo "[Migrations] Done."

  # Start API
  echo "[Server] Starting Honcho API on :8000 ..."
  exec uvicorn src.main:app \
    --host 0.0.0.0 \
    --port 8000 \
    --workers 1

elif [ "${ROLE}" = "deriver" ]; then

  # Brief wait for API to come up first
  sleep 5

  echo "[Deriver] Starting background worker ..."
  exec python -m src.deriver

else
  echo "[ERROR] Unknown HONCHO_ROLE: ${ROLE}"
  exit 1
fi
