// The durable stores, kept in Postgres instead of a local file, for hosting where
// there is no disk that outlives a request (Vercel).
//
// The rules the stores enforce do not change here. The payment store still refuses
// credentials, the allocation store still binds a confirmation to exact numbers;
// both are the same code as in local mode. What changes is only where `data` comes
// from and where it goes:
//
//   - Each request loads the rows it can see, works on them in memory exactly as the
//     file stores do, then writes back only the rows it changed (`flush`).
//   - A write carries the version it read. If another request changed that row in
//     the meantime, the write is refused rather than overwriting it — two people
//     confirming at the same moment cannot silently erase each other.
//   - The in-flight marker for drafting and sending an invoice is a row with a
//     primary key, not a Set in one process's memory. Two requests on two different
//     servers cannot both hold it.
//
// One table holds both stores, distinguished by `kind`, because both are the same
// shape: a document per key. Nothing here is fictional demo data — that stays in
// memory and resets, exactly as it does locally.
import { randomUUID } from "node:crypto";
import { operations } from "./allocation-store-core.js";
import { createPaymentStore } from "./payments/store.js";

const SCHEMA = [
  `create table if not exists hearth_documents (
    kind text not null,
    key text not null,
    data jsonb not null,
    version integer not null default 1,
    updated_at timestamptz not null default now(),
    primary key (kind, key)
  )`,
  `create table if not exists hearth_locks (
    key text primary key,
    holder text not null,
    acquired_at timestamptz not null default now()
  )`,
];

// Two servers starting at once can both try to create the same table. The loser
// sees one of these, and the table it wanted exists either way.
const ALREADY_CREATED = new Set(["23505", "42P07"]);

export async function ensureSchema(query) {
  for (const statement of SCHEMA) {
    try { await query(statement); }
    catch (error) { if (!ALREADY_CREATED.has(error.code)) throw error; }
  }
}

export class ConcurrentWriteError extends Error {
  constructor(kind, key) {
    super("Someone else changed this at the same moment, so your change was not saved. Reload and try again.");
    this.name = "ConcurrentWriteError";
    this.code = "CONCURRENT_WRITE";
    this.kind = kind;
    this.key = key;
  }
}

/**
 * Load every document of one kind, and return them with a `flush` that writes back
 * whatever changed since. A document is compared by its serialized form, so a row
 * that was only read is never written.
 */
async function loadDocuments(query, kind) {
  const { rows } = await query("select key, data, version from hearth_documents where kind = $1", [kind]);
  const documents = {};
  const written = new Map();
  for (const row of rows) {
    documents[row.key] = row.data;
    written.set(row.key, { version: row.version, json: JSON.stringify(row.data) });
  }

  async function flush() {
    for (const [key, value] of Object.entries(documents)) {
      const json = JSON.stringify(value);
      const before = written.get(key);
      if (before?.json === json) continue;
      const result = before
        ? await query("update hearth_documents set data = $3::jsonb, version = version + 1, updated_at = now() where kind = $1 and key = $2 and version = $4", [kind, key, json, before.version])
        : await query("insert into hearth_documents (kind, key, data) values ($1, $2, $3::jsonb) on conflict do nothing", [kind, key, json]);
      if (result.rowCount !== 1) throw new ConcurrentWriteError(kind, key);
      written.set(key, { version: before ? before.version + 1 : 1, json });
    }
  }

  return { documents, flush };
}

/** The payment store, loaded from Postgres. Same interface as the file store, plus `flush`. */
export async function loadPaymentStore(query) {
  const { documents, flush } = await loadDocuments(query, "payment");
  return { ...createPaymentStore({ records: documents, persist: () => {} }), location: "postgres", flush };
}

/** The allocation store, loaded from Postgres. Same interface as the file store, plus `flush`. */
export async function loadAllocationStore(query) {
  const { documents, flush } = await loadDocuments(query, "allocation");
  return { location: "postgres", ...operations({ version: 1, entries: documents }, () => {}), flush };
}

/**
 * The in-flight marker for drafting and sending, shared by every server.
 *
 * `acquire` returns a release function, or null when someone else holds the key.
 * A holder that dies without releasing — a function killed at its time limit — is
 * taken over once its marker is older than any request can run. Until then the
 * resident's invoice reports "already being processed", which is the truth.
 */
export function createLock(query, { staleAfterSeconds = 360 } = {}) {
  return {
    async acquire(key) {
      const holder = randomUUID();
      const { rowCount } = await query(
        `insert into hearth_locks (key, holder) values ($1, $2)
         on conflict (key) do update set holder = excluded.holder, acquired_at = now()
         where hearth_locks.acquired_at < now() - make_interval(secs => $3)`,
        [key, holder, staleAfterSeconds],
      );
      if (rowCount !== 1) return null;
      // Release only our own marker: one that went stale and was taken over now
      // belongs to someone else.
      return async () => { await query("delete from hearth_locks where key = $1 and holder = $2", [key, holder]); };
    },
  };
}
