// Configuration failures. Each one needs its own clear message, because "credentials
// missing" and "recipient mapping missing" need different fixes and a person should
// not have to guess which one they hit.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSandboxMapping, resolveMode, PaymentConfigError } from "../src/payments/config.js";
import { resolvePayments } from "../src/payments/provider.js";
import { PayPalSandbox } from "../src/payments/paypal-sandbox.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "hearth-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** assert.throws does not hand back the error, and these tests are about the message. */
const caught = (fn) => { try { fn(); return null; } catch (error) { return error; } };

function workspace(mapping) {
  const root = mkdtempSync(path.join(dir, "ws-"));
  if (mapping !== undefined) {
    mkdirSync(path.join(root, ".hearth-local"), { recursive: true });
    writeFileSync(path.join(root, ".hearth-local", "sandbox-recipients.json"), typeof mapping === "string" ? mapping : JSON.stringify(mapping), "utf8");
  }
  return root;
}

const GOOD_MAPPING = {
  invoicer: { sandboxBusinessEmail: "sb-seller@business.example.com", givenName: "Lantern", surname: "Ridge Rentals" },
  recipients: { _note: "ignored", "p-3a-devi": "sb-devi@personal.example.com" },
};
const CREDS = { PAYPAL_CLIENT_ID: "test-id", PAYPAL_CLIENT_SECRET: "test-secret", PAYPAL_ENV: "sandbox" };
const sandboxIn = (cwd, env = {}) => caught(() => resolvePayments({ env: { PAYMENTS_MODE: "paypal_sandbox", ...env }, cwd }));

test("the default mode is offline, so nothing is live by accident", () => {
  assert.equal(resolveMode({}), "offline");
});

test("an unrecognised mode is refused rather than guessed", () => {
  assert.throws(() => resolveMode({ PAYMENTS_MODE: "live" }), PaymentConfigError);
  assert.throws(() => resolveMode({ PAYMENTS_MODE: "production" }), /must be one of/);
});

test("offline mode needs no mapping and no credentials at all", () => {
  const payments = resolvePayments({ env: { PAYMENTS_MODE: "offline" }, cwd: workspace(undefined) });
  assert.equal(payments.mode, "offline");
  assert.equal(payments.available, false);
  assert.equal(payments.mapping, null);
  assert.throws(() => payments.provider.createDraft({}), /No payment provider is configured/);
});

test("offline mode ignores a mapping file even if one exists", () => {
  assert.equal(loadSandboxMapping({ mode: "offline", cwd: workspace(GOOD_MAPPING) }), null);
});

test("sandbox mode with no mapping file says exactly what to copy", () => {
  const error = sandboxIn(workspace(undefined), CREDS);
  assert.ok(error instanceof PaymentConfigError, `expected PaymentConfigError, got ${error}`);
  assert.match(error.message, /account mapping at \.hearth-local\/sandbox-recipients\.json/);
  assert.match(error.fix, /cp docs\/sandbox-recipients\.example\.json/);
});

test("an unfilled placeholder is treated as missing, not as a value", () => {
  const error = sandboxIn(workspace({ invoicer: { sandboxBusinessEmail: "sb-REPLACE@business.example.com" } }), CREDS);
  assert.ok(error instanceof PaymentConfigError);
  assert.match(error.message, /still the placeholder/);
});

test("a mapping with no seller email is refused", () => {
  const error = sandboxIn(workspace({ recipients: { "p-3a-devi": "sb-devi@personal.example.com" } }), CREDS);
  assert.ok(error instanceof PaymentConfigError);
  assert.match(error.message, /no sandbox business email for the seller/);
  assert.match(error.fix, /PayPal requires the invoicer email/);
});

test("broken JSON in the mapping is reported as broken JSON", () => {
  const error = sandboxIn(workspace("{ nope"), CREDS);
  assert.ok(error instanceof PaymentConfigError);
  assert.match(error.message, /not valid JSON/);
});

test("the mapping problem is reported before the credential problem", () => {
  // Someone who already set their credentials correctly should not be told to check them.
  const error = sandboxIn(workspace(undefined));
  assert.ok(error instanceof PaymentConfigError);
  assert.match(error.message, /account mapping/);
  assert.ok(!/PAYPAL_CLIENT/.test(error.message));
});

test("sandbox mode with a mapping but no credentials names the missing variables", () => {
  const error = sandboxIn(workspace(GOOD_MAPPING));
  assert.ok(error, "expected a configuration error");
  assert.match(error.message, /PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  assert.match(error.message, /PAYMENTS_MODE=offline/);
});

test("one missing credential is named on its own", () => {
  const error = sandboxIn(workspace(GOOD_MAPPING), { PAYPAL_CLIENT_ID: "x" });
  assert.ok(error, "expected a configuration error");
  assert.match(error.message, /needs PAYPAL_CLIENT_SECRET\./);
});

test("a fully configured sandbox resolves, with the seller and recipients loaded", () => {
  const payments = resolvePayments({ env: { PAYMENTS_MODE: "paypal_sandbox", ...CREDS }, cwd: workspace(GOOD_MAPPING) });
  assert.equal(payments.mode, "paypal_sandbox");
  assert.equal(payments.available, true);
  assert.equal(payments.mapping.invoicer.sandboxBusinessEmail, "sb-seller@business.example.com");
  assert.equal(payments.mapping.invoicer.displayName, "Lantern Ridge Rentals");
  assert.equal(payments.mapping.recipientFor("p-3a-devi"), "sb-devi@personal.example.com");
  assert.equal(payments.mapping.recipientFor("p-3a-ada"), null, "an unmapped resident has no address");
  assert.ok(!("_note" in payments.mapping.recipients), "comment keys are not recipients");
});

test("the client refuses to run against anything but sandbox", () => {
  assert.throws(() => new PayPalSandbox({ ...CREDS, env: "live" }), /sandbox-only/);
  assert.throws(() => new PayPalSandbox({ ...CREDS, env: "production" }), /sandbox-only/);
});

test("the client has no live endpoint, no dry-run fallback and no fused send", () => {
  const source = readFileSync(new URL("../src/payments/paypal-sandbox.js", import.meta.url), "utf8");
  assert.ok(!/api-m\.paypal\.com/.test(source), "no live endpoint may appear in this file");
  assert.ok(!/dryRun|DRY_RUN|dry_run/.test(source), "the client must have no dry-run path");
  assert.ok(!/createAndSend\s*\(/.test(source), "create and send must stay separate methods");
});

test("the old silent-dry-run client is gone, and nothing imports it", () => {
  assert.ok(!existsSync(new URL("../src/paypal.js", import.meta.url)), "src/paypal.js must not exist");
  for (const file of ["../server/payments-api.mjs", "../src/payments/provider.js", "../scripts/demo-server.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(!/from\s+["'][^"']*\/paypal\.js["']/.test(source), `${file} must not import the old client`);
  }
});
