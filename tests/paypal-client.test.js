// The PayPal client against the response shapes PayPal actually returns.
//
// Why this file exists: every other test in this suite mocks the client's three
// methods and therefore proves nothing about how it reads a reply. A real create
// returned a bare link object with no id, the client handed back
// `providerInvoiceId: undefined`, and the next call asked for
// ".../invoices/undefined". The orchestration tests all passed throughout.
//
// No network. `fetchImpl` is injected, and every body below is a shape observed
// from, or documented by, PayPal's invoicing v2 API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PayPalSandbox, PayPalError, invoiceNumberFor } from "../src/payments/paypal-sandbox.js";

const TOKEN = { access_token: "fake-token-not-a-credential", token_type: "Bearer", expires_in: 32400 };
const ID = "INV2-G3MC-Q3PB-28UZ-E7MM";

/** A fetch that replies from a queue and records every request it was given. */
function fakeFetch(handlers) {
  const seen = [];
  const impl = async (url, options = {}) => {
    seen.push({ url, method: options.method || "GET", headers: options.headers || {}, body: options.body });
    if (url.endsWith("/v1/oauth2/token")) return reply(200, TOKEN);
    const handler = handlers.find((h) => h.match(url, options));
    if (!handler) throw new Error(`no fake handler for ${options.method || "GET"} ${url}`);
    handler.hits = (handler.hits || 0) + 1;
    return reply(handler.status ?? 200, typeof handler.body === "function" ? handler.body(handler.hits) : handler.body);
  };
  impl.seen = seen;
  return impl;
}
const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const client = (fetchImpl) => new PayPalSandbox({ env: "sandbox", clientId: "id", clientSecret: "secret", fetchImpl });
const isCreate = (url, o) => url.endsWith("/v2/invoicing/invoices") && o.method === "POST";
const isGet = (url, o) => /\/v2\/invoicing\/invoices\/[^/]+$/.test(url) && (o.method || "GET") === "GET";
const isSearch = (url, o) => url.includes("/v2/invoicing/search-invoices") && o.method === "POST";

/**
 * A search reply shaped like the LIVE one.
 *
 * Observed against the sandbox 2026-11-03: search-invoices returns a SUMMARY with
 * id, status, detail, invoicer, primary_recipients, amount, due_amount and links —
 * and NO `items`. Passing `fields: ["items"]` does not add them, and
 * `fields: "all"` is a 400. The first version of these tests invented a search
 * reply that DID contain items, so it passed while the shipped code refused every
 * real adoption. Every adopt fake below therefore drops `items` on purpose.
 */
const searchSummary = (invoice) => {
  const { items, ...summary } = invoice;
  return { items: [{ id: ID, ...summary }] };
};

test("a create that replies with only a link still yields the invoice id", async () => {
  // This is PayPal's DEFAULT create response. It has no id and no status.
  const fetchImpl = fakeFetch([
    { match: isCreate, status: 201, body: { rel: "self", href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${ID}`, method: "GET" } },
    { match: isGet, body: { id: ID, status: "DRAFT" } },
  ]);
  const created = await client(fetchImpl).createDraft({ detail: { invoice_number: "H-1" } }, "req-1");
  assert.equal(created.providerInvoiceId, ID);
  assert.equal(created.providerStatus, "DRAFT");
});

test("a link-only create reads the status back instead of assuming DRAFT", async () => {
  // If the id had to come from a link, the status is unknown. Assuming "DRAFT"
  // would let an already-sent invoice be displayed as an unsent draft.
  const fetchImpl = fakeFetch([
    { match: isCreate, status: 201, body: { links: [{ rel: "self", href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${ID}` }] } },
    { match: isGet, body: { id: ID, status: "SENT" } },
  ]);
  const created = await client(fetchImpl).createDraft({ detail: { invoice_number: "H-1" } }, "req-1");
  assert.equal(created.providerStatus, "SENT", "the status must come from the invoice, not from an assumption");
});

test("the create asks for the full representation", async () => {
  const fetchImpl = fakeFetch([{ match: isCreate, status: 201, body: { id: ID, status: "DRAFT" } }]);
  await client(fetchImpl).createDraft({ detail: { invoice_number: "H-1" } }, "req-1");
  const create = fetchImpl.seen.find((r) => r.url.endsWith("/v2/invoicing/invoices") && r.method === "POST");
  assert.equal(create.headers.Prefer, "return=representation");
  assert.equal(create.headers["PayPal-Request-Id"], "req-1", "the idempotency key must be on the create");
});

