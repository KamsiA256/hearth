// Message recording for the demo. It applies the same prefix and opt-out suffix the
// real product applies, and records the result as a dry run.
//
// There is no messaging SDK in this repository and no credential this module could
// use, so it cannot send anything. A recorded message is labelled `dry_run` and the
// interface shows it as recorded, never as delivered.
import { db, must } from "./db.mjs";
import { LIFE_SAFETY_REPLY } from "./safety.mjs";

export const SMS_BRAND_PREFIX = "Hearth: ";
export const SMS_OPT_OUT_SUFFIX = "Reply STOP to opt out.";

export function formatOutboundMessage(body) {
  const unformatted = String(body || "").trim();
  const branded = unformatted.startsWith(SMS_BRAND_PREFIX) ? unformatted : `${SMS_BRAND_PREFIX}${unformatted}`;
  if (branded === LIFE_SAFETY_REPLY || branded.endsWith(SMS_OPT_OUT_SUFFIX)) return branded;
  return `${branded} ${SMS_OPT_OUT_SUFFIX}`;
}

export async function sendAndPersist({ organizationId, propertyId, leaseGroupId, person, conversationId, body, inReplyToMessageId = null }) {
  if (person.consent_status === "opted_out" || person.opted_out_at) throw new Error("CONSENT_BLOCK: recipient is opted out");
  return must(await db().from("messages").insert({
    organization_id: organizationId,
    property_id: propertyId,
    lease_group_id: leaseGroupId,
    person_id: person.id,
    conversation_id: conversationId,
    direction: "outbound",
    body: formatOutboundMessage(body),
    delivery_status: "dry_run",
    in_reply_to_message_id: inReplyToMessageId,
  }).select().single(), "record demo reply");
}
