"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { JSDOM, VirtualConsole } = require("jsdom");
const { createWizard, parseEnvFile, SECRET_KEYS } = require("./server.cjs");
const ORIGIN = "http://setup-wizard.honcho.dappnode:8080";
const BASE = "https://custom.invalid/v1";
const STORED_KEY = "synthetic-stored-provider-secret";
const PASSWORD = "synthetic-wizard-password";
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("UI did not reach the expected state");
}
async function browserFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "honcho-ui-test-"));
  const configDir = path.join(dir, "config"); fs.mkdirSync(configDir);
  let token, time = Date.now();
  fs.writeFileSync(path.join(configDir, ".env"), [...SECRET_KEYS.map(key => `${key}=${STORED_KEY}`), `LLM_VLLM_BASE_URL=${BASE}`, `LLM_EMBEDDING_BASE_URL=${BASE}`, "LLM_MODEL=original/model"].join("\n"));
  const server = createWizard({ configDir, password: PASSWORD, now: () => time, fetch: async url => ({ ok: true, json: async () => url.endsWith("/api/tags") ? { models: [{ name: '<img src=x onerror="window.pwned=true">' }] } : { data: [{ id: '<img src=x onerror="window.pwned=true">', name: "Synthetic model" }] } }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const calls = []; const alerts = []; const errors = [];
  const console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error.message));
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), {
    url: ORIGIN, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      window.scrollTo = () => {}; window.alert = message => alerts.push(message);
      window.fetch = (route, options = {}) => new Promise((resolve, reject) => {
        const call = { route, options }; calls.push(call);
        const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: route, method: options.method || "GET", headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN, ...options.headers } }, res => {
          const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => {
            const content = Buffer.concat(chunks); call.status = res.statusCode;
            if (route === "/api/login" && res.statusCode === 200) token = JSON.parse(content.toString()).token;
            resolve(new Response(content, { status: res.statusCode, headers: res.headers }));
          });
        });
        req.on("error", reject); req.end(options.body);
      });
    },
  });
  t.after(async () => { dom.window.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const document = dom.window.document;
  async function login(credential = PASSWORD) {
    document.getElementById("wizard-password").value = credential;
    document.getElementById("login-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => !document.getElementById("wizard-app").hidden || !!document.getElementById("login-error").textContent);
    if (!document.getElementById("wizard-app").hidden) await waitFor(() => document.getElementById("st-model").textContent === "original/model");
  }
  function custom() {
    dom.window.switchTab("setup"); document.querySelector('[data-id="custom"]').click(); dom.window.goTo(1);
  }
  return { dom, document, calls, alerts, errors, get token() { return token; }, configDir, login, custom, advance: ms => { time += ms; } };
}

test("UI logs in with a password, keeps only a tab-memory session and revokes it on lock", async t => {
  const f = await browserFixture(t);
  assert.equal(f.document.getElementById("wizard-app").hidden, true); assert.equal(f.calls.length, 0);
  await f.login("wrong-password"); assert.equal(f.document.getElementById("wizard-app").hidden, true); assert.match(f.document.getElementById("login-error").textContent, /password/);
  await f.login(); assert.equal(f.document.getElementById("login-panel").hidden, true); assert.equal(f.document.getElementById("wizard-password").value, "");
  assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0); assert.equal(f.document.cookie, "");
  assert.ok(f.calls.filter(call => call.route !== "/api/login").every(call => call.options.headers.Authorization === "Bearer " + f.token));
  assert.ok(f.calls.filter(call => call.route !== "/api/login").every(call => !JSON.stringify(call.options).includes(PASSWORD)));
  f.document.getElementById("logout-button").click(); assert.equal(f.document.getElementById("wizard-app").hidden, true);
  const count = f.calls.length; await assert.rejects(f.dom.window.apiFetch("/api/config"), /Unlock/); assert.equal(f.calls.length, count);
  await waitFor(() => f.calls.some(call => call.route === "/api/logout" && call.status === 200));
  const response = await f.dom.window.fetch("/api/config", { headers: { Authorization: `Bearer ${f.token}` } }); assert.equal(response.status, 401);
  assert.deepEqual(f.errors, []);
});

test("expired sessions return the UI to its password prompt", async t => {
  const f = await browserFixture(t); await f.login(); f.advance(8 * 60 * 60 * 1000);
  await assert.rejects(f.dom.window.apiFetch("/api/config"), /expired/);
  assert.equal(f.document.getElementById("wizard-app").hidden, true);
  assert.equal(f.document.getElementById("login-panel").hidden, false);
  await f.login(); assert.equal(f.document.getElementById("wizard-app").hidden, false);
});

test("login rate limits are displayed and the user can retry after the window", async t => {
  const f = await browserFixture(t);
  for (let i = 0; i < 10; i++) await f.login("wrong-password");
  await f.login(); assert.equal(f.document.getElementById("wizard-app").hidden, true);
  assert.match(f.document.getElementById("login-error").textContent, /Too many login attempts/);
  f.advance(60001); await f.login(); assert.equal(f.document.getElementById("wizard-app").hidden, false);
});

test("UI edits model without round-tripping or deleting saved keys", async t => {
  const f = await browserFixture(t); await f.login(); f.custom();
  assert.equal(f.document.getElementById("api-key").value, ""); assert.match(f.document.getElementById("api-key").placeholder, /keep/);
  assert.equal(f.document.getElementById("custom-base-url").value, BASE);
  f.document.getElementById("custom-model").value = "updated/model";
  f.dom.window.showReview(); assert.ok(!f.document.getElementById("env-preview").textContent.includes(STORED_KEY));
  await f.dom.window.saveConfig(); assert.equal(f.alerts.length, 0);
  const body = JSON.parse(f.calls.filter(call => call.options.method === "POST").at(-1).options.body);
  assert.equal(body.env.LLM_VLLM_API_KEY, undefined); assert.equal(body.clearSecrets.length, 0);
  const env = parseEnvFile(fs.readFileSync(path.join(f.configDir, ".env"), "utf8"));
  for (const key of SECRET_KEYS) assert.equal(env[key], STORED_KEY);
  assert.equal(env.LLM_MODEL, "updated/model"); assert.equal(f.document.querySelector('[data-step="3"]').classList.contains("active"), true);
  assert.deepEqual(f.errors, []);
});

test("UI replaces and explicitly clears keys without exposing them in the review", async t => {
  const f = await browserFixture(t); await f.login(); f.custom();
  const replacement = "synthetic-entered-new-secret";
  f.document.getElementById("api-key").value = replacement; f.dom.window.showReview();
  assert.ok(!f.document.getElementById("env-preview").textContent.includes(replacement));
  await f.dom.window.saveConfig(); assert.equal(f.alerts.length, 0);
  assert.equal(f.document.getElementById("api-key").value, "");
  let env = parseEnvFile(fs.readFileSync(path.join(f.configDir, ".env"), "utf8"));
  for (const key of SECRET_KEYS) assert.equal(env[key], replacement);
  f.dom.window.goTo(1); const clear = f.document.getElementById("clear-api-keys"); clear.checked = true; clear.dispatchEvent(new f.dom.window.Event("change"));
  assert.equal(f.document.getElementById("api-key").disabled, true); f.dom.window.showReview(); assert.match(f.document.getElementById("env-preview").textContent, /explicitly clear/);
  await f.dom.window.saveConfig(); env = parseEnvFile(fs.readFileSync(path.join(f.configDir, ".env"), "utf8"));
  for (const key of SECRET_KEYS) assert.equal(env[key], "");
  assert.equal(f.alerts.length, 0); assert.deepEqual(f.errors, []);
});

test("provider model and Ollama responses are rendered as text rather than executable HTML", async t => {
  const f = await browserFixture(t); await f.login();
  f.dom.window.switchTab("setup"); f.document.querySelector('[data-id="openrouter"]').click(); f.dom.window.goTo(1);
  await waitFor(() => f.document.getElementById("or-model-input"));
  f.document.getElementById("or-model-input").dispatchEvent(new f.dom.window.Event("focus"));
  assert.equal(f.document.querySelectorAll(".model-suggestions img").length, 0);
  assert.match(f.document.querySelector(".sg-id").textContent, /<img/);
  f.document.querySelector('[data-id="ollama"]').click(); f.dom.window.goTo(1); await f.dom.window.probeOllama();
  assert.equal(f.document.querySelectorAll("#probe-result img").length, 0); assert.match(f.document.getElementById("probe-result").textContent, /<img/);
  assert.equal(f.dom.window.pwned, undefined); assert.deepEqual(f.errors, []);
});
