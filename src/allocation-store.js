// Where allocation drafts, confirmations and approvals live between restarts, in
// server mode: a local JSON file beside the payment store.
//
// Offline mode cannot use a file and does not pretend to — see
// allocation-store-memory.js. What both modes DO share exactly is how an allocation
// is computed and blocked (allocation-state.js), which is the part that was
// previously duplicated and could disagree with itself.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { operations } from "./allocation-store-core.js";

export { keyFor } from "./allocation-store-core.js";

export function createAllocationStore({ file } = {}) {

  const location = file || path.join(process.cwd(), ".hearth-local", "allocation-store.json");
  const data = { version: 1, entries: {} };

  if (existsSync(location)) {
    try {
      const parsed = JSON.parse(readFileSync(location, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.entries) data.entries = parsed.entries;
    } catch (error) {
      throw new Error(`allocation store at ${location} is unreadable (${error.message}). Move it aside deliberately rather than letting Hearth overwrite it.`);
    }
  }

  const persist = () => {
    mkdirSync(path.dirname(location), { recursive: true });
    const temporary = `${location}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(temporary, location);
  };

  return { location, ...operations(data, persist) };
}
