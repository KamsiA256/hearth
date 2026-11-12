// Choosing the payment provider. The only place that decides which one is in play.
//
// Everything above this line in the stack — the allocation, the approval binding,
// the store, the interface — is provider-agnostic. PayPal sits behind the three
// methods below, so adding a second provider means writing those three methods, not
// touching allocation logic.
//
// This is deliberately not a payment framework. Three methods, one provider, one
// refusing stub.
import { loadSandboxMapping, resolveMode } from "./config.js";
import { offlineProvider } from "./offline.js";
import { PayPalSandbox } from "./paypal-sandbox.js";

/**
 * Resolve the provider and its configuration from the environment.
 *
 * Throws PaymentConfigError in sandbox mode when credentials or the account mapping
 * are missing. The server calls this at startup so a misconfiguration is a failure
 * to start, not a surprise three clicks into a demo.
 */
export function resolvePayments({ env = process.env, cwd = process.cwd(), fetchImpl } = {}) {
  const mode = resolveMode(env);
  if (mode === "offline") {
    return { mode, provider: offlineProvider(), mapping: null, available: false };
  }
  // Order matters: report the mapping problem before authenticating, so a person
  // with no mapping is not told about credentials they already set correctly.
  const mapping = loadSandboxMapping({ mode, cwd, json: env.SANDBOX_RECIPIENTS_JSON });
  const provider = new PayPalSandbox({ env: env.PAYPAL_ENV, clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, fetchImpl });
  return { mode, provider, mapping, available: true };
}
