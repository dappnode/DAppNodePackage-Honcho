#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SECRET_KEYS = ["LLM_VLLM_API_KEY", "LLM_OPENAI_API_KEY", "LLM_OPENAI_COMPATIBLE_API_KEY", "LLM_EMBEDDING_API_KEY"];
const URL_KEYS = ["LLM_VLLM_BASE_URL", "LLM_EMBEDDING_BASE_URL"];
const PUBLIC_KEYS = [...URL_KEYS, "LLM_MODEL"];
const ENV_KEYS = [...SECRET_KEYS, ...PUBLIC_KEYS];
const MAX_BODY = 16 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;
const LOGIN_WINDOW_MS = 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const DEFAULT_ORIGIN = "http://setup-wizard.honcho.dappnode:8080";
const OLLAMA_CANDIDATES = [
  "http://ollama.ollama-nvidia-openwebui.dappnode:11434",
  "http://ollama.ollama-amd-openwebui.dappnode:11434",
  "http://ollama.ollama-cpu-openwebui.dappnode:11434",
  "http://ollama.dappnode:11434",
];

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function parseEnvFile(content) {
  const env = Object.create(null);
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

// API/deriver source this file as shell code. New values must be literal, never shell expressions.
function serializeEnv(existing, updates) {
  const written = new Set();
  const lines = existing.split("\n").map(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.hasOwn(updates, match[1])) return line;
    written.add(match[1]);
    return `${match[1]}='${updates[match[1]]}'`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) lines.push(`${key}='${value}'`);
  }
  return lines.join("\n");
}

