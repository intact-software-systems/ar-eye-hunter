# ALM V1a: the session ledger's age and track budgets, its usage metric and bounded retention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development with test-driven development:
> one implementer per task, the failing tests first, the controller reviews and commits, one commit
> per task, a three-seat final review with one fix wave before the close. Steps use checkbox
> (`- [ ]`) syntax for tracking. The tasks run in the order 1 → 2 → 3 → 4 → 5 → 6.

**Goal:** Deliver Release 7, V1a (D179 to D183, `playground/alm/alm-v1a-design-proposal.md`). The per-session
volatile ledger gains an age bound (an outbound admission whose deadline lies more than 5 minutes ahead is refused)
and an active-track bound (an ordered send that would open a 65th ordering track is refused) beside its count and
byte bounds; the `capacity` refusal names the limit it passed. The ledger's usage (admissions, bytes, the oldest
counted admission's age, tracks), its four limits and `overloaded` are one report, read by the browser as
`rallar.messages.readUsage()`, by the black-box `stats` result as `rallar.alm`, and folded by the ALM lane's
observation into a `ledger` regime. The structures that grew for the owner's lifetime are bounded by repository TTLs
and one RTT counter, and a simulated hour proves the in-memory runtimes return to their baseline. Two lane cells,
`capacity-age` and `capacity-tracks`, prove the new bounds end to end; the docs state all of it.

**Architecture:** `ALVolatileSessionBudget` keeps its msgId map and release heap; each entry now carries its bytes,
admission time and track key (`toALOrderingTrackKey(msg)` in `toALVolatileSessionAdmission`; only an ordered send
with a key and a sequence holds a track), and a per-track admission count leaves with its last counted admission.
`tryAdmit` refuses `age`, then `admissions`, `bytes`, `tracks`; `readReport(nowMs)` is the ledger's only read. The
refusal's limit rides the outbound dispatch plan as `capacityLimit` into the refused admission verdict and the
`refused` failure (`limit?`, present exactly on a ledger `capacity` refusal). The browser middleware carries the
ledger as `volatileBudget`, which the messages controller reads through `requireMiddleware()`; the black-box page
runtime answers `readAlmUsage()`, which the `stats` command decodes into `rallar.alm`. The outbound send controls'
cancelled and handed-over ids and the resync recovery's invoked tracks become `LatestRepository` entries (60 minutes
and 5 minutes); the RTC receiver numbers RTT versions from one counter.

**Tech Stack:** TypeScript on Node (Vitest, Playwright, esbuild bundle budgets) and Deno (api-v1, the control
server: `deno test`, `deno check`); dprint.

**Spec:** `playground/alm/alm-v1a-design-proposal.md`; decisions D179–D183 in `playground/alm/alm-improvement-plan.md`
(decision table and the "Release 7, V1a design" section), as amended by the rulings below; surveys
`.superpowers/sdd/v1-survey/{facts-budgets,facts-scale}.md`.

## Global constraints

- **The maintainer's notes stand: "No legacy, avoid duplication, no migration code, keep the repo consistent,
  prefer existing patterns."** No wire or schema bump: `messages.send.ttlMs` keeps its schema; the connect's
  `almVolatileLimits` gains two optional wire fields read as the constants when absent (R-V1a-3).
- **The four bounds and the limit on the refusal (D179):** the per-session volatile ledger counts at most 1 000
  admissions (`AL_VOLATILE_SESSION_MAX_ADMISSIONS`) and 4 MiB (`AL_VOLATILE_SESSION_MAX_BYTES`), refuses an outbound
  admission whose deadline lies more than `AL_VOLATILE_SESSION_MAX_AGE_MS` (5 minutes) ahead, and refuses an ordered
  send that would open a track while `AL_VOLATILE_SESSION_MAX_TRACKS` (64) are counted; a track is counted while the
  ledger holds a counted admission on it and leaves with its last one; a received message never opens a counted track
  and is never refused (D74). Every refusal is `refused/capacity` with `limit: 'admissions' | 'bytes' | 'age' |
  'tracks'`; the RTC origin's `overloaded → capacity` drop names no limit (R-V1a-1); `overloaded` stays the count or
  byte bound reached (R-V1a-7).
- **The metric and its readers (D180):** `ALVolatileSessionUsage { admissions, bytes, oldestAgeMs, tracks }`;
  `ALVolatileSessionReport { usage, limits, overloaded }` from `readReport(nowMs)`; the facade's
  `rallar.messages.readUsage()` (synchronous, no event, throws the not-connected error before the connect and after a
  disconnect); the black-box `stats` result's `rallar.alm` (and `health`'s stats), absent before the page connects
  and in the control client's periodic stats and final report (R-V1a-12); the lane observation's `ledgerReadings` and
  `ledger` regime, unasserted; no new command kind.
