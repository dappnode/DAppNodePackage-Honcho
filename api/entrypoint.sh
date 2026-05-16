#!/bin/sh
set -e

ROLE="${HONCHO_ROLE:-api}"
CONFIG_DIR="${HONCHO_CONFIG_DIR:-/config}"
ENV_FILE="${CONFIG_DIR}/.env"
CONFIG_TOML="${CONFIG_DIR}/config.toml"

echo "=== Honcho Dappnode — ${ROLE} ==="

# ── 1. Seed config.toml into shared volume if not present ─────
# On first boot, copy the baked-in honcho-self-hosted config.toml
# to the shared volume so the setup wizard can read/write it.
if [ ! -f "${CONFIG_TOML}" ]; then
  mkdir -p "${CONFIG_DIR}"
  if [ -f /app/config.toml ]; then
    cp /app/config.toml "${CONFIG_TOML}"
    echo "[Config] Seeded config.toml to shared volume"
  fi
fi

# ── 2. Load env vars from shared .env file ────────────────────
# The setup wizard writes LLM_VLLM_API_KEY, LLM_VLLM_BASE_URL,
# LLM_MODEL, etc. to this file. Export them into the process
# environment so Honcho reads them at import time.
if [ -f "${ENV_FILE}" ]; then
  echo "[Config] Loading env vars from ${ENV_FILE}"
  while IFS= read -r line; do
    # Skip comments and empty lines
    case "$line" in
      \#*|"") continue ;;
    esac
    # Export each KEY=VALUE pair
    key=$(echo "$line" | cut -d= -f1)
    val=$(echo "$line" | cut -d= -f2-)
    export "$key"="$val"
  done < "${ENV_FILE}"
fi

# ── 3. Rewrite config.toml for single-provider Dappnode mode ──
# The honcho-self-hosted config.toml has hardcoded model names for
# OpenRouter/xAI/Venice. Replace ALL model references + backup
# provider to use the single provider from the setup wizard.
if [ -f "${CONFIG_TOML}" ]; then
  MODEL="${LLM_MODEL:-}"
  BASE_URL="${LLM_VLLM_BASE_URL:-}"

  if [ -n "${MODEL}" ]; then
    sed -i "s|^MODEL = \".*\"|MODEL = \"${MODEL}\"|g" "${CONFIG_TOML}"
    sed -i "s|^BACKUP_MODEL = \".*\"|BACKUP_MODEL = \"${MODEL}\"|g" "${CONFIG_TOML}"
    sed -i "s|^DEDUCTION_MODEL = \".*\"|DEDUCTION_MODEL = \"${MODEL}\"|g" "${CONFIG_TOML}"
    sed -i "s|^INDUCTION_MODEL = \".*\"|INDUCTION_MODEL = \"${MODEL}\"|g" "${CONFIG_TOML}"
    echo "[Config] All model references set to: ${MODEL}"
  fi

  # Single provider mode: backup = same as primary
  sed -i "s|^BACKUP_PROVIDER = \".*\"|BACKUP_PROVIDER = \"vllm\"|g" "${CONFIG_TOML}"

  if [ -n "${BASE_URL}" ]; then
    sed -i "s|^OPENAI_COMPATIBLE_BASE_URL = \".*\"|OPENAI_COMPATIBLE_BASE_URL = \"${BASE_URL}\"|g" "${CONFIG_TOML}"
  fi

  # Copy rewritten config.toml into /app where Honcho reads it
  cp "${CONFIG_TOML}" /app/config.toml

  echo "[Config] config.toml applied to /app/config.toml"
fi

# ── 3b. Set placeholder values if no provider configured yet ──
# On first boot before the wizard runs, LLM vars are empty.
# Set placeholders so clients.py can initialize without crashing.
# Actual LLM calls will fail, but the API server will start.
if [ -z "${LLM_VLLM_API_KEY}" ]; then
  echo "[Config] WARNING: No LLM provider configured yet."
  echo "[Config] Run the Setup Wizard at http://setup-wizard.honcho.dappnode:8080"
  export LLM_VLLM_API_KEY="not-configured"
  export LLM_VLLM_BASE_URL="https://localhost:9999"
  export LLM_OPENAI_API_KEY="not-configured"
  export LLM_OPENAI_COMPATIBLE_API_KEY="not-configured"
  export LLM_EMBEDDING_API_KEY="not-configured"
fi

# ── 4. Ensure all Honcho env vars are exported ────────────────
# Even if the .env file was loaded above, make sure critical vars
# are set (they may come from docker-compose env or the wizard)
export AUTH_USE_AUTH=false
echo "[LLM] Base URL: ${LLM_VLLM_BASE_URL:-not set}"
echo "[LLM] Model: ${LLM_MODEL:-not set}"

# ── 5. Role-based startup ─────────────────────────────────────
if [ "${ROLE}" = "api" ]; then

  echo "[DB] Waiting for PostgreSQL ..."
  until pg_isready -h database -U honcho -q 2>/dev/null; do
    sleep 2
  done
  echo "[DB] PostgreSQL is ready."

  # On-demand backup dump for Dappnode backup button
  pg_dump -h database -U honcho -d honcho --clean --if-exists \
    -f /backup/honcho.sql 2>/dev/null || \
    echo "[Backup] No existing data to dump (first boot)."

  echo "[Migrations] Running ..."
  cd /app
  python -m alembic upgrade head 2>&1 || \
    echo "[Migrations] Alembic failed — may already be up to date."
  echo "[Migrations] Done."

  echo "[Server] Starting Honcho API on :8000 ..."
  exec uvicorn src.main:app \
    --host 0.0.0.0 \
    --port 8000 \
    --workers 1

elif [ "${ROLE}" = "deriver" ]; then

  sleep 5
  echo "[Deriver] Starting background worker ..."
  exec python -m src.deriver

else
  echo "[ERROR] Unknown HONCHO_ROLE: ${ROLE}"
  exit 1
fi
