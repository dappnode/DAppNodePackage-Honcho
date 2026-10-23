"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { createWizard, parseEnvFile, SECRET_KEYS } = require("./server.cjs");
const ORIGIN = "http://setup-wizard.honcho.dappnode:8080";
const INITIAL = "synthetic-provider-key-not-real";
const MODEL = "example/model:1";
const BASE = "https://example.invalid/v1";
const PASSWORD = "synthetic-wizard-password";
const TOML = '[llm]\nMODEL = "old"\nBACKUP_MODEL = "old"\nDEDUCTION_MODEL = "old"\nINDUCTION_MODEL = "old"\nBACKUP_PROVIDER = "old"\nOPENAI_COMPATIBLE_BASE_URL = "https://old.invalid"\n';

async function fixture(t, { configured = true, failNetwork = false, password = PASSWORD } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "honcho-wizard-test-"));
  const configDir = path.join(dir, "config");
  fs.mkdirSync(configDir);
  const template = path.join(dir, "template.toml"); fs.writeFileSync(template, TOML);
  if (configured) fs.writeFileSync(path.join(configDir, ".env"), ["# retain this comment", "UNRELATED_PRIVATE_KEY=synthetic-other-secret", ...SECRET_KEYS.map(key => `${key}=${INITIAL}`), `LLM_MODEL=${MODEL}`, `LLM_VLLM_BASE_URL=${BASE}`, `LLM_EMBEDDING_BASE_URL=${BASE}`].join("\n"));
  const calls = [];
  const fakeFetch = async url => {
    calls.push(url);
    if (failNetwork) throw new Error("synthetic failure");
    if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: [{ name: '<img src=x onerror="alert(1)">' }, { name: "qwen:8b" }] }) };
    if (url.includes("openrouter.ai")) return { ok: true, json: async () => ({ data: [{ id: "paid/model", name: "Paid" }, { id: "skip:free" }] }) };
    if (url === "http://api.honcho.dappnode:8000/health") return { ok: true, json: async () => ({ secret: INITIAL }) };
    throw new Error("Unexpected service endpoint");
  };
  let server, token;
  let time = Date.now();
  async function start() {
    server = createWizard({ configDir, password, template, fetch: fakeFetch, now: () => time });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  }
  await start();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(route = "/api/config", { method = "GET", body, authorized = true, headers = {}, raw } = {}) {
    let data = raw === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : raw;
    const requestHeaders = { Host: new URL(ORIGIN).host, ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers };
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: route, method, headers: requestHeaders }, response => {
        const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json; try { json = JSON.parse(text); } catch {}
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
      });
      req.on("error", reject); req.end(data);
    });
  }
  const login = (credential = password, headers = {}) => request("/api/login", { method: "POST", authorized: false, body: { password: credential }, headers });
  const initial = await login(); assert.equal(initial.status, 200); token = initial.json.token;
  return { dir, configDir, token, calls, request, login, advance: ms => { time += ms; }, read: () => fs.readFileSync(path.join(configDir, ".env"), "utf8"), restart: async (replacement = password) => { await new Promise(resolve => server.close(resolve)); password = replacement; await start(); } };
}

test("all sensitive routes require authorization before reads, writes or network probes", async t => {
  const f = await fixture(t); const original = f.read();
  for (const [route, method] of [["/api/config", "GET"], ["/api/config", "POST"], ["/api/health", "GET"], ["/api/ollama/probe", "GET"], ["/api/models/openrouter", "GET"], ["/api/restart", "POST"], ["/api/logout", "POST"]]) {
    const r = await f.request(route, { method, authorized: false, body: method === "POST" ? { env: { LLM_MODEL: "attacker" } } : undefined });
    assert.equal(r.status, 401); assert.ok(!r.text.includes(INITIAL)); assert.ok(!r.text.includes(f.token));
  }
  assert.equal(f.read(), original); assert.equal(f.calls.length, 0);
});

test("invalid credentials are rejected without leaking tokens", async t => {
  const f = await fixture(t);
  for (const authorization of ["Bearer " + "0".repeat(64), "Bearer short", "Basic abc", "Bearer " + f.token.toUpperCase()]) {
    const r = await f.request("/api/config", { headers: { Authorization: authorization } });
    assert.equal(r.status, 401); assert.ok(!r.text.includes(f.token));
  }
});