test("a representation response needs no extra read", async () => {
  const fetchImpl = fakeFetch([{ match: isCreate, status: 201, body: { id: ID, status: "DRAFT" } }]);
  const created = await client(fetchImpl).createDraft({ detail: { invoice_number: "H-1" } }, "req-1");
  assert.equal(created.providerInvoiceId, ID);
  assert.equal(fetchImpl.seen.filter((r) => isGet(r.url, r)).length, 0, "no read-back is needed when the id and status are present");
});

test("a create that returns no id at all is an error, not an undefined invoice", async () => {
  // The bug this file was written for: an absent id must never be returned as one.
  const fetchImpl = fakeFetch([{ match: isCreate, status: 201, body: { message: "accepted" } }]);
  await assert.rejects(
    () => client(fetchImpl).createDraft({ detail: { invoice_number: "H-1" } }, "req-1"),
    (error) => error instanceof PayPalError && /returned no id/i.test(error.message),
  );
});

test("a duplicate invoice number adopts the existing invoice rather than failing", async () => {
  // The real regression: the search reply carries NO items, so adoption has to
  // re-read the invoice before verifying it. Verifying against the summary would
  // compare our line amount to undefined and refuse a legitimate adoption.
  const full = {
    status: "DRAFT",
    detail: { invoice_number: "H-1", reference: "wc-3a/november-2026/b6af47b9" },
    primary_recipients: [{ billing_info: { email_address: "devi@example.test" } }],
    items: [{ unit_amount: { currency_code: "USD", value: "680.00" } }],
  };
  const fetchImpl = fakeFetch([
    { match: isCreate, status: 400, body: { name: "VALIDATION_ERROR", details: [{ issue: "DUPLICATE_INVOICE_NUMBER" }] } },
    { match: isSearch, body: searchSummary(full) },
    { match: isGet, body: { id: ID, ...full } },
  ]);
  const created = await client(fetchImpl).createDraft({ detail: { invoice_number: "H-1", reference: full.detail.reference }, primary_recipients: full.primary_recipients, items: full.items }, "req-1");
  assert.equal(created.providerInvoiceId, ID);
  assert.equal(created.providerStatus, "DRAFT", "status must come from the authoritative read, not the search summary");
  assert.equal(created.adopted, true, "an adopted invoice must say so, so a caller does not report it as newly created");
  assert.ok(created.raw.items, "the adopted invoice must be the FULL object, not the search summary");
});

test("a duplicate number that cannot be found is still an error", async () => {
  const fetchImpl = fakeFetch([
    { match: isCreate, status: 400, body: { name: "VALIDATION_ERROR", details: [{ issue: "DUPLICATE_INVOICE_NUMBER" }] } },
    { match: isSearch, body: { items: [] } },
  ]);
  await assert.rejects(() => client(fetchImpl).createDraft({ detail: { invoice_number: "H-1" } }, "req-1"), PayPalError);
});

