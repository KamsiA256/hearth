// Local payment configuration: the mode, and the sandbox account mapping.
//
// Two separate failures, reported separately, because they need different fixes:
//   - missing credentials      -> .env
//   - missing recipient mapping -> .hearth-local/sandbox-recipients.json, or, where
//                                  there is no local disk (hosted), the same JSON in
//                                  the SANDBOX_RECIPIENTS_JSON environment variable
//
// Neither is ever guessed, defaulted, or quietly skipped. Sandbox mode with either
// one absent is a configuration error that stops the server, because the alternative
// is an interface that looks connected and is not.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const MODES = ["offline", "paypal_sandbox"];
export const DEFAULT_MAPPING_FILE = path.join(".hearth-local", "sandbox-recipients.json");

export class PaymentConfigError extends Error {
  constructor(message, { fix } = {}) { super(message); this.name = "PaymentConfigError"; this.fix = fix; }
}

export function resolveMode(env = process.env) {
  const mode = env.PAYMENTS_MODE || "offline";
  if (!MODES.includes(mode)) {
    throw new PaymentConfigError(`PAYMENTS_MODE must be one of ${MODES.join(" or ")}, not "${mode}".`, { fix: "Set PAYMENTS_MODE in .env" });
  }
  return mode;
}

/**
 * Load the sandbox account mapping. Returns null in offline mode.
 *
 * The invoicer is the fictional landlord's sandbox BUSINESS account: the seller of
 * record on every invoice. Recipients map a fictional resident id to a sandbox
 * PERSONAL account. These are real account addresses belonging to whoever is running
 * the demo, which is why they live outside the repository and outside the fixture.
 */
export function loadSandboxMapping({ mode, file, cwd = process.cwd(), json } = {}) {
  if (mode === "offline") return null;
  const location = json ? "SANDBOX_RECIPIENTS_JSON" : file || path.join(cwd, DEFAULT_MAPPING_FILE);
  if (!json && !existsSync(location)) {
    throw new PaymentConfigError(
      `Sandbox mode needs the account mapping at ${DEFAULT_MAPPING_FILE}, which does not exist.`,
      { fix: `mkdir -p .hearth-local && cp docs/sandbox-recipients.example.json ${DEFAULT_MAPPING_FILE}, then fill it in. See docs/SANDBOX_SETUP.md` },
    );
  }
  let parsed;
  try { parsed = JSON.parse(json || readFileSync(location, "utf8")); }
  catch (error) { throw new PaymentConfigError(`${json ? "SANDBOX_RECIPIENTS_JSON" : DEFAULT_MAPPING_FILE} is not valid JSON (${error.message}).`, { fix: "Fix the JSON, or re-copy docs/sandbox-recipients.example.json" }); }

  const invoicer = parsed.invoicer || {};
  const email = String(invoicer.sandboxBusinessEmail || "").trim();
  if (!email || email.includes("REPLACE")) {
    throw new PaymentConfigError(
      `${DEFAULT_MAPPING_FILE} has no sandbox business email for the seller (invoicer.sandboxBusinessEmail is ${email ? `still the placeholder "${email}"` : "empty"}).`,
      { fix: "Paste the sandbox Business account's email. PayPal requires the invoicer email to be that account's own." },
    );
  }

  const recipients = Object.fromEntries(
    Object.entries(parsed.recipients || {})
      .filter(([key, value]) => !key.startsWith("_") && typeof value === "string" && value.trim() && !value.includes("REPLACE")),
  );

  return {
    location,
    invoicer: {
      sandboxBusinessEmail: email,
      givenName: String(invoicer.givenName || "Landlord").trim(),
      surname: String(invoicer.surname || "-").trim(),
      // Shown in the review panel so the person approving can see who the invoice
      // comes FROM, not just who it goes to.
      displayName: `${String(invoicer.givenName || "Landlord").trim()} ${String(invoicer.surname || "").trim()}`.trim(),
    },
    recipients,
    recipientFor(personId) { return recipients[personId] || null; },
  };
}

/** The sentence shown when a resident has no sandbox account mapped. */
export const unmappedRecipientMessage = (personId, name) =>
  `${name || personId} has no sandbox recipient mapped. Add "${personId}" to recipients in ${DEFAULT_MAPPING_FILE} with a sandbox Personal account email, then reload. Hearth will not substitute an address.`;
