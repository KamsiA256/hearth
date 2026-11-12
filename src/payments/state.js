// Provider status -> payment state. Kept small, pure and separately tested, because
// getting this wrong is how a demo claims someone paid when they did not.
//
// The important verified fact: PayPal's INVOICING.INVOICE.PAID event fires when an
// invoice is paid, partially paid, OR payment is merely pending, and there is no
// separate partial-payment event. So an event name can never be the payment state.
// The state comes from reading the invoice: its status plus how much is actually
// paid and how much is still due.
//
// "Sent" is not a payment state. It says an invoice left; it says nothing about money.

const DIRECT = {
  DRAFT: "draft",
  SCHEDULED: "scheduled",
  SENT: "sent",
  UNPAID: "sent",
  PAYMENT_PENDING: "payment_pending",
  PARTIALLY_PAID: "partially_paid",
  PAID: "paid",
  MARKED_AS_PAID: "marked_paid",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partially_refunded",
  MARKED_AS_REFUNDED: "refunded",
};

/** A provider amount object ({ value, currency_code }) -> integer cents. */
export function amountToCents(amount) {
  if (!amount) return null;
  const value = typeof amount === "object" ? amount.value : amount;
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Normalize a provider invoice into the state Hearth records.
 *
 * Amounts win over the status label where they disagree: a status of PAID with an
 * amount still due is reported as partially paid, because the money is the fact and
 * the label is a summary of it.
 */
export function paymentStateOf(invoice = {}) {
  const raw = String(invoice.status || "").toUpperCase();
  const reportedPaid = amountToCents(invoice.payments?.paid_amount);
  const paidCents = reportedPaid ?? 0;
  const dueCents = amountToCents(invoice.due_amount);
  const totalCents = amountToCents(invoice.amount);

  let state = DIRECT[raw] || "unknown";

  // Reconcile the label against the amounts.
  if (paidCents > 0 && dueCents !== null && dueCents > 0) state = "partially_paid";
  else if (paidCents > 0 && dueCents === 0 && ["sent", "payment_pending", "partially_paid", "unknown"].includes(state)) state = "paid";
  // A PAID label with money still due and no payment recorded is a contradiction.
  // It is never shown as paid: the label is a summary, the amounts are the fact.
  else if ((state === "paid" || state === "marked_paid") && dueCents !== null && dueCents > 0 && !(reportedPaid > 0)) state = "unknown";

  return {
    state,
    providerStatus: raw || null,
    paidCents,
    dueCents,
    totalCents,
    // The only three questions the interface should ever ask.
    isPaidInFull: state === "paid" || state === "marked_paid",
    isPartiallyPaid: state === "partially_paid",
    hasAnyPayment: paidCents > 0,
  };
}

/** Plain words for the interface. Never says "paid" unless it is paid in full. */
export const PAYMENT_STATE_LABEL = {
  draft: "Draft · not sent",
  scheduled: "Scheduled to send",
  sent: "Invoice sent · not paid",
  payment_pending: "Payment pending",
  partially_paid: "Partly paid",
  paid: "Paid in full",
  marked_paid: "Marked paid outside PayPal",
  cancelled: "Cancelled",
  refunded: "Refunded",
  partially_refunded: "Partly refunded",
  unknown: "Status unclear · refresh to re-read",
};
