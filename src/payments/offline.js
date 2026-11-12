// The offline provider: it refuses.
//
// This exists so that "no credentials" has exactly one behaviour — a clear refusal —
// rather than a dry run that looks like a success. A fake invoice ID returned here
// would be indistinguishable from a real sandbox one a few screens later, which is
// the single most misleading thing this project could do.
export class PaymentProviderUnavailable extends Error {
  constructor(message) { super(message); this.name = "PaymentProviderUnavailable"; this.code = "PROVIDER_UNAVAILABLE"; }
}

const refuse = () => {
  throw new PaymentProviderUnavailable("No payment provider is configured. This is offline mode: set PAYMENTS_MODE=paypal_sandbox and provide sandbox credentials to issue invoices.");
};

export function offlineProvider() {
  return {
    name: "offline",
    available: false,
    describe: () => "Offline — no payment provider configured",
    createDraft: refuse,
    send: refuse,
    get: refuse,
  };
}
