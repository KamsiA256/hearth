// Regressions from the final pre-review scan, 2026-11-04. Each test reproduces a
// defect that was observed against 65d0dd7 before it was fixed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { build } from "../data/willow-court.mjs";
import { useDemoTables } from "../server/_shared/db.mjs";
import { createPaymentsHandler } from "../server/payments-api.mjs";
import { createAllocationHandler } from "../server/allocation-api.mjs";
import { createPaymentStore } from "../src/payments/store.js";
import { createMemoryAllocationStore } from "../src/allocation-store-memory.js";
import { parseShareCents, propertyFacts } from "../public/model.js";

const PROPERTY = "wc-3a", DEVI = "p-3a-devi";
const PEOPLE = ["p-3a-ada", "p-3a-bo", "p-3a-cam", DEVI];
const dir = mkdtempSync(path.join(os.tmpdir(), "hearth-regress-"));

function fakeProvider({ sendDelay = 0, sendThrows = null, emptyRead = false } = {}) {
  const calls = { createDraft: 0, send: 0, get: 0 };
  let invoice = { id: "INV2-TEST-0001", status: "DRAFT" };
  return {
    name: "fake", available: true, calls, describe: () => "Fake provider (tests)",
    buildInvoice: ({ line }) => ({ amountCents: line.amountCents }),
    async createDraft(body) { calls.createDraft++; return { providerInvoiceId: invoice.id, providerStatus: "DRAFT", adopted: false, body }; },
    async send(id) {
      calls.send++;
      if (sendDelay) await new Promise((r) => setTimeout(r, sendDelay));
      if (sendThrows) throw new Error(sendThrows);
      invoice = { ...invoice, status: "SENT" };
      return { providerInvoiceId: id, providerStatus: "SENT", invoice };
    },
    async get(id) {
      calls.get++;
      if (emptyRead) return { providerInvoiceId: undefined, providerStatus: undefined, invoice: {} };
      return { providerInvoiceId: id, providerStatus: invoice.status, invoice };
    },
  };
}

const mapping = {
  invoicer: { sandboxBusinessEmail: "sb-seller@business.example.com", givenName: "Test", surname: "Seller", displayName: "Test Seller" },
  recipientFor: () => "sb-resident@personal.example.com",
};

let pay, alloc, paymentStore, provider;
function mount(providerOptions) {
  const allocationStore = createMemoryAllocationStore();
  paymentStore = createPaymentStore({ file: path.join(dir, `p-${Math.random().toString(36).slice(2)}.json`) });
  provider = fakeProvider(providerOptions);
  const ph = createPaymentsHandler({ payments: { mode: "paypal_sandbox", provider, mapping }, store: paymentStore, allocationStore });
  const ah = createAllocationHandler({ store: allocationStore });
  const caller = (handler, prefix) => async (method, route, body) => {
    if (prefix === "/api/allocation/" && method === "POST" && body && !("versionCanonical" in body)) {
      const shown = await handler({ path: `${prefix}workspace`, httpMethod: "GET", headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: null });
      body = { ...body, versionCanonical: JSON.parse(shown.body).version?.canonical };
    }
    const r = await handler({ path: `${prefix}${route}`, httpMethod: method, headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: body ? JSON.stringify({ propertyId: PROPERTY, ...body }) : null });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  pay = caller(ph, "/api/payments/");
  alloc = caller(ah, "/api/allocation/");
}
beforeEach(() => { useDemoTables(build()); mount(); });

const paymentsVersion = async () => (await pay("GET", "allocation")).body.allocation.version;
const devisAmount = async () => (await pay("GET", "allocation")).body.lines.find((l) => l.personId === DEVI).amountCents;

async function reviseAndApprove() {
  await alloc("POST", "share", { personId: DEVI, amountCents: 50000 });
  await alloc("POST", "share", { personId: "p-3a-ada", amountCents: 108000 }); // back to $3,200
  await alloc("POST", "publish", {});
  for (const personId of PEOPLE) await alloc("POST", "confirm", { personId });
  const approved = await alloc("POST", "approve", {});
  assert.equal(approved.status, 200);
}

test("regression: payments use the workspace's current split, not the dataset seed", async () => {
  await alloc("POST", "share", { personId: DEVI, amountCents: 50000 }); // unbalanced draft v2
  const view = await pay("GET", "allocation");
  assert.equal(await devisAmount(), 50000);
  assert.equal(view.body.allocation.balances, false);
  const draft = await pay("POST", "draft", { personId: DEVI, allocationVersion: view.body.allocation.version });
  assert.equal(draft.status, 409, "an unbalanced draft must not be invoiced at the seed amount");
  assert.equal(provider.calls.createDraft, 0);
});

test("regression: a balanced but unapproved revision cannot be invoiced", async () => {
  await alloc("POST", "share", { personId: DEVI, amountCents: 50000 });
  await alloc("POST", "share", { personId: "p-3a-ada", amountCents: 108000 });
  const draft = await pay("POST", "draft", { personId: DEVI, allocationVersion: await paymentsVersion() });
  assert.equal(draft.status, 409);
  assert.equal(draft.body.code, "NOT_APPROVED");
  await alloc("POST", "publish", {});
  const proposed = await pay("POST", "draft", { personId: DEVI, allocationVersion: await paymentsVersion() });
  assert.equal(proposed.body.code, "NOT_APPROVED", "published but unconfirmed is still not approved");
  assert.equal(provider.calls.createDraft, 0);
});

test("regression: an approved revision is invoiced at the approved amount", async () => {
  await reviseAndApprove();
  const workspace = await alloc("GET", "workspace");
  assert.equal(await paymentsVersion(), workspace.body.version.canonical, "payments and the workspace agree on the version");
  const draft = await pay("POST", "draft", { personId: DEVI, allocationVersion: workspace.body.version.canonical });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.review.amountCents, 50000);
});

