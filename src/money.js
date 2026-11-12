// Money. Integer cents everywhere, never floats: 0.1 + 0.2 !== 0.3, and a cent that
// goes missing in a seven-way rent split is a real argument between real people.
//
// This file is deliberately free of any payment provider. Allocation has to be
// checkable by hand and identical every time it runs, whoever is being invoiced and
// whatever provider eventually carries the money.

/** Dollars (number or string) -> integer cents. */
export function toCents(dollars) {
  const n = typeof dollars === "string" ? Number(dollars) : dollars;
  if (!Number.isFinite(n)) throw new TypeError(`not a money amount: ${dollars}`);
  return Math.round(n * 100);
}

/** Integer cents -> "$1,234.56" */
export function money(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const d = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${d}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Split `totalCents` across `weights` so the parts always sum to the total.
 *
 * Largest-remainder: floor every share, then hand the leftover cents out one at a
 * time, biggest fractional part first, ties broken by order so the result is stable.
 * Without this a three-way split of $100.00 silently loses a cent.
 */
export function allocate(totalCents, weights) {
  const total = Math.trunc(totalCents);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new RangeError("allocate: weights must sum to > 0");

  const exact = weights.map((w) => (total * w) / sum);
  const base = exact.map(Math.floor);
  const leftover = total - base.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = base.slice();
  for (let k = 0; k < leftover; k++) out[order[k % order.length].i] += 1;
  return out;
}

/**
 * Prorate a monthly amount for partial occupancy.
 * The day of move-in counts as occupied; the day of move-out does not.
 */
export function prorate(monthlyCents, daysOccupied, daysInMonth) {
  if (daysInMonth <= 0) throw new RangeError("prorate: daysInMonth must be > 0");
  const days = Math.max(0, Math.min(daysOccupied, daysInMonth));
  if (days === daysInMonth) return Math.trunc(monthlyCents);
  return Math.round((Math.trunc(monthlyCents) * days) / daysInMonth);
}
