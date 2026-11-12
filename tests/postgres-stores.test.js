// The hosted stores against a real Postgres, run in-process by PGlite: no server,
// no network, no credentials.
//
// Hosted, every request may land on a different server, and no two servers share
// memory. Each "server" below is its own store loaded from the same database, which
// is exactly that situation. What these prove is that the guarantees the local
// stores give within one process still hold between servers: a change survives into
// the next request, a lost race is refused rather than overwriting, and one
// resident's invoice cannot be drafted or sent by two servers at once.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { build } from "../data/willow-court.mjs";
import { useDemoTables } from "../server/_shared/db.mjs";
import { createPaymentsHandler } from "../server/payments-api.mjs";
import { ConcurrentWriteError, createLock, ensureSchema, loadAllocationStore, loadPaymentStore } from "../src/postgres-stores.js";
import { createHostedHandler } from "../api/hearth.mjs";

const PROPERTY = "wc-3a", DEVI = "p-3a-devi", PERIOD = "november-2026";
const ENTRY = { propertyId: PROPERTY, periodKey: PERIOD };
const RECORD = { ...ENTRY, personId: DEVI };

// One database for the file, emptied before each test: starting Postgres is the
// slow part, and the mutation audit runs this whole suite once per mutation.
const pg = new PGlite();
const query = async (sql, params) => {
  const result = await pg.query(sql, params);
  return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
};
await ensureSchema(query);
beforeEach(async () => { await query("truncate hearth_documents, hearth_locks"); useDemoTables(build()); });
after(() => pg.close());

const versionOf = async (kind, key) => (await query("select version from hearth_documents where kind = $1 and key = $2", [kind, key])).rows[0]?.version;

test("a change one server makes is what the next server reads", async () => {
  const first = await loadPaymentStore(query);
  first.put(RECORD, { localState: "created", providerInvoiceId: "INV2-TEST-0001" }, { event: "draft_created" });
  await first.flush();

  const second = await loadPaymentStore(query);
  assert.equal(second.get(RECORD).providerInvoiceId, "INV2-TEST-0001");
  assert.equal(second.get(RECORD).history.length, 1);
});

test("a request that only reads writes nothing", async () => {
  const writer = await loadAllocationStore(query);
  writer.putVersion(ENTRY, { n: 1, state: "draft", lines: { [DEVI]: 68000 } }, { event: "share_set" });
  await writer.flush();

  const reader = await loadAllocationStore(query);
  assert.equal(reader.get(ENTRY).versions.length, 1);
  await reader.flush();
  assert.equal(await versionOf("allocation", `${PROPERTY}:${PERIOD}`), 1);
});

test("two servers changing the same split: the second is refused, the first survives", async () => {
  const seed = await loadAllocationStore(query);
  seed.putVersion(ENTRY, { n: 1, state: "proposed", lines: { [DEVI]: 68000 } }, { event: "published" });
  await seed.flush();

  const a = await loadAllocationStore(query);
  const b = await loadAllocationStore(query);
  a.putConfirmation(ENTRY, { personId: DEVI, versionCanonical: "A", versionLabel: "v1" }, { event: "confirmed" });
  b.putConfirmation(ENTRY, { personId: "p-3a-ada", versionCanonical: "A", versionLabel: "v1" }, { event: "confirmed" });
  await a.flush();
  await assert.rejects(b.flush(), ConcurrentWriteError);

  const after = await loadAllocationStore(query);
  assert.deepEqual(Object.keys(after.get(ENTRY).confirmations), [DEVI]);
});

test("two servers creating the same record for the first time: the second is refused", async () => {
  const a = await loadPaymentStore(query);
  const b = await loadPaymentStore(query);
  a.put(RECORD, { localState: "draft_proposed" }, { event: "draft_requested" });
  b.put(RECORD, { localState: "draft_proposed" }, { event: "draft_requested" });
  await a.flush();
  await assert.rejects(b.flush(), ConcurrentWriteError);
});

test("the payment store still refuses credentials when it lives in Postgres", async () => {
  const store = await loadPaymentStore(query);
  assert.throws(() => store.put(RECORD, { client_secret: "nope" }), /credentials never go in this file/);
});