- **The retention rule (D181, as applied by R-V1a-18..21):** the ledger's age budget bounds counted admissions, not
  ordering state: the volatile pairs keep their one-hour ordering-track TTL. What grew for the owner's lifetime is
  bounded: the send controls' cancelled and handed-over ids are `LatestRepository` entries with
  `DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes, the durable row retention); the browser resync recovery's invoked tracks
  a `LatestRepository` with `AL_VOLATILE_SESSION_MAX_AGE_MS`; the RTC receiver numbers every peer's RTT measurements
  from one counter. No new sweep or timer: the repositories evict on access.
- **The proof (D182):** unit pins per bound and per usage field; a simulated hour on a fake clock over the in-memory
  runtimes; lane cells `capacity-age` and `capacity-tracks` in the `addressed` family beside `capacity` (R-V1a-24),
  withheld from hosted manifests 18 and 22, which stay byte-identical.
- **D3:** no compatibility window. A changed contract changes everywhere in the same task; no `?:` added "for now"
  (`limit?` on the refusal is optional because a non-capacity refusal has none; `alm?` on the stats block because a
  page that has not connected reads none; the wire's `maxAgeMs`/`maxTracks` because manifest 18's connects name two
  fields).
- **D8 reuse first.** Search `packages/**` for an existing pattern before writing one; delete what becomes unused in
  the same task; no raw Maps where `packages/shared/cache` repositories (`LatestRepository`,
  `ObservableLatestRepository`: `ttlMs`, `maxEntries`, `isValid`, timer eviction) fit — this slice's retention work is
  exactly that rule (the ledger's own Maps stay: a repository has no release hook, R-V1a-5). Every task carries a D8
  reuse inspection paragraph and its commit one `D8 reuse:` line.
- **No ids in code, tests or docs:** no plan, task, PR or ruling id in code or tests; decision ids (D179 …) only in
  docs and source doc comments.
- **No guarantee weakens.** The four pins (`al-indexeddb-transaction-ledger`, `al-indexeddb-operation-counts`,
  `al-storage-snapshot`, `al-indexeddb-empty-audience-counts`) keep every figure (`al-indexeddb-operation-counts`
  carries Task 1's three D3 follow-ups only, R-V1a-29); hosted manifests 18 and 22 stay byte-identical.
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical verbs; functions
  ≤40 lines; ≤3 positional parameters for a new function; `interface` for object contracts; required fields by
  default; `Either` for expected failure; kebab-case filenames after the primary export; no role folders; no narration
  comments; one canonical name per type (no alias of a shared type on the facade). Tests live under
  `packages/tests/**` mirroring the source.
- **Formatting:** `npx dprint fmt <explicit file list>` on touched files only (pipe a list through `xargs`; zsh does
  not split `$(...)`).
- **Per-task checks:** the focused Vitest files; `npx tsc -p
  packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit`; `deno check` from the repo root on
  every changed `packages/shared/**` file; `cd apps/api-v1 && deno task check` when a type a Deno app consumes
  changes, then `rm -rf apps/api-v1/node_modules/.deno`; `node scripts/check-tests-typecheck.mjs`; the four pins; the
  bundle checks with a private `TMPDIR` (`mktemp -d /tmp/claude-501/b.XXXX`) after any `packages/shared`,
  `shared-web` or `shared-test` change (`npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` and
  `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`; budgets: `browser/rallar.ts` 243 from
  Task 1, headless 309 from Task 2; a crossed budget rises to the next whole KiB with the measured figure in the commit
  message); for a public shared-web change `shared-web-public-api-snapshots.test.ts` and
  `shared-web-browser-bundle-boundaries.test.ts`; after the commit `npm run check:repo-style:changed -- e1e05aa8e HEAD`
  (read the verdict line: the script exits 0 on FAIL), `node scripts/check-test-structure-coupling.mjs --changed
  e1e05aa8e HEAD` and, when a test file is added or deleted, `npm run check:test-reachability`.
- **Sandbox notes.** Loopback binds fail (`listen EPERM`): name those suites as sandbox reds
  (`api-v1-rtc-rtt-recipe-semantics` 5, `api-v1-state-write-convergence-recipe` 4, `local-websocket-session` 1,
  `live-rtc-control-client` 13, `headless-worker-script` 2); pglite and CLI-subprocess 5 s timeouts under load pass
  alone (`api-v1-crdt-append-history-recipe`, `scenario-black-box-config`); `npx tsx` fails on its IPC pipe (use `node
  --import tsx`); `pgrep` fails under the sandbox; `git fetch`, `gh` and the Playwright lane need the sandbox off. The
  api-v1 and control-server `node_modules` are shared across worktrees: remove `.deno` after a Deno run, only when no
  other Deno suite runs. Do not run `npm run test:unit` per task.
- **Git.** One commit per task with one `D8 reuse:` line and no attribution lines; the controller commits and pushes
  after review; never `git stash`; the PR body is written at the close.
- **Task order:** 1 → 2 → 3 → 4 → 5 → 6.

## File structure

| Area                              | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ledger and refusal (1)            | `packages/shared/alm/volatile-budget/{al-volatile-session-budget,to-al-volatile-session-admission,to-al-volatile-session-qos-provider}.ts`; `packages/shared/alm/outbound/{al-outbound-message-runtime,compute-al-outbound-dispatch}.ts`, `outbound/lane/admit-al-outbound-volatile-budget.ts`; `packages/shared/alm/delivery/{al-delivery-lifecycle,al-delivery-failure,compute-al-delivery-lifecycle}.ts`; `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`; `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/{decode-black-box-rallar-connection-config,connection/black-box-rallar-volatile-limits}.ts`; `rallar-bb-test/conformance/alm/scenarios/capacity.ts`; `packages/shared-web/browser/connection/create-browser-session-volatile-bound.ts`; `packages/shared-web/bundle-budgets.json`; 21 test files (36 files) |
| Facade, stats and observation (2) | `packages/shared-web/browser/{rallar-connection-facade,rallar,rallar-core,rallar-messages}.ts`, `browser/connection/initialise-browser-middleware.ts`, `browser/messages/{rallar-message-operations,browser-rallar-messages-controller}.ts`, `browser/composition/browser-communication-composition.ts`; the black-box runtime contract, composition and connection runtime; `rallar-bb-test/alm/decode-al-volatile-session-report.ts` (new); the page bridge, command contracts, test runtimes and stats contracts; `conformance/alm/{alm-observation-snapshot,compute-alm-observation-regime}.ts`; `rallar-bb-test/docs/{schema-and-capabilities,alm-observation-artifact}.md`; `headless-bundle-budget.json`; four new and eleven edited test files (37 files)                                                                                                        |
| Retention and the hour (3)        | `packages/shared/alm/outbound/lane/al-outbound-send-controls.ts`, `outbound/al-outbound-message-runtime.ts`; `packages/shared/services/web-rtc-rx-streamer-service.ts`; `packages/shared-web/browser/messages/browser-resync-recovery.ts`, `browser/composition/{browser-communication-composition,create-rallar-facade}.ts`; `browser-rallar-runtime-composition.ts`; `al-session-retention-long-run.test.ts` (new) and three edited test files (11 files)                                                                                                                                                                                                                                                                                                                                                                                                              |
| Lane cells (4)                    | `rallar-bb-test/conformance/alm/scenarios/volatile-bound/{capacity,capacity-age,capacity-tracks,volatile-bound-commands}.ts` (`capacity.ts` moved); `alm-conformance-scenario-definition.ts`, `create-alm-conformance-recipes.ts`; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`; four edited test files (12 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Docs (5)                          | `docs/rallar-api-reference.md`; `packages/shared/alm/{inbound,outbound}/README.md`; `packages/shared-test/rallar-bb-test/docs/{schema-and-capabilities,schema-compatibility-guide}.md`; `playground/alm/alm-complete-product-description.md` (6 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Close (6)                         | the pins, the gates, the lane run, the review, the PR body, the roadmap's delivered lines and as-applied notes, D87's figures, the audit's F5 and F13 rows, the requirement matrix's PC8 row, the design proposal's as-applied section, this file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Task order

1 (the ledger's bounds and the refusal's limit) → 2 (the facade read, the `stats` block, the observation) → 3
(retention and the simulated hour) → 4 (the lane cells) → 5 (docs) → 6 (close). Task 2 consumes Task 1's
`readReport`, `ALVolatileSessionReport` and `AL_VOLATILE_SESSION_LIMITS`. Task 3 consumes Task 1's
`AL_VOLATILE_SESSION_MAX_AGE_MS`, `AL_VOLATILE_SESSION_LIMITS` and `readReport` (its long-run test) and edits two files
Task 2 also edits (`browser-communication-composition.ts`, `browser-rallar-runtime-composition.ts`; anchors below are
at Task 2's commit). Task 4 consumes Task 1's limits, constants and the decoder's `failure.limit`, and moves the
`capacity.ts` Task 1 edited; its lane cells need Tasks 1 and 2. Task 5 states what Tasks 1–4 built and is checked
against them; it adds neither of the two doc paragraphs Task 2 owns (R-V1a-15).

The composed commits (scratch tree `scratch/v1a-assemble`, each `git am`-able on its predecessor from the design head
`e1e05aa8e`): `final-patch-task-1.patch` … `final-patch-task-5.patch` under `.superpowers/sdd/v1a-plan/` —
`429fb0b66`, `289088559`, `cde2e0812`, `75b11b51a`, `6597c6d50`. Files touched by two tasks:
`al-outbound-message-runtime.ts` (Tasks 1, 3), `director-at-volatile-bound.test.ts` (Tasks 1, 2),
`browser-communication-composition.ts` and `browser-rallar-runtime-composition.ts` (Tasks 2, 3), `capacity.ts` (Task 1
edits, Task 4 moves), `schema-and-capabilities.md` (Tasks 2, 5); every other anchor holds at the design head and at its
task's parent alike.

## Rulings

- **R-V1a-1:** the RTC overlay's `overloaded → capacity` translation names no limit; a limit appears only when the
  ledger refused. _Cost if wrong:_ one optional field on one translation.
- **R-V1a-2:** `readReport(nowMs)` is the ledger's only public read; `readUsage` and `isOverloaded` are deleted (~40
  call sites rewritten in Task 1). _Cost if wrong:_ two thin readers re-added.
- **R-V1a-3:** the black-box decoder reads `maxAgeMs` and `maxTracks` sparsely with the constants as defaults, so
  manifest 18's two-field connects stay valid; Task 4 writes the four fields only in its own cell. _Cost if wrong:_
  required fields would change manifest 18 and force a hosted re-record.
- **R-V1a-4:** `AL_VOLATILE_SESSION_LIMITS` holds the four production limits and replaces two duplicated literals.
  _Cost if wrong:_ one constant.
- **R-V1a-5:** the ledger keeps its Maps and release heap: `LatestRepository`'s eviction has no release hook, so an
  exact byte total and per-track count could not fall at each entry's own deadline. _Cost if wrong:_ a reviewer
  applying the cache rule literally; a repository would lose the exact running totals.
- **R-V1a-6:** the refusal order is age, admissions, bytes, tracks. _Cost if wrong:_ which limit a send past several
  bounds names.
- **R-V1a-7:** `overloaded` is the count or byte bound reached; the age and track bounds refuse a send without
  shedding others. _Cost if wrong:_ the RTC origin would shed every send at the track bound.
- **R-V1a-8:** the limit rides the dispatch plan as `capacityLimit?` into the refused verdict and the refused failure;
  absent on carrier-refused settlements (`capacity` is never a fallback reason). _Cost if wrong:_ one optional field's
  route.
- **R-V1a-9:** `oldestAgeMs` reads the first held entry in admission order, clamped at 0. _Cost if wrong:_ one read.
- **R-V1a-10:** the refusal text reads "The session's volatile bound refused the send (<limit>): … tracks, a deadline
  at most … ms ahead." _Cost if wrong:_ prose.
- **R-V1a-11:** the ledger reaches the facade as `RallarBrowserMiddleware.volatileBudget`, read through
  `requireMiddleware()`, which throws "Rallar is not connected. Call rallar.connect() first." _Cost if wrong:_ one
  middleware field.
- **R-V1a-12:** only the runtime's `stats` command (and `health` through `updateStats`) reads the ledger, through the
  page method `readAlmUsage()` (required on both runtime contracts; `undefined` while disconnected; a malformed answer
  fails `stats` with a `TypeError`); the control client's periodic stats and final report carry no `alm`. _Cost if
  wrong:_ V1c/V1d need an async page read to put the ledger into the periodic envelopes (a Limit).
- **R-V1a-13:** one `decodeALVolatileSessionReport` serves the page boundary (fold → throw) and the snapshot (fold →
  skip). _Cost if wrong:_ one decoder.
- **R-V1a-14:** the regime's `ledger` is `{ outcome: 'measured', readingCount, maxAdmissions, maxBytes, maxOldestAgeMs,
  maxTracks, overloadedReadings } | { outcome: 'no-readings' }`, maxima per page per reading, computed by a private
  `computeLedger` (the `conformance/alm` directory sits at its density threshold). _Cost if wrong:_ the artifact field
  shape V1c reads.
- **R-V1a-15:** Task 2 owns the `stats.rallar.alm` paragraph of `schema-and-capabilities.md` and the `ledger` bullet
  of `alm-observation-artifact.md`; Task 5 cross-checks and adds neither. _Cost if wrong:_ doc placement.
- **R-V1a-16:** six shared-web `RallarMessagesOperations` doubles get a throwing `readUsage`; the black-box facade
  double is scriptable (`isConnected`, `readUsage`); the facade test asserts a wall-clock range because
  `browserDeliveryComposition.nowMs` captures `Date.now` at module load. _Cost if wrong:_ test-only.
- **R-V1a-17:** the headless budget rises 308 → 309 (308.241 KiB measured at Task 2). _Cost if wrong:_ one figure.
- **R-V1a-18 (amends D181):** the volatile pairs' ordering-track TTL STAYS one hour: a receiver that forgets a track
  inside a session reads the sender's next seq as a gap (or a forced resync past 256), so a 5-minute TTL would stall
  any ordered track quiet for 5 minutes; a guard test pins the hour; the retained cost (two inbound rows per idle track
  per hour, one outbound version row per origin per hour) is a bounded plateau, a Limit carried to V1d. _Cost if
  wrong:_ D181's first clause undelivered in V1a; a real bound needs an inbound track cap or a "fresh start" meaning
  for an absent snapshot (a protocol decision).
- **R-V1a-19 (amends the writers' proposal):** the send controls' cancelled and handed-over repositories take ONE
  fixed TTL, the durable row retention `DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes), not the age budget: the controls
  span every lane, and a cancelled durable message picked up after 5 minutes must still not send; growth stays bounded
  to an hour of ids. Applied at assembly in Task 3. _Cost if wrong:_ one constant.
- **R-V1a-20:** the per-peer RTT version table becomes one counter for all peers (deleting per peer breaks the
  server's stale check and the pinned cross-replacement test). _Cost if wrong:_ per-pair versions are no longer dense
  (2, 3 → 5 …); nothing depends on it.
- **R-V1a-21:** the simulated hour runs on the in-memory runtimes (outbound: ledger, memory pair, send controls;
  inbound: ledger, memory pair); the resync set and the RTT counter have unit tests in their own trees; private sizes
  are read through prototype spies; no timer on the repositories (eviction on access); a track silent longer than the
  age budget that resyncs again invokes the recovery handler again. _Cost if wrong:_ a reviewer may reject the spies
  (alternative: a `getRetainedMessageCount()` read, precedent `BrowserRallarDeliveryRegistry.size()`); an idle owner
  keeps its last hour of ids until its next call; one owner invoked twice for a long-lived broken track.
- **R-V1a-22:** V1d carries the two one-hour plateaus as its growth judgement's baseline. _Cost if wrong:_ V1d's
  baseline.
- **R-V1a-23:** Task 5's D181 claims and the outbound README's "owner's lifetime" lines reconcile to R-V1a-18..20.
  _Cost if wrong:_ doc lines.
- **R-V1a-24:** the cells join the `addressed` family beside `capacity` (where `capacity` runs, `capacity.ts:64`); all
  three live under `scenarios/volatile-bound/` (`scenarios/` sits at the 20-file density threshold). _Cost if wrong:_
  a moved file.
- **R-V1a-25:** `capacity` keeps its assertions (no `failure.limit bytes`), so manifest 18 stays byte-identical; the
  `bytes` limit is proven by Task 1's unit tests. _Cost if wrong:_ no lane proof of `limit: 'bytes'`.
- **R-V1a-26:** `capacity-age` sends a 301 s ttl under the production constants (`messages.send.ttlMs` has no schema
  maximum) with no reconnect. _Cost if wrong:_ a future ttl maximum would need a lowered-`maxAgeMs` reconnect.
- **R-V1a-27:** the override change gets a new compatibility note (Owner `ALM V1a`); the 2026-09-29 note stays; the
  API reference, the outbound README and the product description say `overloaded` means the count or byte limit.
  _Cost if wrong:_ one note.
- **R-V1a-28 (assembly):** the assembler brief's Limits and Corrections lists named A2b's carries (server
  publications, claim events, other scopes, Relic, the loss headline, "ResourceInbox-backed", the scope list, the
  `messages.send` field-list drift) and a "two-agent" lane family; none is V1a's. This plan carries V1a's own limits
  and corrections below and runs the lane's `addressed` family (R-V1a-24). _Cost if wrong:_ wording of two sections
  and one `-g` filter; no code.
- **R-V1a-29 (assembly):** "the four pins unchanged" means their figures: `al-indexeddb-operation-counts.test.ts`
  carries Task 1's three D3 follow-ups (`AL_VOLATILE_SESSION_LIMITS`, `readReport(…).usage.admissions` twice) and no
  expected count moves. _Cost if wrong:_ none that D3 allows; a shim to keep the file untouched is a compatibility
  window.
- **R-V1a-30 (assembly):** R-V1a-19 moved the outbound hour test's checkpoints: the ledger, the pair's one version
  row and the empty work queue at the last step + 5.5 min; the pair `[]` and the two send-control repositories `[1, 1]`
  at the last step + 60 min + 1 ms (the version row's own hour has passed too). The Task 3 commit's subject and body
  are rewritten to the TTLs it applies. _Cost if wrong:_ one test's checkpoints and one subject line.
- **R-V1a-31 (assembly):** the close's "As applied" amendment covers D179 (a track leaves with its last counted
  admission, not its head's row; the ledger's read is `readReport(nowMs)`), D180 (only `stats`/`health` read the
  ledger), D181 (R-V1a-18..20) and D182 (the `addressed` family; the lane's track cell refuses the third track at a
  lowered bound of 2, the 65th is a unit pin), in the design proposal and the roadmap's decision rows. _Cost if
  wrong:_ roadmap wording.
- **R-V1a-32 (assembly):** at composition each task's focused files, typechecks and gates ran on its own commit; the
  broad sweeps ran on Task 3's commit and the final head (Tasks 1 and 2 are tree-identical to the writers' commits,
  whose broad sweeps are recorded in their tasks). _Cost if wrong:_ an intermediate red invisible at Tasks 1, 2 or 4
  — the per-task SDD run reruns each task's own checks.

## Limits (carried; Task 6 states them in the PR body)

- The ledger's age budget bounds counted admissions, not ordering state: the volatile pairs keep an ordering track
  for an hour after its last message (R-V1a-18).
- The one-hour per-track plateau — two inbound rows per idle track, one outbound version row per sending origin — is
  V1d's growth judgement's baseline (R-V1a-22).
- The control client's periodic stats and final report carry no `alm` block; only the `stats` command (and
  `health`'s stats) does (R-V1a-12).
- `overloaded` means the count or byte bound only; the RTC origin's congestion drop names no limit (R-V1a-1,
  R-V1a-7).
- A track silent longer than the age budget that resyncs again invokes the recovery handler again (R-V1a-21).
- The `bytes` limit on the refusal is proven only by unit tests; manifest 18 is unchanged (R-V1a-25).
- Only an app-sequenced ordered send opens a counted track: a browser room send names no `seq` unless the caller
  does (`al-contract.ts:349-352`), so a platform ordered send holding a track after `capacity-tracks`' reconnect would
  shift its refusal (none found; Task 4's lane note).
- Cancelled and handed-over ids are kept 60 minutes and swept on access: an idle owner keeps its last hour of ids
  until its next call (R-V1a-19, R-V1a-21). Per-pair RTT versions are no longer dense (R-V1a-20).
- The cells are local and the hosted full read's: manifests 18 and 22 withhold them and stay byte-identical (D182).
- Carried (design §5): fairness and channel backpressure as policy inputs (V1b); the 15/30/50-agent manifests, ALM
  metrics asserted against the declared budgets and `controller-NN` attribution (V1c); the 60-minute run (V1d); a
  server-side ledger; exempting platform topics from the bound (the maintainer's open decision); receipt-latency
  percentiles; browser memory as a metric.

## Corrections and notes (Task 6 states them in the PR body's Corrections)

- **D181 as designed would stall ordered tracks:** a 5-minute volatile ordering TTL makes the next sequence of a track
  idle for 5 minutes a gap; the TTL stays one hour (R-V1a-18). Deleting a peer's RTT entry restarts a replaced peer
  below the server's stale floor; one counter replaces the table (R-V1a-20). The send controls span every lane, so
  their TTL is the durable row retention, not the age budget (R-V1a-19). The close records these as applied
  (R-V1a-31).
- **D179's "a track leaves the count when its head's row expires":** it leaves with its last counted admission,
  released by the ledger's deadline heap; D180's ledger `readUsage()` is `readReport(nowMs)`, and the facade keeps the
  name `rallar.messages.readUsage()`.
- **D182's "two-agent family" and "the 65th track":** `capacity` runs in the `addressed` family, and the cells join it
  (R-V1a-24); the lane lowers the track bound to 2 and the third ordered send is refused; the 65th is Task 1's unit
  pin.
- **The planning frame's `plan.orderingRuntime` does not exist** (`al-outbound-message-runtime.ts:154-191`): the track key is
  `toALOrderingTrackKey(plan.msg)` in `toALVolatileSessionAdmission`.
- **The planning frame's per-lane send-control TTL is not expressible:** one `ALOutboundSendControls` instance serves all three
  lanes (`al-outbound-message-runtime.ts:456`), and `cancel`/`handOver` are synchronous and lane-blind.
- **The facade's clock is captured at module load** (`browser-delivery-composition.ts:8`), so fake `Date` timers do not
  reach `rallar.messages.readUsage()`; `updateStats` became async because the page read is (R-V1a-16).
- **D87's "10 plus 15 per send"** is corrected at the close to the pinned figures: 10 `al-admission` plus 9 `al-work`
  operations per durable send (`al-indexeddb-operation-counts.test.ts:228-250`), 8 per inbound admission.
- **The product description's "fairness are V1's" and "Channel backpressure … is V1's"** name V1b (Task 5); its
  `ws-then-rtc does not take a peer (V1)` line (`:224`) names the release row and is left as is.
- **The main worktree's `apps/api-v1/node_modules`** keeps `graphology`, `postgres` and `prisma` symlinked into
  `.deno` after any Deno run in a worktree that shares it; removing `.deno` leaves them dangling until the next Deno run
  or `npm install` repairs them.

## Tasks

### Task 1: The ledger's age and track bounds and the limit on the refusal (D179)

**Files** (anchors at the design head `e1e05aa8e`, this task's parent; the composed commit is
`.superpowers/sdd/v1a-plan/final-patch-task-1.patch` (`429fb0b66` on the scratch tree), `git am`-able there; 36 files,
+605/−285). Production:

- `packages/shared/alm/volatile-budget/al-volatile-session-budget.ts` (rewritten, 190 lines): after the two constants
  (`:4-5`) add `/** The furthest deadline an outbound admission may name: past it a send is refused, not held (D179). */
  export const AL_VOLATILE_SESSION_MAX_AGE_MS = 5 * 60_000;` and `/** The ordering tracks of this session's own ordered
  sends the bound holds at once (D179). */ export const AL_VOLATILE_SESSION_MAX_TRACKS = 64;`. New `export type
  ALVolatileSessionLimit = 'admissions' | 'bytes' | 'age' | 'tracks';`. `ALVolatileSessionLimits` (`:13-16`) gains
  required `maxAgeMs`, `maxTracks`; then `export const AL_VOLATILE_SESSION_LIMITS: ALVolatileSessionLimits` = the four
  constants (R-V1a-4). `ALVolatileSessionUsage` (`:18-21`) gains `/** How long ago the oldest counted admission was
  admitted; 0 when nothing is counted. */ oldestAgeMs: number` and `tracks: number`. New ``/** `overloaded` is the count
  or byte bound reached; the age and track bounds refuse a send without shedding others. */ export interface
  ALVolatileSessionReport { usage: ALVolatileSessionUsage; limits: ALVolatileSessionLimits; overloaded: boolean }`` (all
  readonly). `Admission` (`:24-29`) gains ``/** The ordering track an ordered send holds; `undefined` for an unordered
  message, which holds none. */ readonly trackKey: string | undefined;``; `Refusal.limit` (`:32`) becomes
  `ALVolatileSessionLimit`. Module-private `interface ALVolatileSessionEntry { bytes; admittedAtMs; trackKey: string |
  undefined }`. The class (doc: "Entries stay in admission order, so the first one held is the oldest; the release
  queue frees each at its own deadline, and a track leaves the count with its last counted admission.") holds
  `entriesByMsgId: Map<string, ALVolatileSessionEntry>` (replaces `bytesByMsgId`), `admissionsByTrackKey: Map<string,
  number>`, the unchanged `releases` heap and `bytes`. `tryAdmit`: `releaseDue`, `toUsage(nowMs)`, a held msgId answers
  the usage, else `resolvePassedLimit(input, usage)` (private method replacing the module function `:100-109`): `age`
  when `deadlineAtMs - nowMs > maxAgeMs`, then `admissions`, then `bytes` (as today), then `tracks` when `trackKey !==
  undefined`, the key is not in `admissionsByTrackKey`, and `usage.tracks >= maxTracks`. `record` (doc "A received
  message is never refused and never opens a counted track (D74, D179).") holds with the clamped deadline and
  `trackKey: undefined`. `readReport(nowMs): ALVolatileSessionReport` replaces `readUsage` and `isOverloaded`
  (deleted, R-V1a-2); `overloaded` = `admissions >= maxAdmissions || bytes >= maxBytes` (R-V1a-7). `hold` stores `{
  bytes, admittedAtMs: input.nowMs, trackKey }` and calls private `holdTrack(trackKey)` (+1); `releaseDue` deletes the
  entry, subtracts its bytes and calls `releaseTrack(trackKey)` (−1, delete at 0). `toUsage(nowMs)`: `oldestAgeMs` =
  `Math.max(0, nowMs - first entry's admittedAtMs)` via `entriesByMsgId.values().next().value`, else 0; `tracks` =
  `admissionsByTrackKey.size`. The release queue file is unchanged.
- `to-al-volatile-session-admission.ts`: import `toALOrderingTrackKey` from `../../al-contracts/al-runtime.ts`; the
  admission (`:20-25`) gains `trackKey: toALOrderingTrackKey(msg)`. `to-al-volatile-session-qos-provider.ts:21`:
  `budget.readReport(nowMs()).overloaded`.
- `packages/shared/alm/outbound/al-outbound-message-runtime.ts`: import (`:28`) adds `ALVolatileSessionLimit`;
  `ALOutboundDispatchPlan` after `dropReasonCode` (`:158`): ``/** The session volatile bound a `capacity` drop passed
  (D179); absent on a congestion drop the planner made. */ readonly capacityLimit?: ALVolatileSessionLimit;`` (R-V1a-8).
- `outbound/lane/admit-al-outbound-volatile-budget.ts`: `toCapacityRefusedPlan` (`:28-40`) sets `capacityLimit:
  refusal.limit` and the prose `` `The session's volatile bound refused the send (${refusal.limit}): ${usage.admissions}
  of ${limits.maxAdmissions} admissions, ${usage.bytes} of ${limits.maxBytes} bytes, ${usage.tracks} of
  ${limits.maxTracks} tracks, a deadline at most ${limits.maxAgeMs} ms ahead.` ``. New exported ``/** The refusal of a
  `capacity` drop; a congestion drop translated to `capacity` names no limit (D179). */ function
  toALCapacityRefusedVerdict(limit: ALVolatileSessionLimit | undefined, detail: string): ALDeliveryAdmissionVerdict`` →
  `{ kind: 'refused', reason: 'capacity', detail }` or `{ …, limit, detail }`.
- `outbound/compute-al-outbound-dispatch.ts`: import it after `:27`; `toALOutboundAdmissionVerdict` (`:281-291`) picks
  `'capacityLimit'` too; `case 'capacity'` leaves the refused group: `return toALCapacityRefusedVerdict(
  plan.capacityLimit, detail);` (inline it and the file's cognitive load hits 51 ≥ 50).
- `alm/delivery/al-delivery-lifecycle.ts`: import `ALVolatileSessionLimit` (after `:4`); the verdict's refused arm
  (`:86`): ``/** `limit` names the session volatile bound a `capacity` refusal passed (D179); absent on every other
  refusal. */ Readonly<{ kind: 'refused'; reason: ALDeliveryRefusalReason; limit?: ALVolatileSessionLimit; detail:
  string; }>``. `al-delivery-failure.ts:18` the same `limit?:` with the same doc (import after `:2`).
  `compute-al-delivery-lifecycle.ts:169`: `toFailureLifecycle(previous, toRefusedFailure(verdict), verdict.detail)`;
  private `toRefusedFailure(verdict: Extract<ALDeliveryAdmissionVerdict, Readonly<{ kind: 'refused'; }>>):
  ALDeliveryFailure` before `toReceiptExhaustedFailure` (`:323`) copies `limit` only when defined. `carrier-refused`
  stays limit-less: `capacity` is never a fallback reason (`resolve-al-delivery-fallback-trigger.ts:22-24`).
- `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`: import `ALVolatileSessionLimit` (after
  `:11`); `ALM_VOLATILE_SESSION_LIMITS: Readonly<Record<ALVolatileSessionLimit, true>>` before `ALM_SKIPPED_REASONS`
  (`:31`); `refused: decodeAlmRefusedFailure` (`:84-86`); before `decodeAlmReceiptExhaustedFailure` (`:150`): ``/** Only a
  `capacity` refusal may name the volatile bound it passed (D179). */`` — a bad reason or an absent limit decodes as
  today; a limit on another reason is `Either.ofLeft('failure.limit')`; else `decodeAlmFailureKey(…, failure.limit,
  'limit')`.
- `shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts`
  `decodeAlmVolatileLimits` (`:126-141`, doc "The wire names the count and byte bounds; a lane that lowers no age or track
  bound reads the constants (D179)."): destructure `{ maxAdmissions, maxBytes, maxAgeMs = AL_VOLATILE_SESSION_MAX_AGE_MS,
  maxTracks = AL_VOLATILE_SESSION_MAX_TRACKS, ...unknownFields }`; all four positive integers and no unknown field, else
  `'rallar.almVolatileLimits must name maxAdmissions and maxBytes and may name maxAgeMs and maxTracks, each a positive
  integer.'` (R-V1a-3). `connection/black-box-rallar-volatile-limits.ts`: `DEFAULT_LIMITS` (`:9-12`) deleted for
  `AL_VOLATILE_SESSION_LIMITS`. `rallar-bb-test/conformance/alm/scenarios/capacity.ts:43-46`: `{
  ...AL_VOLATILE_SESSION_LIMITS, maxBytes: 36_000 }` (its wire `:118-121` keeps two fields; manifests unchanged).
- `packages/shared-web/browser/connection/create-browser-session-volatile-bound.ts:24-29`:
  `readVolatileSessionLimits?.() ?? AL_VOLATILE_SESSION_LIMITS`. `packages/shared-web/bundle-budgets.json:2` 242 → 243.

Tests: `packages/tests/shared/alm/volatile-budget/al-volatile-session-budget.test.ts` (rewritten on `toLimits`/
`createBudget` over `AL_VOLATILE_SESSION_LIMITS`, `toAdmission` gains `trackKey`), `to-al-volatile-session-admission.test.ts`,
`outbound/al-outbound-volatile-budget.test.ts`, `outbound-admission-verdict.test.ts` (before `:200`),
`delivery/al-delivery-failure.test.ts` (row before `:139`), `multicast/web-rtc-overlay-volatile-overload.test.ts` (before
`:113`), `shared-test/alm-delivery-failure-decoding.test.ts`, `shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts`
(`:71` rewritten; `:159` listener typed `RallarBlackBoxBrowserWebSocketEvent`, its `boundary.unknown` finding). D3
follow-ups (four-field limits, `readReport(t).usage`/`.overloaded`, `trackKey: undefined`) in 14 more test files:
`shared/alm/{al-indexeddb-operation-counts, inbound/al-inbound-volatile-budget}.test.ts`,
`volatile-budget/to-al-volatile-session-qos-provider.test.ts`, `shared-test/rallar-browser-runtime/connection.test.ts`,
`shared-web/{al-runtime/browser-al-runtime-stores, composition/browser-runtime-construction,
connection/browser-transport-cleanup, connection/create-browser-session-volatile-bound,
connection/initialise-browser-middleware, director/director-at-volatile-bound, rtc/initialise-browser-rtc-runtime,
websocket/create-browser-web-socket-queue-box}.test.ts`, `shared-web/default-volatile-session-budget.ts`.

**Interfaces produced** (Tasks 2, 3 and 4 consume): `AL_VOLATILE_SESSION_MAX_AGE_MS`, `AL_VOLATILE_SESSION_MAX_TRACKS`,
`AL_VOLATILE_SESSION_LIMITS`, `ALVolatileSessionLimit`, four-field `ALVolatileSessionLimits`,
`ALVolatileSessionUsage { admissions, bytes, oldestAgeMs, tracks }`, `ALVolatileSessionReport`,
`ALVolatileSessionBudget.readReport(nowMs)`; `failure.limit` on a ledger `capacity` refusal; the connect's
`almVolatileLimits` decodes `maxAgeMs`/`maxTracks` (Task 4 only writes them). **Consumed**: nothing new.

**D8 reuse inspection.** The ledger's msgId map, release heap and lazy release carry age and tracks;
`toALOrderingTrackKey` names the track; the drop code carries the limit on the existing plan. `LatestRepository` does not
fit: its eviction has no release hook, so an exact byte total and per-track count could not fall at each entry's own
deadline (R-V1a-5). `AL_VOLATILE_SESSION_LIMITS` replaces two duplicated default-limit literals. Deleted: `readUsage`,
`isOverloaded`, `resolveALVolatileSessionPassedLimit`, `DEFAULT_LIMITS`.

- [ ] **Step 1: Write the failing tests** (copy from the patch). Ledger, inside "the per-session volatile budget (D74)":
      "holds an age bound of five minutes and a track bound of 64 beside the count and byte bounds"; "refuses an outbound
      admission whose deadline lies past the age bound, names that limit and counts nothing for it" (`maxAgeMs: 60_000`,
      +60 001 → left `{ limit: 'age', usage: { admissions: 0, bytes: 0, oldestAgeMs: 0, tracks: 0 }, limits }`, +60 000
      admitted); "refuses the ordered send that would open a track past the track bound and admits one on a counted
      track" (`maxTracks: 2`; `track-c` → `tracks`; `track-a` again and an unordered send admitted, usage `{ 4, 400, 0, 2
      }`); "releases a track with its last counted admission, which lets the next track open"; "never opens a counted
      track for a recorded inbound admission"; "reads the age of the oldest counted admission, and 0 when nothing is
      counted" (1 500 at +1.5 s and at +2.5 s, 0 at +9 s); "reports its usage, its limits and whether it is overloaded in
      one read"; "is not overloaded at the track bound, which refuses only a send that opens another track"; "keeps an
      outbound admission counted until its own deadline, up to the age bound" (replaces "…however far"). Admission:
      "names the ordering track of an ordered message, which an unordered key without a sequence does not hold"
      (`moves:self:0`). Outbound: the 1 001st now also `limit: 'admissions'`; "refuses a volatile send whose deadline
      lies past the age bound with the limit age, and counts nothing" (ttl `MAX_AGE_MS + 1_000` → `{ kind: 'refused',
      reason: 'capacity', limit: 'age', detail: stringContaining('(age)') }`, entries `[]`); "refuses the ordered send
      that opens a track past the track bound with the limit tracks" (`maxTracks: 1`; usage `{ admissions: 3, tracks: 1
      }`). Verdict: "is refused as capacity with the limit the session volatile ledger names". Failure row "a refusal past
      the age bound of the session volatile ledger". Overlay: "names no limit on that refusal, which congestion made
      before the session ledger was asked" (`not.toHaveProperty('limit')`). Decoder: `{ refused, capacity, limit: 'tracks'
      }` round-trips; `limit: 'rate'` and a limit on `unsupported` fail at `failure.limit`. Bridge: "decodes the lane-only
      volatile limits of a connect, reading the age and track bounds the connect leaves out as the constants".
- [ ] **Step 2: Run red.** `cat <list> | xargs npx vitest run` over the 20 test files of the commit (`git show
      --name-only --format= HEAD | grep '\.test\.ts$'`): 13 files failed; 56 failed, 180 passed (236); e.g. `TypeError:
      budget.readReport is not a function` (31), `expected undefined to deeply equal { limit: 'age', … }`.
- [ ] **Step 3: Implement** as listed. Green: 20 files, 236 passed.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared/alm packages/tests/shared/multicast
      packages/tests/shared/services packages/tests/shared-web packages/tests/shared-test packages/tests/rallar-black-box
      packages/tests/rallar-black-box-headless` (713 files at the prototype, whose tree the composed commit equals; only the
      known sandbox reds: `live-rtc-control-client`,
      `local-websocket-session`, `api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe` (EPERM),
      `headless-worker-script`; the four IndexedDB pins pass with every figure unchanged —
      `al-indexeddb-operation-counts.test.ts` carries only the three D3 follow-ups, R-V1a-29); `npx tsc -p packages/shared/tsconfig.json
      --noEmit`, `npx tsc -p packages/shared-web/tsconfig.json --noEmit`, `npm --workspace @ar-eye-hunter/shared-test run
      typecheck`, `npx tsc -p packages/shared-server/tsconfig.json --noEmit`; `deno check` on the changed
      `packages/shared/**` files; `cd apps/api-v1 && deno task check`, then `rm -rf apps/api-v1/node_modules/.deno`;
      `node scripts/check-tests-typecheck.mjs` (PASS); `node --import tsx
      apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` (`checked 67`); with `TMPDIR=$(mktemp
      -d /tmp/claude-501/b.XXXX)`: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
      (`browser/rallar.ts` 242.151 KiB < 243), `npx vitest run packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
      packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
      packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` (headless 307.740 KiB < 308). `npx dprint
      fmt` on the touched files (through `xargs`).
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- e1e05aa8e HEAD` (`PASS: no new repository style
      findings`), `node scripts/check-test-structure-coupling.mjs --changed e1e05aa8e HEAD` (PASS, 2 touched candidates
      already classified). No test file is added.

```text
Bound the session volatile ledger by age and active tracks and name the limit on a capacity refusal

