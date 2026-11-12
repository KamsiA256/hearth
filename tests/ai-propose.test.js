// The orchestration function: ask a client for a proposal, then run it through the
// same money boundary a typed proposal gets. Uses a fake client object — no SDK, no
// network — because proposeDraft() must not be able to skip draftFromProposal()
// regardless of what the client returns, and that is what these tests check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeDraft, proposeRedraft, FeedbackError, RedraftError } from "../src/ai/propose.js";
import { ProposalError } from "../src/ai/proposal.js";
import { FactorSelectionError } from "../data/room-facts.mjs";

const PEOPLE = ["p-ada", "p-bo"];
const client = (input, model = "claude-opus-5-5") => ({ model, proposeWeights: async () => input });
// A fake that records the `rooms` it was called with, so withholding can be
// checked end to end — through proposeDraft(), not just through the renderer.
const capturingClient = (input, model = "claude-opus-5-5") => {
  const calls = [];
  return { model, calls, proposeWeights: async (args) => { calls.push(args); return input; } };
};
// A fake whose answer is a function of the call args, for redraft tests that
// need to behave differently depending on what the prompt actually asked for.
const scriptedClient = (respond, model = "claude-opus-5-5") => ({ model, proposeWeights: async (args) => respond(args) });

const GOOD = { weights: { "p-ada": 1.2, "p-bo": 1 }, basis: { "p-ada": "Larger room.", "p-bo": "Ordinary room." }, unknowns: [] };
const ROOMS = [
  { personId: "p-ada", name: "Ada", facts: { squareFeet: 200, parking: true } },
  { personId: "p-bo", name: "Bo", facts: { squareFeet: 150, parking: false } },
];

test("a well-formed proposal from the client becomes a reconciled cents draft", async () => {
  const draft = await proposeDraft({
    client: client({
      weights: { "p-ada": 1.2, "p-bo": 1 },
      basis: { "p-ada": "Larger room with a private bathroom.", "p-bo": "Ordinary room." },
      unknowns: [],
    }),
    personIds: PEOPLE,
    totalCents: 100000,
  });
  assert.ok(draft.balanced);
  assert.equal(draft.allocated, 100000);
});

test("a client that proposes money is refused, not laundered through as cents", async () => {
  await assert.rejects(
    () => proposeDraft({
      client: client({ weights: { "p-ada": 1, "p-bo": 1 }, basis: {}, unknowns: [], rent: 1000 }),
      personIds: PEOPLE,
      totalCents: 100000,
    }),
    (error) => { assert.ok(error instanceof ProposalError); assert.match(error.message, /carries rent/); return true; },
  );
});

test("a client that leaves a resident out is refused", async () => {
  await assert.rejects(
    () => proposeDraft({
      client: client({ weights: { "p-ada": 1 }, basis: { "p-ada": "Only room described." }, unknowns: [] }),
      personIds: PEOPLE,
      totalCents: 100000,
    }),
    ProposalError,
  );
});

// --- factor selection, carried through the whole path ---

test("a withheld factor never reaches the client, for any resident", async () => {
  const c = capturingClient(GOOD);
  await proposeDraft({ client: c, personIds: PEOPLE, rooms: ROOMS, totalCents: 100000, factorSelection: { parking: "excluded" } });
  assert.equal(c.calls.length, 1);
  for (const room of c.calls[0].rooms) assert.ok(!/park/i.test(room.facts), `parking leaked into: ${room.facts}`);
});

test("with no selection, every factor reaches the client", async () => {
  const c = capturingClient(GOOD);
  await proposeDraft({ client: c, personIds: PEOPLE, rooms: ROOMS, totalCents: 100000 });
  const ada = c.calls[0].rooms.find((room) => room.personId === "p-ada");
  assert.match(ada.facts, /assigned parking/);
});

test("a room with no facts falls back to its label, so legacy rooms still send something", async () => {
  const c = capturingClient(GOOD);
  await proposeDraft({
    client: c, personIds: PEOPLE, totalCents: 100000,
    rooms: [{ personId: "p-ada", name: "Ada", facts: null, label: "Bedroom 1" }, { personId: "p-bo", name: "Bo", facts: null, label: "Bedroom 2" }],
  });
  assert.equal(c.calls[0].rooms.find((room) => room.personId === "p-ada").facts, "Bedroom 1");
});

