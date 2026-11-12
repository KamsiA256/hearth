// The API's load-bearing claim: a request only ever sees the organizations its
// operator belongs to, and a record outside them is reported exactly like a record
// that does not exist.
//
// The demo operator is scoped to the fixture's one organization. So installing a
// SECOND organization alongside it gives a real test: every row of that second
// organization must be invisible, and naming it must 404 rather than 403, because a
// 403 would confirm it exists.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createDatasetBuilder } from "../data/builder.mjs";
import { build } from "../data/willow-court.mjs";
import { useDemoTables } from "../server/_shared/db.mjs";
import { handler } from "../server/operator-api.mjs";

const OURS = "org-lantern-ridge";
const THEIRS = "org-someone-else";

function twoOrganizations() {
  const ours = build();
  const other = createDatasetBuilder({ orgId: THEIRS, orgName: "Someone else's company (fictional)", outboundStatus: "dry_run" });
  other.property({ id: "other-1", name: "Not your property", address: "9 Elsewhere Road — fictional", number: "+16075550199", leaseText: "FICTIONAL", lease: { id: "lease-other", academic_year: "2026–27 (fictional)", term_start: "2026-08-01", term_end: "2027-07-31", total_rent: null }, rooms: [["other-r1", "Bedroom 1", 700]] });
  other.person("other-1", "lease-other", { id: "p-other", name: "Someone Else", phone: "+16075550198", room: "other-r1" });
  other.message("other-1", "lease-other", "p-other", { id: "m-other", body: "A message you must never see.", when: new Date().toISOString() });
  other.releasing("other-1", "p-other", {});
  const merged = { ...ours };
  for (const [table, rows] of Object.entries(other.t)) merged[table] = [...(ours[table] || []), ...rows];
  return merged;
}

const call = (path, options = {}) => handler({
  path: `/api/operator/${path}`,
  httpMethod: options.method || "GET",
  headers: { authorization: "authorization" in options ? options.authorization : "Bearer demo" },
  queryStringParameters: options.query || {},
  body: options.body ? JSON.stringify(options.body) : null,
});
const parse = (result) => JSON.parse(result.body);

beforeEach(() => useDemoTables(twoOrganizations()));

test("the access gate refuses a request with no code, and with the wrong code", async () => {
  for (const authorization of [undefined, "", "Bearer wrong", "Bearer DEMO", "demo"]) {
    const result = await call("properties", { authorization });
    assert.equal(result.statusCode, 401, `authorization ${JSON.stringify(authorization)} must be refused`);
  }
  assert.equal((await call("properties")).statusCode, 200);
});

test("listing properties returns only our organization's properties", async () => {
  const properties = parse(await call("properties"));
  assert.ok(properties.length > 0);
  for (const property of properties) assert.equal(property.organization_id, OURS);
  assert.ok(!properties.some((p) => p.id === "other-1"), "another organization's property must not be listed");
});

test("the overview never counts another organization's property", async () => {
  const rows = parse(await call("overview"));
  assert.ok(!rows.some((row) => row.id === "other-1"));
});

test("messages are limited to our organization", async () => {
  const rows = parse(await call("messages"));
  assert.ok(rows.length > 0);
  assert.ok(!rows.some((row) => row.body === "A message you must never see."));
  assert.ok(!rows.some((row) => row.organization_id === THEIRS));
});

test("searching messages cannot reach across organizations", async () => {
  const rows = parse(await call("messages", { query: { q: "never see" } }));
  assert.deepEqual(rows, []);
});

test("every property-scoped read reports another organization's property as not found", async () => {
  for (const route of ["turnover", "needs-human", "escalations", "evidence", "recipients", "timeline", "requests", "request-groups", "export"]) {
    const result = await call(route, { query: { propertyId: "other-1" } });
    assert.equal(result.statusCode, 404, `${route} must 404 for another organization's property`);
    assert.match(parse(result).error, /not found/i);
  }
});

test("writes cannot name another organization's property or people", async () => {
  const blocked = [
    ["manual-reply", { propertyId: "other-1", personId: "p-other", body: "no" }],
    ["call-log", { propertyId: "other-1", personId: "p-other", summary: "no" }],
    ["workflow-task", { propertyId: "other-1", personId: "p-other", taskKey: "key_status", status: "complete", valueText: "issued" }],
    ["request-decision", { propertyId: "other-1", requestId: "whatever", decision: "approve", note: "no" }],
  ];
  for (const [route, body] of blocked) {
    const result = await call(route, { method: "POST", body });
    assert.equal(result.statusCode, 404, `${route} must 404`);
  }
});

test("a write that omits the property cannot reach another organization's person", async () => {
  const result = await call("call-log", { method: "POST", body: { personId: "p-other", summary: "no" } });
  assert.equal(result.statusCode, 404);
});

test("an unknown route is a 404, not a server error", async () => {
  assert.equal((await call("does-not-exist")).statusCode, 404);
});
