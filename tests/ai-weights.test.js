// The deterministic half of the AI allocation. No model, no credentials, no network:
// if these pass, the arithmetic is right however wrong the model is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocationFromWeights, reconciles, WeightError } from "../src/ai/weights.js";
import { draftFromProposal, validateProposal, proposalSchema, ProposalError } from "../src/ai/proposal.js";

const PEOPLE = ["p-ada", "p-bo", "p-cam", "p-devi"];

const sum = (lines) => Object.values(lines).reduce((running, cents) => running + cents, 0);

test("equal weights split a rent that divides evenly", () => {
  const lines = allocationFromWeights({ totalCents: 320000, weights: { "p-ada": 1, "p-bo": 1, "p-cam": 1, "p-devi": 1 } });
  assert.deepEqual(lines, { "p-ada": 80000, "p-bo": 80000, "p-cam": 80000, "p-devi": 80000 });
});

test("a rent that does not divide evenly still sums to the cent", () => {
  // 100 cents across three equal rooms: 33.33 each, one cent left over.
  const lines = allocationFromWeights({ totalCents: 100, weights: { "p-ada": 1, "p-bo": 1, "p-cam": 1 } });
  assert.equal(sum(lines), 100, "the leftover cent must land somewhere, not vanish");
  assert.deepEqual(Object.values(lines).sort(), [33, 33, 34]);
});

test("unequal weights sum to the cent across many awkward totals", () => {
  const weights = { "p-ada": 1.25, "p-bo": 1, "p-cam": 0.9, "p-devi": 1.1 };
  for (const totalCents of [300000, 299999, 100001, 7, 1, 0, 123457]) {
    const lines = allocationFromWeights({ totalCents, weights });
    assert.equal(sum(lines), totalCents, `total ${totalCents} did not reconcile`);
    assert.ok(reconciles({ totalCents, lines }).balanced);
  }
});

test("the same weights always produce the same cents, including the leftover", () => {
  const weights = { "p-ada": 1, "p-bo": 1, "p-cam": 1 };
  const first = allocationFromWeights({ totalCents: 100, weights });
  for (let i = 0; i < 25; i += 1) {
    assert.deepEqual(allocationFromWeights({ totalCents: 100, weights }), first);
  }
  // The tie is broken on person id, so it is the first id that gains the cent.
  assert.equal(first["p-ada"], 34);
});

test("one resident takes the whole rent", () => {
  assert.deepEqual(allocationFromWeights({ totalCents: 90000, weights: { "p-ada": 3 } }), { "p-ada": 90000 });
});

test("a zero weight is allowed and takes nothing, so long as somebody takes something", () => {
  const lines = allocationFromWeights({ totalCents: 1000, weights: { "p-ada": 1, "p-bo": 0 } });
  assert.deepEqual(lines, { "p-ada": 1000, "p-bo": 0 });
});

test("weights the arithmetic cannot use are refused, not rounded away", () => {
  const cases = [
    [{ "p-ada": -1, "p-bo": 2 }, /negative/i],
    [{ "p-ada": 0, "p-bo": 0 }, /every weight is zero/i],
    [{ "p-ada": Number.NaN }, /not a number/i],
    [{ "p-ada": Number.POSITIVE_INFINITY }, /not a number/i],
    [{ "p-ada": "1.2" }, /not a number/i],
    [{}, /nobody to allocate/i],
  ];
  for (const [weights, expected] of cases) {
    assert.throws(() => allocationFromWeights({ totalCents: 1000, weights }), (error) => {
      assert.ok(error instanceof WeightError);
      assert.match(error.message, expected);
      return true;
    }, `${JSON.stringify(weights)} should have been refused`);
  }
});

test("a total that is not whole cents is refused", () => {
  for (const totalCents of [1000.5, -1, "1000", null]) {
    assert.throws(() => allocationFromWeights({ totalCents, weights: { "p-ada": 1 } }), WeightError);
  }
});

// --- the contract with the model -------------------------------------------

const goodProposal = () => ({
  weights: { "p-ada": 1.2, "p-bo": 1, "p-cam": 0.9, "p-devi": 1 },
  basis: {
    "p-ada": "Largest room with the private bathroom.",
    "p-bo": "Ordinary double facing the street.",
    "p-cam": "Smallest room, north facing, shares the upstairs bathroom.",
    "p-devi": "Ordinary double, shares the upstairs bathroom.",
  },
  unknowns: ["No floor area was recorded for any room."],
});

