// The ai-draft route in allocation-api.mjs, against a fake proposeAiDraft — no SDK,
// no network. The thing worth proving here is the wiring: the route is gated on
// `ai.available`, it goes through the same version-staleness and has-invoices
// checks every other edit does, it never hands the model a dollar figure, and a
// refused proposal is reported rather than silently dropped or 500'd.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "../data/willow-court.mjs";
import { useDemoTables } from "../server/_shared/db.mjs";
import { createAllocationHandler } from "../server/allocation-api.mjs";
import { createMemoryAllocationStore } from "../src/allocation-store-memory.js";
import { FactorSelectionError } from "../data/room-facts.mjs";

const PROPERTY = "wc-3a";

beforeEach(() => useDemoTables(build()));

function caller(handler) {
  return async (route, body) => {
    if (body && !("versionCanonical" in body)) {
      const shown = await handler({ path: "/api/allocation/workspace", httpMethod: "GET", headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: null });
      body = { ...body, versionCanonical: JSON.parse(shown.body).version?.canonical };
    }
    const r = await handler({ path: `/api/allocation/${route}`, httpMethod: "POST", headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: body ? JSON.stringify({ propertyId: PROPERTY, ...body }) : null });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
}

// caller()'s wrapper always POSTs (it only fetches the workspace internally, to
// name a stale-version check's current version). A plain GET needs the raw
// handler directly.
async function workspaceOf(handler) {
  const r = await handler({ path: "/api/allocation/workspace", httpMethod: "GET", headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: null });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

const GOOD_DRAFT = { lines: { "p-3a-ada": 96000, "p-3a-bo": 86000, "p-3a-cam": 70000, "p-3a-devi": 68000 }, allocated: 320000, differenceCents: 0, balanced: true, basis: { "p-3a-ada": "x", "p-3a-bo": "x", "p-3a-cam": "x", "p-3a-devi": "x" }, unknowns: [], weights: { "p-3a-ada": 1 }, excludedFactors: [] };

test("ai-draft is blocked when no AI is connected, by default", async () => {
  const alloc = caller(createAllocationHandler({ store: createMemoryAllocationStore() }));
  const r = await alloc("ai-draft", {});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "AI_UNAVAILABLE");
});

test("a successful proposal is written as a new draft version, reconciled to the cent", async () => {
  let seenArgs;
  const alloc = caller(createAllocationHandler({
    store: createMemoryAllocationStore(),
    ai: { available: true, reason: null },
    proposeAiDraft: async (args) => { seenArgs = args; return GOOD_DRAFT; },
  }));
  const r = await alloc("ai-draft", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.createdVersion, true);
  assert.equal(r.body.total.allocatedCents, 320000);
  assert.equal(r.body.total.differenceCents, 0);

  // Room facts went to the model, never a dollar figure. wc-3a predates
  // structured facts, so every room's `facts` is null and `label` ("Bedroom N")
  // is what src/ai/propose.js falls back to — neither carries a dollar figure.
  assert.equal(seenArgs.totalCents, 320000);
  assert.deepEqual(seenArgs.personIds.sort(), ["p-3a-ada", "p-3a-bo", "p-3a-cam", "p-3a-devi"]);
  for (const room of seenArgs.rooms) {
    assert.equal(room.facts, null);
    assert.ok(!/\$|900|860|760|680/.test(room.label), `room label for ${room.personId} must carry no dollar figure, got "${room.label}"`);
  }
});

test("the factor selection in the request reaches proposeAiDraft unchanged", async () => {
  let seenArgs;
  const alloc = caller(createAllocationHandler({
    store: createMemoryAllocationStore(),
    ai: { available: true, reason: null },
    proposeAiDraft: async (args) => { seenArgs = args; return GOOD_DRAFT; },
  }));
  await alloc("ai-draft", { factorSelection: { parking: "excluded", noise: "not_weighed" } });
  assert.deepEqual(seenArgs.factorSelection, { parking: "excluded", noise: "not_weighed" });
});

test("excludedFactors on the draft is stored on the new version and returned to the client", async () => {
  const handler = createAllocationHandler({
    store: createMemoryAllocationStore(),
    ai: { available: true, reason: null },
    proposeAiDraft: async () => ({ ...GOOD_DRAFT, excludedFactors: ["parking"] }),
  });
  const r = await caller(handler)("ai-draft", {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.version.excludedFactors, ["parking"]);
  assert.deepEqual(r.body.version.aiBasis, GOOD_DRAFT.basis);
  assert.deepEqual(r.body.version.aiWeights, GOOD_DRAFT.weights);

  // And it survives a fresh read of the workspace, not just the write response.
  const shown = await workspaceOf(handler);
  assert.deepEqual(shown.body.version.excludedFactors, ["parking"]);
});

test("a bad factor selection is a 400 naming the problem, never a 502 as if the model misbehaved", async () => {
  const alloc = caller(createAllocationHandler({
    store: createMemoryAllocationStore(),
    ai: { available: true, reason: null },
    proposeAiDraft: async () => { throw new FactorSelectionError('"parkng" is not a room-facts factor.'); },
  }));
  const r = await alloc("ai-draft", { factorSelection: { parkng: "excluded" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "BAD_FACTOR_SELECTION");
  assert.match(r.body.error, /not a room-facts factor/);
});

test("a manually-typed version carries no AI fields at all", async () => {
  const shown = await workspaceOf(createAllocationHandler({ store: createMemoryAllocationStore() }));
  assert.equal(shown.body.version.excludedFactors, null);
  assert.equal(shown.body.version.aiBasis, null);
});

test("the workspace reports whether AI is connected, the same way it reports payments", async () => {
  const off = await workspaceOf(createAllocationHandler({ store: createMemoryAllocationStore() }));
  assert.equal(off.body.ai.available, false);

  const on = await workspaceOf(createAllocationHandler({ store: createMemoryAllocationStore(), ai: { available: true, reason: null } }));
  assert.equal(on.body.ai.available, true);
});

test("a refused proposal is reported as a 502, not a silent fallback or a 500", async () => {
  const alloc = caller(createAllocationHandler({
    store: createMemoryAllocationStore(),
    ai: { available: true, reason: null },
    proposeAiDraft: async () => { throw new Error("The proposal has no weights object."); },
  }));
  const r = await alloc("ai-draft", {});
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "AI_PROPOSAL_REFUSED");
  assert.match(r.body.error, /no weights object/);
});

test("ai-draft names the exact version being replaced, like any other edit", async () => {
  const alloc = caller(createAllocationHandler({
    store: createMemoryAllocationStore(),
    ai: { available: true, reason: null },
    proposeAiDraft: async () => GOOD_DRAFT,
  }));
  const r = await alloc("ai-draft", { versionCanonical: "not-the-real-version" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "STALE_VERSION");
});