The per-session volatile ledger keeps its count and byte bounds and gains
two more. An outbound admission whose deadline lies more than
AL_VOLATILE_SESSION_MAX_AGE_MS (5 minutes) ahead is refused with the
limit age. An ordered send that would open a 65th ordering track
(AL_VOLATILE_SESSION_MAX_TRACKS) is refused with the limit tracks; a
track is counted while the ledger holds a counted admission on it and
leaves with its last one, released by the existing deadline heap. A
received message never opens a counted track and is never refused. Each
entry now carries its bytes, its admission time and its track key, so
the usage reads oldestAgeMs and tracks beside admissions and bytes.

readReport(nowMs) answers usage, limits and overloaded in one value and
replaces readUsage and isOverloaded; overloaded stays the count or byte
bound reached, so the track bound refuses only the send that would open
another track. AL_VOLATILE_SESSION_LIMITS names the four production
limits the browser composition and the black-box override read.

The refusal's limit rides the dispatch plan as capacityLimit into the
refused admission verdict and the refused failure, present exactly when
the ledger refused; the RTC overlay's congestion drop translated to
capacity names none. The black-box failure decoder reads limit on a
capacity refusal only, and the connect's almVolatileLimits may name
maxAgeMs and maxTracks, reading the constants when it leaves them out,
so the hosted manifests stay byte-identical (checked 67).