test("regression: two concurrent sends reach the provider once", async () => {
  mount({ sendDelay: 30 });
  const version = await paymentsVersion();
  assert.equal((await pay("POST", "draft", { personId: DEVI, allocationVersion: version })).status, 201);
  const [a, b] = await Promise.all([
    pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true }),
    pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(provider.calls.send, 1);
});

test("regression: an empty provider read after an uncertain send stays UNKNOWN and keeps the invoice id", async () => {
  mount({ sendThrows: "socket timeout" });
  const version = await paymentsVersion();
  await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
  const sent = await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true });
  assert.equal(sent.body.code, "SEND_UNCERTAIN");
  // Now the provider answers with an empty body.
  const identity = { propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI };
  const before = paymentStore.get(identity).providerInvoiceId;
  const emptyProvider = fakeProvider({ emptyRead: true });
  provider.get = emptyProvider.get;
  const refreshed = await pay("POST", "refresh", { personId: DEVI });
  assert.equal(refreshed.body.resolvedUncertainty, false);
  const record = paymentStore.get(identity);
  assert.equal(record.localState, "send_uncertain", "an empty read must not be guessed as SENT");
  assert.equal(record.providerInvoiceId, before, "the invoice id must survive an empty read");
  const retry = await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true });
  assert.equal(retry.body.code, "SEND_UNCERTAIN", "a retry after an empty read does not resend");
  assert.equal(provider.calls.send, 1);
});

test("regression: share input rejects text, minus signs, blanks and sub-cent amounts", () => {
  for (const bad of ["abc", "", "  ", "-1300", "1300.555", "12e2", "1.2.3", "$", "1,30,0"]) {
    assert.equal(parseShareCents(bad), null, `"${bad}" must be refused`);
  }
  assert.equal(parseShareCents("1300"), 130000);
  assert.equal(parseShareCents("1,300.50"), 130050);
  assert.equal(parseShareCents("$680"), 68000);
  assert.equal(parseShareCents("19.99"), 1999);
  assert.equal(parseShareCents("0.1"), 10);
  assert.equal(parseShareCents("0"), 0);
});

test("regression: a lease with no dates shows no term rather than dashes", () => {
  const property = { people: [], lease_groups: [{ id: "g", term_start: null, term_end: null }], active_lease_group_id: "g" };
  assert.equal(propertyFacts(property, (d) => d || "—").term, null);
});

// ---- Found by the second, adversarial review of the first repair. ----

