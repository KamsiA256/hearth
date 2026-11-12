// The meeting demonstration: a reusable capability in the committed tree, a real
// meeting's profile only on the presenter's machine. These tests hold both halves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The dataset is chosen once at module load (data/datasets.mjs), so select it
// before anything imports the database module.
process.env.HEARTH_DATASET = "meeting-example";
const { scenarioFromProfile, validateMeetingProfile, MEETING_IDS } = await import("../data/meeting-scenario.mjs");
const willow = await import("../data/willow-court.mjs");
const example = JSON.parse(readFileSync(new URL("../fixtures/meeting-profile.example.json", import.meta.url), "utf8"));
const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "hearth-meeting-"));
const clone = () => JSON.parse(JSON.stringify(example));

test("the example profile is valid and opens as a balanced, unpublished draft", () => {
  const { meta } = scenarioFromProfile(example);
  const activity = meta.rentActivity[MEETING_IDS.property];
  assert.equal(activity.seedState, "draft");
  assert.equal(activity.illustrative, true);
  assert.equal(activity.due, null, "no due date is invented");
  const sum = activity.entries.reduce((s, e) => s + Math.round(e.amount * 100), 0);
  assert.equal(sum, example.householdTotalCents);
  assert.match(meta.disclaimer, /fictional household/i);
  assert.match(activity.source, /not this property's rent/i);
});

test("a profile may not carry anything but a label, a total, a period and a fictional household", () => {
  const refusals = [
    ["extra top-level field", (p) => { p.leaseStart = "2026-08-01"; }],
    ["extra resident field", (p) => { p.residents[0].email = "x@example.test"; }],
    ["email in a name", (p) => { p.residents[0].name = "someone@example.test"; }],
    ["URL in the label", (p) => { p.propertyLabel = "https://listing.example/unit"; }],
    ["phone in a name", (p) => { p.residents[1].name = "Call 607-555-0123"; }],
    ["account-shaped number", (p) => { p.propertyLabel = "Acct 123456789012"; }],
    ["shares do not reconcile", (p) => { p.residents[0].shareCents += 1; }],
    ["fractional cents", (p) => { p.householdTotalCents = 2400.5; }],
    ["negative share", (p) => { p.residents[0].shareCents = -1; p.residents[1].shareCents += 85001; }],
    ["a single resident", (p) => { p.residents = [{ name: "Solo", shareCents: p.householdTotalCents }]; }],
    ["an even split", (p) => { p.householdTotalCents = 240000; p.residents.forEach((r) => { r.shareCents = 80000; }); }],
    ["wrong version", (p) => { p.profileVersion = 2; }],
  ];
  for (const [why, mutate] of refusals) {
    const p = clone(); mutate(p);
    assert.throws(() => validateMeetingProfile(p), /Meeting profile refused/, why);
  }
});

test("meeting ids are fixed and share nothing with any other dataset", () => {
  const meeting = scenarioFromProfile(example).build();
  const other = willow.build();
  const idsOf = (t) => new Set([...t.organizations, ...t.properties, ...t.people, ...t.rooms, ...t.lease_groups].map((r) => r.id));
  const overlap = [...idsOf(meeting)].filter((id) => idsOf(other).has(id));
  assert.deepEqual(overlap, []);
  for (const id of idsOf(meeting)) assert.match(id, /^(org-)?meeting-demo/);
  for (const person of meeting.people) assert.match(person.phone, /^\+1\d{3}55501\d{2}$/, "reserved fictional range only");
  assert.ok(meeting.properties.every((p) => p.lease_text.includes("FICTIONAL")));
  // A profile cannot choose ids, so it cannot point at an existing resident or invoice.
  const p = clone(); p.residents[0].id = "p-3a-devi";
  assert.throws(() => validateMeetingProfile(p), /unexpected field/);
});

test("the meeting path runs end to end with the simulated provider, and sent is not paid", async () => {
  // Under Node the entry's payment store uses the real fs (the browser bundle shims
  // it to page memory), so run it from a scratch directory, never the repository.
  process.chdir(tmp);
  const { demoFetch } = await import("../scripts/reviewer-entry.mjs");
  const P = MEETING_IDS.property;
  const call = async (method, url, body) => {
    const res = await demoFetch(url, { method, headers: { authorization: "Bearer demo" }, body: body ? JSON.stringify({ propertyId: P, ...body }) : undefined });
    return { status: res.status, body: await res.json() };
  };
  let view = (await call("GET", `/api/allocation/workspace?propertyId=${P}`)).body;
  assert.equal(view.version.state, "draft");
  assert.equal(view.total.balances, true);
  const [a, b] = view.lines;

  // Unbalance it: saves, but publish is refused.
  view = (await call("POST", "/api/allocation/share", { personId: a.personId, amountCents: a.amountCents - 5000, versionCanonical: view.version.canonical })).body;
  assert.equal(view.total.balances, false);
  assert.ok(view.blocked.publish);
  const refused = await call("POST", "/api/allocation/publish", { versionCanonical: view.version.canonical });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "ALLOCATION_DOES_NOT_BALANCE");

  // Restore exactly, publish, confirm everyone, approve.
  view = (await call("POST", "/api/allocation/share", { personId: b.personId, amountCents: b.amountCents + 5000, versionCanonical: view.version.canonical })).body;
  assert.equal(view.total.balances, true);
  view = (await call("POST", "/api/allocation/publish", { versionCanonical: view.version.canonical })).body;
  const early = await call("POST", "/api/allocation/approve", { versionCanonical: view.version.canonical });
  assert.equal(early.status, 409, "approval waits for every confirmation");
  for (const line of view.lines) view = (await call("POST", "/api/allocation/confirm", { personId: line.personId, versionCanonical: view.version.canonical })).body;
  view = (await call("POST", "/api/allocation/approve", { versionCanonical: view.version.canonical })).body;
  assert.equal(view.version.state, "agreed");

  // Prepare, review, send, refresh.
  const draft = await call("POST", "/api/payments/draft", { personId: a.personId, allocationVersion: view.version.canonical });
  assert.ok([200, 201].includes(draft.status), JSON.stringify(draft.body));
  assert.equal(draft.body.review.simulated, true);
  assert.match(draft.body.review.recipient.email, /@example\.test$/);
  const again = await call("POST", "/api/payments/draft", { personId: a.personId, allocationVersion: view.version.canonical });
  assert.equal(again.body.review.invoice.providerInvoiceId, draft.body.review.invoice.providerInvoiceId, "a second prepare reuses the draft");
  const unconfirmed = await call("POST", "/api/payments/send", { personId: a.personId, allocationVersion: view.version.canonical });
  assert.notEqual(unconfirmed.status, 200, "send requires explicit confirmation");
  const sent = await call("POST", "/api/payments/send", { personId: a.personId, allocationVersion: view.version.canonical, confirmed: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.review.invoice.localState, "sent");
  assert.equal(sent.body.review.invoice.paymentState, "sent", "sent is not paid");
  assert.equal(sent.body.review.invoice.paidCents, 0, "nothing collected on send");
  const twice = await call("POST", "/api/payments/send", { personId: a.personId, allocationVersion: view.version.canonical, confirmed: true });
  assert.equal(twice.body.alreadySent, true, "a second send does not send again");
  const refreshed = await call("POST", "/api/payments/refresh", { personId: a.personId });
  assert.equal(refreshed.body.review.invoice.paymentState, "paid");
});

test("build:meeting compiles only the local profile, labelled, with no local path or other scenario", () => {
  const out = path.join(tmp, "meeting");
  execFileSync(process.execPath, [path.join(root, "scripts/build-reviewer.mjs"), "--meeting"], {
    env: { ...process.env, REVIEWER_OUT: out, HEARTH_MEETING_PROFILE: path.join(root, "fixtures/meeting-profile.example.json") }, stdio: "pipe",
  });
  const html = readFileSync(path.join(out, "index.html"), "utf8");
  assert.match(html, /MEETING DEMONSTRATION/);
  assert.match(html, /payments are simulated/);
  const bundle = readFileSync(path.join(out, "app.js"), "utf8");
  assert.ok(bundle.includes("12 Example Lane"));
  for (const forbidden of ["Willow Court", "p-3a-devi", os.homedir(), root, "paypal.com", "XMLHttpRequest", "sendBeacon"]) {
    assert.ok(!bundle.includes(forbidden), `meeting bundle must not contain ${forbidden}`);
  }
});

test("build:meeting refuses a profile carrying contact data, and builds nothing from it", () => {
  const bad = clone(); bad.residents[0].name = "reach.me@example.test";
  const file = path.join(tmp, "bad.json"); writeFileSync(file, JSON.stringify(bad));
  const out = path.join(tmp, "bad-out");
  const run = spawnSync(process.execPath, [path.join(root, "scripts/build-reviewer.mjs"), "--meeting"], { env: { ...process.env, REVIEWER_OUT: out, HEARTH_MEETING_PROFILE: file }, encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Meeting profile refused/);
});

test("the committed tree names no real property and carries no listing source", () => {
  // Assembled, so this file does not match itself.
  const forbidden = [["Cay", "uga"], ["ithaca", "rents"], ["N ", "Cay"], ["2,4", "50"]].map((parts) => parts.join("").toLowerCase());
  const skip = new Set(["node_modules", ".git", "dist", ".hearth-local"]);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const text = readFileSync(full, "utf8").toLowerCase();
      for (const word of forbidden) if (text.includes(word)) hits.push(`${path.relative(root, full)}: ${word}`);
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});

// ---- Repairs after review (2026-11-05). Each failed before its fix. ----
const { periodKey } = await import("../src/allocation.js");
const { readPeriodKey } = await import("../src/payments/paypal-sandbox.js");

test("regression: a period invoicing cannot read is refused up front, not at Prepare invoice", () => {
  for (const period of ["Fall 2026", "2026/11", "Autumn term", "!!!", "Nov 2026", "November 26"]) {
    const p = clone(); p.period = period;
    assert.throws(() => validateMeetingProfile(p), /period must be a month and year/, period);
  }
  // Every period the validator accepts is one the invoice numbering can read.
  for (const month of ["January", "June", "November", "December"]) {
    const p = clone(); p.period = `${month} 2027`;
    const { period } = validateMeetingProfile(p);
    assert.doesNotThrow(() => readPeriodKey(periodKey(period)), period);
  }
});

test("regression: labels and names are plain text without money, domains or long numbers", () => {
  const label = (text) => { const p = clone(); p.propertyLabel = text; return p; };
  const name = (text) => { const p = clone(); p.residents[0].name = text; return p; };
  for (const p of [label("4111 1111 1111 1111"), label("zillow.com/homedetails"), label("Lease ends 2027-05-31, rent $1,999/mo"),
    label("Café Row"), label("O’Hara House"), label("x".repeat(81)),
    name("Unit 4 Resident"), name("Jo 2")]) {
    assert.throws(() => validateMeetingProfile(p), /Meeting profile refused/, JSON.stringify(p.propertyLabel + " / " + p.residents[0].name));
  }
  assert.doesNotThrow(() => validateMeetingProfile(label("12 Example Lane (fictional)")));
  // Full-width digits are normalized to plain ones, so the label reaches the bundle as ASCII.
  assert.equal(validateMeetingProfile(label("\uff17\uff18\uff19 Main")).propertyLabel, "789 Main");
});

test("regression: bounds hold — at most six residents, a capped total, and the unknowns are listed", () => {
  const seven = clone(); seven.residents = Array.from({ length: 7 }, (_, i) => ({ name: `Person ${"ABCDEFG"[i]}`, shareCents: 10000 + i }));
  seven.householdTotalCents = seven.residents.reduce((s, r) => s + r.shareCents, 0);
  assert.throws(() => validateMeetingProfile(seven), /2 to 6/);
  const huge = clone(); huge.householdTotalCents = 10_000_001; huge.residents[0].shareCents += 10_000_001 - 240000;
  assert.throws(() => validateMeetingProfile(huge), /between 1 and 10,000,000/);
  const { meta } = scenarioFromProfile(example);
  for (const fact of ["the property's actual rent", "bedrooms and bathrooms", "the lease and its dates", "availability"]) {
    assert.ok(meta.provenance.unknown.includes(fact), `unknown must list: ${fact}`);
  }
  assert.ok(scenarioFromProfile(example).build().rooms.every((room) => !/undefined/.test(room.label)));
});

test("regression: a draft still being created blocks share edits and reset, like an existing invoice", async () => {
  const { createAllocationHandler } = await import("../server/allocation-api.mjs");
  const { createMemoryAllocationStore } = await import("../src/allocation-store-memory.js");
  const P = MEETING_IDS.property;
  for (const simulated of [true, false]) {
    const h = createAllocationHandler({ store: createMemoryAllocationStore(), provider: { available: true, simulated },
      invoicesFor: () => [{ personId: MEETING_IDS.resident(0), localState: "draft_proposed", providerInvoiceId: null }] });
    const ev = (route, method, body) => h({ path: `/api/allocation/${route}`, httpMethod: method, headers: { authorization: "Bearer demo" }, queryStringParameters: { propertyId: P }, body: body ? JSON.stringify({ propertyId: P, ...body }) : null });
    const view = JSON.parse((await ev("workspace", "GET")).body);
    const edit = await ev("share", "POST", { personId: view.lines[0].personId, amountCents: 1, versionCanonical: view.version.canonical });
    assert.equal(edit.statusCode, 409);
    const body = JSON.parse(edit.body);
    assert.equal(body.code, "HAS_INVOICES");
    assert.equal(/PayPal/.test(body.error), !simulated, "the simulated demo never tells anyone to go to PayPal");
    assert.equal((await ev("reset", "POST", {})).statusCode, 409);
  }
});

test("regression: illustrative totals are never labelled monthly rent, and the demo number claims no automation", () => {
  const app = readFileSync(path.join(root, "public/app.js"), "utf8");
  assert.match(app, /Household total \(illustrative\)/);
  assert.ok(!/Hearth answers routine questions/.test(app), "no automated-answer claim: this build makes no model call");
  assert.doesNotMatch(app, /<span>Monthly rent<\/span>|<dt>Monthly rent:<\/dt>/, "rent labels go through totalLabel()");
});

test("regression: the meeting build shows the full disclaimer on screen; the reviewer build keeps it hidden", () => {
  const out = path.join(tmp, "meeting-notice");
  execFileSync(process.execPath, [path.join(root, "scripts/build-reviewer.mjs"), "--meeting"], { env: { ...process.env, REVIEWER_OUT: out, HEARTH_MEETING_PROFILE: path.join(root, "fixtures/meeting-profile.example.json") }, stdio: "pipe" });
  assert.ok(!readFileSync(path.join(out, "index.html"), "utf8").includes("#datasetNotice{display:none"));
});

test("regression: a double click on Confirm-send cannot also refresh (which pays, in the offline demo)", () => {
  const app = readFileSync(path.join(root, "public/app.js"), "utf8");
  assert.match(app, /openInvoiceReview\(property, result\.review, reload, \{ justSent: true \}\)/, "the send path marks the review as just sent");
  assert.match(app, /if \(refresh && justSent\) \{ refresh\.disabled = true;/, "Refresh starts disabled right after a send");
});
