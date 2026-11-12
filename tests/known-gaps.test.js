// KNOWN GAPS — NOT COVERAGE.
//
// Every test in this file asserts behaviour we believe is WRONG. They are marked
// `todo`, so the runner reports them separately and they are never counted as
// passing coverage of the desired behaviour. Each one documents a defect precisely
// enough to fix, and will need deleting when it is fixed.
//
// Nothing here is fixed in this milestone. See docs/KNOWN_GAPS.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHardSafety } from "../server/_shared/safety.mjs";

test(
  "GAP 1 (undesired behaviour): reversed water phrasing is not classified as life-safety",
  { todo: "Carried over from the Hearth pilot. Deliberately NOT fixed here: widening a safety pattern changes product behaviour in the pilot too, so it is the owner's decision, not a side effect of copying the file. See docs/KNOWN_GAPS.md." },
  () => {
    // The patterns match "burst pipe" and "water pouring". A resident who writes the
    // words the other way round is not escalated. This asserts the CURRENT, WRONG
    // behaviour; if it starts failing, the gap was fixed and this test should go.
    assert.equal(classifyHardSafety("a pipe burst and water is pouring in"), null);
    assert.equal(classifyHardSafety("water is gushing out of the pipe"), null);

    // For contrast, the phrasings that do work, so the shape of the gap is clear.
    assert.equal(classifyHardSafety("a burst pipe is flooding the kitchen").tier, 3);
    assert.equal(classifyHardSafety("water pouring through the ceiling").tier, 3);
  },
);