function allocationWithInvoices() {
  // Wire the allocation API to the payment store the way demo-server.mjs does.
  const allocationStore = createMemoryAllocationStore();
  paymentStore = createPaymentStore({ file: path.join(dir, `p-${Math.random().toString(36).slice(2)}.json`) });
  provider = fakeProvider();
  const ph = createPaymentsHandler({ payments: { mode: "paypal_sandbox", provider, mapping }, store: paymentStore, allocationStore });
  const ah = createAllocationHandler({ store: allocationStore, invoicesFor: (p, k) => paymentStore.forProperty(p, k) });
  const caller = (handler, prefix) => async (method, route, body) => {
    if (prefix === "/api/allocation/" && method === "POST" && body && !("versionCanonical" in body)) {
      const shown = await handler({ path: `${prefix}workspace`, httpMethod: "GET", headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: null });
      body = { ...body, versionCanonical: JSON.parse(shown.body).version?.canonical };
    }
    const r = await handler({ path: `${prefix}${route}`, httpMethod: method, headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: body ? JSON.stringify({ propertyId: PROPERTY, ...body }) : null });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  pay = caller(ph, "/api/payments/"); alloc = caller(ah, "/api/allocation/");
  return allocationStore;
}

test("regression: once a period is invoiced the split cannot be revised into a second invoice", async () => {
  allocationWithInvoices();
  const version = await paymentsVersion();
  await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
  await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true });
  const edit = await alloc("POST", "share", { personId: DEVI, amountCents: 50000 });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, "HAS_INVOICES");
  assert.equal(provider.calls.send, 1);
});

test("regression: a draft is refused while an invoice for other numbers exists", async () => {
  const allocationStore = allocationWithInvoices();
  const v1 = await paymentsVersion();
  await pay("POST", "draft", { personId: DEVI, allocationVersion: v1 });
  // Simulate the split having moved on underneath an existing invoice.
  const key = { propertyId: PROPERTY, periodKey: "november-2026" };
  const view = (await alloc("GET", "workspace")).body;
  const lines = Object.fromEntries(view.lines.map((l) => [l.personId, l.amountCents]));
  lines[DEVI] = 50000; lines["p-3a-ada"] += 18000;
  allocationStore.putVersion(key, { n: 2, state: "agreed", lines }, { event: "test" });
  const v2 = await paymentsVersion();
  assert.notEqual(v1, v2);
  const draft = await pay("POST", "draft", { personId: DEVI, allocationVersion: v2 });
  assert.equal(draft.body.code, "INVOICE_EXISTS_FOR_OTHER_NUMBERS");
  const send = await pay("POST", "send", { personId: DEVI, allocationVersion: v2, confirmed: true });
  assert.equal(send.status, 409, "the old draft must not be sent as the new version's invoice");
  assert.equal(provider.calls.createDraft, 1);
  assert.equal(provider.calls.send, 0);
});

test("regression: a draft racing a send for the same resident reaches the provider once", async () => {
  mount({ sendDelay: 30 });
  const version = await paymentsVersion();
  await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
  const results = await Promise.all([
    pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true }),
    pay("POST", "draft", { personId: DEVI, allocationVersion: version }),
  ]);
  assert.equal(results.filter((r) => r.body.code === "IN_PROGRESS").length, 1);
  assert.equal(provider.calls.send, 1);
});

test("regression: a provider read naming a different invoice is not adopted", async () => {
  mount({ sendThrows: "socket timeout" });
  const version = await paymentsVersion();
  await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
  await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true });
  provider.get = async () => ({ providerInvoiceId: "INV2-SOMEONE-ELSE", providerStatus: "SENT", invoice: { status: "SENT" } });
  await pay("POST", "refresh", { personId: DEVI });
  const record = paymentStore.get({ propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI });
  assert.equal(record.providerInvoiceId, "INV2-TEST-0001");
  assert.equal(record.localState, "send_uncertain");
  const retry = await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true });
  assert.notEqual(retry.body.sent, true);
  assert.equal(provider.calls.send, 1);
});

