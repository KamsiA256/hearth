import { test } from "node:test";
import assert from "node:assert/strict";
import { allocationFor, blockedReason, lineFor, periodKey } from "../src/allocation.js";

const people = [
  { id: "p-1", name: "Ada Moreno", room_id: "r-1" },
  { id: "p-2", name: "Bo Fitzgerald", room_id: "r-2" },
  { id: "p-3", name: "Cam Nakamura", room_id: "r-3" },
  { id: "p-4", name: "Devi Sharma", room_id: "r-4" },
];
const activity = {
  period: "November 2026", total: 3200, due: "Nov 1", followUp: "Nov 6", source: "Fictional household agreement",
  entries: [
    { personId: "p-1", amount: 900, state: "received", recorded: "Oct 27" },
    { personId: "p-2", amount: 860, state: "received", recorded: "Oct 28" },
    { personId: "p-3", amount: 760, state: "received", recorded: "Oct 30" },
    { personId: "p-4", amount: 680, state: "due" },
  ],
};
const snap = (overrides = {}) => allocationFor({ propertyId: "wc-3a", activity: { ...activity, ...overrides }, people });

test("money is held in integer cents, converted once at the edge", () => {
  const s = snap();
  assert.equal(s.totalCents, 320000);
  assert.deepEqual(s.lines.map((l) => l.amountCents), [90000, 86000, 76000, 68000]);
  for (const line of s.lines) assert.ok(Number.isInteger(line.amountCents));
});

test("an allocation that matches the monthly total balances", () => {
  const s = snap();
  assert.equal(s.allocatedCents, 320000);
  assert.equal(s.differenceCents, 0);
  assert.equal(s.balances, true);
  assert.equal(blockedReason(s), null);
});

test("a short allocation blocks invoicing and says by how much", () => {
  const s = snap({ entries: activity.entries.map((e) => (e.personId === "p-4" ? { ...e, amount: 600 } : e)) });
  assert.equal(s.balances, false);
  assert.equal(s.differenceCents, -8000);
  const reason = blockedReason(s);
  assert.match(reason, /\$80\.00 short/);
  assert.match(reason, /match exactly/);
});

test("an over-allocation also blocks, with different wording", () => {
  const s = snap({ entries: activity.entries.map((e) => (e.personId === "p-4" ? { ...e, amount: 700 } : e)) });
  assert.equal(s.differenceCents, 2000);
  assert.match(blockedReason(s), /\$20\.00 over/);
});

test("a cent off is still off", () => {
  const s = snap({ total: 3200.01 });
  assert.equal(s.balances, false);
  assert.equal(s.differenceCents, -1);
  assert.match(blockedReason(s), /\$0\.01 short/);
});

test("an empty or missing allocation is reported, not treated as zero", () => {
  assert.equal(allocationFor({ propertyId: "x", activity: null, people }), null);
  assert.match(blockedReason(null), /no rent allocation/i);
  assert.match(blockedReason(snap({ entries: [] })), /no resident shares/i);
});

test("the version changes when any amount changes", () => {
  const before = snap().version;
  const after = snap({ entries: activity.entries.map((e) => (e.personId === "p-1" ? { ...e, amount: 901 } : e)) }).version;
  assert.notEqual(before, after);
});

test("the version changes when the recipients change", () => {
  const before = snap().version;
  const swapped = snap({ entries: [...activity.entries.slice(0, 3), { personId: "p-5", amount: 680, state: "due" }] }).version;
  assert.notEqual(before, swapped);
});

test("the version changes when the billing period changes", () => {
  assert.notEqual(snap().version, snap({ period: "December 2026" }).version);
});

test("the version does NOT change when only the order changes", () => {
  // A human approves amounts for people, not the order a list happened to arrive in.
  const reversed = snap({ entries: [...activity.entries].reverse() });
  assert.equal(reversed.version, snap().version);
});

test("the version ignores whether the household says someone paid in", () => {
  // The household's own record is not part of what a landlord authorizes.
  const paid = snap({ entries: activity.entries.map((e) => ({ ...e, state: "received" })) });
  assert.equal(paid.version, snap().version);
});

test("the household's own record is kept separate from any provider state", () => {
  const s = snap();
  assert.equal(lineFor(s, "p-4").recordedByHousehold, false);
  assert.equal(lineFor(s, "p-1").recordedByHousehold, true);
  // Nothing in the snapshot claims a payment state.
  assert.ok(!JSON.stringify(s).includes("paymentState"));
});

test("period keys are stable and filename-safe", () => {
  assert.equal(periodKey("November 2026"), "november-2026");
  assert.equal(periodKey("  December  2026 "), "december-2026");
});

test("a line names an unknown resident rather than inventing one", () => {
  const s = allocationFor({ propertyId: "x", activity: { ...activity, entries: [{ personId: "ghost", amount: 3200 }] }, people });
  assert.equal(s.lines[0].name, "Unknown resident");
});