test("the resulting draft records exactly the excluded factors, never the merely unweighed ones", async () => {
  const draft = await proposeDraft({
    client: client(GOOD), personIds: PEOPLE, rooms: ROOMS, totalCents: 100000,
    factorSelection: { parking: "excluded", noise: "not_weighed" },
  });
  assert.deepEqual(draft.excludedFactors, ["parking"]);
});

test("no selection records no excluded factors", async () => {
  const draft = await proposeDraft({ client: client(GOOD), personIds: PEOPLE, rooms: ROOMS, totalCents: 100000 });
  assert.deepEqual(draft.excludedFactors, []);
});

test("an unknown factor key is refused before the client is ever called", async () => {
  const c = capturingClient(GOOD);
  await assert.rejects(
    () => proposeDraft({ client: c, personIds: PEOPLE, rooms: ROOMS, totalCents: 100000, factorSelection: { parkng: "excluded" } }),
    FactorSelectionError,
  );
  assert.equal(c.calls.length, 0, "the model must never be called on a bad selection");
});

test("withholding every factor is refused before the client is ever called", async () => {
  const c = capturingClient(GOOD);
  const allWithheld = { squareFeet: "excluded", bathroom: "excluded", floor: "excluded", windowExposure: "excluded", outdoorAccess: "excluded", storage: "excluded", noise: "excluded", parking: "excluded" };
  await assert.rejects(
    () => proposeDraft({ client: c, personIds: PEOPLE, rooms: ROOMS, totalCents: 100000, factorSelection: allWithheld }),
    FactorSelectionError,
  );
  assert.equal(c.calls.length, 0);
});

// --- recording what produced the draft ---

test("a draft records the model id and the factor selection used", async () => {
  const draft = await proposeDraft({
    client: client(GOOD, "claude-opus-5-5"), personIds: PEOPLE, rooms: ROOMS, totalCents: 100000,
    factorSelection: { parking: "not_weighed" },
  });
  assert.equal(draft.modelId, "claude-opus-5-5");
  assert.deepEqual(draft.factorSelection, { parking: "not_weighed" });
});

test("no selection still records an empty factor selection, not undefined", async () => {
  const draft = await proposeDraft({ client: client(GOOD), personIds: PEOPLE, rooms: ROOMS, totalCents: 100000 });
  assert.deepEqual(draft.factorSelection, {});
});

// --- feedback-driven redraft ---

const THREE = ["p-ada", "p-bo", "p-cam"];
const THREE_ROOMS = [
  { personId: "p-ada", name: "Ada", facts: { squareFeet: 200, parking: true } },
  { personId: "p-bo", name: "Bo", facts: { squareFeet: 150, parking: false } },
  { personId: "p-cam", name: "Cam", facts: { squareFeet: 140, parking: false } },
];
const PREVIOUS_WEIGHTS = { "p-ada": 1.3, "p-bo": 1.0, "p-cam": 0.9 };
const FEEDBACK_PARKING_OVER = { rating: 2, factor: "parking", direction: "over_weighted", personId: "p-bo" };

function basisFor(weights) {
  return Object.fromEntries(Object.keys(weights).map((id) => [id, `basis for ${id}`]));
}

test("a redraft that holds the exempt residents and moves only the flagged one is accepted", async () => {
  const held = { "p-ada": 1.1, "p-bo": PREVIOUS_WEIGHTS["p-bo"], "p-cam": PREVIOUS_WEIGHTS["p-cam"] };
  const draft = await proposeRedraft({
    client: client({ weights: held, basis: basisFor(held), unknowns: [] }),
    personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000,
    previousWeights: PREVIOUS_WEIGHTS, feedback: FEEDBACK_PARKING_OVER,
  });
  assert.equal(draft.weights["p-ada"], 1.1, "the flagged resident (has parking) was allowed to move");
  assert.equal(draft.weights["p-bo"], PREVIOUS_WEIGHTS["p-bo"], "exempt resident held exactly");
  assert.equal(draft.weights["p-cam"], PREVIOUS_WEIGHTS["p-cam"], "exempt resident held exactly");
  assert.deepEqual(draft.feedback, FEEDBACK_PARKING_OVER);
  assert.equal(draft.modelId, "claude-opus-5-5");
});

