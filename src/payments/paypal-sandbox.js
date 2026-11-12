// PayPal sandbox invoicing client.
//
// SANDBOX ONLY. There is no live base URL in this file, on purpose, and the
// constructor refuses to run if PAYPAL_ENV says anything other than "sandbox".
//
// Endpoints and field names verified 2026-11-02 against PayPal's published
// documentation:
//   POST /v1/oauth2/token                        client_credentials, Basic auth
//   POST /v2/invoicing/invoices                  creates a DRAFT
//   POST /v2/invoicing/invoices/{id}/send        sends it
//   GET  /v2/invoicing/invoices/{id}             reads it back
//   GET  /v2/invoicing/invoices                  lists (used to adopt a duplicate)
//
// Create and send are deliberately NOT combined. The gap between them is where a
// human looks at the draft and decides. A `createAndSend` convenience would remove
// the only point at which approval can happen.
//
// Two traps worth stating, because they have both bitten this codebase:
//   - Invoicing writes money as `amount.currency_code`. The Payouts API writes the
//     same thing as `amount.currency`. Same company, same sandbox, different key.
//   - `detail.invoice_number` must be unique per merchant. A retry that reuses it
//     gets DUPLICATE_INVOICE_NUMBER, which is a success in disguise: the invoice
//     already exists. That case is adopted, not treated as an error.

import { derivationDigest } from "./idempotency.js";

const SANDBOX = "https://api-m.sandbox.paypal.com";
const centsToValue = (cents) => (Math.trunc(cents) / 100).toFixed(2);

export class PayPalError extends Error {
  constructor(message, { status, body, endpoint } = {}) {
    super(message);
    this.name = "PayPalError";
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.issue = body?.details?.[0]?.issue || body?.name || null;
  }
}

export const DEFAULT_TIMEOUT_MS = 20000;

export class PayPalTimeoutError extends Error {
  constructor(endpoint, phase, ms) {
    super(`PayPal did not answer ${endpoint} within ${Math.round(ms / 1000)} s (${phase}). The outcome is unknown.`);
    this.name = "PayPalTimeoutError"; this.endpoint = endpoint; this.phase = phase; this.outcomeUnknown = true;
  }
}

export class PayPalSandbox {
  #token = null;
  #expiresAt = 0;

  constructor({ clientId, clientSecret, env, fetchImpl, timeoutMs } = {}) {
    // Every request AND every body read is bounded. A request that never answers
    // must surface as an unknown outcome, never as a hang or a clean result.
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const resolvedEnv = env ?? process.env.PAYPAL_ENV ?? "sandbox";
    if (resolvedEnv !== "sandbox") throw new Error(`refusing to run against PAYPAL_ENV=${resolvedEnv}; this client is sandbox-only`);
    this.clientId = clientId ?? process.env.PAYPAL_CLIENT_ID;
    this.clientSecret = clientSecret ?? process.env.PAYPAL_CLIENT_SECRET;
    // No dry-run fallback. Missing credentials are a configuration error, reported
    // here, not a quiet switch into pretending.
    const missing = [!this.clientId && "PAYPAL_CLIENT_ID", !this.clientSecret && "PAYPAL_CLIENT_SECRET"].filter(Boolean);
    if (missing.length) throw new Error(`PayPal sandbox mode needs ${missing.join(" and ")}. Set them in .env, or run with PAYMENTS_MODE=offline.`);
    this.fetch = fetchImpl || globalThis.fetch;
    this.name = "paypal_sandbox";
    this.available = true;
  }

  describe() { return "PayPal sandbox (invoicing)"; }

