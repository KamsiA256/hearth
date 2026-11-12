// The allocation workspace: versions, confirmations, approval, and the status line.
//
// These tests exist because of specific ways this can go wrong, not to cover the
// module. The two that matter most: a confirmation must not survive a change to the
// numbers it confirmed, and the status row must never come back empty.
import test from "node:test";
import assert from "node:assert/strict";
import { createAllocationHandler } from "../server/allocation-api.mjs";
import { createMemoryAllocationStore } from "../src/allocation-store-memory.js";
import { allocationStatus, withShare, workspaceFor } from "../src/allocation-state.js";
import { allocationFor } from "../src/allocation.js";

const AUTH = { authorization: "Bearer demo" };
const PROPERTY = "wc-3a";

function harness({ invoices = [], provider = { available: true, reason: null, mappedCount: 4 } } = {}) {
  const store = createMemoryAllocationStore();
  const handler = createAllocationHandler({ store, invoicesFor: () => invoices, provider });
  // Writes must name the version on screen. Unless a test passes its own
  // versionCanonical (or null, to send none), use the one currently shown.
  const call = async (method, route, body, query = {}) => {
    if (method === "POST" && body && !("versionCanonical" in body)) {
      const shown = await handler({ path: "/api/allocation/workspace", httpMethod: "GET", headers: AUTH, queryStringParameters: { propertyId: PROPERTY }, body: null });
      body = { ...body, versionCanonical: JSON.parse(shown.body).version?.canonical };
    }
    if (body && body.versionCanonical === null) { body = { ...body }; delete body.versionCanonical; }
    const res = await handler({
      path: `/api/allocation/${route}`, httpMethod: method, headers: AUTH,
      queryStringParameters: { propertyId: PROPERTY, ...query },
      body: body ? JSON.stringify(body) : null,
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return { store, call, view: () => call("GET", "workspace") };
}

const share = (call, personId, amountCents) => call("POST", "share", { propertyId: PROPERTY, personId, amountCents });

// Willow Court's seed is `agreed`: that household settled its split and an invoice
// was already issued against it. So a test that needs an editable, balanced draft
// starts the way a landlord would — by revising the agreed split, which creates a
// new draft rather than touching the version residents confirmed.
async function balancedDraft(call) {
  await share(call, "p-3a-cam", 70000);   // 760 -> 700
  const r = await share(call, "p-3a-ada", 96000); // 900 -> 960, back to 3,200
  assert.equal(r.body.total.balances, true, "the revision should balance");
  assert.equal(r.body.version.state, "draft");
  return r;
}

test("an unbalanced draft saves, and cannot be published or approved", async () => {
  const { call } = harness();
  const after = await share(call, "p-3a-devi", 62000); // $680 -> $620, so $60 short
  assert.equal(after.status, 200, "the draft must still save");
  assert.equal(after.body.total.differenceCents, -6000);
  assert.equal(after.body.total.balances, false);

  const publish = await call("POST", "publish", { propertyId: PROPERTY });
  assert.equal(publish.status, 409);
  assert.equal(publish.body.code, "ALLOCATION_DOES_NOT_BALANCE");
  assert.match(publish.body.error, /\$60\.00 short/);

  const approve = await call("POST", "approve", { propertyId: PROPERTY });
  assert.equal(approve.status, 409);
});

test("a confirmation does NOT carry to a version with different numbers", async () => {
  // The whole point of binding a confirmation to the canonical form. Four people
  // agreeing to one set of numbers is not agreement to a different set, and a
  // landlord must not be able to approve collection on the strength of the first.
  const { call } = harness();
  await balancedDraft(call);
  await call("POST", "publish", { propertyId: PROPERTY });
  for (const personId of ["p-3a-ada", "p-3a-bo", "p-3a-cam", "p-3a-devi"]) {
    const r = await call("POST", "confirm", { propertyId: PROPERTY, personId });
    assert.equal(r.status, 200, `${personId} should be able to confirm`);
  }
  const ready = await call("GET", "workspace");
  assert.equal(ready.body.lines.filter((line) => line.confirmed).length, 4);
  assert.equal(ready.body.blocked.approve, null, "all four confirmed, so approval is open");

  // Now move another $40 between two residents. The total still balances.
  await share(call, "p-3a-bo", 82000);     // 860 -> 820
  const moved = await share(call, "p-3a-devi", 72000); // 680 -> 720
  assert.equal(moved.body.total.balances, true, "still balances to the cent");

  assert.equal(moved.body.lines.filter((line) => line.confirmed).length, 0, "no confirmation may carry across");
  for (const line of moved.body.lines) {
    assert.ok(line.confirmedOtherVersion, `${line.name} confirmed an earlier version and that should be visible, not erased`);
  }
  const approve = await call("POST", "approve", { propertyId: PROPERTY });
  assert.equal(approve.status, 409, "approval must be blocked again");
  // The edit produced a NEW draft, so the first thing standing in the way is that
  // nobody has been shown it yet — which is a truer statement than "nobody
  // confirmed", and the reason the four earlier confirmations cannot be reused.
  assert.match(approve.body.error, /not been published/);

  // Publishing the revision asks everyone again, from zero.
  const republished = await call("POST", "publish", { propertyId: PROPERTY });
  assert.equal(republished.status, 200);
  assert.equal(republished.body.lines.filter((line) => line.confirmed).length, 0);
  const stillBlocked = await call("POST", "approve", { propertyId: PROPERTY });
  assert.match(stillBlocked.body.error, /have not confirmed/);
});

test("confirming requires the version actually shown to that resident", async () => {
  // A resident holding a stale page confirms numbers that are no longer current.
  // Both versions are published here, so the refusal is specifically about WHICH
  // numbers they were shown — not about publication state.
  const { call } = harness();
  await balancedDraft(call);
  const first = await call("POST", "publish", { propertyId: PROPERTY });
  const shown = first.body.version.canonical;

  await share(call, "p-3a-devi", 60000);   // changes the numbers
  await share(call, "p-3a-ada", 104000);   // back into balance
  const second = await call("POST", "publish", { propertyId: PROPERTY });
  assert.equal(second.body.version.state, "proposed");
  assert.notEqual(second.body.version.canonical, shown);

  const stale = await call("POST", "confirm", { propertyId: PROPERTY, personId: "p-3a-ada", versionCanonical: shown });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "STALE_VERSION");
  assert.match(stale.body.error, /was shown different numbers/);

  // The same resident confirming what is actually on screen is accepted.
  const fresh = await call("POST", "confirm", { propertyId: PROPERTY, personId: "p-3a-ada", versionCanonical: second.body.version.canonical });
  assert.equal(fresh.status, 200);
});

test("an edit against a version that already moved on is refused", async () => {
  const { call } = harness();
  const opened = await call("GET", "workspace");
  const seen = opened.body.version.canonical;
  await share(call, "p-3a-devi", 61000);
  const second = await call("POST", "share", { propertyId: PROPERTY, personId: "p-3a-ada", amountCents: 91000, versionCanonical: seen });
  assert.equal(second.status, 409, "a second operator must not overwrite an edit they never saw");
  assert.equal(second.body.code, "STALE_VERSION");
});

test("a share cannot be negative, and must be whole cents", async () => {
  const { call } = harness();
  const negative = await call("POST", "share", { propertyId: PROPERTY, personId: "p-3a-devi", amountCents: -100 });
  assert.equal(negative.body.code, "NEGATIVE_SHARE");
  const fractional = await call("POST", "share", { propertyId: PROPERTY, personId: "p-3a-devi", amountCents: 680.5 });
  assert.equal(fractional.body.code, "NOT_INTEGER_CENTS");
});

test("an edit that changes nothing creates no version", async () => {
  const { call } = harness();
  const before = await call("GET", "workspace");
  const same = await share(call, "p-3a-devi", before.body.lines.find((l) => l.personId === "p-3a-devi").amountCents);
  assert.equal(same.body.version.n, before.body.version.n, "tabbing through a field is not a change");
  assert.equal(same.body.createdVersion, false);
});

test("resetting the walkthrough is refused once invoices exist", async () => {
  // Allocation and collection have different durability. Clearing a draft must
  // never leave a real provider invoice pointing at numbers nobody approved.
  const { call } = harness({ invoices: [{ providerInvoiceId: "INV2-XXXX", localState: "sent", paidCents: 0 }] });
  const reset = await call("POST", "reset", { propertyId: PROPERTY });
  assert.equal(reset.status, 409);
  assert.equal(reset.body.code, "HAS_INVOICES");
});

test("the status row is never empty, in every state a period can be in", async () => {
  // An empty widget is a claim that nothing needs attention. Every one of these
  // must produce a headline a landlord can act on.
  const people = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  const activity = { period: "November 2026", total: 1000, entries: [{ personId: "a", amount: 600 }, { personId: "b", amount: 400 }] };
  const snapshotOf = (act) => allocationFor({ propertyId: "p", activity: act, people });

  const cases = [
    ["no allocation at all", null, null, []],
    ["unbalanced draft", { ...activity, entries: [{ personId: "a", amount: 500 }, { personId: "b", amount: 400 }], seedState: "draft" }, null, []],
    ["balanced draft", { ...activity, seedState: "draft" }, null, []],
    ["proposed, none confirmed", { ...activity, seedState: "proposed" }, null, []],
    ["agreed, nothing issued", { ...activity, seedState: "agreed" }, null, []],
    ["agreed, one uncertain send", { ...activity, seedState: "agreed" }, null, [{ providerInvoiceId: "i1", localState: "send_uncertain" }]],
    ["agreed, one issued against old numbers", { ...activity, seedState: "agreed" }, null, [{ providerInvoiceId: "i1", localState: "sent", stale: true }]],
    ["agreed, a failed send", { ...activity, seedState: "agreed" }, null, [{ providerInvoiceId: "i1", localState: "send_failed" }]],
    ["agreed, partially collected", { ...activity, seedState: "agreed" }, null, [{ providerInvoiceId: "i1", localState: "sent", paidCents: 60000 }]],
  ];

  for (const [label, act, stored, invoices] of cases) {
    const snapshot = act ? snapshotOf(act) : null;
    const workspace = act ? workspaceFor({ activity: act, stored }) : null;
    const status = allocationStatus({ snapshot, workspace, invoices, residentCount: 2, provider: { available: true, mappedCount: 2 } });
    assert.ok(status && typeof status.headline === "string" && status.headline.length > 0, `${label}: no headline`);
    assert.ok(status.detail && status.detail.length > 0, `${label}: no detail`);
    assert.ok(["landlord", "residents", "nobody"].includes(status.waitingOn), `${label}: waitingOn was ${status.waitingOn}`);
  }
});

test("attention outranks progress", async () => {
  // A household that has collected nearly everything but has one send it cannot
  // account for must report the send, not the percentage.
  const people = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  const activity = { period: "November 2026", total: 1000, seedState: "agreed", entries: [{ personId: "a", amount: 600 }, { personId: "b", amount: 400 }] };
  const snapshot = allocationFor({ propertyId: "p", activity, people });
  const workspace = workspaceFor({ activity, stored: null });
  const status = allocationStatus({
    snapshot, workspace, residentCount: 2, provider: { available: true, mappedCount: 2 },
    invoices: [
      { providerInvoiceId: "i1", localState: "sent", paidCents: 90000 },
      { providerInvoiceId: "i2", localState: "send_uncertain", paidCents: 0 },
    ],
  });
  assert.match(status.headline, /needs checking/);
  assert.equal(status.tone, "overdue");
});

test("offline mode and server mode compute the same allocation", async () => {
  // The divergence this module exists to remove: offline mode used to build its own
  // view in the browser, where an unbalanced draft looked publishable.
  const offline = harness({ provider: { available: false, reason: "Offline mode.", mappedCount: 0 } });
  const server = harness({ provider: { available: true, reason: null, mappedCount: 4 } });
  for (const { call } of [offline, server]) await share(call, "p-3a-devi", 62000);
  const a = (await offline.view()).body, b = (await server.view()).body;

  assert.equal(a.total.differenceCents, b.total.differenceCents);
  assert.equal(a.version.canonical, b.version.canonical);
  assert.equal(a.blocked.publish, b.blocked.publish, "the blocking reason must be identical in both modes");
  assert.equal(a.status.headline, b.status.headline, "and so must the status line");
  // What legitimately differs is collection, and only collection.
  assert.equal(a.provider.available, false);
  assert.equal(b.provider.available, true);
});

test("a published version is never edited in place", () => {
  const activity = { period: "November 2026", total: 1000, seedState: "proposed", entries: [{ personId: "a", amount: 600 }, { personId: "b", amount: 400 }] };
  const workspace = workspaceFor({ activity, stored: null });
  const { version, created } = withShare(workspace, { personId: "a", cents: 70000 });
  assert.equal(created, true);
  assert.equal(version.n, workspace.current.n + 1);
  assert.equal(version.state, "draft");
  assert.equal(workspace.current.lines.a, 60000, "the version residents saw must be untouched");
});

test("a dataset whose split is already agreed does not ask for confirmations again", async () => {
  // Willow Court's household settled its split before Hearth saw it, and an invoice
  // was issued against those exact numbers. Showing "awaiting confirmation" there
  // would invent an outstanding step. Any real confirmation then takes over.
  const { call } = harness();
  const view = await call("GET", "workspace");
  assert.equal(view.body.version.state, "agreed");
  for (const line of view.body.lines) {
    assert.equal(line.confirmed, true, `${line.name} should read as agreed`);
    assert.equal(line.confirmedBySeed, true, "and as agreed ON FILE, not confirmed in Hearth");
  }
  // Once the split is revised, the seed's agreement does not carry to new numbers.
  await balancedDraft(call);
  const revised = await call("GET", "workspace");
  assert.equal(revised.body.version.state, "draft");
  assert.equal(revised.body.lines.filter((line) => line.confirmed).length, 0);
});

test("an invoiced line reports the provider's state beside the agreed share", async () => {
  // The two columns that must never merge. The share is what the household agreed;
  // the payment state is what the provider says, and only the provider can say it.
  const { call } = harness({
    invoices: [{ personId: "p-3a-devi", localState: "sent", providerInvoiceId: "INV2-TEST", providerStatus: "PAID", paymentState: "paid", paymentStateLabel: "Paid in full", paidCents: 68000, dueCents: 0, approvedAllocationVersion: null }],
  });
  const view = await call("GET", "workspace");
  const devi = view.body.lines.find((line) => line.personId === "p-3a-devi");
  assert.equal(devi.amountLabel, "$680.00", "the agreed share");
  assert.equal(devi.invoice.paymentStateLabel, "Paid in full", "and separately, what the provider said");
  assert.equal(devi.invoice.stale, false);
  for (const other of view.body.lines.filter((line) => line.personId !== "p-3a-devi")) {
    assert.equal(other.invoice, null, `${other.name} has no invoice and must not borrow Devi's`);
  }
});

test("an invoice approved against other numbers is reported as stale", async () => {
  const { call } = harness({
    invoices: [{ personId: "p-3a-devi", localState: "sent", providerInvoiceId: "INV2-OLD", providerStatus: "SENT", paymentState: "sent", paidCents: 0, approvedAllocationVersion: '{"property":"wc-3a","period":"november-2026","total":320000,"lines":[["p-3a-devi",99900]]}' }],
  });
  const view = await call("GET", "workspace");
  assert.equal(view.body.lines.find((line) => line.personId === "p-3a-devi").invoice.stale, true);
  assert.match(view.body.status.headline, /older numbers/);
});

test("editing a draft stays in the same version; editing a published one does not", async () => {
  // The version number tracks what people have been asked to agree to, not how many
  // times a landlord nudged a number. A private draft is one proposal being worked
  // on. A published version is something residents have seen.
  const { call } = harness();
  const start = await balancedDraft(call);
  const n = start.body.version.n;

  // Four edits inside the draft. Still one version.
  await share(call, "p-3a-devi", 67000);
  await share(call, "p-3a-devi", 66000);
  await share(call, "p-3a-devi", 65000);
  const stillDraft = await share(call, "p-3a-ada", 99000);
  assert.equal(stillDraft.body.version.n, n, "nudging a draft must not mint versions");
  assert.equal(stillDraft.body.version.state, "draft");

  // But the fingerprint moved every time, which is what the rules actually run on.
  assert.notEqual(stillDraft.body.version.canonical, start.body.version.canonical);
  assert.notEqual(stillDraft.body.version.label, start.body.version.label);

  // After those nudges: Ada 990, Bo 860, Cam 700, Devi 650 = $3,200, so it still
  // balances and can be published.
  assert.equal(stillDraft.body.total.balances, true);

  // Once published, the same edit creates a new version instead.
  const published = await call("POST", "publish", { propertyId: PROPERTY });
  assert.equal(published.status, 200, published.body.error);
  assert.equal(published.body.version.n, n);
  const afterPublish = await share(call, "p-3a-devi", 60000);
  assert.equal(afterPublish.body.version.n, n + 1, "numbers residents have seen are never edited in place");
  assert.equal(afterPublish.body.version.state, "draft");
  assert.equal(afterPublish.body.createdVersion, true);
});

test("an edit inside a draft still invalidates a confirmation that matched it", async () => {
  // The version number stays put, so the protection has to come from the
  // fingerprint. If it did not, a landlord could collect a confirmation, quietly
  // adjust a share within "the same version", and still look approved.
  const { call } = harness();
  await balancedDraft(call);
  await call("POST", "publish", { propertyId: PROPERTY });
  await call("POST", "confirm", { propertyId: PROPERTY, personId: "p-3a-ada" });

  const confirmedView = await call("GET", "workspace");
  assert.equal(confirmedView.body.lines.find((l) => l.personId === "p-3a-ada").confirmed, true);

  // Edit, which creates v(n+1) as a draft, then edit again INSIDE that draft.
  await share(call, "p-3a-devi", 60000);
  const second = await share(call, "p-3a-devi", 61000);
  assert.equal(second.body.version.state, "draft");
  assert.equal(second.body.lines.find((l) => l.personId === "p-3a-ada").confirmed, false,
    "Ada confirmed different numbers; her confirmation must not apply here");
  assert.ok(second.body.lines.find((l) => l.personId === "p-3a-ada").confirmedOtherVersion,
    "and it should still be visible that she confirmed something earlier");
});

test("a resident's billing destination is reported per person, not as a count", async () => {
  // The Rent page shows "No billing destination" per row. Reading that from a count
  // made every row wrong as soon as some residents were mapped and others were not.
  const { call } = harness({ provider: { available: true, reason: null, mappedCount: 1, mappedPersonIds: ["p-3a-devi"] } });
  const view = await call("GET", "workspace");
  const mapped = view.body.lines.filter((line) => line.recipientMapped).map((line) => line.personId);
  assert.deepEqual(mapped, ["p-3a-devi"]);
  assert.equal(view.body.lines.find((line) => line.personId === "p-3a-ada").recipientMapped, false);
});

test("with no provider, nobody has a billing destination", async () => {
  const { call } = harness({ provider: { available: false, reason: "Offline mode.", mappedCount: 0 } });
  const view = await call("GET", "workspace");
  assert.equal(view.body.lines.some((line) => line.recipientMapped), false);
});
