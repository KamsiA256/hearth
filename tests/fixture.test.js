// The fixture must stay fully fictional. This test is the automated half of the rule
// in docs/BOUNDARIES.md; the other half is reading it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { build, meta } from "../data/willow-court.mjs";

const source = readFileSync(new URL("../data/willow-court.mjs", import.meta.url), "utf8");

// The pilot's identifying terms and real company names, as SHA-256 hashes so this
// public file does not name them itself. Every word, and every pair of words, in the
// fixture is hashed and checked against the list.
const FORBIDDEN = new Set([
  "eac5c9cfb0a953681057288b06b68b6e6c954d213b04022c780186c659e16a85",
  "9ec53301a24475f8fa937a9e1e1c9b30c16015e00dc6853ac1273edf7e4f6f15",
  "66d4996d6850c8e11ceb416cb13dbb6fcccce576409b37161549ab43125c0226",
  "3bbbaacf57a9d59a9edd7335955325e9c24670134c9e80748ab33c00cfec7aca",
  "c145a81f678d154b7a756205ece122f69d04098d7a5db132d49cb06ab3c34c5f",
  "f90a255b4520ca7bca77e933a1409debcdb49e3a56f494071d86c662040939c6",
  "d79b8a431b8c1d8d59df0e0f822c75177ebac928e55a7bb34d07d4fa26feb9a4",
]);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("no identifying string from the pilot or any real company survives", () => {
  const words = source.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const grams = [...words, ...words.slice(1).map((word, i) => `${words[i]} ${word}`)];
  for (const gram of grams) assert.ok(!FORBIDDEN.has(sha256(gram)), "fixture must not mention a pilot or real-company term");
});

test("the fixture cites no external source", () => {
  // An independently fictional property has nothing to cite. A URL here would mean
  // the scenario is leaning on something real again.
  assert.ok(!/https?:\/\//.test(source), "fixture must contain no URLs");
  assert.equal(meta.sources, undefined, "fixture must declare no sources");
  assert.equal(meta.publicFacts, undefined, "fixture must declare no public listing facts");
});

test("every phone number is in the reserved fictional range", () => {
  const tables = build();
  const numbers = [...tables.people.map((p) => p.phone), ...tables.phone_numbers.map((n) => n.sms_number)];
  assert.ok(numbers.length >= 10, "expected the fixture to define phone numbers");
  for (const number of numbers) {
    assert.match(number, /^\+1\d{3}55501\d{2}$/, `${number} must be in the reserved 555-0100-0199 range`);
  }
});

test("addresses and the organization are marked fictional", () => {
  const tables = build();
  for (const property of tables.properties) assert.match(property.address, /fictional/i);
  for (const organization of tables.organizations) assert.match(organization.name, /fictional/i);
  for (const group of tables.lease_groups) assert.match(group.academic_year, /fictional/i);
});

test("the lease text cannot be mistaken for a real lease", () => {
  for (const property of build().properties) assert.match(property.lease_text, /FICTIONAL/);
});

test("no outbound message in the fixture claims to have been delivered", () => {
  for (const message of build().messages.filter((m) => m.direction === "outbound")) {
    assert.equal(message.delivery_status, "dry_run", `${message.id} must be recorded as a dry run`);
  }
});

test("rent shares reconcile to the monthly total, to the cent", () => {
  for (const [propertyId, activity] of Object.entries(meta.rentActivity)) {
    const sum = activity.entries.reduce((total, entry) => total + Math.round(entry.amount * 100), 0);
    assert.equal(sum, Math.round(activity.total * 100), `${propertyId}: shares must sum to the monthly total`);
  }
});

test("rent shares are deliberately unequal, so an even split is never assumed", () => {
  for (const [propertyId, activity] of Object.entries(meta.rentActivity)) {
    const amounts = new Set(activity.entries.map((entry) => entry.amount));
    assert.ok(amounts.size > 1, `${propertyId}: shares should differ`);
  }
});

test("every rent entry names a person who exists at that property", () => {
  const tables = build();
  for (const [propertyId, activity] of Object.entries(meta.rentActivity)) {
    const residents = new Set(tables.people.filter((p) => p.property_id === propertyId).map((p) => p.id));
    for (const entry of activity.entries) {
      assert.ok(residents.has(entry.personId), `${entry.personId} must be a resident of ${propertyId}`);
    }
  }
});

test("the data directory holds exactly the scenarios we know about", () => {
  // An allow-list, not a count. A new dataset has to be added here deliberately,
  // because a scenario carries claims about what is real and what is invented, and
  // one appearing without review is how a demo starts asserting something nobody
  // checked.
  // college-ave-twelve-reviewed.mjs is the same household as college-ave-twelve.mjs
  // at a later point in its month, for the static reviewer build, which has no model
  // behind it and so cannot draft a split of its own. Its claims were reviewed: the
  // street address is real and everything else — the household, the split, and the
  // basis lines explaining it — is invented, which its header and the build's banner
  // both say. Nothing in it is presented as a model's output.
  const KNOWN = ["college-ave-twelve-reviewed.mjs", "college-ave-twelve.mjs", "datasets.mjs", "meeting-example.mjs", "meeting-scenario.mjs", "willow-court.mjs"];
  // room-facts.mjs is a shared helper (data/room-facts.mjs), not a scenario: it
  // declares no claims about what is real or invented, same as builder.mjs.
  const scenarios = readdirSync(new URL("../data/", import.meta.url)).filter((f) => !["builder.mjs", "in-memory-db.mjs", "room-facts.mjs"].includes(f));
  assert.deepEqual(scenarios.sort(), KNOWN);
});
