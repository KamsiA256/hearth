// The payments API end to end, against a fake provider. No network, no credentials.
//
// What these prove is the orchestration: that approval is bound to exact numbers,
// that creating and sending are separate, that a retry cannot produce or resend a
// second invoice, and that a send whose outcome is unknown is never retried blind.
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { build } from "../data/willow-court.mjs";
import { demoMeta, useDemoTables } from "../server/_shared/db.mjs";
import { createPaymentsHandler } from "../server/payments-api.mjs";
import { createPaymentStore } from "../src/payments/store.js";
import { offlineProvider } from "../src/payments/offline.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "hearth-payments-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const DEVI = "p-3a-devi", PROPERTY = "wc-3a";

// A provider that records what it was asked to do and can be told to misbehave.
function fakeProvider(options = {}) {
  const calls = { createDraft: [], send: [], get: [] };
  let invoice = { id: "INV2-TEST-0001", status: "DRAFT", detail: { metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#INV2TEST0001" } } };
  return {
    name: "fake", available: true, calls,
    describe: () => "Fake provider (tests)",
    setInvoice(next) { invoice = { ...invoice, ...next }; },
    buildInvoice: ({ line, invoiceNumber, recipientEmail }) => ({ detail: { invoice_number: invoiceNumber }, items: [{ unit_amount: { value: (line.amountCents / 100).toFixed(2) } }], recipientEmail }),
    async createDraft(body, requestId) {
      calls.createDraft.push({ body, requestId });
      if (options.createThrows) throw new Error(options.createThrows);
      return { providerInvoiceId: invoice.id, providerStatus: "DRAFT", adopted: false, raw: invoice };
    },
    async send(id, requestId, sendOptions = {}) {
      calls.send.push({ id, requestId, sendOptions });
      if (options.sendThrows) throw new Error(options.sendThrows);
      invoice = { ...invoice, status: "SENT", due_amount: { value: "680.00" }, amount: { value: "680.00" } };
      return { providerInvoiceId: id, providerStatus: invoice.status, recipientViewUrl: invoice.detail.metadata.recipient_view_url, invoice };
    },
    async get(id) {
      calls.get.push({ id });
      return { providerInvoiceId: id, providerStatus: invoice.status, recipientViewUrl: invoice.detail.metadata.recipient_view_url, invoice };
    },
  };
}

const mapping = {
  invoicer: { sandboxBusinessEmail: "sb-seller@business.example.com", givenName: "Lantern", surname: "Ridge Rentals", displayName: "Lantern Ridge Rentals" },
  recipients: { [DEVI]: "sb-devi@personal.example.com" },
  recipientFor(personId) { return this.recipients[personId] || null; },
};

let store, provider, handler, storeFile;
function mount({ providerOverride, mappingOverride, mode = "paypal_sandbox", fresh = true } = {}) {
  if (fresh) storeFile = path.join(dir, `store-${Math.random().toString(36).slice(2)}.json`);
  store = createPaymentStore({ file: storeFile });
  provider = providerOverride || fakeProvider();
  handler = createPaymentsHandler({ payments: { mode, provider, mapping: mappingOverride === undefined ? mapping : mappingOverride }, store });
  return { store, provider, handler };
}

const call = async (route, { method = "POST", body, query = {}, auth = "Bearer demo" } = {}) => {
  const result = await handler({ path: `/api/payments/${route}`, httpMethod: method, headers: { authorization: auth }, queryStringParameters: query, body: body ? JSON.stringify(body) : null });
  return { status: result.statusCode, body: JSON.parse(result.body) };
};
const allocation = async () => (await call("allocation", { method: "GET", query: { propertyId: PROPERTY } })).body;
const currentVersion = async () => (await allocation()).allocation.version;

beforeEach(() => { useDemoTables(build()); mount(); });

test("the access gate applies to payments too", async () => {
  assert.equal((await call("allocation", { method: "GET", query: { propertyId: PROPERTY }, auth: "Bearer nope" })).status, 401);
});

test("another organization's property is not found", async () => {
  assert.equal((await call("allocation", { method: "GET", query: { propertyId: "other-1" } })).status, 404);
});

test("the allocation reports the seller, the period and each share", async () => {
  const view = await allocation();
  assert.equal(view.mode, "paypal_sandbox");
  assert.equal(view.seller.email, "sb-seller@business.example.com");
  assert.equal(view.allocation.totalLabel, "$3,200.00");
  assert.equal(view.allocation.balances, true);
  assert.equal(view.blockedReason, null);
  const devi = view.lines.find((l) => l.personId === DEVI);
  assert.equal(devi.amountLabel, "$680.00");
  assert.equal(devi.recipientMapped, true);
  assert.equal(devi.recipientEmail, "sb-devi@personal.example.com");
  assert.equal(devi.invoice, null);
});

test("a resident with no sandbox recipient is reported, never substituted", async () => {
  const view = await allocation();
  const ada = view.lines.find((l) => l.personId === "p-3a-ada");
  assert.equal(ada.recipientMapped, false);
  assert.match(ada.unmappedReason, /no sandbox recipient mapped/i);
  const r = await call("draft", { body: { propertyId: PROPERTY, personId: "p-3a-ada", allocationVersion: await currentVersion() } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "RECIPIENT_NOT_MAPPED");
  assert.equal(provider.calls.createDraft.length, 0, "nothing may be sent to the provider");
});

test("offline mode refuses to create an invoice instead of faking one", async () => {
  mount({ providerOverride: offlineProvider(), mappingOverride: null, mode: "offline" });
  const version = await currentVersion();
  const r = await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "PROVIDER_UNAVAILABLE");
  assert.match(r.body.error, /offline mode/i);
  assert.equal(store.all().length, 0, "nothing is recorded for an invoice that was never created");
});

test("an allocation that does not balance blocks invoicing", async () => {
  const original = demoMeta.rentActivity[PROPERTY].entries;
  demoMeta.rentActivity[PROPERTY] = { ...demoMeta.rentActivity[PROPERTY], entries: original.map((e) => (e.personId === DEVI ? { ...e, amount: 600 } : e)) };
  try {
    const view = await allocation();
    assert.equal(view.allocation.balances, false);
    assert.match(view.blockedReason, /\$80\.00 short/);
    const r = await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: view.allocation.version } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "ALLOCATION_DOES_NOT_BALANCE");
    assert.equal(provider.calls.createDraft.length, 0);
  } finally {
    demoMeta.rentActivity[PROPERTY] = { ...demoMeta.rentActivity[PROPERTY], entries: original };
  }
});

