// Bundled ONLY into dist/reviewer (npm run build:reviewer). Never into public/.
//
// The offline reviewer build runs the real operator, allocation and payments
// handlers inside the page against fictional data, so an outside reviewer can walk
// the whole flow: split → confirm → approve → prepare invoice → send → status.
//
// The payment provider here is SIMULATED and says so everywhere it appears: its
// label is "OFFLINE DEMO · simulated PayPal", invoice ids start with DEMO-, and
// every address is on example.test. Nothing leaves the page. After sending, the
// invoice reads as SENT (not paid); the simulated resident "pays" when the status is
// next refreshed, so the difference between sent and paid is visible.
//
// Server mode is unchanged: there, with no PayPal credentials, invoicing is refused
// rather than faked.
import { handler } from "../server/operator-api.mjs";
import { demoMeta } from "../server/_shared/db.mjs";
import { createAllocationHandler } from "../server/allocation-api.mjs";
import { createPaymentsHandler } from "../server/payments-api.mjs";
import { createMemoryAllocationStore } from "../src/allocation-store-memory.js";
import { createPaymentStore } from "../src/payments/store.js";
import { PAYMENT_STATE_LABEL } from "../src/payments/state.js";
import { periodKey } from "../src/allocation.js";

export const SIMULATED_LABEL = "OFFLINE DEMO · simulated PayPal — nothing is sent or paid";

const invoices = new Map();
let next = 1;
const simulated = {
  name: "offline_demo", available: true,
  describe: () => SIMULATED_LABEL,
  buildInvoice: ({ line, recipientEmail }) => ({ amountCents: line.amountCents, recipientEmail }),
  async createDraft(body) {
    const id = `DEMO-INV-${String(next++).padStart(4, "0")}`;
    const value = (body.amountCents / 100).toFixed(2);
    invoices.set(id, { id, status: "DRAFT", amount: { value }, due_amount: { value } });
    return { providerInvoiceId: id, providerStatus: "DRAFT", adopted: false };
  },
  async send(id) { const inv = invoices.get(id); inv.status = "SENT"; return this.get(id, { fromSend: true }); },
  async get(id, { fromSend = false } = {}) {
    const inv = invoices.get(id);
    if (!inv) return { providerInvoiceId: undefined, providerStatus: undefined, invoice: {} };
    if (inv.status === "SENT" && !fromSend) {
      inv.status = "PAID"; inv.payments = { paid_amount: inv.amount }; inv.due_amount = { value: "0.00" };
    }
    return { providerInvoiceId: id, providerStatus: inv.status, recipientViewUrl: null, invoice: { ...inv } };
  },
};

const people = Object.values(demoMeta.rentActivity || {}).flatMap((a) => (a.entries || []).map((e) => e.personId));
const mapping = {
  invoicer: { sandboxBusinessEmail: "landlord@example.test", givenName: "Fictional", surname: "Landlord", displayName: "Fictional Landlord (demo)" },
  recipients: Object.fromEntries(people.map((id) => [id, `${id}@example.test`])),
  recipientFor(id) { return this.recipients[id] || null; },
};

const allocationStore = createMemoryAllocationStore();
const paymentStore = createPaymentStore({ file: "page-memory.json" }); // fs is a no-op shim here

// Invoices the scenario says already exist, so a reviewer opens on a month part-way
// collected rather than on an empty column — "sent" and "paid" are different facts,
// and a screen where nothing has been sent yet cannot show that they are. Driven
// entirely by the dataset (`seedInvoices` on a rent activity), so a scenario that
// declares none seeds nothing and this does nothing.
//
// Both sides have to be seeded, not just one. The store is what the Rent page reads;
// the simulated provider's own map is what a status refresh reads. Seeding only the
// store would leave every seeded invoice reading as missing the first time anyone
// pressed refresh.
let seeded = 0;
for (const [propertyId, activity] of Object.entries(demoMeta.rentActivity || {})) {
  const totalFor = new Map((activity.entries || []).map((entry) => [entry.personId, Math.round(Number(entry.amount) * 100)]));
  for (const seed of activity.seedInvoices || []) {
    const totalCents = totalFor.get(seed.personId);
    if (!totalCents) continue;
    const paidCents = seed.state === "paid" ? totalCents : seed.state === "partially_paid" ? (seed.paidCents ?? 0) : 0;
    const dueCents = totalCents - paidCents;
    const providerStatus = seed.state === "paid" ? "PAID" : seed.state === "partially_paid" ? "PARTIALLY_PAID" : "SENT";
    const id = `DEMO-INV-${String(++seeded).padStart(4, "0")}`;
    const value = (cents) => (cents / 100).toFixed(2);
    invoices.set(id, {
      id, status: providerStatus, amount: { value: value(totalCents) }, due_amount: { value: value(dueCents) },
      ...(paidCents ? { payments: { paid_amount: { value: value(paidCents) } } } : {}),
    });
    paymentStore.put({ propertyId, periodKey: periodKey(activity.period), personId: seed.personId }, {
      localState: "sent", providerInvoiceId: id, providerStatus,
      paymentState: seed.state, paidCents, dueCents, recipientViewUrl: null,
      // Deliberately null. `stale` means "approved against numbers other than the
      // ones on screen", and these were issued against the seeded split itself.
      // Naming a version here would mean reproducing that split's canonical
      // fingerprint by hand, and getting it wrong would mark every seeded invoice
      // as issued against older numbers — which reads as a fault, not a fixture.
      approvedAllocationVersion: null,
    });
  }
}
// So a reviewer's own sends get fresh ids rather than colliding with the seeded ones.
next = seeded + 1;

const paymentsHandler = createPaymentsHandler({ payments: { mode: "offline_demo", provider: simulated, mapping }, store: paymentStore, allocationStore });
const allocationHandler = createAllocationHandler({
  store: allocationStore,
  invoicesFor: (p, k) => paymentStore.forProperty(p, k).map((r) => ({ ...r, paymentStateLabel: r.paymentState ? PAYMENT_STATE_LABEL[r.paymentState] : null })),
  provider: { available: true, reason: null, label: SIMULATED_LABEL, simulated: true, mappedCount: people.length, mappedPersonIds: people },
});

const startedAt = new Date().toISOString();
const demoHeaders = { "x-hearth-dataset": "fictional-offline-demo", "content-type": "application/json; charset=utf-8" };
function response(status, body, headers = {}) {
  const all = Object.fromEntries(Object.entries({ ...demoHeaders, ...headers }).map(([key, value]) => [key.toLowerCase(), value]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => all[String(name).toLowerCase()] || null }, json: async () => body };
}

export async function demoFetch(resource, options = {}) {
  // A fixed base: under file:// the page origin is the string "null".
  const url = new URL(resource, "https://hearth-demo.invalid");
  if (url.pathname === "/demo/meta") return response(200, { ...demoMeta, startedAt, storage: "page" });
  const route = url.pathname.startsWith("/api/allocation/") ? allocationHandler : url.pathname.startsWith("/api/payments/") ? paymentsHandler : handler;
  const result = await route({
    path: url.pathname,
    httpMethod: String(options.method || "GET").toUpperCase(),
    headers: options.headers || {},
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: options.body || null,
  });
  let body = {};
  try { body = JSON.parse(result.body || "{}"); } catch { body = {}; }
  return response(result.statusCode, body, result.headers);
}

export function getDemoMeta() { return { ...demoMeta, startedAt }; }
