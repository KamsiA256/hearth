# Known gaps

Defects we know about and have not fixed. Each has a `todo`-marked test in
`tests/known-gaps.test.js` that asserts the current, wrong behaviour, so the gap is
recorded in code rather than in memory. Those tests are reported as `todo`, never as
passing coverage.

A gap stays here until it is fixed, at which point its test fails and both the test
and the entry get deleted.

---

## GAP 1 — reversed water phrasing escapes life-safety classification

**Where:** `server/_shared/safety.mjs`, the life-safety patterns.

**What happens:** the patterns match `burst pipe` and `water pouring`. A message
phrased the other way round is not classified at all, so it is not escalated:

| Message | Classified |
|---|---|
| "a burst pipe is flooding the kitchen" | tier 3 |
| "water pouring through the ceiling" | tier 3 |
| **"a pipe burst and water is pouring in"** | **not classified** |
| **"water is gushing out of the pipe"** | **not classified** |

**Why it matters:** the second phrasing is at least as natural as the first. A
resident reporting a flood in their own words can land in the ordinary queue.

**Wider than first recorded (observed 2026-11-09).** The cause is not word order,
it is adjacency: the pattern is `water (?:pouring|gushing)` and needs those two
words touching. Any word between them defeats it, including the most ordinary one:

| Message | Classified |
|---|---|
| "water pouring through the ceiling" | tier 3 |
| **"water is pouring through the ceiling"** | **not classified** |
| **"there is water coming through the ceiling"** | **not classified** |

Verified by calling `classifyHardSafety()` directly against the current module.
Recorded only — still not scheduled, for the reason below.

**Why it is not fixed here:** this code is carried over from the Hearth pilot
unchanged. Widening a safety pattern changes product behaviour in the pilot as well
as in this demo, and safety routing is not something to adjust as a side effect of
copying a file. It is a deliberate decision for the owner to take, with the pilot's
own tests in view.

**Found:** 2026-11-02, while writing the copied code's tests.

**Status:** recorded, not scheduled. Out of scope for the sandbox-invoicing milestone.

## Before this repository is made public

Recorded 2026-11-04 and updated 2026-11-12. None of these is a problem while the
repository stays private; each is a problem the moment it does not.

**Pilot identifiers.** The documentation no longer names the pilot counterparty or
carries the pilot's branch names and commit hashes: `docs/REUSE.md` and
`docs/DECISIONS.md` were generalised, and the internal documents that named it were
removed on 2026-11-12. They are still in this repository's git history, so publish
a copy with fresh history rather than flipping this repository to public.

`tests/fixture.test.js` keeps the terms out of the demo fixtures by checking SHA-256
hashes of them, so the test no longer names them either.

**Also before publishing:** reconcile README and decision-log claims against
evidence, test clean setup from a fresh clone, and review licence and data contents.