test("regression: shares must be safe whole cents no larger than the rent", async () => {
  for (const amountCents of [1e22, 9007199254740993, 320001]) {
    assert.equal((await alloc("POST", "share", { personId: DEVI, amountCents })).status, 400, String(amountCents));
  }
  assert.equal(parseShareCents("99999999999999999999"), null);
  assert.equal(parseShareCents("999,999,999.99"), 99999999999);
});

// ---- Third round: audits of 570d009. ----
import { PayPalSandbox } from "../src/payments/paypal-sandbox.js";
import { paymentStateOf } from "../src/payments/state.js";
import { isVerifiedAbsence } from "../public/model.js";

const IDENTITY = { propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI };

function mountWith(providerOverride, mappingOverride = mapping) {
  const allocationStore = createMemoryAllocationStore();
  paymentStore = createPaymentStore({ file: path.join(dir, `p-${Math.random().toString(36).slice(2)}.json`) });
  provider = providerOverride;
  const ph = createPaymentsHandler({ payments: { mode: "paypal_sandbox", provider, mapping: mappingOverride }, store: paymentStore, allocationStore });
  pay = async (method, route, body) => {
    const r = await ph({ path: `/api/payments/${route}`, httpMethod: method, headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: body ? JSON.stringify({ propertyId: PROPERTY, ...body }) : null });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
}

test("regression: a draft made for one address is never reused or sent after the mapping changes", async () => {
  const live = { ...mapping, current: "sb-old@personal.example.com", recipientFor() { return this.current; } };
  mountWith(fakeProvider(), live);
  const version = await paymentsVersion();
  assert.equal((await pay("POST", "draft", { personId: DEVI, allocationVersion: version })).status, 201);
  live.current = "sb-new@personal.example.com";
  const again = await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
  assert.equal(again.body.code, "RECIPIENT_CHANGED");
  const send = await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true });
  assert.equal(send.body.code, "RECIPIENT_CHANGED");
  assert.equal(provider.calls.send, 0, "no provider send");
  assert.equal(provider.calls.createDraft, 1, "no silent re-create");
  // Whatever the panel shows for the existing draft is the address it was made for.
  const refreshed = await pay("POST", "refresh", { personId: DEVI });
  assert.equal(refreshed.body.review.recipient.email, "sb-old@personal.example.com");
  assert.ok(!JSON.stringify(refreshed.body.review).includes("sb-new@"), "the new address is never shown for the old draft");
});

for (const [label, reply] of [
  ["still DRAFT", (id) => ({ providerInvoiceId: id, providerStatus: "DRAFT", invoice: { status: "DRAFT" } })],
  ["empty", () => ({ providerInvoiceId: undefined, providerStatus: undefined, invoice: {} })],
  ["a different invoice", () => ({ providerInvoiceId: "INV2-OTHER", providerStatus: "SENT", invoice: { status: "SENT" } })],
]) {
  test(`regression: a send whose read-back is ${label} is recorded UNKNOWN, not SENT, and is not retried`, async () => {
    const p = fakeProvider();
    p.send = async (id) => { p.calls.send++; return reply(id); };
    mountWith(p);
    const version = await paymentsVersion();
    await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
    const sent = await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true });
    assert.equal(sent.status, 502);
    assert.equal(sent.body.code, "SEND_UNCERTAIN");
    const record = paymentStore.get(IDENTITY);
    assert.equal(record.localState, "send_uncertain");
    assert.equal(record.providerInvoiceId, "INV2-TEST-0001");
    assert.equal(p.calls.send, 1, "never retried automatically");
  });
}

const fakeCreds = { clientId: "test-id", clientSecret: "test-secret", env: "sandbox" };
const hang = () => new Promise(() => {});
const okToken = { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "t", expires_in: 3600 }) };

test("regression: a PayPal request that never answers times out as an unknown outcome", async () => {
  const client = new PayPalSandbox({ ...fakeCreds, timeoutMs: 50, fetchImpl: (url) => (url.endsWith("/token") ? Promise.resolve(okToken) : hang()) });
  await assert.rejects(client.get("INV2-X"), (error) => error.name === "PayPalTimeoutError" && error.outcomeUnknown === true);
});

test("regression: a token request that never answers times out", async () => {
  const client = new PayPalSandbox({ ...fakeCreds, timeoutMs: 50, fetchImpl: hang });
  await assert.rejects(client.get("INV2-X"), { name: "PayPalTimeoutError" });
});