Bundles: browser/rallar.ts measures 242.151 KiB (base 241.942) and
crossed 242, raised to 243; the headless agent 307.740 KiB against 308.

D8 reuse: the ledger's msgId map, release heap and lazy release carry the age and track dimensions, toALOrderingTrackKey names the track, and the plan's drop code carries the limit; LatestRepository does not fit an exact running total that must fall at each entry's own deadline.
```

### Task 2: The facade read, the harness `stats` block and the lane observation's ledger readings (D180)

**Files** (anchors at Task 1's composed commit, this task's parent; the composed commit is
`.superpowers/sdd/v1a-plan/final-patch-task-2.patch` (`289088559`), `git am`-able there; 37 files, +606/−21; no
`packages/shared` source change: Task 1's `readReport` is the only ledger read used)

- `packages/shared-web/browser/rallar-connection-facade.ts`: `RallarBrowserMiddleware` (`:39-48`) gains
  `readonly volatileBudget: ALVolatileSessionBudget;` doc "The session's volatile ledger, which both carriers' runtimes count
  against (D74)." (type import from `@shared/alm/volatile-budget/al-volatile-session-budget.ts` before the `AuthSession` import).
- `packages/shared-web/browser/connection/initialise-browser-middleware.ts:264`: the returned `middleware` object, written one
  member per line, adds `volatileBudget: transportInput.volatileBound.budget` (the budget built once at `:278-282` and already
  handed to the inbound pair, the WS client and the RTC overlay).
- `packages/shared-web/browser/messages/rallar-message-operations.ts`: `RallarMessagesOperations` (`:28-38`) gains
  `readUsage(): ALVolatileSessionReport;` doc "The connected session's volatile ledger: what it holds, its four bounds, and
  whether it sheds (D180)."
- `packages/shared-web/browser/messages/browser-rallar-messages-controller.ts`: `Input` gains `requireMiddleware(): ApiMiddleware;`
  after `readMiddleware` (`:37`); `this.operations` (`:103-111`) gains
  `readUsage: () => input.requireMiddleware().middleware.volatileBudget.readReport(input.nowMs())`.
- `browser-communication-composition.ts:124`: pass `requireMiddleware: input.session.requireMiddleware` — its error is the
  transport runtime's `'Rallar is not connected. Call rallar.connect() first.'` (`browser-transport-runtime.ts:71-77`).
- `rallar.ts` (after `:300`), `rallar-core.ts` (after `:146`), `rallar-messages.ts` (after `:53`): `export type { ALVolatileSessionReport }`.
- `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts:80`:
  `BlackBoxRallarRuntime` gains `readAlmUsage(): Promise<ALVolatileSessionReport | undefined>;` doc "The facade's
  `rallar.messages.readUsage()`; `undefined` until the facade's connect completes."
- `.../browser-rallar-runtime-composition.ts`: `BlackBoxBrowserMessagesDependency` also picks `'readUsage'`;
  `.../connection/black-box-rallar-connection-runtime.ts:161` `installation()` adds
  `readAlmUsage: async () => rallar.isConnected() ? rallar.messages.readUsage() : undefined,` after `readRtcMessageNacks`.
- `packages/shared-test/rallar-bb-test/browser/browser-command-contracts.ts`: `RallarBlackBoxBrowserRallarRuntime` gains
  `readAlmUsage(): Promise<unknown>;` after `readStorageCounters` (doc "The page's session ledger report, read by the `stats`
  command; `undefined` before the page connects."); `CreateRallarBlackBoxBrowserTestRuntimeOptions` omits
  `'commandExecutor' | 'readAlmUsage'`. `browser-rallar-runtime-bridge.ts:36`: forward `readAlmUsage`.
- `packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts`: `CreateRallarBlackBoxTestRuntimeOptions`
  gains `readonly readAlmUsage?: () => Promise<ALVolatileSessionReport | undefined>;` (doc "Reads the page's session ledger for
  `stats`; absent on a runtime that drives no Rallar page."); `Dependencies` gains the required
  `readAlmUsage: (() => Promise<…>) | undefined` and `toRuntimeDependencies` (`:598`) passes it; `case 'stats'` (`:231`) awaits
  `updateStats`, which becomes `private async updateStats(commandId?: string): Promise<RallarBlackBoxTestStatsSnapshot>`: read
  `alm` first, then `toRuntimeStats(this.currentState, now)`, then `alm === undefined ? stats : { ...stats, rallar: { ...stats.rallar,
  alm } }`. `to-runtime-stats.ts` is unchanged (the control client and the report keep their synchronous calls).
- `rallar-black-box-test-contracts.ts`: the stats `rallar` block (`:1057-1065`) gains `alm?: ALVolatileSessionReport` with the
  doc of the three absences; `RallarBlackBoxTestCommandContext.updateStats` (`:1119`) returns `Promise<…>`;
  `create-rallar-black-box-browser-test-runtime.ts:141` (`health`) awaits it.
- `create-rallar-black-box-browser-test-runtime.ts:224-239`: `const rallarRuntime = options.rallarRuntime;` and
  `readAlmUsage: rallarRuntime === undefined ? undefined : async () => decodeAlmUsageResultValue(await rallarRuntime.readAlmUsage())`;
  private `decodeAlmUsageResultValue(value: unknown): ALVolatileSessionReport | undefined` — `undefined` passes, otherwise
  `decodeALVolatileSessionReport(value).fold` throws `TypeError("The page's session ledger report is not valid: " + issues.join('; '))`.
- Create `packages/shared-test/rallar-bb-test/alm/decode-al-volatile-session-report.ts` exporting
  `decodeALVolatileSessionReport(value: unknown): Either<readonly string[], ALVolatileSessionReport>`: issues
  `usage.<field> is not a count` (admissions, bytes, oldestAgeMs, tracks), `limits.<field> is not a count` (the four `max*`),
  `overloaded is not a boolean`; a count is a finite number ≥ 0 (`isCount(value: unknown): value is number`); the right is a
  fresh object with exactly those fields.
- `conformance/alm/alm-observation-snapshot.ts`: `STATS_TOPIC = 'rallar.bb.stats'`; exported
  `ALMObservationLedgerReading { atEpochMs; agentId; usage: ALVolatileSessionUsage; overloaded }`; `ALMObservationSnapshot`
  gains `ledgerReadings`; `decodeALMObservationSnapshot` sets `ledgerReadings: events.map(toLedgerReading).filter(isPresent)`;
  `toLedgerReading` reads `event.payload.topic === STATS_TOPIC` and `event.payload.payload.rallar.alm`, decoded (left → skipped).
- `conformance/alm/compute-alm-observation-regime.ts`: exported type `ALMObservationLedger = { outcome: 'measured'; readingCount;
  maxAdmissions; maxBytes; maxOldestAgeMs; maxTracks; overloadedReadings } | { outcome: 'no-readings' }` (before
  `ALMObservationRegime`); the regime gains `ledger` (before `snapshotIssues`), `computeLedger(snapshot.ledgerReadings)` — private,
  maxima by `reduce` from 0 — and `createUnreadableALMObservationRegime` sets `{ outcome: 'no-readings' }`. Not a new file:
  `conformance/alm` already has 22 production files and a 23rd trips `layout.directory-density` (R-V1a-14).
- Docs (copied from the patch, R-V1a-15): `docs/schema-and-capabilities.md` after `:1049`; `docs/alm-observation-artifact.md` `ledger` bullet.
- Test doubles: `packages/tests/shared-web/api-middleware-test-double.ts` (`volatileBudget`: an `ALVolatileSessionBudget` override
  passes through, else `createDefaultVolatileSessionBudget()`); a throwing `readUsage` in the six `RallarMessagesOperations`
  doubles (`ai/browser-rallar-ai-test-runtime.ts`, `calls/browser-call-signal-runtime.test.ts`,
  `crdt/create-rallar-crdt-message-transport.test.ts` ×2, `director/browser-director-relay-transport.test.ts`,
  `director/director-at-volatile-bound.test.ts`, `director/director-command-storage-volume.test.ts`);
  `shared-test/browser-rallar-required-methods-test-double.ts` (`readAlmUsage: async () => undefined`);
  `rallar-bb-test-alm-commands.test.ts` fake (same); `rallar-browser-runtime/browser-runtime-facade-test-double.ts`
  (`facadeBehavior.isConnected` default `true`, `facadeBehavior.readUsage` default `IDLE_SESSION_REPORT` at
  `AL_VOLATILE_SESSION_LIMITS`); `shared-web-public-api-snapshots.test.ts` pins `'ALVolatileSessionReport'` in the three lists;
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` 308 → 309.

