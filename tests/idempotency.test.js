import { test } from "node:test";
import assert from "node:assert/strict";
import { idempotencyKey, recordKey } from "../src/payments/idempotency.js";

const base = { scope: "invoice-create", propertyId: "wc-3a", periodKey: "november-2026", personId: "p-3a-devi", allocationVersion: '{"property":"wc-3a","total":320000}', destination: "devi@example.test" };

test("the key is a UUID-shaped 36 characters, inside PayPal's 38-character limit", () => {
  const key = idempotencyKey(base);
  assert.equal(key.length, 36);
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("the key is derived, so a restart regenerates the same one", () => {
  // This is the point: a random key lost to a crash would let a retry create a
  // second invoice. The same logical operation always yields the same key.
  assert.equal(idempotencyKey(base), idempotencyKey({ ...base }));
});

test("a different resident, period, property or scope is a different key", () => {
  const key = idempotencyKey(base);
  assert.notEqual(key, idempotencyKey({ ...base, personId: "p-3a-ada" }));
  assert.notEqual(key, idempotencyKey({ ...base, periodKey: "december-2026" }));
  assert.notEqual(key, idempotencyKey({ ...base, propertyId: "wc-5b" }));
  assert.notEqual(key, idempotencyKey({ ...base, scope: "invoice-send" }));
});

test("a changed allocation is a different logical operation and a different key", () => {
  // Reusing a key across amounts would make PayPal replay the OLD invoice for NEW
  // numbers, which is the worst possible outcome of getting this wrong.
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, allocationVersion: '{"property":"wc-3a","total":320001}' }));
});

test("create and send get separate keys for the same invoice", () => {
  assert.notEqual(idempotencyKey({ ...base, scope: "invoice-create" }), idempotencyKey({ ...base, scope: "invoice-send" }));
});

test("components cannot run together to collide", () => {
  // "ab"+"c" must not equal "a"+"bc" for any pair of fields.
  assert.notEqual(idempotencyKey({ ...base, propertyId: "wc", periodKey: "3anovember" }), idempotencyKey({ ...base, propertyId: "wc3a", periodKey: "november" }));
});

test("every component is required", () => {
  for (const field of ["scope", "propertyId", "periodKey", "personId", "allocationVersion", "destination"]) {
    assert.throws(() => idempotencyKey({ ...base, [field]: undefined }), TypeError, field);
  }
});

test("a changed billing destination is a different key", () => {
  // Regression. The destination used to be absent from the material, which made
  // "the resident moved their billing address" indistinguishable from "retry the
  // last request" — so a replayed PayPal-Request-Id could return the invoice
  // addressed to the OLD address while Hearth reported the new one.
  assert.notEqual(idempotencyKey(base), idempotencyKey({ ...base, destination: "devi-new@example.test" }));
});

test("the record key identifies one resident, period and property", () => {
  assert.equal(recordKey({ propertyId: "wc-3a", periodKey: "november-2026", personId: "p-3a-devi" }), "wc-3a:november-2026:p-3a-devi");
});
