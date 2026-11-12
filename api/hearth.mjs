// Hearth hosted on Vercel: the one function every API request reaches (see the
// rewrites in vercel.json). The interface is static files in public/, served by
// Vercel directly.
//
// The handlers are the same ones the local server runs (server/handlers.mjs). What
// differs is where the durable stores live. There is no disk that outlives a
// request here, and no memory shared between servers, so:
//
//   - the payment and allocation stores load from Postgres per request and write
//     back only what changed (src/postgres-stores.js);
//   - the "already being processed" lock is a database row, not a Set in memory.
//
// The fictional demo data (messages, turnover, leasing) still lives in memory and
// resets when a server starts, exactly as it does locally. Rent splits and invoices
// do not: a sandbox invoice exists at PayPal whether or not a server remembers it.
//
// Configuration is resolved once per server, as at local startup. A configuration
// error cannot stop a hosted server from starting, so every API request answers
// with it instead — never with an interface that looks connected and is not.
import pg from "pg";
import { demoMeta, resetDemoData } from "../server/_shared/db.mjs";
import { resolveOperator } from "../server/_shared/operator-auth.mjs";
import { handler as operatorHandler } from "../server/operator-api.mjs";
import { createHandlers, handlerFor } from "../server/handlers.mjs";
import { resolvePayments } from "../src/payments/provider.js";
import { resolveAi } from "../src/ai/provider.js";
import { createLock, ensureSchema, loadAllocationStore, loadPaymentStore } from "../src/postgres-stores.js";

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-hearth-dataset": "fictional-hosted-demo" };
const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });

// Stable for one deployment, so a browser forgets its last-viewed property when a
// new version ships, not whenever a request lands on a different server.
const RUN_ID = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || new Date().toISOString();
const STORAGE_NOTE = "Rent splits and invoices are saved for everyone using this link. Other demo data — messages, turnover, leasing — resets from time to time.";
// The datasets describe the local server, where storage is local. Hosted, it is not,
// and STORAGE_NOTE says what is true instead.
const DISCLAIMER = demoMeta.disclaimer?.replace(" · local storage only", "");
const STORED = ["/api/allocation/", "/api/payments/"];
const asResponse = (result) => new Response(result.body, { status: result.statusCode, headers: { ...HEADERS, ...result.headers } });

/**
 * The request handler, given a `query(sql, params)` that returns `{ rows, rowCount }`.
 * Exported so tests can run it against an in-process Postgres.
 */
export function createHostedHandler({ query, env = process.env }) {
  let configuration;
  try {
    configuration = { payments: resolvePayments({ env }), ai: resolveAi({ env }) };
  } catch (error) {
    configuration = { error: { error: `Hearth is not configured: ${error.message}`, fix: error.fix || null, code: "NOT_CONFIGURED" } };
  }
  // No access code is required: the page sends the built-in one by itself, so anyone
  // with the link can draft splits with AI and send sandbox invoices. The spend that
  // exposes is capped where it is paid for, with a monthly limit on the Anthropic key.
  // Setting HEARTH_ACCESS_CODE still puts a code in front of a copy that wants one.
  // Created on the first request, not at load: a rejection nobody is awaiting yet
  // would take the server down. A failed attempt is forgotten so the next can retry.
  let schema = null;
  const schemaReady = () => (schema ||= ensureSchema(query).catch((error) => { schema = null; throw error; }));
  const lock = query ? createLock(query) : null;

  return async function hosted(request) {
    const url = new URL(request.url);
    // A rewrite names the original path in __path; a direct request has its own.
    const pathname = url.searchParams.get("__path") || url.pathname;
    url.searchParams.delete("__path");

    if (pathname === "/demo/meta") return respond(200, { ...demoMeta, disclaimer: DISCLAIMER, startedAt: RUN_ID, storageNote: STORAGE_NOTE });
    if (configuration.error) return respond(500, configuration.error);

    const event = {
      path: pathname,
      httpMethod: request.method,
      headers: Object.fromEntries(request.headers),
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: (await request.text()) || null,
    };
    // Checked before the database is touched: a request without the code costs
    // nothing but this comparison.
    if (!resolveOperator(event)) return respond(401, { error: "Operator token required" });
    // Start over: the link back to its first screen for whoever opens it next. Every
    // rent split and invoice record goes, on purpose. Invoices already sent stay in
    // PayPal's sandbox, as fake money nobody is asked for again.
    if (pathname === "/api/demo/start-over" && request.method === "POST") {
      if (query) {
        await schemaReady();
        await query("delete from hearth_documents where kind in ('payment', 'allocation')");
        await query("delete from hearth_locks");
      }
      resetDemoData();
      return respond(200, { ok: true });
    }
    // The operator routes read only the fictional in-memory data, so most of a page
    // load never needs the stores at all.
    if (pathname.startsWith("/api/operator/")) return asResponse(await operatorHandler(event));
    if (!STORED.some((prefix) => pathname.startsWith(prefix))) return respond(404, { error: "Not found" });

    if (!query) return respond(500, { error: "Hearth is not configured: hosted mode keeps rent splits and invoices in Postgres, and no database is connected.", fix: "Connect a Postgres database to this Vercel project (Storage tab) so DATABASE_URL or POSTGRES_URL is set.", code: "NOT_CONFIGURED" });
    await schemaReady();

    const paymentStore = await loadPaymentStore(query);
    const allocationStore = await loadAllocationStore(query);
    const result = await handlerFor(createHandlers({ ...configuration, paymentStore, allocationStore, lock }), pathname)(event);
    try {
      await paymentStore.flush();
      await allocationStore.flush();
    } catch (error) {
      if (error.code === "CONCURRENT_WRITE") return respond(409, { error: error.message, code: error.code });
      throw error;
    }
    return asResponse(result);
  };
}

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const pool = connectionString ? new pg.Pool({ connectionString, max: 5 }) : null;
// An idle connection the database closes is reported here; unheard, it would end the process.
pool?.on("error", (error) => console.error("postgres_pool_error", error.message));

export default { fetch: createHostedHandler({ query: pool && ((sql, params) => pool.query(sql, params)) }) };
