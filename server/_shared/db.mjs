// The demo database. It holds fictional rows in memory, makes no network call and
// forgets everything when the process exits or the page reloads.
//
// In the pilot this module is a real database client, and the demo swapped it out at
// load time. Here there is no real client to swap: this IS the implementation, so a
// reader can see in one file that nothing reaches a database.
//
// Note what this does NOT cover: payment records. Sandbox invoice IDs and their
// outcomes live in the payment store, which persists on disk on purpose. Resetting
// this fictional data must never make Hearth forget an invoice that really exists at
// the payment provider.
import { createInMemoryDatabase } from "../../data/in-memory-db.mjs";
import { resolveDataset } from "../../data/datasets.mjs";

// Which scenario this process serves. Chosen once, here, from HEARTH_DATASET — see
// data/datasets.mjs for why it is not switchable per request.
const dataset = resolveDataset();
const { build, meta } = dataset;

export const datasetId = dataset.id;
export const demoMeta = meta;
export const demoOrganizationIds = build().organizations.map((organization) => organization.id);

let singleton = createInMemoryDatabase(build());
export function db() { return singleton; }
export function resetDemoData() { singleton = createInMemoryDatabase(build()); }
// Tests only: serve an explicit in-memory table set (e.g. two fictional organizations).
export function useDemoTables(tables) { singleton = createInMemoryDatabase(tables); }

export function must(result, label = "database operation") {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

export async function audit(organizationId, action, entityType, entityId, metadata = {}, actor = "Demo operator") {
  const { error } = await db().from("audit_events").insert({ organization_id: organizationId, actor, action, entity_type: entityType, entity_id: String(entityId), metadata });
  if (error) throw new Error(`audit event: ${error.message}`);
}