test("the lock is held across servers, released by its holder, and taken over only when stale", async () => {
  const serverA = createLock(query), serverB = createLock(query);
  const release = await serverA.acquire("wc-3a:p-3a-devi");
  assert.ok(release);
  assert.equal(await serverB.acquire("wc-3a:p-3a-devi"), null);
  await release();
  assert.ok(await serverB.acquire("wc-3a:p-3a-devi"));

  // A holder killed mid-request never releases. Once its marker is older than any
  // request can run, the next server takes over — and the dead holder's late
  // release cannot remove the new holder's marker.
  const quick = createLock(query, { staleAfterSeconds: 0 });
  const stale = await quick.acquire("wc-3a:p-3a-ada");
  await new Promise((resolve) => setTimeout(resolve, 20)); // older than "now", by a clock tick
  const takeover = await quick.acquire("wc-3a:p-3a-ada");
  assert.ok(takeover);
  await stale();
  assert.equal(await createLock(query).acquire("wc-3a:p-3a-ada"), null);
});

// A provider that holds every call until told to continue, and checks, when sent
// to, what the database already says.
function slowProvider() {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const calls = { createDraft: 0, send: 0, storedAtSend: null };
  let status = "DRAFT";
  const read = () => ({ providerInvoiceId: "INV2-TEST-0001", providerStatus: status, invoice: { status, amount: { value: "680.00" }, due_amount: { value: "680.00" } } });
  return {
    name: "fake", available: true, calls, open,
    describe: () => "Slow fake provider (tests)",
    buildInvoice: ({ line }) => ({ amountCents: line.amountCents }),
    async createDraft() { calls.createDraft += 1; await gate; return { providerInvoiceId: "INV2-TEST-0001", providerStatus: "DRAFT", adopted: false }; },
    async send() {
      calls.send += 1;
      calls.storedAtSend = (await loadPaymentStore(query)).get(RECORD)?.localState;
      status = "SENT";
      return read();
    },
    async get() { return read(); },
  };
}

const mapping = {
  invoicer: { sandboxBusinessEmail: "sb-seller@business.example.com", givenName: "Lantern", surname: "Ridge Rentals", displayName: "Lantern Ridge Rentals" },
  recipients: { [DEVI]: "sb-devi@personal.example.com" },
  recipientFor(personId) { return this.recipients[personId] || null; },
};

// One request on one server: load the stores, handle, flush — as api/hearth.mjs does.
async function server(provider, lock) {
  const store = await loadPaymentStore(query);
  const handler = createPaymentsHandler({ payments: { mode: "paypal_sandbox", provider, mapping }, store, lock });
  return async (route, body) => {
    const result = await handler({ path: `/api/payments/${route}`, httpMethod: body ? "POST" : "GET", headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: body ? JSON.stringify(body) : null });
    await store.flush();
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
}

test("two servers cannot both draft one resident's invoice", async () => {
  const provider = slowProvider();
  const version = (await (await server(provider, createLock(query)))("allocation")).body.allocation.version;
  const a = await server(provider, createLock(query));
  const b = await server(provider, createLock(query));

  const first = a("draft", { propertyId: PROPERTY, personId: DEVI, allocationVersion: version });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = await b("draft", { propertyId: PROPERTY, personId: DEVI, allocationVersion: version });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "IN_PROGRESS");

  provider.open();
  assert.equal((await first).status, 201);
  assert.equal(provider.calls.createDraft, 1);
  assert.equal((await loadPaymentStore(query)).get(RECORD).localState, "created");
});

test("a send is recorded as uncertain in the database before PayPal is asked", async () => {
  const provider = slowProvider();
  provider.open();
  const lock = createLock(query);
  const version = (await (await server(provider, lock))("allocation")).body.allocation.version;
  await (await server(provider, lock))("draft", { propertyId: PROPERTY, personId: DEVI, allocationVersion: version });
  const sent = await (await server(provider, lock))("send", { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true });

  assert.equal(sent.status, 200);
  // A server killed during the send leaves this behind, so the next attempt reads
  // PayPal before doing anything.
  assert.equal(provider.calls.storedAtSend, "send_uncertain");
  assert.equal((await loadPaymentStore(query)).get(RECORD).localState, "sent");
});

const request = (path, { method = "GET", body, code = "demo" } = {}) => new Request(`https://hearth.test/api/hearth?__path=${encodeURIComponent(path)}&propertyId=${PROPERTY}`, {
  method, body: body && JSON.stringify(body), headers: { authorization: `Bearer ${code}`, "content-type": "application/json" },
});
const OFFLINE_ENV = { PAYMENTS_MODE: "offline", AI_MODE: "off" };