**Interfaces.** Consumes Task 1: `ALVolatileSessionBudget.readReport(nowMs): ALVolatileSessionReport` (the only public read,
R-V1a-2), `ALVolatileSessionReport`/`ALVolatileSessionUsage`/`ALVolatileSessionLimits` with the four fields,
`AL_VOLATILE_SESSION_LIMITS` (R-V1a-4), `Admission.trackKey`; Task 1's sparse four-field limits decoder (R-V1a-3) is not touched.
Produces: `rallar.messages.readUsage()`, `RallarBrowserMiddleware.volatileBudget`, `stats.rallar.alm`, the page method
`readAlmUsage`, `decodeALVolatileSessionReport`, `ALMObservationSnapshot.ledgerReadings`, `ALMObservationRegime.ledger`.

**D8 reuse inspection.** Reused: Task 1's `readReport` and `AL_VOLATILE_SESSION_LIMITS`; the transport runtime's
`requireMiddleware` error; the per-connect middleware that already carries `storageAvailability`; the page method shape of
`readStorageCounters`; the snapshot's event decoding. Inspected, not reused: the connect's limits decoder
(`decode-black-box-rallar-connection-config.ts:126-145`), an exact sparse input that throws on extra keys — the report is page
output with usage and `overloaded`. One decoder serves the page boundary (fold → throw) and the snapshot (fold → skip).

- [ ] **Step 1: Write the tests** (copy from the patch).
  - `packages/tests/shared-web/messages/browser-rallar-messages-controller.test.ts`, `describe('rallar.messages.readUsage')`,
    over `rallar-facade-test-runtime.ts` with `LIMITS = { maxAdmissions: 2, maxBytes: 1_024, maxAgeMs: 300_000, maxTracks: 4 }`.
    Admissions are placed relative to `Date.now()`: `browserDeliveryComposition.nowMs` captures `Date.now` at module load, so
    fake Date timers never reach the facade (R-V1a-16). Titles: "throws the not-connected error before the session connects,
    and again after it disconnects"; "reads the connected session ledger: what it holds, its four bounds, and not overloaded
    below them" (`{ usage: { admissions: 1, bytes: 100, oldestAgeMs, tracks: 1 }, limits: LIMITS, overloaded: false }`,
    `1_000 ≤ oldestAgeMs < 31_000`); "reads overloaded once the session holds its admission bound"; "reads an admission whose
    deadline has passed as released" (all zero).
  - `packages/tests/shared-test/rallar-bb-runtime/stats.test.ts`, `describe('the stats result rallar.alm block')`: "reads the page
    session ledger afresh at every stats command, into its result, its event and the latest stats"; "carries the ledger in the
    stats of a health result too"; "leaves the block absent while the page has not connected"; "leaves the block absent on a
    runtime that drives no Rallar page"; "fails the stats command when the page answers with something that is not a ledger
    report, naming each bad field" (message `"The page's session ledger report is not valid: usage.admissions is not a count;
    usage.tracks is not a count; overloaded is not a boolean"`).
  - `packages/tests/shared-test/rallar-browser-runtime/read-alm-usage.test.ts`: "answers the facade ledger report once the facade
    is connected"; "answers undefined before the facade is connected, where the facade read would throw".
  - `packages/tests/shared-test/alm-observation-ledger.test.ts`, `describe('the ALM observation ledger readings')`: "decodes each
    stats reading that carries a ledger per agent, skipping the periodic stats and a malformed report"; "reports the most any one
    page held, field by field, and how many readings were overloaded" (`{ outcome: 'measured', readingCount: 3, maxAdmissions:
    30, maxBytes: 4_800, maxOldestAgeMs: 2_400, maxTracks: 3, overloadedReadings: 1 }`); "reports no readings for a cell whose
    agents read no ledger, and for an unreadable snapshot".
- [ ] **Step 2: Run red.** `npx vitest run packages/tests/shared-web/messages/browser-rallar-messages-controller.test.ts
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-test/rallar-bb-runtime/stats.test.ts
  packages/tests/shared-test/rallar-browser-runtime/read-alm-usage.test.ts packages/tests/shared-test/alm-observation-ledger.test.ts`
      → 15 failed, 11 passed (two absent-block cases, nine unrelated snapshot surfaces). **Step 3: Implement**; green → 26 passed.
- [ ] **Step 4: Verify.**
  - `npx vitest run packages/tests/shared-web packages/tests/shared-test packages/tests/shared/alm` → 483 files, 5238 passed,
    11 failed: the sandbox loopback set (rtc-rtt recipe 4, state-write recipe 4, local-websocket-session 1) and one pglite load
    timeout (`api-v1-crdt-append-history-recipe`, 6/6 alone). The four pins pass unedited.
  - `npx vitest run packages/tests/rallar-black-box packages/tests/rallar-black-box-headless packages/tests/repo` → 3045 passed,
    15 failed: `live-rtc-control-client` (13, `listen EPERM`) and `headless-worker-script` (2), both known sandbox reds.
  - `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit`; the four browser apps' tsconfigs;
    `node scripts/check-tests-typecheck.mjs` (PASS); `cd apps/rallar-black-box-control-server && deno task check` (no error),
    then `rm -rf apps/rallar-black-box-control-server/node_modules/.deno`; `npx dprint fmt` on the 37 files via `xargs`.
  - Bundles with a private `TMPDIR` (`mktemp -d /tmp/claude-501/b.XXXX`): `check:browser-bundles` → `browser/rallar.ts` 242.355
    KiB < 243 (Task 1's budget); `headless-bundle-boundary.test.ts` → 308.241 KiB, so the budget becomes 309 (maintainer rule).
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- e1e05aa8e HEAD` (PASS), `node scripts/check-test-structure-coupling.mjs
  --changed e1e05aa8e HEAD` (PASS; no mock-count pins), `npm run check:test-reachability` (four files added; 1781 files, 1775
      reached, 6 manual).

