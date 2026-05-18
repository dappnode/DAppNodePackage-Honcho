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

1. Install the Honcho package from the Dappnode admin UI
2. Open the **Setup Wizard** at `http://setup-wizard.honcho.dappnode:8080`
3. Pick your AI provider and enter your API key and model
4. Restart the Honcho package to apply the configuration

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
