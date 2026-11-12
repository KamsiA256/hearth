// Idempotency keys.
//
// Verified: PayPal makes a POST idempotent via the `PayPal-Request-Id` header,
// recommends a UUID because of a 38-character limit, and reuses the ID for about 45
// days. Its own troubleshooting guidance names "retrying without the header" as the
// cause of duplicate invoices, and says to generate a stable ID per logical
// operation and store it BEFORE the request.
//
// So the key here is derived, not random: the same billing period, the same
// allocation version and the same recipient always produce the same key. That holds
// even if the process dies between generating the key and writing it down, which a
// random key would not survive. It is stored as well, so the stored value is what
// gets replayed.
//
// A key is deliberately tied to the allocation version. If the amount changes, it is
// a different logical operation and must not quietly reuse a prior invoice.
import { createHash } from "node:crypto";

/** Format 32 hex characters as a UUID-shaped 36-character string. */
const asUuid = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

/**
 * The one hash every derived identifier comes from.
 *
 * `destination` is part of the material on purpose. Sending the same amount to a
 * DIFFERENT address is a different logical operation: it must not reuse a prior
 * invoice, and it must not replay a prior PayPal-Request-Id. Leaving it out was a
 * defect — it made a changed billing address indistinguishable from a retry.
 */
export function derivationDigest({ scope, propertyId, periodKey, personId, allocationVersion, destination }) {
  if (!scope || !propertyId || !periodKey || !personId || !allocationVersion || !destination) {
    throw new TypeError("derivation needs scope, propertyId, periodKey, personId, allocationVersion and destination");
  }
  // The separator cannot occur in any component, so two different inputs cannot
  // produce the same joined string.
  const material = [scope, propertyId, periodKey, personId, allocationVersion, destination].join("\u0000");
  return createHash("sha256").update(material).digest("hex");
}

export function idempotencyKey(parts) {
  return asUuid(derivationDigest(parts));
}

/** Record key for the payment store: one row per resident, period and property. */
export const recordKey = ({ propertyId, periodKey, personId }) => `${propertyId}:${periodKey}:${personId}`;
