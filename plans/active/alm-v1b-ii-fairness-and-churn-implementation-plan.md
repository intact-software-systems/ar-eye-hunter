# ALM V1b-ii: fairness under many tracks and churn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development with test-driven development:
> one implementer per task, the failing tests first, the controller reviews and commits, one commit
> per task, a three-seat final review with one fix wave before the close. Steps use checkbox
> (`- [ ]`) syntax for tracking. The tasks run in the order 1 → 2 → 3 → 4 → 5 → 6.

**Goal:** Deliver Release 7, V1b-ii (D189 to D193, `playground/alm/alm-v1b-ii-design-proposal.md`). The volatile
session ledger keeps an own pool and an inbound pool under its limits, so arrivals alone never refuse the session's
own sends: an own send is refused `capacity` only when the total has reached the limit and the own pool has reached
`AL_VOLATILE_SESSION_OWN_SHARE`, half of it. An inbound batch that delivers a buffered release runs the same track's
next release in the same batch, so a 64-message buffered track drains in 5 batches instead of 65 and a 255-message
one in 17 instead of outliving the 30 s default lifetime. Departed-sender state is bounded by count: at most 256
ordering snapshots per inbound admission store, 256 tracks in the browser's resync record and 4 096 receipt
aggregates on the WS server. The facade usage, the harness `stats`, the inbound `effect-drain` diagnostic and the
lane observation carry the new figures; three two-agent lane cells prove each mechanism end to end; the docs state
all of it.

**Architecture:** `ALVolatileSessionBudget` tags each counted entry with its pool, keeps two own counters beside the
totals and derives the inbound pool as the difference; `readReport` returns `own` and `inbound` beside `usage`, and
`overloaded` is the refusal of the smallest next own send. The work handler (`al-work-handler.ts`) asks a new
required `claimSuccessor` dependency for the successor of each claim that completed, while the batch holds fewer
than a page of claims; the inbound lane answers through `claimALInboundPromotedRelease`
(`inbound/lane/claim-al-inbound-promoted-release.ts`), which reads the track's next release row by its work key and
claims it only when it is due and its delivery reads it ready, as that read observed it; the outbound lane passes
`undefined`. The inbound admission store evicts the least recently updated ordering snapshots past
`AL_INBOUND_MAX_ORDERING_TRACKS` right after the commit that opened a new track, in its own guarded write over the
ordering-key prefix, and states the count it holds through an optional `reportOrderingTracks`; the browser wires that
reporter to the storage diagnostics port as an `ordering-tracks` event, and the black-box page sums the latest count
per store as `stats.rallar.alm.orderingTracks`. The browser resync record's `LatestRepository` gains `maxEntries`;
the WS server's receipt aggregates become a `LatestRepository` that ends its oldest aggregate `timed-out` at the cap.
The lane observation folds `maxInboundAdmissions`, `maxInboundBytes`, `maxOrderingTracks` and `promotedReleases`.

**Tech Stack:** TypeScript on Node (Vitest, Playwright, esbuild bundle budgets) and Deno (api-v1, the control
server: `deno test`, `deno check`); dprint.

**Spec:** `playground/alm/alm-v1b-ii-design-proposal.md`; decisions D189–D193 in
`playground/alm/alm-improvement-plan.md` (decision table and the "Release 7, V1b-ii design" section), as amended by
the rulings below; survey `.superpowers/sdd/v1b-ii-survey/facts.md`.

## Global constraints

- **The maintainer's notes stand: "no legacy, avoid duplication, no migration code, keep repo consistent, prefer
  existing patterns."** No wire or schema bump: the ordering cap reuses the admission backend's `list` and guarded
  `remove`, so `AL_ADMISSION_SCHEMA_ID` stays (R-V1b-ii-2).
- **The share rule (D189):** the volatile session ledger keeps `own` (the session's own volatile admissions,
  `tryAdmit`) and `inbound` (the arrivals it records, `record`) pools under the same four limits. Arrivals are
  recorded and never refused. The own share is `Math.floor(limit × AL_VOLATILE_SESSION_OWN_SHARE)` per limit, with
  `AL_VOLATILE_SESSION_OWN_SHARE = 0.5` (500 admissions and 2 MiB at the production limits; a one-admission bound
  keeps none, R-V1b-ii-9). An own send is refused `capacity` only when both hold, for the count
  `total + 1 > maxAdmissions && own + 1 > ownShare.admissions` and for the bytes
  `total + bytes > maxBytes && own + bytes > ownShare.bytes` (R-V1b-ii-10); own sends may use capacity the arrivals leave free, and the total may exceed the limit by up to the
  own share. `overloaded` is the refusal of the smallest next own send (count, or one byte). The age and track bounds
  are unchanged and own-only. The refusal keeps its four limit names and gains `own` (R-V1b-ii-7); `readReport`
  returns `{ usage, own, inbound, limits, overloaded }` with `own` and `inbound` required at the top level
  (R-V1b-ii-8).
- **The promotion invariants (D190, as amended by R-V1b-ii-16):** only a `release-buffered` claim that completed in
  the batch promotes (R-V1b-ii-18); its successor is the same track's next sequence, read by its work key
  (`toALInboundWorkKey(namespace, toALInboundReleaseEffectId(trackKey, seq + 1))`), claimed only when it is due and its
  delivery reads it ready, and only as that read observed it (an observed-entry compare-and-set), so a track never
  has two releases claimed at once; the batch never exceeds `AL_INBOUND_WORK_PAGE_SIZE` (16) claims; a claim that did
  not complete promotes nothing; no promotion crosses tracks; a throwing `claimSuccessor` is stated through
  `reportBatchFailure` and never strands the batch's unrun claims (R-V1b-ii-19). The inbound `effect-drain` diagnostic
  carries a required `promoted` count beside `deferred`.
- **The three bounds (D191, as amended by R-V1b-ii-1..6):** (1) every inbound admission store holds at most
  `AL_INBOUND_MAX_ORDERING_TRACKS = 256` ordering snapshots: a commit that opens a track past the cap evicts the least
  recently updated snapshots right after it, each removal guarded on the snapshot still being the one read, a
  conflict left to the next new track; the evicted track's next arrival reads as a fresh track's; its `delivered`
  marker stays (time-bounded, R-V1b-ii-3); (2) the browser resync record (`invokedTrackKeys`) has `maxEntries:
  AL_INBOUND_MAX_ORDERING_TRACKS` beside its 5-minute TTL, first remembered first evicted (R-V1b-ii-6); (3) the WS
  server's receipt aggregates are a `LatestRepository` (`ttlMs` 30 minutes, `maxEntries`
  `WS_QUEUE_BOX_SERVER_MAX_RECEIPT_AGGREGATES` = 4 096, `evictsPerWindow: 0`) whose oldest aggregate the aggregation
  ends itself at the cap with a `timed-out` receipt of the audience confirmed so far, as its deadline would
  (R-V1b-ii-5).
- **The metric and the proof (D192):** `stats.rallar.alm` is `RallarBlackBoxTestAlmUsage` = the ledger report plus a
  required `orderingTracks` (R-V1b-ii-21), the count pushed by the stores (R-V1b-ii-20); no facade method beyond
  `readUsage()`. The observation folds `maxInboundAdmissions`/`maxInboundBytes` (Task 1, R-V1b-ii-11),
  `maxOrderingTracks` and `promotedReleases` (Task 4, R-V1b-ii-23). Three cells under
  `conformance/alm/scenarios/fairness/` in the two-agent family, withheld from hosted manifests 18 and 22, which stay
  byte-identical.
- **D3:** no compatibility window. A changed contract changes everywhere in the same task: `claimSuccessor` is a
  required `T | undefined` dependency of every `ALWorkHandler` (R-V1b-ii-17); `createBrowserALVolatileInboundRuntimeStores`
  takes its storage sink at every caller in the task that adds it (R-V1b-ii-28); `effect-drain.promoted` and
  `stats.rallar.alm.orderingTracks` are required in their decoders (R-V1b-ii-21, R-V1b-ii-22). Optional only where
  absence means something: `reportOrderingTracks?` on the store inputs (no reporter wired).
- **D8 reuse first.** Search `packages/**` for an existing pattern before writing one; delete what becomes unused in
  the same task; **no raw Maps where `packages/shared/cache` repositories fit** (`LatestRepository` /
  `ObservableLatestRepository`): the receipt aggregates move from a `Map` to `LatestRepository`, the resync record
  keeps its `LatestRepository`, the harness ordering-track holder keeps an immutable record, not a `Map`. Every task
  carries a D8 reuse inspection paragraph and its commit one `D8 reuse:` line.
- **No ids in code, tests or docs:** no plan, task, PR or ruling id in code, tests or commit messages; decision ids
  (D189 …) only in docs and source doc comments; the docs name release slices as the repo's docs already do
  (`Owner: ALM V1b-ii` in the compatibility guide, as V1a and V1b-i).
- **No guarantee weakens.** The four pins (`al-indexeddb-transaction-ledger`, `al-indexeddb-operation-counts`,
  `al-storage-snapshot`, `al-indexeddb-empty-audience-counts`) keep their values (Task 2 adds only `claimSuccessor:
  undefined` to three constructions in `al-indexeddb-operation-counts.test.ts`); the public API snapshots are
  unchanged (`ALVolatileSessionPoolUsage` is not re-exported, R-V1b-ii-13); hosted manifests 18 and 22 stay
  byte-identical.
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical verbs; functions
  ≤40 lines; ≤3 positional parameters for a new function; `interface` for object contracts; required fields by
  default; `Either` for expected failure; kebab-case filenames after the primary export; no role folders; no narration
  comments; one canonical name per type. `packages/shared/alm/inbound/` (22 direct files) and
  `conformance/alm/scenarios/` gain no direct file: the promotion claim lives under `inbound/lane/`, the cells under
  `scenarios/fairness/`. `al-work-handler.ts` stays under cognitive load 50 (48: `claimSuccessors` returns an array).
  Tests live under `packages/tests/**` mirroring the source.
- **Formatting:** `npx dprint fmt <explicit file list>` on touched files only (pipe a list through `xargs`; zsh does
  not split `$(...)`); never a glob.