**True of the code after this task.** `rallar.messages.readUsage()` returns the connected session's report and throws the
not-connected error before the connect and after a disconnect; every browser agent's `stats`/`health.stats` carries `rallar.alm`
once its page is connected (not the control client's periodic stats or report); the lane observation reports `ledger` unasserted.

```text
Read the session ledger through rallar.messages.readUsage and record it in the stats block and the lane observation

rallar.messages.readUsage() answers the connected session's ledger
report: its usage (admissions, bytes, oldestAgeMs, tracks), its four
limits and whether it is overloaded, read synchronously at the wall
clock with no event. The ledger reaches the messages controller as the
connect's middleware's volatileBudget, the one budget both carriers
already count against, so before the connect completes and after a
disconnect the read throws the facade's usual "Rallar is not
connected" error. ALVolatileSessionReport is exported from rallar.ts,
rallar-core.ts and rallar-messages.ts.

A browser agent's stats result gains rallar.alm, the page's report read
at the command through the page runtime's readAlmUsage(); the same
block reaches health's stats, the rallar.bb.stats event and
latestStats. It is absent before the page connects, on a runtime that
drives no Rallar page, and in the control client's periodic stats and
final report, which read no page. A page answer that is not a whole
report fails the stats command, naming each bad field. No command kind
is added: a manifest's existing stats loops record the ledger.

The ALM observation snapshot keeps each stats reading that carries a
report as ledgerReadings per agent, and the regime reports ledger: the
most any one page held of each usage field and how many readings were
overloaded, or no-readings. Nothing asserts it; the observation stays
non-blocking.

Bundles: browser/rallar.ts measures 242.355 KiB against 243; the
headless agent measures 308.241 KiB and crossed 308, raised to 309.

D8 reuse: the ledger's readReport and AL_VOLATILE_SESSION_LIMITS, the transport runtime's requireMiddleware error, the middleware that already carries the session's storage availability, the page runtime's readStorageCounters method shape and the observation snapshot's topic decoding carry the read; one report decoder serves the page boundary and the snapshot, and the connect's limits decoder, an exact sparse input, is not reused.
```

### Task 3: Retention bounded by repository TTLs and the simulated hour (D181, D182)

**Precondition:** Tasks 1 and 2 are committed (`AL_VOLATILE_SESSION_MAX_AGE_MS`, `AL_VOLATILE_SESSION_LIMITS`,
`ALVolatileSessionBudget.readReport` exist). **Files** (anchors at this task's parent, Task 2's composed commit; the
composed commit is `.superpowers/sdd/v1a-plan/final-patch-task-3.patch` (`cde2e0812`), `git am`-able there; 11 files,
+437/−34). Rulings this text carries: R-V1a-19 (one fixed TTL, the durable row retention `DEFAULT_AL_REPOSITORY_TTL_MS`,
for both send-control sets), R-V1a-18 (the volatile pairs' track TTLs are NOT shortened: `al-runtime-stores.ts` is
untouched), R-V1a-20 (one RTT version counter, no per-peer table), R-V1a-21 (no timer, eviction on access; the hour on
the in-memory runtimes; private sizes through prototype spies; a track silent for the age budget resyncs into a second
invocation).

Production:

- `packages/shared/alm/outbound/lane/al-outbound-send-controls.ts`: import `LatestRepository` from
  `../../../cache/LatestRepository.ts` and `DEFAULT_AL_REPOSITORY_TTL_MS` from `../../ALStoreRetention.ts`. Before the
  class doc (`:15`) add `export namespace ALOutboundSendControls { export interface Input { /** The owner's clock, which
  ages every ended message. */ readonly nowMs: () => number; } }`. In the class (`:19`): `private readonly input:
  ALOutboundSendControls.Input;` first; `cancelledMsgIds` (`:21-22`) becomes `new LatestRepository<string, true>({
  ttlMs: DEFAULT_AL_REPOSITORY_TTL_MS })` with the doc "Held for the durable lane's row retention, in memory, never
  persisted (D181): the controls span every lane, so a durable row first claimed within the hour still completes
  without sending; one the next owner drains sends. Each access sweeps the expired ids."; `handedOverMsgIds`
  (`:23-24`) the same repository with the doc "Held as cancellations are: another carrier's owner took these messages
  (D56)."; add `constructor(input: ALOutboundSendControls.Input) { this.input = input; }`. `cancel` (`:32-40`, doc
  "Remembers the id for the row retention and aborts a live attempt; the caller states the settlement."): `const nowMs
  = this.input.nowMs();` `readAt(msgId, nowMs) !== undefined` → `'already-cancelled'`, else `acceptAt({ key: msgId,
  value: true, nowEpochMs: nowMs })`. `handOver` (`:42-53`, doc "Remembers the id for the row retention and aborts a
  live attempt, as `cancel` does, …"): `acceptAt` with `this.input.nowMs()`. `isEnded` (`:55-58`): one `nowMs`,
  `readAt` on both repositories.
- `packages/shared/alm/outbound/al-outbound-message-runtime.ts`: the field (`:456`) becomes `private readonly
  sendControls: ALOutboundSendControls;`, constructed right after `this.dependencies = dependencies;` (`:464`):
  `this.sendControls = new ALOutboundSendControls({ nowMs: () => dependencies.clock.nowMs() });`. The `cancel` doc
  (`:527-532`): "Cancels one message for the durable row retention (60 minutes). … Idempotent within the retention:
  only the first call states the `cancelled` settlement."
- `packages/shared/services/web-rtc-rx-streamer-service.ts`: delete `rttVersionByPeerId` (`:114`); after
  `rttReportingPeerIds` (`:118`) add `/** One counter for every peer's measurements, so each pair's versions only rise
  across a heartbeat restart or a peer's replacement and nothing is kept per peer (D181). */ private lastRttVersion =
  0;`; `publishRttMeasurement` (`:373-376`): `const version = Math.max(this.lastRttVersion + 1, result.version);
  this.lastRttVersion = version;`. (Deleting the entry in `removePeer`, as the design proposed, breaks the server's
  stale check `compute-rtc-rtt-mutation.ts:73-81` and the pinned test `webrtc-rtt-lifecycle.test.ts:106-125`.)
- `packages/shared-web/browser/messages/browser-resync-recovery.ts`: import `AL_VOLATILE_SESSION_MAX_AGE_MS` and
  `LatestRepository` (`@shared/cache/LatestRepository.ts`); `Input` (`:12-16`) gains `readonly nowMs: () => number;`.
  Class doc (`:19-24`, the "unbounded on purpose" sentence goes): "Invokes a channel's recovery owner once per ordering
  track while the track goes on resynchronizing: the runtime resets no track after a resynchronization, and the
  sender's new epoch is a new track. A track is remembered for the session's age budget after its last
  resynchronization (D181), so one that fell silent is forgotten and a later resynchronization of it invokes the owner
  again. A message whose route declared no owner is dropped as before, and nothing is stated for it."
  `invokedTrackKeys` (`:27`) = `new LatestRepository<string, true>({ ttlMs: AL_VOLATILE_SESSION_MAX_AGE_MS })`.
  `onResyncRequired` (`:33-44`): return on `trackKey === undefined`; `const nowMs = this.input.nowMs(); const invoked =
  this.invokedTrackKeys.readAt(trackKey, nowMs) !== undefined; this.invokedTrackKeys.acceptAt({ key: trackKey, value:
  true, nowEpochMs: nowMs }); if (invoked) { return; }` then invoke and state as today (every sighting refreshes).
- `packages/shared-web/browser/composition/browser-communication-composition.ts`:
  `CreateBrowserResyncRecoveryCompositionInput` (`:70-72`) gains `readonly nowMs: () => number;`; the recovery's input
  (`:98-103`) gains `nowMs: input.nowMs`. `create-rallar-facade.ts:162`: `createBrowserResyncRecoveryComposition({
  connectionRuntime: foundation.connectionRuntime, nowMs })` (the `nowMs` destructured at `:161`).
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts:388`:
  `{ connectionRuntime: foundation.connectionRuntime, nowMs: browserDeliveryComposition.nowMs }`.

Tests (no ids in titles):

- `packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts`: import `DEFAULT_AL_REPOSITORY_TTL_MS` from
  `@shared/alm/ALStoreRetention.ts`; the two `new ALOutboundSendControls()` (`:117`, `:128`) take `{ nowMs: Date.now }`;
  new `describe('how long the send controls remember an ended message')` after `:135`: `it('remembers a handed-over
  message for the durable row retention and forgets it after')` — `let nowMs = 1_000`, `handOver('msg-1')`,
  `+DEFAULT_AL_REPOSITORY_TTL_MS` → `isEnded` true and `handOver` → `'already-ended'`, `+1` → `isEnded` false and
  `handOver` → `'handed-over'`; `it('remembers a cancelled message for the durable row retention and forgets it
  after')` — the same with `cancel` → `'already-cancelled'` then `'cancelled'`.
- `packages/tests/shared-web/messages/browser-resync-recovery.test.ts`: the fixture (`:59-76`) gains `readonly advance:
  (ms: number) => void` over `let nowMs = 1_000` passed as `nowMs: () => nowMs`. Before `:111` add `it('keeps a track
  that goes on resynchronizing invoked once')` (seq 300 at 0, 301 at +AGE, 302 at +2·AGE → `invocations` equals
  `[first.cursor]`) and `it('invokes the owner again for a track it has not seen resynchronize for the session age
  budget')` (seq 300, `advance(AGE + 1)`, seq 900 → `[first.cursor, later.cursor]`), AGE =
  `AL_VOLATILE_SESSION_MAX_AGE_MS`.
- `packages/tests/shared/webrtc-rtt-lifecycle.test.ts`: extract `interface StreamingPeer { peer; wire }` and
  `createStreamingPeer(sessionId, peerSessionId)` from `createStreamingEndpoint` (`:174-192`: signaler, connection,
  channel, loopback wire, peer); the endpoint calls it and connects `peer.channel` (`:229`). Before `:128` add `it('numbers
  every peer\'s measurements from one counter, so a removed peer leaves no version behind')`: the a→b pair reports once
  (`5_020` ms), `reporter.streamer.removePeer(reporter.peer)`, a second peer `createStreamingPeer('session-a',
  'session-c')` wired to `createStreamingEndpoint('session-c', 'session-a')` (responder reports nothing), added to the
  reporter, `setRttReportingPeerIds(['session-c'])`, both wires opened, `5_020` ms → `[sessionIdTo, version]` equals
  `[['session-b', 2], ['session-c', 3]]`.
- New `packages/tests/shared/alm/al-session-retention-long-run.test.ts` (copy it from the composed patch, 256 lines), on
  a fake `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`, start `Date.UTC(2026, 9, 8, 12)`), 100 steps of 36 s,
  `AFTER_LAST_STEP_MS = AL_VOLATILE_SESSION_MAX_AGE_MS + AL_RECEIPT_DEADLINE_GRACE_MS + 1`:
  `it('returns the outbound memory pair, the ledger and the send controls to their baseline')` — a ledger
  `new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS)` on `createVolatileALOutboundRuntimeStores`, an `rtc`
  outbound owner whose planner is `{ lane: 'volatile', mintsSequence: true }`; per step 5 sends on tracks `track-${n %
  200}` (500 sends, 200 tracks), one work batch, `handOver` of all 5, `cancel('never-sent-<step>')`; `const lastStepAtMs
  = Date.now()`; at `lastStepAtMs + AFTER_LAST_STEP_MS`, `evictExpired()` → `readReport(now).usage` equals `{ admissions:
  0, bytes: 0, oldestAgeMs: 0, tracks: 0 }`, the pair's keys equal `[toALOutboundVersionKey(namespace, 'self')]` (the
  per-origin fence, kept its hour), its work keys `[]`; at `lastStepAtMs + DEFAULT_AL_REPOSITORY_TTL_MS + 1`,
  `evictExpired()`, one more `handOver('after-the-hour')` and `cancel('after-the-hour-cancelled')` → the pair's keys
  `[]` and the two repositories the send controls accepted into hold one id each (`[1, 1]`). `it('keeps only its tracks
  past the age budget and returns to its baseline an hour after the last arrival')` — 200 ordered tracks (two opened
  per step at seq 1, continued next step at seq 2) plus one unordered arrival per step through an inbound `ws` owner
  over `createVolatileALInboundRuntimeStores` (each arrival `admitted` or `pending-admission`; `drainEngine` per step);
  past the budget the ledger is empty, the work keys `[]`, every key matches `/:(ordering|delivered):track-\d+:/` and
  there are at most 400; `DEFAULT_AL_REPOSITORY_TTL_MS + 1` after the last arrival the keys are `[]`.
  `describe('the volatile inbound pair\'s ordering track')` / `it('remembers an idle track for the repository hour and
  forgets it after')` — seq 2 reads `in-order` at `DEFAULT_AL_REPOSITORY_TTL_MS − 1` and `gap` at
  `DEFAULT_AL_REPOSITORY_TTL_MS` (the guard for R-V1a-18; green before). Production instances are read through
  prototype spies (`LatestRepository.prototype.acceptAt` collects `this`; `InMemoryAdmissionBackend.prototype.evictExpired`
  captures the pair's backend for `peekKeys()`), so no read is added to production for the test.

**Interfaces consumed:** `AL_VOLATILE_SESSION_MAX_AGE_MS`, `AL_VOLATILE_SESSION_LIMITS`, `readReport` (Task 1);
`DEFAULT_AL_REPOSITORY_TTL_MS` (`packages/shared/alm/ALStoreRetention.ts:2`); `LatestRepository.acceptAt/readAt/size`;
`browserDeliveryComposition.nowMs`. **Produced:** `ALOutboundSendControls.Input`; `BrowserResyncRecovery.Input.nowMs`;
`CreateBrowserResyncRecoveryCompositionInput.nowMs`. Task 5's docs state these TTLs.

**D8 reuse inspection:** `packages/shared/cache/LatestRepository` (ttlMs, acceptAt/readAt on an injected clock,
rate-limited sweep on accept) replaces two `Set`s and one `Set`; the TTLs are existing constants
(`DEFAULT_AL_REPOSITORY_TTL_MS`, `AL_VOLATILE_SESSION_MAX_AGE_MS`); the per-peer `Map` is deleted, not replaced; no new
sweep, timer or repository type.

- [ ] **Step 1 (red):** write the four test changes. `npx vitest run
  packages/tests/shared/alm/al-session-retention-long-run.test.ts packages/tests/shared/webrtc-rtt-lifecycle.test.ts
  packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts
  packages/tests/shared-web/messages/browser-resync-recovery.test.ts` → `Test Files  4 failed (4)`, `Tests  5 failed |
  21 passed (26)` (the two send-control tests, the resync re-invocation, the one-counter RTT test, the outbound hour;
      the "invoked once" and both inbound tests pass already).
- [ ] **Step 2 (green):** the production changes above; the same command → `Tests  26 passed (26)`.
- [ ] **Step 3 (checks):** `echo <the 11 files> | xargs npx dprint fmt`; with a private `TMPDIR`: `npx vitest run
  packages/tests/shared/alm packages/tests/shared/multicast packages/tests/shared/services packages/tests/shared/webrtc
  packages/tests/shared/webrtc-rtt-lifecycle.test.ts packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared-web
  packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` → `Test Files  359 passed (359)`, `Tests
  3675 passed (3675)` (the four storage pins among them, unchanged); `npx tsc -p
  packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit` clean; `deno check` the three changed
      `packages/shared/**` files; `node scripts/check-tests-typecheck.mjs` → `PASS`; `check:browser-bundles` (private
      `TMPDIR`) → facade 242.297 KiB < 243 (Task 2's 242.355 less 0.058); headless 308.190 KiB < 309; no Deno app consumes
      a changed type (the api-v1 check runs at the close).
- [ ] **Step 4 (commit):** `git add` the 11 paths, then the commit below; after it `npm run check:repo-style:changed --
  e1e05aa8e HEAD` → `PASS: no new repository style findings`; `node scripts/check-test-structure-coupling.mjs --changed
  e1e05aa8e HEAD` → three `PASS`; `npm run check:test-reachability` → `1782 test files, 1776 reached by CI, 6 manual`.

```text
Bound the session's ended-message and resync records by repository TTLs and prove a simulated hour

The outbound send controls' cancelled and handed-over ids become LatestRepository entries aged by
DEFAULT_AL_REPOSITORY_TTL_MS, the durable lane's row retention, on the owner's clock and swept on
access: the controls span every lane, so a cancelled durable row first claimed within the hour still
completes without sending. The browser resync recovery's invoked tracks become a LatestRepository
aged by AL_VOLATILE_SESSION_MAX_AGE_MS; a track that goes on resynchronizing stays invoked once, and
one silent for longer invokes its owner again. The RTC receiver numbers every peer's RTT
measurements from one counter, so it keeps no version per peer and each pair's versions still only
rise across a heartbeat restart or a peer's replacement. The volatile pairs keep their ordering
tracks for the repository hour: a receiver that forgot a track would read the next sequence as a
gap.

A simulated hour drives 500 ordered sends over 200 tracks with 500 hand-overs and 100 cancels
through the outbound owner and 200 ordered tracks through the inbound owner: past the age budget the
ledger and the outbound memory pair (but its per-origin version row) are at their baseline, an hour
after the last step the pair and the send controls are, and the inbound pair holds only its tracks'
two rows each until the repository hour after their last arrival (D181, D182).

D8 reuse: packages/shared/cache/LatestRepository (ttlMs, acceptAt/readAt on the owner's clock) for the
two send-control sets and the invoked tracks; no new sweep, no new repository type.
```

### Task 4: The `capacity-age` and `capacity-tracks` cells (D182)

The composed commit is `.superpowers/sdd/v1a-plan/final-patch-task-4.patch` (`75b11b51a`, parent Task 3's `cde2e0812`;
12 files, +480/−206, of which 186/111 lines are the moved `capacity.ts`). Line anchors are on `e1e05aa8e` and hold at
this task's parent: no earlier task touches these files but `capacity.ts`, which Task 1 changed at `:43-46` and this
task moves. The unit pins need only Task 1's names; the lane (Task 6) needs Task 1's `limit` on the refusal.
The limits override is Task 1's (R-V1a-3: `maxAdmissions` and `maxBytes` required, `maxAgeMs` and `maxTracks` read as
the constants when left out); this task does not touch the decoder.

**Files**

- Move `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/capacity.ts` → `scenarios/volatile-bound/capacity.ts`
  (`scenarios/` holds exactly 20 direct files, the `layout.directory-density` threshold, so any new file there fails the
  changed-style gate). Create beside it `volatile-bound-commands.ts`, `capacity-age.ts`, `capacity-tracks.ts`.
- Modify `conformance/alm/alm-conformance-scenario-definition.ts:27` (`'capacity-age'`, `'capacity-tracks'` after
  `'capacity'`); `create-alm-conformance-recipes.ts:37` (the `capacity` import moves), `:67` (three imports from
  `./scenarios/volatile-bound/`; dprint places them after `unicast-fallback`), `:130` (`capacityAge, capacityTracks` right
  after `capacity`).
- Modify `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:22` (two imports), `:85` (two withheld rows).
- Tests: `packages/tests/shared-test/alm-conformance-addressed-scenarios.test.ts:25,29-35,261`,
  `alm-conformance-recipes.test.ts:58,160,178,201,227-230,400-401,500,531`,
  `alm-conformance-recipe-validation.test.ts:48,80,114`, `packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts:150-156`.

**Interfaces consumed** (Task 1, `@shared/alm/volatile-budget/al-volatile-session-budget.ts`): `AL_VOLATILE_SESSION_LIMITS`,
`AL_VOLATILE_SESSION_MAX_AGE_MS`, `type ALVolatileSessionLimit`, the four-field `ALVolatileSessionLimits`; the harness
failure decoder's `failure.limit` on a capacity refusal (R-V1a-8).

**Interfaces produced**

- `volatile-bound-commands.ts`: `type AlmVolatileBoundRefusalFact = readonly [field: string, expected: string | number]`;
  `toLimitRefusalFacts(limit: ALVolatileSessionLimit)` → `[['failure.kind','refused'], ['failure.reason','capacity'],
  ['failure.limit', limit], ['attempts', 0]]`; `toBoundReconnectCommands(sender, name: 'lowered' | 'restored', limits:
  Pick<ALVolatileSessionLimits, 'maxAdmissions' | 'maxBytes'> | undefined)` (close + connect; the limits written as given,
  so `capacity` still writes `{ maxAdmissions: 1000, maxBytes: 36000 }`); `toBoundRefusalCommands(sender, index, facts)`
  (observe `rejected`; `assert-status-<i>` on `send-<i>`; one `assert-<field, first . → ->-<i>` per fact on
  `observe-rejected-<i>`); `toAcknowledgedCommands(sender, index)`; `toReconnectedArrivalsCommand(receiver, count,
  settleMs)` (timeout `deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS + CONNECT_READINESS_TIMEOUT_MS + settleMs`, window
  timeout − `RESPONSE_MARGIN_MS`). `capacity.ts` keeps its constants, its two-field limits and its three-fact `REFUSAL`
  (no `failure.limit`, manifest 18 byte-identical) and is rebuilt on these helpers; its commands are unchanged.
- `capacityAge` (`'capacity-age'`, `FULL_TAGS`, `ALM_CONFORMANCE_CARRIERS`, roles `['sender','receiver']`, laneFamily
  `'addressed'`, R-V1a-24): sender = `toSendCommand` index 1 (payload `{ marker, carrier, index: 1 }`, `ack: 'receiver'`,
  `ttlMs: AL_VOLATILE_SESSION_MAX_AGE_MS + 1_000`, `commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS`) +
  `toBoundRefusalCommands(sender, 1, toLimitRefusalFacts('age'))`; no reconnect: `messages.send.ttlMs` has no maximum
  (`schema.ts:627` `{ type: 'integer', minimum: 0 }`; `validate-alm-control-command.ts:111` minimum only; the browser send
  defaults copy it, `to-browser-message-send-defaults.ts:49-52`). Receiver: `toReceivedCommand({ index: 1, count: 1,
  absent: true })`.
- `capacityTracks` (`'capacity-tracks'`, same tags/carriers/roles/family): `TRACK_LIMITS: ALVolatileSessionLimits =
  { ...AL_VOLATILE_SESSION_LIMITS, maxTracks: 2 }` (the cell writes all four fields); sender = reconnect `lowered`, sends
  1 and 2 each followed by `toAdmissionCommands`, send 3, `toBoundRefusalCommands(sender, 3, toLimitRefusalFacts('tracks'))`,
  acknowledged 1 and 2, reconnect `restored`. Each send: `ack: 'receiver'`, `reliability: 'at-least-once'`, `ttlMs:
  NON_EXPIRING_TTL_MS`, `commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS`, `` orderingKey: `${toOrderingKey(sender)}-${index}` ``,
  `seq: 1` (a track needs both, `al-runtime.ts:73-83`). Receiver = `toReconnectedArrivalsCommand(receiver, 2, 0)`: a
  received message opens no counted track, so no rejoin wait.
- Hosted rows after the claim rows: `// The age and track bound cells' lane evidence is local and the hosted full read's;
  manifest 18 stays as recorded.`, `{ scenarioKey: 'capacity-age', carriers: capacityAge.carriers }`,
  `{ scenarioKey: 'capacity-tracks', carriers: capacityTracks.carriers }`.

**Test pins.** `addressed-scenarios`: `VOLATILE_BOUND_KEYS = ['capacity', 'capacity-age', 'capacity-tracks']` spread into
`ADDRESSED_KEYS` and each carrier list; `REFUSED_AT_THE_BOUND(limit)` = `status equals rejected`, `failure.kind equals
refused`, `failure.reason equals capacity`, `failure.limit equals <limit>`, `attempts equals 0`; new
`it('refuses a send whose deadline lies past the age bound capacity/age with no attempt, under the constants')` (shapes
`messages.send, messages.observe, assert×5`; send `{ ack: 'receiver', ttlMs: AL_VOLATILE_SESSION_MAX_AGE_MS + 1_000,
timeoutMs: 10_000 }`; receiver `['received:1:absent']`) and `it('reconnects with two tracks, refuses the send opening a
third capacity/tracks with no attempt, and restores them')` (shapes `close, rtc.connect`, 2×`[send, observe, assert]`,
`[send, observe, assert×5]`, 2×`[observe, assert]`, `close, rtc.connect`; limits `[{ ...AL_VOLATILE_SESSION_LIMITS,
maxTracks: 2 }, undefined]`; sends `[alm-<carrier>-capacity-tracks-<i>, 1, 'at-least-once', 'receiver']` for i 1..3;
receiver `count 2, windowMs 57_000, timeoutMs 58_000`). `recipes`: a `VOLATILE_BOUND_KEYS` const at `:58` used in the
addressed list (`:227-230`) and the full-only list (`:500`), the two keys after `'capacity'` in the three
`SCENARIO_KEYS_BY_CARRIER` lists, two more `['full']` rtc tags (`:531`), and the window skip (`:400-401`) becomes
`/-capacity(-tracks)?-receiver-received-1$/.test(command.commandId ?? '')`. `recipe-validation`: the two ids after
`'capacity'` per carrier. `hetzner-alm-manifest-entries`: title `withholds exactly the named cells: both checkpoint cells,
the exhausted repair and the age and track bound cells everywhere, the gap repair where it runs`; `'capacity-age'`,
`'capacity-tracks'` join the all-carrier withheld keys.

**D8 reuse inspection.** `capacity.ts`'s private reconnect, refusal, acknowledgement and receiver-window code (moved
into `volatile-bound-commands.ts`, not copied); `AL_VOLATILE_SESSION_LIMITS`; `toSendCommand`, `toAdmissionCommands`,
`toObserveCommand`, `toResultAssertion`, `toReceivedCommand`, `toOrderingKey`; the withheld-row pattern.
`toVerdictCommands` does not fit: index 1 only and no send `status` assertion.

