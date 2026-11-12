// Safety classification runs before anything else looks at a message. These are the
// cases that must not regress: an emergency must never be swallowed by opt-out
// handling, and an ordinary sentence containing "stop" must not revoke consent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHardSafety, isStop, isStart, isHelp, LIFE_SAFETY_REPLY, safeRoleContext } from "../server/_shared/safety.mjs";

test("life-safety language is tier 3", () => {
  for (const body of ["I smell gas in the kitchen", "There's smoke coming from the basement", "carbon monoxide alarm is going off", "a burst pipe is flooding the kitchen", "No heat and it's freezing inside", "someone tried a break-in last night"]) {
    const result = classifyHardSafety(body);
    assert.ok(result, `${body} must classify`);
    assert.equal(result.tier, 3, body);
  }
});

test("urgent maintenance language is tier 2", () => {
  for (const body of ["I'm locked out", "no water since this morning", "the outlet is sparking", "there's sewage in the basement"]) {
    assert.equal(classifyHardSafety(body)?.tier, 2, body);
  }
});

test("an ordinary message classifies as neither", () => {
  for (const body of ["Is the laundry coin-only?", "Can my parents park in the driveway?", "When is rent due?"]) {
    assert.equal(classifyHardSafety(body), null, body);
  }
});

test("whole-message opt-out keywords revoke consent", () => {
  for (const body of ["STOP", "stop", "Stop.", "UNSUBSCRIBE", "CANCEL", "QUIT", "END", "OPT OUT", "REVOKE"]) {
    assert.equal(isStop(body), true, body);
  }
});

test("a sentence revokes only when it is about messages or consent", () => {
  assert.equal(isStop("please stop texting me"), true);
  assert.equal(isStop("I revoke consent"), true);
  assert.equal(isStop("opt me out"), true);
  assert.equal(isStop("the water won't stop running"), false);
  assert.equal(isStop("can you stop by tomorrow?"), false);
});

test("an emergency is never treated as an opt-out", () => {
  // The worst possible failure: someone writes "stop" inside an emergency and the
  // message is filed as a consent revocation instead of being escalated.
  assert.equal(isStop("the smoke alarm won't stop and I smell smoke"), false);
  assert.equal(classifyHardSafety("the smoke alarm won't stop and I smell smoke")?.tier, 3);
});

test("opt-in and help keywords are recognised", () => {
  for (const body of ["START", "YES", "UNSTOP"]) assert.equal(isStart(body), true, body);
  assert.equal(isHelp("HELP"), true);
  assert.equal(isHelp("help me please"), false);
});

test("the life-safety reply never claims help is coming", () => {
  assert.match(LIFE_SAFETY_REPLY, /call 911/i);
  assert.match(LIFE_SAFETY_REPLY, /cannot confirm that help is on the way/i);
});

test("a guarantor is scoped to the one person they guarantee", () => {
  const context = safeRoleContext({ id: "g-1", role: "guarantor", guarantor_of_person_id: "p-1" });
  assert.equal(context.allowedPersonId, "p-1");
  assert.match(context.rule, /Never discuss roommates/);
  const resident = safeRoleContext({ id: "p-2", role: "student" });
  assert.equal(resident.allowedPersonId, "p-2");
});