test("an approval must name the version it authorizes", async () => {
  const missing = await call("draft", { body: { propertyId: PROPERTY, personId: DEVI } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "VERSION_REQUIRED");
  const stale = await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: "an-older-version" } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STALE_ALLOCATION");
  assert.equal(provider.calls.createDraft.length, 0);
});

test("creating a draft does not send anything", async () => {
  const r = await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: await currentVersion() } });
  assert.equal(r.status, 201);
  assert.equal(provider.calls.createDraft.length, 1);
  assert.equal(provider.calls.send.length, 0, "creating a draft must never send it");

  const review = r.body.review;
  assert.equal(review.recipient.email, "sb-devi@personal.example.com");
  assert.equal(review.amountLabel, "$680.00");
  assert.equal(review.period.label, "November 2026");
  assert.equal(review.seller.email, "sb-seller@business.example.com");
  assert.equal(review.environment, provider.describe(), "the label names the provider actually used; a fake is never called PayPal sandbox");
  assert.equal(review.invoice.providerStatus, "DRAFT");
  assert.equal(review.invoice.localState, "created");
  assert.equal(review.invoice.paymentState, "draft");

  const record = store.get({ propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI });
  assert.equal(record.providerInvoiceId, "INV2-TEST-0001");
  assert.ok(record.createRequestId, "the idempotency key is written down");
});

test("asking for the draft twice does not create a second invoice", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  const again = await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  assert.equal(again.status, 200);
  assert.equal(again.body.reused, true);
  assert.equal(provider.calls.createDraft.length, 1, "exactly one draft was ever created");
});

test("the same idempotency key is replayed on a retry", async () => {
  const version = await currentVersion();
  mount({ providerOverride: fakeProvider({ createThrows: "network blip" }) });
  const failed = await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  assert.equal(failed.status, 502);
  const firstKey = store.get({ propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI }).createRequestId;

  mount({ fresh: false });                       // same store file, working provider
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  assert.equal(provider.calls.createDraft[0].requestId, firstKey, "the retry replays the stored key");
});