- [ ] **Step 1: Tests (red).** Copy the four test edits. `npx vitest run packages/tests/shared-test/alm-conformance-addressed-scenarios.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`
      → `Test Files  4 failed | 1 passed (5)`, `Tests  10 failed | 80 passed (90)`.
- [ ] **Step 2: Implement.** Same command → `Test Files  5 passed (5)`, `Tests  90 passed (90)`. Wider:
      `ls packages/tests/shared-test/alm-*.test.ts packages/tests/shared-test/rallar-bb-test-*.test.ts packages/tests/rallar-black-box/hetzner-*.test.ts | xargs npx vitest run`
      → `Test Files  68 passed (68)`, `Tests  987 passed (987)` on the composed tree;
      `node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` →
      `checked 67 Hetzner distributed manifest(s)`.
- [ ] **Step 3: Checks.** `printf '%s\n' <the 12 files> | xargs npx dprint fmt`; `npx tsc -p packages/shared-test/tsconfig.json --noEmit`
      and `cd apps/rallar-black-box && npx tsc --noEmit` → clean; `cd apps/rallar-black-box-control-server && deno task check`
      → clean, then `rm -rf node_modules/.deno`; `node scripts/check-tests-typecheck.mjs` → `PASS`. After the commit:
      `npm run check:repo-style:changed -- e1e05aa8e HEAD` → `PASS: no new repository style findings`;
      `node scripts/check-test-structure-coupling.mjs --changed e1e05aa8e HEAD` → three PASS lines. No test file is
      added, so `check:test-reachability` does not change.
- [ ] **Step 4: Commit.**

```text
Prove the age and track bounds in the ALM lane: the capacity-age and capacity-tracks cells

The volatile-bound cells move into a folder of their own beside the
claim and leader cells, sharing the reconnect, the refusal commands,
the acknowledgement read and the reconnected receiver's window, which
the capacity cell held privately; capacity's commands are unchanged.

capacity-age sends under the session's own constants with a deadline a
second past the age bound and reads it rejected, refused capacity,
limit age, no attempt; the receiver receives nothing. capacity-tracks
reconnects with the production limits but two tracks and sends three
ordered sends, each seq 1 on an ordering key of its own: the third
reads rejected, refused capacity, limit tracks, no attempt, and the
first two are acknowledged; then it reconnects without the override.
Both run in the addressed family beside capacity on every carrier, full
tag only, and are withheld from hosted manifest 18, which stays
byte-identical.

D8 reuse: the capacity cell's reconnect, refusal and acknowledgement commands (moved, not copied), AL_VOLATILE_SESSION_LIMITS, toOrderingKey, toReceivedCommand, toSendCommand's delivery fields, the withheld-manifest rows.
```

Lane (Task 6 Step 4, unsandboxed, `RALLAR_BLACK_BOX_ALM_SCOPE=full`, the `addressed family over <carrier> (full)` test). If send 1 or 2
of `capacity-tracks` reads `limit tracks`, a platform ordered send held a track after the reconnect (none found: browser
room sends name no `seq` unless the caller does, `al-contract.ts:349-352`): read `stats.rallar.alm.usage.tracks` right
after the reconnect before changing the cell.

### Task 5: Docs — the four bounds, the usage read and bounded retention (D183)

The composed commit is `.superpowers/sdd/v1a-plan/final-patch-task-5.patch` (`6597c6d50`, parent Task 4's `75b11b51a`;
6 files, +186/−36, docs only). It is the exact text (`git am`-able on its parent; Task 2 owns the `stats.rallar.alm` paragraph of `schema-and-capabilities.md` and the `ledger` bullet of
`alm-observation-artifact.md`, so this task adds neither, R-V1a-15). If a hunk no longer applies, replay it by its text
anchor. Controller rulings R-V1a-18 (ordering-track TTL stays 1 h), R-V1a-19 (send-control sets: 60 min TTL) and
R-V1a-20 (one RTT counter) bind this text. Then run the "True of the code" checks, the only part that can fail; a mismatch is
fixed in the doc, never in the code. Decision ids only: no plan/task/PR/ruling id is added (those already in the files
stay). The roadmap row, D87's "10 plus 15" and the static audit are the close's.

**Files (text anchors; line numbers at `e1e05aa8e`)**

- `docs/rallar-api-reference.md`, after "send with `qos: { durability: { algo: 'local-checkpoint' } }`." (`:666`): the
  four limits (D74, D179) and what is not counted; the `limit` on `{ kind: 'refused', reason: 'capacity', limit }`;
  `rallar.messages.readUsage()` (usage with `oldestAgeMs` and `tracks`, limits, `overloaded` = count or byte limit,
  throws before connect, D180) with a `ts` example; retention (D181): the age limit bounds counted messages, not
  ordering state (tracks stay known an hour); cancelled/handed-over ids 60 minutes; the resync record 5 minutes (a track
  quiet longer that resyncs again calls the recovery handler again); one RTT counter for all peers; a **Limit:**
  paragraph naming the plateau (two inbound rows per idle track for an hour, one outbound version row per origin).
- `packages/shared/alm/outbound/README.md`: `:185` "fairness is V1's" → "V1b's"; `:935-936` cancellation held "for
  `DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes, D181)" instead of the owner's lifetime; `:990` the hand-over remembers the
  id for the same 60 minutes; `:993` "before it expires in this owner's lifetime" → "before it expires"; "The volatile
  bound" `:775-783` rewritten for the four limits and `limit`, plus a paragraph on the counted track
  (`toALOrderingTrackKey`; leaves with its last counted admission; a received message never opens one) and
  `readReport(nowMs)` (`ALVolatileSessionReport`) surfaced as `readUsage()` and `stats.rallar.alm`; `:791` "at or over its
  count or byte limit"; after `:796` "That drop names no `limit`, because `overloaded` names none; only the ledger's own
  refusal does."; before `### Grouped control sends` (`:801`) the retention paragraph (tracks keep the repository hour
  and why; the two send-control `LatestRepository` sets at `DEFAULT_AL_REPOSITORY_TTL_MS`; the resync record at
  `AL_VOLATILE_SESSION_MAX_AGE_MS`; one RTT counter; no new sweep) and its **Limit:** (the plateau).
- `packages/shared/alm/inbound/README.md`: after the eviction bullet (ending `:107`) the bullet **The age limit bounds
  counted admissions, not tracks.** with its **Limit:** (two rows per idle track for an hour); `:132` the inbound
  admission raises count, bytes and oldest age, never tracks (D179). The server-track text (`:382`, `:435-438`) is
  unchanged.
- `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`: after "run after every other block." (`:519`) the
  `capacity-age`/`capacity-tracks` paragraph; `:725-733` the lane-only field section: count and bytes required, age and
  tracks optional (read as the constants), quoting Task 1's error text.
- `packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md`: one upgrade note appended after the last one
  ("rtc.connect may lower the age and track limits of the volatile bound", Owner `ALM V1a`); the 2026-09-29 note at
  `:735-764` stays as the history it records (R-V1a-27).
- `playground/alm/alm-complete-product-description.md`: `:408` "at or over its count or byte limit"; `:414-415` → "The
  age and track budgets joined in V1a (D179, below); fairness is V1b's, and transport-aware authorization stays
  planned."; `:669` "V1's" → "V1b's"; `:892-900` → **CURRENT — S3c-ii and V1a, the volatile bound** plus a new
  **CURRENT — V1a, the bound as a metric** paragraph (D180; retention and its plateau as a **Limit:**, D181); `:914-915` "are current: count and bytes since S3, age
  and active tracks since V1a (D179)."

**True of the code (verify each against the landed code; fix the doc on a mismatch)**