test("regression: a response body that never finishes times out", async () => {
  const client = new PayPalSandbox({ ...fakeCreds, timeoutMs: 50, fetchImpl: async (url) => (url.endsWith("/token") ? okToken : { ok: true, status: 200, text: hang }) });
  await assert.rejects(client.get("INV2-X"), { name: "PayPalTimeoutError" });
});

test("regression: a send that times out lands in the uncertain-send path, not failed or sent", async () => {
  const p = fakeProvider();
  const client = new PayPalSandbox({ ...fakeCreds, timeoutMs: 50, fetchImpl: (url) => (url.endsWith("/token") ? Promise.resolve(okToken) : hang()) });
  p.send = async (id, requestId) => { p.calls.send++; return client.send(id, requestId); };
  mountWith(p);
  const version = await paymentsVersion();
  await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
  const sent = await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true });
  assert.equal(sent.body.code, "SEND_UNCERTAIN");
  assert.equal(paymentStore.get(IDENTITY).localState, "send_uncertain");
});

for (const route of ["share", "publish", "confirm", "approve"]) {
  test(`regression: allocation ${route} refuses a missing or stale version`, async () => {
    mount();
    const raw = createAllocationHandler({ store: createMemoryAllocationStore() });
    const post = async (body) => {
      const r = await raw({ path: `/api/allocation/${route}`, httpMethod: "POST", headers: { authorization: "Bearer demo" }, queryStringParameters: {}, body: JSON.stringify({ propertyId: PROPERTY, personId: DEVI, amountCents: 60000, ...body }) });
      return { status: r.statusCode, body: JSON.parse(r.body) };
    };
    const missing = await post({});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, "VERSION_REQUIRED");
    const stale = await post({ versionCanonical: '{"stale":true}' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "STALE_VERSION");
  });
}

test("regression: PAID with money still due and no payment recorded is not shown as paid", () => {
  for (const payments of [undefined, { paid_amount: { value: "0.00" } }]) {
    const s = paymentStateOf({ status: "PAID", due_amount: { value: "680.00" }, amount: { value: "680.00" }, payments });
    assert.equal(s.state, "unknown");
    assert.equal(s.isPaidInFull, false);
  }
  assert.equal(paymentStateOf({ status: "PAID", due_amount: { value: "0.00" }, payments: { paid_amount: { value: "680.00" } } }).state, "paid");
  const marked = paymentStateOf({ status: "MARKED_AS_PAID", due_amount: { value: "50.00" } });
  assert.equal(marked.state, "unknown", "marked paid with money still due is not paid in full");
  assert.equal(marked.isPaidInFull, false);
});

test("regression: only a 404 or NO_PERIOD counts as absence; failures do not", () => {
  assert.equal(isVerifiedAbsence({ status: 404 }), true);
  assert.equal(isVerifiedAbsence({ status: 409, code: "NO_PERIOD" }), true);
  for (const failure of [{ status: 500 }, { status: 502 }, new TypeError("Failed to fetch"), { status: 409, code: "STALE_VERSION" }, null]) {
    assert.equal(isVerifiedAbsence(failure), false);
  }
});

test("regression: a draft that was never sent is not counted as sent or issued", async () => {
  const { allocationStatus, workspaceFor } = await import("../src/allocation-state.js");
  const { allocationFor } = await import("../src/allocation.js");
  const { demoMeta } = await import("../server/_shared/db.mjs");
  const tables = build();
  const activity = demoMeta.rentActivity[PROPERTY];
  const people = tables.people.filter((p) => p.property_id === PROPERTY);
  const snapshot = allocationFor({ propertyId: PROPERTY, activity, people });
  const workspace = workspaceFor({ activity, stored: null });
  const draftOnly = [{ personId: DEVI, providerInvoiceId: "SIM-1", localState: "created" }];
  const status = allocationStatus({ snapshot, workspace, invoices: draftOnly, provider: { available: true, mappedCount: 4 } });
  assert.match(status.headline, /4 invoices not yet sent/);
  assert.match(status.detail, /1 draft prepared, not sent/);
});

