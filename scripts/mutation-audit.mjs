// Does the suite actually test anything?
//
// A green suite proves nothing on its own. This repository has twice shipped a real
// defect while every test passed: a client that returned `providerInvoiceId:
// undefined` (2026-11-02) and an invoice-number derivation in which four months
// collided (2026-11-03). In both cases tests existed and asserted the wrong thing.
//
// So: break the code on purpose, one change at a time, and check that the suite
// NOTICES. A mutation no test catches means that behaviour is uncovered, however
// many tests appear to be about it.
//
// It also catches the subtler failure, which is the one worth having a tool for: a
// test that kills a mutant for the WRONG REASON. The refusal test originally varied
// the reference AND the amount, so deleting the reference check still failed it — on
// the error message, not the behaviour. With identical rent (which is the normal
// case: the same resident owes the same share every month) a month collision would
// have been adopted silently. The single-field tests exist because of that finding.
//
// Run: npm run test:mutation
//
// SAFETY: this script writes to source files and restores them. It restores on
// error, on an unhandled rejection and on SIGINT. If it is killed with SIGKILL,
// check `git diff` before trusting the tree.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PP = "src/payments/paypal-sandbox.js";
const ID = "src/payments/idempotency.js";
const MS = "data/meeting-scenario.mjs";
const AA = "server/allocation-api.mjs";
const UI = "public/app.js";
const SOURCES = [PP, ID, MS, AA, UI];

// The same file set as `npm test`. Passing the DIRECTORY to `node --test` resolves a
// different set and made an earlier version of this script report a red baseline
// against a green suite.
const TEST_FILES = readdirSync("tests").filter((name) => name.endsWith(".test.js")).map((name) => `tests/${name}`);

const MUTATIONS = [
  { name: "month slug reverts to tail-slicing (the original bug)", file: PP,
    from: `const month = text.replace(/[^a-zA-Z]/g, "").slice(0, 3).toLowerCase();`,
    to:   `const month = text.replace(/[^a-zA-Z]/g, "").slice(-3).toLowerCase();` },

  { name: "an unreadable period key is accepted instead of refused", file: PP,
    // The 2026-11 bug: month "" and year "2611", carried into a permanent provider
    // record with the readable half missing and nothing thrown.
    from: `  if (monthIndex === -1 || year.length !== 4) {`,
    to:   `  if (false) {` },

  { name: "an unknown month name is accepted", file: PP,
    from: `  if (monthIndex === -1 || year.length !== 4) {`,
    to:   `  if (year.length !== 4) {` },

  { name: "a missing year is accepted", file: PP,
    from: `  if (monthIndex === -1 || year.length !== 4) {`,
    to:   `  if (monthIndex === -1) {` },

  { name: "the digest is removed from the invoice number", file: PP,
    from: `, destination }).slice(0, 10);`,
    to:   `, destination }).slice(0, 0);` },

  { name: "BOTH: ambiguous month AND no digest", file: PP, multi: [
    { from: `const month = text.replace(/[^a-zA-Z]/g, "").slice(0, 3).toLowerCase();`, to: `const month = text.replace(/[^a-zA-Z]/g, "").slice(-3).toLowerCase();` },
    { from: `, destination }).slice(0, 10);`, to: `, destination }).slice(0, 0);` },
  ] },

  { name: "destination stops affecting the invoice number", file: PP,
    from: `const digest = derivationDigest({ scope: "invoice-number", propertyId, periodKey, personId, allocationVersion, destination }).slice(0, 10);`,
    to:   `const digest = derivationDigest({ scope: "invoice-number", propertyId, periodKey, personId, allocationVersion, destination: "pinned" }).slice(0, 10);` },

  { name: "destination stops affecting the idempotency key", file: ID,
    from: `const material = [scope, propertyId, periodKey, personId, allocationVersion, destination].join("\\u0000");`,
    to:   `const material = [scope, propertyId, periodKey, personId, allocationVersion].join("\\u0000");` },

  { name: "adoption stops checking the REFERENCE", file: PP, from: `    ["reference", "detail.reference"],\n`, to: `` },
  { name: "adoption stops checking the AMOUNT", file: PP, from: `    ["amount", "items.0.unit_amount.value"],\n`, to: `` },
  { name: "adoption stops checking the CURRENCY", file: PP, from: `    ["currency", "items.0.unit_amount.currency_code"],\n`, to: `` },
  { name: "adoption stops checking the RECIPIENT", file: PP, from: `    ["recipient", "primary_recipients.0.billing_info.email_address"],\n`, to: `` },
  { name: "adoption verifies nothing at all", file: PP, from: `      assertSameInvoice(invoice, existing);\n`, to: `` },

  { name: "reference compares the WRONG field (always equal)", file: PP,
    from: `    ["reference", "detail.reference"],`,
    to:   `    ["reference", "detail.invoice_number"],` },

  { name: "mismatches are computed but never reported", file: PP,
    from: `    .filter(([, want, got]) => want !== got);`,
    to:   `    .filter(() => false);` },

  { name: "a null field silently equals a present one", file: PP,
    from: `    .map(([label, path]) => [label, field(intended, path) ?? null, field(existing, path) ?? null])`,
    to:   `    .map(([label, path]) => [label, field(intended, path) ?? null, field(intended, path) ?? null])` },

  { name: "adoption verifies the search SUMMARY instead of re-reading", file: PP,
    from: `      const reread = await this.get(found.id);`,
    to:   `      const reread = { invoice: found, providerInvoiceId: found.id, providerStatus: found.status };` },

  { name: "lookup reverts to scanning the first list page", file: PP,
    from: `    const page = await this.#call("POST", "/v2/invoicing/search-invoices?page_size=10&total_required=false", {
      body: { invoice_number: invoiceNumber },
    });`,
    to: `    const page = await this.#call("GET", "/v2/invoicing/invoices?page_size=100&total_required=false&fields=all");` },

  { name: "the Prefer: return=representation header is dropped", file: PP,
    from: `{ body: invoice, requestId, prefer: "return=representation" }`,
    to:   `{ body: invoice, requestId }` },

  { name: "a create with no id no longer throws", file: PP,
    from: `      if (!providerInvoiceId) {`,
    to:   `      if (false) {` },
  // ---- Meeting demonstration (2026-11-05) ----
  { name: "meeting: any period accepted (invoicing then fails mid-demo)", file: MS,
    from: `if (!PERIOD.test(period)) refuse(`, to: `if (false) refuse(` },
  { name: "meeting: label character check removed", file: MS,
    from: `if (!chars.test(text)) refuse(`, to: `if (false) refuse(` },
  { name: "meeting: unknown profile fields accepted", file: MS,
    from: `if (extra.length) refuse(`, to: `if (false) refuse(` },
  { name: "meeting: opening shares need not reconcile", file: MS,
    from: `if (sum !== total) refuse(`, to: `if (false) refuse(` },
  { name: "meeting: ids taken from a shared prefix", file: MS,
    from: `resident: (i) => \`meeting-demo-resident-\${i + 1}\`,`, to: `resident: (i) => ["p-3a-ada", "p-3a-ben", "p-3a-cam"][i] || \`meeting-demo-resident-\${i + 1}\`,` },
  { name: "allocation: an in-flight draft no longer blocks share edits", file: AA,
    from: `|| invoice.localState === "draft_proposed"`, to: `|| false` },
  { name: "ui: illustrative totals labelled monthly rent again", file: UI,
    from: `illustrative ? "Household total (illustrative)" : "Monthly rent"`, to: `"Monthly rent"` },

];