  // fetch + full body read, under one deadline. The race covers fetch
  // implementations that ignore the abort signal, and bodies that never finish.
  async #fetchText(url, init, endpoint) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PayPalTimeoutError(endpoint, "request", this.timeoutMs)); }, this.timeoutMs);
    });
    try {
      const res = await Promise.race([this.fetch(url, { ...init, signal: controller.signal }), deadline]);
      const text = await Promise.race([res.text(), deadline.catch(() => { throw new PayPalTimeoutError(endpoint, "reading the response", this.timeoutMs); })]);
      return { res, text };
    } catch (error) {
      if (error?.name === "AbortError") throw new PayPalTimeoutError(endpoint, "aborted", this.timeoutMs);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async #accessToken() {
    if (this.#token && Date.now() < this.#expiresAt) return this.#token;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const { res, text } = await this.#fetchText(`${SANDBOX}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    }, "/v1/oauth2/token");
    if (!res.ok) {
      const error = new PayPalError(`PayPal authentication failed (HTTP ${res.status})`, { status: res.status, body: safeJson(text), endpoint: "/v1/oauth2/token" });
      // invalid_client is returned for an unknown client id AND for a wrong secret,
      // so the message cannot say which. It can say what to check, in the order that
      // resolves it fastest. Guessing between them is what wastes the time.
      if (/invalid_client/i.test(text)) {
        error.fix = [
          "The sandbox rejected this client id / secret pair. Check, in this order:",
          "  1. The dashboard was on Sandbox, not Live, when you copied them. A Live app's",
          "     credentials fail here with exactly this error.",
          "  2. The secret is complete. PayPal only reveals it on request, and a partial",
          "     copy looks valid but is not.",
          "  3. Both values came from the SAME app. An id from one app and a secret from",
          "     another is the same error again.",
          "Both values are in .env. Nothing else needs changing.",
        ].join("\n");
      }
      throw error;
    }
    const json = JSON.parse(text);
    this.#token = json.access_token;
    // Refresh a minute early rather than racing the expiry.
    this.#expiresAt = Date.now() + Math.max(0, (json.expires_in ?? 0) - 60) * 1000;
    return this.#token;
  }

  async #call(method, endpoint, { body, requestId, prefer } = {}) {
    const token = await this.#accessToken();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    // Idempotency. Sent on every POST so a retry cannot create a second invoice.
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    if (prefer) headers.Prefer = prefer;
    const { res, text } = await this.#fetchText(`${SANDBOX}${endpoint}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, endpoint);
    const json = safeJson(text);
    if (!res.ok) {
      const error = new PayPalError(`PayPal ${method} ${endpoint} returned HTTP ${res.status}`, { status: res.status, body: json, endpoint });
      // 403 NOT_AUTHORIZED on an invoicing endpoint means the credentials are fine
      // and the app simply lacks the Invoicing feature. Authentication succeeding
      // makes this easy to misread as a code fault, so say what it actually is.
      if (res.status === 403 && /NOT_AUTHORIZED/i.test(text || "")) {
        error.fix = [
          "The credentials authenticated, but this app is not permitted to use Invoicing.",
          "Enable it: Developer Dashboard -> Apps & Credentials -> Sandbox -> your app ->",
          "Features -> tick Invoicing -> Save. The client id and secret do not change.",
          "A token minted before the change does not gain the scope; re-run afterwards.",
        ].join("\n");
      }
      throw error;
    }
    return json ?? {};
  }

  /**
   * The invoice body for one resident's monthly share.
   *
   * One item, because one resident owes one share. The item's description carries
   * the basis, so the invoice itself explains where the number came from rather than
   * asking the resident to trust it.
   */
  buildInvoice({ line, snapshot, property, invoicer, recipientEmail, invoiceNumber }) {
    const [givenName, ...rest] = String(line.name).trim().split(/\s+/);
    return {
      detail: {
        currency_code: "USD",
        invoice_number: invoiceNumber,
        reference: `${snapshot.propertyId}/${snapshot.period.key}/${snapshot.versionLabel}`,
        note: `${property.display_name} — ${snapshot.period.label}. Your agreed share of the ${snapshot.totalLabel} monthly rent. Allocation version ${snapshot.versionLabel}.`,
        terms_and_conditions: "This invoice covers one resident's agreed share of the household's monthly rent. It does not change the lease or anyone's obligations under it. Reply to your landlord to query any amount.",
      },
      invoicer: {
        name: { given_name: invoicer.givenName, surname: invoicer.surname },
        email_address: invoicer.sandboxBusinessEmail,
      },
      primary_recipients: [{
        billing_info: {
          name: { given_name: givenName, surname: rest.join(" ") || "-" },
          email_address: recipientEmail,
        },
      }],
      items: [{
        name: `Rent share — ${snapshot.period.label}`,
        description: `Agreed share of ${snapshot.totalLabel} total monthly rent for ${property.display_name}`,
        quantity: "1",
        unit_amount: { currency_code: "USD", value: centsToValue(line.amountCents) },
        unit_of_measure: "AMOUNT",
      }],
    };
  }

  /**
   * Create a DRAFT invoice. Does not send it.
   *
   * If the invoice number is already taken, the invoice already exists: find and
   * adopt it rather than reporting a failure that would push a caller into creating
   * a second one under a new number.
   */
  async createDraft(invoice, requestId) {
    try {
      // Prefer: return=representation, because the DEFAULT response to this call is
      // not the invoice. PayPal replies with a bare link object — {rel, href, method}
      // — and no id and no status at all. Reading `created.id` off that gives
      // undefined, which then travels as a real invoice id until something 404s on
      // ".../invoices/undefined". Observed against the live sandbox 2026-11-02.
      const created = await this.#call("POST", "/v2/invoicing/invoices", { body: invoice, requestId, prefer: "return=representation" });
      const providerInvoiceId = created.id || idFromLink(created);
      // An invoice with no id is not a success we can act on. Refusing here keeps an
      // undefined from being written to the store as though it were an invoice.
      if (!providerInvoiceId) {
        throw new PayPalError("PayPal accepted the invoice but returned no id to reference it by", {
          status: 201, body: created, endpoint: "/v2/invoicing/invoices",
        });
      }
      // If the representation came back, its status is authoritative. If we had to
      // dig the id out of a link, we do not know the status: ask, rather than assume
      // "DRAFT" and risk calling a sent invoice a draft.
      if (created.status) return { providerInvoiceId, providerStatus: created.status, adopted: false, raw: created };
      const read = await this.get(providerInvoiceId);
      return { providerInvoiceId, providerStatus: read.providerStatus, adopted: false, raw: read.invoice };
    } catch (error) {
      const duplicate = error instanceof PayPalError && /DUPLICATE_INVOICE_NUMBER/i.test(JSON.stringify(error.body || {}));
      if (!duplicate) throw error;
      const found = await this.findByInvoiceNumber(invoice.detail.invoice_number);
      if (!found) throw error;
      // The search response is a SUMMARY. It carries id, status, detail, invoicer,
      // primary_recipients and the totals, but NOT `items` — observed against the
      // live sandbox, 2026-11-03. Verifying against it would compare our line
      // amount to undefined and refuse EVERY legitimate adoption. So re-read the
      // full invoice, which `get` is already the authority for, and verify that.
      const reread = await this.get(found.id);
      const existing = reread.invoice;
      // Matching on the invoice number ALONE is not enough. The number is derived,
      // so a derivation defect or a hash collision would hand us somebody else's
      // invoice — or the same resident's invoice for a different month — and we
      // would bind it to this record and report the resident as invoiced. Verify it
      // is really the invoice we meant to create, and fail loudly if it is not.
      assertSameInvoice(invoice, existing);
      return { providerInvoiceId: reread.providerInvoiceId, providerStatus: reread.providerStatus, adopted: true, raw: existing };
    }
  }

  /**
   * Send an invoice that already exists. Separate call, separate human decision.
   *
   * `notifyRecipient` maps to PayPal's `send_to_recipient`, a top-level boolean on
   * the send body that defaults to true (verified against PayPal's API reference,
   * 2026-11-02). False makes the invoice payable WITHOUT PayPal emailing anyone,
   * which is the mode for delivering the hosted link over SMS instead. Either way
   * the invoice is equally payable; this controls who announces it, nothing else.
   */
  async send(providerInvoiceId, requestId, { notifyRecipient = true } = {}) {
    const sent = await this.#call("POST", `/v2/invoicing/invoices/${encodeURIComponent(providerInvoiceId)}/send`, {
      body: { send_to_invoicer: false, send_to_recipient: notifyRecipient },
      requestId,
    });
    // The send response is thin and varies; the invoice itself is the authority.
    const invoice = await this.get(providerInvoiceId);
    return { ...invoice, sendResponse: sent };
  }

  /** Read an invoice back. This is the only thing allowed to say what was paid. */
  async get(providerInvoiceId) {
    const invoice = await this.#call("GET", `/v2/invoicing/invoices/${encodeURIComponent(providerInvoiceId)}`);
    return {
      providerInvoiceId: invoice.id,
      providerStatus: invoice.status,
      recipientViewUrl: invoice.detail?.metadata?.recipient_view_url || null,
      invoice,
    };
  }

  /**
   * Find one invoice by its number. Returns a SUMMARY, not a full invoice: the
   * response has no `items`, so a caller that needs line amounts must `get` it.
   *
   * Uses POST /v2/invoicing/search-invoices, whose request body takes an
   * `invoice_number` filter (verified against PayPal's own OpenAPI specification,
   * 2026-11-03). The previous implementation listed the FIRST 100 invoices and
   * scanned them, so adoption silently stopped working once the merchant had more
   * than 100 invoices — exactly when it matters most.
   */
  async findByInvoiceNumber(invoiceNumber) {
    const page = await this.#call("POST", "/v2/invoicing/search-invoices?page_size=10&total_required=false", {
      body: { invoice_number: invoiceNumber },
    });
    // The filter is a server-side match, but it is still a FILTER: confirm the hit
    // is exact rather than trusting the search to be precise.
    return (page.items || []).find((item) => item.detail?.invoice_number === invoiceNumber) || null;
  }
}