function readFile(file, fallback = "") {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

function atomicWrite(file, content) {
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function passwordDigest(password) {
  return crypto.createHash("sha256").update(password, "utf8").digest();
}

function loadPasswordDigest(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128 || /[^\x20-\x7e]/.test(password)) {
    throw new Error("Set HONCHO_WIZARD_PASSWORD to 12–128 printable ASCII characters in Honcho's Dappnode Config, then restart the setup-wizard service.");
  }
  // The configured password is managed by Dappnode, not written into the shared provider config.
  return passwordDigest(password);
}

function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw new RequestError(415, "Use application/json.");
  if (Number(req.headers["content-length"]) > MAX_BODY) throw new RequestError(413, "Request body too large.");
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new RequestError(413, "Request body too large.")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new RequestError(400, "Invalid JSON body.")); }
    });
    req.on("error", reject);
  });
}

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validateText(value, key, max = 2048) {
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f']/.test(value)) throw new RequestError(400, `Invalid ${key}.`);
  return value;
}
function validateValue(key, value) {
  validateText(value, key);
  if (key === "LLM_MODEL" && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value)) throw new RequestError(400, "Invalid model ID.");
  if (URL_KEYS.includes(key)) {
    let url;
    try { url = new URL(value); } catch { throw new RequestError(400, "Invalid provider URL."); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || url.search || /[\s"\\]/.test(value)) throw new RequestError(400, "Use an HTTP(S) URL without credentials, query or fragment.");
  }
  return value;
}

function validateUpdate(body, current) {
  if (!isObject(body) || Object.keys(body).some(key => !["env", "model", "baseUrl", "clearSecrets"].includes(key))) throw new RequestError(400, "Invalid configuration object.");
  const env = body.env === undefined ? {} : body.env;
  if (!isObject(env) || Object.keys(env).some(key => !ENV_KEYS.includes(key))) throw new RequestError(400, "Unknown configuration key.");
  const updates = Object.create(null);
  for (const [key, value] of Object.entries(env)) {
    validateValue(key, value);
    // Old clients or blank password fields must never erase a saved credential.
    if (SECRET_KEYS.includes(key) && (value === "" || /^(?:\*+|•+|<redacted>)$/.test(value))) continue;
    updates[key] = value;
  }
  for (const [field, key] of [["model", "LLM_MODEL"], ["baseUrl", "LLM_VLLM_BASE_URL"]]) {
    if (body[field] === undefined) continue;
    validateValue(key, body[field]);
    if (Object.hasOwn(updates, key) && updates[key] !== body[field]) throw new RequestError(400, "Conflicting configuration values.");
    updates[key] = body[field];
  }
  const clear = body.clearSecrets === undefined ? [] : body.clearSecrets;
  if (!Array.isArray(clear) || clear.some(key => !SECRET_KEYS.includes(key))) throw new RequestError(400, "Invalid clearSecrets list.");
  for (const key of clear) {
    if (Object.hasOwn(updates, key)) throw new RequestError(400, "Cannot replace and clear the same secret.");
    updates[key] = "";
  }
  // Do not silently forward an old provider's key to a newly selected endpoint.
  for (const [urlKey, secretKeys] of [["LLM_VLLM_BASE_URL", SECRET_KEYS.slice(0, 3)], ["LLM_EMBEDDING_BASE_URL", ["LLM_EMBEDDING_API_KEY"]]]) {
    if (updates[urlKey] !== undefined && updates[urlKey] !== current[urlKey]) {
      if (secretKeys.some(key => current[key] && !Object.hasOwn(updates, key))) throw new RequestError(400, "Changing provider URL requires replacing or explicitly clearing its saved API keys.");
    }
  }
  return updates;
}

function rewriteConfigToml(toml, model, baseUrl) {
  let result = toml;
  for (const key of ["MODEL", "BACKUP_MODEL", "DEDUCTION_MODEL", "INDUCTION_MODEL"]) {
    if (model) result = result.replace(new RegExp(`^${key} = ".*"`, "gm"), () => `${key} = ${JSON.stringify(model)}`);
  }
  result = result.replace(/^BACKUP_PROVIDER = ".*"/gm, 'BACKUP_PROVIDER = "vllm"');
  if (baseUrl) result = result.replace(/^OPENAI_COMPATIBLE_BASE_URL = ".*"/gm, () => `OPENAI_COMPATIBLE_BASE_URL = ${JSON.stringify(baseUrl)}`);
  return result;
}

function createWizard(options = {}) {
  const configDir = options.configDir || process.env.HONCHO_CONFIG_DIR || "/config";
  const envFile = path.join(configDir, ".env");
  const tomlFile = path.join(configDir, "config.toml");
  const template = options.template || process.env.TEMPLATE_TOML || "/app/config-template.toml";
  const request = options.fetch || fetch;
  const expectedPassword = loadPasswordDigest(options.password ?? process.env.HONCHO_WIZARD_PASSWORD);
  const now = options.now || Date.now;
  const sessions = new Map();
  let loginWindowEnd = 0;
  let loginAttempts = 0;
  const origins = (options.origins || (process.env.HONCHO_WIZARD_ORIGINS || DEFAULT_ORIGIN).split(",")).map(value => {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.origin !== value || url.username || url.password) throw new Error("Invalid HONCHO_WIZARD_ORIGINS; use exact origins.");
    return url;
  });
  const hosts = new Set(origins.map(url => url.host));
  const allowedOrigins = new Set(origins.map(url => url.origin));
  let orCache = { models: [], ts: 0 };

  async function probeOllama() {
    for (const url of OLLAMA_CANDIDATES) {
      try {
        const resp = await request(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json();
          return { reachable: true, url, models: (data.models || []).map(model => String(model.name)) };
        }
      } catch {}
    }
    return { reachable: false, url: null, models: [] };
  }
  async function fetchModels() {
    if (orCache.models.length && Date.now() - orCache.ts < 6 * 60 * 60 * 1000) return orCache.models;
    try {
      const resp = await request("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10000), headers: { Accept: "application/json" } });
      if (!resp.ok) return orCache.models;
      const data = await resp.json();
      const models = (data.data || []).filter(model => typeof model.id === "string" && !model.id.includes(":free"))
        .map(model => ({ id: model.id, name: String(model.name || model.id), context_length: Number(model.context_length) || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
      orCache = { models, ts: Date.now() };
    } catch {}
    return orCache.models;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Host allowlisting also prevents browser DNS rebinding to an attacker-controlled origin.
      if (!hosts.has((req.headers.host || "").toLowerCase())) throw new RequestError(403, "Unrecognized wizard host.");
      if ((req.headers.origin && !allowedOrigins.has(req.headers.origin)) || req.headers["sec-fetch-site"] === "cross-site") throw new RequestError(403, "Cross-origin access denied.");
      const url = new URL(req.url, DEFAULT_ORIGIN);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"));
        return;
      }
      if (!url.pathname.startsWith("/api/")) { json(res, 404, { error: "Not found." }); return; }
      if (req.method === "POST" && url.pathname === "/api/login") {
        const time = now();
        if (time >= loginWindowEnd) { loginWindowEnd = time + LOGIN_WINDOW_MS; loginAttempts = 0; }
        if (loginAttempts >= MAX_LOGIN_ATTEMPTS) {
          res.setHeader("Retry-After", String(Math.ceil((loginWindowEnd - time) / 1000)));
          throw new RequestError(429, "Too many login attempts. Try again in one minute.");
        }
        loginAttempts++;
        const body = await readBody(req);
        if (!isObject(body) || Object.keys(body).some(key => key !== "password") || typeof body.password !== "string" || body.password.length > 128) throw new RequestError(400, "Invalid login request.");
        if (!crypto.timingSafeEqual(passwordDigest(body.password), expectedPassword)) throw new RequestError(401, "Incorrect wizard password.");
        for (const [token, expires] of sessions) if (expires <= time) sessions.delete(token);
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        const token = crypto.randomBytes(32).toString("hex");
        sessions.set(token, time + SESSION_TTL_MS);
        json(res, 200, { token, expiresIn: SESSION_TTL_MS / 1000 });
        return;
      }
      const credential = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || "");
      const token = credential?.[1];
      if (!token || !sessions.has(token) || sessions.get(token) <= now()) {
        if (token) sessions.delete(token);
        throw new RequestError(401, "Wizard session required. Unlock with your password.");
      }
      if (req.method === "POST" && url.pathname === "/api/logout") {
        sessions.delete(token);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        const current = parseEnvFile(readFile(envFile));
        const publicEnv = {};
        const invalidPublicFields = [];
        for (const key of PUBLIC_KEYS) {
          if (!Object.hasOwn(current, key)) continue;
          try { publicEnv[key] = validateValue(key, current[key]); }
          catch { invalidPublicFields.push(key); }
        }
        json(res, 200, {
          env: publicEnv,
          invalidPublicFields,
          configuredSecrets: Object.fromEntries(SECRET_KEYS.map(key => [key, !!current[key]])),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = await readBody(req);
        const existing = readFile(envFile);
        const current = parseEnvFile(existing);
        const updates = validateUpdate(body, current);
        const merged = { ...current, ...updates };
        const toml = readFile(tomlFile, readFile(template));
        const newToml = rewriteConfigToml(toml, merged.LLM_MODEL, merged.LLM_VLLM_BASE_URL);
        fs.mkdirSync(configDir, { recursive: true });
        // All input validation completes before either file is changed. Each file is replaced atomically.
        if (newToml) atomicWrite(tomlFile, newToml);
        atomicWrite(envFile, serializeEnv(existing, updates));
        json(res, 200, { ok: true, message: "Configuration saved. Restart Honcho services to apply." });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/ollama/probe") { json(res, 200, await probeOllama()); return; }
      if (req.method === "GET" && url.pathname === "/api/models/openrouter") { json(res, 200, { models: await fetchModels() }); return; }
      if (req.method === "GET" && url.pathname === "/api/health") {
        try {
          const resp = await request("http://api.honcho.dappnode:8000/health", { signal: AbortSignal.timeout(5000) });
          // Do not relay arbitrary internal API content to the browser.
          json(res, 200, { apiServer: resp.ok });
        } catch { json(res, 200, { apiServer: false }); }
        return;
      }
      // The previous restart endpoint was a no-op; restarting remains an admin-UI operation.
      json(res, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof RequestError) json(res, error.status, { error: error.message });
      else { console.error("Wizard request failed; configuration was not returned."); json(res, 500, { error: "Unable to process configuration. Check the local service and storage." }); }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  createWizard().listen(8080, "0.0.0.0", () => {
    console.log("Honcho Setup Wizard listening on :8080. Unlock with the wizard password configured in Dappnode.");
  });
}
module.exports = { createWizard, parseEnvFile, serializeEnv, validateUpdate, rewriteConfigToml, SECRET_KEYS };