test("sending needs an explicit confirmation", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  const r = await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "CONFIRMATION_REQUIRED");
  assert.equal(provider.calls.send.length, 0);
});

test("sending without a draft is refused", async () => {
  const r = await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: await currentVersion(), confirmed: true } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "NO_DRAFT");
});

test("an approval does not survive a change to the numbers", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  // The household re-splits the rent after the draft was prepared.
  const original = demoMeta.rentActivity[PROPERTY].entries;
  demoMeta.rentActivity[PROPERTY] = { ...demoMeta.rentActivity[PROPERTY], entries: original.map((e) => (e.personId === DEVI ? { ...e, amount: 700 } : e)).map((e) => (e.personId === "p-3a-cam" ? { ...e, amount: 740 } : e)) };
  try {
    const r = await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "STALE_ALLOCATION");
    assert.equal(provider.calls.send.length, 0, "an invoice approved for $680 must not go out under $700");
  } finally {
    demoMeta.rentActivity[PROPERTY] = { ...demoMeta.rentActivity[PROPERTY], entries: original };
  }
});

test("a sent invoice is recorded as sent, and never as paid", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  const r = await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, true);
  assert.equal(r.body.review.invoice.paymentState, "sent");
  assert.match(r.body.review.invoice.paymentStateLabel, /not paid/);
  assert.ok(r.body.review.invoice.recipientViewUrl, "the hosted payment link is recorded");

  const record = store.get({ propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI });
  assert.equal(record.localState, "sent");
  assert.equal(record.approvedAllocationVersion, version);
  assert.equal(record.approvedBy, "Demo operator");
  assert.ok(record.approvedAt);
});

test("sending twice does not send twice", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });
  const again = await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadySent, true);
  assert.equal(provider.calls.send.length, 1, "exactly one send ever reached the provider");
});

test("by default the send asks the provider to notify the recipient", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });
  assert.equal(provider.calls.send[0].sendOptions.notifyRecipient, true);
  const record = store.get({ propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI });
  assert.equal(record.notifyRecipient, true, "the channel choice is part of what was approved, so it is recorded");
});

test("notifyRecipient:false reaches the provider and is recorded with the approval", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  const r = await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true, notifyRecipient: false } });
  assert.equal(r.status, 200);
  assert.equal(provider.calls.send[0].sendOptions.notifyRecipient, false);
  const record = store.get({ propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI });
  assert.equal(record.notifyRecipient, false);
  // Suppressing the email must not weaken anything else: it is still sent, and sent
  // is still not paid.
  assert.equal(record.localState, "sent");
  assert.equal(record.paymentState, "sent");
});

test("the channel choice does not change the allocation version", async () => {
  // Who announces an invoice is not part of who owes what. If it changed the
  // version, picking a channel would invalidate an approval it has nothing to do with.
  const before = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: before } });
  await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: before, confirmed: true, notifyRecipient: false } });
  assert.equal(await currentVersion(), before);
});

test("asking for a draft after sending returns the sent invoice, not a new one", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });
  const r = await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  assert.equal(r.body.alreadySent, true);
  assert.equal(provider.calls.createDraft.length, 1);
});

test("a send with an unknown outcome is not recorded as sent, and not as failed", async () => {
  const version = await currentVersion();
  const shaky = fakeProvider({ sendThrows: "socket hang up" });
  mount({ providerOverride: shaky });
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  const r = await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "SEND_UNCERTAIN");
  assert.match(r.body.error, /has not recorded this as sent/i);
  const record = store.get({ propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI });
  assert.equal(record.localState, "send_uncertain");
});

test("after an uncertain send, provider state is read BEFORE any retry", async () => {
  const version = await currentVersion();
  const shaky = fakeProvider({ sendThrows: "socket hang up" });
  mount({ providerOverride: shaky });
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });

  // It turns out the invoice DID go out: the failure was on the way back.
  shaky.setInvoice({ status: "SENT", due_amount: { value: "680.00" }, amount: { value: "680.00" } });
  const sendsBefore = shaky.calls.send.length;
  const retry = await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });

  assert.equal(retry.status, 200);
  assert.equal(retry.body.alreadySent, true);
  assert.equal(retry.body.recoveredFromUncertainty, true);
  assert.equal(shaky.calls.send.length, sendsBefore, "the retry must not send again");
  assert.equal(store.get({ propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI }).localState, "sent");
});

