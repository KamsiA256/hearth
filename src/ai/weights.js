// Weights to cents. The deterministic half of the AI allocation.
//
// The model never returns money. It returns a weight per person and the reasoning
// behind it; this module turns those weights into an allocation that sums to the
// required rent to the cent. Nothing here calls a model, imports from node, or
// reads configuration, so it runs identically on the server, in the browser bundle
// and in a test with no credentials.
//
// The consequence worth stating plainly: the model can be completely wrong about
// what a room is worth and the arithmetic is still exact. A bad proposal is a bad
// proposal a person can see and edit — never a total that does not add up.

/** Weights must be finite, non-negative, and not all zero. */
export class WeightError extends Error {
  constructor(message) { super(message); this.name = "WeightError"; this.code = "BAD_WEIGHTS"; }
}

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Turn {personId: weight} into {personId: cents} summing exactly to totalCents.
 *
 * Largest remainder: floor every exact share, then hand the leftover cents out one
 * at a time to the largest fractional parts. Ties break on personId so the same
 * input always produces the same output — a demo that reshuffles its own pennies
 * between runs is not one anybody should trust.
 */
export function allocationFromWeights({ totalCents, weights }) {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new WeightError(`Total must be a whole number of cents, received ${JSON.stringify(totalCents)}.`);
  }
  const entries = Object.entries(weights || {});
  if (entries.length === 0) throw new WeightError("No weights were given, so there is nobody to allocate to.");

  for (const [personId, weight] of entries) {
    if (!isFiniteNumber(weight)) {
      throw new WeightError(`Weight for ${personId} is ${JSON.stringify(weight)}, which is not a number.`);
    }
    if (weight < 0) {
      throw new WeightError(`Weight for ${personId} is ${weight}. A negative weight would mean a negative share.`);
    }
  }

  const sum = entries.reduce((running, [, weight]) => running + weight, 0);
  if (sum <= 0) {
    throw new WeightError("Every weight is zero, so there is no ratio to divide the rent by.");
  }

  // Exact share, floored, with the fractional part kept for the remainder pass.
  const parts = entries.map(([personId, weight]) => {
    const exact = (totalCents * weight) / sum;
    const floor = Math.floor(exact);
    return { personId, floor, fraction: exact - floor };
  });

  let remainder = totalCents - parts.reduce((running, part) => running + part.floor, 0);

  // Largest fractional part first; personId breaks ties so the result is stable.
  const order = [...parts].sort((a, b) =>
    b.fraction - a.fraction || (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));

  for (const part of order) {
    if (remainder <= 0) break;
    part.floor += 1;
    remainder -= 1;
  }

  const lines = {};
  for (const part of parts) lines[part.personId] = part.floor;
  return lines;
}

/**
 * The check the caller is expected to run anyway, stated once here so no screen has
 * to re-derive it: does this allocation actually sum to the rent?
 */
export function reconciles({ totalCents, lines }) {
  const allocated = Object.values(lines).reduce((running, cents) => running + cents, 0);
  return { allocated, differenceCents: totalCents - allocated, balanced: allocated === totalCents };
}
