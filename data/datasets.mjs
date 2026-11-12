// The dataset registry.
//
// One running demo serves ONE scenario, chosen here at module load from
// HEARTH_DATASET and defaulting to Willow Court. Deliberately not switchable per
// request: the operator's organization scope is computed once at load
// (server/_shared/db.mjs), and the payment store is keyed by property id, so
// swapping datasets mid-process would change the scoping set under in-flight
// requests. Two scenarios means two processes on two ports, which is also how the
// offline and sandbox modes already run side by side.
import * as willowCourt from "./willow-court.mjs";
import * as meetingExample from "./meeting-example.mjs";
import * as collegeAveTwelve from "./college-ave-twelve.mjs";
import * as collegeAveTwelveReviewed from "./college-ave-twelve-reviewed.mjs";

export const DATASETS = {
  "willow-court": willowCourt,
  "meeting-example": meetingExample,
  // The same household at two points in its month, and the difference is the point:
  // -twelve has nothing divided yet, which is the slate a live demonstration of the
  // drafting needs; -reviewed has the split agreed and confirmed, which is what a
  // static build has to show because it can reach neither a model nor a provider.
  "college-ave-twelve": collegeAveTwelve,
  "college-ave-twelve-reviewed": collegeAveTwelveReviewed,
};

export const DEFAULT_DATASET = "willow-court";

/**
 * Resolve the active dataset. An unknown name is an error rather than a silent
 * fallback: starting the meeting demonstration and getting Willow Court because of a
 * typo is exactly the failure that would be noticed on stage and nowhere earlier.
 */
// Where the dataset name comes from, in the two hosts this code runs in.
//
// In the offline browser bundle there is no `process`, so esbuild compiles the
// choice in as __HEARTH_DATASET__. That has to be checked FIRST: an earlier version
// guarded the whole lookup with `typeof process === "undefined"`, which meant the
// browser took the undefined branch and silently loaded the default scenario while
// the build log cheerfully reported the other one.
const fromEnvironment = () => {
  if (typeof __HEARTH_DATASET__ !== "undefined" && __HEARTH_DATASET__) return __HEARTH_DATASET__;
  if (typeof process !== "undefined" && process.env) return process.env.HEARTH_DATASET;
  return undefined;
};

export function resolveDataset(name = fromEnvironment()) {
  const id = String(name || DEFAULT_DATASET).trim();
  const dataset = DATASETS[id];
  if (!dataset) {
    throw new Error(
      `HEARTH_DATASET="${id}" is not a dataset. Available: ${Object.keys(DATASETS).join(", ")}. ` +
      `Leave it unset for ${DEFAULT_DATASET}.`,
    );
  }
  return { id, ...dataset };
}