test("refreshing resolves an uncertain send without sending anything", async () => {
  const version = await currentVersion();
  const shaky = fakeProvider({ sendThrows: "socket hang up" });
  mount({ providerOverride: shaky });
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });
  shaky.setInvoice({ status: "SENT", due_amount: { value: "680.00" }, amount: { value: "680.00" } });

  const r = await call("refresh", { body: { propertyId: PROPERTY, personId: DEVI } });
  assert.equal(r.status, 200);
  assert.equal(r.body.resolvedUncertainty, true);
  assert.equal(r.body.paymentState, "sent");
  assert.equal(shaky.calls.send.length, 1, "refresh never sends");
  assert.equal(store.get({ propertyId: PROPERTY, periodKey: "november-2026", personId: DEVI }).localState, "sent");
});

test("refresh distinguishes sent, partly paid and paid", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });

  provider.setInvoice({ status: "PARTIALLY_PAID", payments: { paid_amount: { value: "200.00" } }, due_amount: { value: "480.00" }, amount: { value: "680.00" } });
  let r = await call("refresh", { body: { propertyId: PROPERTY, personId: DEVI } });
  assert.equal(r.body.paymentState, "partially_paid");
  assert.equal(r.body.review.invoice.paidCents, 20000);
  assert.equal(r.body.review.invoice.dueCents, 48000);
  assert.match(r.body.review.invoice.paymentStateLabel, /Partly paid/);

  provider.setInvoice({ status: "PAID", payments: { paid_amount: { value: "680.00" } }, due_amount: { value: "0.00" } });
  r = await call("refresh", { body: { propertyId: PROPERTY, personId: DEVI } });
  assert.equal(r.body.paymentState, "paid");
  assert.match(r.body.review.invoice.paymentStateLabel, /Paid in full/);
});

test("refreshing before there is an invoice says so", async () => {
  const r = await call("refresh", { body: { propertyId: PROPERTY, personId: DEVI } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "NO_INVOICE");
});

test("a sent invoice survives a server restart", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });

  // Restart: fresh demo data, fresh handler, same store file on disk.
  useDemoTables(build());
  mount({ fresh: false });
  const view = await allocation();
  const devi = view.lines.find((l) => l.personId === DEVI);
  assert.equal(devi.invoice.localState, "sent");
  assert.equal(devi.invoice.providerInvoiceId, "INV2-TEST-0001");
  assert.equal(devi.invoice.paymentState, "sent");
});

test("the invoice action is written into the property's own record", async () => {
  const version = await currentVersion();
  await call("draft", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version } });
  await call("send", { body: { propertyId: PROPERTY, personId: DEVI, allocationVersion: version, confirmed: true } });
  const { db } = await import("../server/_shared/db.mjs");
  const { data } = await db().from("audit_events").select("*");
  const summaries = data.map((e) => e.metadata?.summary || "");
  assert.ok(summaries.some((s) => /draft created/i.test(s)));
  assert.ok(summaries.some((s) => /Sandbox invoice sent/i.test(s) && /Sent is not paid/i.test(s)));
});

test("every write route returns a review the panel can open", async () => {
  // The interface opens the review panel from whatever a write route returns. One
  // branch returned `record` and not `review`, so the panel read `review.invoice`
  // off undefined and rendered blank with no error at all. Reachable with two
  // operators: one prepares and sends while the other still has a stale sheet
  // showing "Prepare invoice".
  const version = await currentVersion();
  const payload = { propertyId: PROPERTY, personId: DEVI, allocationVersion: version };

  const draft = await call("draft", { body: payload });
  assert.equal(draft.status, 201);
  assert.ok(draft.body.review?.invoice, "draft must return a review");

  const sent = await call("send", { body: { ...payload, confirmed: true } });
  assert.equal(sent.status, 200);
  assert.ok(sent.body.review?.invoice, "send must return a review");

  // The branch that was broken: drafting again once it is already sent.
  const again = await call("draft", { body: payload });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadySent, true);
  assert.ok(again.body.review?.invoice, "alreadySent must ALSO return a review, or the panel breaks");
  assert.equal(again.body.review.invoice.paymentState, "sent", "and it must not claim paid");
});