test("hosted: a split edited through one server is shown by another", async () => {
  const one = createHostedHandler({ query, env: OFFLINE_ENV });
  const two = createHostedHandler({ query, env: OFFLINE_ENV });

  const shown = await (await one(request("/api/allocation/workspace"))).json();
  const edited = await one(request("/api/allocation/share", { method: "POST", body: { propertyId: PROPERTY, personId: DEVI, amountCents: 67000, versionCanonical: shown.version.canonical } }));
  assert.equal(edited.status, 200);

  const elsewhere = await (await two(request("/api/allocation/workspace"))).json();
  assert.equal(elsewhere.lines.find((line) => line.personId === DEVI).amountCents, 67000);
});

test("hosted: starting over clears every rent split and invoice record, and needs the code", async () => {
  const hosted = createHostedHandler({ query, env: OFFLINE_ENV });
  const shown = await (await hosted(request("/api/allocation/workspace"))).json();
  await hosted(request("/api/allocation/share", { method: "POST", body: { propertyId: PROPERTY, personId: DEVI, amountCents: 67000, versionCanonical: shown.version.canonical } }));
  await query("insert into hearth_documents (kind, key, data) values ('payment', 'an-invoice', '{}'::jsonb)");
  const count = async () => (await query("select count(*)::int as n from hearth_documents")).rows[0].n;
  assert.ok(await count() >= 2);

  assert.equal((await hosted(request("/api/demo/start-over", { method: "POST", code: "nope" }))).status, 401);
  assert.ok(await count() >= 2);
  assert.equal((await hosted(request("/api/demo/start-over", { method: "POST" }))).status, 200);
  assert.equal(await count(), 0);
  const fresh = await (await hosted(request("/api/allocation/workspace"))).json();
  assert.notEqual(fresh.lines.find((line) => line.personId === DEVI).amountCents, 67000);
});

test("hosted: the gate, the metadata, and a missing database are all reported plainly", async () => {
  const hosted = createHostedHandler({ query, env: OFFLINE_ENV });
  assert.equal((await hosted(request("/api/operator/properties", { code: "nope" }))).status, 401);

  const meta = await (await hosted(request("/demo/meta"))).json();
  assert.match(meta.storageNote, /saved for everyone using this link/);

  const unconnected = await createHostedHandler({ query: null, env: OFFLINE_ENV })(request("/api/allocation/workspace"));
  assert.equal(unconnected.status, 500);
  assert.equal((await unconnected.json()).code, "NOT_CONFIGURED");
});

test("hosted: a configuration error is answered, not hidden", async () => {
  // Malformed on purpose, so the result cannot depend on a mapping file on this machine.
  const hosted = createHostedHandler({ query, env: { PAYMENTS_MODE: "paypal_sandbox", SANDBOX_RECIPIENTS_JSON: "not json", AI_MODE: "off" } });
  const result = await hosted(request("/api/allocation/workspace"));
  assert.equal(result.status, 500);
  assert.match((await result.json()).error, /not configured/);
});

test("hosted: with AI or invoicing on, the built-in code opens it; no code of your own is required", async () => {
  // A key that is never used: nothing here reaches a model.
  const spending = { PAYMENTS_MODE: "offline", AI_MODE: "anthropic", ANTHROPIC_API_KEY: "unused-in-tests" };
  const result = await createHostedHandler({ query, env: spending })(request("/api/allocation/workspace"));
  assert.notEqual((await result.json()).code, "NOT_CONFIGURED");
});

test("hosted: a request without the code, and the operator screens, never reach the database", async () => {
  let queries = 0;
  const counted = async (sql, params) => { queries += 1; return query(sql, params); };
  const hosted = createHostedHandler({ query: counted, env: OFFLINE_ENV });

  assert.equal((await hosted(request("/api/allocation/workspace", { code: "nope" }))).status, 401);
  assert.equal((await hosted(request("/api/operator/properties"))).status, 200);
  assert.equal(queries, 0);

  assert.equal((await hosted(request("/api/allocation/workspace"))).status, 200);
  assert.ok(queries > 0);
});

test("hosted: the banner does not claim storage is local", async () => {
  const meta = await (await createHostedHandler({ query, env: OFFLINE_ENV })(request("/demo/meta"))).json();
  assert.doesNotMatch(meta.disclaimer, /local storage/);
  assert.match(meta.disclaimer, /no messages sent/);
});
