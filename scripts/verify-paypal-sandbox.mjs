// Verify the PayPal sandbox connection against the real API, one endpoint at a time.
//
//   node scripts/verify-paypal-sandbox.mjs            auth, create a draft, replay the
//                                                     create, read it back
//   node scripts/verify-paypal-sandbox.mjs --send     also send it, then replay the send
//
// Why this exists: idempotency is documented on invoice creation, but whether the
// SEND endpoint honours the same header is a separate empirical question, and so is
// what a replayed request actually returns. This answers both by doing it and
// printing what came back, rather than assuming.
//
// It uses the same derived idempotency key the app uses for Devi's November share,
// so a draft created here is the same logical operation as the one the interface
// would create. Click "Prepare invoice" afterwards and PayPal should hand back this
// same invoice instead of making a second one.
//
// --send actually sends a sandbox invoice to your sandbox personal account. That is
// a deliberate action behind a deliberate flag; nothing sends without it.
import { allocationFor, lineFor } from "../src/allocation.js";
import { idempotencyKey } from "../src/payments/idempotency.js";
import { invoiceNumberFor } from "../src/payments/paypal-sandbox.js";
import { paymentStateOf, PAYMENT_STATE_LABEL } from "../src/payments/state.js";
import { resolvePayments } from "../src/payments/provider.js";
import { PaymentConfigError } from "../src/payments/config.js";
import { db, demoMeta } from "../server/_shared/db.mjs";

const PROPERTY = "wc-3a";
const PERSON = "p-3a-devi";
const WILL_SEND = process.argv.includes("--send");

const line = (text = "") => console.log(text);
const pass = (text) => line(`  PASS  ${text}`);
const fail = (text) => line(`  FAIL  ${text}`);
const info = (text) => line(`        ${text}`);

let payments;
try {
  payments = resolvePayments({ env: { ...process.env, PAYMENTS_MODE: "paypal_sandbox" } });
} catch (error) {
  line(`\nCannot verify: ${error.message}`);
  if (error instanceof PaymentConfigError && error.fix) line(`Fix: ${error.fix}`);
  line("\nSee docs/SANDBOX_SETUP.md\n");
  process.exit(1);
}
const { provider, mapping } = payments;

const { data: property } = await db().from("properties").select("id,display_name,organization_id").eq("id", PROPERTY).single();
const { data: people } = await db().from("people").select("id,name,room_id").eq("property_id", PROPERTY);
const snapshot = allocationFor({ propertyId: PROPERTY, activity: demoMeta.rentActivity[PROPERTY], people });
const target = lineFor(snapshot, PERSON);
const recipientEmail = mapping.recipientFor(PERSON);

line("\nPayPal sandbox verification");
line("===========================");
info(`Seller (invoicer):  ${mapping.invoicer.displayName} · ${mapping.invoicer.sandboxBusinessEmail}`);
info(`Recipient:          ${target.name} · ${recipientEmail || "NOT MAPPED"}`);
info(`Amount:             ${target.amountLabel}  (share of ${snapshot.totalLabel} for ${snapshot.period.label})`);
info(`Allocation version: ${snapshot.versionLabel}  (balances: ${snapshot.balances})`);
line();

if (!recipientEmail) { fail(`${PERSON} has no sandbox recipient mapped. Add it to .hearth-local/sandbox-recipients.json.`); process.exit(1); }
if (!snapshot.balances) { fail("The allocation does not balance, so no invoice may be created."); process.exit(1); }

let failures = 0;
const check = (ok, good, bad) => { if (ok) pass(good); else { fail(bad); failures++; } };

// ---- 1. Authentication ----------------------------------------------------
line("1. OAuth client_credentials");
const derivation = { propertyId: PROPERTY, periodKey: snapshot.period.key, personId: PERSON, allocationVersion: snapshot.version, destination: recipientEmail };
const createKey = idempotencyKey({ scope: "invoice-create", ...derivation });
const invoiceNumber = invoiceNumberFor(derivation);
const invoiceBody = provider.buildInvoice({ line: target, snapshot, property, invoicer: mapping.invoicer, recipientEmail, invoiceNumber });

let first;
try {
  first = await provider.createDraft(invoiceBody, createKey);
  pass("authenticated against the sandbox token endpoint");
} catch (error) {
  fail(`authentication or create failed: ${error.message}`);
  if (error.body) info(JSON.stringify(error.body).slice(0, 400));
  if (error.fix) { line(); for (const row of String(error.fix).split("\n")) info(row); }
  line("\nSee docs/SANDBOX_SETUP.md\n");
  process.exit(1);
}

