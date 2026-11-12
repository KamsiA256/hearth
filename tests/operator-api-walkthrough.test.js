// The operator API calls the demo walkthrough depends on, exercised in-process.
// This does NOT run a browser and does not test the interface: it proves each API
// route the walkthrough uses returns data and accepts its actions.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build, meta } from "../data/willow-court.mjs";
import { useDemoTables } from "../server/_shared/db.mjs";
import { handler } from "../server/operator-api.mjs";

const A = "wc-3a", B = "wc-5b";
const call = async (path, options = {}) => {
  const result = await handler({
    path: `/api/operator/${path}`,
    httpMethod: options.method || "GET",
    headers: { authorization: "Bearer demo" },
    queryStringParameters: options.query || {},
    body: options.body ? JSON.stringify(options.body) : null,
  });
  return { status: result.statusCode, body: JSON.parse(result.body) };
};
const ok = async (path, options) => { const r = await call(path, options); assert.equal(r.status, options?.method === "POST" ? r.status : 200, `${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`); assert.ok(r.status < 300, `${path} -> ${r.status}`); return r.body; };

beforeEach(() => useDemoTables(build()));

test("every operator API route the walkthrough uses returns data", async () => {
  const properties = await ok("properties");
  assert.deepEqual(properties.map((p) => p.id).sort(), [A, B]);
  assert.ok(properties.every((p) => p.people.length > 0), "each property has residents");

  const overview = await ok("overview");
  assert.equal(overview.length, 2);

  for (const propertyId of [A, B]) {
    for (const route of ["turnover", "needs-human", "escalations", "evidence", "recipients", "timeline", "requests", "request-groups"]) {
      await ok(route, { query: { propertyId } });
    }
  }
  await ok("messages", { query: { propertyId: A } });
});

test("Today has something that needs the landlord at each property", async () => {
  const needsA = await ok("needs-human", { query: { propertyId: A } });
  assert.ok(needsA.some((m) => /paid on the 3rd/.test(m.body)), "3A: a rent-timing question is waiting");

  const needsB = await ok("needs-human", { query: { propertyId: B } });
  assert.ok(needsB.some((m) => /sublet/.test(m.body)), "5B: the sublet question is waiting");

  const escalations = await ok("escalations", { query: { propertyId: B } });
  const heat = escalations.find((e) => e.id === "esc-5b-heat");
  assert.equal(heat.status, "open");
  assert.equal(heat.tier, 2);
});

test("the applicant group can be completed, decided and undone", async () => {
  const groups = await ok("request-groups", { query: { propertyId: A } });
  const group = groups.find((g) => g.id === "grp-3a-2027");
  assert.equal(group.decision, null);

  // Record the reference that was missing on Kemi's file, with where it came from.
  const answered = await ok("request-answer", { method: "POST", body: { propertyId: A, requestId: "req-3a-kemi", fieldKey: "rental_history", value: "Returned · no issues noted", source: "Reference form" } });
  assert.equal(answered.answers.rental_history.value, "Returned · no issues noted");
  assert.equal(answered.answers.rental_history.source, "Reference form");

  // An answer with no source is refused: the record has to say where it came from.
  assert.equal((await call("request-answer", { method: "POST", body: { propertyId: A, requestId: "req-3a-kemi", fieldKey: "income", value: "Pay stubs", source: "" } })).status, 400);

  // A decision needs a reason, then it sticks, then it can be undone.
  assert.equal((await call("request-decision", { method: "POST", body: { propertyId: A, groupId: group.id, decision: "approve", note: "" } })).status, 400);
  const decided = await ok("request-decision", { method: "POST", body: { propertyId: A, groupId: group.id, decision: "approve", note: "All four files complete; approved for a 12-month lease." } });
  assert.equal(decided.decision, "approve");
  assert.equal((await call("request-decision", { method: "POST", body: { propertyId: A, groupId: group.id, decision: "hold", note: "changed my mind" } })).status, 409, "a decided group must be undone first");
  const undone = await ok("request-decision", { method: "POST", body: { propertyId: A, groupId: group.id, decision: null } });
  assert.equal(undone.decision, null);

  // Both steps stay in the property record.
  const timeline = await ok("timeline", { query: { propertyId: A } });
  const summaries = timeline.filter((x) => x.type === "audit").map((x) => x.metadata?.summary || "");
  assert.ok(summaries.some((s) => /you chose “Approve”/.test(s)), "the decision is in the record");
  assert.ok(summaries.some((s) => /you undid “Approve”/.test(s)), "the undo is in the record");
});

