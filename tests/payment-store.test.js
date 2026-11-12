// The store exists to survive a restart. These tests are mostly about that, and
// about the one thing it must never contain.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPaymentStore } from "../src/payments/store.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "hearth-store-"));
const file = path.join(dir, "payment-store.json");
const identity = { propertyId: "wc-3a", periodKey: "november-2026", personId: "p-3a-devi" };
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { if (existsSync(file)) rmSync(file); });

test("a record survives a restart", () => {
  const first = createPaymentStore({ file });
  first.put(identity, { localState: "sent", providerInvoiceId: "INV2-ABCD", amountCents: 68000 }, { event: "send_approved" });

  // A new store instance is what a restarted server gets.
  const restarted = createPaymentStore({ file });
  const record = restarted.get(identity);
  assert.equal(record.providerInvoiceId, "INV2-ABCD");
  assert.equal(record.localState, "sent");
  assert.equal(record.amountCents, 68000);
});

test("resetting the fictional demo data cannot touch the payment store", async () => {
  // The guarantee that matters: wiping the demo's own data, which happens on every
  // restart, must not make Hearth forget an invoice PayPal actually holds.
  const store = createPaymentStore({ file });
  store.put(identity, { localState: "sent", providerInvoiceId: "INV2-KEEP" });

  const { resetDemoData, db } = await import("../server/_shared/db.mjs");
  resetDemoData();
  assert.ok((await db().from("properties").select("id")).data.length > 0, "demo data was rebuilt");

  assert.equal(createPaymentStore({ file }).get(identity).providerInvoiceId, "INV2-KEEP");
  assert.equal(store.get(identity).localState, "sent");
});

test("history accumulates instead of overwriting", () => {
  const store = createPaymentStore({ file });
  store.put(identity, { localState: "draft_proposed" }, { event: "draft_requested" });
  store.put(identity, { localState: "created" }, { event: "provider_state_read" });
  store.put(identity, { localState: "sent" }, { event: "send_approved" });
  const record = createPaymentStore({ file }).get(identity);
  assert.deepEqual(record.history.map((h) => h.event), ["draft_requested", "provider_state_read", "send_approved"]);
  assert.ok(record.history.every((h) => h.at));
});

test("credentials are refused, by field name and by shape", () => {
  const store = createPaymentStore({ file });
  assert.throws(() => store.put(identity, { client_secret: "abc" }), /credentials never go in this file/);
  assert.throws(() => store.put(identity, { accessToken: "abc" }), /credentials never go in this file/);
  assert.throws(() => store.put(identity, { PAYPAL_CLIENT_ID: "abc" }), /credentials never go in this file/);
  assert.throws(() => store.put(identity, { note: "Authorization: Bearer A1b2C3d4E5f6G7h8" }), /bearer token/);
});

test("what is written on disk contains no credential", () => {
  const store = createPaymentStore({ file });
  store.put(identity, { localState: "sent", providerInvoiceId: "INV2-ABCD", recipientEmail: "sb-x@personal.example.com", sellerEmail: "sb-y@business.example.com", createRequestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  const raw = readFileSync(file, "utf8");
  for (const pattern of [/client_?id/i, /client_?secret/i, /access_?token/i, /bearer/i, /password/i]) {
    assert.ok(!pattern.test(raw), `store file must not contain ${pattern}`);
  }
});

test("records are kept per resident, period and property", () => {
  const store = createPaymentStore({ file });
  store.put(identity, { localState: "sent" });
  store.put({ ...identity, personId: "p-3a-ada" }, { localState: "created" });
  store.put({ ...identity, periodKey: "december-2026" }, { localState: "draft_proposed" });
  assert.equal(store.all().length, 3);
  assert.equal(store.forProperty("wc-3a", "november-2026").length, 2);
  assert.equal(store.get({ ...identity, personId: "p-3a-ada" }).localState, "created");
});

test("an unreadable store stops the server instead of being overwritten", () => {
  // It may be the only local record of a real sandbox invoice.
  writeFileSync(file, "{ this is not json", "utf8");
  assert.throws(() => createPaymentStore({ file }), /unreadable/);
  assert.ok(existsSync(file), "the damaged file must be left in place");
});

test("a missing store file is simply a fresh start", () => {
  const store = createPaymentStore({ file });
  assert.equal(store.get(identity), null);
  assert.deepEqual(store.all(), []);
});
