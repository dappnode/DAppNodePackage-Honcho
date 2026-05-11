# DAppNodePackage-honcho

Self-sovereign AI memory layer for Dappnode — packages [Honcho](https://github.com/plastic-labs/honcho) using the community-proven [honcho-self-hosted](https://github.com/elkimek/honcho-self-hosted) configuration.

## How it works

This package uses upstream Honcho source code with the `honcho-self-hosted` config overlay. All LLM calls are routed through Honcho's `vllm` transport slot, which accepts any OpenAI-compatible endpoint (Ollama, OpenRouter, OpenAI, Anthropic, vLLM, etc.).

No fork, no code changes — just config files on top of upstream Honcho.

## Internal endpoint

```
http://honcho.dappnode:8000
```

## Setup Wizard UI

```
http://setup-wizard.honcho.dappnode:8080
```

## LLM Providers

| Option | Description | API key needed |
|--------|-------------|----------------|
| `local_ollama` | Uses your Dappnode Ollama package | No |
| `openrouter` | 200+ models via OpenRouter | Yes |
| `openai` | OpenAI API | Yes |
| `anthropic` | Anthropic API | Yes |
| `custom` | Any OpenAI-compatible endpoint | Optional |

## Backup

Use the **Backup** button in the Dappnode admin UI. It bundles a PostgreSQL dump of all memory data.

## Development

```bash
git clone https://github.com/dappnode/DAppNodePackage-honcho
cd DAppNodePackage-honcho
npx @dappnode/dappnodesdk build
```

## Upstream

- **Honcho**: https://github.com/plastic-labs/honcho (AGPL-3.0)
- **honcho-self-hosted**: https://github.com/elkimek/honcho-self-hosted (GPL-3.0)
- **Docs**: https://docs.honcho.dev
