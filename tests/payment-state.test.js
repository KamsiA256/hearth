// The mapping that decides whether Hearth says "sent", "partly paid" or "paid".
// Getting it wrong is how a demo lies about money, so each case is spelled out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { amountToCents, paymentStateOf, PAYMENT_STATE_LABEL } from "../src/payments/state.js";

const invoice = (status, { paid, due, total } = {}) => ({
  status,
  amount: total === undefined ? undefined : { currency_code: "USD", value: total },
  due_amount: due === undefined ? undefined : { currency_code: "USD", value: due },
  payments: paid === undefined ? undefined : { paid_amount: { currency_code: "USD", value: paid } },
});

test("a sent invoice is never reported as paid", () => {
  const s = paymentStateOf(invoice("SENT", { total: "680.00", due: "680.00" }));
  assert.equal(s.state, "sent");
  assert.equal(s.isPaidInFull, false);
  assert.equal(s.hasAnyPayment, false);
  assert.match(PAYMENT_STATE_LABEL[s.state], /not paid/);
});

test("a draft is a draft", () => {
  assert.equal(paymentStateOf(invoice("DRAFT")).state, "draft");
  assert.match(PAYMENT_STATE_LABEL.draft, /not sent/);
});

test("UNPAID means sent and unpaid, not unknown", () => {
  assert.equal(paymentStateOf(invoice("UNPAID", { total: "680.00", due: "680.00" })).state, "sent");
});

test("a partial payment is partial, and says how much is still due", () => {
  const s = paymentStateOf(invoice("PARTIALLY_PAID", { total: "680.00", paid: "200.00", due: "480.00" }));
  assert.equal(s.state, "partially_paid");
  assert.equal(s.paidCents, 20000);
  assert.equal(s.dueCents, 48000);
  assert.equal(s.isPaidInFull, false);
  assert.equal(s.isPartiallyPaid, true);
});

test("amounts override the status label when they disagree", () => {
  // PayPal says PAID but money is still outstanding. The money is the fact.
  const s = paymentStateOf(invoice("PAID", { total: "680.00", paid: "200.00", due: "480.00" }));
  assert.equal(s.state, "partially_paid");
  assert.equal(s.isPaidInFull, false);
});

test("a payment that clears the balance is paid in full", () => {
  const s = paymentStateOf(invoice("PAID", { total: "680.00", paid: "680.00", due: "0.00" }));
  assert.equal(s.state, "paid");
  assert.equal(s.isPaidInFull, true);
  assert.equal(s.dueCents, 0);
});

test("a pending payment is pending, not paid", () => {
  const s = paymentStateOf(invoice("PAYMENT_PENDING", { total: "680.00", due: "680.00" }));
  assert.equal(s.state, "payment_pending");
  assert.equal(s.isPaidInFull, false);
});

test("a full payment arriving under a SENT label is recognised", () => {
  // This is the case PayPal's single PAID event makes possible: the label lags, the
  // amounts do not.
  const s = paymentStateOf(invoice("SENT", { total: "680.00", paid: "680.00", due: "0.00" }));
  assert.equal(s.state, "paid");
});

test("marked-paid is distinguished from actually paid through PayPal", () => {
  assert.equal(paymentStateOf(invoice("MARKED_AS_PAID")).state, "marked_paid");
  assert.match(PAYMENT_STATE_LABEL.marked_paid, /outside PayPal/);
});

test("cancelled and refunded are their own states", () => {
  assert.equal(paymentStateOf(invoice("CANCELLED")).state, "cancelled");
  assert.equal(paymentStateOf(invoice("REFUNDED")).state, "refunded");
  assert.equal(paymentStateOf(invoice("PARTIALLY_REFUNDED")).state, "partially_refunded");
  assert.equal(paymentStateOf(invoice("MARKED_AS_REFUNDED")).state, "refunded");
});

test("an unrecognised status is unknown, and says to re-read rather than guessing", () => {
  assert.equal(paymentStateOf(invoice("SOMETHING_NEW")).state, "unknown");
  assert.equal(paymentStateOf({}).state, "unknown");
  assert.match(PAYMENT_STATE_LABEL.unknown, /refresh/i);
});

test("every state has words a landlord can read", () => {
  for (const state of Object.keys(PAYMENT_STATE_LABEL)) assert.ok(PAYMENT_STATE_LABEL[state].length > 3, state);
});

test("amounts convert to integer cents, and absent amounts stay absent", () => {
  assert.equal(amountToCents({ value: "680.00" }), 68000);
  assert.equal(amountToCents({ value: "0.01" }), 1);
  assert.equal(amountToCents("12.34"), 1234);
  assert.equal(amountToCents(undefined), null);
  assert.equal(amountToCents({ value: "" }), null);
  assert.equal(amountToCents({ value: "not-a-number" }), null);
});