test("approving a reply records it as a dry run and marks the question answered", async () => {
  const before = await ok("needs-human", { query: { propertyId: B } });
  const question = before.find((m) => /sublet/.test(m.body));

  const sent = await ok("manual-reply", { method: "POST", body: { propertyId: B, sourceMessageId: question.id, personId: question.person_id, conversationId: question.conversation_id, body: "Subletting needs my written approval first — send me your friend's details and I'll review." } });
  assert.equal(sent.delivery_status, "dry_run", "a demo reply is never a delivery");
  assert.equal(sent.direction, "outbound");
  assert.match(sent.body, /^Hearth: /);
  assert.match(sent.body, /Reply STOP to opt out\.$/);
  assert.equal(sent.in_reply_to_message_id, question.id);

  const after = await ok("needs-human", { query: { propertyId: B } });
  assert.ok(!after.some((m) => m.id === question.id), "the answered question leaves the queue");
});

test("the urgent repair can be marked handled, once", async () => {
  const resolved = await ok("resolve-escalation", { method: "POST", body: { propertyId: B, id: "esc-5b-heat" } });
  assert.equal(resolved.status, "resolved");
  assert.ok(resolved.resolved_at);
  assert.equal((await call("resolve-escalation", { method: "POST", body: { propertyId: B, id: "esc-5b-heat" } })).status, 404, "it cannot be resolved twice");

  const timeline = await ok("timeline", { query: { propertyId: B } });
  assert.ok(timeline.some((x) => x.type === "audit" && /Marked handled/.test(x.metadata?.summary || "")));
});

test("a call can be logged against a resident and appears in their record", async () => {
  const logged = await call("call-log", { method: "POST", body: { propertyId: B, personId: "p-5b-elan", summary: "Called about the radiators; plumber booked for tomorrow morning." } });
  assert.equal(logged.status, 201);
  const record = await ok("timeline", { query: { propertyId: B, personId: "p-5b-elan" } });
  assert.ok(record.some((x) => x.type === "call" && /plumber booked/.test(x.summary)));
});

test("turnover tasks save, and refuse values the workflow does not define", async () => {
  const task = await ok("workflow-task", { method: "POST", body: { propertyId: A, personId: "p-3a-ada", taskKey: "key_status", status: "complete", valueText: "returned" } });
  assert.equal(task.value_text, "returned");
  assert.equal((await call("workflow-task", { method: "POST", body: { propertyId: A, personId: "p-3a-ada", taskKey: "key_status", status: "complete", valueText: "melted" } })).status, 400);
  assert.equal((await call("workflow-task", { method: "POST", body: { propertyId: A, personId: "p-3a-ada", taskKey: "invented_task", status: "complete" } })).status, 400);

  const turnover = await ok("turnover", { query: { propertyId: A } });
  assert.equal(turnover.students.find((s) => s.id === "p-3a-ada").tasks.key_status.value_text, "returned");
});

test("rent activity is present for both properties and reconciles", async () => {
  const properties = await ok("properties");
  for (const property of properties) {
    const activity = meta.rentActivity[property.id];
    assert.ok(activity, `${property.id} has rent activity`);
    const sum = activity.entries.reduce((t, e) => t + Math.round(e.amount * 100), 0);
    assert.equal(sum, Math.round(activity.total * 100));
    // Every room's entered share is visible to the interface.
    assert.ok(property.rooms.every((r) => r.rent_share != null));
  }
});

test("the property record exports with its audit trail", async () => {
  const exported = await ok("export", { query: { propertyId: A } });
  assert.equal(exported.property.id, A);
  assert.ok(exported.property.people.length >= 4);
  assert.ok(Array.isArray(exported.property.audit_events));
  assert.match(exported.warning, /expire/i);
});