test("password login issues independent expiring sessions without exposing credentials elsewhere", async t => {
  const f = await fixture(t, { configured: false });
  assert.match(f.token, /^[a-f0-9]{64}$/);
  const second = await f.login(); assert.equal(second.status, 200); assert.notEqual(second.json.token, f.token); assert.equal(second.json.expiresIn, 8 * 60 * 60);
  assert.equal(second.headers["cache-control"], "no-store"); assert.equal(second.headers["set-cookie"], undefined);
  for (const route of ["/", "/auth/admin-token", "/admin-token", "/api/config"]) {
    const r = await f.request(route, { authorized: false }); assert.ok(!r.text.includes(f.token)); assert.ok(!r.text.includes(PASSWORD));
  }
  assert.equal(fs.existsSync(path.join(f.configDir, ".env")), false);
});

test("missing, short, oversized or control-containing setup passwords fail closed", () => {
  for (const password of ["", "too-short", "x".repeat(129), PASSWORD + "\n", PASSWORD + "\0", "password-with-\u00e9"]) {
    assert.throws(() => createWizard({ password }), /Set HONCHO_WIZARD_PASSWORD/);
  }
});

test("password punctuation and leading or trailing spaces are preserved", async t => {
  const password = "  synthetic:password!'$  "; const f = await fixture(t, { password });
  assert.equal((await f.login(password.trim())).status, 401);
  assert.equal((await f.login(password)).status, 200);
});

test("logout and session expiry reject previously authorized credentials", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/logout", { method: "POST" })).status, 200);
  assert.equal((await f.request()).status, 401);
  const session = (await f.login()).json.token;
  assert.equal((await f.request("/api/config", { headers: { Authorization: `Bearer ${session}` } })).status, 200);
  f.advance(8 * 60 * 60 * 1000);
  assert.equal((await f.request("/api/config", { headers: { Authorization: `Bearer ${session}` } })).status, 401);
});

test("restart and configured password changes revoke sessions without changing provider keys", async t => {
  const f = await fixture(t); const original = f.read();
  await f.restart(); assert.equal((await f.request()).status, 401); assert.equal((await f.login()).status, 200);
  const replacement = "synthetic-new-wizard-password";
  await f.restart(replacement);
  assert.equal((await f.login(PASSWORD)).status, 401);
  assert.equal((await f.login(replacement)).status, 200);
  assert.equal(f.read(), original);
});

test("login attempts are bounded per wizard while established sessions remain usable", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 9; i++) assert.equal((await f.login("wrong-password")).status, 401);
  const limited = await f.login(); assert.equal(limited.status, 429); assert.equal(limited.headers["retry-after"], "60");
  assert.equal((await f.request()).status, 200);
  f.advance(60001); assert.equal((await f.login()).status, 200);
});

