// The committed, fully fictional meeting profile, so the meeting capability is
// testable and runnable from a fresh clone (HEARTH_DATASET=meeting-example).
// A real meeting's profile is never committed: it lives in
// .hearth-local/meeting-profile.json and only `npm run build:meeting` reads it.
import profile from "../fixtures/meeting-profile.example.json" with { type: "json" };
import { scenarioFromProfile } from "./meeting-scenario.mjs";

const scenario = scenarioFromProfile(profile);
export const meta = scenario.meta;
export const build = scenario.build;