test("a redraft within tolerance of an exempt resident's previous weight is accepted, not just an exact match", async () => {
  const nudged = { "p-ada": 1.1, "p-bo": PREVIOUS_WEIGHTS["p-bo"] + 0.01, "p-cam": PREVIOUS_WEIGHTS["p-cam"] - 0.01 };
  const draft = await proposeRedraft({
    client: client({ weights: nudged, basis: basisFor(nudged), unknowns: [] }),
    personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000,
    previousWeights: PREVIOUS_WEIGHTS, feedback: FEEDBACK_PARKING_OVER,
  });
  assert.equal(draft.weights["p-bo"], nudged["p-bo"]);
});

test("a redraft that wanders onto an exempt resident is refused, not stored", async () => {
  const wandered = { "p-ada": 1.1, "p-bo": 1.4, "p-cam": PREVIOUS_WEIGHTS["p-cam"] };
  await assert.rejects(
    () => proposeRedraft({
      client: client({ weights: wandered, basis: basisFor(wandered), unknowns: [] }),
      personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000,
      previousWeights: PREVIOUS_WEIGHTS, feedback: FEEDBACK_PARKING_OVER,
    }),
    (error) => { assert.ok(error instanceof RedraftError); assert.match(error.message, /p-bo/); return true; },
  );
});

test("a redraft that re-rolls the whole household is refused", async () => {
  const rerolled = { "p-ada": 0.7, "p-bo": 1.6, "p-cam": 1.2 };
  await assert.rejects(
    () => proposeRedraft({
      client: client({ weights: rerolled, basis: basisFor(rerolled), unknowns: [] }),
      personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000,
      previousWeights: PREVIOUS_WEIGHTS, feedback: FEEDBACK_PARKING_OVER,
    }),
    RedraftError,
  );
});

test("the previous weights and the complaint reach the model as the prompt's context", async () => {
  const c = capturingClient({ weights: PREVIOUS_WEIGHTS, basis: basisFor(PREVIOUS_WEIGHTS), unknowns: [] });
  await proposeRedraft({
    client: c, personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000,
    previousWeights: PREVIOUS_WEIGHTS, feedback: FEEDBACK_PARKING_OVER,
  });
  const sentContext = c.calls[0].context;
  assert.match(sentContext, /REDRAFT/);
  assert.match(sentContext, /1\.3/); // Ada's previous weight
  assert.match(sentContext, /Parking/i);
  assert.match(sentContext, /p-cam=0\.9/); // an exempt resident's previous weight, named explicitly
});

test("a factor with no exempt subset (e.g. noise) lets a redraft move anyone — the check is honestly vacuous there", async () => {
  const anyMovement = { "p-ada": 1.25, "p-bo": 1.05, "p-cam": 0.85 };
  const draft = await proposeRedraft({
    client: client({ weights: anyMovement, basis: basisFor(anyMovement), unknowns: [] }),
    personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000,
    previousWeights: PREVIOUS_WEIGHTS, feedback: { rating: 3, factor: "noise", direction: "under_weighted" },
  });
  assert.deepEqual(draft.weights, anyMovement);
});