/**
 * Refuse to adopt an invoice that is not the one we intended to create.
 *
 * `detail.reference` carries property/period/FULL version label, so it is the
 * strongest single check available: unlike the invoice number it is not truncated.
 * Amount, currency and recipient are checked too, because a reference match with a
 * different amount would still be the wrong invoice to bind.
 *
 * A recipient mismatch is a REFUSAL, not a correction. If the billing destination
 * changed, the invoice sitting at PayPal is addressed somewhere the resident no
 * longer uses; adopting it would report a money request as delivered to an address
 * nobody reads. The destination is part of the invoice number derivation, so the
 * replacement invoice gets its own number and this case should not arise — if it
 * does, something is wrong and silence would be the worst answer.
 */
function assertSameInvoice(intended, existing) {
  const field = (invoice, path) => path.split(".").reduce((node, key) => (node == null ? node : node[key]), invoice);
  const checks = [
    ["reference", "detail.reference"],
    ["amount", "items.0.unit_amount.value"],
    ["currency", "items.0.unit_amount.currency_code"],
    ["recipient", "primary_recipients.0.billing_info.email_address"],
  ];
  const mismatches = checks
    .map(([label, path]) => [label, field(intended, path) ?? null, field(existing, path) ?? null])
    .filter(([, want, got]) => want !== got);
  if (!mismatches.length) return;
  throw new PayPalError(
    `An invoice numbered ${intended.detail?.invoice_number} already exists at PayPal, but it is not the invoice Hearth meant to create, so it was NOT adopted. ` +
    mismatches.map(([label, want, got]) => `${label}: existing ${JSON.stringify(got)}, intended ${JSON.stringify(want)}`).join("; "),
    { status: 409, endpoint: "/v2/invoicing/search-invoices", body: { name: "ADOPTION_REFUSED", mismatches } },
  );
}

