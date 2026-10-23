# Honcho Memory Layer — Dappnode Package

Self-sovereign AI memory layer for Dappnode. Packages [Honcho](https://github.com/plastic-labs/honcho) by Plastic Labs as a fully self-hosted Dappnode service.

## What Honcho does

Honcho gives your AI agents (Hermes, OpenClaw, or any custom agent) persistent, reasoning-backed memory that survives across sessions. Rather than simple key-value storage, Honcho continually learns from conversations using four background workers:

| Worker | What it does | When it runs |
|--------|-------------|--------------|
| **Deriver** | Extracts observations and conclusions from messages | After each message |
| **Dialectic** | Answers natural-language questions about users from stored memory | On demand (5 reasoning levels) |
| **Summary** | Compresses long sessions into concise context | On session compaction |
| **Dream** | Consolidates, deduplicates, and refines stored observations | Periodically in the background |

All workers share the single LLM provider you configure in the Setup Wizard.

## Getting started

1. Install Honcho from the Dappnode admin UI and choose a **Honcho wizard password** in the installation form. Use a password manager to generate and save a strong password of 12–128 printable ASCII characters.
2. If upgrading an existing installation, set `HONCHO_WIZARD_PASSWORD` for **setup-wizard** in Honcho's **Config** tab, then restart that service.
3. Open the **Setup Wizard** at `http://setup-wizard.honcho.dappnode:8080` over your Dappnode VPN and unlock it with that password.
4. Pick your AI provider and enter your API key and model.
5. Restart the Honcho package to apply the provider configuration.

## Setup Wizard access and migration

The Dappnode installation form requires a separate wizard password. It is supplied as `HONCHO_WIZARD_PASSWORD` **only to the setup-wizard service**, and is never written into the shared provider `.env` or returned by a configuration read. The wizard fails startup with an actionable Config message if the password is missing or invalid. There is no default password or unauthenticated first-visitor registration.

Unlocking exchanges the password for a random, server-side session lasting at most eight hours. The browser keeps only that session token in tab memory; locking or reloading requires unlocking again. Locking requests server-side revocation of the current session. All sessions are invalidated when the wizard restarts. Passwords and sessions are never printed in service logs, placed in URLs or persisted by the UI in cookies, localStorage or sessionStorage; your browser's password manager can save the password normally.

Login attempts are limited to ten per minute across this wizard, including successful attempts. Established sessions remain usable during a login cooldown. Up to 32 sessions are retained; creating another revokes the oldest. All authenticated API routes reject expired or revoked sessions.

To change or recover the wizard password, update `HONCHO_WIZARD_PASSWORD` in the package's **Config** tab and restart **setup-wizard**. You do not need SSH. Existing provider configuration remains unchanged. If upgrading from the earlier token-based development build, its old token is no longer accepted and its auth volume is no longer mounted or used. No credential files or provider data are automatically deleted.

Dappnode manages the password as a service environment setting, visible to trusted host administrators through package configuration and Docker inspection. It is not encrypted in a separate wizard credential vault. Save it in your password manager and set it again when restoring onto another installation; the provider-configuration backup does not include it. API and deriver services do not receive this setting.

The wizard no longer publishes host port 8080. Its existing Dappnode DNS address and container port remain available through Dappnode's private network. Authentication does not encrypt HTTP: use the trusted Dappnode VPN, or configure a trusted HTTPS reverse proxy. Do not expose the raw wizard over the internet or an untrusted LAN.

The default accepted origin/host is `http://setup-wizard.honcho.dappnode:8080`. An administrator using a different HTTPS address must set `HONCHO_WIZARD_ORIGINS` to the exact origin (or comma-separated exact origins) and configure the proxy to preserve that `Host`. Wildcards, arbitrary forwarded headers and cross-site browser requests are not trusted. There is no wildcard CORS access.

Existing `.env` configuration and provider keys are retained on upgrade. Saved keys are never returned to the browser, even after unlocking. Blank or fully masked secret fields keep existing keys; enter a replacement or explicitly select **Clear all saved provider keys** to erase them. Changing an endpoint while keys are saved requires an explicit replacement or clearing decision, to avoid sending an old provider's key to a new destination. Legacy URLs containing embedded credentials, queries or invalid syntax are withheld from the browser and listed by field name in `invalidPublicFields`; replace them with a clean URL and put the key in its dedicated field.

This protects the **Setup Wizard**, not the separate Honcho memory API. The API still listens on port 8000 with authentication disabled by the upstream package entrypoint; it requires a separate access-control review. Keep that endpoint on a trusted network as well.

## Endpoint

Other Dappnode packages (like Hermes) reach Honcho at:

```
http://honcho.dappnode:8000
```

### Supported providers

| Provider | Description | API key required |
|----------|-------------|-----------------|
| **Dappnode Nexus** | Private AI gateway — prompts never logged or stored | Yes |
| **OpenRouter** | 200+ models with one API key, live model search | Yes |
| **OpenAI** | GPT-4.1, GPT-5, o4-mini | Yes |
| **Anthropic** | Claude Opus, Sonnet, Haiku | Yes |
| **Ollama (Local)** | Run models on your Dappnode — free and private | No |
| **Groq** | Ultra-fast inference with free tier | Yes |
| **DeepSeek** | V3.2 and R1 reasoning models | Yes |
| **Custom** | Any OpenAI-compatible endpoint | Optional |

The wizard auto-detects Ollama instances running on your Dappnode and fetches available models from OpenRouter in real time.

## Backup and restore

The Dappnode admin UI provides a **Backup** button for this package. It bundles:

- **honcho-db-dump** — full PostgreSQL dump of all memory data
- **honcho-llm-config** — LLM provider configuration (.env file)

Restore by uploading a previously downloaded tarball in the same admin UI.

## Volumes

| Volume | Contents |
|--------|----------|
| `honcho-config` | Shared config volume (.env written by wizard, read by api + deriver) |
| `honcho-db-data` | PostgreSQL data (memories, sessions, observations, conclusions) |
| `honcho-redis-data` | Redis queue and cache |
| `honcho-backup` | On-demand backup output |

Resetting the package stops all containers but does **not** delete volumes. To permanently erase all stored memories, remove `honcho-db-data` from the Dappnode volume manager.

## Connecting Hermes

Point the Hermes Dappnode package at `http://honcho.dappnode:8000`. The Honcho setup skill bundled with Hermes handles this automatically.

## Upstream

- **Honcho**: [plastic-labs/honcho](https://github.com/plastic-labs/honcho) (AGPL-3.0)
- **Docs**: [docs.honcho.dev](https://docs.honcho.dev)
- **Evals**: [evals.honcho.dev](https://evals.honcho.dev)

## Wizard regression tests

```sh
cd setup-wizard
npm ci --ignore-scripts
npm test
```

Tests use synthetic keys, temporary directories, loopback HTTP and stubbed provider responses. They cover password login, session expiry/revocation, login rate limits, redaction, explicit secret updates, origin/host checks, request limits, shell/TOML input safety, and the browser DOM unlock/edit/clear flows. No production provider or database is used. Test dependencies are not installed in the runtime image.
