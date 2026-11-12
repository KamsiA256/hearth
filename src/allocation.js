// The household allocation, in integer cents.
//
// This is the deterministic half of the product and it knows nothing about any
// payment provider. Given a monthly total and the shares a household agreed to, it
// says what each resident owes, whether the shares reconcile, and what version of
// the allocation this is. No invoice can be issued unless `balances` is true.
//
// The version matters as much as the amounts. A human approves specific numbers for
// specific people in a specific billing period, so the approval is bound to a
// version computed from exactly those things. Change any amount, any recipient or
// the period, and the version changes and the approval stops being valid.
import { money, toCents } from "./money.js";

/** "November 2026" -> "november-2026". Stable key for a billing period. */
export const periodKey = (label) => String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Canonical form: the exact facts a human authorizes, in a fixed order so that two
// equal allocations always produce the same string and unequal ones never do.
function canonical(snapshot) {
  return JSON.stringify({
    property: snapshot.propertyId,
    period: snapshot.period.key,
    total: snapshot.totalCents,
    lines: snapshot.lines
      .map((line) => [line.personId, line.amountCents])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
}

// FNV-1a, for a short readable label only. The full canonical string above is what
// gets compared; this is what a person reads out loud.
function shortLabel(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Build the allocation snapshot for one property and billing period.
 *
 * `activity` is the recorded household agreement: a monthly total and a share per
 * resident. `people` supplies names. Amounts arrive as dollars and are converted
 * once, here, at the edge; everything downstream is cents.
 */
export function allocationFor({ propertyId, activity, people }) {
  if (!activity) return null;
  const byId = new Map((people || []).map((person) => [person.id, person]));
  const totalCents = toCents(activity.total);
  const lines = (activity.entries || []).map((entry) => {
    const person = byId.get(entry.personId);
    return {
      personId: entry.personId,
      name: person?.name || "Unknown resident",
      roomId: person?.room_id || null,
      amountCents: toCents(entry.amount),
      amountLabel: money(toCents(entry.amount)),
      // "received" is the household's own record of who has paid in. It is NOT a
      // payment-provider state and never becomes one: a provider's status is the
      // only thing that can say an invoice was paid.
      recordedByHousehold: entry.state === "received",
      recordedOn: entry.recorded || null,
    };
  });
  const allocatedCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const snapshot = {
    propertyId,
    period: { label: activity.period, key: periodKey(activity.period), due: activity.due, followUp: activity.followUp },
    totalCents,
    totalLabel: money(totalCents),
    allocatedCents,
    allocatedLabel: money(allocatedCents),
    // Signed: positive means the shares overshoot the rent, negative means short.
    differenceCents: allocatedCents - totalCents,
    lines,
    source: activity.source || null,
  };
  snapshot.balances = snapshot.differenceCents === 0;
  snapshot.differenceLabel = money(Math.abs(snapshot.differenceCents));
  snapshot.version = canonical(snapshot);
  snapshot.versionLabel = shortLabel(snapshot.version);
  return snapshot;
}

/** The one line an invoice would be issued against. */
export const lineFor = (snapshot, personId) => snapshot?.lines.find((line) => line.personId === personId) || null;

/**
 * Why this allocation cannot be invoiced, or null if it can.
 * Stated as a sentence because it is shown to the person, not logged.
 */
export function blockedReason(snapshot) {
  if (!snapshot) return "There is no rent allocation for this property yet.";
  if (!snapshot.lines.length) return "No resident shares have been entered yet.";
  if (snapshot.differenceCents < 0) return `The shares are ${snapshot.differenceLabel} short of the ${snapshot.totalLabel} monthly rent. Invoices stay blocked until they match exactly.`;
  if (snapshot.differenceCents > 0) return `The shares are ${snapshot.differenceLabel} over the ${snapshot.totalLabel} monthly rent. Invoices stay blocked until they match exactly.`;
  return null;
}