// ---- 2. Create a draft ----------------------------------------------------
line("\n2. POST /v2/invoicing/invoices  (create draft)");
info(`invoice_number:     ${invoiceNumber}`);
info(`PayPal-Request-Id:  ${createKey}`);
info(`returned id:        ${first.providerInvoiceId}`);
info(`returned status:    ${first.providerStatus}${first.adopted ? "  (adopted an existing invoice with this number)" : ""}`);
check(Boolean(first.providerInvoiceId), "a draft invoice id came back", "no invoice id came back");
// Without an id there is nothing to replay against and nothing to read back. Stop
// here rather than carrying an undefined into the next two checks, where it turns
// into a 404 on ".../invoices/undefined" and buries the real finding in a stack.
if (!first.providerInvoiceId) {
  line("\nStopping: no invoice id, so steps 3 and 4 have nothing to act on.");
  process.exit(1);
}
check(String(first.providerStatus).toUpperCase() === "DRAFT" || first.adopted, "the new invoice is a DRAFT — creating does not send", `expected DRAFT, got ${first.providerStatus}`);

// ---- 3. Idempotency on CREATE --------------------------------------------
line("\n3. Idempotency on CREATE — replaying the same PayPal-Request-Id");
let replay;
try {
  replay = await provider.createDraft(invoiceBody, createKey);
  info(`replay returned id: ${replay.providerInvoiceId}${replay.adopted ? "  (via duplicate-invoice-number lookup)" : ""}`);
  check(replay.providerInvoiceId === first.providerInvoiceId,
    "the replay returned the SAME invoice — no duplicate was created",
    `the replay returned a DIFFERENT invoice (${replay.providerInvoiceId}). Retries would duplicate.`);
  if (replay.adopted) info("NOTE: the replay was resolved by looking the invoice number up, not by the header alone.");
} catch (error) {
  fail(`the replay errored: ${error.message}`);
  if (error.body) info(JSON.stringify(error.body).slice(0, 300));
  failures++;
}

// ---- 4. Read it back ------------------------------------------------------
line("\n4. GET /v2/invoicing/invoices/{id}  (read back)");
let read;
try {
  read = await provider.get(first.providerInvoiceId);
} catch (error) {
  fail(`reading the invoice back failed: ${error.message}`);
  if (error.body) info(JSON.stringify(error.body).slice(0, 300));
  if (error.fix) { line(); for (const row of String(error.fix).split("\n")) info(row); }
  process.exit(1);
}
const state = paymentStateOf(read.invoice);
info(`provider status:    ${read.providerStatus}`);
info(`Hearth state:       ${state.state}  — "${PAYMENT_STATE_LABEL[state.state]}"`);
info(`recipient_view_url: ${read.recipientViewUrl || "(absent on a draft)"}`);
check(read.providerInvoiceId === first.providerInvoiceId, "the invoice reads back by id", "the invoice did not read back");
check(!state.isPaidInFull, "an unsent draft is not reported as paid", "a draft was reported as paid");

if (!WILL_SEND) {
  line("\n5. SEND — skipped");
  info("Re-run with --send to send this invoice and verify idempotency on the send endpoint.");
  info("Or send it from the interface: npm run demo, open Rent, Prepare invoice, then Send.");
} else {
  // ---- 5. Send ------------------------------------------------------------
  line("\n5. POST /v2/invoicing/invoices/{id}/send  (send)");
  const sendKey = idempotencyKey({ ...derivation, scope: "invoice-send" });
  info(`PayPal-Request-Id:  ${sendKey}`);
  let sent;
  try {
    sent = await provider.send(first.providerInvoiceId, sendKey);
    const sentState = paymentStateOf(sent.invoice);
    info(`provider status:    ${sent.providerStatus}`);
    info(`Hearth state:       ${sentState.state}  — "${PAYMENT_STATE_LABEL[sentState.state]}"`);
    info(`recipient_view_url: ${sent.recipientViewUrl || "(none returned)"}`);
    check(String(sent.providerStatus).toUpperCase() !== "DRAFT", "the invoice left DRAFT after sending", "the invoice is still a DRAFT after sending");
    check(!sentState.isPaidInFull, "a sent invoice is NOT reported as paid", "a sent invoice was reported as paid");
    check(Boolean(sent.recipientViewUrl), "a hosted payment link came back", "no hosted payment link came back");
  } catch (error) {
    fail(`send failed: ${error.message}`);
    if (error.body) info(JSON.stringify(error.body).slice(0, 300));
    failures++;
  }

  // ---- 6. Idempotency on SEND -------------------------------------------
  if (sent) {
    line("\n6. Idempotency on SEND — replaying the same PayPal-Request-Id");
    try {
      const again = await provider.send(first.providerInvoiceId, sendKey);
      info(`replay status:      ${again.providerStatus}`);
      pass("the replay was accepted without error");
      info("Check the sandbox personal account's inbox: ONE invoice email means send is idempotent here.");
      info("TWO emails would mean the header does not deduplicate sends, and the app must rely on its own stored state (it does).");
    } catch (error) {
      // An error on replay is not necessarily wrong: refusing to re-send an already
      // sent invoice is also correct behaviour. What matters is what it says.
      info(`replay rejected:    ${error.message}`);
      if (error.body) info(`issue:              ${error.issue || JSON.stringify(error.body).slice(0, 200)}`);
      pass("the replay did not silently send a second time (it was rejected)");
    }
  }
}

line(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
line(`Invoice: ${first.providerInvoiceId}  ·  sandbox only, no real money.\n`);
process.exit(failures === 0 ? 0 : 1);