test("send re-reads the invoice, because the send response is not authoritative", async () => {
  const fetchImpl = fakeFetch([
    { match: (url, o) => url.endsWith("/send") && o.method === "POST", body: {} },
    { match: isGet, body: { id: ID, status: "SENT", detail: { metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#X" } } } },
  ]);
  const sent = await client(fetchImpl).send(ID, "send-key");
  assert.equal(sent.providerStatus, "SENT");
  assert.equal(sent.recipientViewUrl, "https://www.sandbox.paypal.com/invoice/p/#X");
  const send = fetchImpl.seen.find((r) => r.url.endsWith("/send"));
  assert.equal(send.headers["PayPal-Request-Id"], "send-key");
});

test("send asks PayPal to email the recipient by default", async () => {
  const fetchImpl = fakeFetch([
    { match: (url, o) => url.endsWith("/send") && o.method === "POST", body: {} },
    { match: isGet, body: { id: ID, status: "SENT" } },
  ]);
  await client(fetchImpl).send(ID, "send-key");
  const body = JSON.parse(fetchImpl.seen.find((r) => r.url.endsWith("/send")).body);
  assert.equal(body.send_to_recipient, true);
  assert.equal(body.send_to_invoicer, false, "the landlord does not need a copy of every invoice");
});

test("send can suppress PayPal's email so the hosted link is the only notice", async () => {
  const fetchImpl = fakeFetch([
    { match: (url, o) => url.endsWith("/send") && o.method === "POST", body: {} },
    { match: isGet, body: { id: ID, status: "SENT", detail: { metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#X" } } } },
  ]);
  const sent = await client(fetchImpl).send(ID, "send-key", { notifyRecipient: false });
  const body = JSON.parse(fetchImpl.seen.find((r) => r.url.endsWith("/send")).body);
  assert.equal(body.send_to_recipient, false);
  // Suppressing the email must not change payability: the invoice still leaves DRAFT
  // and still has a link to pay at.
  assert.equal(sent.providerStatus, "SENT");
  assert.ok(sent.recipientViewUrl, "a suppressed email must still leave a payable link");
});

test("a 401 explains that it cannot tell a bad id from a bad secret", async () => {
  const fetchImpl = async () => reply(401, { error: "invalid_client", error_description: "Client Authentication failed" });
  await assert.rejects(
    () => client(fetchImpl).get(ID),
    (error) => /authentication failed/i.test(error.message) && /Sandbox, not Live/.test(error.fix),
  );
});

test("a 403 says the credentials are fine and the app lacks Invoicing", async () => {
  const fetchImpl = fakeFetch([{ match: isGet, status: 403, body: { name: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions." } }]);
  await assert.rejects(
    () => client(fetchImpl).get(ID),
    (error) => error.status === 403 && /not permitted to use Invoicing/.test(error.fix),
  );
});

test("money is written as currency_code, and as integer-cent-derived strings", async () => {
  const body = client(async () => reply(200, {})).buildInvoice({
    line: { name: "Devi Sharma", amountCents: 68000 },
    snapshot: { propertyId: "wc-3a", period: { key: "2026-11", label: "November 2026" }, versionLabel: "b6af", totalLabel: "$3,200.00" },
    property: { display_name: "212 Willow Court #3A" },
    invoicer: { givenName: "Lantern", surname: "Ridge Rentals", sandboxBusinessEmail: "seller@business.example.com" },
    recipientEmail: "devi@personal.example.com",
    invoiceNumber: "H-1",
  });
  assert.equal(body.items[0].unit_amount.currency_code, "USD", "invoicing uses currency_code; payouts uses currency");
  assert.equal(body.items[0].unit_amount.value, "680.00");
  assert.equal(body.detail.currency_code, "USD");
});

const NUM = { propertyId: "wc-3a", personId: "p-3a-devi", allocationVersion: '{"property":"wc-3a","total":320000}', destination: "devi@example.test" };

test("the invoice number stays within PayPal's 25-character limit", () => {
  // Every component is fixed-width or truncated to one, so length cannot drift: the
  // place slug is the last 4 of the property id, the month is 3, the year 4, the
  // digest 10. The long inputs below are the ones that could have overflowed.
  const inputs = [
    { ...NUM, periodKey: "november-2026" },
    { ...NUM, periodKey: "september-2026" },
    { ...NUM, periodKey: "may-2027" },
    { ...NUM, periodKey: "november-2026", propertyId: "an-extremely-long-property-identifier-willow-court-apartment-3a" },
    { ...NUM, periodKey: "november-2026", personId: "an-extremely-long-person-identifier-for-one-resident" },
  ];
  for (const input of inputs) {
    const number = invoiceNumberFor(input);
    assert.equal(number.length, 25, `${number} is ${number.length} characters`);
  }
});

test("a period key with no month is REFUSED, not silently given an empty one", () => {
  // Regression, found 2026-11-04 while wiring a second scenario whose fixture used
  // "2026-11". The month is taken from the letters in the period key, so a numeric
  // key produced month "" and year "2611" — H-WC3A-2611-… — and nothing threw. The
  // readable half of an invoice number is the only part a human scanning a
  // provider's invoice list can act on, and a number is permanent once PayPal has
  // it, so an unreadable key has to fail where it is introduced.
  // Each of these fails differently: no month at all, a month with no year, a month
  // with a two-digit year, nothing. "november" alone is the one that matters most —
  // it reads fine to a person and would have produced H-WC3A-NOV-… with the year
  // silently dropped.
  for (const periodKey of ["2026-11", "11/2026", "2026", "november", "november-26", "nov", "", null, undefined]) {
    assert.throws(
      () => invoiceNumberFor({ ...NUM, periodKey }),
      (error) => error instanceof TypeError && /does not name a month and a four-digit year/.test(error.message),
      `periodKey ${JSON.stringify(periodKey)} should have been refused`,
    );
  }
});

test("a month name Hearth does not recognise is refused rather than abbreviated", () => {
  // "foo-2026" slices to "FOO", which is not a month. Accepting it would put three
  // meaningless letters where a reader expects one of twelve known values.
  assert.throws(() => invoiceNumberFor({ ...NUM, periodKey: "foo-2026" }), /does not name a month/);
  // And the valid twelve all pass, so the check is not simply refusing everything.
  for (const month of ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]) {
    assert.match(invoiceNumberFor({ ...NUM, periodKey: `${month}-2026` }), new RegExp(`^H-WC3A-${month.slice(0, 3).toUpperCase()}2026-`));
  }
});

const BER_MONTHS = ["september-2026", "october-2026", "november-2026", "december-2026"];

test("the readable part names the month unambiguously", () => {
  // Regression, found 2026-11-03. The period used to be TAIL-sliced to six
  // characters, so every month ending in "ber" collapsed to "ER2026":
  // september, october, november and december — four of twelve.
  // THIS is the assertion that fails if the slug goes back to tail-slicing.
  const labels = BER_MONTHS.map((periodKey) => invoiceNumberFor({ ...NUM, periodKey }).split("-")[2]);
  assert.deepEqual(labels, ["SEP2026", "OCT2026", "NOV2026", "DEC2026"]);
});

test("the four 'ber' months cannot share an invoice number", () => {
  // Defence in depth, and honest about it: with the digest carrying uniqueness,
  // this CANNOT fail from an ambiguous readable prefix alone — the mutation audit
  // confirms it only fails when the prefix is ambiguous AND the digest is gone.
  // It is kept because it states the property that actually matters, and it would
  // catch a future change that moves uniqueness back into the readable part.
  const numbers = BER_MONTHS.map((periodKey) => invoiceNumberFor({ ...NUM, periodKey }));
  assert.equal(new Set(numbers).size, 4, `collided: ${numbers.join(" ")}`);
});

test("a changed billing destination gets a different invoice number", () => {
  // Otherwise the replacement invoice collides with the one addressed to the old
  // address, and adoption is the only outcome available.
  assert.notEqual(
    invoiceNumberFor({ ...NUM, periodKey: "november-2026" }),
    invoiceNumberFor({ ...NUM, periodKey: "november-2026", destination: "devi-new@example.test" }),
  );
});

test("a different allocation gets a different invoice number", () => {
  assert.notEqual(
    invoiceNumberFor({ ...NUM, periodKey: "november-2026" }),
    invoiceNumberFor({ ...NUM, periodKey: "november-2026", allocationVersion: '{"property":"wc-3a","total":320001}' }),
  );
});

test("adoption looks the invoice up by number instead of scanning a list page", async () => {
  // The old implementation listed the first 100 invoices and scanned them, so it
  // silently stopped working past 100 invoices at the merchant.
  const fetchImpl = fakeFetch([
    { match: isCreate, status: 400, body: { name: "VALIDATION_ERROR", details: [{ issue: "DUPLICATE_INVOICE_NUMBER" }] } },
    { match: isSearch, body: searchSummary({ status: "DRAFT", detail: { invoice_number: "H-1" } }) },
    { match: isGet, body: { id: ID, status: "DRAFT", detail: { invoice_number: "H-1" } } },
  ]);
  await client(fetchImpl).createDraft({ detail: { invoice_number: "H-1" } }, "req-1");
  const search = fetchImpl.seen.find((call) => call.url.includes("search-invoices"));
  assert.ok(search, "adoption must use the search endpoint");
  assert.equal(JSON.parse(search.body).invoice_number, "H-1", "the number has to be the server-side filter, not a client-side scan");
  assert.ok(!fetchImpl.seen.some((call) => /\/v2\/invoicing\/invoices\?/.test(call.url)), "no list-and-scan");
});

test("every mismatching field is reported, not just the first", async () => {
  // A multi-field mismatch must name ALL of them, so an operator reading the error
  // learns what is actually wrong rather than one arbitrary difference.
  // This test used to be the ONLY refusal test, and it varied reference AND amount
  // at once — which meant deleting the reference check still failed it, on the
  // error message rather than the behaviour. The mutation audit on 2026-11-03
  // caught that. The single-field tests below are what actually cover each check;
  // this one covers the reporting.
  await refusedBecause(
    { detail: { invoice_number: "H-1", reference: "wc-3a/december-2026/77c10e42" }, ...SAME },
    { detail: { invoice_number: "H-1", reference: "wc-3a/november-2026/b6af47b9" }, ...SAME, items: [{ unit_amount: { currency_code: "USD", value: "700.00" } }] },
    ["reference", "amount"],
  );
});

// Same recipient, same amount, same currency for every case below, so that the
// field under test is the ONLY thing that differs. A refusal test that varies two
// fields at once still passes when one of the two checks is deleted — which is how
// the reference check went uncovered until the mutation audit on 2026-11-03.
const SAME = {
  primary_recipients: [{ billing_info: { email_address: "devi@example.test" } }],
  items: [{ unit_amount: { currency_code: "USD", value: "680.00" } }],
};
const duplicateThen = (existing) => fakeFetch([
  { match: isCreate, status: 400, body: { name: "VALIDATION_ERROR", details: [{ issue: "DUPLICATE_INVOICE_NUMBER" }] } },
  // Search gives a summary with no items; the full object comes from the re-read.
  { match: isSearch, body: searchSummary({ status: "SENT", ...existing }) },
  { match: isGet, body: { id: ID, status: "SENT", ...existing } },
]);
/** Assert the refusal happened AND that exactly one named field caused it. */
async function refusedBecause(intended, existing, labels) {
  await assert.rejects(
    () => client(duplicateThen(existing)).createDraft(intended, "req-1"),
    (error) => {
      assert.ok(error instanceof PayPalError, "a refusal must be a PayPalError");
      assert.equal(error.body.name, "ADOPTION_REFUSED");
      assert.deepEqual(error.body.mismatches.map(([label]) => label), labels,
        "exactly these fields must be the cause, so deleting one of their checks fails this test");
      return true;
    },
  );
}

test("adoption is refused when ONLY the month differs, at identical rent", async () => {
  // THE case the collision actually produced, and the one nothing covered.
  // Rent is the same every month, so amount, currency and recipient are all
  // IDENTICAL between November and December. detail.reference is the only field
  // that can tell them apart — it carries the period and the full version label.
  // Adopting here would bind December's record to November's invoice and report a
  // resident as invoiced for a month they were never invoiced for.
  await refusedBecause(
    { detail: { invoice_number: "H-1", reference: "wc-3a/december-2026/77c10e42" }, ...SAME },
    { detail: { invoice_number: "H-1", reference: "wc-3a/november-2026/b6af47b9" }, ...SAME },
    ["reference"],
  );
});

test("adoption is refused when ONLY the amount differs", async () => {
  // The allocation changed but the reference somehow did not: still the wrong
  // invoice to bind, and the amount is the only thing saying so.
  await refusedBecause(
    { detail: { invoice_number: "H-1", reference: "r" }, ...SAME },
    { detail: { invoice_number: "H-1", reference: "r" }, ...SAME, items: [{ unit_amount: { currency_code: "USD", value: "700.00" } }] },
    ["amount"],
  );
});

test("adoption is refused when ONLY the currency differs", async () => {
  // 680 USD and 680 CAD are not the same money. Nothing covered this before the
  // mutation audit: removing the currency check broke no test.
  await refusedBecause(
    { detail: { invoice_number: "H-1", reference: "r" }, ...SAME },
    { detail: { invoice_number: "H-1", reference: "r" }, ...SAME, items: [{ unit_amount: { currency_code: "CAD", value: "680.00" } }] },
    ["currency"],
  );
});

test("adoption is refused when ONLY the recipient differs", async () => {
  // The billing destination changed, so the invoice sitting at PayPal is addressed
  // somewhere the resident no longer reads. Adopting it would report a money
  // request as delivered to a dead address.
  await refusedBecause(
    { detail: { invoice_number: "H-1", reference: "r" }, ...SAME },
    { detail: { invoice_number: "H-1", reference: "r" }, ...SAME, primary_recipients: [{ billing_info: { email_address: "old@example.test" } }] },
    ["recipient"],
  );
});
