// The facts renderer: the only place structured room facts are flattened to the
// text sent to a model (see src/ai/client.js). The structured object stays
// checkable and editable; this file checks the one thing it turns into.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRoomFacts, validateFactorSelection, FactorSelectionError, FACTOR_KEYS } from "../data/room-facts.mjs";

const FULL = {
  squareFeet: 220, bathroom: "private", floor: "2nd floor",
  windowExposure: "south-facing, bright", outdoorAccess: "private balcony",
  storage: "walk-in closet", noise: "quiet, faces the backyard", parking: true,
};

test("every structured fact appears in the rendered text", () => {
  const text = renderRoomFacts(FULL);
  assert.match(text, /220 sq ft/);
  assert.match(text, /private bathroom/);
  assert.match(text, /2nd floor/);
  assert.match(text, /south-facing, bright/);
  assert.match(text, /private balcony/);
  assert.match(text, /walk-in closet/);
  assert.match(text, /quiet, faces the backyard/);
  assert.match(text, /assigned parking/);
});

test("a shared bathroom and no outdoor access or parking are stated explicitly, not omitted", () => {
  const text = renderRoomFacts({ ...FULL, bathroom: "shared", outdoorAccess: null, parking: false });
  assert.match(text, /shared bathroom/);
  assert.match(text, /no balcony or private outdoor access/);
  assert.match(text, /no assigned parking/);
});

test("no rendered text ever contains a dollar figure", () => {
  // The renderer has no rent field to read in the first place, but this is the
  // boundary src/ai/client.js relies on — worth asserting directly, not just by
  // omission.
  for (const facts of [FULL, { ...FULL, bathroom: "shared", outdoorAccess: null, parking: false }, {}]) {
    assert.ok(!/\$\d/.test(renderRoomFacts(facts)), `unexpected dollar figure in: ${renderRoomFacts(facts)}`);
  }
});

test("missing facts render as an empty string rather than throwing", () => {
  assert.equal(renderRoomFacts(null), "");
  assert.equal(renderRoomFacts(undefined), "");
});

test("an empty facts object still states the two explicit absences", () => {
  const text = renderRoomFacts({});
  assert.match(text, /no balcony or private outdoor access/);
  assert.match(text, /no assigned parking/);
});

test("two differently-described rooms render to different text", () => {
  const quiet = renderRoomFacts(FULL);
  const noisy = renderRoomFacts({ ...FULL, noise: "street-facing, noisy", bathroom: "shared", outdoorAccess: null });
  assert.notEqual(quiet, noisy);
});

// --- withholding a factor: the mechanism the household's selection relies on ---

test("with parking withheld, parking is mentioned nowhere — on a room that has it, or one that doesn't", () => {
  const withParking = renderRoomFacts(FULL, { parking: "not_weighed" });
  const withoutParking = renderRoomFacts({ ...FULL, parking: false }, { parking: "not_weighed" });
  assert.ok(!/park/i.test(withParking), `parking leaked into: ${withParking}`);
  assert.ok(!/park/i.test(withoutParking), `parking leaked into: ${withoutParking}`);
  // Every other factor is unaffected — only parking was withheld.
  assert.match(withParking, /220 sq ft/);
  assert.match(withParking, /private bathroom/);
});

test("'not_weighed' and 'excluded' withhold a factor identically in the rendered text", () => {
  const notWeighed = renderRoomFacts(FULL, { parking: "not_weighed" });
  const excluded = renderRoomFacts(FULL, { parking: "excluded" });
  assert.equal(notWeighed, excluded);
});

test("withholding every factor renders an empty string, not twelve defaults", () => {
  const allWithheld = Object.fromEntries(FACTOR_KEYS.map((key) => [key, "excluded"]));
  assert.equal(renderRoomFacts(FULL, allWithheld), "");
});

test("an unselected factor is weighed by default — selection is opt-out, not opt-in", () => {
  assert.equal(renderRoomFacts(FULL, {}), renderRoomFacts(FULL, undefined));
});

// --- validating the selection itself ---

test("a factor key that is not a real room-facts field is refused, not silently priced in", () => {
  assert.throws(() => validateFactorSelection({ parkng: "excluded" }), FactorSelectionError);
  assert.throws(() => validateFactorSelection({ parkng: "excluded" }), /not a room-facts factor/);
});

test("withholding every known factor is refused with a useful message", () => {
  const allWithheld = Object.fromEntries(FACTOR_KEYS.map((key) => [key, "not_weighed"]));
  assert.throws(() => validateFactorSelection(allWithheld), FactorSelectionError);
  assert.throws(() => validateFactorSelection(allWithheld), /nothing left to weigh/);
});

test("withholding all but one factor is accepted — there is still something to weigh", () => {
  const selection = Object.fromEntries(FACTOR_KEYS.slice(1).map((key) => [key, "excluded"]));
  assert.doesNotThrow(() => validateFactorSelection(selection));
});

test("no selection at all is accepted — the default is to weigh everything", () => {
  assert.doesNotThrow(() => validateFactorSelection(undefined));
  assert.doesNotThrow(() => validateFactorSelection(null));
});