test("two rounds of feedback converge rather than re-rolling", async () => {
  // Round 1: a plain first draft.
  const round1 = await proposeDraft({
    client: client({ weights: PREVIOUS_WEIGHTS, basis: basisFor(PREVIOUS_WEIGHTS), unknowns: [] }),
    personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000,
  });
  assert.ok(round1.balanced);

  // Round 2: Bo complains parking was over-weighted (Ada has it, Bo/Cam don't).
  const afterRound2 = { "p-ada": 1.15, "p-bo": round1.weights["p-bo"], "p-cam": round1.weights["p-cam"] };
  const round2 = await proposeRedraft({
    client: client({ weights: afterRound2, basis: basisFor(afterRound2), unknowns: [] }),
    personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000,
    previousWeights: round1.weights, feedback: { rating: 2, factor: "parking", direction: "over_weighted", personId: "p-bo" },
  });
  assert.ok(round2.weights["p-ada"] < round1.weights["p-ada"], "over-weighted factor moved down");
  assert.equal(round2.weights["p-bo"], round1.weights["p-bo"]);
  assert.equal(round2.weights["p-cam"], round1.weights["p-cam"]);

  // Round 3: a second complaint, this time Ada says her own private bathroom
  // was under-weighted (only Ada has one; Bo and Cam are exempt here too).
  const afterRound3 = { "p-ada": round2.weights["p-ada"] + 0.1, "p-bo": round2.weights["p-bo"], "p-cam": round2.weights["p-cam"] };
  const round3Rooms = [
    { personId: "p-ada", name: "Ada", facts: { squareFeet: 200, parking: true, bathroom: "private" } },
    { personId: "p-bo", name: "Bo", facts: { squareFeet: 150, parking: false, bathroom: "shared" } },
    { personId: "p-cam", name: "Cam", facts: { squareFeet: 140, parking: false, bathroom: "shared" } },
  ];
  const round3 = await proposeRedraft({
    client: client({ weights: afterRound3, basis: basisFor(afterRound3), unknowns: [] }),
    personIds: THREE, rooms: round3Rooms, totalCents: 100000,
    previousWeights: round2.weights, feedback: { rating: 2, factor: "bathroom", direction: "under_weighted", personId: "p-ada" },
  });
  assert.ok(round3.weights["p-ada"] > round2.weights["p-ada"], "under-weighted factor moved up");
  assert.equal(round3.weights["p-bo"], round2.weights["p-bo"]);
  assert.equal(round3.weights["p-cam"], round2.weights["p-cam"]);
});

test("feedback with a bad rating, factor or direction is refused before the client is ever called", async () => {
  const c = capturingClient({ weights: PREVIOUS_WEIGHTS, basis: {}, unknowns: [] });
  for (const feedback of [
    { rating: 0, factor: "parking", direction: "over_weighted" },
    { rating: 3.5, factor: "parking", direction: "over_weighted" },
    { rating: 3, factor: "parkng", direction: "over_weighted" },
    { rating: 3, factor: "parking", direction: "sideways" },
    null,
  ]) {
    await assert.rejects(
      () => proposeRedraft({ client: c, personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000, previousWeights: PREVIOUS_WEIGHTS, feedback }),
      FeedbackError,
    );
  }
  assert.equal(c.calls.length, 0);
});

test("a redraft with no previous weights is refused — there is no blank re-proposal here", async () => {
  const c = capturingClient({ weights: PREVIOUS_WEIGHTS, basis: {}, unknowns: [] });
  await assert.rejects(
    () => proposeRedraft({ client: c, personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000, feedback: FEEDBACK_PARKING_OVER }),
    FeedbackError,
  );
  await assert.rejects(
    () => proposeRedraft({ client: c, personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000, previousWeights: {}, feedback: FEEDBACK_PARKING_OVER }),
    FeedbackError,
  );
  assert.equal(c.calls.length, 0);
});

test("a redraft's rating is never sent to the model — only the factor and direction are", async () => {
  const c = capturingClient({ weights: PREVIOUS_WEIGHTS, basis: basisFor(PREVIOUS_WEIGHTS), unknowns: [] });
  await proposeRedraft({
    client: c, personIds: THREE, rooms: THREE_ROOMS, totalCents: 100000,
    previousWeights: PREVIOUS_WEIGHTS, feedback: { rating: 2, factor: "parking", direction: "over_weighted" },
  });
  const sentContext = c.calls[0].context;
  assert.ok(!/\brating\b|\bstar\b/i.test(sentContext), `a bare rating leaked into the prompt: ${sentContext}`);
});
