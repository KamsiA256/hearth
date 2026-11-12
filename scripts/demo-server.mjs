// Local server for the Hearth demo. Two modes, chosen here and never guessed:
//
//   npm run demo           server mode  — the browser calls the real operator API
//                                         over HTTP, against fictional data held in
//                                         this process. Sandbox invoicing will run
//                                         from here, because it needs credentials a
//                                         browser page cannot hold.
//   npm run demo:offline   offline mode — the whole app runs inside the browser from
//                                         public/offline-runtime.js. This server
//                                         serves files and REFUSES every API call,
//                                         so "offline" cannot quietly mean "online".
//
// It listens on 127.0.0.1 only and deletes every pilot service variable from its own
// environment, so it cannot reach a database or send a message. Restarting it resets
// the fictional data. PayPal and ANTHROPIC variables are deliberately left alone:
// sandbox invoicing and AI-assisted weight proposals both run from server mode,
// gated by their own mode flag (PAYMENTS_MODE / AI_MODE) and resolved below — never
// guessed from a credential's mere presence.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const key of Object.keys(process.env)) if (/^(SUPABASE|TWILIO|SMS_WEBHOOK|OPERATOR_)/.test(key)) delete process.env[key];

const OFFLINE = process.env.HEARTH_MODE === "offline";
const { demoMeta, resetDemoData } = await import("../server/_shared/db.mjs");
const { resolveOperator } = await import("../server/_shared/operator-auth.mjs");
const { createHandlers, eventFrom, handlerFor } = await import("../server/handlers.mjs");
const { resolvePayments } = await import("../src/payments/provider.js");
const { createPaymentStore } = await import("../src/payments/store.js");
const { PaymentConfigError } = await import("../src/payments/config.js");
const { createAllocationStore } = await import("../src/allocation-store.js");
const { resolveAi } = await import("../src/ai/provider.js");
const { AiConfigError } = await import("../src/ai/config.js");

// Resolve payments at startup. In sandbox mode with credentials or the account
// mapping missing, this throws and the server does not start: there is no state in
// which the interface offers invoicing it cannot actually do.
let payments, handlers, startOver;
let ai;
try {
  payments = resolvePayments();
} catch (error) {
  if (error instanceof PaymentConfigError) {
    console.error(`\nCannot start: ${error.message}`);
    if (error.fix) console.error(`Fix: ${error.fix}`);
    console.error("\nOr run the interface with no payment provider at all:");
    console.error("  PAYMENTS_MODE=offline npm run demo\n");
    process.exit(1);
  }
  console.error(`\nCannot start: ${error.message}\n`);
  process.exit(1);
}

// Same discipline for AI. The default mode is "off", so nothing calls a model
// unless AI_MODE=anthropic is set deliberately; in that mode a missing key is a
// failure to start, not an interface that offers a proposal it cannot produce.
try {
  ai = resolveAi();
} catch (error) {
  if (error instanceof AiConfigError) {
    console.error(`\nCannot start: ${error.message}`);
    if (error.fix) console.error(`Fix: ${error.fix}`);
    console.error("\nOr run the interface with no AI at all:");
    console.error("  AI_MODE=off npm run demo\n");
    process.exit(1);
  }
  console.error(`\nCannot start: ${error.message}\n`);
  process.exit(1);
}

try {
  // The payment store is durable and separate from the fictional data, which resets
  // on every restart. A reset must never lose a real sandbox invoice.
  const paymentStore = createPaymentStore(), allocationStore = createAllocationStore();
  handlers = createHandlers({ payments, ai, paymentStore, allocationStore });
  // Settings > Start the demo over: the one deliberate exception to the rule above.
  // It forgets every split and invoice record so the demo opens as if new.
  startOver = () => { paymentStore.__reset(); allocationStore.__reset(); resetDemoData(); };
} catch (error) {
  console.error(`\nCannot start: ${error.message}\n`);
  process.exit(1);
}

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.DEMO_PORT || 8888);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const DATASET_HEADER = { "x-hearth-dataset": OFFLINE ? "fictional-offline-demo" : "fictional-local-demo" };
// Identifies this run: when the demo restarts (its fictional data resets), browsers
// also forget the property they last viewed.
const STARTED_AT = new Date().toISOString();

const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...DATASET_HEADER, ...headers }); res.end(JSON.stringify(body)); };

export function offlinePage(html) {
  return html.replace("<html lang=\"en\">", "<html lang=\"en\" data-hearth-mode=\"offline\">");
}

export async function serve(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/api/demo/start-over" && req.method === "POST") {
      if (OFFLINE) return json(res, 410, { error: "Offline mode: reload the page to start over." });
      if (!resolveOperator({ headers: req.headers })) return json(res, 401, { error: "Operator token required" });
      startOver();
      return json(res, 200, { ok: true });
    }
    const apiHandler = handlerFor(handlers, url.pathname);
    if (apiHandler) {
      // Offline mode has no server-side anything — allocation included, which runs
      // inside the page (scripts/offline-entry.mjs). A request arriving here would
      // mean the page is not actually running offline, so say so instead of answering.
      if (OFFLINE) return json(res, 410, { error: "Offline mode: this server answers no API calls. The app runs entirely in the browser." });
      const result = await apiHandler(await eventFrom(req, url));
      res.writeHead(result.statusCode, { ...result.headers, ...DATASET_HEADER });
      return res.end(result.body);
    }
    if (url.pathname === "/demo/meta") {
      if (OFFLINE) return json(res, 410, { error: "Offline mode: the app reads its own metadata in the browser." });
      return json(res, 200, { ...demoMeta, startedAt: STARTED_AT });
    }
    const file = path.join(root, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
    if (!file.startsWith(root)) throw new Error("Not found");
    const content = await readFile(file);
    const isIndex = path.extname(file) === ".html";
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store", ...DATASET_HEADER });
    res.end(OFFLINE && isIndex ? offlinePage(content.toString("utf8")) : content);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

// Only start listening when run directly, so tests can import `serve` and `offlinePage`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = http.createServer(serve);

  // Offline and functional mode are meant to run side by side — one to review the
  // interface, one to verify against the sandbox. They used to default to the same
  // port, so starting the second one failed with a message that named neither mode.
  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") throw error;
    const other = port === 8888 ? 8889 : 8888;
    console.error(`\nPort ${port} is already in use, so this ${OFFLINE ? "offline" : "server-mode"} demo did not start.`);
    console.error(`Something is already listening on 127.0.0.1:${port} — most likely another Hearth demo.`);
    console.error(`\n  See what it is:   lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    console.error(`  Use another port: DEMO_PORT=${other} ${OFFLINE ? "npm run demo:offline" : "npm run demo"}`);
    console.error(`  Or stop it:       kill $(lsof -t -nP -iTCP:${port} -sTCP:LISTEN)`);
    console.error(`\nBy default offline mode listens on 8889 and server mode on 8888, so both can run at once.\n`);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Hearth demo [${demoMeta.id}] ${OFFLINE ? "OFFLINE mode — no API, no credentials" : "server mode"}: http://127.0.0.1:${port}`);
    console.log("Fictional data, local storage only, no messages sent.");
    console.log(`Payments: ${payments.provider.describe()}${payments.mapping ? ` · seller ${payments.mapping.invoicer.displayName} · ${Object.keys(payments.mapping.recipients).length} sandbox recipient(s) mapped` : ""}`);
    console.log(`AI: ${ai.available ? ai.client.describe() : "off — no AI is connected (AI_MODE=off)"}`);
  });
}
