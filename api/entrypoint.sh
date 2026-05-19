#!/bin/sh
set -e

ROLE="${HONCHO_ROLE:-api}"
CONFIG_DIR="${HONCHO_CONFIG_DIR:-/config}"
ENV_FILE="${CONFIG_DIR}/.env"

echo "=== Honcho Dappnode — ${ROLE} ==="

# ── 1. Load env vars from shared .env (written by setup wizard) ───
if [ -f "${ENV_FILE}" ]; then
  echo "[Config] Loading ${ENV_FILE}"
  set -a
  . "${ENV_FILE}"
  set +a
fi

# ── 2. Resolve provider settings ─────────────────────────────────
# The setup wizard writes: LLM_VLLM_API_KEY, LLM_VLLM_BASE_URL, LLM_MODEL
#
# Upstream v3.0.6 uses per-component env vars with SupportedProviders:
#   "custom" provider → reads LLM_OPENAI_COMPATIBLE_BASE_URL + LLM_OPENAI_COMPATIBLE_API_KEY
#   Each worker needs: DERIVER_PROVIDER, DERIVER_MODEL, etc.
#   Dialectic needs: DIALECTIC_LEVELS__minimal__PROVIDER, DIALECTIC_LEVELS__minimal__MODEL, etc.

API_KEY="${LLM_VLLM_API_KEY:-${LLM_OPENAI_COMPATIBLE_API_KEY:-}}"
BASE_URL="${LLM_VLLM_BASE_URL:-${LLM_OPENAI_COMPATIBLE_BASE_URL:-}}"
MODEL="${LLM_MODEL:-}"

echo "[LLM] Base URL: ${BASE_URL:-not set}"
echo "[LLM] Model: ${MODEL:-not set}"

# ── 3. Placeholder for first boot (no wizard config yet) ─────────
if [ -z "${API_KEY}" ]; then
  echo "[Config] WARNING: No LLM provider configured."
  echo "[Config] Open http://setup-wizard.honcho.dappnode:8080 to configure."
  API_KEY="not-configured"
  BASE_URL="https://localhost:9999"
  MODEL="placeholder"
fi

# ── 4. Export upstream Honcho env vars ────────────────────────────
# These are the exact var names from .env.template v3.0.6

# Custom provider endpoint (any OpenAI-compatible API)
export LLM_OPENAI_COMPATIBLE_BASE_URL="${BASE_URL}"
export LLM_OPENAI_COMPATIBLE_API_KEY="${API_KEY}"

# Embedding provider — route through same endpoint via "openrouter"
# (openrouter is a valid Literal for EMBEDDING_PROVIDER and uses
# the openai-compatible path internally)
export LLM_EMBEDDING_PROVIDER="openrouter"

# Also set the direct provider keys so clients.py can init
export LLM_OPENAI_API_KEY="${API_KEY}"

# Auth disabled — internal Dappnode network only
export AUTH_USE_AUTH=false

# ── 5. Set per-worker provider + model via env vars ───────────────
# Deriver
export DERIVER_PROVIDER="custom"
export DERIVER_MODEL="${MODEL}"

# Summary
export SUMMARY_PROVIDER="custom"
export SUMMARY_MODEL="${MODEL}"

# Dream
export DREAM_PROVIDER="custom"
export DREAM_MODEL="${MODEL}"
export DREAM_DEDUCTION_MODEL="${MODEL}"
export DREAM_INDUCTION_MODEL="${MODEL}"

# Dialectic — all 5 levels, each needs PROVIDER + MODEL + THINKING_BUDGET_TOKENS
export DIALECTIC_LEVELS__minimal__PROVIDER="custom"
export DIALECTIC_LEVELS__minimal__MODEL="${MODEL}"
export DIALECTIC_LEVELS__minimal__THINKING_BUDGET_TOKENS=0
export DIALECTIC_LEVELS__minimal__MAX_TOOL_ITERATIONS=1
export DIALECTIC_LEVELS__minimal__MAX_OUTPUT_TOKENS=250

export DIALECTIC_LEVELS__low__PROVIDER="custom"
export DIALECTIC_LEVELS__low__MODEL="${MODEL}"
export DIALECTIC_LEVELS__low__THINKING_BUDGET_TOKENS=0
export DIALECTIC_LEVELS__low__MAX_TOOL_ITERATIONS=5

export DIALECTIC_LEVELS__medium__PROVIDER="custom"
export DIALECTIC_LEVELS__medium__MODEL="${MODEL}"
export DIALECTIC_LEVELS__medium__THINKING_BUDGET_TOKENS=0
export DIALECTIC_LEVELS__medium__MAX_TOOL_ITERATIONS=2

export DIALECTIC_LEVELS__high__PROVIDER="custom"
export DIALECTIC_LEVELS__high__MODEL="${MODEL}"
export DIALECTIC_LEVELS__high__THINKING_BUDGET_TOKENS=0
export DIALECTIC_LEVELS__high__MAX_TOOL_ITERATIONS=4

export DIALECTIC_LEVELS__max__PROVIDER="custom"
export DIALECTIC_LEVELS__max__MODEL="${MODEL}"
export DIALECTIC_LEVELS__max__THINKING_BUDGET_TOKENS=0
export DIALECTIC_LEVELS__max__MAX_TOOL_ITERATIONS=10

echo "[Config] All workers set to: custom / ${MODEL}"

# ── 6. Role-based startup ────────────────────────────────────────
if [ "${ROLE}" = "api" ]; then

  echo "[DB] Waiting for PostgreSQL ..."
  until pg_isready -h database -U honcho -q 2>/dev/null; do
    sleep 2
  done
  echo "[DB] PostgreSQL is ready."

  # Backup dump for Dappnode backup button
  pg_dump -h database -U honcho -d honcho --clean --if-exists \
    -f /backup/honcho.sql 2>/dev/null || \
    echo "[Backup] No existing data to dump (first boot)."

  # Run migrations via upstream's provision script
  echo "[Migrations] Running ..."
  cd /app
  python scripts/provision_db.py 2>&1 || \
    echo "[Migrations] provision_db.py failed — may already be up to date."
  echo "[Migrations] Done."

  echo "[Server] Starting Honcho API on :8000 ..."
  exec fastapi run --host 0.0.0.0 src/main.py

elif [ "${ROLE}" = "deriver" ]; then

  sleep 5
  echo "[Deriver] Starting background worker ..."
  exec python -m src.deriver

else
  echo "[ERROR] Unknown HONCHO_ROLE: ${ROLE}"
  exit 1
fi
