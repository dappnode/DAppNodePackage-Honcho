#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 8080;
const CONFIG_DIR = process.env.HONCHO_CONFIG_DIR || "/config";
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const CONFIG_TOML_FILE = path.join(CONFIG_DIR, "config.toml");
const TEMPLATE_TOML = process.env.TEMPLATE_TOML || "/app/config-template.toml";
const HTML_FILE = path.join(__dirname, "index.html");

// Honcho API inside the Docker network
const HONCHO_API = "http://api:8000";

// Ollama candidates on Dappnode
const OLLAMA_CANDIDATES = [
  "http://ollama.ollama-nvidia-openwebui.dappnode:11434",
  "http://ollama.ollama-amd-openwebui.dappnode:11434",
  "http://ollama.ollama-cpu-openwebui.dappnode:11434",
  "http://ollama.dappnode:11434",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseEnvFile(content) {
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    env[key] = val;
  }
  return env;
}

function serializeEnv(env) {
  // Preserve existing lines/comments, update known keys, append new ones
  let lines = [];
  const written = new Set();
  try {
    const existing = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of existing.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) { lines.push(line); continue; }
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) { lines.push(line); continue; }
      const key = trimmed.slice(0, eqIdx).trim();
      if (key in env) { lines.push(`${key}=${env[key]}`); written.add(key); }
      else { lines.push(line); }
    }
  } catch { /* no existing file */ }
  for (const [key, val] of Object.entries(env)) {
    if (!written.has(key)) lines.push(`${key}=${val}`);
  }
  return lines.join("\n");
}

function readEnv() {
  try { return parseEnvFile(fs.readFileSync(ENV_FILE, "utf-8")); }
  catch { return {}; }
}

function readConfigToml() {
  try { return fs.readFileSync(CONFIG_TOML_FILE, "utf-8"); }
  catch {
    // Fall back to template
    try { return fs.readFileSync(TEMPLATE_TOML, "utf-8"); }
    catch { return ""; }
  }
}

/**
 * Rewrite config.toml for single-provider mode.
 * Sets all MODEL, BACKUP_MODEL, DEDUCTION_MODEL, INDUCTION_MODEL to the chosen model.
 * Sets BACKUP_PROVIDER to "vllm" (same as primary).
 * Sets OPENAI_COMPATIBLE_BASE_URL to the primary base URL.
 * EMBEDDING_PROVIDER stays as "openrouter" (valid Pydantic Literal).
 */
function rewriteConfigToml(toml, model, baseUrl) {
  let result = toml;
  if (model) {
    result = result.replace(/^MODEL = ".*"/gm, `MODEL = "${model}"`);
    result = result.replace(/^BACKUP_MODEL = ".*"/gm, `BACKUP_MODEL = "${model}"`);
    result = result.replace(/^DEDUCTION_MODEL = ".*"/gm, `DEDUCTION_MODEL = "${model}"`);
    result = result.replace(/^INDUCTION_MODEL = ".*"/gm, `INDUCTION_MODEL = "${model}"`);
  }
  // Single provider mode: backup = same as primary
  result = result.replace(/^BACKUP_PROVIDER = ".*"/gm, 'BACKUP_PROVIDER = "vllm"');
  if (baseUrl) {
    result = result.replace(/^OPENAI_COMPATIBLE_BASE_URL = ".*"/gm, `OPENAI_COMPATIBLE_BASE_URL = "${baseUrl}"`);
  }
  // EMBEDDING_PROVIDER must stay as openai|gemini|openrouter — keep "openrouter"
  return result;
}

async function probeOllama() {
  for (const url of OLLAMA_CANDIDATES) {
    try {
      const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json();
        const models = (data.models || []).map((m) => m.name);
        return { reachable: true, url, models };
      }
    } catch {}
  }
  return { reachable: false, url: null, models: [] };
}

// In-memory cache for OpenRouter models
let orCache = { models: [], ts: 0 };
const CACHE_TTL = 6 * 60 * 60 * 1000;

async function fetchOpenRouterModels() {
  const now = Date.now();
  if (orCache.models.length && (now - orCache.ts) < CACHE_TTL) return orCache.models;
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return orCache.models;
    const data = await resp.json();
    const models = (data.data || [])
      .filter((m) => m.id && !m.id.includes(":free"))
      .map((m) => ({ id: m.id, name: m.name || m.id, context_length: m.context_length || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    orCache = { models, ts: now };
    return models;
  } catch { return orCache.models; }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Serve HTML ──
  if (req.method === "GET" && url.pathname === "/") {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(HTML_FILE, "utf-8"));
    } catch { res.writeHead(500); res.end("Failed to load page"); }
    return;
  }

  // ── Read current config ──
  if (req.method === "GET" && url.pathname === "/api/config") {
    json(res, 200, { env: readEnv(), configToml: readConfigToml() });
    return;
  }

  // ── Save config ──
  if (req.method === "POST" && url.pathname === "/api/config") {
    try {
      const body = JSON.parse(await readBody(req));
      fs.mkdirSync(CONFIG_DIR, { recursive: true });

      // 1. Write .env
      if (body.env && typeof body.env === "object") {
        const current = readEnv();
        const merged = Object.assign(current, body.env);
        fs.writeFileSync(ENV_FILE, serializeEnv(merged), "utf-8");
      }

      // 2. Rewrite config.toml with model + base URL
      const model = body.model || (body.env && body.env.LLM_MODEL) || null;
      const baseUrl = body.baseUrl || (body.env && body.env.LLM_VLLM_BASE_URL) || null;
      let toml = readConfigToml();
      if (toml) {
        toml = rewriteConfigToml(toml, model, baseUrl);
        fs.writeFileSync(CONFIG_TOML_FILE, toml, "utf-8");
      }

      json(res, 200, { ok: true, message: "Configuration saved. Restart Honcho services to apply." });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  // ── Probe Ollama ──
  if (req.method === "GET" && url.pathname === "/api/ollama/probe") {
    json(res, 200, await probeOllama());
    return;
  }

  // ── OpenRouter models ──
  if (req.method === "GET" && url.pathname === "/api/models/openrouter") {
    json(res, 200, { models: await fetchOpenRouterModels() });
    return;
  }

  // ── Health check (proxy to Honcho API) ──
  if (req.method === "GET" && url.pathname === "/api/health") {
    try {
      const resp = await fetch(`${HONCHO_API}/health`, { signal: AbortSignal.timeout(5000) });
      const data = await resp.json();
      json(res, 200, { apiServer: true, ...data });
    } catch {
      json(res, 200, { apiServer: false });
    }
    return;
  }

  // ── Restart (kill PID 1 — Docker restart policy brings it back) ──
  if (req.method === "POST" && url.pathname === "/api/restart") {
    json(res, 200, { ok: true, message: "Restart signal sent." });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Honcho Setup Wizard running at http://0.0.0.0:${PORT}`);
});
