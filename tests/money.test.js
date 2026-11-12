import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, money, prorate, toCents } from "../src/money.js";

test("money formats cents without float drift", () => {
  assert.equal(money(123456), "$1,234.56");
  assert.equal(money(5), "$0.05");
  assert.equal(money(0), "$0.00");
  assert.equal(money(-250), "-$2.50");
  assert.equal(toCents(0.1) + toCents(0.2), toCents(0.3)); // the whole reason for cents
});

test("allocate never loses or invents a cent", () => {
  for (const total of [10000, 10001, 14000, 1, 320000, 999999]) {
    for (const n of [2, 3, 4, 7, 12]) {
      const parts = allocate(total, Array(n).fill(1));
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total} across ${n} must sum back`);
      assert.ok(Math.max(...parts) - Math.min(...parts) <= 1, "equal weights differ by at most a cent");
    }
  }
});

test("allocate is deterministic and weight-proportional", () => {
  assert.deepEqual(allocate(10000, [1, 1, 1]), [3334, 3333, 3333]);
  assert.deepEqual(allocate(10000, [1, 1, 1]), allocate(10000, [1, 1, 1]));
  assert.deepEqual(allocate(30000, [2, 1]), [20000, 10000]);
});

test("allocate handles the unequal shares a real household agrees to", () => {
  // Willow Court 3A: $3,200 across four rooms that are not the same size.
  const parts = allocate(320000, [90000, 86000, 76000, 68000]);
  assert.deepEqual(parts, [90000, 86000, 76000, 68000]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 320000);
});

test("allocate refuses weights that cannot define a split", () => {
  assert.throws(() => allocate(1000, [0, 0]), RangeError);
  assert.throws(() => allocate(1000, []), RangeError);
});

test("prorate counts move-in day and not move-out day", () => {
  assert.equal(prorate(90000, 31, 31), 90000);
  assert.equal(prorate(90000, 0, 31), 0);
  // Moved in on the 9th of a 31-day month => 23 days occupied.
  assert.equal(prorate(90000, 23, 31), Math.round((90000 * 23) / 31));
  assert.throws(() => prorate(90000, 10, 0), RangeError);
});

test("toCents rejects things that are not amounts", () => {
  assert.throws(() => toCents("not money"), TypeError);
  assert.throws(() => toCents(undefined), TypeError);
});
