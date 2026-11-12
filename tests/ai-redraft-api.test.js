// The ai-redraft route in allocation-api.mjs, against a fake proposeAiRedraft —
// no SDK, no network. What's worth proving here is the wiring: a redraft starts
// from the CURRENT version's weights (not a blank re-proposal), the complaint and
// rating land on the new version, a refused redraft never gets stored, and the
// previous round stays readable for comparison.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "../data/willow-court.mjs";
import { useDemoTables } from "../server/_shared/db.mjs";
import { createAllocationHandler } from "../server/allocation-api.mjs";
import { createMemoryAllocationStore } from "../src/allocation-store-memory.js";

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
async function workspaceOf(handler) {
  const r = await handler({ path: "/api/allocation/workspace", httpMethod: "GET", headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: PROPERTY }, body: null });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

const ROUND1 = { lines: { "p-3a-ada": 96000, "p-3a-bo": 86000, "p-3a-cam": 70000, "p-3a-devi": 68000 }, allocated: 320000, differenceCents: 0, balanced: true, basis: { "p-3a-ada": "x", "p-3a-bo": "x", "p-3a-cam": "x", "p-3a-devi": "x" }, unknowns: [], weights: { "p-3a-ada": 1.2, "p-3a-bo": 1.0, "p-3a-cam": 0.95, "p-3a-devi": 0.9 }, excludedFactors: [], factorSelection: {}, modelId: "claude-opus-5-5" };
const FEEDBACK = { rating: 2, factor: "parking", direction: "over_weighted", personId: "p-3a-bo" };

async function draftedHandler(proposeAiRedraft) {
  const handler = createAllocationHandler({
    store: createMemoryAllocationStore(),
    ai: { available: true, reason: null },
    proposeAiDraft: async () => ROUND1,
    proposeAiRedraft,
  });
  await caller(handler)("ai-draft", {});
  return handler;
}

test("ai-redraft is blocked when no AI is connected, by default", async () => {
  const handler = createAllocationHandler({ store: createMemoryAllocationStore() });
  const r = await caller(handler)("ai-redraft", { feedback: FEEDBACK });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "AI_UNAVAILABLE");
});

test("ai-redraft is blocked when the current version has no AI weights to start from", async () => {
  const handler = createAllocationHandler({ store: createMemoryAllocationStore(), ai: { available: true, reason: null } });
  const r = await caller(handler)("ai-redraft", { feedback: FEEDBACK });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "NOTHING_TO_REDRAFT");
});

test("a successful redraft starts from the current version's weights, not a blank re-proposal", async () => {
  let seenArgs;
  const handler = await draftedHandler(async (args) => { seenArgs = args; return { ...ROUND1, weights: { ...ROUND1.weights, "p-3a-ada": 1.1 }, feedback: FEEDBACK, modelId: "claude-opus-5-5" }; });
  const r = await caller(handler)("ai-redraft", { feedback: FEEDBACK });
  assert.equal(r.status, 200);
  assert.deepEqual(seenArgs.previousWeights, ROUND1.weights);
  assert.deepEqual(seenArgs.feedback, FEEDBACK);
});

test("the new version records the complaint as its reason, the rating, the model id and the factor selection", async () => {
  const handler = await draftedHandler(async () => ({ ...ROUND1, weights: { ...ROUND1.weights, "p-3a-ada": 1.1 }, feedback: FEEDBACK, factorSelection: { noise: "excluded" }, excludedFactors: ["noise"], modelId: "claude-opus-5-5" }));
  const r = await caller(handler)("ai-redraft", { feedback: FEEDBACK });
  assert.equal(r.status, 200);
  assert.equal(r.body.createdVersion, true);
  assert.deepEqual(r.body.version.feedback, FEEDBACK);
  assert.equal(r.body.version.rating, 2);
  assert.equal(r.body.version.modelId, "claude-opus-5-5");
  assert.deepEqual(r.body.version.excludedFactors, ["noise"]);
  // wc-3a's seed is already a version (n=1); the first ai-draft made n=2; this
  // redraft is n=3 — n+1 of whatever came immediately before it, in both cases.
  assert.equal(r.body.version.n, 3, "a redraft is a new version, n+1");
});

test("the previous round stays visible on the response for comparison", async () => {
  const handler = await draftedHandler(async () => ({ ...ROUND1, weights: { ...ROUND1.weights, "p-3a-ada": 1.1 }, feedback: FEEDBACK, modelId: "claude-opus-5-5" }));
  const r = await caller(handler)("ai-redraft", { feedback: FEEDBACK });
  assert.ok(r.body.previousVersion, "expected the superseded round to still be readable");
  assert.equal(r.body.previousVersion.n, 2, "the round the redraft was answering (the first ai-draft, n=2)");
  assert.deepEqual(r.body.previousVersion.aiWeights, ROUND1.weights);
  assert.deepEqual(r.body.previousVersion.answeredFeedback, FEEDBACK);
  const ada = r.body.previousVersion.lines.find((line) => line.personId === "p-3a-ada");
  assert.equal(ada.amountCents, ROUND1.lines["p-3a-ada"], "the previous round's own dollar amount, not the new one's");
});

test("a redraft the isolation check refused is never stored — the version stays where it was", async () => {
  const handler = await draftedHandler(async () => { const e = new Error("moved p-3a-devi, who has no parking"); e.code = "REDRAFT_REFUSED"; throw e; });
  const r = await caller(handler)("ai-redraft", { feedback: FEEDBACK });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "REDRAFT_REFUSED");
  assert.match(r.body.error, /p-3a-devi/);

  const shown = await workspaceOf(handler);
  assert.equal(shown.body.version.n, 2, "still the first ai-draft's version — the refused redraft must not have created a new one");
});

test("bad feedback is a 400 naming the problem, never a 502 as if the model misbehaved", async () => {
  const handler = await draftedHandler(async () => { const e = new Error("rating must be 1-5"); e.code = "BAD_FEEDBACK"; throw e; });
  const r = await caller(handler)("ai-redraft", { feedback: { rating: 9, factor: "parking", direction: "over_weighted" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "BAD_FEEDBACK");
});

test("ai-redraft names the exact version it is redrafting, like any other edit", async () => {
  const handler = await draftedHandler(async () => ({ ...ROUND1, feedback: FEEDBACK, modelId: "claude-opus-5-5" }));
  const r = await caller(handler)("ai-redraft", { feedback: FEEDBACK, versionCanonical: "not-the-real-version" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "STALE_VERSION");
});

test("the first AI draft carries no feedback or rating, and has no previous round — the seed is a bootstrap default, not a stored round", async () => {
  const handler = await draftedHandler(async () => ROUND1);
  const shown = await workspaceOf(handler);
  assert.equal(shown.body.version.feedback, null);
  assert.equal(shown.body.version.rating, null);
  // The very first write to a fresh store starts history at exactly that write —
  // the seed is never itself pushed into stored history, so there is nothing
  // behind the first AI draft to compare it against yet.
  assert.equal(shown.body.previousVersion, null);
});
