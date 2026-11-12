// Nothing in this repository can send a message. What this proves is that the
// recording path still applies the real formatting and consent rules, and that every
// recorded message is labelled a dry run rather than a delivery.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "../data/willow-court.mjs";
import { useDemoTables, db } from "../server/_shared/db.mjs";
import { formatOutboundMessage, sendAndPersist } from "../server/_shared/messaging.mjs";
import { LIFE_SAFETY_REPLY } from "../server/_shared/safety.mjs";

beforeEach(() => useDemoTables(build()));

test("there is no messaging SDK anywhere in the dependency list", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const name of ["twilio", "@supabase/supabase-js", "nodemailer", "@sendgrid/mail"]) {
    assert.ok(!deps.includes(name), `${name} must not be a dependency`);
  }
});

test("outbound text is branded once and carries the opt-out line once", () => {
  assert.equal(formatOutboundMessage("Your keys are ready."), "Hearth: Your keys are ready. Reply STOP to opt out.");
  assert.equal(formatOutboundMessage("Hearth: Already branded."), "Hearth: Already branded. Reply STOP to opt out.");
  assert.equal(formatOutboundMessage("Hearth: Done. Reply STOP to opt out."), "Hearth: Done. Reply STOP to opt out.");
});

test("the life-safety reply is sent exactly as written, with nothing appended", () => {
  assert.equal(formatOutboundMessage(LIFE_SAFETY_REPLY), LIFE_SAFETY_REPLY);
});

test("a recorded message is a dry run, never a delivery", async () => {
  const tables = build();
  const person = tables.people.find((p) => p.id === "p-3a-ada");
  const recorded = await sendAndPersist({ organizationId: person.organization_id, propertyId: person.property_id, leaseGroupId: person.lease_group_id, person, conversationId: `conv-${person.id}`, body: "Test message" });
  assert.equal(recorded.delivery_status, "dry_run");
  assert.equal(recorded.direction, "outbound");
  assert.match(recorded.body, /^Hearth: /);
});

test("an opted-out recipient is refused before anything is recorded", async () => {
  const tables = build();
  const person = { ...tables.people.find((p) => p.id === "p-3a-ada"), consent_status: "opted_out", opted_out_at: new Date().toISOString() };
  const before = (await db().from("messages").select("*")).data.length;
  await assert.rejects(
    () => sendAndPersist({ organizationId: person.organization_id, propertyId: person.property_id, leaseGroupId: person.lease_group_id, person, conversationId: `conv-${person.id}`, body: "Should not record" }),
    /CONSENT_BLOCK/,
  );
  assert.equal((await db().from("messages").select("*")).data.length, before, "nothing may be recorded for an opted-out recipient");
});