- Task 1 (checked on the composed tree): `AL_VOLATILE_SESSION_MAX_AGE_MS` 300 000, `AL_VOLATILE_SESSION_MAX_TRACKS` 64,
  `AL_VOLATILE_SESSION_LIMITS`; `age` when the deadline lies more than `maxAgeMs` ahead, `tracks` when a send would open
  a track at `tracks >= maxTracks`; a track leaves with its last counted admission; `record` opens none;
  `readReport(nowMs)` → `ALVolatileSessionReport { usage, limits, overloaded }`, `oldestAgeMs` 0 when empty;
  `overloaded` = count or byte bound (R-V1a-7); the RTC overlay's `overloaded → capacity` drop names no limit; the
  override's error text `rallar.almVolatileLimits must name maxAdmissions and maxBytes and may name maxAgeMs and
  maxTracks, each a positive integer.` (R-V1a-3).
- Task 2 (checked on the composed tree): `rallar.messages.readUsage(): ALVolatileSessionReport` reads
  `volatileBudget.readReport(nowMs())` and throws before the middleware exists (the API reference says "It throws before
  the session is connected"); `stats.rallar.alm` is that report. The API `ts` snippet typechecks (checked on Tasks 1+2+4+5):
  put it in a scratch `packages/shared-web/browser/zz-doc-snippet-check.ts` inside an exported function with
  `import { rallar } from '@shared-web/browser/rallar.ts'` and `declare function showSlowDown(): void;`,
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit 2>&1 | grep -c zz-doc` → `0`; delete the file.
- Task 3 (per R-V1a-18..20, checked on the composed tree): no pair's
  `orderingTrackTtlMs` changes; `cancelledMsgIds`/`handedOverMsgIds` are `LatestRepository`s with `ttlMs:
  DEFAULT_AL_REPOSITORY_TTL_MS`; the RTC receiver numbers RTT versions from one counter (no per-peer table); the resync
  recovery's invoked tracks are a `LatestRepository` with `ttlMs: AL_VOLATILE_SESSION_MAX_AGE_MS`, so a track that
  resyncs again after it expired invokes the owner again (if one that keeps resyncing refreshes its entry, the docs
  still hold); no new timer or sweep; the long-run test's plateau is two inbound rows per idle track and one outbound
  version row per origin (else restate the **Limit:** paragraphs in the API reference, both READMEs and the PD).
- Task 4: `capacity-age` (`ttlMs` 301 000, constants, no reconnect) and `capacity-tracks` (production limits but
  `maxTracks: 2`, keys `alm-<carrier>-capacity-tracks-<i>`, `seq` 1) in the addressed family, withheld from manifest 18,
  in `conformance/alm/scenarios/volatile-bound/`.

- [ ] **Step 1: Apply** the patch (or replay the hunks above). **Step 2: True-of-code checks** above.
- [ ] **Step 3: Format** `printf '%s\n' docs/rallar-api-reference.md packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md playground/alm/alm-complete-product-description.md | xargs npx dprint fmt`,
      then the same list through `xargs npx dprint check` → exit 0.
- [ ] **Step 4: Checks.** `npx vitest run packages/tests/repo packages/tests/shared-web/rallar-group-public-contracts.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts`
      → `Test Files  93 passed (93)`, `Tests  1244 passed (1244)` on the composed tree; `cd apps/api-v1 && deno test --allow-all test/swagger-routes.test.ts`
      → `14 passed | 0 failed`, then `rm -rf apps/api-v1/node_modules/.deno`; after the commit
      `npm run check:repo-style:changed -- e1e05aa8e HEAD` → PASS.
- [ ] **Step 5: Commit** (the patch's message, verbatim):

```text
Document the session ledger's age and track bounds, its usage read and bounded retention

The API reference states the volatile bound's four limits (1 000
messages, 4 MiB, a deadline at most 5 minutes ahead, 64 live ordering
tracks of the session's own ordered sends), the limit the capacity
refusal names, rallar.messages.readUsage() with an example, and what
the session retains: ordering tracks for the repository hour, the
cancelled and handed-over ids for 60 minutes, the resync record for 5
minutes, one RTT counter for all peers, and the plateau as a limit. The
outbound README's volatile bound section states the four limits, what a
counted track is and when it leaves, the ledger's one-read report, the
RTC origin's limit-less overloaded drop and the same retention;
cancellation and the hand-over are held for 60 minutes instead of the
owner's lifetime; fairness is V1b's. The inbound README states that an
inbound admission never opens a counted track and that the age limit
bounds counted admissions, not tracks. The black-box schema doc states
the limits override's optional age and track fields and the
capacity-age and capacity-tracks cells, with a compatibility note for
the override. The product description's volatile bound becomes current
for the four limits, the metric and the bounded retention; fairness and
channel backpressure are V1b's.

D8 reuse: the existing volatile bound, retention and lane-only connect field prose of each document, extended in place; one compatibility note in the existing template.
```

### Task 6: Close

Pins unchanged and bundles measured; the static merge bar; `npm run test:postgres:integration` (a regression read:
no V1a path touches the server); the conformance lane's `addressed` family with the `capacity-age` and
`capacity-tracks` cells over `ws`, `rtc` and `rtc-with-ws-fallback`; the three-seat final review BEFORE one fix wave;
push; the Branch Release Gate green on the code head; hosted manifests 18 and 22 dispatched from the branch; the PR
body; the close commit with the delivered lines; this plan file deleted.

- [ ] **Step 1: Pins and bundles.** `npx vitest run` the four pins (`al-indexeddb-transaction-ledger`,
      `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts` under
      `packages/tests/shared/alm/`) → all pass; `git diff --stat origin/main HEAD` lists of them only
      `al-indexeddb-operation-counts.test.ts`, with Task 1's three D3 follow-ups and no expected figure moved
      (R-V1a-29). Bundles with a private `TMPDIR`: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
      (`browser/rallar.ts` 242.297 KiB of 243 at composition) and `headless-bundle-boundary.test.ts` (308.190 KiB of 309
      at composition); a crossed budget rises to the next whole KiB, named in the PR body.
- [ ] **Step 2: Static merge bar.** `npm run typecheck`; `npm run build`; `npm run check:repo-style:changed --
      origin/main HEAD` (read the verdict line) and `node scripts/check-test-structure-coupling.mjs --changed
      origin/main HEAD`; `npm run check:test-reachability` (`1782 test files, 1776 reached by CI, 6 manual` at
      composition); `git diff --name-only origin/main HEAD | xargs npx dprint check`; `node --import tsx
      apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` → `checked 67 Hetzner distributed
      manifest(s)` and `git diff --stat origin/main HEAD -- apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json
      apps/rallar-black-box/manifests/hetzner/22-alm-conformance-3-agent.json` empty; `cd apps/api-v1 && deno task check`
      then `rm -rf apps/api-v1/node_modules/.deno`; `cd apps/rallar-black-box-control-server && deno task check` then
      `rm -rf node_modules/.deno`; `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit`.
- [ ] **Step 3: Postgres integration.** With the test Postgres up (`docker ps` first; `npm run db:test:up` only from
      this worktree), run `npm run test:postgres:integration` unsandboxed; name every red from its output.
- [ ] **Step 4: The conformance lane, unsandboxed on private ports.** `lsof -i :18480 -i :5480 -i :5481` first, so no
      other session's server is reused; then `VITE_RALLAR_API_BASE_URL=http://localhost:18480
      VITE_RALLAR_SPA_BASE_URL=http://localhost:5480 RALLAR_BLACK_BOX_CONTROL_BASE_URL=http://127.0.0.1:5481
      RALLAR_BLACK_BOX_ALM_SCOPE=full npm run test:rallar:full-stack:memory:alm -- -g "addressed family"` (all three
      carriers; `RALLAR_BLACK_BOX_ALM_CARRIERS=ws|rtc|rtc-with-ws-fallback` runs one). Expected: `addressed family over
      ws (full)`, `… over rtc (full)` and `… over rtc-with-ws-fallback (full)` pass, with `capacity` unchanged,
      `capacity-age` on every carrier (send 1 `rejected`, `failure.kind refused`, `failure.reason capacity`,
      `failure.limit age`, `attempts 0`; the receiver receives nothing) and `capacity-tracks` on every carrier (sends 1
      and 2 acknowledged by the receiver; send 3 `rejected`, `refused`/`capacity`/`tracks`, `attempts 0`; the reconnect
      restores the production limits). If send 1 or 2 of `capacity-tracks` reads `limit tracks`, read
      `stats.rallar.alm.usage.tracks` right after the reconnect before changing the cell (a platform ordered send held a
      track). Every cell's `stats` step records a `rallar.alm` reading, and the lane's observation artifact carries
      `ledger: { outcome: 'measured', … }` per cell. Diagnose a red cell from its artifact.
- [ ] **Step 5: Final review, then one fix wave.** Three seats (product: the four bounds, the limit on the refusal,
      the metric and its readers, the retention as applied against D179–D183 and R-V1a-18..20; harness: the
      `stats.rallar.alm` block, the page method, the observation's `ledger` regime, the two cells, the four-field
      override and the withheld manifests; code quality: the code standard, D3, D8 and the cache-repository rule, one
      report decoder, one limits constant, no ids, the prototype spies of the hour test) review the branch head before
      any fix; the controller rules on every finding and applies one fix wave; any fix reruns its task's checks and Steps
      1–2.
- [ ] **Step 6: Push and gates.** Push the branch; the Branch Release Gate (`gh run list --branch
      claude/alm-v1-session-budgets`) green on the code head; rerun a known flake once with `--failed` before
      diagnosing it.
- [ ] **Step 7: Hosted manifests 18 and 22 from the branch.** `gh workflow run hetzner-distributed-recipe.yml --ref
      claude/alm-v1-session-budgets -f ref=claude/alm-v1-session-budgets -f rollout_before_run=true -f
      manifest_path=apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`, and the same with
      `22-alm-conformance-3-agent.json`; both are regression reads (the two cells are withheld) and now record
      `rallar.alm` in every browser agent's `stats`; diagnose a red from its artifacts.
- [ ] **Step 8: PR body.** Goal; Changes per task; Public surface (`AL_VOLATILE_SESSION_MAX_AGE_MS`,
      `AL_VOLATILE_SESSION_MAX_TRACKS`, `AL_VOLATILE_SESSION_LIMITS`, `ALVolatileSessionLimit`, the four-field
      `ALVolatileSessionLimits`, `ALVolatileSessionUsage.oldestAgeMs`/`tracks`, `ALVolatileSessionReport`,
      `ALVolatileSessionBudget.readReport(nowMs)` replacing `readUsage`/`isOverloaded`, `limit?` on the `refused`
      failure and verdict, `rallar.messages.readUsage()` and the exported `ALVolatileSessionReport`, the `stats` result's
      `rallar.alm`, the page method `readAlmUsage()`, the connect's optional `maxAgeMs`/`maxTracks`, the observation's
      `ledgerReadings` and `ledger`, `ALOutboundSendControls.Input`, the budgets 242 → 243 and 308 → 309); Acceptance;
      Validation with every red named; Rulings R-V1a-1 to R-V1a-32 and any the review adds; Corrections (this plan's
      list); Limits (this plan's list); Risk and rollback; Follow-ups (V1b fairness and backpressure; V1c scale manifests
      reading `stats.rallar.alm` and a periodic ledger read if they need one; V1d the 60-minute run judged against the
      one-hour plateau; the platform-topic exemption). End the body with the Claude Code attribution line.
- [ ] **Step 9: The close commit.** In `playground/alm/alm-improvement-plan.md`: D87's row (`:116`) reads "the durable
      pins (10 plus 9 per send, 8 per inbound admission)"; the D179, D180, D181 and D182 rows each gain an "**As applied
      (V1a):**" sentence (R-V1a-31): D179 "a track leaves the count with its last counted admission, released by the
      ledger's deadline heap; the ledger's one read is `readReport(nowMs)`, which `rallar.messages.readUsage()`
      returns."; D180 "only the `stats` command and `health` read the ledger; the control client's periodic stats carry
      no `alm`."; D181 "the volatile pairs keep the one-hour ordering-track TTL (a receiver that forgot a track would read
      the next sequence as a gap); the send controls' sets take `DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes), since they
      span every lane; the RTT version table is one counter for all peers; the resync recovery's set takes the age
      budget."; D182 "the cells run in the `addressed` family beside `capacity`; `capacity-tracks` refuses the third
      ordered send at a lowered bound of 2, the 65th is a unit pin; the hour test's inbound pair keeps its tracks' rows
      for their hour."; the "Releases 4 to 8" map row `| 7 V1    |` gains "Delivered (V1a, `<head>`; #<pr>)." after
      "(D179–D183)." in its outcome column; the consumer row `| 7 V1     |` gains "Delivered (V1a, `<head>`; #<pr>)." in
      its AR Eye column; the fresh-session paragraph replaces "V1a is the active slice, designed in … V1b, V1c and V1d
      follow." with "Release 7 V1a is delivered (#<pr> as `<head>`, from
      [alm-v1a-design-proposal.md](alm-v1a-design-proposal.md), decisions D179–D183 as applied; its plan file is deleted
      with the close). V1b (fairness and channel backpressure as policy inputs) is the next slice; V1c and V1d follow.";
      the revision history gains "<merge date> (V1a delivered): #<pr> as `<head>`; the V1 map row, the consumer row,
      D87's pinned figures, the D179–D182 as-applied notes, the F5, F13 and PC8 rows and the fresh-session paragraph
      record it; V1b is next."; the requirement matrix's `| PC8 bounded protocol work |` row reads "Partial: the
      per-session volatile ledger bounds count, bytes, age and active tracks and is read as a metric (V1a, #<pr>);
      fairness, backpressure and the long-run proof remain (V1b–V1d)." with its owner column `F2, R1, V1`. In
      `playground/alm/alm-static-audit.md` the status table's `| F5 |` line reads "Resolved for the volatile tier: a
      volatile send commits nothing to IndexedDB (S3c-ii, pinned) and the session's volatile memory is bounded by count,
      bytes, age and active tracks (V1a)." (keep any default-durability clause the code still makes true) with owner
      `V1b`, and the `| F13 |` line "Resolved: per-message ceilings (S3) and the per-session aggregate budgets for count,
      bytes, age and active tracks (V1a); fairness remains." with owner `V1b`. In
      `playground/alm/alm-v1a-design-proposal.md` add "## 6. As applied (V1a delivered)" with the four as-applied
      sentences above. Delete this plan file in the same commit. Never a blank line inside a table; `npx dprint fmt` the
      three files.
