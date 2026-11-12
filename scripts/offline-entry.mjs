// Bundled into public/offline-runtime.js for OFFLINE MODE.
//
// Offline mode runs the real operator API against the fictional dataset entirely in
// the browser: no server, no credentials, nothing to configure. It is how the
// interface is reviewed without a PayPal sandbox account.
//
// Offline mode cannot do sandbox invoicing, and must never appear to: PayPal needs
// server-side credentials, which a browser page cannot hold. Payment actions are
// unavailable here rather than faked.
import { handler } from "../server/operator-api.mjs";
import { demoMeta } from "../server/_shared/db.mjs";
import { createAllocationHandler } from "../server/allocation-api.mjs";
import { createMemoryAllocationStore } from "../src/allocation-store-memory.js";

// The allocation workspace runs here too, from the SAME module the local server
// mounts. This is the fix for a real divergence: offline mode used to build its own
// view of the split in the page, so an unbalanced draft that server mode refused to
// issue looked publishable offline. One module cannot disagree with itself.
//
// Storage is the honest difference. There is no file in a browser, so a draft lives
// until the tab reloads, and the interface says so.
const allocationHandler = createAllocationHandler({
  store: createMemoryAllocationStore(),
  invoicesFor: () => [],
  provider: { available: false, reason: "Offline mode: no payment provider is connected, so nothing can be collected from here.", mappedCount: 0 },
});

const startedAt = new Date().toISOString();
const demoHeaders = { "x-hearth-dataset": "fictional-offline-demo", "content-type": "application/json; charset=utf-8" };

function response(status, body, headers = {}) {
  const all = Object.fromEntries(Object.entries({ ...demoHeaders, ...headers }).map(([key, value]) => [key.toLowerCase(), value]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => all[String(name).toLowerCase()] || null }, json: async () => body };
}

export async function demoFetch(resource, options = {}) {
  const url = new URL(resource, globalThis.location?.origin || "https://hearth-demo.invalid");
  if (url.pathname === "/demo/meta") return response(200, { ...demoMeta, startedAt, storage: "page" });
  const route = url.pathname.startsWith("/api/allocation/") ? allocationHandler : handler;
  const result = await route({
    path: url.pathname,
    httpMethod: String(options.method || "GET").toUpperCase(),
    headers: options.headers || {},
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: options.body || null,
  });
  let body = {};
  try { body = JSON.parse(result.body || "{}"); } catch { body = {}; }
  return response(result.statusCode, body, result.headers);
}

export function getDemoMeta() { return { ...demoMeta, startedAt }; }