const originals = new Map(SOURCES.map((file) => [file, readFileSync(file, "utf8")]));
let restored = false;
function restore() {
  for (const [file, text] of originals) writeFileSync(file, text, "utf8");
  restored = true;
}
process.on("exit", () => { if (!restored) restore(); });
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("unhandledRejection", (error) => { restore(); throw error; });

function runSuite() {
  try {
    execFileSync("node", ["--test", ...TEST_FILES], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { failed: false, out: "" };
  } catch (error) {
    return { failed: true, out: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

const failureNames = (out) => {
  const names = new Set();
  for (const match of out.matchAll(/^✖ (.+?) \(\d/gm)) if (!/^failing tests/.test(match[1])) names.add(match[1]);
  return [...names];
};

const baseline = runSuite();
if (baseline.failed) {
  console.error("The suite is already failing. Fix that before auditing it.");
  restore();
  process.exit(1);
}
console.log(`baseline: green (${TEST_FILES.length} test files)\n`);

const survivors = [];
const skipped = [];
for (const mutation of MUTATIONS) {
  restore();
  restored = false;
  const edits = mutation.multi || [mutation];
  let applied = true;
  for (const edit of edits) {
    const text = readFileSync(mutation.file, "utf8");
    const hits = text.split(edit.from).length - 1;
    if (hits !== 1) {
      console.log(`SKIP     ${mutation.name}  (anchor matched ${hits}x — the code moved, update this mutation)`);
      skipped.push(mutation.name);
      applied = false;
      break;
    }
    writeFileSync(mutation.file, text.replace(edit.from, edit.to), "utf8");
  }
  if (!applied) continue;

  const result = runSuite();
  if (result.failed) {
    const killers = failureNames(result.out);
    console.log(`KILLED   ${mutation.name}`);
    console.log(`         by: ${killers.slice(0, 3).join(" | ") || "(unnamed failure)"}${killers.length > 3 ? ` (+${killers.length - 3})` : ""}`);
  } else {
    console.log(`SURVIVED ${mutation.name}   <-- NO TEST NOTICED`);
    survivors.push(mutation.name);
  }
}
restore();

const killed = MUTATIONS.length - survivors.length - skipped.length;
console.log(`\n${killed} killed, ${survivors.length} survived, ${skipped.length} skipped`);
if (survivors.length) {
  console.log("\nUncovered behaviour — each of these is a change no test would catch:");
  for (const name of survivors) console.log(`  - ${name}`);
}
if (skipped.length) console.log("\nSkipped mutations are stale anchors, not passes. Update them.");
process.exit(survivors.length || skipped.length ? 1 : 0);
