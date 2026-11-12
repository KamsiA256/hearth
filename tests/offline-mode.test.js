// Offline mode is the credential-free way to review the interface. The thing worth
// testing is that it cannot be confused with the connected mode: the page runs in the
// browser, and this server answers no API call at all. A silent fallback between the
// two is the one failure this project cannot afford.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";

process.env.HEARTH_MODE = "offline";
const { serve, offlinePage } = await import("../scripts/demo-server.mjs");

let server, base;
before(async () => {
  server = http.createServer(serve);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test("the served page tells the app to run offline", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<html lang="en" data-hearth-mode="offline">/);
  assert.match(html, /offline-runtime\.js|app\.js/);
});

test("the page source itself is not pinned to offline mode", () => {
  // The attribute is injected per request. If it were committed into the file, the
  // connected server would serve an offline page and sandbox invoicing would appear
  // to be absent for no visible reason.
  const source = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(!source.includes("data-hearth-mode"), "index.html must not hardcode the mode");
  assert.match(offlinePage('<html lang="en">'), /data-hearth-mode="offline"/);
});

test("offline mode answers no API call", async () => {
  for (const path of ["/api/operator/properties", "/api/operator/overview", "/api/operator/messages"]) {
    const res = await fetch(`${base}${path}`, { headers: { authorization: "Bearer demo" } });
    assert.equal(res.status, 410, `${path} must be refused in offline mode`);
    assert.match((await res.json()).error, /offline mode/i);
  }
});

test("offline mode does not serve demo metadata either", async () => {
  const res = await fetch(`${base}/demo/meta`);
  assert.equal(res.status, 410);
});

test("offline mode labels its dataset as offline", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get("x-hearth-dataset"), "fictional-offline-demo");
});

test("static files are still served, so the interface can be reviewed", async () => {
  for (const path of ["/app.js", "/model.js", "/styles.css"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
});

test("the built offline bundle carries no SDK, credential or external endpoint", () => {
  const bundle = new URL("../public/offline-runtime.js", import.meta.url);
  if (!existsSync(bundle)) {
    assert.fail("public/offline-runtime.js is missing — run `npm run build:offline` first");
  }
  const code = readFileSync(bundle, "utf8");
  for (const pattern of [/supabase/i, /twilio/i, /anthropic/i, /api-m\.sandbox\.paypal\.com/, /client_secret/i, /PAYPAL_CLIENT/]) {
    assert.ok(!pattern.test(code), `offline bundle must not contain ${pattern}`);
  }
  // It must also make no network call of its own.
  assert.ok(!/fetch\s*\(\s*["'`]https?:/.test(code), "offline bundle must not call out to any host");
});
