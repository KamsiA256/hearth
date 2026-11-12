// The API handlers, wired once. The local server (scripts/demo-server.mjs) and the
// hosted function (api/hearth.mjs) both build them here, so the two cannot drift:
// they differ only in where the stores keep their data.
import { handler as operatorHandler } from "./operator-api.mjs";
import { createPaymentsHandler } from "./payments-api.mjs";
import { createAllocationHandler } from "./allocation-api.mjs";
import { PAYMENT_STATE_LABEL } from "../src/payments/state.js";
import { proposeDraft, proposeRedraft } from "../src/ai/propose.js";

/**
 * `payments` and `ai` are the resolved configuration (resolvePayments, resolveAi).
 * `lock` is optional: without one, the payments handler uses an in-process lock.
 */
export function createHandlers({ payments, ai, paymentStore, allocationStore, lock }) {
  // One allocation store, shared: payments must invoice exactly the split the
  // landlord approved in the workspace, not the dataset seed.
  const paymentsHandler = createPaymentsHandler({ payments, store: paymentStore, allocationStore, lock });
  // The allocation handler is the SAME module offline mode runs. It is given the
  // payment store read-only, so the status line can account for collection without
  // the allocation routes being able to touch an invoice.
  const allocationHandler = createAllocationHandler({
    store: allocationStore,
    // Shaped here, where the payment modules already live, so the allocation API
    // stays provider-agnostic and the offline bundle carries none of this.
    invoicesFor: (propertyId, periodKey) => paymentStore.forProperty(propertyId, periodKey).map((record) => ({
      personId: record.personId,
      localState: record.localState,
      providerInvoiceId: record.providerInvoiceId || null,
      providerStatus: record.providerStatus || null,
      paymentState: record.paymentState || null,
      paymentStateLabel: record.paymentState ? PAYMENT_STATE_LABEL[record.paymentState] : null,
      paidCents: record.paidCents ?? null,
      dueCents: record.dueCents ?? null,
      recipientViewUrl: record.recipientViewUrl || null,
      approvedAllocationVersion: record.approvedAllocationVersion || null,
      lastCheckedAt: record.lastCheckedAt || null,
      sentAt: record.sentAt || null,
    })),
    provider: {
      available: payments.provider.available,
      reason: payments.provider.available ? null : "No payment provider is connected in this mode.",
      mappedCount: payments.mapping ? Object.keys(payments.mapping.recipients).length : 0,
      mappedPersonIds: payments.mapping ? Object.keys(payments.mapping.recipients) : [],
    },
    // Likewise shaped here: the allocation API never imports the Anthropic SDK, so
    // the offline bundle never carries it either (see tests/offline-mode.test.js).
    ai: {
      available: ai.available,
      reason: ai.available ? null : "No AI is connected in this mode.",
    },
    proposeAiDraft: ai.available
      ? (args) => proposeDraft({ client: ai.client, ...args })
      : undefined,
    proposeAiRedraft: ai.available
      ? (args) => proposeRedraft({ client: ai.client, ...args })
      : undefined,
  });

  return { "/api/allocation/": allocationHandler, "/api/payments/": paymentsHandler, "/api/operator/": operatorHandler };
}

/** The handler for a path, or null when no API prefix matches. */
export function handlerFor(handlers, pathname) {
  const prefix = Object.keys(handlers).find((p) => pathname.startsWith(p));
  return prefix ? handlers[prefix] : null;
}

/** A Node request as the event shape the handlers take. */
export async function eventFrom(req, url) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return { path: url.pathname, httpMethod: req.method, headers: Object.fromEntries(Object.entries(req.headers)), queryStringParameters: Object.fromEntries(url.searchParams), body: body || null };
}