test("a well formed proposal becomes a draft that reconciles exactly", () => {
  const draft = draftFromProposal({ proposal: goodProposal(), totalCents: 320000, personIds: PEOPLE });
  assert.equal(draft.allocated, 320000);
  assert.equal(draft.differenceCents, 0);
  assert.ok(draft.balanced);
  assert.equal(Object.keys(draft.lines).length, 4);
  assert.match(draft.basis["p-ada"], /private bathroom/);
  assert.deepEqual(draft.unknowns, ["No floor area was recorded for any room."]);
});

test("a proposal that names money is refused, not used", () => {
  for (const field of ["cents", "amount", "amountCents", "shareCents", "dollars", "rent"]) {
    const proposal = { ...goodProposal(), [field]: 80000 };
    assert.throws(() => validateProposal(proposal, { personIds: PEOPLE }), (error) => {
      assert.ok(error instanceof ProposalError);
      assert.match(error.message, new RegExp(field));
      return true;
    }, `a proposal carrying ${field} should have been refused`);
  }
});

test("a proposal that leaves somebody out is refused", () => {
  const proposal = goodProposal();
  delete proposal.weights["p-cam"];
  assert.throws(() => validateProposal(proposal, { personIds: PEOPLE }), /leaves out p-cam/);
});

test("a proposal that invents a resident is refused", () => {
  const proposal = goodProposal();
  proposal.weights["p-nobody"] = 1;
  assert.throws(() => validateProposal(proposal, { personIds: PEOPLE }), /not on this lease/);
});

test("a weight with no stated basis is refused, because an unexplained share is not reviewable", () => {
  for (const basis of ["", "   ", null, 42]) {
    const proposal = goodProposal();
    proposal.basis["p-bo"] = basis;
    assert.throws(() => validateProposal(proposal, { personIds: PEOPLE }), /no stated basis/);
  }
});

test("unknowns must be a list, and an empty list is how the model says nothing is missing", () => {
  const proposal = goodProposal();
  proposal.unknowns = "none";
  assert.throws(() => validateProposal(proposal, { personIds: PEOPLE }), /unknowns list/);

  const empty = { ...goodProposal(), unknowns: [] };
  assert.deepEqual(validateProposal(empty, { personIds: PEOPLE }).unknowns, []);
});

test("the schema the prompt asks for lists exactly the people on the lease", () => {
  const schema = proposalSchema(PEOPLE);
  assert.deepEqual(schema.properties.weights.required, PEOPLE);
  assert.equal(schema.properties.weights.additionalProperties, false);
  assert.deepEqual(schema.required, ["weights", "basis", "unknowns"]);
});

// --- a household the size college-ave-twelve actually exercises -----------

test("twelve uneven weights against the College Ave total (1435000 cents) reconcile to zero difference", () => {
  // Twelve genuinely uneven weights — none a round multiple of another — against
  // 1435000 cents ($14,350.00), the same total as data/college-ave-twelve.mjs.
  // 1435000 / 12 is not a whole number of cents, so the largest-remainder pass in
  // weights.js is doing real work here, not just coincidentally landing exact.
  const weights = {
    "p-ca-priya": 1.35, "p-ca-marcus": 1.05, "p-ca-sofia": 1.15, "p-ca-diego": 1.5,
    "p-ca-hannah": 0.9, "p-ca-tyler": 1.1, "p-ca-ngozi": 1.2, "p-ca-owen": 0.85,
    "p-ca-mei": 1.4, "p-ca-caleb": 0.95, "p-ca-isla": 1.0, "p-ca-theo": 0.75,
  };
  const totalCents = 1435000;
  const lines = allocationFromWeights({ totalCents, weights });
  assert.equal(Object.keys(lines).length, 12);
  assert.ok(Object.values(lines).every((cents) => Number.isInteger(cents) && cents >= 0));
  const result = reconciles({ totalCents, lines });
  assert.equal(result.allocated, totalCents);
  assert.equal(result.differenceCents, 0);
  assert.ok(result.balanced);
});
