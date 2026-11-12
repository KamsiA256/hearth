// The payment store. Small, local, and DURABLE on purpose.
//
// The fictional demo data resets whenever the server restarts. Sandbox invoices do
// not: once PayPal has an invoice, it exists whether or not this process remembers
// it. So payment records live here, in a separate file that survives a restart, and
// resetting the demo data can never make Hearth forget an invoice that really
// exists at the provider. That asymmetry is the whole reason this file exists.
//
// What it holds: provider invoice IDs, idempotency keys, the allocation version that
// was approved, who approved it, send outcomes, last known provider status.
// What it must NEVER hold: a client ID, a client secret, an access token, or any
// other credential. Those stay in the environment. A test asserts this.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recordKey } from "./idempotency.js";

// Fields that may never be written, whatever a caller passes.
const FORBIDDEN = /client_?id|client_?secret|access_?token|refresh_?token|authorization|password|bearer/i;

function assertNoCredentials(record) {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN.test(key)) throw new Error(`payment store: refusing to persist "${key}" — credentials never go in this file`);
  }
  const serialized = JSON.stringify(record);
  if (/\bBearer\s+[A-Za-z0-9._-]{10,}/.test(serialized)) throw new Error("payment store: refusing to persist something shaped like a bearer token");
}

/**
 * `records` and `persist` replace the file when the records live somewhere else
 * (src/postgres-stores.js). The rules below apply either way.
 */
export function createPaymentStore({ file, records, persist: persistElsewhere } = {}) {
  const location = file || path.join(process.cwd(), ".hearth-local", "payment-store.json");
  let data = { version: 1, records: records || {} };

  function load() {
    if (!existsSync(location)) return;
    try {
      const parsed = JSON.parse(readFileSync(location, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.records) data = { version: 1, ...parsed };
    } catch (error) {
      // A corrupt store is not something to paper over: it may be the only local
      // record of a real sandbox invoice. Keep the file and refuse to start.
      throw new Error(`payment store at ${location} is unreadable (${error.message}). Move it aside deliberately rather than letting Hearth overwrite it.`);
    }
  }

  function persist() {
    if (persistElsewhere) return persistElsewhere(data);
    mkdirSync(path.dirname(location), { recursive: true });
    // Write, then rename: a crash mid-write leaves the previous file intact rather
    // than a truncated one.
    const temporary = `${location}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(temporary, location);
  }

  if (!persistElsewhere) load();

  return {
    location,

    get(identity) { return data.records[recordKey(identity)] || null; },

    all() { return Object.values(data.records); },

    forProperty(propertyId, periodKeyValue) {
      return Object.values(data.records).filter((record) => record.propertyId === propertyId && (!periodKeyValue || record.periodKey === periodKeyValue));
    },

    /** Create or update one record. `changes` is merged; `event` is appended to its history. */
    put(identity, changes, event) {
      const key = recordKey(identity);
      const existing = data.records[key] || { key, ...identity, createdAt: new Date().toISOString(), history: [] };
      const next = { ...existing, ...changes, updatedAt: new Date().toISOString() };
      assertNoCredentials(next);
      if (event) next.history = [...(existing.history || []), { at: new Date().toISOString(), ...event }];
      data.records[key] = next;
      persist();
      return next;
    },

    /** Tests only. Never called by the server. */
    __reset() { data = { version: 1, records: {} }; persist(); },
  };
}
