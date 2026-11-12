// Builds dist/reviewer/: a static, offline-only copy of the app for outside reviewers.
//
// What makes it safe to hand out:
//   - The page is hard-wired to offline mode (data-hearth-mode="offline"), so every
//     API call is answered inside the page. There is no server, no payment provider
//     and no messaging provider; a plain static file server is enough.
//   - Only the fully fictional Willow Court dataset is bundled (checked below).
//
// --college-ave builds dist/college-ave/ instead: the same offline page serving ONLY
// the twelve-person College Ave household, with its split already agreed and
// confirmed (data/college-ave-twelve-reviewed.mjs). This is the build to hand to
// someone outside the project who should see the whole product in one sitting. Note
// what it cannot show, because there is no server behind it: a live model call, an
// AI basis line, or a real invoice. Those exist only in server mode.
//
// --meeting builds dist/meeting/ instead: the same offline page, but serving ONLY
// the meeting scenario made from a local, gitignored profile
// (.hearth-local/meeting-profile.json, or HEARTH_MEETING_PROFILE). The profile is
// validated by data/meeting-scenario.mjs and inlined as data; Willow Court is not
// bundled. The output is for a private, in-person meeting: it is never committed
// and never deployed.
//   - A banner that cannot be dismissed says OFFLINE REVIEW DEMO.
//   - It opens on Rent.
//
// This is NOT a deployment of public/. public/ needs scripts/demo-server.mjs.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateMeetingProfile } from "../data/meeting-scenario.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const MEETING = process.argv.includes("--meeting");
const COLLEGE = process.argv.includes("--college-ave");
if (MEETING && COLLEGE) {
  console.error("Pass at most one of --meeting and --college-ave: one build serves one scenario.");
  process.exit(1);
}

// What each build is, in one place, so adding a scenario is one entry rather than a
// dozen ternaries spread down this file. `forbidden` is the scenario text the finished
// bundle must NOT contain: the check at the bottom is what makes "only this scenario
// is bundled" a fact about the output rather than an intention.
const VARIANT = MEETING
  ? {
      dir: "meeting", dataset: "meeting-demo", registry: "meeting-registry",
      title: "Hearth · meeting demonstration", marker: "MEETING DEMONSTRATION",
      banner: "MEETING DEMONSTRATION · fictional household · illustrative amounts · payments are simulated: nothing is sent or paid · runs entirely in this page · reloading resets it",
      // Shows the full disclaimer on screen rather than in a tooltip — "not this
      // property's rent … nobody at this address uses Hearth".
      keepDatasetNotice: true,
      forbidden: ["Willow Court", "wc-3a", "p-3a-devi"],
      describe: "meeting demonstration from the local profile",
    }
  : COLLEGE
  ? {
      dir: "college-ave", dataset: "college-ave-twelve-reviewed", registry: "college-registry",
      title: "Hearth · offline review demo", marker: "OFFLINE REVIEW DEMO",
      banner: "OFFLINE REVIEW DEMO · real street address, invented household · the agreed split is fictional, not a model's output · no payment, message or account is real · runs entirely in this page · reloading resets it",
      // Kept on screen for the same reason as the meeting build: this is the one
      // scenario that uses a real street address, so its disclaimer is not a tooltip.
      keepDatasetNotice: true,
      forbidden: ["Willow Court", "wc-3a", "p-3a-devi", "meeting-demo", "Example Lane"],
      describe: "offline review demo, the twelve-person College Ave household only",
    }
  : {
      dir: "reviewer", dataset: "willow-court", registry: "willow-registry",
      title: "Hearth · offline review demo", marker: "OFFLINE REVIEW DEMO",
      banner: "OFFLINE REVIEW DEMO · fictional data · runs entirely in this page · no payment, message or account is real · reloading resets it",
      keepDatasetNotice: false,
      forbidden: ["meeting-demo", "Example Lane"],
      describe: "offline review demo, Willow Court only",
    };

let meetingProfile = null;
if (MEETING) {
  const file = path.resolve(process.env.HEARTH_MEETING_PROFILE || path.join(root, ".hearth-local", "meeting-profile.json"));
  if (!existsSync(file)) {
    console.error(`No meeting profile at ${path.relative(root, file)}.\nCopy fixtures/meeting-profile.example.json to .hearth-local/meeting-profile.json (gitignored) and edit it.`);
    process.exit(1);
  }
  meetingProfile = JSON.parse(readFileSync(file, "utf8"));
  validateMeetingProfile(meetingProfile); // throws with the reason if refused
}
// REVIEWER_OUT lets the test suite build into a temporary directory.
const out = process.env.REVIEWER_OUT ? path.resolve(process.env.REVIEWER_OUT) : path.join(root, "dist", VARIANT.dir);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Copy the interface, but not the default offline bundle (rebuilt below).
for (const name of readdirSync(path.join(root, "public"))) {
  if (name === "offline-runtime.js") continue;
  cpSync(path.join(root, "public", name), path.join(out, name), { recursive: true });
}