test("regression: checking an unknown send that PayPal proves is still DRAFT re-opens a deliberate send", async () => {
  const p = fakeProvider();
  p.send = async () => { p.calls.send++; return { providerInvoiceId: undefined, providerStatus: undefined, invoice: {} }; };
  mountWith(p);
  const version = await paymentsVersion();
  await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
  assert.equal((await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true })).body.code, "SEND_UNCERTAIN");
  const check = await pay("POST", "refresh", { personId: DEVI });
  assert.equal(check.body.resolvedUncertainty, true);
  assert.equal(paymentStore.get(IDENTITY).localState, "created", "proven DRAFT: not sent, may be sent deliberately");
  assert.equal(p.calls.send, 1, "checking never sends");
});

// ---- Fourth round: the offline reviewer build. ----
import { createHash as nodeHash } from "node:crypto";
import { sha256Hex } from "../scripts/reviewer-shims/crypto.mjs";

test("reviewer build: the in-page SHA-256 matches node:crypto, so invoice numbers match the server", () => {
  for (const text of ["", "abc", "invoice-number\u0000wc-3a\u0000november-2026\u0000p-3a-devi", "é✓ 💸".repeat(40), "x".repeat(1000)]) {
    assert.equal(sha256Hex(text), nodeHash("sha256").update(text).digest("hex"));
  }
});

test("reviewer build: only the offline demo provider is flagged simulated; others never are", async () => {
  mountWith(fakeProvider());
  const version = await paymentsVersion();
  const draft = await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
  assert.equal(draft.body.review.simulated, false);
  const demo = { ...fakeProvider(), name: "offline_demo", describe: () => "OFFLINE DEMO" };
  mountWith(demo);
  const demoDraft = await pay("POST", "draft", { personId: DEVI, allocationVersion: await paymentsVersion() });
  assert.equal(demoDraft.body.review.simulated, true);
  assert.match(demoDraft.body.review.environment, /OFFLINE DEMO/);
});

test("reviewer build: static, offline, labelled, and free of real-listing text, PayPal hosts and network calls", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, readdirSync } = await import("node:fs");
  const out = path.join(dir, `reviewer-${Math.random().toString(36).slice(2)}`);
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-reviewer.mjs", import.meta.url))], { env: { ...process.env, REVIEWER_OUT: out }, stdio: "pipe" });
  const html = readFileSync(path.join(out, "index.html"), "utf8");
  assert.match(html, /data-hearth-mode="offline"/);
  assert.match(html, /OFFLINE REVIEW DEMO/);
  assert.doesNotMatch(html, /(href|src)="\//, "relative paths only, so it opens from file://");
  assert.match(html, /<script defer src="app.js"><\/script>/, "a classic script, not a module");
  const runtime = readFileSync(path.join(out, "app.js"), "utf8").toLowerCase();
  for (const forbidden of ["meeting-demo", "example lane", "paypal.com", "xmlhttprequest", "sendbeacon", "eventsource", "websocket("]) {
    assert.ok(!runtime.includes(forbidden), `bundle must not contain ${forbidden}`);
  }
  assert.ok(runtime.includes("simulated paypal"), "the simulated provider is labelled");
  assert.ok(readdirSync(out).includes("demo-media"));
});

test("regression: with the offline demo provider, history never says Sandbox or that PayPal emailed anyone", async () => {
  const { db } = await import("../server/_shared/db.mjs");
  const demo = { ...fakeProvider(), name: "offline_demo", describe: () => "OFFLINE DEMO · simulated PayPal" };
  mountWith(demo);
  const version = await paymentsVersion();
  await pay("POST", "draft", { personId: DEVI, allocationVersion: version });
  await pay("POST", "send", { personId: DEVI, allocationVersion: version, confirmed: true });
  const { data } = await db().from("audit_events").select("*").eq("entity_id", PROPERTY);
  const summaries = (data || []).map((e) => e.metadata?.summary).filter(Boolean);
  assert.ok(summaries.length >= 2, "both invoice events are in the history");
  for (const text of summaries) {
    assert.ok(!/PayPal|Sandbox/.test(text), `history must not claim PayPal or sandbox: ${text}`);
    assert.match(text, /offline demo/);
  }
});
