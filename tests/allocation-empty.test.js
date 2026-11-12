// A property with a rent period but no divided split yet — data/college-ave-twelve.mjs
// seeds no rentActivity entries for ca-140 on purpose. This is the path
// seedVersion()/workspaceFor() never exercised before: null, not a version with
// empty lines. The invariant under test throughout: no split yet and a split that
// happens to be zero must never look the same — not $0.00 collected, not a
// difference of zero reading as balanced.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build, meta } from "../data/college-ave-twelve.mjs";

// server/_shared/db.mjs resolves the dataset (and the demo operator's allowed
// organization ids) once, at module load, from HEARTH_DATASET. It has to be set
// before that first import — same reason tests/tenant-landlord-loop-style fixtures
// set it here rather than relying on useDemoTables() alone, which only swaps the
// in-memory rows, not the auth scoping.
process.env.HEARTH_DATASET = "college-ave-twelve";
const { useDemoTables } = await import("../server/_shared/db.mjs");
const { createAllocationHandler } = await import("../server/allocation-api.mjs");
const { createMemoryAllocationStore } = await import("../src/allocation-store-memory.js");

const PROPERTY = "ca-140";
const RESIDENT_COUNT = 12;

beforeEach(() => useDemoTables(build()));

function caller(handler) {
  return async (route, method, body) => {
    const r = await handler({
      path: `/api/allocation/${route}`, httpMethod: method,
      headers: { authorization: "Bearer demo" },
      queryStringParameters: method === "GET" ? { propertyId: PROPERTY } : {},
      body: method === "GET" ? null : JSON.stringify({ propertyId: PROPERTY, ...body }),
    });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
}

test("the dataset itself seeds no entries for ca-140 — this test is exercising the real empty path, not a fixture built for the test", () => {
  // Guards against the test suite quietly drifting back to a seeded split: if
  // someone adds entries back to the dataset, this fails loudly rather than the
  // other tests below silently testing a no-op.
  const activity = meta.rentActivity[PROPERTY];
  assert.ok(activity, "ca-140 must still have a rent period");
  assert.equal((activity.entries || []).length, 0, "ca-140 must have no seeded entries");
  assert.equal(activity.total, 14350);
});

test("the workspace opens with a period, a total, and no split — 200, not NO_PERIOD", async () => {
  const alloc = caller(createAllocationHandler({ store: createMemoryAllocationStore() }));
  const r = await alloc("workspace", "GET");
  assert.equal(r.status, 200, "a property with a period but no split is not an error");
  assert.equal(r.body.version, null);
  assert.equal(r.body.previousVersion, null);
  assert.equal(r.body.period.label, "November 2026");
  assert.equal(r.body.period.due, "Nov 1");
  assert.equal(r.body.total.requiredCents, 1435000, "the $14,350.00 total is still known");
});

test("the status line says no split yet, never a balanced or zero-difference claim", async () => {
  const alloc = caller(createAllocationHandler({ store: createMemoryAllocationStore() }));
  const r = await alloc("workspace", "GET");
  assert.equal(r.body.status.headline, "No rent split yet");
  assert.equal(r.body.status.waitingOn, "landlord");
});

test("allocated and difference are null, not zero — a split of zero would be a different, false claim", async () => {
  const alloc = caller(createAllocationHandler({ store: createMemoryAllocationStore() }));
  const r = await alloc("workspace", "GET");
  assert.equal(r.body.total.allocatedCents, null);
  assert.equal(r.body.total.allocatedLabel, null);
  assert.equal(r.body.total.differenceCents, null);
  assert.equal(r.body.total.differenceLabel, null);
  assert.equal(r.body.total.balances, false, "balances must read false, never true, with no split to balance");
});

test("every resident is listed with no dollar figure at all", async () => {
  const alloc = caller(createAllocationHandler({ store: createMemoryAllocationStore() }));
  const r = await alloc("workspace", "GET");
  assert.equal(r.body.lines.length, RESIDENT_COUNT);
  for (const line of r.body.lines) {
    assert.equal(line.amountCents, null, `${line.name} must carry no amount`);
    assert.equal(line.amountLabel, null);
    assert.equal(line.confirmed, false);
    assert.equal(line.invoice, null);
  }
});

test("publish, confirm and approve all refuse plainly — there is nothing yet to act on", async () => {
  const alloc = caller(createAllocationHandler({ store: createMemoryAllocationStore() }));
  for (const route of ["publish", "approve"]) {
    const r = await alloc(route, "POST", {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /no allocation/i);
  }
  const confirmed = await alloc("confirm", "POST", { personId: "p-ca-priya" });
  assert.equal(confirmed.status, 409);
});

test("ai-redraft refuses — there are no previous weights to start from", async () => {
  const alloc = caller(createAllocationHandler({
    store: createMemoryAllocationStore(), ai: { available: true, reason: null },
    proposeAiRedraft: async () => { throw new Error("should never be called"); },
  }));
  const r = await alloc("ai-redraft", "POST", { feedback: { rating: 2, factor: "parking", direction: "over_weighted" } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "NOTHING_TO_REDRAFT");
});

test("naming a version that doesn't exist yet is refused as stale, not silently ignored", async () => {
  const alloc = caller(createAllocationHandler({ store: createMemoryAllocationStore() }));
  const r = await alloc("publish", "POST", { versionCanonical: "something" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "STALE_VERSION");
});

test("typing the first share bootstraps version 1 from nothing, with no versionCanonical required", async () => {
  const alloc = caller(createAllocationHandler({ store: createMemoryAllocationStore() }));
  const r = await alloc("share", "POST", { personId: "p-ca-priya", amountCents: 145000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.createdVersion, true);
  assert.equal(r.body.version.n, 1);
  assert.equal(r.body.version.state, "draft");
  const priya = r.body.lines.find((line) => line.personId === "p-ca-priya");
  assert.equal(priya.amountCents, 145000);
  // Everyone else still carries no figure — one typed share does not invent eleven.
  const bo = r.body.lines.find((line) => line.personId === "p-ca-marcus");
  assert.equal(bo.amountCents, null);
});

test("ai-draft works with no prior allocation, and starts at version 1", async () => {
  const GOOD = {
    lines: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p-ca-${["priya", "marcus", "sofia", "diego", "hannah", "tyler", "ngozi", "owen", "mei", "caleb", "isla", "theo"][i]}`, 1435000 / 12])),
    basis: {}, unknowns: [], weights: {}, excludedFactors: [], factorSelection: {}, modelId: "claude-opus-5-5",
  };
  let seenArgs;
  const alloc = caller(createAllocationHandler({
    store: createMemoryAllocationStore(), ai: { available: true, reason: null },
    proposeAiDraft: async (args) => { seenArgs = args; return GOOD; },
  }));
  const r = await alloc("ai-draft", "POST", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.version.n, 1);
  assert.equal(seenArgs.personIds.length, RESIDENT_COUNT);
  assert.equal(seenArgs.totalCents, 1435000);
});

test("the workspace reports whether AI is connected even with no allocation yet", async () => {
  const alloc = caller(createAllocationHandler({ store: createMemoryAllocationStore() }));
  const r = await alloc("workspace", "GET");
  assert.equal(r.body.ai.available, false);
});

// Observed in a browser on 2026-11-10, against the server running this dataset:
// the Rent page itself threw "Cannot read properties of null (reading 'state')"
// and rendered its load-failed banner instead of the empty state the tests above
// describe. The payload was right; two reads on the page were not. There is no DOM
// in this suite, so the guard is on the source — `view.version.<field>` is exactly
// the shape that crashes, because `version` is null until something is drafted.
test("no screen dereferences view.version without a null guard", () => {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const unguarded = [...source.matchAll(/view\.version\.[a-zA-Z]/g)].map((m) => m[0]);
  assert.deepEqual(unguarded, [], "read it through a guarded local (`const v = view.version`) or `view.version?.`");
});