/**
 * Pull an invoice id out of PayPal's minimal create response.
 *
 * That response is either {rel, href, method} or {links: [{rel: "self", href}]}.
 * The id is the last path segment of the self href.
 */
function idFromLink(created) {
  if (!created || typeof created !== "object") return null;
  const candidates = [created.href, ...(Array.isArray(created.links) ? created.links.filter((l) => !l.rel || l.rel === "self").map((l) => l.href) : [])];
  for (const href of candidates) {
    if (typeof href !== "string") continue;
    const match = /\/v2\/invoicing\/invoices\/([^/?#]+)/.exec(href);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
}

/**
 * Deterministic, unique-per-merchant, at most 25 characters as PayPal requires.
 *
 * The readable prefix is COSMETIC and allowed to collide. All uniqueness lives in
 * the digest, which covers property, period, resident, allocation version AND
 * destination.
 *
 * The previous version derived uniqueness from readable parts and collided:
 *   - it took the TAIL of the period, so "september-2026", "october-2026",
 *     "november-2026" and "december-2026" ALL slugged to "ER2026";
 *   - it used the first 4 hex characters of the version label, i.e. 65,536 values.
 * Two different months could therefore produce one invoice number, and the adopt
 * path would then bind one month's record to the other month's invoice — reporting
 * a resident as invoiced who never was. See docs/DECISIONS.md.
 *
 * The month is now head-sliced, so NOV and DEC differ, and 10 hex characters of the
 * digest carry the uniqueness. Total is exactly 25 characters, never truncated.
 */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The month and year a period key names, or a refusal.
 *
 * This is strict on purpose. The readable half of an invoice number is the only part a
 * human scanning a provider's invoice list can act on, and a period key this cannot
 * read does not produce a wrong number — it produces a number with the readable half
 * MISSING, which looks fine until someone needs it. `"2026-11"` used to yield month ""
 * and year "2611": both halves silently wrong, nothing thrown.
 *
 * So an unreadable period key is a configuration error, raised where it is introduced
 * rather than carried into a provider record that cannot be edited afterwards.
 */
export function readPeriodKey(periodKey) {
  const text = String(periodKey ?? "");
  const month = text.replace(/[^a-zA-Z]/g, "").slice(0, 3).toLowerCase();
  const year = text.replace(/\D/g, "").slice(-4);
  const monthIndex = MONTHS.indexOf(month);
  if (monthIndex === -1 || year.length !== 4) {
    throw new TypeError(
      `Period key ${JSON.stringify(periodKey)} does not name a month and a four-digit year, ` +
      `so no readable invoice number can be built from it. Use a key like "november-2026". ` +
      `(read month ${JSON.stringify(month)}, year ${JSON.stringify(year)})`,
    );
  }
  return { month: MONTHS[monthIndex].toUpperCase(), year, monthIndex };
}

export function invoiceNumberFor({ propertyId, periodKey, personId, allocationVersion, destination }) {
  const place = String(propertyId).replace(/[^a-zA-Z0-9]/g, "").slice(-4).toUpperCase();
  const { month, year } = readPeriodKey(periodKey);
  const digest = derivationDigest({ scope: "invoice-number", propertyId, periodKey, personId, allocationVersion, destination }).slice(0, 10);
  return `H-${place}-${month}${year}-${digest}`;
}
