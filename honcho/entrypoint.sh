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

# ── 2. Rewrite config.toml for single-provider Dappnode mode ──
# The honcho-self-hosted config.toml has hardcoded model names for
# OpenRouter/xAI/Venice across 12+ fields. In Dappnode, the user picks
# ONE provider and ONE model via the setup wizard. We rewrite everything
# to point at that single provider + model.
if [ -f /app/config.toml ]; then

  # 2a. Replace ALL model references (primary, backup, deduction, induction)
  #     TOML keys are uppercase: MODEL, BACKUP_MODEL, DEDUCTION_MODEL, INDUCTION_MODEL
  if [ -n "${LLM_MODEL}" ]; then
    sed -i "s|^MODEL = \".*\"|MODEL = \"${LLM_MODEL}\"|g" /app/config.toml
    sed -i "s|^BACKUP_MODEL = \".*\"|BACKUP_MODEL = \"${LLM_MODEL}\"|g" /app/config.toml
    sed -i "s|^DEDUCTION_MODEL = \".*\"|DEDUCTION_MODEL = \"${LLM_MODEL}\"|g" /app/config.toml
    sed -i "s|^INDUCTION_MODEL = \".*\"|INDUCTION_MODEL = \"${LLM_MODEL}\"|g" /app/config.toml
    echo "[Config] All model references set to: ${LLM_MODEL}"
  fi

  # 2b. Point the backup provider at the SAME endpoint as primary
  #     (Dappnode uses one provider — no Venice/OpenRouter fallback)
  sed -i "s|^BACKUP_PROVIDER = \".*\"|BACKUP_PROVIDER = \"vllm\"|g" /app/config.toml
  echo "[Config] Backup provider set to same as primary (vllm)"

  # 2c. Override the hardcoded Venice backup base URL
  sed -i "s|^OPENAI_COMPATIBLE_BASE_URL = \".*\"|OPENAI_COMPATIBLE_BASE_URL = \"${LLM_VLLM_BASE_URL}\"|g" /app/config.toml
  echo "[Config] Backup base URL set to: ${LLM_VLLM_BASE_URL}"

  # 2d. Set embedding provider to vllm (same endpoint)
  sed -i "s|^EMBEDDING_PROVIDER = \".*\"|EMBEDDING_PROVIDER = \"vllm\"|g" /app/config.toml

  echo "[Config] config.toml rewritten for single-provider Dappnode mode"
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