test("login validates bounded JSON and enforces host and origin checks", async t => {
  const f = await fixture(t);
  for (const headers of [{ Origin: "https://attacker.invalid" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { Host: "attacker.invalid" }]) assert.equal((await f.login(PASSWORD, headers)).status, 403);
  const cases = [[{ body: [] }, 400], [{ body: { password: [] } }, 400], [{ body: { password: "x".repeat(129) } }, 400], [{ body: { password: PASSWORD, extra: true } }, 400], [{ raw: "{" }, 400], [{ raw: "x".repeat(17000) }, 413], [{ raw: "x".repeat(17000), headers: { "Transfer-Encoding": "chunked" } }, 413], [{ body: {}, headers: { "Content-Type": "text/plain" } }, 415]];
  for (const [options, status] of cases) assert.equal((await f.request("/api/login", { method: "POST", authorized: false, ...options })).status, status);
});

test("session storage stays bounded by revoking the oldest session", async t => {
  const f = await fixture(t); let latest;
  for (let i = 0; i < 32; i++) { f.advance(60001); latest = (await f.login()).json.token; }
  assert.equal((await f.request()).status, 401);
  assert.equal((await f.request("/api/config", { headers: { Authorization: `Bearer ${latest}` } })).status, 200);
});

test("authenticated config is an allowlisted redacted representation", async t => {
  const f = await fixture(t); const r = await f.request();
  assert.equal(r.status, 200); assert.deepEqual(r.json.env, { LLM_VLLM_BASE_URL: BASE, LLM_EMBEDDING_BASE_URL: BASE, LLM_MODEL: MODEL });
  assert.deepEqual(r.json.configuredSecrets, Object.fromEntries(SECRET_KEYS.map(key => [key, true])));
  for (const secret of [INITIAL, "synthetic-other-secret", f.token, PASSWORD]) assert.ok(!r.text.includes(secret));
  assert.equal(r.json.configToml, undefined); assert.equal(r.headers["cache-control"], "no-store"); assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("model edits and blank/masked secrets preserve existing keys and comments", async t => {
  const f = await fixture(t);
  const r = await f.request("/api/config", { method: "POST", body: { env: { LLM_MODEL: "new/model", LLM_VLLM_API_KEY: "", LLM_OPENAI_API_KEY: "********", LLM_OPENAI_COMPATIBLE_API_KEY: "<redacted>", LLM_EMBEDDING_API_KEY: "••••" } } });
  assert.equal(r.status, 200); assert.ok(!r.text.includes(INITIAL));
  const env = parseEnvFile(f.read()); for (const key of SECRET_KEYS) assert.equal(env[key], INITIAL);
  assert.equal(env.LLM_MODEL, "new/model"); assert.match(f.read(), /# retain this comment/); assert.equal(env.UNRELATED_PRIVATE_KEY, "synthetic-other-secret");
  assert.equal(fs.statSync(path.join(f.configDir, ".env")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(f.configDir, "config.toml"), "utf8"), /INDUCTION_MODEL = "new\/model"/);
});

test("explicit replacement and clearing work; omitted fields remain unchanged", async t => {
  const f = await fixture(t);
  let r = await f.request("/api/config", { method: "POST", body: { env: { LLM_VLLM_API_KEY: "synthetic-replacement" }, clearSecrets: ["LLM_EMBEDDING_API_KEY"] } });
  assert.equal(r.status, 200); let env = parseEnvFile(f.read());
  assert.equal(env.LLM_VLLM_API_KEY, "synthetic-replacement"); assert.equal(env.LLM_EMBEDDING_API_KEY, ""); assert.equal(env.LLM_OPENAI_API_KEY, INITIAL);
  r = await f.request(); assert.equal(r.json.configuredSecrets.LLM_EMBEDDING_API_KEY, false); assert.ok(!r.text.includes("synthetic-replacement"));
});

test("provider changes cannot silently send existing keys to a new endpoint", async t => {
  const f = await fixture(t); const original = f.read();
  let r = await f.request("/api/config", { method: "POST", body: { env: { LLM_VLLM_BASE_URL: "https://new.invalid/v1" } } });
  assert.equal(r.status, 400); assert.equal(f.read(), original);
  r = await f.request("/api/config", { method: "POST", body: { env: { LLM_VLLM_BASE_URL: "https://new.invalid/v1", ...Object.fromEntries(SECRET_KEYS.slice(0, 3).map(key => [key, "synthetic-new-key"])) } } });
  assert.equal(r.status, 200);
});

test("cross-origin requests, preflights, DNS rebinding and Origin:null are rejected", async t => {
  const f = await fixture(t); const original = f.read();
  for (const headers of [{ Origin: "https://attacker.invalid" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }, { Host: "attacker.invalid" }]) {
    const r = await f.request("/api/config", { method: "POST", body: { env: { LLM_MODEL: "bad" } }, headers }); assert.equal(r.status, 403);
  }
  assert.equal((await f.request("/api/config", { method: "OPTIONS", authorized: false, headers: { Origin: "https://attacker.invalid", "Access-Control-Request-Headers": "authorization" } })).status, 403);
  assert.equal((await f.request("/api/config", { headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" } })).status, 200);
  assert.equal(f.read(), original);
});

test("malformed, oversized and non-JSON bodies are rejected without changes", async t => {
  const f = await fixture(t); const original = f.read();
  for (const [options, status] of [[{ raw: "{" }, 400], [{ raw: "x".repeat(17000) }, 413], [{ raw: "x".repeat(17000), headers: { "Transfer-Encoding": "chunked" } }, 413], [{ body: {}, headers: { "Content-Type": "text/plain" } }, 415]]) {
    assert.equal((await f.request("/api/config", { method: "POST", ...options })).status, status);
  }
  assert.equal(f.read(), original);
});

test("unknown keys, prototype keys, invalid types and directive injection cannot mutate config", async t => {
  const f = await fixture(t); const original = f.read();
  const bodies = [null, [], { env: [] }, { env: { AUTH_USE_AUTH: "false" } }, { arbitrary: "bad" }, { env: { LLM_MODEL: 1 } }, { env: { LLM_MODEL: "valid\nINJECTED=true" } }, { env: { LLM_MODEL: 'model"\n[evil]' } }, { env: { LLM_VLLM_API_KEY: "key\nEVIL=true" } }, { env: { LLM_VLLM_API_KEY: "quote'break" } }, { env: { LLM_VLLM_BASE_URL: "file:///tmp/x" } }, { env: { LLM_VLLM_BASE_URL: "https://user:pass@example.invalid" } }, { env: { LLM_VLLM_BASE_URL: "https://example.invalid/?key=secret" } }, { clearSecrets: ["LLM_MODEL"] }, { env: { LLM_VLLM_API_KEY: "replacement" }, clearSecrets: ["LLM_VLLM_API_KEY"] }, { env: { LLM_MODEL: "a" }, model: "b" }];
  bodies.push(JSON.parse('{"env":{"__proto__":{"polluted":true}}}'));
  for (const body of bodies) assert.equal((await f.request("/api/config", { method: "POST", body })).status, 400);
  assert.equal(f.read(), original); assert.equal({}.polluted, undefined);
});

test("shell syntax in a key stays literal when actual consumer shells source .env", async t => {
  const f = await fixture(t); const marker = path.join(f.dir, "must-not-exist");
  const synthetic = `key$(touch ${marker});$HOME\\backtick\`literal\``;
  const r = await f.request("/api/config", { method: "POST", body: { env: { LLM_VLLM_API_KEY: synthetic } } });
  assert.equal(r.status, 200);
  const output = execFileSync("/bin/sh", ["-c", '. "$1"; printf "%s" "$LLM_VLLM_API_KEY"', "test", path.join(f.configDir, ".env")], { encoding: "utf8" });
  assert.equal(output, synthetic); assert.equal(fs.existsSync(marker), false);
});

test("authorized Ollama, model cache and health work without proxying internal secrets", async t => {
  const f = await fixture(t);
  const probe = await f.request("/api/ollama/probe"); assert.equal(probe.status, 200); assert.equal(probe.json.reachable, true); assert.equal(probe.json.models[1], "qwen:8b");
  const models = await f.request("/api/models/openrouter"); assert.deepEqual(models.json.models, [{ id: "paid/model", name: "Paid", context_length: 0 }]);
  await f.request("/api/models/openrouter"); assert.equal(f.calls.filter(url => url.includes("openrouter.ai")).length, 1);
  const health = await f.request("/api/health"); assert.deepEqual(health.json, { apiServer: true }); assert.ok(!health.text.includes(INITIAL));
  assert.equal((await f.request("/api/restart", { method: "POST" })).status, 404);
});

test("authorized upstream failures have safe empty results", async t => {
  const f = await fixture(t, { failNetwork: true });
  assert.deepEqual((await f.request("/api/health")).json, { apiServer: false });
  assert.deepEqual((await f.request("/api/models/openrouter")).json, { models: [] });
  assert.deepEqual((await f.request("/api/ollama/probe")).json, { reachable: false, url: null, models: [] });
});


test("legacy secrets without a saved URL require an explicit decision on endpoint selection", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.configDir, ".env"), SECRET_KEYS.map(key => `${key}=${INITIAL}`).join("\n"));
  const original = f.read();
  const r = await f.request("/api/config", { method: "POST", body: { env: { LLM_VLLM_BASE_URL: BASE } } });
  assert.equal(r.status, 400); assert.equal(f.read(), original);
});

test("legacy URLs with userinfo or query credentials are never returned as public configuration", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.configDir, ".env"), `LLM_VLLM_BASE_URL=https://user:${INITIAL}@example.invalid/v1\nLLM_EMBEDDING_BASE_URL=https://example.invalid/v1?key=${INITIAL}\nLLM_MODEL=${MODEL}`);
  const r = await f.request();
  assert.equal(r.status, 200); assert.deepEqual(r.json.env, { LLM_MODEL: MODEL });
  assert.deepEqual(r.json.invalidPublicFields, ["LLM_VLLM_BASE_URL", "LLM_EMBEDDING_BASE_URL"]); assert.ok(!r.text.includes(INITIAL));
});
