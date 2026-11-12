// The in-memory database the operator API talks to.
//
// It implements the small subset of a PostgREST-style query builder that
// server/operator-api.mjs actually uses — chained filters, ordering, limits, inserts,
// upserts, and embedded relations such as "people(name)" and "lease_groups!fk(...)".
// Rows live in memory, nothing is sent anywhere, and everything is forgotten when the
// process exits or the page reloads.
//
// There is no database driver in this repository. This file is the whole storage
// layer, which is why the isolation claim in the README can be checked by reading it.
// Deliberately free of node:* imports, so the same tested implementation runs in the
// local server and inside the browser bundle. Web Crypto exists in both.
const randomUUID = () => globalThis.crypto.randomUUID();

const SINGULAR = { people: "person", rooms: "room", properties: "property", messages: "message", lease_groups: "lease_group", escalations: "escalation", conversations: "conversation", phone_numbers: "phone_number", evidence: "evidence", call_logs: "call_log", workflow_tasks: "workflow_task", releasing_status: "releasing_status", audit_events: "audit_event", info_requests: "info_request", request_templates: "request_template", request_groups: "request_group" };

const ROW_DEFAULTS = {
  messages: () => ({ media_urls: [], provider_message_id: null, error_code: null, needs_human: false, human_answered_at: null, model_used: null, escalated_to_deep_model: false, model_usage: [], in_reply_to_message_id: null }),
  escalations: () => ({ status: "open", resolved_at: null }),
  workflow_tasks: () => ({ value_text: null, status: "pending", completed_at: null, evidence_id: null }),
  conversations: () => ({ opened_at: new Date().toISOString(), last_activity: new Date().toISOString() }),
  audit_events: () => ({ metadata: {} }),
};

function splitTopLevel(text) {
  const parts = []; let depth = 0, current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function project(tables, table, row, columns) {
  if (!row) return row;
  const out = {};
  for (const part of splitTopLevel(columns || "*")) {
    const relation = part.match(/^([a-z_]+)(?:![a-z_]+)?\((.*)\)$/s);
    if (!relation) { if (part === "*") Object.assign(out, structuredClone(row)); else out[part] = structuredClone(row[part] ?? null); continue; }
    const [, target, inner] = relation, foreignKey = `${SINGULAR[target]}_id`;
    if (Object.hasOwn(row, foreignKey)) {
      const match = (tables[target] || []).find((candidate) => candidate.id === row[foreignKey]);
      out[target] = match ? project(tables, target, match, inner) : null;
    } else {
      const backKey = `${SINGULAR[table]}_id`;
      out[target] = (tables[target] || []).filter((candidate) => candidate[backKey] === row.id).map((candidate) => project(tables, target, candidate, inner));
    }
  }
  return out;
}

class Query {
  constructor(tables, table) { Object.assign(this, { tables, table, filters: [], orders: [], max: null, mode: "select", columns: "*", returning: false, one: false }); }
  select(columns = "*") { if (this.mode === "select") this.columns = columns; else { this.returning = true; this.columns = columns; } return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  neq(column, value) { this.filters.push((row) => row[column] !== value); return this; }
  is(column, value) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
  textSearch(column, query) { const words = String(query).toLowerCase().split(/\s+/).filter(Boolean); this.filters.push((row) => words.every((word) => String(row[column] || "").toLowerCase().includes(word))); return this; }
  order(column, { ascending = true } = {}) { this.orders.push([column, ascending]); return this; }
  limit(count) { this.max = count; return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.one = true; this.maybe = true; return this; }
  insert(rows) { this.mode = "insert"; this.payload = rows; return this; }
  update(changes) { this.mode = "update"; this.payload = changes; return this; }
  upsert(row, { onConflict } = {}) { this.mode = "upsert"; this.payload = row; this.conflict = onConflict ? onConflict.split(",") : ["id"]; return this; }

  run() {
    const rows = this.tables[this.table] ||= [];
    let affected;
    if (this.mode === "insert" || this.mode === "upsert") {
      affected = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((input) => {
        const existing = this.mode === "upsert" && rows.find((row) => this.conflict.every((key) => row[key] === input[key]));
        if (existing) return Object.assign(existing, structuredClone(input));
        const row = { id: this.table === "audit_events" ? rows.length + 1 : randomUUID(), created_at: new Date().toISOString(), ...ROW_DEFAULTS[this.table]?.(), ...structuredClone(input) };
        rows.push(row); return row;
      });
      if (!this.returning) return { data: null, error: null };
    } else {
      affected = rows.filter((row) => this.filters.every((test) => test(row)));
      if (this.mode === "update") affected.forEach((row) => Object.assign(row, structuredClone(this.payload)));
      if (this.mode === "update" && !this.returning) return { data: null, error: null };
    }
    for (const [column, ascending] of [...this.orders].reverse()) affected = [...affected].sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
    if (this.max !== null) affected = affected.slice(0, this.max);
    const data = affected.map((row) => project(this.tables, this.table, row, this.columns));
    if (this.maybe && data.length === 0) return { data: null, error: null };
    if (this.one) return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: `expected exactly one ${this.table} row, found ${data.length}` } };
    return { data, error: null };
  }
  then(resolve, reject) { try { resolve(this.run()); } catch (error) { reject(error); } }
}

export function createInMemoryDatabase(tables) {
  return {
    tables,
    from: (table) => new Query(tables, table),
    storage: { from: () => ({ createSignedUrl: async (path) => ({ data: { signedUrl: `/demo-media/placeholder.svg?photo=${encodeURIComponent(path)}` }, error: null }) }) },
  };
}