- **Per-task checks:** the focused Vitest files; `npx tsc -p
  packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit`; `deno check` from the repo root on
  every changed `packages/shared/**` file; `cd apps/api-v1 && deno task check` and the control server's when a type
  they consume changes (then remove `.deno` in the main worktree's `apps/*/node_modules`); `node
  scripts/check-tests-typecheck.mjs`; the four IndexedDB pins — a changed pin is a finding to report, not to re-pin
  silently; the bundle checks with a private `TMPDIR` (`mktemp -d /tmp/claude-501/b.XXXX`):
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` (facade budget 244, 243.1 KiB at the design
  head) and `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` (headless budget 310 at
  309.675 KiB until Task 3 raises it to 311, R-V1b-ii-15, R-V1b-ii-27); raise a crossed budget to the next whole KiB
  and say so; `shared-web-public-api-snapshots.test.ts` and `shared-web-browser-bundle-boundaries.test.ts` for a
  shared-web change; after the commit `npm run check:repo-style:changed -- 853bfd33b HEAD` (read the verdict line: the
  script exits 0 on FAIL), `node scripts/check-test-structure-coupling.mjs --changed 853bfd33b HEAD`, and `npm run
  check:test-reachability` when a test file is added.
- **Sandbox notes.** Loopback binds fail (`listen EPERM`): name those suites as sandbox reds
  (`api-v1-rtc-rtt-recipe-semantics` 5, `api-v1-state-write-convergence-recipe` 4, `local-websocket-session` 1,
  `live-rtc-control-client` 13, `headless-worker-script` 2); pglite and CLI-subprocess 5 s timeouts under load pass
  alone; `npx tsx` fails on its IPC pipe (use `node --import tsx`); `git fetch`, `gh` and the Playwright lane need the
  sandbox off. Deno runs from any worktree rewire the shared `apps/*/node_modules` into `.deno`: remove `.deno` after
  a Deno run, only when no other Deno suite runs. Use the session scratchpad or `mktemp`, never a fixed name under
  `$TMPDIR`. Do not run `npm run test:unit` per task.
- **Git.** One commit per task with one `D8 reuse:` line and no attribution lines; the controller commits and pushes
  after review; never `git stash`; never touch `main`; the PR body is written at the close.
- **Task order:** 1 → 2 → 3 → 4 → 5 → 6.

## File structure

| Area                                   | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger pools, usage, facade proofs (1) | `packages/shared/alm/volatile-budget/al-volatile-session-budget.ts`; `packages/shared/alm/outbound/lane/admit-al-outbound-volatile-budget.ts`; `packages/shared-test/rallar-bb-test/alm/decode-al-volatile-session-report.ts`; `packages/shared-test/rallar-bb-test/conformance/alm/{alm-observation-snapshot,compute-alm-observation-regime}.ts`; nine edited test files and fixtures (14 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Promotion (2)                          | `packages/shared/alm/work/al-work-handler.ts`; `packages/shared/alm/inbound/{al-inbound-effect-intent,al-inbound-runtime-diagnostics,read-al-inbound-work-selection}.ts`; `packages/shared/alm/inbound/lane/{claim-al-inbound-promoted-release (new),al-inbound-store-lane}.ts`; `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`; `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`; two new and five edited test files (15 files)                                                                                                                                                                                                                                                                                                                                                                                                          |
| Count bounds (3)                       | `packages/shared/alm/inbound/al-inbound-admission-store.ts`; `packages/shared-web/browser/messages/browser-resync-recovery.ts`; `packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts`; `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`; one new and two edited test files (7 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Count report, harness, cells (4)       | `al-inbound-admission-store.ts`, `packages/shared/alm/{al-runtime-stores,storage/al-storage-event}.ts`; `packages/shared-web/browser/{al-runtime/browser-al-runtime-stores,connection/initialise-browser-middleware}.ts`; the black-box runtime's `black-box-rallar-ordering-tracks.ts` (new), composition, diagnostics, close and connection operations, runtime contract; `rallar-bb-test/alm/decode-rallar-black-box-test-alm-usage.ts` (new), the contracts and both test runtimes; the observation snapshot and fold; `scenarios/fairness/{to-send-loop-command,own-share-under-inbound,buffered-track-drains,churn-bounded-tracks}.ts` (new) and the recipe registry, scenario ids, message commands, volatile-bound and congestion commands; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`; one new and 19 edited test files and fixtures (47 files) |
| Docs (5)                               | `docs/rallar-api-reference.md`; `packages/shared/alm/{inbound,outbound}/README.md`; `packages/shared-web/browser/README.md`; `packages/shared-test/rallar-bb-test/docs/{runtime-diagnostic-contract,schema-and-capabilities,alm-observation-artifact,schema-compatibility-guide}.md`; `playground/alm/alm-complete-product-description.md` (9 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Close (6)                              | the pins, the gates, the Postgres run, the lane run, the review, the PR body, the roadmap's delivered line and as-applied notes, the audit's F5 row, the requirement matrix's PC8 row, this file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Task order

1 (the ledger's pools, the widened report, the stats decoder and the inbound fold) → 2 (promotion in the work handler
and the inbound lane, `effect-drain.promoted`) → 3 (the three count bounds; the headless budget to 311) → 4 (the
ordering-snapshot count, `stats.rallar.alm.orderingTracks`, the folds `maxOrderingTracks` and `promotedReleases`, the
three fairness cells) → 5 (docs) → 6 (close). Tasks 1, 2 and 3 touch pairwise disjoint files. Task 4 consumes Task 1's
pools, report decoder and `maxInbound*` fold, Task 2's required `effect-drain.promoted`, and Task 3's
`AL_INBOUND_MAX_ORDERING_TRACKS`, `evictOrderingTracksPastCap` and `toOrderingPrefix`; Task 5 states what Tasks 1–4
built and is checked against them.

The composed commits (scratch tree `scratch/v1b-ii-assemble`, each `git am -3`-able on its predecessor from the design
head `853bfd33b`): `final-patch-task-1.patch` … `final-patch-task-5.patch` under `.superpowers/sdd/v1b-ii-plan/` —
`d6452160a`, `4a0f6f41c`, `778b9e526`, `7fc45171c`, `d05df6bac`. Tasks 1, 2 and 5 are tree-identical to the writers'
prototypes applied in order (`77f938541`; `7cb01a997` = `92d416fed` on Task 1; `c918502fd`); Task 3 is `475da1fbf`
plus the headless budget raise and Task 4 is `cf3350d29` without it (R-V1b-ii-27); Task 2's message carries corrected
timings (R-V1b-ii-29). Files touched by two tasks: `al-inbound-admission-store.ts` and
`al-inbound-ordering-track-cap.test.ts` (Tasks 3, 4: Task 4 keeps Task 3's eviction and makes it return the count
held); `browser-web-socket-buffered-track.test.ts` (Tasks 2, 4: Task 4 passes the new storage sink, R-V1b-ii-28);
`alm-observation-snapshot.ts`, `compute-alm-observation-regime.ts`, `alm-observation-ledger.test.ts`,
`rallar-bb-runtime/stats.test.ts`, `read-alm-usage.test.ts`, `browser-runtime-facade-test-double.ts` and
`create-browser-web-socket-queue-box.test.ts` (Tasks 1, 4); `runtime-diagnostic-contract.md` (Tasks 2, 5). Each
task's anchors are at its own parent commit.

## Rulings

| id                     | ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                      | _Cost if wrong_                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R-V1b-ii-1             | Ordering-snapshot eviction runs right after the admission commit in its own guarded write; between the two writes the store may hold 257; a conflicted eviction waits for the next new track. In-transaction eviction fences all 256 rows and measured ≈1.5× slower (fake-indexeddb, 256 new tracks: base ≈1.0 s, post-commit ≈3.4 s, in-transaction ≈5.0 s).                                                                                               | _Cost if wrong:_ moving the eviction into the bundle's transaction — one method and the fence, about half a task.                                      |
| R-V1b-ii-2             | The oldest snapshots are found by the ordering-key prefix (`${namespace}:ordering:`, a primary-key range of at most 257 rows, sorted by `updatedAtMs` then key), not the store-wide `expireAtTimestamp` index; no schema bump.                                                                                                                                                                                                                              | _Cost if wrong:_ an index read the backend interface lacks today — a backend method on two backends.                                                   |
| R-V1b-ii-3             | The cap bounds ordering snapshots only; the per-track `delivered` row stays time-bounded (one hour) because `ALInboundOrderedDelivery.complete` needs it while buffered rows live — carried to V1d; the docs say "ordering snapshots", never "per-track state"; D191 "As applied" at the close.                                                                                                                                                             | _Cost if wrong:_ V1d's growth read finds the delivered rows; bounding them needs a delivery-side guard.                                                |
| R-V1b-ii-4             | `storage.counters` counts IndexedDB operations, not rows, so the churn cell's witness is `stats.rallar.alm.orderingTracks`; no facade method (`readUsage()` stays the ledger's); the count is also V1d's receiver-side growth witness (amended by R-V1b-ii-20: pushed, not read).                                                                                                                                                                           | _Cost if wrong:_ one harness read and one stats field to remove.                                                                                       |
| R-V1b-ii-5             | The receipt aggregation keeps `ttlMs` + `maxEntries` with `evictsPerWindow: 0` and evicts the oldest aggregate itself at the cap (answering it as a passed deadline); no eviction callback on `LatestRepository`.                                                                                                                                                                                                                                           | _Cost if wrong:_ an eviction callback on the shared cache instead — a `packages/shared/cache` change and its tests.                                    |
| R-V1b-ii-6             | The resync set reuses `AL_INBOUND_MAX_ORDERING_TRACKS`; its insertion-order eviction (a re-accepted key keeps its place) is a Limit.                                                                                                                                                                                                                                                                                                                        | _Cost if wrong:_ a recency-ordered set later — a `LatestRepository` option or a delete-then-accept.                                                    |
| R-V1b-ii-7             | The four refusal limit names stay; only the own pool is ever refused; the `capacity` refusal gains `own` (the pool figures) and its drop reason states the own pool and the share.                                                                                                                                                                                                                                                                          | _Cost if wrong:_ a later rename touches the public `limit` union, the harness failure decoder, the `capacity*` cells and the docs.                     |
| R-V1b-ii-8             | `own` and `inbound` sit at the top level of `ALVolatileSessionReport` beside `usage` (which keeps its four totals); `tryAdmit`/`record` still return `ALVolatileSessionUsage`.                                                                                                                                                                                                                                                                              | _Cost if wrong:_ moving them under `usage` re-touches the decoder, the observation reading, the cells' paths and the docs.                             |
| R-V1b-ii-9             | The share is rounded down at construction (`Math.floor(limit × 0.5)`), so a one-admission bound keeps no own share.                                                                                                                                                                                                                                                                                                                                         | _Cost if wrong:_ rounding up flips five one-admission overload fixtures to `maxAdmissions: 2`.                                                         |
| R-V1b-ii-10            | Refusal when `total + 1 > max && own + 1 > share` for the count and `total + bytes > maxBytes && own + bytes > shareBytes` for the bytes; `overloaded` = the smallest next own send would be refused.                                                                                                                                                                                                                                                       | _Cost if wrong:_ an off-by-one in a lowered byte limit a cell computes from the share.                                                                 |
| R-V1b-ii-11            | Task 1 owns the observation fold's `maxInboundAdmissions`/`maxInboundBytes`; Task 4 adds `promotedReleases` and `maxOrderingTracks`; Task 5 the docs.                                                                                                                                                                                                                                                                                                       | _Cost if wrong:_ a fold split across two commits — none at composition (no conflict arose).                                                            |
| R-V1b-ii-12            | The facade proof runs on the real browser WS client (`createBrowserWebSocketQueueBox`, `maxAdmissions: 4`) plus the real outbound runtime at production limits, not through `rallar.messages.room().send`.                                                                                                                                                                                                                                                  | _Cost if wrong:_ a facade fixture with a real WS carrier (about the V1b-i congestion fixture).                                                         |
| R-V1b-ii-13            | `ALVolatileSessionPoolUsage` is not re-exported from the shared-web entries (reachable as `ALVolatileSessionReport['own']`); the public API snapshots are unchanged.                                                                                                                                                                                                                                                                                        | _Cost if wrong:_ one more name in three snapshots later.                                                                                               |
| R-V1b-ii-14            | Task 4 measures before recomputing the `capacity*` limits: a send-only ledger behaves as before (the `capacity` cell still refuses its third send); only a cell whose refusal depended on inbound filling the pool needs new limits.                                                                                                                                                                                                                        | _Cost if wrong:_ none if measured; a needless limit change otherwise.                                                                                  |
| R-V1b-ii-15            | The first composed task that crosses the headless budget raises it to 311 (the facade to 245 likewise).                                                                                                                                                                                                                                                                                                                                                     | _Cost if wrong:_ a red `headless-bundle-boundary` at composition.                                                                                      |
| R-V1b-ii-16            | Promotion reads the successor row by key (`readEntry(toALInboundWorkKey(ns, release:T:k+1))`), reserved only after k completed in the same batch, only when due and read ready, through an observed-entry compare-and-set — not from the page's deferred rows (page-bound promotion measured 8 batches for 64 and 48 for 255). Order and the page bound unchanged; amends the frame and D190's wording; D190 "As applied" at the close.                     | _Cost if wrong:_ one `readEntry` per completed release; the page-bound form is the fallback (two files).                                               |
| R-V1b-ii-17            | `claimSuccessor` is a required `T \| undefined` field of the work handler's dependencies (like `diagnostics`); the outbound lane and the test constructions pass `undefined`.                                                                                                                                                                                                                                                                               | _Cost if wrong:_ an optional field instead — 36 test lines removed.                                                                                    |
| R-V1b-ii-18            | Only a completed `release-buffered` promotes (seq 1's own `dispatch-local` does not): 5 batches for 64, 17 for 255.                                                                                                                                                                                                                                                                                                                                         | _Cost if wrong:_ one batch per track; widening the decode to `dispatch-local` is one condition.                                                        |
| R-V1b-ii-19            | A throwing `claimSuccessor` is reported through `reportBatchFailure` and promotes nothing, never stranding the batch's unrun claims.                                                                                                                                                                                                                                                                                                                        | _Cost if wrong:_ a batch that fails as a whole on a promotion read — the claims would wait for their leases.                                           |
| R-V1b-ii-20            | The ordering-snapshot count is pushed by the inbound admission store after its eviction pass (optional `reportOrderingTracks`; the browser wires it to the storage port as an `ordering-tracks` storage event, the memory pair as `<store id>/volatile`; the harness keeps the latest count per store, resets at close; `readAlmUsage` sums it as `orderingTracks`); no facade method; the page cannot pull the in-memory pair. Amends R-V1b-ii-4's "read". | _Cost if wrong:_ a store-port count method and a registry read that misses the volatile pair.                                                          |
| R-V1b-ii-21            | `orderingTracks` is a required field of `stats.rallar.alm` (`RallarBlackBoxTestAlmUsage extends ALVolatileSessionReport`); the compatibility guide says a pre-change stats answer decodes as no reading.                                                                                                                                                                                                                                                    | _Cost if wrong:_ an optional field and a defaulting decoder.                                                                                           |
| R-V1b-ii-22            | `effect-drain.promoted` is required in the observation decoder (D3; `alm-observation-snapshot.ts` sits at load 49).                                                                                                                                                                                                                                                                                                                                         | _Cost if wrong:_ older artifacts stop decoding their inbound drains — none are read across versions.                                                   |
| R-V1b-ii-23            | `promotedReleases` sits on each measured inbound direction (both lanes summed); `maxOrderingTracks` on the ledger block.                                                                                                                                                                                                                                                                                                                                    | _Cost if wrong:_ a moved field in the observation and its doc.                                                                                         |
| R-V1b-ii-24            | `buffered-track-drains` uses 64 literal sends (a loop index counts from 0 and an outer loop fixes an inner's index) and a first-success digit loop on `"promoted":{loop.iteration}` (1..9), not a pinned 15.                                                                                                                                                                                                                                                | _Cost if wrong:_ a longer recipe; a loop-offset placeholder in the harness would shorten it.                                                           |
| R-V1b-ii-25            | `churn-bounded-tracks` runs on rtc only; the sender reconnects with `maxTracks: 600`; the fairness cells register right after the congestion cells ("after every cell registered before them").                                                                                                                                                                                                                                                             | _Cost if wrong:_ a ws/fallback run of the churn cell — one carrier list.                                                                               |
| R-V1b-ii-26            | The `capacity*` cells keep their limits (only `capacity.ts`'s comment changes); `capacity` is in manifest 18.                                                                                                                                                                                                                                                                                                                                               | _Cost if wrong:_ a lane red on a `capacity*` cell — recompute its lowered limits from the share.                                                       |
| R-V1b-ii-27 (assembly) | The headless budget rises 310 → 311 in Task 3, the first composed commit past 310 (Tasks 1, 2, 3 composed: 309.744, 309.886, 310.365 KiB); Task 4 (310.674 KiB) raises nothing and its message drops the sentence; Task 3's message gains "The headless agent budget rises to 311 KiB."; the facade stays 244 (243.4, 243.8, 243.8, 243.9 KiB).                                                                                                             | _Cost if wrong:_ a budget line in the other commit; nothing functional.                                                                                |
| R-V1b-ii-28 (assembly) | Task 4 keeps its edit of Task 2's `browser-web-socket-buffered-track.test.ts` (the third, storage-sink argument of `createBrowserALVolatileInboundRuntimeStores`): Task 4 adds that parameter, so the two-argument call is correct at Task 2's commit and D3 puts every caller in the task that changes the signature.                                                                                                                                      | _Cost if wrong:_ none; moving it would break Task 2's typecheck.                                                                                       |
| R-V1b-ii-29 (assembly) | Task 2's commit message states the measured 7.5 s in memory (was "7.3 s") and 0.7 s on IndexedDB (was "0.9 s"), the figures of the writer's report and Task 5's docs.                                                                                                                                                                                                                                                                                       | _Cost if wrong:_ a timing figure in one message.                                                                                                       |
| R-V1b-ii-30 (assembly) | At composition each task's focused files, red runs, typechecks, Deno checks, pins, bundles and gates ran on its own composed commit; the brief's broad sweep ran once at the final head, whose code tree is Task 4's (Task 5 is docs only), and stands in Task 4's wide step for the writer's wider set.                                                                                                                                                    | _Cost if wrong:_ an intermediate red invisible at Tasks 1–3 outside their focused and wider sets — the per-task SDD run reruns each task's own checks. |

## Limits (carried; Task 6 states them in the PR body)

- The per-track `delivered` row is time-bounded only (one hour after its last update): a churned track leaves one
  delivered marker behind for up to an hour after its snapshot is evicted (R-V1b-ii-3; carried to V1d).
- The resync record evicts in insertion order: a re-accepted key keeps its place (R-V1b-ii-6).
- Between an admission's commit and its eviction write the store may hold 257 snapshots; a conflicted eviction waits
  for the next new track (R-V1b-ii-1).
- The cap is per inbound admission store; a browser session holds two (the IndexedDB pair and the memory pair), so it
  may hold up to 512 snapshots, and `stats.rallar.alm.orderingTracks` is their sum.
- A gap fill's own dispatch does not promote: only a completed `release-buffered` runs its successor, so seq 1's
  batch releases nothing beyond itself (R-V1b-ii-18).
- The IndexedDB cost of promotion is pinned nowhere: the four pins exercise no buffered track (measured: 24 861 → 4 020
  IndexedDB operations for the 64-message track).
- The total may exceed a count or byte limit by up to the own share while arrivals hold it (1 500 entries / 6 MiB worst
  case at the production limits, plus arrivals, which were never refused): the limit is no ceiling on the total.
- `churn-bounded-tracks` runs on rtc only (R-V1b-ii-25); `buffered-track-drains` reads `promoted` over rtc only (over
  ws the relay buffers out of the page's sight).
- The fairness cells are local and the hosted full read's: hosted manifests 18 and 22 withhold all three and stay
  byte-identical (D192).
- Carried (design §5, D193): the outbound claim order stays sender-blind (measured: not a latency defect; a rotation
  needs a sender index the queue key cannot give without a schema bump); the browser page's retry cadence under
  backpressure (four to five deferrals per two-second hold against the runtime's 38–40); the per-message
  `resync-required` NACK after a buffered expiry; the frozen RTC audience of an in-flight send when a recipient
  departs; the silent `ordering-rejected` drop on a same-session, same-epoch seq restart; `replace-latest` and the
  bounded queue on the reliable lane; RTC unicast and unaddressed sends reading the congestion inputs; relay fanout
  reduction, alternate routes, server-side WS backpressure, per-hop routing around a backpressured peer and a
  per-peer backpressure metric (D188).

## Corrections and notes (Task 6 states them in the PR body's Corrections)

- **Design §4 (the roadmap and the product description):** the outbound README's "about 33 messages a second" was the
  measured inbound rate at which own sends are refused under the single pool (33/s partial, 34/s total); Task 5
  replaces it with the share rule and the measured figures. The product description's "fairness is V1b-ii's" becomes
  CURRENT for the own share, the promotion and the bounds and keeps the claim-order rotation, `replace-latest` and the
  bounded queue PLANNED, plus a bound on the delivered marker (Task 5). D188's carry list is unchanged.
- **Design §2.a and D189 "the `capacity` refusal's `limit` names the pool":** the four limit names stay and the
  refusal gains `own` (R-V1b-ii-7); "the `capacity*` cells' lowered limits are recomputed": measured, unchanged
  (R-V1b-ii-14, R-V1b-ii-26).
- **Design §2.b and D190 "the next contiguous release the page deferred":** the successor is read by its work key
  (R-V1b-ii-16); the design's target "at most 16 batches" for 255 messages is measured at 17 (one batch per
  sixteen-claim page after seq 1's own batch).
- **Design §2.c and D191 "IndexedDB evicts through the existing expiry index":** the eviction lists the ordering-key
  prefix (R-V1b-ii-2), after the commit (R-V1b-ii-1); "oldest-inserted evicted first" on the server: the aggregation
  takes its oldest itself at the cap (R-V1b-ii-5).
- **Design §2.d and D192 "the storage counters already count ordering rows, which the churn cell reads":**
  `storage.counters` counts IndexedDB operations; the witness is the pushed `stats.rallar.alm.orderingTracks`
  (R-V1b-ii-4, R-V1b-ii-20), and the cell asserts exactly 256 (`lte` and `gte`).
- **The base pinned the defect:** `al-outbound-volatile-budget.test.ts` "refuses the 1 001st volatile data admission"
  recorded 999 arrivals and expected the second own send refused — the single-pool refusal D189 removes; Task 1
  rewrites it into the production-limit proof (1 000 arrivals, 500 own admitted, the 501st refused).
- **`overloaded` is stricter:** arrivals alone no longer set it, so the RTC congestion producer (D78) no longer drops
  own sends while inbound fills the ledger; the old C13 test filled with `record` and now fills with `tryAdmit`.
- **Harness drift the writers fixed:** the browser WS composition test must start its `InboxOutboxEngine` or only the
  commit's own batch runs (Task 2's proof does); IndexedDB drains stall in `createInboundTestRuntime` under a fake
  `Date` at the base too (51/64, 244/300 after 50–60 rounds), so Task 2's proofs run on memory stores or real timers; a
  loop index counts from 0 and an outer loop fixes an inner's index, and a loop child's `handleId` gains a
  `{loop.index}` suffix (R-V1b-ii-24); the report decoder's `isCount` admits fractions (unchanged; the malformed-report
  test uses −2). Touched-file closure: `al-work-handler.test.ts` drops `logged: unknown[][]` and
  `alm-observation-regime.test.ts` drops an `as unknown`; the one-export `fairness-commands.ts` became
  `to-send-loop-command.ts`.
- **The docs are stale between Task 1 and Task 5** (`alm-observation-artifact.md`'s `ledgerReadings` shape,
  `schema-and-capabilities.md`'s `stats.rallar.alm` shape, the API reference); Task 5 owns every doc wording but
  Task 2's one sentence on `promoted` in `runtime-diagnostic-contract.md`.
- **The main worktree's `apps/*/node_modules`** are rewired into `.deno` by any Deno run from a worktree that shares
  them; removing `.deno` leaves `graphology`, `postgres` and `prisma` dangling until the next Deno run or `npm install`
  repairs them.

## Tasks

### Task 1: The ledger's own and inbound pools, the widened usage report and the facade proofs (D189, D192)

**Files** (anchors at the design head `853bfd33b`, this task's parent; the composed commit is
`.superpowers/sdd/v1b-ii-plan/final-patch-task-1.patch` (`d6452160a` on `scratch/v1b-ii-assemble`), `git am`-able on
`853bfd33b` and tree-identical to the writer's prototype `77f938541`; 14 files, +435/−101). Production:

- `packages/shared/alm/volatile-budget/al-volatile-session-budget.ts`: after `AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS`
  (`:15`): `/** The part of the count and byte limits kept for this session's own sends (D189): arrivals are never refused,
  so they refuse an own send only once the own pool also holds this share of the limit it passes. */ export const
  AL_VOLATILE_SESSION_OWN_SHARE = 0.5;`. Before `ALVolatileSessionReport` (`:42`): `/** One pool of the totals: this
  session's own admissions, or the arrivals it records (D189). */ export interface ALVolatileSessionPoolUsage { readonly
  admissions: number; readonly bytes: number; }`. `ALVolatileSessionReport` (`:43-47`) gains, after `usage`, `readonly own:
  ALVolatileSessionPoolUsage; readonly inbound: ALVolatileSessionPoolUsage;` (required); its doc becomes "`overloaded` is
  the count or byte bound refusing this session's next own send; the age and track bounds refuse a send without shedding
  others." `ALVolatileSessionBudget.Refusal` (`:59-63`) gains `readonly own: ALVolatileSessionPoolUsage;` after `usage`.
  `ALVolatileSessionLimit` keeps its four names (R: no pool names). File-private `type ALVolatileSessionPool = 'own' |
  'inbound';` before `ALVolatileSessionEntry` (`:66-70`), which gains `readonly pool: ALVolatileSessionPool;`. The class
  (`:76-191`): fields `private readonly ownShare: ALVolatileSessionPoolUsage;`, `private ownAdmissions = 0; private ownBytes
  = 0;`; the constructor sets `ownShare = { admissions: Math.floor(limits.maxAdmissions * AL_VOLATILE_SESSION_OWN_SHARE),
  bytes: Math.floor(limits.maxBytes * AL_VOLATILE_SESSION_OWN_SHARE) }`. `tryAdmit` (`:97-98`) holds with `'own'` and
  refuses with `{ limit, usage, own: this.toOwnUsage(), limits }`; `record` (`:102-108`) holds with `'inbound'`.
  `readReport` (`:110-118`) returns `{ usage, own, inbound: { admissions: usage.admissions - own.admissions, bytes:
  usage.bytes - own.bytes }, limits, overloaded: this.passesAdmissionBound(usage, own) ||
  this.passesByteBound(usage, own, 1) }`. `resolvePassedLimit` (`:127-132`): `const own = this.toOwnUsage();` then `passesAdmissionBound(usage, own)` →
  `'admissions'`, `passesByteBound(usage, own, input.bytes)` → `'bytes'`; age first, tracks last, unchanged. New private
  `/** One more own admission passes the count bound only past both the total limit and the own share (D189). */
  passesAdmissionBound(usage, own): boolean` = `usage.admissions + 1 > maxAdmissions && own.admissions + 1 >
  ownShare.admissions`; `passesByteBound(usage, own, bytes: number): boolean` = `usage.bytes + bytes > maxBytes &&
  own.bytes + bytes > ownShare.bytes`. `hold(input, pool: ALVolatileSessionPool)` (`:137-150`) builds the entry with its
  pool and calls `holdOwn(entry)`; `releaseDue` (`:157`) calls `releaseOwn(entry)`; `holdOwn`/`releaseOwn` (beside
  `holdTrack`/`releaseTrack`) move the two counters when `entry.pool === 'own'`; `toOwnUsage()` before `toUsage` (`:182`).
- `packages/shared/alm/outbound/lane/admit-al-outbound-volatile-budget.ts`: the type import (`:3-6`) becomes a value import
  of `AL_VOLATILE_SESSION_OWN_SHARE` with `type` `ALVolatileSessionBudget`, `ALVolatileSessionLimit`; `toCapacityRefusedPlan`
  (`:36-41`) destructures `own` and the reason reads `` `The session's volatile bound refused the send (${limit}): ${a} of
  ${maxAdmissions} admissions, ${b} of ${maxBytes} bytes, of which its own sends hold ${own.admissions} admissions and
  ${own.bytes} bytes against a share of ${AL_VOLATILE_SESSION_OWN_SHARE * 100}%, ${tracks} of ${maxTracks} tracks, a
  deadline at most ${maxAgeMs} ms ahead.` ``. `capacityLimit` unchanged.
- `packages/shared-test/rallar-bb-test/alm/decode-al-volatile-session-report.ts`: import `ALVolatileSessionPoolUsage`
  (`:1-5`); after `USAGE_FIELDS` (`:16`) `const POOL_FIELDS = ['admissions', 'bytes'] as const satisfies readonly (keyof
  ALVolatileSessionPoolUsage)[];`; `decodeALVolatileSessionReport` (`:25-44`) decodes `record.own`/`record.inbound` with
  `decodeCounts(…, POOL_FIELDS, 'own' | 'inbound')`, requires both, lists their issues after `usage` and before `limits`,
  and returns `own`/`inbound` copied field by field after `usage`.
- `packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts`: import `ALVolatileSessionPoolUsage`
  (`:4`); `ALMObservationLedgerReading` (`:55-60`) gains `own`, `inbound` (required) after `usage`; `toLedgerReading`
  (`:409`) carries them.
- `packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts`: the `measured` arm of
  `ALMObservationLedger` (`:126-136`) gains, after `maxTracks`, `/** The most arrivals and arrival bytes one page's inbound
  pool held (D189). */ maxInboundAdmissions: number; maxInboundBytes: number;`; `computeLedger` (`:368-382`) folds them as
  maxima over every reading's `inbound`. (`promotedReleases` is Task 4's; this task owns the inbound fold.)
- Untouched and verified: `to-al-volatile-session-qos-provider.ts` (reads `overloaded`), `browser-rallar-messages-controller.ts`
  `readUsage` and `rallar-message-operations.ts` (pass the widened type through), the black-box `readAlmUsage` chain and
  `rallar-black-box-test-contracts.ts` (`alm?: ALVolatileSessionReport`), the `capacity*` cells and `almVolatileLimits`.

Tests: `packages/tests/shared/alm/volatile-budget/al-volatile-session-budget.test.ts` (helpers `recordArrivals`,
`admitOwnSends` after `:43`; refusal `toEqual`s at `:95`, `:212`, `:226`, `:284` gain `own`; `:72`, `:111`, `:333` read the
pools; `:344` fills with `tryAdmit`; new describe "the own share of the per-session volatile budget (D189)" at the end),
`to-al-volatile-session-qos-provider.test.ts` (before `:80`), `alm/outbound/al-outbound-volatile-budget.test.ts`
(`recordReceivedUntilOneShort` `:66` → `recordArrivalsAtTheLimit`; the "1 001st" test `:89-102` rewritten),
`shared-web/websocket/create-browser-web-socket-queue-box.test.ts` (the C3 test `:279-337` reuses `openWsClient`; new proof;
helpers `resolveWsClientCheckpointStores`, `collectChatArrivals`, `createChatArrival`, `createChatSend` after `:415`),
`shared-web/messages/browser-rallar-messages-controller.test.ts` (`:53`, `:78` gain pools; new test before `:71`),
`shared-test/rallar-bb-runtime/stats.test.ts` (`:18-27`, `:124-134`), `shared-test/alm-observation-ledger.test.ts`
(`toReport(reading: Omit<ALVolatileSessionReport, 'limits'>)` `:19`, reports `:55-57`, `:72-75`, `:85-93`), and the
fixtures `shared-test/rallar-browser-runtime/read-alm-usage.test.ts:10`, `browser-runtime-facade-test-double.ts:148`.

**Interfaces produced** (Task 4 consumes): `AL_VOLATILE_SESSION_OWN_SHARE`; `ALVolatileSessionPoolUsage`;
`ALVolatileSessionReport.own` / `.inbound` (so `stats.rallar.alm.own.admissions`, `stats.rallar.alm.inbound.admissions`);
`ALVolatileSessionBudget.Refusal.own`; `ALMObservationLedgerReading.own` / `.inbound`; `ALMObservationLedger.measured.
maxInboundAdmissions` / `maxInboundBytes`. A capacity refusal still names `'admissions' | 'bytes' | 'age' | 'tracks'`.
`ALVolatileSessionPoolUsage` is not re-exported from the shared-web entries (public API snapshots unchanged).
**Consumed**: nothing new.

**D8 reuse inspection.** The ledger's own `entriesByMsgId` map and `ALVolatileSessionReleaseQueue` carry each entry's pool;
two counters beside the existing `bytes` derive the own pool and the inbound pool is the difference, so no new map, cache,
queue or timer (nothing for `packages/shared/cache` to replace). `holdOwn`/`releaseOwn` follow `holdTrack`/`releaseTrack`.
The stats decoder reuses `decodeCounts`/`isCount`; the observation reuses `toLedgerReading` and `computeLedger`. The WS proof
reuses the file's `openWsClient`, which the older C3 test now also uses (its 40-line inline setup deleted). Deleted:
`recordReceivedUntilOneShort` and the test that pinned the single-pool refusal.

- [ ] **Step 1: Write the failing tests** (copy from `final-patch-task-1.patch`). Budget, describe "the own share of the
      per-session volatile budget (D189)": "keeps half of the count and byte limits for the session's own sends"; "admits own
      sends up to the own share while arrivals hold the total at the count limit, then refuses the next" (`maxAdmissions: 10`,
      10 arrivals, own `[11..15]`, the sixth `{ limit: 'admissions', usage: { 15, 1_500, 0, 0 }, own: { 5, 500 }, limits }`);
      "lets own sends past the share use the admissions arrivals leave free" (2 arrivals, 8 own, ninth refused); "admits own
      bytes up to the own share while arrivals hold the total at the byte limit, then refuses the next" (1 000 B arrival;
      300 in, 201 `bytes`, 200 in, 1 `bytes`); "lets own bytes past the share use the bytes arrivals leave free" (200 B; 700
      in, 101 `bytes`, 100 in); "rounds the own share down, so a bound of one admission keeps none and a bound of three keeps
      one"; "frees its own share as its own admissions reach their deadlines, while arrivals still hold the total"; two
      `it.each` tables "with %i arrivals and %i own sends under four admissions, reads overloaded %s exactly as it refuses the
      next own send" (8 rows) and "with %i arrival and %i own bytes under 1 000, reads overloaded %s exactly as it refuses a
      one-byte own send" (5 rows); the C13 test renamed "is overloaded when its own sends hold the count or byte limit and
      clear below both (C13)". QoS: "states no overload while arrivals alone hold the total, and overloaded once the own share
      is held too (D189)". Outbound runtime (production limits): "admits its own share of volatile sends while arrivals hold
      the count limit, and refuses the next with capacity (D189)" (1 000 arrivals, 500 own admitted by `enqueueAllIfAbsent`,
      the next `{ refused, capacity, limit: 'admissions' }`, reason contains `its own sends hold 500 admissions`). WS client
      facade proof: "admits own sends while arrivals hold the total at its limit, and refuses capacity once the own share is
      held too (D189)" (`maxAdmissions: 4`; four arrivals over the test socket; sends 1–2 admitted volatile, send 3 refused
      `capacity`/`admissions`; report `{ usage: { admissions: 6 }, own: { 2 }, inbound: { 4 }, overloaded: true }`). Facade:
      "reads the session's own sends and its arrivals as two pools, not overloaded while arrivals alone hold the bound (D189)".
      Harness: the stats reports carry pools; the malformed report adds `own: { admissions: 0, bytes: -2 }` and expects
      `… usage.tracks is not a count; own.bytes is not a count; inbound.admissions is not a count; inbound.bytes is not a
      count; overloaded is not a boolean`; the ledger fold expects `maxInboundAdmissions: 28, maxInboundBytes: 2_000`.
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared/alm/volatile-budget/al-volatile-session-budget.test.ts
      packages/tests/shared/alm/volatile-budget/to-al-volatile-session-qos-provider.test.ts
      packages/tests/shared/alm/volatile-budget/to-al-volatile-session-admission.test.ts
      packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts
      packages/tests/shared/alm/outbound/al-outbound-congestion-diagnostic.test.ts
      packages/tests/shared/alm/inbound/al-inbound-volatile-budget.test.ts
      packages/tests/shared/alm/al-session-retention-long-run.test.ts
      packages/tests/shared/multicast/web-rtc-overlay-volatile-overload.test.ts
      packages/tests/shared-web/messages/browser-rallar-messages-controller.test.ts
      packages/tests/shared-web/director/director-at-volatile-bound.test.ts
      packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts
      packages/tests/shared-test/rallar-bb-runtime/stats.test.ts packages/tests/shared-test/alm-observation-ledger.test.ts
      packages/tests/shared-test/rallar-browser-runtime/read-alm-usage.test.ts
      packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts` (with a private `TMPDIR`):
      `Test Files 7 failed | 8 passed (15)`, `Tests 29 failed | 106 passed (135)` (budget 16, stats 5, facade 3, ledger 2,
      QoS 1, outbound 1, WS 1); e.g. `expected { Object (usage, limits, ...) } to deeply equal { Object (usage, own, ...) }`,
      `expected true to be false`.
- [ ] **Step 3: Implement** as listed. Green: `Test Files 15 passed (15)`, `Tests 135 passed (135)` (the production-limit
      outbound proof ≈200 ms, the WS proof ≈60 ms). `npx dprint fmt` on the 14 touched files only.
- [ ] **Step 4: Checks.** `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit` (clean);
      `deno check packages/shared/alm/volatile-budget/al-volatile-session-budget.ts
      packages/shared/alm/outbound/lane/admit-al-outbound-volatile-budget.ts`; `cd apps/rallar-black-box-control-server &&
      deno task check` and `cd apps/api-v1 && deno task check` (both clean; then remove `apps/*/node_modules/.deno` in the main
      worktree); `node scripts/check-tests-typecheck.mjs` (`1486 test files enforced … 0 errors`); the four IndexedDB pins
      (`4 passed`, `27 passed`, unchanged); `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` (facade
      243.4 KiB < 244) and `headless-bundle-boundary.test.ts` (309.744 KiB < 310); `shared-web-public-api-snapshots.test.ts`
      and `shared-web-browser-bundle-boundaries.test.ts` (unchanged, pass). No test file is added, so no reachability run.
- [ ] **Step 5: Commit** with the message below, then `npm run check:repo-style:changed -- 853bfd33b HEAD` (`PASS: no new repository style
      findings`) and `node scripts/check-test-structure-coupling.mjs --changed 853bfd33b HEAD` (three `PASS` lines).

```text
Keep an own share of the volatile session ledger under inbound load

The session ledger counted arrivals and own sends in one pool and
refused an own send once the total reached the count or byte limit, so
inbound traffic alone could refuse every own volatile send: about 34
arrivals a second hold the 1 000-admission limit. The ledger now keeps
each counted admission in an own or an inbound pool. Arrivals are still
recorded and never refused; an own send is refused capacity only when
the total has reached the limit and the own pool has reached
AL_VOLATILE_SESSION_OWN_SHARE, half of that limit, for the count and for
the bytes alike. Own sends may still use capacity the arrivals leave
free, and a limit of one admission keeps no own share. overloaded
reports the same condition, so the RTC congestion read stops shedding
own sends while arrivals alone fill the ledger. The age and track
bounds are unchanged.

readReport, rallar.messages.readUsage() and the black-box stats
rallar.alm block report the own and inbound pools beside the totals; a
capacity refusal keeps its limit name and its drop reason states what
the own pool holds; the ALM observation's ledger readings carry both
pools and its ledger fold reports maxInboundAdmissions and
maxInboundBytes.

D8 reuse: the ledger's entry map and release queue carry each entry's pool and two counters derive the own pool (no new map, queue or timer); the stats decoder's count decoder reads the two pools; the WS client test's openWsClient opens the client for the old and the new bound proofs.
```

### Task 2: promote a buffered track's next release into the batch that delivered its predecessor (D190)

Composed commit: `.superpowers/sdd/v1b-ii-plan/final-patch-task-2.patch` (`4a0f6f41c` on Task 1's `d6452160a`;
the writer's prototype `7cb01a997` applied there, tree-identical, with the timings of its message corrected,
R-V1b-ii-29; 15 files, +693/−10). Independent of Tasks 1 and 3 (pairwise disjoint files); it does not touch
`al-inbound-admission-store.ts`.

**Files** (anchors at the parent `d6452160a`; Task 1 touched none of these files, so they equal the design head's)

- Modify `packages/shared/alm/work/al-work-handler.ts`: `ALWorkHandlerDependencies.selectReady` (:60) gains a
  sibling `claimSuccessor` after it; `runClaimedWork` (:401–419) becomes a queue drain; new private
  `claimSuccessors` after it.
- Create `packages/shared/alm/inbound/lane/claim-al-inbound-promoted-release.ts` (under `lane/`: `inbound/` already
  holds 22 direct files and a 23rd trips `layout.directory-density`).
- Modify `packages/shared/alm/inbound/read-al-inbound-work-selection.ts`: `ALInboundWorkSelector` (:123–150) gains
  `claimPromotedRelease` and `getPromotedCount` after `getClaimedControlSends` (:147); `createALInboundWorkSelector`
  (:298–329) keeps a `promotedCount` and drops promoted ids from `unreservedDue`.
- Modify `packages/shared/alm/inbound/al-inbound-effect-intent.ts`: export `toALInboundReleaseEffectId(trackKey, seq)`
  before `toALInboundLocalDeliveryEffects` (:117) and use it at :106.
- Modify `packages/shared/alm/inbound/lane/al-inbound-store-lane.ts`: `claimSuccessor` in `createWorkHandler` (after
  :485); `promoted: this.workSelector.getPromotedCount()` beside `deferred` (:307).
- Modify `packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts`: `effect-drain` gains required
  `promoted: number` after `deferred` (:63).
- Modify `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`: `claimSuccessor: undefined` (after :526).
- Modify `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (:359): one sentence on `promoted`.
- Tests: create `packages/tests/shared/alm/inbound/al-inbound-release-promotion.test.ts` (4) and
  `packages/tests/shared-web/websocket/browser-web-socket-buffered-track.test.ts` (1, the facade proof); modify
  `packages/tests/shared/alm/work/al-work-handler.test.ts` (new `describe('ALWorkHandler successor claims')` after
  the last `it` before `createEngine` :1232, 7 cases; touched-file closure replaces `const logged: unknown[][]` at
  :1159–1162 with `logged: string[]` and `(message?: string) =>`); add `claimSuccessor: undefined,` before `runClaim:`
  in every other `new ALWorkHandler({` (27 in that file, 3 in `al-indexeddb-operation-counts.test.ts`, 4 in
  `work/al-work-handler-readiness-restore.test.ts`, 1 each in `work/al-durable-work-ownership.test.ts` and
  `inbound/al-inbound-work-selection.test.ts`).

**Interfaces** (produced; Task 4 consumes `effect-drain.promoted`)

```ts
// al-work-handler.ts — required, `T | undefined` like `diagnostics`
readonly claimSuccessor: ((port: ALWorkQueuePort, completed: ALWorkClaim) => Promise<ALWorkClaim | undefined>) | undefined;
// handler: after each released claim, `const successors = await this.claimSuccessors(release, progress.claimedCount)`;
// claimSuccessors returns [] unless claimSuccessor is set, the outcome is 'completed' and claimedCount < pageSize;
// a throw is stated through reportBatchFailure and yields [] (never strands the batch's unrun claims).
// lane/claim-al-inbound-promoted-release.ts
export namespace ClaimALInboundPromotedRelease { interface Input { port; completed: ALWorkClaim; delivery:
    ALInboundAdmittedDelivery; namespace: string; nowMs: number; } interface Promoted { claim: ALWorkClaim; effectId: string; } }
export async function claimALInboundPromotedRelease(input): Promise<ClaimALInboundPromotedRelease.Promoted | undefined>;
// decode completed; only 'release-buffered'; effectId = toALInboundReleaseEffectId(trackKey, seq + 1);
// entry = port.readEntry(toALInboundWorkKey(namespace, effectId)); skip if absent, expired, not due
// (resolveALInboundWorkReadyAt), or delivery.readReadiness(...).ready is false (corruption/NonRetryable => false);
// then port.claim({ maxCount: 1, observedEntries: [entry] }).
// ALInboundWorkSelector
claimPromotedRelease(port: ALWorkQueuePort, completed: ALWorkClaim): Promise<ALWorkClaim | undefined>;
getPromotedCount(): number; // reset by selectReady
```

Consumed: `ALInboundAdmittedDelivery.readReadiness`, `ALWorkQueuePort.readEntry/claim`, `toALInboundWorkKey`.
Produced: `effect-drain.promoted` (Task 4 folds it as `promotedReleases`; the harness re-emits the event unchanged).

**D8 reuse inspection.** Promotion reuses the delivery readiness read the selection already asks per row
(`readReadiness`), the port's observed-entry compare-and-set claim and `readEntry`, and `toALInboundWorkKey`; the
release effect id is extracted from its single construction site in `toALInboundBufferedReleaseEffects` rather than
re-built. The selector keeps one counter, not a map; no `packages/shared/cache` repository fits (nothing is keyed or
retained across batches). Nothing becomes unused. The page's own deferred list was tried as the promotion source and
rejected (8 batches for 64, 48 for 255: a page holds rows in queue order, and the next release is often on the next
page).

**Steps**

- [ ] **Step 1: Red.** Add the three test files' changes above (the handler `claimSuccessor: undefined,` lines and the closure fix
      included). Run:
      `npx vitest run packages/tests/shared/alm/work/al-work-handler.test.ts` → `Tests 3 failed | 30 passed (33)`
      (successor chain, failure stated, page bound; the four `asks no successor of a claim that ended …` pass vacuously);
      `npx vitest run packages/tests/shared/alm/inbound/al-inbound-release-promotion.test.ts` → `3 failed | 1 passed (4)`
      (the failed-predecessor pin passes at base; the 64-track pin fails `got 65` batches);
      `npx vitest run packages/tests/shared-web/websocket/browser-web-socket-buffered-track.test.ts` → `1 failed (1)`
      (`expected 65 to be less than or equal to 5` after ≈27 s).
- [ ] **Step 2: Green.** Implement the Interfaces. Pins: the 64-track drain is exactly 5 batches with `claimedCount`
      `[1, 16, 16, 16, 16]` and `promoted` `[0, 15, 15, 15, 15]` on memory stores. The facade proof runs the browser's
      own `createBrowserWebSocketQueueBox` with real timers and a started `InboxOutboxEngine` (the connect starts it;
      without it no rotation round runs after the commit's own batch); arrivals are best-effort, so they land in the
      session's **memory** pair; each frame is awaited to its `admission-outcome` before the next. Same three runs →
      `33 passed (33)`, `4 passed (4)`, `1 passed (1)`.
- [ ] **Step 3: Checks** (record each summary line): `npx vitest run packages/tests/shared/alm packages/tests/shared-web/websocket
   packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/ws-qos-policy.test.ts` →
      `Test Files 130 passed (130)`, `Tests 1570 passed (1570)`; the four IndexedDB pins unchanged (4/21/1/1 passed); `npx tsc -p
   packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit` clean; `git diff --name-only
   853bfd33b -- packages/shared | xargs deno check` clean; `cd apps/api-v1 && deno task check` and the control
      server's clean (then remove `apps/*/node_modules/.deno` in the main worktree); `node
   scripts/check-tests-typecheck.mjs` → `1488 test files enforced, 0 files carrying known debt (0 errors)`; `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
      (private TMPDIR) facade 243.8 KiB < 244 (243.4 at the parent); `headless-bundle-boundary.test.ts`
      309.886 KiB < 310 (309.744 at the parent).
- [ ] **Step 4: Commit** with the message below, then `npm run check:repo-style:changed -- 853bfd33b HEAD` → `PASS: no new repository style findings`
      (`al-work-handler.ts` cognitive load 48: keep `claimSuccessors` returning an array, a ternary in the loop puts it at
      51); `node scripts/check-test-structure-coupling.mjs --changed 853bfd33b HEAD` → three PASS lines (assert recorded values, not
      `toHaveBeenCalled*`); `npm run check:test-reachability` → `1794 test files, 1788 reached by CI, 6 manual`.

**Commit message**

```text
Run a buffered track's next release in the batch that delivered its predecessor

An inbound batch ran one buffered release per engine round: the eligibility
read defers every release whose predecessor is still undelivered, so a page
held one claimable release and up to fifteen deferred ones. A track of 64
buffered messages took 65 batches (7.5 s in memory, 13.5 s on IndexedDB), and a
full 255-message window outlived the browser's 30 s default message lifetime.

The work handler now asks its owner for the successor of each claim that
completed, while the batch holds fewer than a page of claims, and runs and
releases that successor with the rest of the batch. A claim that did not
complete promotes nothing, and a successor that cannot be claimed is stated as
a batch failure is, without stranding the claims the batch has yet to run. The
inbound owner answers a completed buffered release with the same track's next
release, read by its work key, claimed only when it is due and its delivery reads it ready
and only as that read observed it, so a track never has two releases claimed at
once. The outbound owner promotes nothing. The inbound effect-drain diagnostic
gains `promoted`, the releases a batch ran this way, which leave its `deferred`
list.

A 64-message buffered track now drains in 5 batches: 0.4 s in memory, and
0.7 s on IndexedDB with 84% fewer IndexedDB operations. A 255-message one
drains in 17 batches (2.1 s), and the browser's WS client delivers all 65
messages of the 64-message track in order within one message lifetime.

D8 reuse: the delivery readiness read the selection already asks, the port's observed-entry claim and readEntry, and toALInboundWorkKey; the release effect id is extracted from its one construction site, and no cache or map is added.
```

### Task 3: count bounds on departed-sender state (D191)

Composed commit: `.superpowers/sdd/v1b-ii-plan/final-patch-task-3.patch` (`778b9e526` on Task 2's `4a0f6f41c`; the
writer's prototype `475da1fbf` plus the headless budget raise, R-V1b-ii-27; 7 files, +387/−29). Independent of Tasks
1–2 (pairwise disjoint files); touches `al-inbound-admission-store.ts` only in `commitBundle` and below the class
(Task 2 owns the lane).

**Files** (anchors at the parent `4a0f6f41c`; Tasks 1–2 touched none of these files, so they equal the design head's)

- Modify `packages/shared/alm/inbound/al-inbound-admission-store.ts`: new export above `ALInboundMessageOwner` (`:63`);
  `commitBundle` (`:614-640`) split into `commitBundle`, private `writeValidatedBundle` (the old try/catch, unchanged)
  and private `evictOrderingTracksPastCap`; `toOrderingKey` (`:837-839`) gains `toOrderingPrefix`; two module functions
  before `toALInboundClaimKey`'s doc comment (`:858`); import `ALAdmissionBackendEntry` (`:14`).
- Modify `packages/shared-web/browser/messages/browser-resync-recovery.ts` (`:22-31`): doc comment + `maxEntries`.
- Modify `packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts`: constant after
  `:41`; namespace types after `CountedAck` (`:85-89`); class doc (`:101-102`); `#aggregates` (`:105`); every
  `#aggregates` use in `readRelayedAckRejection`/`holdsReceiptFor`/`recordAdmission`/`recordAck`/`sweep`/
  `writeAdmittedReceipt` (`:129-198`); two private methods before `deleteAggregate` (`:249`); import (`:30`).
- Modify `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`: `brotliBudgetKiB` 310 → 311
  (R-V1b-ii-15, R-V1b-ii-27: this is the first composed commit past 310).
- Create `packages/tests/shared/alm/inbound/al-inbound-ordering-track-cap.test.ts` (unit pins + facade proof).
- Modify `packages/tests/shared-web/messages/browser-resync-recovery.test.ts` (`:20-42` optional `orderingKey`; a
  `createTrackResync` helper before `RecoveryFixture` `:59`; one test before `:152`).
- Modify `packages/tests/shared/services/ws-queue-box-server-receipt-aggregation.test.ts` (import `:33-36`; `:390`
  reads `.admitted`; a new `describe` + `admitAggregates` helper before `createAggregation` `:400`).

**Interfaces** (Task 4 consumes `AL_INBOUND_MAX_ORDERING_TRACKS`, the private `evictOrderingTracksPastCap` and
`toOrderingPrefix`)

- Produces `AL_INBOUND_MAX_ORDERING_TRACKS = 256` (exported from `al-inbound-admission-store.ts`; also bounds the resync
  set). `ALInboundAdmissionStore`'s interface is unchanged.
- Produces `WS_QUEUE_BOX_SERVER_MAX_RECEIPT_AGGREGATES = 4096`, `WsQueueBoxServerReceiptAggregation.EndedAggregate
  { receipt: ALReceiptPayload; deadlineAtMs: number }`, `RecordedAdmission { admitted: ALReceiptPayload; evicted:
  EndedAggregate | undefined }`; `recordAdmission(admission)` now returns `RecordedAdmission` (only its own tests call it;
  `apps/api-v1` and the control server reach it through `createDefaultWsQueueBoxServerService` only).
- Consumes `LatestRepository` (`acceptAt`, `readAt`, `take`, `keys`, `size`, `delete`; options `ttlMs`, `maxEntries`,
  `evictsPerWindow: 0`), `ALAdmissionWorkBackend.readWithin`/`write`, `decodeALInboundOrderingSnapshot`.

**D8 reuse inspection.** The aggregates `Map` becomes `LatestRepository` (`ttlMs = WS_QUEUE_BOX_SERVER_RECEIPT_WINDOW_MS`
= `DEFAULT_AL_EPHEMERAL_TTL_MS`, `maxEntries: 4096`, `evictsPerWindow: 0` so the deadline sweep stays the one path that
ends an aggregate on time); the repository drops its oldest silently, so the aggregation takes the oldest itself at
the cap (`keys()` is insertion order; `acceptAt` on a live key keeps its place) to answer it. `invokedTrackKeys` keeps
its `LatestRepository` and gains `maxEntries`. The ordering cap reuses the backend's existing `list(prefix)` in a read
session and its fenced `read` + `remove` in one write — no new backend method, no new index, no new row shape, so
`AL_ADMISSION_SCHEMA_ID` stays. The IndexedDB `expireAtTimestamp` index exists (`open-indexed-db-admission-database.ts`)
but is store-wide (every namespace and row kind) and the backend interface has no index read; the ordering prefix is a
primary-key range of at most 257 rows and gives the same order (expiry = `updatedAtMs` + one TTL). Nothing becomes
unused.

**Behaviour**

1. Store: after a `'committed'` bundle whose `observations.ordering?.snapshot === undefined` and whose mutations hold a
   `set-ordering` (`opensALInboundOrderingTrack`), `evictOrderingTracksPastCap()` lists `${namespace}:ordering:` in a
   `readWithin` session, sorts by `updatedAtMs` then key (`resolveLeastRecentlyUpdatedTracks(held, held.length - 256)`),
   and in one `backend.write` removes each victim only if `read` still returns the same `updatedAtMs`; an
   `ALAdmissionBackendConflictError` from that write is swallowed (the next new track evicts), anything else rethrows.
   The admission's own status is returned unchanged. Only the snapshot leaves: the `delivered:` marker stays, because
   `ALInboundOrderedDelivery.complete` throws `NonRetryableException` when a buffered row outlives its progress row.
2. Resync: `new LatestRepository<string, true>({ ttlMs: AL_VOLATILE_SESSION_MAX_AGE_MS, maxEntries:
   AL_INBOUND_MAX_ORDERING_TRACKS })`; doc sentence "It remembers at most as many tracks as the receiver keeps ordering
   snapshots for, the first remembered leaving first (D191)."
3. Aggregation: `recordAdmission` returns early (`evicted: undefined`) for a live key or an empty audience; otherwise
   `takeOldestAggregateAtCap(nowMs)` (size ≥ 4096 → `take` the first key, delete it from `#deadlines`, return its
   `timed-out` receipt with `deadlineAtMs`), then `acceptAt` + `#deadlines.add`. Reads use `readAt(key, clock.nowMs())`,
   `sweep` uses `take`, a partial ACK uses `acceptAt`. `writeAdmittedReceipt` returns early for no admission or a live
   aggregate, writes `evicted` first (`writeReceipt(evicted.receipt, evicted.deadlineAtMs)`, which also settles the
   server row as a `timed-out` sweep does), then the `admitted` receipt.

**Tests** (fake Date, `vi.setSystemTime(Date.now() + 1)` before each admission so every track has its own `updatedAtMs`)

- `al-inbound-ordering-track-cap.test.ts` (`import 'fake-indexeddb/auto'`): fixture = `createInboundTestBackendStores({
  namespace: 'ordering-cap', storage, observer: passThrough })` + `createInboundTestRuntime({ carrier: 'ws', stores })`;
  message for track t, sequence s: `createInboundTestMessage({ msgId: 'track-<t>-<s>', seq: s })` with `ordering:` key `track-<t>`,
  admitted through `runtime.admitIncomingMessage(…, INBOUND_TEST_SOURCE)` expecting `{ kind: 'admitted' }`; held
  tracks = `backend.list('ordering-cap:ordering:', (v) => v)` keys' first segment. Memory `describe`: (1) 256 first
  sequences → 256 held; (2) 256 tracks, then `track-0` seq 2, then `track-256` seq 1 → 256 held, `track-0` and
  `track-256` held, `track-1` not (least recently updated, not first opened); (3) 257 tracks → the decision surface
  (`readInboundTestDecisionSurface` → `computeALInboundPlanningObservations(read).orderingObservation`) of `track-0` seq 2
  is `{ status: 'gap', expectedSeq: 1, missingRanges: [{ from: 1, to: 1 }] }` and equals a never-seen `track-257` seq 2's
  but for `trackKey`; held `track-1` seq 2 reads `in-order`, `expectedSeq: 3`. Facade proof, `describe.each(['memory',
  'indexeddb'])`: 300 one-send tracks → 256 held, `track-299` held, `track-43` not (timeout 30 000 ms).
- `browser-resync-recovery.test.ts`: `ResyncMessageInput.orderingKey?` (absent → `'chat'`), helper
  `createTrackResync(track)`; test "remembers at most the receiver's ordering-track cap, forgetting the first
  remembered first": resync tracks 0..256, then 256 again, then 0 → 258 invocations, the last on `track-0`.
- `ws-queue-box-server-receipt-aggregation.test.ts`, `describe('WS server receipt aggregates at their cap')` with
  helper `admitAggregates(aggregation, count, first = 0)` (msgIds `room-message-<first+1>` … `<first+count>`, returns the
  defined `evicted` values): (1) 4096 admitted → no eviction, `sweep(MAX_SAFE_INTEGER)` 4096; (2) message 1 admitted,
  ACK from `b` counted, 4095 more, then one more → evicted equals `{ receipt: { msgId: 'room-message-1', originPeerId:
  'a', expectedRecipientPeerIds: ['b','c'], confirmedRecipientPeerIds: ['b'], snapshotVersion: 7, phase: 'timed-out',
  observedAtEpochMs: 1000 }, deadlineAtMs: 30000 }`, a later ACK from `c` is refused "names no receipt this server
  aggregates", the sweep returns 4096 without `room-message-1`; (3) 4096 admitted as messages 2..4097, then
  `writeAdmittedReceipt` of `roomMessage(1_000)` → enqueued receipts `[{ msgId: 'room-message-2', phase: 'timed-out' },
  { msgId: 'room-message-1', phase: 'admitted' }]`.

**Steps**

- [ ] Red. Write the three test changes above. Private TMPDIR: `T=$(mktemp -d
  /tmp/claude-501/x.XXXX)`. Run `TMPDIR=$T npx vitest run packages/tests/shared/alm/inbound/al-inbound-ordering-track-cap.test.ts
  packages/tests/shared-web/messages/browser-resync-recovery.test.ts
  packages/tests/shared/services/ws-queue-box-server-receipt-aggregation.test.ts`. Expected: `Test Files 3 failed (3)`,
      `Tests 10 failed | 26 passed (36)` (the cap file 5/5 red — its constant import is `undefined` until step 2 — resync 1,
      aggregation 4 including the `.admitted` read at `:390`).
- [ ] Green. Apply the three source changes. Same command: `Test Files 3 passed (3)`, `Tests 36 passed (36)`. The
      IndexedDB facade case runs about 3–5 s (timeout 30 s in the file).
- [ ] Wider: `TMPDIR=$T npx vitest run packages/tests/shared/alm packages/tests/shared/services
  packages/tests/shared-web/messages packages/tests/shared-web/al-runtime` → `Test Files 184 passed (184)`, `Tests 2223
  passed (2223)`. The four IndexedDB pins (`al-indexeddb-transaction-ledger`, `al-indexeddb-operation-counts`,
      `al-storage-snapshot`, `al-indexeddb-empty-audience-counts`) → `4 passed`, `27 passed`, unchanged: none admits an
      ordered inbound message.
- [ ] Types and Deno: `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit` (4×
      clean); `deno check packages/shared/alm/inbound/al-inbound-admission-store.ts
  packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts`; `cd apps/api-v1 && deno task
  check`; `cd apps/rallar-black-box-control-server && deno task check` (all exit 0); `node scripts/check-tests-typecheck.mjs`
      → `1489 test files enforced, 0 files carrying known debt (0 errors)`; then remove `apps/{api-v1,rallar-black-box-control-server}/node_modules/.deno`.
- [ ] Bundles (private TMPDIR): `cd packages/shared-web && TMPDIR=$T node scripts/measure-browser-bundles.mjs --check` →
      facade 243.8 KiB < 244 (243.8 at the parent); the headless agent measures 310.365 KiB (309.886 at the parent), past
      310: raise `headless-bundle-budget.json` to 311 in this commit (R-V1b-ii-27) and `headless-bundle-boundary.test.ts`
      passes; `shared-web-public-api-snapshots` and `shared-web-browser-bundle-boundaries` pass (no public export changes).
- [ ] `npx dprint check` on the seven files; commit; then `npm run check:repo-style:changed -- 853bfd33b HEAD`, `node
  scripts/check-test-structure-coupling.mjs --changed 853bfd33b HEAD`, `npm run check:test-reachability` (a test file is
      added) → `PASS: no new repository style findings`, three coupling PASS lines (`all 2 current structure-coupling candidates
  are individually classified`, `… complete individual classifications`, `registry entries are complete and current`),
      `Test reachability: 1795 test files, 1789 reached by CI, 6 manual.`

**Commit message**

```text
Bound departed-sender state by count: ordering snapshots, resync set, receipt aggregates

A receiver's ordering snapshots, the browser's resync set and the WS server's
receipt aggregates were bounded by time only, so sessions that leave and rejoin
grew them in step with churn.

- The inbound admission store keeps at most 256 ordering snapshots. A commit
  that opens a track past the cap evicts the least recently updated snapshot
  right after it, each removal guarded on the snapshot still being the one read;
  the evicted track's next arrival reads as a fresh track's. Its delivered
  marker stays, since live delivery work reads it.
- The browser's resync recovery remembers at most 256 tracks.
- The WS server holds at most 4096 receipt aggregates within the receipt
  window; an admission at the cap ends the oldest with a timed-out receipt of
  the audience confirmed so far, as its deadline would.

The headless agent budget rises to 311 KiB.

D8 reuse: LatestRepository replaces the receipt aggregates Map and caps the resync set; the ordering cap uses the admission backend's existing list and guarded remove, with no new index, row shape or backend method.
```

### Task 4: the fairness cells, the ordering-snapshot count and the observation folds (D189–D192)

Composed commit: `.superpowers/sdd/v1b-ii-plan/final-patch-task-4.patch` (`7fc45171c` on Task 3's `778b9e526`; 47
files, +1180/−133): the writer's prototype `cf3350d29` without its headless budget raise, which Task 3 carries
(R-V1b-ii-27), and without the message's budget sentence. It is the exact text: apply with `git am -3`; replay a hunk
that no longer applies by its text anchor (line numbers below are at `778b9e526`, which equals the prototype's parent
`1baae57de` but for the budget file).
Rulings R-V1b-ii-4 (the churn witness is a harness `stats.rallar.alm.orderingTracks`, no facade method), -8 (pools at the
report's top level), -11 (Task 1 owns `maxInbound*`; this task adds `promotedReleases` and `maxOrderingTracks`), -14
(measure before recomputing the `capacity*` limits), -15 with -27 (no budget raise here), -18 (only a completed release
promotes), -20..-26 and -28 bind it.

**Files**

- Shared (the count): `packages/shared/alm/inbound/al-inbound-admission-store.ts` — `CreateALInboundAdmissionStoreInput`
  gains optional `reportOrderingTracks?: ALInboundOrderingTracksReport` and the exported type
  `ALInboundOrderingTracksReport = (tracks: number) => void` after it; `Dependencies` gains it (required, `| undefined`);
  the constructor stores it; `commitBundle` reports `await this.evictOrderingTracksPastCap()`, which now returns the count
  held after the pass (`held.length − removed`) through a new private `removeUnchangedTracks(evicted)` (the old guarded
  write, counting its removes, `0` on `ALAdmissionBackendConflictError`); both factories pass it explicitly.
  `packages/shared/alm/al-runtime-stores.ts` — `CreateInMemoryALRuntimeStoresInput` and `CreateDefaultALRuntimeStoresInput`
  gain the optional field; `toDefaultInMemoryInput`, `toInMemoryALInboundAdmissionStoreInput` and the IndexedDB inbound
  store input pass it. `packages/shared/alm/storage/al-storage-event.ts` — union member
  `Readonly<{ kind: 'ordering-tracks'; storeId: string; tracks: number; }>` (doc line in the union's comment) and
  `toALOrderingTracksReport(storage, storeId)` before `toALStorageResetSink`.
- Shared-web (wiring, no facade method): `browser/al-runtime/browser-al-runtime-stores.ts` — the session inbound scope's
  options add `reportOrderingTracks: toALOrderingTracksReport(reporting.storage, sessionInboundId)`;
  `createBrowserALVolatileInboundRuntimeStores(name, budget, storage)` (third parameter) reports as `${name}/volatile`.
  `browser/connection/initialise-browser-middleware.ts:304` passes `options.diagnosticsPorts.storage`.
- Harness: new `black-box-runner/browser/rallar-browser-runtime/black-box-rallar-ordering-tracks.ts`
  (`BlackBoxRallarOrderingTracks { observe(event: ALStorageEvent); getOrderingTracks(); reset() }`, latest count per
  `storeId` in an immutable record, summed); `browser-rallar-runtime-composition.ts` (diagnostics dependency field
  `orderingTracks`, created beside `congestion`); `black-box-rallar-diagnostics.ts` (the `storage` port observes first,
  then relays as before); `connection/black-box-rallar-close-operation.ts:88` (reset beside congestion);
  `connection/black-box-rallar-connection-runtime.ts` (`readAlmUsage` answers `{ ...readUsage(), orderingTracks }`);
  `black-box-rallar-runtime-contract.ts` (`readAlmUsage(): Promise<RallarBlackBoxTestAlmUsage | undefined>`).
  `rallar-bb-test/rallar-black-box-test-contracts.ts`: `interface RallarBlackBoxTestAlmUsage extends
  ALVolatileSessionReport { orderingTracks: number }` before `RallarBlackBoxTestStatsSnapshot`, whose `rallar.alm` takes
  it; new `rallar-bb-test/alm/decode-rallar-black-box-test-alm-usage.ts` (report decoder + integer count, issue
  `orderingTracks is not a count`); `create-rallar-black-box-browser-test-runtime.ts` and
  `runtime/create-rallar-black-box-test-runtime.ts` swap the type and decoder.
- Observation: `conformance/alm/alm-observation-snapshot.ts` — `ALMObservationInboundDrain.promoted` (required, decoded
  in the drain's one `if` chain); `ALMObservationLedgerReading.orderingTracks` via the new decoder.
  `compute-alm-observation-regime.ts` — ledger `maxOrderingTracks`; measured inbound direction `promotedReleases` (sum
  over every drain of the role, both lanes; doc sentence on `toInboundDirection`).
- Cells (`conformance/alm/scenarios/fairness/`; `scenarios/` gains no direct file): `to-send-loop-command.ts`
  (`toSendLoopCommand({ step, name, count, send })`, handle `${send.handleId}-{loop.index}`),
  `own-share-under-inbound.ts`, `buffered-track-drains.ts`, `churn-bounded-tracks.ts`. Also
  `alm-conformance-scenario-definition.ts` (three ids), `create-alm-conformance-recipes.ts` (imports; registered right
  after `backpressureDeferred`), `alm-conformance-message-commands.ts` (assertion operators gain `gte`, `lt`, `lte`;
  `toObserveCommand` returns `RallarBlackBoxTestMessagesObserveCommand`), `volatile-bound/volatile-bound-commands.ts`
  (`name` gains `'raised'`; `toReconnectedArrivalsCommand(waiting, …)` doc for either page),
  `volatile-bound/capacity.ts` (doc only: why the share leaves the limits), `congestion/congestion-commands.ts` (doc:
  "after every cell registered before them"), `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`
  (three imports, three withheld rows after `backpressure-deferred`).
- Budget: none; the headless agent measures 310.674 KiB against Task 3's 311 (R-V1b-ii-27).
- Tests: new `packages/tests/shared-test/alm-conformance-fairness.test.ts`; `alm-conformance-recipes.test.ts`,
  `alm-conformance-recipe-validation.test.ts`, `alm-conformance-congestion.test.ts`,
  `packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts`, `alm-observation-regime.test.ts` (also drops
  the `as unknown` in `readFixtureRegime`: a touched file enforces `boundary.unknown`), `alm-observation-ledger.test.ts`,
  `rallar-bb-runtime/stats.test.ts`, `rallar-browser-runtime/read-alm-usage.test.ts`,
  `rallar-browser-runtime/browser-runtime-facade-test-double.ts`, `alm-cross-carrier-duplicate-outcome.test.ts`,
  `packages/tests/shared/alm/inbound-runtime-test-fixture.ts` (optional `reportOrderingTracks`),
  `.../inbound/al-inbound-ordering-track-cap.test.ts`, `shared-web/al-runtime/browser-al-runtime-stores.test.ts`, and the
  pass-through sink at every `createBrowserALVolatileInboundRuntimeStores` call in five shared-web test files
  (`acknowledgement-under-hold-fixture.ts`, `create-browser-web-socket-queue-box.test.ts`,
  `ws-durable-owner-recovery.test.ts`, `ws-retained-work-fault.test.ts`, and Task 2's
  `browser-web-socket-buffered-track.test.ts`, R-V1b-ii-28).

**Interfaces consumed.** Task 1: `AL_VOLATILE_SESSION_OWN_SHARE`, `ALVolatileSessionReport.{own,inbound}`, the report
decoder, `ALMObservationLedgerReading.{own,inbound}` and `maxInbound*`. Task 2: `effect-drain.promoted` (required).
Task 3: `AL_INBOUND_MAX_ORDERING_TRACKS`, `evictOrderingTracksPastCap`, `toOrderingPrefix`.

**Interfaces produced.** `ALInboundOrderingTracksReport`; `ALStorageEvent` `ordering-tracks`; `toALOrderingTracksReport`;
`createBrowserALVolatileInboundRuntimeStores(name, budget, storage)`; `RallarBlackBoxTestAlmUsage`,
`decodeRallarBlackBoxTestAlmUsage`; `stats.rallar.alm.orderingTracks`; observation `maxOrderingTracks`,
`promotedReleases`; scenario ids `own-share-under-inbound`, `buffered-track-drains`, `churn-bounded-tracks`.

**The cells.** Two-agent, `FULL_TAGS`, roles `['sender','receiver']`.

- `own-share-under-inbound` (all carriers). Receiver: close, connect with `{ maxAdmissions: 20, maxBytes: 4 MiB }`
  (share `floor(20 × 0.5) = 10`); `send-1` (ready); `received-1` count 20; `send-2`; `acknowledged-2`;
  `stats-own-share` asserting `rallar.alm.inbound.admissions` gte 20, `rallar.alm.own.admissions` lt 10,
  `rallar.alm.overloaded` equals false; reconnect restored. Sender: `received-1` (count 1, window 57 s: one readiness
  budget), loop `flood` × 20 (`ack: 'receiver'`, at-least-once, `ttlMs` 30 000). Arithmetic: arrivals count
  `min(ttl, 30 s)`; 20 back-to-back arrivals hold `inbound ≥ 20` for ~30 s (`30 · r ≥ 20` ⇔ `r ≥ 0.67/s`; the 28 s
  `received-1` window needs only `r ≥ 0.72/s`); own = 2 (the ready and the asserted send) < 10. Under one pool `total + 1 > 20` refuses `send-2`.
- `buffered-track-drains` (`ws`, `rtc`). Sender: `toOrderedSendCommands` for seq 2..65 (64 literal sends: a loop index
  counts from 0 with no offset, and an outer loop fixes an inner loop's index), then seq 1. Receiver: `received-1` count
  65, window 29 s / timeout 30 s; over `rtc` only, loop `promoted-release` (`count: 9`, `until: 'first-success'`) of a
  wait on `rallar.browser.alm.inbound_diagnostics` `data` containing `"promoted":{loop.iteration}`, 1 s each — the
  measured per-batch `promoted` is `[0,15,15,15,15]`, so iteration 1 matches at once; over `ws` the relay buffers.
- `churn-bounded-tracks` (`rtc`). Sender: close, connect `{ maxAdmissions: 1000, maxBytes: 4 MiB, maxTracks: 600 }` (the
  300 tracks are live in the sender's own ledger, default 64), loop `open-tracks` × 300 (`orderingKey`
  `alm-rtc-churn-bounded-tracks-{loop.index}`, seq 1, at-least-once, 30 s), observe handle `…-send-0-299`
  transport-accepted, `close-departs`. Receiver: `received-1` count 300 (window 57 s), absent wait `snapshots-settle`
  1 s, `stats-ordering-tracks` asserting `rallar.alm.orderingTracks` lte 256 and gte 256.
- `capacity*`: limits unchanged (R-V1b-ii-14). `capacity` (bytes 36 000, share 18 000): after the 31 s settle the own
  pool is the sends; send 2 takes own to 2S ≈ 26.8 KB > 18 000 but total 2S + H ≤ 36 000 → admitted; send 3: own 3S and
  total 3S > 36 000 → refused, as before. `capacity-age`/`-tracks` refuse on bounds D189 leaves alone; the track cell's
  `overloaded` false holds (own 2 ≪ 500).

**D8 reuse inspection.** The store's existing eviction listing (no new read) and the storage diagnostics port carry the
count; the harness holder mirrors `black-box-rallar-congestion-counters.ts` (per connection, reset at `close`), with a
record instead of a raw `Map`; `toBoundReconnectCommands`, `toReconnectedArrivalsCommand`, `toOrderedSendCommands`,
`toSendCommand`, `toReceivedCommand`, `toAcknowledgedCommands`, `toStatsCommand` + `toResultAssertion`, the assert
operators the harness already evaluates, the loop command's placeholders and first-success mode, the withheld rows.
A store-port count method and a registry read were rejected: the session's memory inbound pair is reachable only
through the facade, and the IndexedDB pair alone misses the volatile tracks V1d must watch.

- [ ] **Step 1: Tests (red).** Copy the test edits (every `packages/tests/**` change of the commit) onto `778b9e526`. `npx vitest run
  packages/tests/shared-test/alm-conformance-fairness.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts
  packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/shared-test/alm-conformance-congestion.test.ts
  packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts packages/tests/shared-test/alm-observation-regime.test.ts
  packages/tests/shared-test/alm-observation-ledger.test.ts packages/tests/shared-test/rallar-bb-runtime/stats.test.ts
  packages/tests/shared-test/rallar-browser-runtime/read-alm-usage.test.ts packages/tests/shared-test/alm-cross-carrier-duplicate-outcome.test.ts
  packages/tests/shared/alm/inbound/al-inbound-ordering-track-cap.test.ts packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts
  packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
      → `Test Files  12 failed | 1 passed (13)`, `Tests  33 failed | 135 passed (168)` (two files fail at import; the
      headless boundary test passes at 310.365 KiB under Task 3's 311).
- [ ] **Step 2: Implement.** Same command → `Test Files  13 passed (13)`, `Tests  173 passed (173)`. Wide (private
      `TMPDIR`, R-V1b-ii-30): `npx vitest run packages/tests/shared packages/tests/shared-web packages/tests/shared-server
  packages/tests/shared-test packages/tests/rallar-black-box` → `Test Files  5 failed | 1316 passed | 4 skipped (1325)`,
      `Tests  25 failed | 12730 passed | 12 skipped (12767)`, all sandbox reds (`live-rtc-control-client` 13 `listen EPERM`
      with its hook timeout, `api-v1-rtc-rtt-recipe-semantics` 5, `api-v1-state-write-convergence-recipe` 4,
      `local-websocket-session` 1, `headless-worker-script` 2).
      `node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` → `checked 67 Hetzner
  distributed manifest(s)`; `git diff --stat 853bfd33b HEAD -- apps/rallar-black-box/manifests/hetzner/` empty.
- [ ] **Step 3: Checks.** `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit` and
      `cd apps/rallar-black-box && npx tsc --noEmit` clean; `node scripts/check-tests-typecheck.mjs` → `1490 test files enforced, 0 files carrying known debt (0 errors)`;
      `deno check` the three changed `packages/shared` files; `deno task check` in `apps/api-v1`, the control server and
      `apps/relic-hunter-server-v1` clean; control server `deno test … test/control-alm-evidence.test.ts
  test/control-alm-three-agent-evidence.test.ts test/control-generated-alm-reload.test.ts` → `43 passed`; then remove
      `.deno` under the main worktree's `apps/*/node_modules`. Bundles (private `TMPDIR`): facade 243.9 < 244; headless
      310.674 < 311 (parent 310.365; Task 3 raised the budget, R-V1b-ii-27). IndexedDB pins unchanged (the report
      is a callback, no operation). After the commit: `npm run check:repo-style:changed -- 853bfd33b HEAD` → PASS;
      `node scripts/check-test-structure-coupling.mjs --changed 853bfd33b HEAD` → three PASS lines;
      `npm run check:test-reachability` → `1796 test files, 1790 reached by CI, 6 manual`.
- [ ] **Step 4: Commit** with the message below.

Lane (Task 6, unsandboxed, `RALLAR_BLACK_BOX_ALM_SCOPE=full`, `-g "baseline family"`): expect about +45 s per `rtc`
run (two reconnects, 20 + 65 + 300 sends), +25 s per `ws` run and +15 s on the fallback cell (10.3 min measured; 15 min
budget per carrier). If
`churn-bounded-tracks` reads `orderingTracks` 0, the page saw no `ordering-tracks` event: check the receiver's
`rallar.browser.alm.storage` events before the cell. If `buffered-track-drains` exhausts its digit loop over `rtc`, read
the receiver's `effect-drain` events: seq 1 may have overtaken the buffered sends.

**Commit message**

```text
Prove fairness in the ALM lane: the own share, promotion and the track bound

Three two-agent cells run last in the family, full tag only, and are
withheld from hosted manifest 18; manifests 18 and 22 stay
byte-identical.

own-share-under-inbound (ws, rtc, rtc-with-ws-fallback): the receiver
reconnects with its count bound lowered to 20, its own share 10 (D189),
and sends a ready message; the sender floods the room with 20
acknowledged sends, so arrivals alone hold the receiver's total at the
bound. The receiver's own room send is still admitted and acknowledged,
and its ledger reads inbound admissions at or above 20, own admissions
under 10 and no overload; it reconnects with its constants last.

buffered-track-drains (ws, rtc): the sender sends seq 2 to 65 on one
ordering key, then seq 1, and the receiver delivers all 65 within one
default lifetime. Over rtc, where the receiver buffered the track, an
inbound effect-drain states a release run by promotion (D190): a loop
reads the count's leading digit, 1 to 9, until one matches.

churn-bounded-tracks (rtc): the sender reconnects with room for 600
tracks of its own, opens 300 tracks with one send each and leaves; the
receiver delivers the 300 and its stats then read exactly 256 ordering
snapshots (D191).

That count is new. An inbound admission store states how many ordering
snapshots it holds after the eviction pass a new track runs, through an
optional reporter; the browser wires both session pairs to the storage
diagnostics port as ordering-tracks events, the IndexedDB pair under
its store id and the memory pair as its volatile lane. The black-box
page keeps each store's latest statement, resets them at close, and
stats.rallar.alm carries their sum as orderingTracks beside the ledger
report. The observation folds maxOrderingTracks into its ledger block
and promotedReleases, the promoted counts of every drain of a role on
both lanes, into each inbound direction.

The capacity cells keep their limits: once the platform sync left the
budget their own sends are the own pool, which passes its share before
the total, so the total still decides.

D8 reuse: the store's existing eviction listing (no new read), the storage diagnostics port and its sink helpers, the congestion counters' per-connection reset, toBoundReconnectCommands (with a raised name), toReconnectedArrivalsCommand for either waiting page, toOrderedSendCommands, toSendCommand, toReceivedCommand, toAcknowledgedCommands, toStatsCommand with toResultAssertion (gte, lt and lte from the harness's assert operators), the loop command with its index placeholder and first-success mode, the withheld-manifest rows; the observation fold extended in place.
```

### Task 5: Docs — the own share, promotion, the count bounds and the fairness cells (D193)

Composed commit: `.superpowers/sdd/v1b-ii-plan/final-patch-task-5.patch` (`d05df6bac` on Task 4's `7fc45171c`,
tree-identical to the writer's prototype `c918502fd`; 9 files, +240/−52, docs only). It is the exact text: apply with
`git am -3` after Task 4; replay a hunk that no longer applies by its text anchor (line numbers at `7fc45171c`, whose
docs equal the prototype parent `cf3350d29`'s). Then run the "True of the code" checks,
the only part that can fail; a mismatch is fixed in the doc, never in the code. Decision ids only; the roadmap row, the
audit's F5 row and the requirement matrix are the close's. Rulings R-V1b-ii-3 ("ordering snapshots", never per-track
state; the delivered marker named as carried), -6 (the resync record's insertion-order eviction is a Limit), -16
(promotion by keyed read within the batch bound) bind it. Task 2 already wrote `promoted` into
`runtime-diagnostic-contract.md`; Task 1 and Task 3 wrote no Markdown.

**Files (text anchors)**

- `docs/rallar-api-reference.md`: the volatile bound paragraph ("The bound has four limits", `:671`) — the two pools
  and the own share (`AL_VOLATILE_SESSION_OWN_SHARE` 0.5 rounded down: 500, 2 MiB); the refusal paragraph (`:684`) —
  the both-conditions rule, arrivals never refused, the total may exceed the limit, the measured single-pool figure (34
  arrivals/s refused every send of a 1/s sender) and `overloaded` as the next own send's refusal; `readUsage()`
  (`:699`) — `usage` totals, `own`, `inbound`, `overloaded`; the bounded-state paragraph (`:716`) — the resync record's
  256 tracks and the 256 ordering snapshots per store; its **Limit** — the plateau at ≤ 256 snapshots plus one
  delivered marker per track received on in the hour, and the resync record's first-recorded-first eviction; Congestion
  (`:741`) — `overloaded` as the next send's refusal; the storage port list (after `recovery-owner-invoked`, `:936`) —
  `ordering-tracks`; Ordering, Repair And Resynchronization (after the buffer-limits paragraph, `:1299`) — promotion
  (16 claims a batch, 64 buffered in 5 batches: 0.4 s where one release per round took 7.5 s; 255 in 17; only a
  delivered release, one track at a time) and the cap (post-admission eviction, an evicted track read from seq 1).
- `packages/shared/alm/outbound/README.md`: `:185` "fairness is V1b-ii's" → the claim order is the queue's own and was
  kept (measured); `:780-787` the pools, the share rule, the refusal's own figures; `:793-795` `readReport` names the
  pools; `:798-801` "about 33 messages a second" → the measured single-pool figures (`30·inbound + ttl·own ≥ 1 000`: 33/s
  refused two thirds of a 1/s stream, 34/s all; 8.5 KB envelopes at 16/s) and the share (500 counted own sends, ≈16/s at
  30 s, whatever arrives; arrivals at 1 000 still admit 500 and refuse the 501st); `:806` `overloaded` = the next own
  send's refusal; `:841-843` the resync record's 256 tracks; `:848` the **Limit** names the snapshot cap and the
  delivered marker; Server receipts on WS (`:546`) — the aggregates are a `LatestRepository` (30 min TTL,
  `WS_QUEUE_BOX_SERVER_MAX_RECEIPT_AGGREGATES` 4 096), the oldest ended `timed-out` at the cap.
- `packages/shared/alm/inbound/README.md`: the "age limit bounds counted admissions" bullet (`:108`) — the cap and the
  delivered marker's hour; the inbound-budget paragraph (`:132`) — the inbound pool and that arrivals alone refuse no
  own send; after "Ordering gaps and resynchronization" (`:440`) a **Buffered releases and the snapshot cap** paragraph
  pair (promotion by `claimPromotedRelease`'s keyed read in `lane/claim-al-inbound-promoted-release.ts`, the page-size
  bound, only a completed release, one track; measured 5 / 17 batches; `promoted` leaves `deferred`; the post-commit
  eviction, 257 between the writes, a conflict left to the next track, the delivered marker's **Limit**, the
  `reportOrderingTracks` reporter and the browser's `ordering-tracks` event); the Buffered release table row; the
  relayed-diagnostics paragraph (`:740`) — `effect-drain.promoted`.
- `packages/shared-web/browser/README.md:301-303`: the resync sink remembers at most 256 tracks, first remembered first.
- `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`: before `persist` (`:550`) the
  `ordering-tracks` storage event.
- `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`: after the congestion cells (`:518`) the fairness
  cells paragraph; `:551` the `capacity-tracks` parenthetical no longer calls itself the only ledger reading at a bound;
  `:1101` `stats.rallar.alm` = `{ usage, own, inbound, limits, overloaded, orderingTracks }`.
- `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md`: the inbound direction's `promotedReleases`
  (after `claimWaits`); the `ledger` bullet's reading shape and fold (`maxInboundAdmissions`, `maxInboundBytes`,
  `maxOrderingTracks`), stricter decode.
- `packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md`: one note appended (Owner `ALM V1b-ii`).
- `playground/alm/alm-complete-product-description.md`: `:406-416` `overloaded` and "fairness joined in V1b-ii";
  after the V1b-i CURRENT paragraph (`:690`) **CURRENT — V1b-ii, fairness under many tracks and churn**; **PLANNED:**
  drops "fairness … (V1b-ii)" and adds the rotating claim order and a bound on the delivered marker.
- `docs/rallar-hetzner-distributed-recipes.md`: unchanged (it lists no cells).

**True of the code (verify each; fix the doc on a mismatch)**

- Task 1: `AL_VOLATILE_SESSION_OWN_SHARE = 0.5`; share `Math.floor(limit × 0.5)` per limit; refusal `total + 1 > max &&
  own + 1 > share` (count), `total + bytes > maxBytes && own + bytes > shareBytes` (bytes); `overloaded` with `bytes = 1`;
  report `{ usage, own, inbound, limits, overloaded }`; four limit names unchanged; the refusal carries `own`.
- Task 2: promotion only after a completed `release-buffered`; successor read by key (`toALInboundReleaseEffectId`,
  `readEntry`), claimed when due and claimable; `claimedCount < pageSize` (16); `promoted` required on `effect-drain`;
  the measured `[0,15,15,15,15]`, 5 / 17 batches.
- Task 3: `AL_INBOUND_MAX_ORDERING_TRACKS = 256`; eviction after the commit, guarded per snapshot, conflict → next track;
  delivered marker kept; `invokedTrackKeys` `maxEntries` 256 (insertion order); aggregates `LatestRepository`
  (`ttlMs` 30 min, `maxEntries` 4 096, `evictsPerWindow: 0`), the oldest ended `timed-out` at the cap.
- Task 4: `ordering-tracks` event and `<store id>/volatile`; `stats.rallar.alm.orderingTracks` (sum of latest per store,
  reset at `close`, 0 before a track); the cells' limits, counts, carriers and assertions as `task-4.md` states.

- [ ] **Step 1: Apply** the patch (or replay the hunks above). **Step 2: True-of-code checks** above.
- [ ] **Step 3: Format** `printf '%s\n' docs/rallar-api-reference.md packages/shared/alm/outbound/README.md
  packages/shared/alm/inbound/README.md packages/shared-web/browser/README.md
  packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
  packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
  packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md
  packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md
  playground/alm/alm-complete-product-description.md | xargs npx dprint fmt`, then the same list through
      `xargs npx dprint check` → exit 0.
- [ ] **Step 4: Checks.** `npx vitest run packages/tests/repo packages/tests/shared-web/rallar-group-public-contracts.test.ts
  packages/tests/shared-test/rallar-bb-test-schema.test.ts` → `Test Files  93 passed (93)`, `Tests  1244 passed (1244)`;
      `cd apps/api-v1 && deno test --allow-all test/swagger-routes.test.ts` → `14 passed | 0 failed`, then remove
      `apps/api-v1/node_modules/.deno` in the main worktree; after the commit `npm run check:repo-style:changed -- 853bfd33b
  HEAD` → `PASS: no new repository style findings`.
- [ ] **Step 5: Commit** with the message below.

**Commit message**

```text
Document fairness under many tracks and churn: the own share, promotion and the count bounds

The API reference's volatile bound states the two pools and the own share
(half of each limit, rounded down: 500 messages and 2 MiB): an own send
passes the count or byte limit only when it takes both the total past the
limit and the own pool past its share, arrivals are never refused, and the
total may exceed the limit; readUsage() names usage, own and inbound, and
overloaded is the refusal of the smallest next own send. Its ordering
section states the in-batch release of a buffered track's next sequence (5
batches for 64, 17 for 255) and the 256-snapshot cap per store, its
bounded-state paragraph the resync record's 256 tracks, and the storage
port its ordering-tracks event; the Limit names the delivered marker that
outlives an evicted snapshot.

The outbound README replaces "about 33 messages a second" with the measured
single-pool figures and the share rule, states the refusal's own figures,
the new overloaded condition, the resync record's cap and the WS server's
receipt aggregates (a LatestRepository of at most 4 096 within the 30 min
window, the oldest ended timed-out at the cap), and says the outbound claim
order stays the queue's own. The inbound README states the inbound pool,
promotion by keyed read within the page-size bound and its measured drain,
the snapshot cap with its post-commit eviction and the store's reporter, and
effect-drain's promoted. The browser README states the resync record's cap.

The black-box docs state stats.rallar.alm's own, inbound and orderingTracks,
the ordering-tracks storage event, the observation's pools, maxOrderingTracks
and promotedReleases, the three fairness cells, and a compatibility note. The
product description's fairness becomes current for the share, the promotion
and the bounds; replace-latest, the bounded queue, a rotating claim order and
a bound on the delivered marker stay planned.

D8 reuse: the volatile bound, ordering, storage-event, stats, observation and congestion prose of each document, extended in place; one compatibility note in the existing template.
```

### Task 6: Close

Pins unchanged and bundles measured; the static merge bar; `npm run test:postgres:integration` (a regression read for
the receipt aggregation, which api-v1 and the control server run); the conformance lane's two-agent family with the
three `fairness` cells over `ws`, `rtc` and `rtc-with-ws-fallback`; the three-seat final review BEFORE one fix wave;
push; the Branch Release Gate green on the code head; hosted manifests 18 and 22 dispatched fresh from the branch; the
PR body; the close commit with the delivered line; this plan file deleted.

- [ ] **Step 1: Pins and bundles.** `npx vitest run` the four pins (`al-indexeddb-transaction-ledger`,
      `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts` under
      `packages/tests/shared/alm/`) → `Test Files 4 passed (4)`, `Tests 27 passed (27)`; `git diff origin/main HEAD --`
      on the four files shows only the three `claimSuccessor: undefined,` lines of Task 2. Bundles with a private
      `TMPDIR`: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` (`browser/rallar.ts` 243.9 KiB of
      244 at composition) and `headless-bundle-boundary.test.ts` (310.674 KiB of 311 at composition); the public API
      snapshot and bundle-boundary tests pass unchanged (`Tests 18 passed (18)` with the headless test); a crossed
      budget rises to the next whole KiB, named in the PR body.
- [ ] **Step 2: Static merge bar.** `npm run typecheck`; `npm run build`; `npm run check:repo-style:changed --
      origin/main HEAD` (read the verdict line) and `node scripts/check-test-structure-coupling.mjs --changed
      origin/main HEAD`; `npm run check:test-reachability` (`1796 test files, 1790 reached by CI, 6 manual` at
      composition); `git diff --name-only origin/main HEAD | xargs npx dprint check`; `node --import tsx
      apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` → `checked 67 Hetzner distributed
      manifest(s)` and `git diff --stat origin/main HEAD -- apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json
      apps/rallar-black-box/manifests/hetzner/22-alm-conformance-3-agent.json` empty; `cd apps/api-v1 && deno task check`
      and `cd apps/rallar-black-box-control-server && deno task check`, then remove `.deno` under the main worktree's
      `apps/*/node_modules`; `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit`.
- [ ] **Step 3: Postgres integration.** With the test Postgres up (`docker ps` first; `docker start` a stopped
      container, `npm run db:test:up` only from this worktree), run `npm run test:postgres:integration` unsandboxed with
      the plain `DATABASE_URL` (the script's default `postgres://app:app@localhost:5432/appdb`, no `?schema=`
      parameter). The known reds are `rtc-topology-replay-consumer` and `topology-app-outbox-concurrency`; name every
      red from its output and classify any other.
- [ ] **Step 4: The conformance lane, unsandboxed on private ports.** `lsof -i :18480 -i :5480 -i :5481` first, so no
      other session's server is reused; then `VITE_RALLAR_API_BASE_URL=http://localhost:18480
      VITE_RALLAR_SPA_BASE_URL=http://localhost:5480 RALLAR_BLACK_BOX_CONTROL_BASE_URL=http://127.0.0.1:5481
      RALLAR_BLACK_BOX_ALM_SCOPE=full npm run test:rallar:full-stack:memory:alm -- -g "baseline family"` (the
      two-agent family over all three carriers; `RALLAR_BLACK_BOX_ALM_CARRIERS=ws|rtc|rtc-with-ws-fallback` runs one).
      The per-carrier budget is 15 minutes (`CARRIER_TEST_TIMEOUT_MS = 900_000`,
      `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts:117`); the cells add about 45 s over `rtc`,
      25 s over `ws` and 15 s over `rtc-with-ws-fallback` (estimate). Expected: `baseline family over ws (full)`,
      `… over rtc (full)` and `… over rtc-with-ws-fallback (full)` pass, the fairness cells last:
      `own-share-under-inbound` on all three (the receiver's own send `acknowledged`, `rallar.alm.inbound.admissions` ≥
      20, `rallar.alm.own.admissions` < 10, `rallar.alm.overloaded` false); `buffered-track-drains` on `ws` and `rtc`
      (65 arrivals within the default lifetime; over `rtc` an inbound `effect-drain` with `"promoted":` and a leading
      digit 1–9); `churn-bounded-tracks` on `rtc` (300 arrivals, `rallar.alm.orderingTracks` exactly 256). The lane's
      observation artifact carries `promotedReleases` on the inbound directions and `maxInboundAdmissions`,
      `maxInboundBytes`, `maxOrderingTracks` on the ledger block per cell. Diagnose a red cell from its artifact
      (Task 4's lane note).
- [ ] **Step 5: Final review, then one fix wave.** Three seats (product: the share rule and `overloaded`, the
      promotion invariants, the three bounds and their eviction semantics against D189–D192 and R-V1b-ii-1..3, -5..10,
      -16..19; harness: `stats.rallar.alm` with `own`, `inbound` and `orderingTracks`, the pushed count and its reset,
      the observation folds, the three cells and the withheld manifests, R-V1b-ii-20..26; code quality: the code
      standard, D3, D8 and the `packages/shared/cache` rule, the density limits, the required `claimSuccessor`, no ids)
      review the branch head before any fix; the controller rules on every finding and applies one fix wave; any fix
      reruns its task's checks and Steps 1–2.
- [ ] **Step 6: Push and gates.** Push the branch; the Branch Release Gate (`gh run list --branch
      claude/alm-v1b-ii-fairness`) green on the code head; rerun a known flake once with `--failed` before diagnosing
      it.
- [ ] **Step 7: Hosted manifests 18 and 22, dispatched fresh from the branch.** `gh workflow run
      hetzner-distributed-recipe.yml --ref claude/alm-v1b-ii-fairness -f ref=claude/alm-v1b-ii-fairness -f
      rollout_before_run=true -f manifest_path=apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`,
      and the same with `22-alm-conformance-3-agent.json`. A rerun is a new dispatch: `gh run rerun --failed` of that
      workflow is a no-op. Both are regression reads (the three cells are withheld) and now record `own`, `inbound` and
      `orderingTracks` in every browser agent's `stats.rallar.alm`; diagnose a red from its artifacts.
- [ ] **Step 8: PR body.** Goal; Changes per task; Public surface (`AL_VOLATILE_SESSION_OWN_SHARE`,
      `ALVolatileSessionPoolUsage`, `ALVolatileSessionReport.own`/`.inbound`, `ALVolatileSessionBudget.Refusal.own`, the
      capacity drop reason; `ALWorkHandlerDependencies.claimSuccessor`, `claimALInboundPromotedRelease`,
      `ALInboundWorkSelector.claimPromotedRelease`/`getPromotedCount`, `toALInboundReleaseEffectId`,
      `effect-drain.promoted`; `AL_INBOUND_MAX_ORDERING_TRACKS`, `WS_QUEUE_BOX_SERVER_MAX_RECEIPT_AGGREGATES`,
      `WsQueueBoxServerReceiptAggregation.EndedAggregate`/`RecordedAdmission` and `recordAdmission`'s result;
      `ALInboundOrderingTracksReport`, `reportOrderingTracks?`, the `ordering-tracks` storage event,
      `toALOrderingTracksReport`, `createBrowserALVolatileInboundRuntimeStores(name, budget, storage)`;
      `RallarBlackBoxTestAlmUsage`, `stats.rallar.alm.own`/`.inbound`/`.orderingTracks`; the observation's
      `maxInboundAdmissions`, `maxInboundBytes`, `maxOrderingTracks`, `promotedReleases`; the three cells; the headless
      budget 310 → 311); Acceptance; Validation with every red named; Rulings R-V1b-ii-1 to R-V1b-ii-30 and any the
      review adds; Corrections (this plan's list); Limits (this plan's list); Risk and rollback; Follow-ups (V1c, V1d;
      the delivered-marker bound, R-V1b-ii-3; the carries of design §5). End the body with the Claude Code attribution
      line.
- [ ] **Step 9: The close commit.** In `playground/alm/alm-improvement-plan.md`: the D189, D190, D191 and D192 rows
      each gain an "**As applied (V1b-ii):**" sentence where the code differs from the design: D189 "the four limit
      names stay and the refusal carries the own pool's figures (R-V1b-ii-7); the share is rounded down (R-V1b-ii-9);
      the `capacity*` cells keep their limits (R-V1b-ii-26)."; D190 "the successor is read by its work key and claimed
      as that read observed it, not taken from the page's deferred rows; only a completed buffered release promotes
      (R-V1b-ii-16, R-V1b-ii-18); 255 messages drain in 17 batches."; D191 "the cap bounds ordering snapshots only and
      the per-track delivered row is carried (R-V1b-ii-3); the eviction runs after the commit over the ordering-key
      prefix, not the expiry index (R-V1b-ii-1, R-V1b-ii-2); the resync record evicts in insertion order (R-V1b-ii-6);
      the server ends its oldest aggregate itself at the cap (R-V1b-ii-5)."; D192 "the ordering-snapshot count is pushed
      by the stores as `stats.rallar.alm.orderingTracks`, required, not read from `storage.counters` (R-V1b-ii-4,
      R-V1b-ii-20, R-V1b-ii-21); `effect-drain.promoted` and `orderingTracks` are required; the churn cell runs on rtc
      only and the buffered cell uses literal sends (R-V1b-ii-24, R-V1b-ii-25)." The "Releases 4 to 8" map row `| 7 V1
      |` replaces "V1b-ii, V1c, V1d open." with "(V1b-ii, `<head>`; #<pr>); V1c, V1d open." (so the cell reads
      "Delivered (V1a, `c37bda7`; #649); (V1b-i, `84472ce`; #650); (V1b-ii, `<head>`; #<pr>); V1c, V1d open."); the
      fresh-session paragraph replaces "V1b-ii is the active slice, designed in
      [alm-v1b-ii-design-proposal.md](alm-v1b-ii-design-proposal.md) (D189–D193) with its plan under `plans/active/`:
      fairness under many tracks and churn; V1c and V1d follow." with "V1b-ii is delivered (#<pr> as `<head>`, from
      [alm-v1b-ii-design-proposal.md](alm-v1b-ii-design-proposal.md), decisions D189–D193 with their "As applied" notes;
      its plan file is deleted with the close). V1c (15/30/50-agent manifests with ALM metrics against the declared
      budgets) is the next slice; V1d follows."; the revision history gains "<merge date> (V1b-ii delivered): #<pr> as
      `<head>`; the V1 map row, the F5/PC8 rows, the D189–D192 "As applied" notes and the fresh-session paragraph record
      it; V1c is next."; the requirement matrix's `| PC8 bounded protocol work |` row reads "Partial: the session
      ledger's four bounds and bounded retention (V1a, #649); backpressure as a congestion input (V1b-i, #650); fairness
      under many tracks and churn — an own share, in-batch promotion and count bounds on departed-sender state (V1b-ii,
      #<pr>); the scale runs open." with its owner column unchanged. In `playground/alm/alm-static-audit.md` the status
      table's `| F5 |` line reads "Partly closed: the volatile default and the per-session bound (S3), the age and track
      bounds and the usage metric (V1a), channel backpressure as a congestion input (V1b-i), the own share and the
      count bounds on departed-sender state (V1b-ii); the scale runs open (V1c, V1d)." with owner `S3, V1`. In
      `playground/alm/alm-v1b-ii-design-proposal.md` add "## 6. As applied (V1b-ii delivered)" with the four as-applied
      sentences above. Delete this plan file in the same commit. Never a blank line inside a table; `npx dprint fmt` the
      three files.
