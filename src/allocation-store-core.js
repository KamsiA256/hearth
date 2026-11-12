// The allocation store's shared behaviour, with no storage attached.
//
// Imports nothing from Node, because this file goes into the offline browser bundle.
// The two wrappers — allocation-store.js (a local JSON file) and
// allocation-store-memory.js (in the page) — supply persistence and nothing else.
//
// Keyed by property and billing period. Nothing here is a payment record: provider
// invoice IDs stay in the payment store, which has different durability rules.

export const keyFor = ({ propertyId, periodKey }) => `${propertyId}:${periodKey}`;

export function emptyEntry(identity) {
  return { ...identity, versions: [], confirmations: {}, approval: null, history: [], createdAt: new Date().toISOString() };
}

export function operations(data, persist) {
  return {
    get(identity) { return data.entries[keyFor(identity)] || null; },

    all() { return Object.values(data.entries); },

    /** Replace the version list head, or append a new version. */
    putVersion(identity, version, event) {
      const key = keyFor(identity);
      const entry = data.entries[key] || emptyEntry(identity);
      const versions = [...entry.versions];
      const last = versions[versions.length - 1];
      if (last && last.n === version.n) versions[versions.length - 1] = version;
      else {
        if (last) versions[versions.length - 1] = { ...last, state: last.state === "agreed" ? "agreed" : "superseded" };
        versions.push(version);
      }
      data.entries[key] = { ...entry, versions, history: [...entry.history, { at: new Date().toISOString(), ...event }], updatedAt: new Date().toISOString() };
      persist();
      return data.entries[key];
    },

    /**
     * Record one resident's confirmation, bound to the exact version canonical form.
     * Storing the canonical string rather than the version number is what makes a
     * confirmation impossible to carry onto different numbers.
     */
    putConfirmation(identity, { personId, versionCanonical, versionLabel }, event) {
      const key = keyFor(identity);
      const entry = data.entries[key] || emptyEntry(identity);
      data.entries[key] = {
        ...entry,
        confirmations: { ...entry.confirmations, [personId]: { versionCanonical, versionLabel, at: new Date().toISOString() } },
        history: [...entry.history, { at: new Date().toISOString(), ...event }],
        updatedAt: new Date().toISOString(),
      };
      persist();
      return data.entries[key];
    },

    putApproval(identity, approval, event) {
      const key = keyFor(identity);
      const entry = data.entries[key] || emptyEntry(identity);
      data.entries[key] = { ...entry, approval, history: [...entry.history, { at: new Date().toISOString(), ...event }], updatedAt: new Date().toISOString() };
      persist();
      return data.entries[key];
    },

    /** Drop everything for one property and period, so a walkthrough can restart. */
    clear(identity, event) {
      const key = keyFor(identity);
      const entry = data.entries[key];
      data.entries[key] = { ...emptyEntry(identity), history: [...(entry?.history || []), { at: new Date().toISOString(), ...event }] };
      persist();
      return data.entries[key];
    },

    __reset() { data.entries = {}; persist(); },
  };
}
