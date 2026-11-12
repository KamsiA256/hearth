// The allocation store for OFFLINE mode: in the page, forgotten on reload.
//
// This is the honest difference between the modes. Offline mode runs in a browser
// with no server and no file, so a draft lives until the tab reloads. It is NOT a
// different allocation implementation: versions, confirmations, blocking and the
// status line all come from allocation-state.js, the same module server mode uses.
import { operations } from "./allocation-store-core.js";

export { keyFor } from "./allocation-store-core.js";

export function createMemoryAllocationStore() {
  const data = { version: 1, entries: {} };
  return { location: null, ...operations(data, () => {}) };
}