const shim = (name) => path.join(root, "scripts", "reviewer-shims", name);
const withoutRealListing = {
  name: "willow-only",
  setup(b) {
    // Node built-ins the payment modules import, replaced by page-memory shims.
    b.onResolve({ filter: /^node:(crypto|fs|path)$/ }, (args) => ({ path: shim(`${args.path.slice(5)}.mjs`) }));
    // A one-scenario registry: no other scenario is even named. In the reviewer
    // build that is Willow Court; in the meeting build it is the meeting profile,
    // inlined as data (not imported by path, so no local path reaches the bundle).
    b.onResolve({ filter: /datasets\.mjs$/ }, () => ({ path: VARIANT.registry, namespace: "stub" }));
    b.onResolve({ filter: /meeting-example\.mjs$/ }, () => ({ path: "unused-stub", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: args.path === "willow-registry"
        ? `import * as willowCourt from "./data/willow-court.mjs";
export const DATASETS = { "willow-court": willowCourt };
export const DEFAULT_DATASET = "willow-court";
export function resolveDataset() { return { id: "willow-court", ...willowCourt }; }`
        : args.path === "college-registry"
        ? `import * as collegeAve from "./data/college-ave-twelve-reviewed.mjs";
export const DATASETS = { "college-ave-twelve-reviewed": collegeAve };
export const DEFAULT_DATASET = "college-ave-twelve-reviewed";
export function resolveDataset() { return { id: "college-ave-twelve-reviewed", ...collegeAve }; }`
        : args.path === "meeting-registry"
        ? `import { scenarioFromProfile } from "./data/meeting-scenario.mjs";
const meeting = scenarioFromProfile(${JSON.stringify(meetingProfile)});
export const DATASETS = { "meeting-demo": meeting };
export const DEFAULT_DATASET = "meeting-demo";
export function resolveDataset() { return { id: "meeting-demo", ...meeting }; }`
        : "export const meta = {}; export function build() { throw new Error('Not in this build.'); }",
      loader: "js",
      resolveDir: root,
    }));
  },
};

// One classic script, no modules and relative paths only, so the folder opens by
// double-clicking index.html (file://) as well as from any static server. The
// page's offline runtime import is pointed at the reviewer entry and inlined.
const reviewerRuntime = {
  name: "reviewer-runtime",
  setup(b) {
    b.onResolve({ filter: /offline-runtime\.js$/ }, () => ({ path: path.join(root, "scripts", "reviewer-entry.mjs") }));
  },
};
await build({
  entryPoints: [path.join(root, "public", "app.js")],
  outfile: path.join(out, "app.js"),
  // Module path comments are written relative to this directory. Pinned to the repo
  // root so a build started from anywhere else cannot embed a local path.
  absWorkingDir: root,
  bundle: true, format: "iife", platform: "browser", target: ["es2020"],
  sourcemap: false, legalComments: "none",
  define: { __HEARTH_DATASET__: JSON.stringify(VARIANT.dataset) },
  plugins: [reviewerRuntime, withoutRealListing],
});
rmSync(path.join(out, "model.js"), { force: true });
// The fictional photo placeholder is referenced by an absolute path in the data
// layer; under file:// that would point at the disk root.
writeFileSync(path.join(out, "app.js"), readFileSync(path.join(out, "app.js"), "utf8").replaceAll("`/demo-media/", "`demo-media/"));

const banner = `<div class="review-banner" role="note">${VARIANT.banner}</div>`;
// The Willow Court build hides the dataset notice, because its banner already says
// everything there is to say about fictional data. The builds whose disclaimer says
// more than that — the meeting profile, and College Ave with its real street address
// — keep the notice on screen rather than in a tooltip.
const style = `<style>.review-banner{position:sticky;top:0;z-index:50;background:#3b2a00;color:#fff3cf;font:600 13px/1.4 system-ui,sans-serif;padding:7px 14px;text-align:center;letter-spacing:.01em}${VARIANT.keepDatasetNotice ? "" : "#datasetNotice{display:none!important}"}</style>`;
let html = readFileSync(path.join(root, "public", "index.html"), "utf8");
html = html
  .replace('<html lang="en">', '<html lang="en" data-hearth-mode="offline" data-hearth-review="1">')
  .replace("<title>Hearth</title>", `<title>${VARIANT.title}</title>`)
  .replace("</head>", `${style}\n<script>if(!location.hash)location.replace("#rent")</script>\n</head>`)
  .replace("<body>", `<body>\n  ${banner}`)
  .replaceAll('href="/', 'href="')
  .replace('<script type="module" src="/app.js"></script>', '<script defer src="app.js"></script>');
if (/(href|src)="\//.test(html)) throw new Error("reviewer page still has an absolute path");
if (!html.includes('data-hearth-mode="offline"') || !html.includes(VARIANT.marker)) throw new Error("page was not marked offline");
writeFileSync(path.join(out, "index.html"), html);

// Refuse to produce a build that carries real-listing text or credential-shaped values.
const bundle = readFileSync(path.join(out, "app.js"), "utf8");
// Credential prefixes are assembled so this file is not itself flagged by check-secrets.sh.
// Each build carries exactly one scenario, so every other scenario's text is
// forbidden in the output — see VARIANT at the top of this file.
for (const forbidden of [...VARIANT.forbidden,"/Users/", "/home/", "/private/", "/Volumes/", "/var/folders/", ":\\Users\\", "paypal.com", "XMLHttpRequest", "sendBeacon", "WebSocket(", "EventSource", "/demo-media/", ["PAYPAL", "CLIENT", "SECRET="].join("_"), "sk-" + "ant-", "Bearer " + "ey"]) {
  if (bundle.toLowerCase().includes(forbidden.toLowerCase())) throw new Error(`reviewer bundle contains forbidden text: ${forbidden}`);
}
if (MEETING && !bundle.includes(JSON.stringify(meetingProfile.propertyLabel).slice(1, -1))) throw new Error("meeting bundle does not carry the profile's property label");
console.log(`Built ${path.relative(root, out) || out}/ — ${VARIANT.describe}. Open index.html directly, or serve the folder with any static server.`);
