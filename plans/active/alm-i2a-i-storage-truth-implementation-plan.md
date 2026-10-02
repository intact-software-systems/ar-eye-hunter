# ALM I2a-i: storage truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser ALM storage truthful (D119, the first of the two I2a PRs): a storage failure becomes a typed value (`ALStorageUnavailable`, seven causes) instead of a raw throw or a silent memory fallback; a durable send its storage cannot hold settles `failed` with `storage-unavailable`, or, on a channel that chose `onStorageUnavailable: 'volatile'`, is sent once without storage with `durabilityDowngrade` evidence; availability is decided per connect; the first durable admission asks for persistent storage; one public `storage` port states resets, per-store recovery outcomes, health transitions and the persistence outcome; the browser database is named per scope and a replaced session's rows are purged; identity dedup holds through the message deadline plus the receipt grace on every store, the server's included; a harness storage fault port and the `storage-unavailable` lane scenario prove it, and `delivery-reload` reads the recovery outcome.

**Architecture:** `toALStorageUnavailable` classifies once (D122) in a new feature folder `packages/shared/alm/storage/`, and the lanes' admission boundary turns a storage throw into the `storage-unavailable` verdict (backends keep their I/O shape). Each browser store gets one `ALStorageHealth` per connect, an `ObservableLatestValue` whose listener states transitions on `RallarDiagnosticsPorts.storage`, which replaces `onStorageReset` (D121). The decision `refuse | volatile` sits in the browser dispatch; the connect's `BrowserALStorageAvailability` skips the durable lane only while IndexedDB is missing, and the durable pairs never fall back to memory. The database is `rallar-al-runtime:<applicationId>:<workspaceId>` (D120, no migration, the legacy database left in place); the purge runs per listed database. The `set-dedup` expiry becomes `max(window, min(deadline + grace, now + msgOwnerTtl))` for identity algorithms (D125). The IndexedDB operation observer becomes an interceptor with no production cost; `ScriptedStorageFaultPort` mirrors the transport fault port. Recovery outcomes come from each durable lane's first work batch, stated through the store's health (D124).

**Tech Stack:** TypeScript, Vitest with fake-indexeddb and happy-dom, Deno (api-v1, the black-box control server), PGlite and PostgreSQL for the shared inbound mutation, the ALM Playwright lane and hosted Hetzner manifests 18/22, esbuild/brotli bundle budgets, dprint.

**Spec:** `playground/alm/alm-i2a-design-proposal.md` §2.2, §3.a–3.e, §3.h–3.j, §4 (D119–D128), §5 (I2a-i rows), §6; decisions D119–D128 in `playground/alm/alm-improvement-plan.md`; QoS plan §5, §8, §9.2 in `playground/alm/alm-qos-product-plan.md`. The writers' prototypes, their reports and the controller's rulings (below) are in the session scratchpad (`i2a-plan/`).

## Global Constraints

- The maintainer's notes, verbatim: "no migration code, avoid duplications, reuse existing repo patterns, use repo
  guidance." D3: a storage change is a reset, never a migration; the legacy database `ar-eye-hunter-al-runtime` is
  LEFT in place (D120), no delete code.
- D8 reuse first: `Either` for expected failure; in-memory keyed/latest state uses `packages/shared/cache`
  (`LatestRepository`, `ObservableLatestRepository`, `ObservableLatestValue`), never a raw Map; existing ports and
  helpers are widened, not duplicated (`BrowserLocks` port, `ALStorageResetListeners`, `deleteBrowserALRuntimeEntriesForSession`,
  `deleteIndexedDbDatabase`, `computeALReceiptRetentionExpiryMs`, `ScriptedTransportFaultPort`'s model). Every task's
  text carries a D8 reuse inspection paragraph (what was reused, what was NOT added and why).
- No guarantee weakens. Pins only fall: the warm durable send ledger (chain 6, total 8, 37 requests, 10 `al-admission`
  plus 5 `al-work`), the cold pin (10 + 9), inbound (chain 9/11, total 11/13, `al-work` 5/7) in
  `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts` and `al-indexeddb-operation-counts.test.ts`
  must not rise. The volatile zero pin (D55) holds.
- No schema id bump unless a row shape changes (none planned); no new dependency; no new timer on the send path;
  `navigator.storage.persist()` is never awaited on the send path (D127).
- Bundle budgets: `packages/shared-web/bundle-budgets.json` (`browser/rallar.ts` 231 KiB; 230.106 measured at P1b)
  and `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (294; 293.694). A crossed budget is
  raised to the next whole KiB with the measured figure in the commit message and the PR body. The raise lands in
  the task whose commit crosses it, measured on the real tree (R-I2a-i-48); the assembled branch crossed in Tasks 1,
  3, 4, 8 and 9 (the tasks' bundle steps state the figures).
- The server is touched only where the code is shared (the `set-dedup` mutation, Task 7): the PostgreSQL backend
  never produces `ALStorageUnavailable`; the api-v1 cluster profile and the medium-scale gate prove the shared change.
- Code standard (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical verbs (`toXxx` pure,
  `computeXxx`, `validateXxx` returns all issues, `readXxx`/`writeXxx` cross a boundary, `getXxx`/`setXxx` in memory,
  `createXxx`, `createDefaultXxx`, `resolveXxx`), functions ≤ 40 lines, ≤ 3 positional parameters, `interface` for
  object contracts, required fields by default (an optional field only where absence has domain meaning, stated in its
  doc line), kebab-case files named after the primary export, no role folders, no comments except an essential
  invariant (test-intent comments are fine), no plan/decision/task/PR id in code or tests, file cognitive-load tiers
  (warn ≥ 50, review ≥ 110, ≥ 330 needs a registered exception), 1,200-line backstop.
- Formatting: dprint only on touched files (`npx dprint fmt <file> <file>`), never a glob.
- Per-task checks: the focused Vitest files for the touched package; `npx tsc -p packages/shared/tsconfig.json --noEmit`;
  `npm --workspace @ar-eye-hunter/shared-web run typecheck`; `npm --workspace @ar-eye-hunter/shared-server run typecheck`;
  `cd apps/api-v1 && deno task check`; `node scripts/check-tests-typecheck.mjs`; `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
  and `npx vitest run packages/tests/rallar-black-box-headless` after any `packages/shared` or `shared-web` change;
  `npm run check:repo-style:changed -- origin/main HEAD` and `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`
  before the commit; any change under `packages/shared/alm/inbound/**` or the shared mutations runs
  `npm run test:postgres:integration` (shared container `ar-eye-hunter-postgres`, `docker start` only if stopped,
  never `db:test:up`/`db:down`); a public shared-web surface change runs `shared-web-public-api-snapshots.test.ts`
  and `shared-web-browser-bundle-boundaries.test.ts`.
- Navigation maps are updated in the task that changes what they describe: `packages/shared/alm/outbound/README.md`,
  `packages/shared/alm/inbound/README.md`, `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`,
  the shared-web diagnostics docs, never claiming behaviour the code lacks.
- Git: one commit per task by the implementer with ONE "D8 reuse:" line in the body and NO attribution lines; the
  controller pushes after review; never `git stash`, never push, never merge, never `pr:delivery ready`.
- Code identity: the steps' diffs and new files were cut from the assembled scratch branch `scratch/i2a-assemble`
  (worktree `<scratchpad>/i2a-plan/assemble`, head `285d9d1b0`, one commit per task on `7e6f0a117`: Task 1
  `7afe08a40`, 2 `bdbdabd2d`, 3 `4567aa673`, 4 `222c4407b`, 5 `b67e43022`, 6 `7b5bf4442`, 7 `a8db6195c`,
  8 `3561cc9f3`, 9 `285d9d1b0`). An implementer who follows the steps in order lands on that tree; `file:line`
  anchors in prose are at `7e6f0a117` unless a step names another commit.

## File structure

| Area                    | Files                                                                                                                                                                                                                                                                                                                                                                                        | Responsibility                                                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage value           | `packages/shared/alm/storage/al-storage-unavailable.ts`; `packages/shared/alm/open-indexed-db-admission-database.ts`                                                                                                                                                                                                                                                                         | `ALStorageUnavailable` (seven causes), `ALStorageUnavailableError`, `toALStorageUnavailable(error: Error)`; the opener raises `missing` and `open-failed` (Task 1)                                            |
| Storage port and health | `packages/shared/alm/storage/al-storage-event.ts`, `al-storage-health.ts`; `packages/shared-web/browser/connection/rallar-diagnostics-ports.ts`; `browser-al-runtime-stores.ts` (`toBrowserStoreOptions`); `browser-al-runtime-cleanup.ts`; the harness diagnostics; `rallar.ts`/`rallar-core.ts` exports                                                                                    | `ALStorageEvent` (reset, recovery, health, persist), `ALStorageHealth` per store per connect, `storage` replaces `onStorageReset`, the `rallar.browser.alm.storage` topic (Task 2); `recordRecovery` (Task 9) |
| Lane boundary           | `packages/shared/alm/storage/al-storage-readiness.ts`; `al-delivery-lifecycle.ts`, `al-delivery-failure.ts`, `compute-al-delivery-lifecycle.ts`; `al-outbound-dispatch-admission.ts`; both store lanes; `al-work-handler.ts`; both runtimes and their resources; the exhaustive readers (signaling, server publish status, harness decoders)                                                 | The verdict and failure arms, `ready()` as `Either`, `runStoreOperation`, the idle probe gate, batch failures as health (Task 3)                                                                              |
| Channel decision        | `rallar-message-contracts.ts`, `validate-rallar-typed-channel-policy.ts`, `to-browser-message-send-defaults.ts`, `browser-typed-message-channels.ts`, `browser-rallar-message-sender.ts`, `browser-rallar-message-dispatch.ts`; the lifecycle's `durability-downgrade` settlement and evidence                                                                                               | `onStorageUnavailable` (`refuse` or `volatile`), the downgrade (Task 4)                                                                                                                                       |
| Availability            | `packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts`; `browser-al-runtime-stores.ts`; `initialise-browser-middleware.ts`; `rallar-connection-facade.ts`; the dispatch                                                                                                                                                                                                 | Per-connect availability, the end of the memory fallback, `persisted()` then `persist()` (Task 5)                                                                                                             |
| Scope and purge         | `browser-al-runtime-identity.ts`, `browser-al-runtime-stores.ts`, `browser-al-runtime-cleanup.ts`, `initialise-browser-middleware.ts`; `session/delete-ended-session-al-runtime-entries.ts`, `session-auth-lifecycle.ts`                                                                                                                                                                     | The per-scope database name, the sweep and purge over every scope database, the purge on login over a session and a session switch (Task 6)                                                                   |
| Dedup retention         | `packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts`, `packages/shared/alm/inbound/README.md`                                                                                                                                                                                                                                                                            | `computeALInboundDedupExpiryMs`, server-shared (Task 7)                                                                                                                                                       |
| Storage fault port      | `packages/shared/persistence/indexed-db-operation-observer.ts`, `storage-fault-port.ts`; the three IndexedDB owners' observe sites; the harness composition, schema, validator and decoder                                                                                                                                                                                                   | The interceptor seam, `ScriptedStorageFaultPort`, `fault.inject` `carrier: 'storage'` (Task 8)                                                                                                                |
| Recovery and lane       | `packages/shared/persistence/open-indexed-db.ts`; `open-indexed-db-admission-database.ts`; `packages/shared/alm/storage/al-storage-recovery-reporter.ts`; `indexed-db-admission-backend.ts`, `indexed-db-queue-box.ts`; `al-runtime-stores.ts`; the lanes; the conformance catalog (`storage-unavailable`, `delivery-reload`); the three harness projections; manifest 18; the Deno fixtures | Recovery outcomes per durable store, the scenario, the reload's recovery reads (Task 9)                                                                                                                       |
| Docs                    | `packages/shared/alm/outbound/README.md`, `packages/shared/alm/inbound/README.md`, `packages/shared-web/browser/README.md`, `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`, `schema-and-capabilities.md`, `docs/rallar-api-reference.md`, `docs/test-structure-coupling-exceptions.md`                                                                            | Navigation maps and registry, updated in the task that changes what they describe                                                                                                                             |
| Budgets                 | `packages/shared-web/bundle-budgets.json`, `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`                                                                                                                                                                                                                                                                            | Raised in the crossing task only (Tasks 1, 3, 4, 8, 9)                                                                                                                                                        |
| Close                   | `playground/alm/alm-qos-product-plan.md` §8, the PR body, this plan file                                                                                                                                                                                                                                                                                                                     | Task 10                                                                                                                                                                                                       |

## Task order

1 (storage value) → 2 (storage port and health) → 3 (verdict, lanes' boundary, batch health) → 4 (channel decision) →
5 (availability per connect) → 6 (scope and purge) → 7 (dedup retention) → 8 (storage fault port) → 9 (recovery
outcomes and the lane scenarios) → 10 (close). Task 2 runs before Task 3 because Task 3 records into the
`ALStorageHealth` Task 2 creates (R-I2a-i-8). Task 4 reads Task 3's verdict arm; Task 5 needs Task 3's non-blocking
durable lane and idle-probe gate (R-I2a-i-50) and Task 4's dispatch decision. Task 6 rewrites the store composition
Tasks 2 and 5 shaped. Task 7 is independent of 2–6 but lands after them so the bundle figures are read in order.
Task 8's interceptor is the seam Task 9's scenario faults through; Task 9 also consumes Tasks 2–5 (the port, the
verdict, the channel setting, the retry of a quota cause). Task 10 runs on the pushed, reviewed Tasks 1–9.

---

## Rulings made while writing the plan

Each is a choice the spec does not settle, taken by the controller from the writers' prototypes. The maintainer can
undo any of them; the cost column says what a wrong ruling costs. Where the assembly measured something a ruling
predicted, the row says what was measured.

| Id         | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Why                                                                                                                               | Cost if wrong                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| R-I2a-i-1  | `computeALInboundDedupExpiryMs(input)` (named input: `nowMs`, `dedup`, `messageDeadlineAtMs: number \| undefined`, `msgOwnerTtlMs`) sits in `al-inbound-delivery-mutations.ts` beside `computeALInboundMessageOwnerExpiryMs`; no new production file.                                                                                                                                                                                                                                                                                                                                                                                 | One owner for the two inbound row expiries; the unit test needs no full read DTO.                                                 | A second expiry rule later splits the file (it is 207 lines today).                               |
| R-I2a-i-2  | None of the four tests the proposal named moves (none pins the window's length); the only dedup-expiry pin, `rtc-relay-row-retention.test.ts:81`, stays green because 30 s ttl + 30 s grace = the 60 s window.                                                                                                                                                                                                                                                                                                                                                                                                                        | Measured by the writer (red 10/12 at base, green 12/12 at head, five runs).                                                       | None.                                                                                             |
| R-I2a-i-3  | The cap `nowMs + msgOwnerTtlMs` applies to volatile and durable messages alike; `ttlHops ≤ 0` (deadline 0) keeps the window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | One rule for both lanes, no special case.                                                                                         | A volatile message with a deadline beyond 60 min loses dedup after the TTL (stated in Limits).    |
| R-I2a-i-4  | A third replay test runs on the server's PostgreSQL store under PGlite (`packages/tests/shared-server/al-runtime/postgres/p-sql-inbound-dedup-retention.test.ts`, in `test:unit:main`); it is KEPT.                                                                                                                                                                                                                                                                                                                                                                                                                                   | Neither the medium-scale nor the cluster profile replays a message after 60 s, so it is the only direct proof of the server path. | 65 lines of test and one PGlite start per run.                                                    |
| R-I2a-i-5  | "Re-acknowledged" is proven with a copy addressed to this peer as its one next hop; a same-carrier unicast duplicate with no next hop is answered with nothing (pre-existing, already pinned).                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tests prove the retention, not a new ACK rule.                                                                                    | None.                                                                                             |
| R-I2a-i-6  | Each replay test waits for the second ACK before asserting the verdict (the PGlite case hung at teardown at base with the assertion first).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Clean red at base on all three stores.                                                                                            | None.                                                                                             |
| R-I2a-i-7  | The inbound README gains a `### Dedup retention` subsection and corrects the relay-rows sentence, citing D125 as its neighbours cite decision ids; code and tests carry no ids.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The repo rule bans ids in code, not in navigation docs.                                                                           | None.                                                                                             |
| R-I2a-i-8  | Execution order is 1 → 5 → 2 (the plan numbers them Task 1 storage value, Task 2 storage port, Task 3 verdict + boundary + health): the boundary records into the `ALStorageHealth` the port task builds; the port reads nothing from the boundary.                                                                                                                                                                                                                                                                                                                                                                                   | Dependency direction.                                                                                                             | None.                                                                                             |
| R-I2a-i-9  | The new modules live in a new folder `packages/shared/alm/storage/` (four `al-storage-*` files): `alm/` has 20 direct files and the directory-density finding fires above 20. Assembled: the folder holds five files after Task 9 and the gate passes.                                                                                                                                                                                                                                                                                                                                                                                | The changed-style gate.                                                                                                           | A fifth file (W-E) may trip the prefix review; split by owner then.                               |
| R-I2a-i-10 | `toALStorageUnavailable(error: Error)`, not `unknown` (callers pass `toError(caught)`); the `boundary.unknown` rule exempts only `decode*`/type guards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Repo rule.                                                                                                                        | None.                                                                                             |
| R-I2a-i-11 | `ready()` returns `Either<ALStorageUnavailable, 'ready'>` (`ALStorageReadiness.Outcome`): `Either` refuses an `undefined` right.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Library constraint.                                                                                                               | None.                                                                                             |
| R-I2a-i-12 | One `ALStorageUnavailableError` carries `missing`, `open-failed` and `evicted`; `ALStorageResetBlockedError` becomes its subclass (same name and message); `missing` is decided in the admission opener so the shared persistence open is untouched.                                                                                                                                                                                                                                                                                                                                                                                  | One typed carrier for thrown storage failures at the one boundary that classifies them.                                           | None.                                                                                             |
| R-I2a-i-13 | DOMException mapping: `QuotaExceededError` → `quota`; `InvalidStateError` → `closed`; `UnknownError`, `AbortError`, `TransactionInactiveError` → `transaction-failed`; every other name stays unclassified (rethrown).                                                                                                                                                                                                                                                                                                                                                                                                                | Only the names the proposal's causes cover.                                                                                       | An unmapped browser error stays a raw throw (as today).                                           |
| R-I2a-i-14 | The outbound boundary classifies only `enqueue` commits (beside the `NonRetryableException` catch); `dequeue`/`repair` commits still throw into their work claim, which retries; control and receipt admissions answer `not-handled`; the hand-over's receipt end returns without ending the row; an inbound message answers `not-admitted` with reason `storage-unavailable`; an inbound control answers `not-handled`; all through one `ALStorageReadiness.runStoreOperation`.                                                                                                                                                      | The send is the one place the application gets a typed answer; work paths already retry.                                          | None.                                                                                             |
| R-I2a-i-15 | A failed open is not cached: the next `ready()` opens again and a send's own commit reopens and settles typed; the per-connect availability short-circuit is Task 5 (W-B).                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Keeps the lane honest about storage; the composition decides the skip.                                                            | None.                                                                                             |
| R-I2a-i-16 | One `ALStorageHealth` per store scope per connect, built in the browser composition and passed into the ALM factory; optional on the store pair (like `storageResets`) and `\| undefined` on `Resources`; `ALWorkHandlerDependencies.storageHealth` is optional with the doc line "absent on the server lane, which has no storage health reporter" (the browser composition always passes it).                                                                                                                                                                                                                                       | Absence has domain meaning (the PostgreSQL lane never produces the value); not a test convenience.                                | A browser composition that forgets it loses health events silently: the composition test pins it. |
| R-I2a-i-17 | Health semantics: `lastFailure` is the latest failure; a recovery point is a committed admission, an inbound admission that wrote work, or a batch flush with at least one release; health is stated on transitions only.                                                                                                                                                                                                                                                                                                                                                                                                             | Proposal 3.b.                                                                                                                     | None.                                                                                             |
| R-I2a-i-18 | The expiry sweep and the session purge name the database as the reset's `storeId` (they open no single store); W-C's scoped name replaces the constant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Honest id.                                                                                                                        | None.                                                                                             |
| R-I2a-i-19 | The harness `storage_reset` payload is unchanged (no `storeId`); `rallar.browser.alm.storage` carries the whole event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The reload identity assessment stays untouched.                                                                                   | None.                                                                                             |
| R-I2a-i-20 | Public exports from `rallar.ts` and `rallar-core.ts`: `ALStorageEvent`, `ALStorageRecoveryOutcome`, `ALStorageUnavailable`, `ALStorageUnavailableCause`; the snapshot is updated in Task 2 (port).                                                                                                                                                                                                                                                                                                                                                                                                                                    | A consumer of the port needs the event types.                                                                                     | None.                                                                                             |
| R-I2a-i-21 | Exhaustive readers of the verdict: signaling maps `storage-unavailable` to `terminal`; the server publish status maps it to `failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Both unions are switched exhaustively.                                                                                            | None.                                                                                             |
| R-I2a-i-22 | Recovery events are emitted through `ALStorageHealth.recordRecovery(outcome)` (W-E adds it); `evicted` is raised as `new ALStorageUnavailableError({ cause: 'evicted', detail })`. Assembled with R-I2a-i-56: the eviction is a value recorded on the health (`recordFailure`), never thrown, since the open itself succeeded; the error class still carries `evicted` for a raiser that knows it.                                                                                                                                                                                                                                    | One emitter per store.                                                                                                            | None.                                                                                             |
| R-I2a-i-23 | Budgets: the headless budget rises 294 → 295 KiB in Task 1 (294.028 measured); `browser/rallar.ts` measures 230.902 of 231 after the boundary task and rises to 232 in the first task that crosses it (expected Task 4 or 5), with the figure in the commit message. Superseded in its figures by R-I2a-i-48 (assembled: `rallar.ts` crosses in Task 3 at 231.032 KiB).                                                                                                                                                                                                                                                               | Global Constraints.                                                                                                               | None.                                                                                             |
| R-I2a-i-24 | The pre-existing masked `boundary.unknown` finding at `admitIncomingMessage(value: unknown)` in `al-inbound-message-runtime.ts` is NOT fixed in this PR; no new comment there carries an apostrophe (it woke the masked finding).                                                                                                                                                                                                                                                                                                                                                                                                     | Scope; a style fix with no I2a semantics.                                                                                         | Listed as a follow-up in the PR body.                                                             |
| R-I2a-i-25 | The database name encodes its two scope parts with `encodeURIComponent`, as `toStateScopeHttpPath` does: `rallar-al-runtime:${encode(applicationId)}:${encode(workspaceId)}`; plain ids read exactly as D120 states them. Assembled: W-C's prototype did not encode; Task 6 adds the encoding and a case pinning `a:b`/`c` against `a`/`b:c`.                                                                                                                                                                                                                                                                                         | Scope ids have no pattern in the OpenAPI spec, so `a:b`/`c` and `a`/`b:c` would otherwise name one database.                      | None for plain ids; an id with reserved characters reads encoded in DevTools.                     |
| R-I2a-i-26 | Without `indexedDB.databases()`, the purge and the 60 s sweep cover only the current scope (the frame's rule), not "current plus default" (proposal 3.c).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | One rule; the default scope is the current scope for every app today.                                                             | Rows of another scope age out under the browser's eviction.                                       |
| R-I2a-i-27 | Login over a session and the session switch purge only when the `sessionId` differs (rows are keyed by session id); a renewal that keeps the id keeps its rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keys, not auth keys, own the rows.                                                                                                | None.                                                                                             |
| R-I2a-i-28 | A failed purge emits one `health` `failing` event per store id of the ended session, carrying `lastFailure: toALStorageUnavailable(toError(error))`, straight to `diagnosticsPorts.storage`, not through the per-store health holder (the ended session's stores are gone; nothing could report `healthy` again).                                                                                                                                                                                                                                                                                                                     | Truthful terminal report.                                                                                                         | None.                                                                                             |
| R-I2a-i-29 | A failing database does not stop the sweep or purge of the others; the first failure is rethrown after all were tried (pinned).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | No partial purge hides behind one bad database.                                                                                   | None.                                                                                             |
| R-I2a-i-30 | The purge's fallback scope is `resolveOperationScope() ?? defaultStateScope()`; a per-call `connect({ scope })` scope is kept nowhere; the 60 s loop's fallback scope is the scope of the connect that started it.                                                                                                                                                                                                                                                                                                                                                                                                                    | Existing scope resolution reused.                                                                                                 | A per-call scope's rows are purged only through `databases()`.                                    |
| R-I2a-i-31 | A reset caused by a sweep names the database it opened, once per database (Task 2's convention).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Honest id.                                                                                                                        | None.                                                                                             |
| R-I2a-i-32 | The purge-and-report logic lives in a new module `session/delete-ended-session-al-runtime-entries.ts`: inline it pushed `session-auth-lifecycle.ts` to cognitive load 51 and added a `boundary.unknown` finding.                                                                                                                                                                                                                                                                                                                                                                                                                      | The changed-style gate.                                                                                                           | None.                                                                                             |
| R-I2a-i-33 | `toBrowserALRuntimeNamespace` is no longer exported (nothing imports it); otherwise the identity file reaches 12 runtime exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The export-count tier.                                                                                                            | None.                                                                                             |
| R-I2a-i-34 | The cleanup result's `dbName` becomes `dbNames`; `createBrowserAL*RuntimeStores` require `dbName` (tests and the durable-send harness follow).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Required fields by default.                                                                                                       | None.                                                                                             |
| R-I2a-i-35 | `browser/rallar.ts` budget 231 → 232 KiB lands in the scope task (231.211 measured on W-A's head); headless 294.886 of 295. Both are re-measured at the real commit since the tasks before it move the figures. Superseded in its figures by R-I2a-i-48: on the assembled tree Task 6 crosses nothing (231.863 / 295.511 under 232 / 296).                                                                                                                                                                                                                                                                                            | Global Constraints.                                                                                                               | None.                                                                                             |
| R-I2a-i-36 | The cleanup's silent zero result when IndexedDB is missing stays; the per-connect availability (Task 5, W-B) reports `missing` once, which is the one truthful place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | One report per cause per connect.                                                                                                 | None.                                                                                             |
| R-I2a-i-37 | The `initialiseMiddleware` scope wiring is pinned by the store-level disjoint-rows test and by `delivery-reload` (Task 9); no separate middleware unit test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The required field and the typecheck already enforce the wiring.                                                                  | A wiring regression surfaces in the lane, not a unit test.                                        |
| R-I2a-i-38 | The dispatch skips the durable carrier only while the availability cause is `missing`; every other cause is retried by the next durable admission, whose verdict re-decides availability.                                                                                                                                                                                                                                                                                                                                                                                                                                             | Quota frees and a closed connection reopens; a missing API does not.                                                              | A quota-bound session pays one failing commit per send until quota frees (typed each time).       |
| R-I2a-i-39 | The downgrade reaches the evidence through a new evidence-only settlement `durability-downgrade` (the evidence field stays `durabilityDowngrade: { requested, cause }`), not a field on the `admission` settlement that about 15 test files and the outbound effects build.                                                                                                                                                                                                                                                                                                                                                           | Same shape the receipt downgrade already uses; smaller blast radius.                                                              | None.                                                                                             |
| R-I2a-i-40 | The `volatile` choice re-admits the same msgId on the same carrier with the envelope's `qos.durability` rewritten to `volatile`; no lane override; a downgraded `local-inbox` send also loses the receiver's inbox persistence (stated in the PR body's Limits and in the setting's doc line).                                                                                                                                                                                                                                                                                                                                        | A downgrade is end to end; the note names the requested tier.                                                                     | None.                                                                                             |
| R-I2a-i-41 | Availability rides the per-connect middleware as `RallarBrowserMiddleware.storageAvailability: BrowserALStorageAvailability`, returned by `configureBrowserALRuntimeStores`; a public type gains a field (PR body: public surface).                                                                                                                                                                                                                                                                                                                                                                                                   | The connect owns the decision (highest point holding the stores).                                                                 | None.                                                                                             |
| R-I2a-i-42 | (Amends D127's wording) `navigator.storage.persist()` is asked once per connect on the first `admitted{durable:true}` verdict, after a `navigator.storage.persisted()` read: an already-granted browser reports `granted` without a prompt; a denial reads `denied` and a later connect asks again; neither call is awaited on the send path. Assembled: `toBrowserStoragePersistRequest` reads `persisted()` first; two cases pin it (calls recorded in an array, no new coupling candidate).                                                                                                                                        | Per-connect state is where the ask lives; `persisted()` prevents re-prompting a granted browser.                                  | A denying browser (Firefox) may prompt once per connect.                                          |
| R-I2a-i-43 | No probe open at connect: `missing` is decided from `typeof indexedDB` alone; `open-failed` and the other causes are learned from the first durable admission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | No IndexedDB operation at connect (the pins).                                                                                     | The first send after connect pays the discovery.                                                  |
| R-I2a-i-44 | Lane (harness) sends always refuse unless the scenario sets `onStorageUnavailable: 'volatile'`; `RallarStorageUnavailablePolicy` is exported from `rallar.ts`, `rallar-core.ts` and `rallar-messages.ts`; `ALDeliveryDurabilityDowngrade` stays unexported like `ALDeliveryReceiptDowngrade`.                                                                                                                                                                                                                                                                                                                                         | Public surface mirrors the existing downgrade.                                                                                    | None.                                                                                             |
| R-I2a-i-45 | `storage-unavailable` is not a delivery-level fallback trigger (D56/D65 list unchanged).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | A storage failure is not a carrier failure.                                                                                       | None.                                                                                             |
| R-I2a-i-46 | The memory twin `acknowledgement-under-transport-hold.test.ts` is deleted (a subset of its `-indexeddb` twin); `ws-retained-work-fault` and `browser-session-inbound-store` run on fake IndexedDB; the coupling registry gets one contract per executable assertion (11 contracts, 15 entries) with `semanticCoverage` equal to the contract's.                                                                                                                                                                                                                                                                                       | The end of the memory fallback makes the memory twins untrue.                                                                     | None.                                                                                             |
| R-I2a-i-47 | `wakeQueueBoxEngineIfQueued` takes `Pick<ALOutboundEnqueueResult, 'verdict'>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Narrow input.                                                                                                                     | None.                                                                                             |
| R-I2a-i-48 | Budgets on the assembled branch: headless 294 → 295 in Task 1 (W-A); `browser/rallar.ts` 231 → 232 in Task 4 (the channel setting), re-measured there; if Task 5 crosses 295 on real code it rises to 296 there. Assembled (each re-measured on its real commit): headless 294 → 295 in Task 1 (294.028), 295 → 296 in Task 4 (295.075), 296 → 297 in Task 8 (296.491), 297 → 298 in Task 9 (297.231); `rallar.ts` 231 → 232 in Task 3 (231.032: the idle-probe gate of R-I2a-i-50 adds 0.130 KiB to W-A's 230.902) and 232 → 233 in Task 8 (232.010). Task 4 raises no `rallar.ts` budget; Task 5 crosses nothing.                   | Global Constraints; the raise lands in the task that crosses.                                                                     | None.                                                                                             |
| R-I2a-i-49 | Assembly reconciliation: W-B's stub import paths `alm/al-storage-*.ts` become `alm/storage/al-storage-*.ts` (W-A's folder); W-B's stub commits are dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | One owner for the new modules.                                                                                                    | None.                                                                                             |
| R-I2a-i-50 | A durable lane whose open fails leaves `runtime.ready()` resolved (the lane's `Either` left recorded as health), starts no work task, so no idle readiness probe runs and health is not flooded; volatile lanes keep working. The assembler verifies W-A's Task 3 text states this and adds the step and its test if it does not. Assembled: W-A's text lacked it (the engine probed the missing database on every pass, measured 3 `al-work` attempts over 3 passes and a `TaskEngine error` each); Task 3 adds `ALStorageReadiness.readOpenedStore` and routes both lanes' idle probe through it, with a lane test and a unit case. | W-B's Task 5 depends on it.                                                                                                       | Without it a missing IndexedDB breaks volatile sends on connect.                                  |
| R-I2a-i-51 | The harness evidence projections (`black-box-rallar-delivery-ledger.ts:68`, `rallar-black-box-alm-result-values.ts:41`, `decode-alm-runtime-result.ts`) carry `durabilityDowngrade`; this lands in Task 9 (W-E) or, if W-E's text lacks it, the assembler adds it there. Assembled: W-E carried the page ledger; Task 9 Step 9 adds the result value and its decoder, with three decoder cases and the required field in four typed literals (one Deno).                                                                                                                                                                              | The lane asserts the downgrade through these projections.                                                                         | None.                                                                                             |
| R-I2a-i-52 | `fault.clear` is the existing release: re-inject the same `faultId` with `remaining: 0`; no new command kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Reuse of the transport fault's own release.                                                                                       | None.                                                                                             |
| R-I2a-i-53 | `observe()` returns `Promise<void> \| void`; call sites await only an `instanceof Promise` result, so the production pass-through adds no microtask; the harness observer counts first, then asks the fault port.                                                                                                                                                                                                                                                                                                                                                                                                                     | The ledger and operation-count pins stay unedited.                                                                                | None.                                                                                             |
| R-I2a-i-54 | `ScriptedStorageFault` carries `carrier: 'storage'`; `match.kind` is optional (absent = every kind of the owner); `quota` fails the write kinds only (write, work-write, work-reserve, work-release, work-cleanup) with `QuotaExceededError`; `fail` rejects with `UnknownError`.                                                                                                                                                                                                                                                                                                                                                     | One fault model beside the transport faults.                                                                                      | None.                                                                                             |
| R-I2a-i-55 | Recovery is reported from each durable lane's first `work-batch` (the bootstrap batch), through `ALStorageHealth.recordRecovery(outcome)`, not from `ready()`; a durable store whose work task never starts (storage missing) reports no recovery and its unavailability is reported instead; an existing database with an empty first batch reads `restored {claimed: 0, expired: 0}`; `expired` comes from a new `IndexedDbQueueBox.getReservationExpiredDeleteCount()` (the `reserveEntries` return type unchanged).                                                                                                               | Exactly one outcome per durable store that starts, per connect.                                                                   | None.                                                                                             |
| R-I2a-i-56 | Eviction versus another context's reset is told apart by a document-wide `LatestRepository` per database name fed by a `versionchange` listener; eviction becomes `Either.ofLeft({ cause: 'evicted' })` and is reported through the per-store `ALStorageHealth` (Task 2's value), never as a direct event from `browser-al-runtime-stores.ts`; `storage-reset`'s reason gains `'other-context'`.                                                                                                                                                                                                                                      | `packages/shared/cache` for the keyed state (D8); one emitter per store.                                                          | None.                                                                                             |
| R-I2a-i-57 | The recovery reporter is its own module in `packages/shared/alm/storage/` (W-A's folder), not folded into `open-indexed-db-admission-database.ts` (which would reach 356 lines and 11 runtime exports); the task's steps run the changed-style gate and, if the prefix-cluster finding fires on the fifth `al-storage-*` file, fold the reporter into the health module that owns `recordRecovery`. Assembled: `al-storage-recovery-reporter.ts` is the fifth `al-storage-*` file and `check:repo-style:changed` passes, so the fold-back does not apply.                                                                             | The density and export tiers; one owner.                                                                                          | None.                                                                                             |
| R-I2a-i-58 | The `health` event's keys are emitted in the order `kind`, `storeId`, `status`, `lastFailure`, `lastRecoveryPointAtMs`, and `lastFailure` is kept on the `healthy` transition; the scenario waits match `"status":"failing\|healthy","lastFailure":{"cause":"quota"`. Assembled: Task 2 pins the order with a JSON-text case.                                                                                                                                                                                                                                                                                                         | The harness waits are substring matches on the emitted JSON.                                                                      | A reordered emitter silently breaks the lane.                                                     |
| R-I2a-i-59 | `storage-unavailable` uses one type id for two channels (the default refuses, the other names `'volatile'`); three sends: refused, downgraded, committed after the release; the receiver gets 2 and 3, never 1.                                                                                                                                                                                                                                                                                                                                                                                                                       | One scenario proves both policy values and the health transitions.                                                                | None.                                                                                             |
| R-I2a-i-60 | `delivery-reload` waits inside its suffix for `restored` from the session inbound store and from the store holding the original; the reload identity assessment allows a `wait` there; checkpoint ids unchanged; the store-id prefixes are literal in the catalog (the Deno control server has no `@shared-web` alias) and a Vitest test pins them to the browser's id builders.                                                                                                                                                                                                                                                      | The Deno runtime cannot import the browser builders.                                                                              | A renamed id breaks the pin, not the lane silently.                                               |
| R-I2a-i-61 | Manifest 18 is regenerated and its description prose names `storage-unavailable`; manifest 22 and the entries file are unchanged; the Deno fixture `control-generated-alm-reload.test.ts` models the quota, the downgrade, the health transitions and the recoveries. Assembled: the description string in `hetzner-alm-manifest-entries.ts` changes (no entry, family or recipe change), and manifest 18 is regenerated with it.                                                                                                                                                                                                     | Docs truth; hosted 18 runs the new two-agent scenario.                                                                            | None.                                                                                             |
| R-I2a-i-62 | The send decoder's option checks fold into one `decodeKnownSendOption`; the storage waits stay private to their scenario files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Both files stay under the style thresholds.                                                                                       | None.                                                                                             |
| R-I2a-i-63 | Tooling follow-up (not this PR): the style checker misreads an apostrophe in a doc comment inside a type literal and re-keys five `boundary.unknown` findings; the plan's comments avoid apostrophes there.                                                                                                                                                                                                                                                                                                                                                                                                                           | Scope.                                                                                                                            | Listed in the PR body's follow-ups.                                                               |

---

### Task 1: `ALStorageUnavailable` and `toALStorageUnavailable`

Prototyped in `scratch-A` (branch `scratch/i2a-A`) as commit `5301d3980` on `7e6f0a117` (red, then green);
assembled unchanged as `7afe08a40` on `scratch/i2a-assemble`.
Proposal §1.1, §3.a; decision D122 (the value the verdict arm carries). Fact sheet items 2 and 4.

**Files**

- Create: `packages/shared/alm/storage/al-storage-unavailable.ts` — `ALStorageUnavailableCause`,
  `ALStorageUnavailable`, `ALStorageUnavailableError`, `toALStorageUnavailable` (56 lines). A new feature folder
  `alm/storage/` because `packages/shared/alm` already holds 20 direct files (the `layout.directory-density` review
  threshold is > 20, R-I2a-i-9).
- Modify: `packages/shared/alm/open-indexed-db-admission-database.ts` — `ALStorageResetBlockedError` (`:36-42` at
  base) now extends `ALStorageUnavailableError` with cause `reset-blocked`, same name and message;
  `openIndexedDbAdmissionDatabase` (`:81-94`) raises `missing` before its first open; `openOrReset` (`:96-112`) opens
  through a new `openAdmissionStores`, which raises the open request's own failure as `open-failed` (new
  `toOpenFailedError`).
- Create: `packages/tests/shared/alm/storage/al-storage-unavailable.test.ts` (9 cases).
- Modify: `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` — 294 → 295 (measured, Step 8).
- Not touched: `packages/shared/persistence/open-indexed-db.ts` (its tests pin the raw open errors by name:
  `packages/tests/shared/open-indexed-db.test.ts:82-114`), every backend (`ALAdmissionWorkBackend` keeps its I/O shape),
  `PersistenceWriteExpiredError`, `ALAdmissionCorruptionError`, `ALAdmissionBackendConflictError`,
  `IndexedDbQueueWriteConflictError`.

**Interfaces**

- Consumes: `toError` (`packages/shared/resilience/to-error.ts`); `OpenedIndexedDb` (exported type,
  `packages/shared/persistence/open-indexed-db.ts:30`).
- Produces (`packages/shared/alm/storage/al-storage-unavailable.ts`):
  ```ts
  export type ALStorageUnavailableCause =
      | 'missing'
      | 'open-failed'
      | 'reset-blocked'
      | 'quota'
      | 'closed'
      | 'evicted'
      | 'transaction-failed';
  export interface ALStorageUnavailable {
      readonly cause: ALStorageUnavailableCause;
      readonly detail: string;
  }
  export class ALStorageUnavailableError extends Error {
      readonly unavailable: ALStorageUnavailable;
      constructor(unavailable: ALStorageUnavailable, options?: ErrorOptions);
  }
  export function toALStorageUnavailable(error: Error): ALStorageUnavailable | undefined;
  ```
  Classification: an `ALStorageUnavailableError` (and so `ALStorageResetBlockedError`) answers its own value; a
  `DOMException` named `QuotaExceededError` → `quota`, `InvalidStateError` → `closed`, `UnknownError`, `AbortError`,
  `TransactionInactiveError` → `transaction-failed`, with `detail` = `` `${name}: ${message}` ``; everything else
  (`PersistenceWriteExpiredError`, `ALAdmissionCorruptionError`, both conflict errors, `ConstraintError`, `DataError`,
  a plain `Error`) → `undefined`. The parameter is `Error`, not `unknown` (R-I2a-i-10): callers normalize the caught
  value with `toError` once, as the code standard asks, and the changed-style gate's `boundary.unknown` rule exempts
  only `decode*` and type-guard parameters. `missing` and `open-failed` are raised by the opener as an
  `ALStorageUnavailableError`, because only its position knows them; `evicted` has no producer in this task — Task 9's
  recovery reporter produces it as a value (`{ cause: 'evicted', detail }`) and records it on the store's health, with
  no throw (the open itself succeeded; R-I2a-i-56). The error class still carries it for a raiser that knows the cause
  (R-I2a-i-22), which is what the classification case below reads.

**D8 reuse inspection.** Reused: `toError`; the opener's own error class (`ALStorageResetBlockedError` becomes the
`reset-blocked` member of the new class instead of gaining a sibling); the DOMException names IndexedDB already raises;
`OpenedIndexedDb`. Not added: no error hierarchy beyond the one class (the alternative, one class per cause, would
duplicate the `cause` field in seven constructors); no change to `openIndexedDbWithValidatedStores` (the shared
persistence open stays cause-agnostic; its tests pin raw `AbortError`/`DataCloneError`); no `Either` from the backends
(D122's "backends keep their I/O shape"); no `navigator`/`indexedDB` read inside the classifier (it stays pure; the
opener decides `missing`). No new IndexedDB operation, so no pin moves.

- [ ] **Step 1: Write the failing test.** Create `packages/tests/shared/alm/storage/al-storage-unavailable.test.ts`:

```ts
// packages/tests/shared/alm/storage/al-storage-unavailable.test.ts
import * as FakeIndexedDb from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    ALStorageResetBlockedError,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    ALStorageUnavailableError,
    toALStorageUnavailable
} from '@shared/alm/storage/al-storage-unavailable.ts';
import { readIndexedDbRequest } from '@shared/persistence/indexed-db-request.ts';
import { PersistenceWriteExpiredError } from '@shared/persistence/persistence-write-deadline.ts';
import { IndexedDbQueueWriteConflictError } from '@shared/queuebox/indexed-db-queue-write-conflict-error.ts';
import { toError } from '@shared/resilience/to-error.ts';

const STORE_NAME = 'entries';

describe('toALStorageUnavailable', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('reads missing when the admission database is opened without IndexedDB', async () => {
        vi.stubGlobal('indexedDB', undefined);

        const error = await readOpenFailure(`al-storage-missing-${crypto.randomUUID()}`);

        expect(error).toBeInstanceOf(ALStorageUnavailableError);
        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'missing',
            detail: 'IndexedDB is not available in this environment'
        });
    });

    // The open request itself fails: a VersionError from asking for an older version than the stored one.
    it('reads open-failed when the open request of the admission database fails', async () => {
        const factory = new FakeIndexedDb.IDBFactory();
        vi.stubGlobal('indexedDB', factory);
        const dbName = `al-storage-open-failed-${crypto.randomUUID()}`;
        await createDatabaseAtVersion(factory, dbName, 2);
        const open = factory.open.bind(factory);
        vi.spyOn(factory, 'open').mockImplementation((name: string) => open(name, 1));

        const error = await readOpenFailure(dbName);

        expect(error).toMatchObject({
            name: 'ALStorageUnavailableError',
            cause: { name: 'VersionError' }
        });
        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'open-failed',
            detail: expect.stringMatching(
                new RegExp(`^IndexedDB open of "${dbName}" failed: VersionError: `)
            )
        });
    });

    // The delete that stays blocked is pinned against the real database in browser-al-storage-reset.test.ts;
    // it waits the 5 s timeout in real time, so the classification reads a constructed error.
    it('reads reset-blocked from the blocked reset error', () => {
        const error = new ALStorageResetBlockedError('al-runtime');

        expect(error.name).toBe('ALStorageResetBlockedError');
        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'reset-blocked',
            detail: 'IndexedDB database "al-runtime" delete is blocked by an open connection'
        });
    });

    // fake-indexeddb has no storage quota, so the classification reads a constructed DOMException.
    it('reads quota from a QuotaExceededError', () => {
        expect(
            toALStorageUnavailable(
                new DOMException('The quota has been exceeded.', 'QuotaExceededError')
            )
        )
            .toEqual({
                cause: 'quota',
                detail: 'QuotaExceededError: The quota has been exceeded.'
            });
    });

    it('reads closed when a transaction starts on a connection that was closed', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const db = await openIndexedDbAdmissionDatabase({
            dbName: `al-storage-closed-${crypto.randomUUID()}`,
            storeName: STORE_NAME,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        db.close();

        const error = readThrown(() => db.transaction(STORE_NAME, 'readonly'));

        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'closed',
            detail: expect.stringMatching(/^InvalidStateError: /)
        });
    });

    // The database vanishing under an open document is detected on reopen, which raises this error.
    it('reads evicted from the error that carries it', () => {
        const error = new ALStorageUnavailableError({
            cause: 'evicted',
            detail: 'al-runtime was recreated'
        });

        expect(toALStorageUnavailable(error)).toEqual({
            cause: 'evicted',
            detail: 'al-runtime was recreated'
        });
    });

    it('reads transaction-failed from a request the abort of its transaction failed', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const db = await openIndexedDbAdmissionDatabase({
            dbName: `al-storage-aborted-${crypto.randomUUID()}`,
            storeName: STORE_NAME,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const written = readIndexedDbRequest(
            transaction.objectStore(STORE_NAME).put({
                key: 'row',
                value: '1',
                expireAtTimestamp: 0
            })
        );
        transaction.abort();

        const error = await written.then(() => undefined, toError);
        db.close();

        expect(error?.name).toBe('AbortError');
        expect(toALStorageUnavailable(error!)).toEqual({
            cause: 'transaction-failed',
            detail: expect.stringMatching(/^AbortError: /)
        });
    });

    // fake-indexeddb raises no UnknownError, so the classification reads a constructed DOMException.
    it('reads transaction-failed from an UnknownError', () => {
        expect(toALStorageUnavailable(new DOMException('Internal error.', 'UnknownError')))
            .toEqual({ cause: 'transaction-failed', detail: 'UnknownError: Internal error.' });
    });

    it('leaves a write deadline, a corrupt row, a conflict and a code defect unclassified', async () => {
        vi.stubGlobal('indexedDB', new FakeIndexedDb.IDBFactory());
        const constraint = await readConstraintError(
            `al-storage-constraint-${crypto.randomUUID()}`
        );

        expect(constraint.name).toBe('ConstraintError');
        for (
            const error of [
                new PersistenceWriteExpiredError(),
                new ALAdmissionCorruptionError('row', new Error('bad row')),
                new ALAdmissionBackendConflictError('moved'),
                new IndexedDbQueueWriteConflictError('moved'),
                constraint,
                new DOMException('Bad key.', 'DataError'),
                new Error('IndexedDB transaction failed')
            ]
        ) {
            expect(toALStorageUnavailable(error)).toBeUndefined();
        }
    });
});

async function readOpenFailure(dbName: string): Promise<Error> {
    return await openIndexedDbAdmissionDatabase({
        dbName,
        storeName: STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    }).then(
        (db) => {
            db.close();
            throw new Error('the open was expected to fail');
        },
        toError
    );
}

async function createDatabaseAtVersion(
    factory: IDBFactory,
    dbName: string,
    version: number
): Promise<void> {
    const request = factory.open(dbName, version);
    request.onupgradeneeded = () =>
        request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    (await readIndexedDbRequest(request)).close();
}

function readThrown(run: () => void): Error {
    try {
        run();
    }
    catch (error) {
        return toError(error);
    }
    throw new Error('the call was expected to throw');
}

async function readConstraintError(dbName: string): Promise<Error> {
    const db = await openIndexedDbAdmissionDatabase({
        dbName,
        storeName: STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    });
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    store.add({ key: 'row', value: '1', expireAtTimestamp: 0 });
    const error = await readIndexedDbRequest(
        store.add({ key: 'row', value: '2', expireAtTimestamp: 0 })
    )
        .then(() => new Error('the second add was expected to fail'), toError);
    db.close();
    return error;
}
```

- [ ] **Step 2: Run it and see it fail.**

```sh
npx vitest run packages/tests/shared/alm/storage/al-storage-unavailable.test.ts
```

Expected (measured at `7e6f0a117`): `Test Files  1 failed (1)`, `Tests  no tests` — the suite does not load:
`Cannot find package '@shared/alm/storage/al-storage-unavailable.ts'`.

- [ ] **Step 3: Create `packages/shared/alm/storage/al-storage-unavailable.ts`:**

```ts
// packages/shared/alm/storage/al-storage-unavailable.ts
/**
 * Why a browser ALM store cannot persist: IndexedDB is absent (`missing`), its open request failed
 * (`open-failed`), a reset's delete stayed blocked (`reset-blocked`), a write hit the quota (`quota`),
 * a `versionchange` closed the connection (`closed`), the database vanished under the document
 * (`evicted`), or a transaction failed for another reason (`transaction-failed`).
 */
export type ALStorageUnavailableCause =
    | 'missing'
    | 'open-failed'
    | 'reset-blocked'
    | 'quota'
    | 'closed'
    | 'evicted'
    | 'transaction-failed';

export interface ALStorageUnavailable {
    readonly cause: ALStorageUnavailableCause;
    readonly detail: string;
}

/** Raised where only the raising code knows the cause: IndexedDB absent, an open that failed, a database that vanished. */
export class ALStorageUnavailableError extends Error {
    readonly unavailable: ALStorageUnavailable;

    constructor(unavailable: ALStorageUnavailable, options?: ErrorOptions) {
        super(unavailable.detail, options);
        this.name = 'ALStorageUnavailableError';
        this.unavailable = unavailable;
    }
}

const AL_STORAGE_UNAVAILABLE_CAUSES_BY_DOM_EXCEPTION_NAME: ReadonlyMap<
    string,
    ALStorageUnavailableCause
> = new Map([
    ['QuotaExceededError', 'quota'],
    ['InvalidStateError', 'closed'],
    ['UnknownError', 'transaction-failed'],
    ['AbortError', 'transaction-failed'],
    ['TransactionInactiveError', 'transaction-failed']
]);

/**
 * The storage failure an error is, or `undefined` for every other error: a write deadline, a corrupt
 * row, a conflict and a code defect keep their own meanings. The PostgreSQL backend raises none of these.
 */
export function toALStorageUnavailable(error: Error): ALStorageUnavailable | undefined {
    if (error instanceof ALStorageUnavailableError) {
        return error.unavailable;
    }
    const cause = isDOMException(error)
        ? AL_STORAGE_UNAVAILABLE_CAUSES_BY_DOM_EXCEPTION_NAME.get(error.name)
        : undefined;
    return cause === undefined ? undefined : { cause, detail: `${error.name}: ${error.message}` };
}

function isDOMException(error: Error): error is DOMException {
    return typeof DOMException !== 'undefined' && error instanceof DOMException;
}
```

- [ ] **Step 4: Raise `missing`, `open-failed` and `reset-blocked` from the opener.** Apply to
      `packages/shared/alm/open-indexed-db-admission-database.ts`:

```diff
diff --git a/packages/shared/alm/open-indexed-db-admission-database.ts b/packages/shared/alm/open-indexed-db-admission-database.ts
index cdfd0c46a..45610c435 100644
--- a/packages/shared/alm/open-indexed-db-admission-database.ts
+++ b/packages/shared/alm/open-indexed-db-admission-database.ts
@@ -1,13 +1,16 @@
 import { readIndexedDbRequest } from '../persistence/indexed-db-request.ts';
 import {
     openIndexedDbWithValidatedStores,
-    type IndexedDbStoreDefinition
+    type IndexedDbStoreDefinition,
+    type OpenedIndexedDb
 } from '../persistence/open-indexed-db.ts';
 import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
 import { toIndexedDbQueueStoreDefinition } from '../queuebox/indexed-db-queue-box-store.ts';
+import { toError } from '../resilience/to-error.ts';
 import { decodeALAdmissionStoredValue } from './al-admission-backend.ts';
 import { decodeALAdmissionValue } from './al-admission-decoder.ts';
 import { decodeALAdmissionString } from './al-admission-value-validation.ts';
+import { ALStorageUnavailableError } from './storage/al-storage-unavailable.ts';
 
 export const AL_ADMISSION_WORK_STORE_NAME = 'alm-work';
 
@@ -34,9 +37,12 @@ export interface OpenIndexedDbAdmissionDatabaseInput {
 }
 
 /** Thrown when `indexedDB.deleteDatabase` stays blocked by another open connection past its timeout. */
-export class ALStorageResetBlockedError extends Error {
+export class ALStorageResetBlockedError extends ALStorageUnavailableError {
     constructor(dbName: string) {
-        super(`IndexedDB database "${dbName}" delete is blocked by an open connection`);
+        super({
+            cause: 'reset-blocked',
+            detail: `IndexedDB database "${dbName}" delete is blocked by an open connection`
+        });
         this.name = 'ALStorageResetBlockedError';
     }
 }
@@ -81,6 +87,12 @@ export class ALStorageResetListeners {
 export async function openIndexedDbAdmissionDatabase(
     input: OpenIndexedDbAdmissionDatabaseInput
 ): Promise<IDBDatabase> {
+    if (typeof indexedDB === 'undefined') {
+        throw new ALStorageUnavailableError({
+            cause: 'missing',
+            detail: 'IndexedDB is not available in this environment'
+        });
+    }
     const first = await openOrReset(input, undefined);
     if (first.kind === 'open') {
         return first.db;
@@ -97,10 +109,7 @@ async function openOrReset(
     input: OpenIndexedDbAdmissionDatabaseInput,
     attempt: OpenOrResetAttempt
 ): Promise<OpenOrResetResult> {
-    const opened = await openIndexedDbWithValidatedStores(
-        input.dbName,
-        toAdmissionStoreDefinitions(input.storeName, input.schemaId)
-    );
+    const opened = await openAdmissionStores(input);
     if (opened.schemaIssues.length === 0) {
         return await toSchemaIdMismatchReset(input, attempt, opened.db);
     }
@@ -111,6 +120,26 @@ async function openOrReset(
     return await toStoreSchemaMismatchReset(input);
 }
 
+/** Only the open request's own failure is `open-failed`; what the opened stores hold is checked after it. */
+async function openAdmissionStores(input: OpenIndexedDbAdmissionDatabaseInput): Promise<OpenedIndexedDb> {
+    try {
+        return await openIndexedDbWithValidatedStores(
+            input.dbName,
+            toAdmissionStoreDefinitions(input.storeName, input.schemaId)
+        );
+    }
+    catch (error) {
+        throw toOpenFailedError(input.dbName, toError(error));
+    }
+}
+
+function toOpenFailedError(dbName: string, error: Error): ALStorageUnavailableError {
+    return new ALStorageUnavailableError(
+        { cause: 'open-failed', detail: `IndexedDB open of "${dbName}" failed: ${error.name}: ${error.message}` },
+        { cause: error }
+    );
+}
+
 async function toStoreSchemaMismatchReset(
     input: OpenIndexedDbAdmissionDatabaseInput
 ): Promise<OpenOrResetResult> {
```

- [ ] **Step 5: Format the touched files.**

```sh
npx dprint fmt packages/shared/alm/storage/al-storage-unavailable.ts packages/shared/alm/open-indexed-db-admission-database.ts packages/tests/shared/alm/storage/al-storage-unavailable.test.ts
```

- [ ] **Step 6: Run the new test and the opener's neighbours.**

```sh
npx vitest run packages/tests/shared/alm/storage/al-storage-unavailable.test.ts packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts packages/tests/shared/open-indexed-db.test.ts packages/tests/shared/alm/al-admission-backend.test.ts
```

Expected (measured): `Test Files  4 passed (4)`, `Tests  61 passed (61)` (9 new; the reset suite still sees
`ALStorageResetBlockedError` by `instanceof` and name, `browser-al-storage-reset.test.ts:200`, which waits its 5 s
timeout in real time).

- [ ] **Step 7: Constraint checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit                      # exit 0
npm --workspace @ar-eye-hunter/shared-web run typecheck                # exit 0
npm --workspace @ar-eye-hunter/shared-server run typecheck             # exit 0
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1410 test files enforced, 0 files carrying known debt (0 errors).
# PASS: no new type errors in the maintained test project
```

- [ ] **Step 8: Bundles.** The classifier and the error class reach both browser bundles.

```sh
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles   # Bundle budget check passed.
npx vitest run packages/tests/rallar-black-box-headless
```

Measured (brotli q11, the gates' method): `browser/rallar.ts` 230.106 → 230.370 KiB (budget 231, passes); the headless
agent 293.694 → 294.028 KiB, which fails `headless-bundle-boundary.test.ts` against 294 with "raise it to 295". Raise
it to the next whole KiB, and nothing more:

```json
{
  "brotliBudgetKiB": 295
}
```

(`packages/tests/rallar-black-box-headless/headless-bundle-budget.json`; rerun: `Tests  4 passed (4)`.) The same
figures were measured on the assembled commit `7afe08a40` (R-I2a-i-23, R-I2a-i-48).

- [ ] **Step 9: Commit.**

```sh
git add packages/shared/alm/storage/al-storage-unavailable.ts packages/shared/alm/open-indexed-db-admission-database.ts packages/tests/shared/alm/storage/al-storage-unavailable.test.ts packages/tests/rallar-black-box-headless/headless-bundle-budget.json
git commit -m "Classify a browser ALM storage failure as ALStorageUnavailable

toALStorageUnavailable reads one of seven causes from an error: missing,
open-failed, reset-blocked, quota, closed, evicted, transaction-failed. The
admission database's opener raises missing and open-failed as an
ALStorageUnavailableError, and ALStorageResetBlockedError becomes one. A
write deadline, a corrupt row, a conflict and a code defect stay unclassified.

The headless agent measures 294.028 KiB (293.694 before), so its budget
rises from 294 to 295 KiB; rallar.ts measures 230.370 KiB (230.106).

D8 reuse: reuses toError, the opener's own error class and the DOMException names; no new error hierarchy, no change to the shared persistence open or to any backend's I/O shape."
```

- [ ] **Step 10: Changed-range gates (need the commit).**

```sh
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings (c86ee9519… -> HEAD).
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: no current structure-coupled test candidates
# PASS: changed-range structure-coupling review has complete individual classifications
# PASS: registry entries are complete and current
```

Navigation maps: none changes in this task (the value has no reader yet; Task 3 documents where it is answered).

---

### Task 2: the `storage` port, `ALStorageEvent` and the per-store health

Prototyped in `scratch-A` as commit `14d2a5b17` on Task 1's `5301d3980` (red, then green); assembled as `bdbdabd2d`
on `scratch/i2a-assemble` with one more health case (the key order, R-I2a-i-58). It runs second (R-I2a-i-8): Task 3
records failures and recovery points into the `ALStorageHealth` this task creates and attaches to the store pairs,
and nothing in this task reads Task 3. Proposal §1.3, §3.b, §3.h (the recovery outcome union only); decision D121.
Fact sheet items 1, 8, 11, 12.

**Files**

- Create: `packages/shared/alm/storage/al-storage-event.ts` (45 lines) — `ALStorageHealthStatus`,
  `ALStorageHealthState`, `ALStorageRecoveryOutcome`, `ALStoragePersistOutcome`, `ALStorageEvent`,
  `ALStorageEventSink`, `createPassThroughALStorageEventSink`, `toALStorageResetSink`.
- Create: `packages/shared/alm/storage/al-storage-health.ts` (46 lines) — `ALStorageHealth` over an
  `ObservableLatestValue<ALStorageHealthState>`.
- Modify: `packages/shared/alm/al-runtime-stores.ts` — `CreateIndexedDbALRuntimeStoresInput.storageHealth` (`:67-72`
  at base), `CreateDefaultALRuntimeStoresInput.storageHealth?` (`:82-96`), both IndexedDB factories return it
  (`:146`, `:177-178`), `toDefaultIndexedDbInput` passes it (`:309-319`). The memory factories do not (no storage
  failure reaches a memory pair).
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (`ALOutboundRuntimeStores`, `:172-180`) and
  `packages/shared/alm/inbound/al-inbound-message-runtime.ts` (`ALInboundRuntimeStores`, `:32-35`) — an optional
  `storageHealth?: ALStorageHealth`, beside the outbound pair's optional `storageResets`.
- Modify: `packages/shared-web/browser/connection/rallar-diagnostics-ports.ts` — `storage` replaces `onStorageReset`
  on `RallarDiagnosticsPortsInput` (`:24`) and `RallarDiagnosticsPorts` (`:33`); default pass-through (`:55`).
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts` — `toBrowserRuntimeStoreScopes`
  (`:66-100`) takes the port and gives each scope `toBrowserStoreOptions` (new): its reset sink names the store and
  one `ALStorageHealth` per store per connect; `configureBrowserALRuntimeStores` (`:150-169`) no longer passes the
  port's reset sink itself.
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts` — the four option shapes and
  `openBrowserALRuntimeDatabase` (`:72-76`, `:107-118`, `:131-134`, `:170`, `:182-191`, `:194-210`) take `storage`;
  the cleanup's reset names the database it opens.
- Modify: `packages/shared-web/browser/connection/initialise-browser-middleware.ts:279`,
  `packages/shared-web/browser/session/session-auth-lifecycle.ts:315` — pass `storage`.
- Modify: `packages/shared-web/browser/rallar.ts` (after `:286`, the `al-delivery-lifecycle.ts` type export), `packages/shared-web/browser/rallar-core.ts` (after
  `:132`) — export the types `ALStorageEvent`, `ALStorageRecoveryOutcome`, `ALStorageUnavailable`,
  `ALStorageUnavailableCause`.
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts:129-130`
  — `storage`: the `reset` arm keeps `rallar.browser.alm.storage_reset` with the unchanged `ALStorageResetEvent`
  payload; every other arm goes to `rallar.browser.alm.storage`.
- Docs: `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (§ Storage Reset Diagnostics, new
  § Storage Diagnostics), `packages/shared/alm/outbound/README.md:815-817` (the reset's browser arm).
- Tests: create `packages/tests/shared/alm/storage/al-storage-health.test.ts` (7 cases); modify
  `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts` (one new case, ports rename),
  `browser-outbound-cleanup.test.ts`, `packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts` (one new
  case), `replay-captured-message.test.ts`, `rtc-message-nack-diagnostics.test.ts`,
  `packages/tests/shared-web/composition/browser-facade-behavior.test.ts`,
  `packages/tests/shared-web/rallar-facade-defaults.test.ts`, `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`.
- Not touched: the `alm/` factory input `onStorageReset` and `IndexedDbAdmissionBackend.Input.onStorageReset` (D121:
  the browser composition adapts them), `ALStorageResetListeners`, the reload identity assessment
  (`packages/tests/shared-test/alm-identity-assessment.test.ts:331-349` reads `storage_reset` unchanged).

**Interfaces**

- Consumes: Task 1's `ALStorageUnavailable` (`packages/shared/alm/storage/al-storage-unavailable.ts`);
  `ObservableLatestValue` (`packages/shared/cache/ObservableLatestValue.ts`: `accept`, `peek`, `onUpdatedDo`, the
  `equals` option); `ALStorageResetEvent`.
- Produces:
  ```ts
  // packages/shared/alm/storage/al-storage-event.ts
  export type ALStorageHealthStatus = 'healthy' | 'failing';
  export interface ALStorageHealthState {
      readonly status: ALStorageHealthStatus;
      readonly lastFailure: ALStorageUnavailable | undefined;      // undefined before any failure
      readonly lastRecoveryPointAtMs: number | undefined;          // undefined before the first durable commit
  }
  export type ALStorageRecoveryOutcome =
      | Readonly<{ kind: 'restored'; claimed: number; expired: number; }>
      | Readonly<{ kind: 'expired-at-recovery'; expired: number; }>
      | Readonly<{ kind: 'storage-created'; }>
      | Readonly<{ kind: 'storage-reset'; reason: ALStorageResetEvent['reason']; }>;
  export type ALStoragePersistOutcome = 'granted' | 'denied' | 'unsupported';
  export type ALStorageEvent =
      | Readonly<{ kind: 'reset'; storeId: string; event: ALStorageResetEvent; }>
      | Readonly<{ kind: 'recovery'; storeId: string; outcome: ALStorageRecoveryOutcome; }>
      | (Readonly<{ kind: 'health'; storeId: string; }> & ALStorageHealthState)
      | Readonly<{ kind: 'persist'; outcome: ALStoragePersistOutcome; }>;
  export type ALStorageEventSink = (event: ALStorageEvent) => void;
  export function createPassThroughALStorageEventSink(): ALStorageEventSink;
  export function toALStorageResetSink(storage: ALStorageEventSink, storeId: string): (event: ALStorageResetEvent) => void;

  // packages/shared/alm/storage/al-storage-health.ts
  export namespace ALStorageHealth {
      export interface Input { readonly storeId: string; readonly storage: ALStorageEventSink; }
  }
  export class ALStorageHealth {
      constructor(input: ALStorageHealth.Input);
      recordFailure(failure: ALStorageUnavailable): void;     // healthy → failing states `health`
      recordRecoveryPoint(atMs: number): void;                // failing → healthy states `health`
  }

  // packages/shared-web/browser/connection/rallar-diagnostics-ports.ts
  RallarDiagnosticsPortsInput.storage?: ALStorageEventSink;   // replaces onStorageReset?
  RallarDiagnosticsPorts.storage: ALStorageEventSink;          // replaces onStorageReset

  // store pairs (both directions), absent for a pair no storage failure reaches
  ALOutboundRuntimeStores<T>.storageHealth?: ALStorageHealth;
  ALInboundRuntimeStores.storageHealth?: ALStorageHealth;
  CreateIndexedDbALRuntimeStoresInput.storageHealth: ALStorageHealth | undefined;
  CreateDefaultALRuntimeStoresInput.storageHealth?: ALStorageHealth;

  // browser cleanup options: `storage: ALStorageEventSink` replaces `onStorageReset`
  DeleteExpiredBrowserALRuntimeEntriesOptions, InitBrowserALRuntimeExpiryEvictionInput,
  deleteBrowserALRuntimeEntriesForSession(sessionId, { storage })
  ```
  Store ids: `browser-session-inbound:<sessionId>`, `browser-ws-client:<sessionId>`, `browser-rtc-overlay:<sessionId>`
  (the registry scope ids, `browser-al-runtime-identity.ts:16-29`); the cleanup's own reset names the database it opens
  (`BROWSER_AL_RUNTIME_DB_NAME`, R-I2a-i-18; Task 6 replaces the constant by the scope's name at the same call). Health: one `ALStorageHealth` per store scope per
  `configureBrowserALRuntimeStores` call (one per connect), shared by every resolve of that scope; it starts `healthy`
  without an event and states only a change of status (an `ObservableLatestValue` whose `equals` compares `status`, so
  a repeated failure is a `Refreshed` event its `onUpdatedDo` listener never sees). A recovery point while healthy
  writes nothing to the value. The listener runs on the value's promise queue, so a throwing port never reaches the
  recorder. `recovery` and `persist` have no producer in this task (Tasks 5 and 9 state them; Task 9 adds
  `ALStorageHealth.recordRecovery(outcome)`, R-I2a-i-22). The `health` event's keys are emitted in the order `kind`,
  `storeId`, `status`, `lastFailure`, `lastRecoveryPointAtMs`, and `lastFailure` is kept on the `healthy` transition
  (R-I2a-i-58): the lane's waits (Task 9) match the emitted JSON as text, so a case pins the order.

**D8 reuse inspection.** Reused: `ObservableLatestValue` from `packages/shared/cache` is the per-store state; its
`equals` option plus `onUpdatedDo` is the transition detector (no hand-written previous-status comparison, no Map of
store ids: each store's health is constructed once in the composition root and travels with its pair, as
`storageResets` does); `ALStorageResetListeners` and the ALM factories' `onStorageReset` input are kept and adapted
by `toALStorageResetSink`, not duplicated (D121); the registry scope ids are the store ids. Not added: no second port
beside `storage`; no `ObservableLatestRepository` keyed by store id (each owner holds its own value, so a keyed
repository would add a lookup no caller needs); no new timer; no IndexedDB operation, so no pin moves; no change to the
volatile pairs (`storageHealth` absent).

- [ ] **Step 1: Write the failing ALM test.** Create `packages/tests/shared/alm/storage/al-storage-health.test.ts`:

```ts
// packages/tests/shared/alm/storage/al-storage-health.test.ts
import { describe, expect, it, vi } from 'vitest';

import { toALStorageResetSink, type ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type { ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';

const QUOTA: ALStorageUnavailable = { cause: 'quota', detail: 'QuotaExceededError: full' };
const CLOSED: ALStorageUnavailable = { cause: 'closed', detail: 'InvalidStateError: closed' };

describe('ALStorageHealth', () => {
    it('starts healthy and states nothing until the first failure', async () => {
        const { events } = createHealth();

        await flushListeners();

        expect(events).toEqual([]);
    });

    it('states failing once on the first failure, with no recovery point yet', async () => {
        const { health, events } = createHealth();

        health.recordFailure(QUOTA);
        health.recordFailure(CLOSED);

        await vi.waitFor(() => expect(events).toHaveLength(1));
        await flushListeners();
        expect(events).toEqual([{
            kind: 'health',
            storeId: 'browser-ws-client:session-1',
            status: 'failing',
            lastFailure: QUOTA,
            lastRecoveryPointAtMs: undefined
        }]);
    });

    // The harness waits match the emitted JSON as text, so the key order is part of the event.
    it('states the health keys in a fixed order and keeps the failure on healthy', async () => {
        const { health, events } = createHealth();

        health.recordFailure(QUOTA);
        health.recordRecoveryPoint(2_000);

        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(events.map((event) => JSON.stringify(event))).toEqual([
            '{"kind":"health","storeId":"browser-ws-client:session-1","status":"failing","lastFailure":{"cause":"quota","detail":"QuotaExceededError: full"}}',
            '{"kind":"health","storeId":"browser-ws-client:session-1","status":"healthy","lastFailure":{"cause":"quota","detail":"QuotaExceededError: full"},"lastRecoveryPointAtMs":2000}'
        ]);
    });

    // Every durable commit is a recovery point; only the one that ends a failure is stated.
    it('states healthy at the first recovery point after a failure', async () => {
        const { health, events } = createHealth();

        health.recordRecoveryPoint(1_000);
        health.recordFailure(QUOTA);
        health.recordRecoveryPoint(2_000);
        health.recordRecoveryPoint(3_000);

        await vi.waitFor(() => expect(events).toHaveLength(2));
        await flushListeners();
        expect(events).toEqual([
            {
                kind: 'health',
                storeId: 'browser-ws-client:session-1',
                status: 'failing',
                lastFailure: QUOTA,
                lastRecoveryPointAtMs: 1_000
            },
            {
                kind: 'health',
                storeId: 'browser-ws-client:session-1',
                status: 'healthy',
                lastFailure: QUOTA,
                lastRecoveryPointAtMs: 2_000
            }
        ]);
    });

    it('states nothing for recovery points while healthy', async () => {
        const { health, events } = createHealth();

        health.recordRecoveryPoint(1_000);
        health.recordRecoveryPoint(2_000);
        await flushListeners();

        expect(events).toEqual([]);
    });

    it('keeps recording when the storage port throws', async () => {
        const events: ALStorageEvent[] = [];
        const health = new ALStorageHealth({
            storeId: 'browser-ws-client:session-1',
            storage: (event) => {
                events.push(event);
                throw new Error('sink failed');
            }
        });

        health.recordFailure(QUOTA);
        health.recordRecoveryPoint(1_000);

        await vi.waitFor(() =>
            expect(events.map((event) => event.kind === 'health' ? event.status : event.kind))
                .toEqual(['failing', 'healthy'])
        );
    });
});

describe('toALStorageResetSink', () => {
    it('states a reset of the store it names', () => {
        const events: ALStorageEvent[] = [];
        const reset = {
            dbName: 'rallar-al-runtime',
            previousSchemaId: 'old',
            schemaId: 'current',
            reason: 'schema-id-mismatch'
        } as const;

        toALStorageResetSink((event) => events.push(event), 'browser-ws-client:session-1')(reset);

        expect(events).toEqual([{
            kind: 'reset',
            storeId: 'browser-ws-client:session-1',
            event: reset
        }]);
    });
});

function createHealth(): Readonly<{ health: ALStorageHealth; events: ALStorageEvent[]; }> {
    const events: ALStorageEvent[] = [];
    const health = new ALStorageHealth({
        storeId: 'browser-ws-client:session-1',
        storage: (event) => events.push(event)
    });
    return { health, events };
}

/** The health listener runs on the value's promise queue; two macrotask turns drain it. */
async function flushListeners(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}
```

- [ ] **Step 2: Move the browser and harness tests to the `storage` port, and add their new cases.**

`packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts` (one new case: each store names itself on
its reset and health; a second resolve of a scope shares its health):

```diff
diff --git a/packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts b/packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts
index 8524f19a2..22b877ba0 100644
--- a/packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts
@@ -32,7 +32,9 @@ import {
     toRallarDiagnosticsPorts
 } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
+import { AL_ADMISSION_SCHEMA_ID, openIndexedDbAdmissionDatabase } from '@shared/alm/open-indexed-db-admission-database.ts';
 import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
+import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
 import {
     AL_VOLATILE_SESSION_MAX_ADMISSIONS,
     AL_VOLATILE_SESSION_MAX_BYTES,
@@ -206,7 +208,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         );
         const unrelatedSentPrefix = toBrowserOutboundSentPrefix(unrelatedRuntimeName);
 
-        const result = await deleteExpiredBrowserALRuntimeEntries({ onStorageReset: diagnosticsPorts.onStorageReset });
+        const result = await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
 
         expect(result).toMatchObject({
             dbName: BROWSER_AL_RUNTIME_DB_NAME,
@@ -244,7 +246,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
             throw new Error('Periodic expiry cleanup must not scan the complete object store');
         });
 
-        const result = await deleteExpiredBrowserALRuntimeEntries({ onStorageReset: diagnosticsPorts.onStorageReset });
+        const result = await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
 
         // The AL_OUTBOUND work row's own expiry now goes through cleanupAsync, off this count.
         expect(result.deleted).toBe(2);
@@ -268,7 +270,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
 
         await expect(
             deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
-                onStorageReset: diagnosticsPorts.onStorageReset
+                storage: diagnosticsPorts.storage
             })
         ).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
         expect(await readBrowserALRuntimeEntryKeys(key)).toEqual([key]);
@@ -304,7 +306,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         );
 
         const result = await deleteExpiredBrowserALRuntimeEntriesForSession(targetSessionId, {
-            onStorageReset: diagnosticsPorts.onStorageReset
+            storage: diagnosticsPorts.storage
         });
 
         // The AL_OUTBOUND work rows' own expiry now goes through cleanupAsync, off this count.
@@ -358,7 +360,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         await vi.advanceTimersByTimeAsync(15_001);
 
         const result = await deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
-            onStorageReset: diagnosticsPorts.onStorageReset
+            storage: diagnosticsPorts.storage
         });
 
         expect(result.deleted).toBe(1);
@@ -410,7 +412,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         );
 
         const result = await deleteBrowserALRuntimeEntriesForSession(targetSessionId, {
-            onStorageReset: diagnosticsPorts.onStorageReset
+            storage: diagnosticsPorts.storage
         });
 
         expect(result.scanned).toBe(11);
@@ -462,7 +464,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         await expect(
             deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
                 nowMs: 100,
-                onStorageReset: diagnosticsPorts.onStorageReset
+                storage: diagnosticsPorts.storage
             })
         ).rejects.toThrow('cleanup conflicted');
 
@@ -490,7 +492,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         await vi.advanceTimersByTimeAsync(21);
 
         const stop = await initBrowserALRuntimeExpiryEviction({
-            onStorageReset: diagnosticsPorts.onStorageReset,
+            storage: diagnosticsPorts.storage,
             intervalMs: 50
         });
         try {
@@ -520,7 +522,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
                 indexedDbOperationObserver: observer,
                 outboundDiagnostics: createPassThroughALOutboundRuntimeDiagnosticsSink(),
                 inboundDiagnostics: createPassThroughALInboundRuntimeDiagnosticsSink(),
-                onStorageReset: () => {}
+                storage: () => {}
             }
         });
         const stores = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
@@ -530,6 +532,50 @@ describe('Browser AL runtime IndexedDB stores', () => {
         expect(observer.getCounts().total).toBeGreaterThan(0);
     });
 
+    // Each store states its reset and its health under its own id, and every resolve of it shares one health.
+    it('names each store on the reset and the health it states through the storage port', async () => {
+        const seeded = await openIndexedDbAdmissionDatabase({
+            dbName: BROWSER_AL_RUNTIME_DB_NAME,
+            storeName: BROWSER_AL_RUNTIME_STORE_NAME,
+            schemaId: 'rallar-alm-previous',
+            onStorageReset: () => {}
+        });
+        seeded.close();
+        const events: ALStorageEvent[] = [];
+        const sessionId = `storage-port-${crypto.randomUUID()}`;
+        const wsClientId = toBrowserWsClientALRuntimeStoreId(sessionId);
+        configureBrowserALRuntimeStores(sessionId, {
+            diagnosticsPorts: toRallarDiagnosticsPorts({ storage: (event) => events.push(event) })
+        });
+        const stores = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
+
+        await stores.admissionStore.ready();
+        expect(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).storageHealth).toBe(stores.storageHealth);
+        expect(resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId).storageHealth).not.toBe(stores.storageHealth);
+        stores.storageHealth?.recordFailure({ cause: 'quota', detail: 'QuotaExceededError: full' });
+
+        await vi.waitFor(() => expect(events).toHaveLength(2));
+        expect(events).toEqual([
+            {
+                kind: 'reset',
+                storeId: wsClientId,
+                event: {
+                    dbName: BROWSER_AL_RUNTIME_DB_NAME,
+                    previousSchemaId: 'rallar-alm-previous',
+                    schemaId: AL_ADMISSION_SCHEMA_ID,
+                    reason: 'schema-id-mismatch'
+                }
+            },
+            {
+                kind: 'health',
+                storeId: wsClientId,
+                status: 'failing',
+                lastFailure: { cause: 'quota', detail: 'QuotaExceededError: full' },
+                lastRecoveryPointAtMs: undefined
+            }
+        ]);
+    });
+
     it('gives every carrier a fresh, empty memory pair that shares nothing with IndexedDB', async () => {
         const first = createBrowserALVolatileOutboundRuntimeStores('browser-ws-client:session-1', createDefaultVolatileSessionBudget());
         const second = createBrowserALVolatileOutboundRuntimeStores('browser-ws-client:session-1', createDefaultVolatileSessionBudget());
@@ -576,7 +622,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         expect(volatile.admissionStore.namespace).toBe(
             `browser:${toBrowserSessionALInboundRuntimeStoreId(sessionId)}:volatile:inbound:admission`
         );
-        await deleteBrowserALRuntimeEntriesForSession(sessionId, { onStorageReset: diagnosticsPorts.onStorageReset });
+        await deleteBrowserALRuntimeEntriesForSession(sessionId, { storage: diagnosticsPorts.storage });
         expect(await volatile.workQueue.getAllKeys()).toHaveLength(1);
     });
 });
```

`packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts` (the reset keeps its topic and payload; one
new case for the storage topic):

```diff
diff --git a/packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts b/packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts
index 1ca5949d9..9a1bf323c 100644
--- a/packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts
@@ -357,11 +357,15 @@ it('records an AL storage reset diagnostics event into the agent event log', asy
         rallar: { apiBaseUrl: 'https://api.example.test', applicationId: 'app-1', username: 'alice', password: 'secret' }
     });
 
-    facade.records.defaultWrites.at(-1)?.diagnosticsPorts?.onStorageReset?.({
-        dbName: 'rallar-al-runtime',
-        previousSchemaId: 'rallar-alm-2026-08-f1',
-        schemaId: 'rallar-alm-2026-09-f2',
-        reason: 'schema-id-mismatch'
+    facade.records.defaultWrites.at(-1)?.diagnosticsPorts?.storage?.({
+        kind: 'reset',
+        storeId: 'browser-ws-client:session-1',
+        event: {
+            dbName: 'rallar-al-runtime',
+            previousSchemaId: 'rallar-alm-2026-08-f1',
+            schemaId: 'rallar-alm-2026-09-f2',
+            reason: 'schema-id-mismatch'
+        }
     });
 
     expect(events).toEqual(expect.arrayContaining([
@@ -378,6 +382,39 @@ it('records an AL storage reset diagnostics event into the agent event log', asy
     ]));
 });
 
+// The reset keeps its own topic and payload; recovery, health and persist share the storage topic.
+it('records AL storage recovery, health and persist events on the storage topic', async () => {
+    const runtime = await loadRuntime();
+    await runtime.connect({
+        connection: 'diagnostics',
+        rallar: { apiBaseUrl: 'https://api.example.test', applicationId: 'app-1', username: 'alice', password: 'secret' }
+    });
+    const storage = facade.records.defaultWrites.at(-1)?.diagnosticsPorts?.storage;
+
+    storage?.({ kind: 'recovery', storeId: 'browser-ws-client:session-1', outcome: { kind: 'storage-created' } });
+    storage?.({
+        kind: 'health',
+        storeId: 'browser-ws-client:session-1',
+        status: 'failing',
+        lastFailure: { cause: 'quota', detail: 'QuotaExceededError: full' },
+        lastRecoveryPointAtMs: 1_000
+    });
+    storage?.({ kind: 'persist', outcome: 'granted' });
+
+    expect(events.filter((event) => event.topic === 'rallar.browser.alm.storage').map((event) => event.data)).toEqual([
+        { kind: 'recovery', storeId: 'browser-ws-client:session-1', outcome: { kind: 'storage-created' } },
+        {
+            kind: 'health',
+            storeId: 'browser-ws-client:session-1',
+            status: 'failing',
+            lastFailure: { cause: 'quota', detail: 'QuotaExceededError: full' },
+            lastRecoveryPointAtMs: 1_000
+        },
+        { kind: 'persist', outcome: 'granted' }
+    ]);
+    expect(events.filter((event) => event.topic === 'rallar.browser.alm.storage_reset')).toEqual([]);
+});
+
 it('records synchronous connection producer diagnostics once across reconnect', async () => {
     const runtime = await loadRuntime();
     const connect = { connection: 'early', rallar: { apiBaseUrl: 'https://api.example.test', applicationId: 'app-1', username: 'alice', password: 'secret' } };
@@ -391,7 +428,11 @@ it('records synchronous connection producer diagnostics once across reconnect',
             queuedBehindOrigin: 'none',
             durationMs: 0
         });
-        ports?.onStorageReset?.({ dbName: 'early', previousSchemaId: undefined, schemaId: 'current', reason: 'schema-id-mismatch' });
+        ports?.storage?.({
+            kind: 'reset',
+            storeId: 'browser-ws-client:early',
+            event: { dbName: 'early', previousSchemaId: undefined, schemaId: 'current', reason: 'schema-id-mismatch' }
+        });
     });
     await runtime.connect(connect);
     await runtime.close();
```

The public API snapshot (`packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`, both `rallar.ts` and
`rallar-core.ts` type lists):

```diff
diff --git a/packages/tests/shared-web/shared-web-public-api-snapshots.test.ts b/packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
index 9ac85b507..217896be9 100644
--- a/packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
+++ b/packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
@@ -44,6 +44,10 @@ const PUBLIC_SURFACES: readonly PublicSurfaceSnapshot[] = [
                 'ALDurabilityAlgo',
                 'ALQosPolicyRequest',
                 'ALReceiptMode',
+                'ALStorageEvent',
+                'ALStorageRecoveryOutcome',
+                'ALStorageUnavailable',
+                'ALStorageUnavailableCause',
                 'ApiMiddleware',
                 'CommandsOrchestrator',
                 'CommandsOrchestratorPolicies',
@@ -298,6 +302,10 @@ const PUBLIC_SURFACES: readonly PublicSurfaceSnapshot[] = [
                 'ALDurabilityAlgo',
                 'ALQosPolicyRequest',
                 'ALReceiptMode',
+                'ALStorageEvent',
+                'ALStorageRecoveryOutcome',
+                'ALStorageUnavailable',
+                'ALStorageUnavailableCause',
                 'ApiMiddleware',
                 'CommandsOrchestrator',
                 'CommandsOrchestratorPolicies',
```

The mechanical renames (`onStorageReset: diagnosticsPorts.onStorageReset` → `storage: diagnosticsPorts.storage`, and
`onStorageReset: expect.any(Function)` → `storage: expect.any(Function)` in the ports expectations):

```diff
diff --git a/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts b/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts
index 31a7544b6..937eee619 100644
--- a/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts
@@ -77,13 +77,13 @@ describe('browser canonical outbound cleanup', () => {
         const unrelated = toResourceEntryWithKey({ topicId: 'unrelated', contextId: 'test', resourceId: crypto.randomUUID() }, 'unrelated', {});
         await other.queue.enqueueIfAbsent(unrelated);
         vi.setSystemTime(Date.now() + 11);
-        await deleteExpiredBrowserALRuntimeEntries({ onStorageReset: diagnosticsPorts.onStorageReset });
+        await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
         let rows = await readRawWorkRows();
         expect(rows.some((row) => row.resource === expired.resource)).toBe(false);
         expect(rows.some((row) => row.resource === target.resource)).toBe(true);
         expect(rows.some((row) => row.resource === other.resource)).toBe(true);
         await deleteBrowserALRuntimeEntriesForSession(targetSession, {
-            onStorageReset: diagnosticsPorts.onStorageReset
+            storage: diagnosticsPorts.storage
         });
         rows = await readRawWorkRows();
         expect(rows.some((row) => row.resource === target.resource)).toBe(false);
@@ -100,13 +100,13 @@ describe('browser canonical outbound cleanup', () => {
         await fresh.store.workQueue.enqueueIfAbsent(unrelated);
         await vi.advanceTimersByTimeAsync(11);
 
-        await deleteExpiredBrowserALRuntimeEntries({ onStorageReset: diagnosticsPorts.onStorageReset });
+        await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
         const remaining = await readRawWorkRows();
 
         expect(remaining.filter((row) => expired.keys.has(row.keyString))).toEqual([]);
         expect(remaining.filter((row) => fresh.keys.has(row.keyString))).toHaveLength(fresh.keys.size);
         expect(remaining.some((row) => row.keyString.includes(unrelated.key.resourceId))).toBe(true);
-        await deleteExpiredBrowserALRuntimeEntries({ onStorageReset: diagnosticsPorts.onStorageReset });
+        await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
         expect(await readRawWorkRows()).toEqual(remaining);
     });
 
@@ -120,7 +120,7 @@ describe('browser canonical outbound cleanup', () => {
         expect(await expired.store.workQueue.getItem(toALOutboundIdentityKey(reference.key))).toBeUndefined();
         expect((await readRawWorkRows()).filter((row) => expired.keys.has(row.keyString))).toHaveLength(2);
 
-        await deleteExpiredBrowserALRuntimeEntries({ onStorageReset: diagnosticsPorts.onStorageReset });
+        await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
 
         expect((await readRawWorkRows()).filter((row) => expired.keys.has(row.keyString))).toEqual([]);
     });
@@ -163,7 +163,7 @@ describe('browser canonical outbound cleanup', () => {
         const otherLive = await admitForSession(otherLiveSession, 60_000);
 
         await deleteExpiredBrowserALRuntimeEntriesForSession(targetSession, {
-            onStorageReset: diagnosticsPorts.onStorageReset
+            storage: diagnosticsPorts.storage
         });
 
         const remaining = await readRawWorkRows();
@@ -176,7 +176,7 @@ describe('browser canonical outbound cleanup', () => {
         vi.setSystemTime(new Date('2030-08-01T00:00:00Z'));
         const first = await admitForSession(`timer-first-${crypto.randomUUID()}`, 20);
         const stop = await initBrowserALRuntimeExpiryEviction({
-            onStorageReset: diagnosticsPorts.onStorageReset,
+            storage: diagnosticsPorts.storage,
             intervalMs: 10
         });
         try {
@@ -199,7 +199,7 @@ describe('browser canonical outbound cleanup', () => {
         await other.store.workQueue.enqueueIfAbsent(unrelated);
 
         await deleteBrowserALRuntimeEntriesForSession(targetSession, {
-            onStorageReset: diagnosticsPorts.onStorageReset
+            storage: diagnosticsPorts.storage
         });
         const remaining = await readRawWorkRows();
 
@@ -267,7 +267,7 @@ describe('browser canonical outbound cleanup', () => {
         });
 
         await deleteBrowserALRuntimeEntriesForSession(targetSession, {
-            onStorageReset: diagnosticsPorts.onStorageReset
+            storage: diagnosticsPorts.storage
         });
         openCursorSpy.mockRestore();
```

```diff
diff --git a/packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts b/packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts
index da8fff205..4e0956519 100644
--- a/packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts
@@ -56,7 +56,7 @@ function createSessionOutbounds(): SessionOutbounds {
     onTestFinished(async () => {
         rtc.dispose();
         ws.dispose();
-        await deleteBrowserALRuntimeEntriesForSession(sessionId, { onStorageReset: diagnosticsPorts.onStorageReset });
+        await deleteBrowserALRuntimeEntriesForSession(sessionId, { storage: diagnosticsPorts.storage });
     });
     const wake = vi.fn();
     const replayed: ALMessage[] = [];
```

```diff
diff --git a/packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts b/packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts
index 0a20032c2..5d3521f10 100644
--- a/packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts
@@ -67,7 +67,7 @@ describe('RTC message diagnostic receipts', () => {
         }
         finally {
             await deleteBrowserALRuntimeEntriesForSession(sessionId, {
-                onStorageReset: diagnosticsPorts.onStorageReset
+                storage: diagnosticsPorts.storage
             });
         }
     });
```

```diff
diff --git a/packages/tests/shared-web/composition/browser-facade-behavior.test.ts b/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
index a452ffcec..71818e4d2 100644
--- a/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
+++ b/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
@@ -197,7 +197,7 @@ describe('browser facade restored-session setup', () => {
                     indexedDbOperationObserver: { observe: expect.any(Function) },
                     outboundDiagnostics: expect.any(Function),
                     inboundDiagnostics: expect.any(Function),
-                    onStorageReset: expect.any(Function)
+                    storage: expect.any(Function)
                 },
                 onAuthInvalid: expect.any(Function),
                 scope: {
```

```diff
diff --git a/packages/tests/shared-web/rallar-facade-defaults.test.ts b/packages/tests/shared-web/rallar-facade-defaults.test.ts
index 84e7b08c7..117e810b6 100644
--- a/packages/tests/shared-web/rallar-facade-defaults.test.ts
+++ b/packages/tests/shared-web/rallar-facade-defaults.test.ts
@@ -284,7 +284,7 @@ describe('Rallar facade default scope behavior', () => {
                     indexedDbOperationObserver: { observe: expect.any(Function) },
                     outboundDiagnostics: expect.any(Function),
                     inboundDiagnostics: expect.any(Function),
-                    onStorageReset: expect.any(Function)
+                    storage: expect.any(Function)
                 },
                 onAuthInvalid: expect.any(Function),
                 scope: {
@@ -335,7 +335,7 @@ describe('Rallar facade default scope behavior', () => {
                     indexedDbOperationObserver,
                     outboundDiagnostics: expect.any(Function),
                     inboundDiagnostics: expect.any(Function),
-                    onStorageReset: expect.any(Function)
+                    storage: expect.any(Function)
                 }
             })
         );
```

The IndexedDB-backend constructions in tests (`onStorageReset: () => {}` passed to `IndexedDbAdmissionBackend` or
`openIndexedDbAdmissionDatabase`) are the ALM input and stay as they are.

- [ ] **Step 3: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared/alm/storage/al-storage-health.test.ts packages/tests/shared-web/al-runtime packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts packages/tests/shared-web/composition/browser-facade-behavior.test.ts packages/tests/shared-web/rallar-facade-defaults.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
```

Expected (measured on Task 1's commit): `Test Files  6 failed | 7 passed (13)`, `Tests  9 failed | 76 passed (85)`:
the health suite does not load (`al-storage-event.ts` missing); the two snapshot cases, the three diagnostics cases,
the new composition case, and the three ports expectations fail. (The cleanup suites pass because the old functions
ignore the unknown `storage` option; `check-tests-typecheck` fails on them.)

- [ ] **Step 4: Create `packages/shared/alm/storage/al-storage-event.ts`:**

```ts
// packages/shared/alm/storage/al-storage-event.ts
import type { ALStorageResetEvent } from '../open-indexed-db-admission-database.ts';
import type { ALStorageUnavailable } from './al-storage-unavailable.ts';

export type ALStorageHealthStatus = 'healthy' | 'failing';

export interface ALStorageHealthState {
    readonly status: ALStorageHealthStatus;
    /** The latest failure, kept on the `healthy` that ends it; `undefined` before any failure. */
    readonly lastFailure: ALStorageUnavailable | undefined;
    /** The last durable commit of the store; `undefined` before its first one. */
    readonly lastRecoveryPointAtMs: number | undefined;
}

/** What a durable store found when its lane started: exactly one per store per connect. */
export type ALStorageRecoveryOutcome =
    | Readonly<{ kind: 'restored'; claimed: number; expired: number; }>
    | Readonly<{ kind: 'expired-at-recovery'; expired: number; }>
    | Readonly<{ kind: 'storage-created'; }>
    | Readonly<{ kind: 'storage-reset'; reason: ALStorageResetEvent['reason']; }>;

export type ALStoragePersistOutcome = 'granted' | 'denied' | 'unsupported';

/**
 * What the browser ALM stores state about their storage: a reset, the recovery a store found at
 * start, a change of its health, and the answer to the session's one persistence request.
 */
export type ALStorageEvent =
    | Readonly<{ kind: 'reset'; storeId: string; event: ALStorageResetEvent; }>
    | Readonly<{ kind: 'recovery'; storeId: string; outcome: ALStorageRecoveryOutcome; }>
    | (Readonly<{ kind: 'health'; storeId: string; }> & ALStorageHealthState)
    | Readonly<{ kind: 'persist'; outcome: ALStoragePersistOutcome; }>;

export type ALStorageEventSink = (event: ALStorageEvent) => void;

export function createPassThroughALStorageEventSink(): ALStorageEventSink {
    return () => {};
}

/** The reset sink an ALM store factory takes, stating each reset as the `reset` event of one store. */
export function toALStorageResetSink(
    storage: ALStorageEventSink,
    storeId: string
): (event: ALStorageResetEvent) => void {
    return (event) => storage({ kind: 'reset', storeId, event });
}
```

- [ ] **Step 5: Create `packages/shared/alm/storage/al-storage-health.ts`:**

```ts
// packages/shared/alm/storage/al-storage-health.ts
import { ObservableLatestValue } from '../../cache/ObservableLatestValue.ts';
import type { ALStorageEventSink, ALStorageHealthState } from './al-storage-event.ts';
import type { ALStorageUnavailable } from './al-storage-unavailable.ts';

export namespace ALStorageHealth {
    export interface Input {
        readonly storeId: string;
        readonly storage: ALStorageEventSink;
    }
}

/**
 * One durable store's health. It starts `healthy` and states only a change of status: the first
 * failure, and the first recovery point after it. Every durable commit is a recovery point.
 */
export class ALStorageHealth {
    private readonly state = new ObservableLatestValue<ALStorageHealthState>({
        equals: (left, right) => left.status === right.status
    });
    private lastRecoveryPointAtMs: number | undefined = undefined;

    constructor(input: ALStorageHealth.Input) {
        this.state.accept({
            status: 'healthy',
            lastFailure: undefined,
            lastRecoveryPointAtMs: undefined
        });
        this.state.onUpdatedDo(({ value }) => {
            if (value !== undefined) {
                input.storage({ kind: 'health', storeId: input.storeId, ...value });
            }
        });
    }

    recordFailure(failure: ALStorageUnavailable): void {
        this.state.accept({
            status: 'failing',
            lastFailure: failure,
            lastRecoveryPointAtMs: this.lastRecoveryPointAtMs
        });
    }

    recordRecoveryPoint(atMs: number): void {
        this.lastRecoveryPointAtMs = atMs;
        const state = this.state.peek();
        if (state?.status === 'failing') {
            this.state.accept({
                status: 'healthy',
                lastFailure: state.lastFailure,
                lastRecoveryPointAtMs: atMs
            });
        }
    }
}
```

- [ ] **Step 6: Carry the health on the IndexedDB store pairs.**

```diff
diff --git a/packages/shared/alm/al-runtime-stores.ts b/packages/shared/alm/al-runtime-stores.ts
index 6fc56d545..e3d3ba84c 100644
--- a/packages/shared/alm/al-runtime-stores.ts
+++ b/packages/shared/alm/al-runtime-stores.ts
@@ -39,6 +39,7 @@ import type {
     ALOutboundRuntimeStores,
     ALVolatileOutboundRuntimeStores
 } from './outbound/al-outbound-message-runtime.ts';
+import type { ALStorageHealth } from './storage/al-storage-health.ts';
 import type { ALVolatileSessionBudget } from './volatile-budget/al-volatile-session-budget.ts';
 
 /**
@@ -69,6 +70,8 @@ export interface CreateIndexedDbALRuntimeStoresInput extends CreateInMemoryALRun
     readonly observer: IndexedDbOperationObserver;
     readonly schemaId: string;
     readonly onStorageReset: (event: ALStorageResetEvent) => void;
+    /** The health the pair's lanes record into; `undefined` when no one reads it. */
+    readonly storageHealth: ALStorageHealth | undefined;
 }
 
 export interface CreateIndexedDbALOutboundRuntimeStoresInput<TPrepared> extends CreateIndexedDbALRuntimeStoresInput {
@@ -93,6 +96,7 @@ export interface CreateDefaultALRuntimeStoresInput {
     readonly observer?: IndexedDbOperationObserver;
     readonly schemaId?: string;
     readonly onStorageReset?: (event: ALStorageResetEvent) => void;
+    readonly storageHealth?: ALStorageHealth;
 }
 
 const DEFAULT_NAMESPACE = 'al-runtime';
@@ -144,6 +148,7 @@ export function createIndexedDbALInboundRuntimeStores(
             onStorageReset: input.onStorageReset
         });
     return {
+        storageHealth: input.storageHealth,
         admissionStore: createALInboundAdmissionStore({
             nowMs: input.nowMs,
             namespace: `${input.namespace}:inbound:admission`,
@@ -176,6 +181,7 @@ export function createIndexedDbALOutboundRuntimeStores<TPrepared>(
         });
     return {
         storageResets,
+        storageHealth: input.storageHealth,
         admissionStore: createALOutboundAdmissionStore({
             nowMs: input.nowMs,
             namespace: `${input.namespace}:outbound:admission`,
@@ -314,6 +320,7 @@ function toDefaultIndexedDbInput(
         dbName: options.dbName,
         observer: options.observer ?? createPassThroughIndexedDbOperationObserver(),
         schemaId: options.schemaId ?? AL_ADMISSION_SCHEMA_ID,
-        onStorageReset: options.onStorageReset ?? createPassThroughALStorageResetSink()
+        onStorageReset: options.onStorageReset ?? createPassThroughALStorageResetSink(),
+        storageHealth: options.storageHealth
     };
 }
```

```diff
diff --git a/packages/shared/alm/outbound/al-outbound-message-runtime.ts b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
index 54c02bbd5..9ae307f0b 100644
--- a/packages/shared/alm/outbound/al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
@@ -19,6 +19,7 @@ import type {
     ALDeliverySettlementSink
 } from '../delivery/al-delivery-lifecycle.ts';
 import type { ALStorageResetListeners } from '../open-indexed-db-admission-database.ts';
+import type { ALStorageHealth } from '../storage/al-storage-health.ts';
 import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
 import type { ALWorkReadinessProbeCause } from '../work/al-work-readiness-memory.ts';
 import type {
@@ -177,6 +178,8 @@ export interface ALOutboundRuntimeStores<TPrepared> {
      * relayed here (a memory or PostgreSQL pair, or a backend its caller opened).
      */
     readonly storageResets?: ALStorageResetListeners;
+    /** Records the storage failures and the commits of the lanes over this pair; absent where no storage failure reaches. */
+    readonly storageHealth?: ALStorageHealth;
 }
 
 /** The memory pair of a carrier runtime: nothing in it survives the document, and its lane sweeps it. */
```

```diff
diff --git a/packages/shared/alm/inbound/al-inbound-message-runtime.ts b/packages/shared/alm/inbound/al-inbound-message-runtime.ts
index e6d31e506..b8735442f 100644
--- a/packages/shared/alm/inbound/al-inbound-message-runtime.ts
+++ b/packages/shared/alm/inbound/al-inbound-message-runtime.ts
@@ -9,6 +9,7 @@ import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
 import { Either } from '../../resilience/Either.ts';
 import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
 import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';
+import type { ALStorageHealth } from '../storage/al-storage-health.ts';
 import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
 import type { ALInboundAdmissionStore, ALInboundPlanner } from './al-inbound-admission-store.ts';
 import {
@@ -33,6 +34,8 @@ import {
 export interface ALInboundRuntimeStores {
     readonly admissionStore: ALInboundAdmissionStore;
     readonly workQueue: QueueBoxResourceEntryRepository;
+    /** Records the storage failures and the commits of the lanes over this pair; absent where no storage failure reaches. */
+    readonly storageHealth?: ALStorageHealth;
 }
 
 /** The session's inbound memory pair: nothing in it survives the document, and each lane over it sweeps it. */
```

(The doc comments carry no apostrophe on purpose: `al-inbound-message-runtime.ts` has a pre-existing
`boundary.unknown` finding at `admitIncomingMessage(value: unknown)` that the changed-style gate's comment-unaware
quote stripping masks only while the file's apostrophe count stays odd; a first draft with "pair's" woke it.)

- [ ] **Step 7: The `storage` port.**

```diff
diff --git a/packages/shared-web/browser/connection/rallar-diagnostics-ports.ts b/packages/shared-web/browser/connection/rallar-diagnostics-ports.ts
index f61de69af..8d0525fb6 100644
--- a/packages/shared-web/browser/connection/rallar-diagnostics-ports.ts
+++ b/packages/shared-web/browser/connection/rallar-diagnostics-ports.ts
@@ -1,9 +1,9 @@
 import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
-import {
-    createPassThroughALStorageResetSink,
-    type ALStorageResetEvent
-} from '@shared/alm/open-indexed-db-admission-database.ts';
 import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
+import {
+    createPassThroughALStorageEventSink,
+    type ALStorageEventSink
+} from '@shared/alm/storage/al-storage-event.ts';
 import {
     createPassThroughIndexedDbOperationObserver,
     type IndexedDbOperationObserver
@@ -21,7 +21,8 @@ export interface RallarDiagnosticsPortsInput {
     readonly indexedDbOperationObserver?: IndexedDbOperationObserver;
     readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
     readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
-    readonly onStorageReset?: (event: ALStorageResetEvent) => void;
+    /** Every storage event of the browser ALM stores: reset, recovery, health and persist. */
+    readonly storage?: ALStorageEventSink;
 }
 
 export interface RallarDiagnosticsPorts {
@@ -30,7 +31,7 @@ export interface RallarDiagnosticsPorts {
     readonly indexedDbOperationObserver: IndexedDbOperationObserver;
     readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink;
     readonly inboundDiagnostics: ALInboundRuntimeDiagnosticsSink;
-    readonly onStorageReset: (event: ALStorageResetEvent) => void;
+    readonly storage: ALStorageEventSink;
 }
 
 export function createPassThroughALOutboundRuntimeDiagnosticsSink(): ALOutboundRuntimeDiagnosticsSink {
@@ -52,6 +53,6 @@ export function toRallarDiagnosticsPorts(
             createPassThroughIndexedDbOperationObserver(),
         outboundDiagnostics: input?.outboundDiagnostics ?? createPassThroughALOutboundRuntimeDiagnosticsSink(),
         inboundDiagnostics: input?.inboundDiagnostics ?? createPassThroughALInboundRuntimeDiagnosticsSink(),
-        onStorageReset: input?.onStorageReset ?? createPassThroughALStorageResetSink()
+        storage: input?.storage ?? createPassThroughALStorageEventSink()
     };
 }
```

- [ ] **Step 8: The browser composition names each store and gives it one health per connect.**

```diff
diff --git a/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts b/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
index e2b60ca09..b2672da6a 100644
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
@@ -29,6 +29,8 @@ import {
     decodeALOutboundTransportMessage,
     type ALOutboundTransportMessage
 } from '@shared/alm/outbound/al-outbound-transport-message.ts';
+import { toALStorageResetSink, type ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
+import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
 import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
 
 import {
@@ -41,7 +43,7 @@ import {
 type BrowserALRuntimeOptions = Omit<CreateDefaultALRuntimeStoresInput, 'dbName' | 'namespace'>;
 
 export interface ConfigureBrowserALRuntimeStoresInput
-    extends Omit<BrowserALRuntimeOptions, 'observer' | 'onStorageReset'> {
+    extends Omit<BrowserALRuntimeOptions, 'observer' | 'onStorageReset' | 'storageHealth'> {
     readonly diagnosticsPorts: RallarDiagnosticsPorts;
 }
 
@@ -65,7 +67,8 @@ function createBrowserRuntimeStoreFactories(
 
 function toBrowserRuntimeStoreScopes(
     sessionId: string,
-    options: BrowserALRuntimeOptions
+    options: BrowserALRuntimeOptions,
+    storage: ALStorageEventSink
 ): readonly ALRuntimeStoreScope<ALOutboundTransportMessage>[] {
     const sessionInboundId = toBrowserSessionALInboundRuntimeStoreId(sessionId);
     const wsClientId = toBrowserWsClientALRuntimeStoreId(sessionId);
@@ -77,7 +80,7 @@ function toBrowserRuntimeStoreScopes(
             factories: createBrowserRuntimeStoreFactories(
                 sessionInboundId,
                 { inbound: true },
-                options
+                toBrowserStoreOptions(sessionInboundId, options, storage)
             )
         },
         {
@@ -85,7 +88,7 @@ function toBrowserRuntimeStoreScopes(
             factories: createBrowserRuntimeStoreFactories(
                 wsClientId,
                 { outbound: true },
-                options
+                toBrowserStoreOptions(wsClientId, options, storage)
             )
         },
         {
@@ -93,12 +96,25 @@ function toBrowserRuntimeStoreScopes(
             factories: createBrowserRuntimeStoreFactories(
                 rtcOverlayId,
                 { outbound: true },
-                options
+                toBrowserStoreOptions(rtcOverlayId, options, storage)
             )
         }
     ];
 }
 
+/** One health per store and connect, shared by every resolve of it; its events and resets name the store. */
+function toBrowserStoreOptions(
+    storeId: string,
+    options: BrowserALRuntimeOptions,
+    storage: ALStorageEventSink
+): BrowserALRuntimeOptions {
+    return {
+        ...options,
+        onStorageReset: toALStorageResetSink(storage, storeId),
+        storageHealth: new ALStorageHealth({ storeId, storage })
+    };
+}
+
 export function createBrowserALInboundRuntimeStores(
     name: string,
     options: BrowserALRuntimeOptions = {}
@@ -156,7 +172,6 @@ export function configureBrowserALRuntimeStores(
     const scoped: BrowserALRuntimeOptions = {
         ...options,
         observer: diagnosticsPorts.indexedDbOperationObserver,
-        onStorageReset: diagnosticsPorts.onStorageReset,
         canonicalScope: `browser-session:${sessionId}`,
         inboundBackend: inMemory
             ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
@@ -165,7 +180,7 @@ export function configureBrowserALRuntimeStores(
             ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
             : options.outboundBackend
     };
-    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped));
+    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped, diagnosticsPorts.storage));
 }
 
 export function resolveBrowserSessionALInboundRuntimeStores(
```

- [ ] **Step 9: The cleanup and its two callers take the port.**

```diff
diff --git a/packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts b/packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts
index 4c72d3335..000fb28da 100644
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts
@@ -3,10 +3,10 @@ import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendC
 import { EMPTY_INDEXED_DB_ADMISSION_FENCE } from '@shared/alm/indexed-db-admission-fence.ts';
 import {
     AL_ADMISSION_SCHEMA_ID,
-    openIndexedDbAdmissionDatabase,
-    type ALStorageResetEvent
+    openIndexedDbAdmissionDatabase
 } from '@shared/alm/open-indexed-db-admission-database.ts';
 import { readIndexedDbAdmissionSnapshot } from '@shared/alm/read-indexed-db-admission-snapshot.ts';
+import { toALStorageResetSink, type ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
 import {
     writeIndexedDbAdmissionMutations,
     type IndexedDbAdmissionMutation
@@ -71,7 +71,7 @@ export interface BrowserALRuntimeCleanupResult {
 }
 
 export interface DeleteExpiredBrowserALRuntimeEntriesOptions {
-    readonly onStorageReset: (event: ALStorageResetEvent) => void;
+    readonly storage: ALStorageEventSink;
     readonly nowMs?: number;
     readonly keyPrefixes?: readonly string[];
 }
@@ -84,7 +84,7 @@ export async function deleteExpiredBrowserALRuntimeEntries(
     return await deleteBrowserALRuntimeEntriesMatching({
         keyPrefixes: options.keyPrefixes ?? [BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX],
         deletionPolicy: { kind: 'expired', nowMs },
-        onStorageReset: options.onStorageReset
+        storage: options.storage
     });
 }
 
@@ -106,14 +106,14 @@ export async function deleteExpiredBrowserALRuntimeEntriesForSession(
 
 export async function deleteBrowserALRuntimeEntriesForSession(
     sessionId: string,
-    options: Readonly<{ onStorageReset: (event: ALStorageResetEvent) => void; }>
+    options: Readonly<{ storage: ALStorageEventSink; }>
 ): Promise<BrowserALRuntimeCleanupResult> {
     return await deleteBrowserALRuntimeEntriesMatching({
         keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId),
         workNamespaces: toBrowserSessionALRuntimeWorkNamespaces(sessionId),
         canonicalScopes: [`browser-session:${sessionId}`],
         deletionPolicy: { kind: 'all' },
-        onStorageReset: options.onStorageReset
+        storage: options.storage
     });
 }
 
@@ -129,7 +129,7 @@ export async function evictExpiredBrowserALRuntimeEntries(
 }
 
 export interface InitBrowserALRuntimeExpiryEvictionInput {
-    readonly onStorageReset: (event: ALStorageResetEvent) => void;
+    readonly storage: ALStorageEventSink;
     readonly intervalMs?: number;
 }
 
@@ -167,7 +167,7 @@ function startBrowserALRuntimeExpiryEviction(
     return tryRunInIntervals(
         async () => {
             if (!stopped) {
-                await evictExpiredBrowserALRuntimeEntries({ onStorageReset: input.onStorageReset });
+                await evictExpiredBrowserALRuntimeEntries({ storage: input.storage });
             }
         },
         input.intervalMs ?? BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS
@@ -179,14 +179,13 @@ function startBrowserALRuntimeExpiryEviction(
         });
 }
 
-function openBrowserALRuntimeDatabase(
-    onStorageReset: (event: ALStorageResetEvent) => void
-): Promise<IDBDatabase> {
+/** The cleanup opens the whole database for no one store, so a reset it causes names the database. */
+function openBrowserALRuntimeDatabase(storage: ALStorageEventSink): Promise<IDBDatabase> {
     return openIndexedDbAdmissionDatabase({
         dbName: BROWSER_AL_RUNTIME_DB_NAME,
         storeName: BROWSER_AL_RUNTIME_STORE_NAME,
         schemaId: AL_ADMISSION_SCHEMA_ID,
-        onStorageReset
+        onStorageReset: toALStorageResetSink(storage, BROWSER_AL_RUNTIME_DB_NAME)
     });
 }
 
@@ -196,7 +195,7 @@ async function deleteBrowserALRuntimeEntriesMatching(
         workNamespaces?: readonly string[];
         canonicalScopes?: readonly string[];
         deletionPolicy: BrowserALRuntimeDeletionPolicy;
-        onStorageReset: (event: ALStorageResetEvent) => void;
+        storage: ALStorageEventSink;
     }>
 ): Promise<BrowserALRuntimeCleanupResult> {
     const keyPrefixes = [...new Set(options.keyPrefixes)].filter((prefix) => prefix.length > 0);
@@ -207,7 +206,7 @@ async function deleteBrowserALRuntimeEntriesMatching(
         return toBrowserALRuntimeCleanupResult(keyPrefixes, 0, 0);
     }
 
-    const db = await openBrowserALRuntimeDatabase(options.onStorageReset);
+    const db = await openBrowserALRuntimeDatabase(options.storage);
 
     try {
         if (options.deletionPolicy.kind === 'expired') {
```

```diff
diff --git a/packages/shared-web/browser/connection/initialise-browser-middleware.ts b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
index 095628485..278dcbd94 100644
--- a/packages/shared-web/browser/connection/initialise-browser-middleware.ts
+++ b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
@@ -276,7 +276,7 @@ function initialiseBrowserRuntimeStores(
 ): void {
     initialiseBrowserCacheRepositories();
     configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
-    initBrowserALRuntimeExpiryEviction({ onStorageReset: diagnosticsPorts.onStorageReset }).catch((error) =>
+    initBrowserALRuntimeExpiryEviction({ storage: diagnosticsPorts.storage }).catch((error) =>
         console.error('Failed to initialise browser AL runtime expiry eviction:', toError(error))
     );
 }
```

```diff
diff --git a/packages/shared-web/browser/session/session-auth-lifecycle.ts b/packages/shared-web/browser/session/session-auth-lifecycle.ts
index 8fae9313b..d684a4396 100644
--- a/packages/shared-web/browser/session/session-auth-lifecycle.ts
+++ b/packages/shared-web/browser/session/session-auth-lifecycle.ts
@@ -312,7 +312,7 @@ export class BrowserSessionAuthLifecycle implements RallarSessionAuthLifecycle {
         const dataCleanupError = await captureError(() => this.input.closeDataScopes(session));
         try {
             await deleteBrowserALRuntimeEntriesForSession(session.sessionId, {
-                onStorageReset: diagnosticsPorts.onStorageReset
+                storage: diagnosticsPorts.storage
             });
         }
         catch {
```

- [ ] **Step 10: The public types.** The same two lines in `rallar.ts` and `rallar-core.ts`:

```diff
diff --git a/packages/shared-web/browser/rallar.ts b/packages/shared-web/browser/rallar.ts
index 9801a58f6..222505155 100644
--- a/packages/shared-web/browser/rallar.ts
+++ b/packages/shared-web/browser/rallar.ts
@@ -284,3 +284,5 @@ export type {
     ALDeliveryRelayRejection,
     ALDeliveryState
 } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
+export type { ALStorageEvent, ALStorageRecoveryOutcome } from '@shared/alm/storage/al-storage-event.ts';
+export type { ALStorageUnavailable, ALStorageUnavailableCause } from '@shared/alm/storage/al-storage-unavailable.ts';
```

```diff
diff --git a/packages/shared-web/browser/rallar-core.ts b/packages/shared-web/browser/rallar-core.ts
index 8161b925e..995044260 100644
--- a/packages/shared-web/browser/rallar-core.ts
+++ b/packages/shared-web/browser/rallar-core.ts
@@ -131,3 +131,5 @@ export type {
     ALDeliveryState
 } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
 export { AL_DELIVERY_ADMITTED_STATES, AL_DELIVERY_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
+export type { ALStorageEvent, ALStorageRecoveryOutcome } from '@shared/alm/storage/al-storage-event.ts';
+export type { ALStorageUnavailable, ALStorageUnavailableCause } from '@shared/alm/storage/al-storage-unavailable.ts';
```

- [ ] **Step 11: The harness topics.**

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts
index baf0aafc7..93ae87415 100644
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts
@@ -126,8 +126,14 @@ export function createBlackBoxRallarDiagnosticsPorts(
                 topic: 'rallar.browser.alm.inbound_diagnostics',
                 data: { ...event }
             }),
-        onStorageReset: (event) =>
-            diagnostics.emit({ kind: 'diagnostic', topic: 'rallar.browser.alm.storage_reset', data: { ...event } })
+        storage: (event) =>
+            event.kind === 'reset'
+                ? diagnostics.emit({
+                    kind: 'diagnostic',
+                    topic: 'rallar.browser.alm.storage_reset',
+                    data: { ...event.event }
+                })
+                : diagnostics.emit({ kind: 'diagnostic', topic: 'rallar.browser.alm.storage', data: { ...event } })
     };
 }
```

- [ ] **Step 12: The navigation maps.**

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
index 2f3fe3d3d..8a37f7a11 100644
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -433,6 +433,10 @@ measured halves are `readDurationMs` and `commitDurationMs`.
 
 ## Storage Reset Diagnostics
 
+The browser's `RallarDiagnosticsPorts.storage` port receives every
+`ALStorageEvent` of the browser ALM stores. The harness publishes its `reset`
+arm here and every other arm on `rallar.browser.alm.storage` (below).
+
 `rallar.browser.alm.storage_reset` carries an `ALStorageResetEvent` recorded
 the moment `openIndexedDbAdmissionDatabase` deletes and reopens a database
 whose stores or schema identity no longer match. This is not one event per
@@ -457,6 +461,20 @@ layouts, new stored fields) leaves behind: it confirms the old database was
 discarded rather than left mismatched underneath a client that assumes the
 current shape.
 
+## Storage Diagnostics
+
+`rallar.browser.alm.storage` carries every `ALStorageEvent` but a reset; the
+event's `data` is the event itself, with `kind` and, except for `persist`, the
+`storeId` of the store it describes (`browser-session-inbound:<sessionId>`,
+`browser-ws-client:<sessionId>` or `browser-rtc-overlay:<sessionId>`).
+
+- `health`: `status` (`healthy` or `failing`), `lastFailure` (an
+  `ALStorageUnavailable`: `cause` and `detail`, or `undefined` before the first
+  failure) and `lastRecoveryPointAtMs` (the store's last durable commit, or
+  `undefined` before its first). A store starts `healthy` without an event and
+  states only a change of status, never one event per send: `failing` at its
+  first storage failure, `healthy` at the first recovery point after it.
+
 ## Compatibility
 
 Adding optional fields to diagnostic payloads is compatible.
```

```diff
diff --git a/packages/shared/alm/outbound/README.md b/packages/shared/alm/outbound/README.md
index d27000cf9..4fb8f2499 100644
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -814,7 +814,8 @@ IndexedDB-only; the memory pair is swept by its own lane (Store lanes, above).
 
 A browser database whose stores or recorded schema identity do not match is deleted
 and recreated once, and the reset is reported through the required `onStorageReset`
-port with the previous and current schema ids. An undecodable schema row is treated
+port with the previous and current schema ids; the browser composition states it as
+the `reset` event of the store on its `storage` port. An undecodable schema row is treated
 as "no schema record yet" and resets the same way. A mismatch that survives that
 single reset is a storage invariant failure and throws; a delete that stays blocked by
 another open connection throws `ALStorageResetBlockedError`. Unrelated application
```

- [ ] **Step 13: Format the touched files** (explicit list, never a glob):

```sh
git diff --name-only HEAD; git ls-files --others --exclude-standard   # review the list, then:
git diff --name-only HEAD | grep -E '\.(ts|md)$' | xargs npx dprint fmt
git ls-files --others --exclude-standard | grep -E '\.(ts|md)$' | xargs npx dprint fmt
```

- [ ] **Step 14: Run the focused tests.**

```sh
npx vitest run packages/tests/shared/alm/storage packages/tests/shared-web/al-runtime packages/tests/shared-test/rallar-browser-runtime packages/tests/shared-web/session packages/tests/shared-web/connection packages/tests/shared-web/composition packages/tests/shared-web/rallar-facade-defaults.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts
```

Expected (measured on the assembled commit `bdbdabd2d`): `Test Files  54 passed (54)`, `Tests  509 passed (509)`.

- [ ] **Step 15: Constraint checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit                      # exit 0
npm --workspace @ar-eye-hunter/shared-web run typecheck                # exit 0
npm --workspace @ar-eye-hunter/shared-server run typecheck             # exit 0
npx tsc -p packages/shared-test/tsconfig.json --noEmit                 # exit 0
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1411 test files enforced, 0 files carrying known debt (0 errors).
# PASS: no new type errors in the maintained test project
```

- [ ] **Step 16: Bundles.**

```sh
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles   # Bundle budget check passed.
npx vitest run packages/tests/rallar-black-box-headless               # Tests  4 passed (4)
```

Measured (and the same on `bdbdabd2d`): `browser/rallar.ts` 230.370 → 230.533 KiB (budget 231); headless
294.028 → 294.231 KiB (budget 295 from Task 1). Neither crosses.

- [ ] **Step 17: Commit.**

```sh
git add packages/shared/alm/storage/al-storage-event.ts packages/shared/alm/storage/al-storage-health.ts packages/shared/alm/al-runtime-stores.ts packages/shared/alm/outbound/al-outbound-message-runtime.ts packages/shared/alm/inbound/al-inbound-message-runtime.ts packages/shared/alm/outbound/README.md packages/shared-web/browser/connection/rallar-diagnostics-ports.ts packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts packages/shared-web/browser/connection/initialise-browser-middleware.ts packages/shared-web/browser/session/session-auth-lifecycle.ts packages/shared-web/browser/rallar.ts packages/shared-web/browser/rallar-core.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md packages/tests/shared/alm/storage/al-storage-health.test.ts packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts packages/tests/shared-web/composition/browser-facade-behavior.test.ts packages/tests/shared-web/rallar-facade-defaults.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
git commit -m "Widen the storage reset port into one storage port of four kinds

RallarDiagnosticsPorts.storage replaces onStorageReset and receives an
ALStorageEvent: reset, recovery, health or persist, each naming its store.
Each browser store gets one ALStorageHealth per connect, which states only a
change of status, and the composition states the factory's resets as the
store's reset event. The harness keeps rallar.browser.alm.storage_reset for
the reset and publishes the other kinds on rallar.browser.alm.storage.

rallar.ts measures 230.533 KiB (230.370), the headless agent 294.231 KiB (294.028).

D8 reuse: the health state is an ObservableLatestValue whose update listener is the transition; the reset sink of the ALM factories and ALStorageResetListeners are kept and adapted, not duplicated; no Map, no second port."
```

- [ ] **Step 18: Changed-range gates (need the commit).**

```sh
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings (c86ee9519… -> HEAD).
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: no current structure-coupled test candidates
# PASS: changed-range structure-coupling review has complete individual classifications
# PASS: registry entries are complete and current
```

(Measured note: a first version pinned the throwing-port case with `toHaveBeenCalledTimes(2)` on a `vi.fn` and the
coupling gate reported `mock-invocation-count-or-order`; the case now records the events the port saw.)

---

### Task 3: the `storage-unavailable` verdict and failure, and no storage throw out of a lane

Prototyped in `scratch-A` as commit `993e564df` on Task 2's `14d2a5b17` (red, then green); assembled as `4567aa673`
on `scratch/i2a-assemble` with the idle-probe gate R-I2a-i-50 asks for (Steps 1, 5 and 8 carry it). **Depends on
Task 2**: it records into the `ALStorageHealth` Task 2 creates (`ALOutboundRuntimeStores.storageHealth`,
`ALInboundRuntimeStores.storageHealth`) and its tests read `ALStorageEvent`. Proposal §1.1, §3.a, §3.b (health);
decision D122. Fact sheet items 2, 4, 8.

**Files**

- Modify: `packages/shared/alm/delivery/al-delivery-lifecycle.ts:76-91` — the verdict arm
  `(Readonly<{ kind: 'storage-unavailable'; }> & ALStorageUnavailable)`, modelled on the failure union's
  `receipt-exhausted` intersection.
- Modify: `packages/shared/alm/delivery/al-delivery-failure.ts:16-27` — the failure arm
  `{ kind: 'storage-unavailable'; cause: ALStorageUnavailableCause }`.
- Modify: `packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts:153-180` (the verdict case) and `:268-277`
  (`'storage-unavailable': 'failed'`). The twelve states and their decoders are unchanged.
- Create: `packages/shared/alm/storage/al-storage-readiness.ts` (81 lines) — `ALStorageReadiness`: a lane's open
  (begun at construction, as `readyPromise` was), its work bootstrap, `readOpenedStore` (the idle probe's gate,
  R-I2a-i-50) and `runStoreOperation`.
- Modify: `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts:203-214` — the catch where
  `NonRetryableException` becomes `failed` also turns a storage failure into `storage-unavailable` (intent `enqueue`
  only, as today); new `toALOutboundThrownVerdict`.
- Modify: `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts` — `readyPromise` (`:79`, `:95`) becomes an
  `ALStorageReadiness`; `ready()` (`:131-134`) answers `Either`; `commit`/`commitAll` (`:149-176`) record a failure or
  a recovery point (new `recordStorageHealth`); `acceptControlMessage`, `acceptReceipt`, `endReceipt` (`:186-205`) run
  through `runStoreOperation`; the work handler gets `storageHealth`.
- Modify: `packages/shared/alm/inbound/lane/al-inbound-store-lane.ts` — the same readiness (`:74`, `:94`, `:121-124`);
  `admitData` (`:133-150`) runs through `runStoreOperation` (body moved to `admitDataInStore`) and records a recovery
  point when it wrote work; `admitControl` (`:156-165`) through `runStoreOperation`.
- Modify: `packages/shared/alm/work/al-work-handler.ts` — `ALWorkHandlerDependencies.storageHealth?` (`:35-69`),
  `flushReleases` records a recovery point (`:465-473`), `reportBatchFailure` classifies (`:492-494`).
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (`Resources`, `:336`; `ready()`, `:451-453`),
  `packages/shared/alm/inbound/al-inbound-message-runtime.ts` (`Resources`, `:73-75`; `ready()`, `:181-183`),
  `create-default-al-outbound-message-runtime.ts:115`, `create-default-al-inbound-message-runtime.ts:47-49` — the pair's
  health travels in `Resources`; the runtimes' `ready()` answers the durable lane's `Either`.
- Modify (exhaustive readers of the two unions): `packages/shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts:134-150`
  (`terminal`), `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-publish-result.ts:45-63`
  (`failed`; PostgreSQL never answers it), `packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts:48-59`,
  `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts:44-70`.
- Docs: `packages/shared/alm/outbound/README.md:33` and § Read and failure boundaries,
  `packages/shared/alm/inbound/README.md` § Selection, failure, and cleanup,
  `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md:411`,
  `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` § Storage Diagnostics.
- Tests: create `packages/tests/shared/alm/storage/al-storage-readiness.test.ts` (3),
  `packages/tests/shared/alm/outbound/al-outbound-storage-unavailable.test.ts` (4),
  `packages/tests/shared/alm/inbound/al-inbound-storage-unavailable.test.ts` (1); modify
  `packages/tests/shared/alm/work/al-work-handler.test.ts` (2 new), `packages/tests/shared/alm/delivery/al-delivery-failure.test.ts`
  (1 new row), `packages/tests/shared-test/alm-delivery-failure-decoding.test.ts` (2 new rows), and two direct
  `Resources` constructions (`packages/tests/shared/al-outbound-message-runtime.test.ts:61`,
  `packages/tests/shared/alm/al-inbound-admission-preparation.test.ts:571-588`: `storageHealth: undefined`).
- Not touched: `ALAdmissionWorkBackend` and the three backends (I/O shape unchanged), the browser dispatch
  (`browser-rallar-message-dispatch.ts`: a `storage-unavailable` verdict is not carrier-owned and no fallback trigger,
  so it settles the handle `failed`; Task 4 adds the `volatile` choice there), the volatile lanes (their memory pair
  carries no health and never fails for storage).

**Interfaces**

- Consumes: Task 1's `ALStorageUnavailable`, `ALStorageUnavailableCause`, `toALStorageUnavailable`; Task 2's
  `ALStorageHealth` (`recordFailure`, `recordRecoveryPoint`), `ALStorageEvent` (tests), the optional `storageHealth` on
  both store-pair types; `Either` (`packages/shared/resilience/Either.ts`), `toError`.
- Produces:
  ```ts
  // packages/shared/alm/delivery/al-delivery-lifecycle.ts
  ALDeliveryAdmissionVerdict |= (Readonly<{ kind: 'storage-unavailable'; }> & ALStorageUnavailable);
  // packages/shared/alm/delivery/al-delivery-failure.ts
  ALDeliveryFailure |= Readonly<{ kind: 'storage-unavailable'; cause: ALStorageUnavailableCause; }>;  // state `failed`

  // packages/shared/alm/storage/al-storage-readiness.ts
  export namespace ALStorageReadiness {
      export interface Input {
          readonly openStores: () => Promise<void>;
          readonly startWork: () => Promise<void>;
          readonly storageHealth: ALStorageHealth | undefined;
      }
      export type Outcome = Either<ALStorageUnavailable, 'ready'>;
  }
  export class ALStorageReadiness {
      constructor(input: ALStorageReadiness.Input);
      ready(): Promise<ALStorageReadiness.Outcome>;
      /** The idle engine's read: answered `whileUnavailable`, touching no storage, while the last open failed. */
      readOpenedStore<T>(read: () => Promise<T>, whileUnavailable: T): Promise<T>;
      runStoreOperation<T>(operation: () => Promise<T>, toAnswer: (unavailable: ALStorageUnavailable) => T): Promise<T>;
  }

  ALOutboundStoreLane.ready(): Promise<ALStorageReadiness.Outcome>;     // was Promise<void>
  ALInboundStoreLane.ready(): Promise<ALStorageReadiness.Outcome>;
  ALOutboundMessageRuntime.ready(): Promise<ALStorageReadiness.Outcome>; // the durable lane's answer
  ALInboundMessageRuntime.ready(): Promise<ALStorageReadiness.Outcome>;
  ALOutboundMessageRuntime.Resources.storageHealth: ALStorageHealth | undefined;
  ALInboundMessageRuntime.Resources.storageHealth: ALStorageHealth | undefined;
  ALWorkHandlerDependencies.storageHealth?: ALStorageHealth;
  ```
  The right of `Outcome` is `'ready'`, not `void`: `Either` refuses an `undefined` right ("Either must contain exactly
  one of left or right", `Either.ts:21-28`), and `Either<string, 'published'>` is the precedent
  (`ws-queue-box-server-ack-relay.ts:10`) (R-I2a-i-11). Behaviour at the lane: a pair that cannot open answers `Left`
  (recorded on the health), and the next `ready()` opens again (`IndexedDbConnection.open` already forgets a failed
  open); a non-storage open failure still rejects. An enqueue whose commit throws for storage settles
  `storage-unavailable` with no entries and `trackedReceiptAlgo: 'none'`; a group whose commit throws falls back to
  members alone (unchanged), each answering its own verdict. A control or receipt its store cannot persist is
  `not-handled`; a hand-over whose receipt row cannot end returns; an inbound message is
  `{ kind: 'not-admitted', reason: 'storage-unavailable' }`, an inbound control `not-handled`. A `dequeue` or `repair`
  commit still throws into its work claim (retry), and a batch whose storage fails records `failing` instead of
  `console.error` (R-I2a-i-14). Every committed admission, every inbound admission that wrote work and every flushed
  batch with releases is a recovery point, which ends `failing`.

  A lane whose open failed (R-I2a-i-50): `runtime.ready()` resolves with the durable lane's `Left` (recorded once on
  the health), the work bootstrap does not run, and the engine's idle readiness probe goes through
  `readOpenedStore`, so it answers "no work" without touching storage until a send or admission opens the store again.
  Without the gate the engine's own task (registered at construction) probes the missing database on every pass, each
  probe rejecting inside the engine (`TaskEngine error ... IndexedDB is not available`, measured: 3 `al-work`
  operations attempted over 3 passes). The volatile lane keeps admitting and delivering, which Task 5 relies on for a
  browser without IndexedDB.

**D8 reuse inspection.** Reused: `Either` for the readiness answer; Task 1's classifier at every boundary (one
classification, three call sites: the dispatch catch, `ALStorageReadiness`, the work handler); Task 2's
`ALStorageHealth` as the one place a failure or recovery point is recorded; the existing `NonRetryableException` catch
in `commitWithPhases` (widened, not duplicated); the inbound `not-admitted` and the control `not-handled` answers that
already exist; `IndexedDbConnection`'s own forgetting of a failed open (the retry costs no new code). Not added: no
`Either` from any backend; no new timer, no retry loop (the next call retries); no state on the runtime (it forwards
the durable lane's answer); no IndexedDB operation, so the warm pins (chain 6, total 8, 37 requests, 10 `al-admission`
plus 5 `al-work`), the cold pin (10 + 9), the inbound pins and the volatile zero pin are unchanged (their suites pass in
Step 9). The lanes' shared start and fallback live in one class, not twice.

- [ ] **Step 1: Write the failing tests.**

Create `packages/tests/shared/alm/storage/al-storage-readiness.test.ts`:

```ts
// packages/tests/shared/alm/storage/al-storage-readiness.test.ts
import { describe, expect, it, vi } from 'vitest';

import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import { ALStorageReadiness } from '@shared/alm/storage/al-storage-readiness.ts';
import { ALStorageUnavailableError } from '@shared/alm/storage/al-storage-unavailable.ts';

const OPEN_FAILED = new ALStorageUnavailableError({
    cause: 'open-failed',
    detail: 'IndexedDB open of "al-runtime" failed: UnknownError: boom'
});

describe('ALStorageReadiness', () => {
    it('opens the stores once at construction and starts the work after the open', async () => {
        const calls: string[] = [];
        const readiness = new ALStorageReadiness({
            openStores: async () => {
                calls.push('open');
            },
            startWork: async () => {
                calls.push('work');
            },
            storageHealth: undefined
        });

        expect(calls).toEqual(['open']);
        expect((await readiness.ready()).right).toBe('ready');
        expect((await readiness.ready()).right).toBe('ready');
        expect(calls).toEqual(['open', 'work', 'work']);
    });

    // A store that cannot open answers as a value, states failing once, and the next call opens again.
    it('answers a storage failure as a value, records it and retries the open on the next call', async () => {
        const events: ALStorageEvent[] = [];
        const calls: string[] = [];
        const readiness = new ALStorageReadiness({
            openStores: async () => {
                calls.push('open');
                if (calls.length === 1) {
                    throw OPEN_FAILED;
                }
            },
            startWork: async () => {
                calls.push('work');
            },
            storageHealth: new ALStorageHealth({
                storeId: 'store-1',
                storage: (event) => events.push(event)
            })
        });

        const failed = await readiness.ready();
        const opened = await readiness.ready();

        expect(failed.left).toEqual(OPEN_FAILED.unavailable);
        expect(opened.right).toBe('ready');
        expect(calls).toEqual(['open', 'open', 'work']);
        await vi.waitFor(() =>
            expect(events).toEqual([{
                kind: 'health',
                storeId: 'store-1',
                status: 'failing',
                lastFailure: OPEN_FAILED.unavailable,
                lastRecoveryPointAtMs: undefined
            }])
        );
    });

    // The idle engine probes through this read: a store whose open failed reads nothing until a call opens it.
    it('answers the idle read without touching storage while the last open failed, and reads once it opened', async () => {
        let opens = 0;
        const reads: string[] = [];
        const readiness = new ALStorageReadiness({
            openStores: async () => {
                opens += 1;
                if (opens === 1) {
                    throw OPEN_FAILED;
                }
            },
            startWork: async () => {},
            storageHealth: undefined
        });
        const read = async () => {
            reads.push('read');
            return 'row';
        };

        const whileFailed = await readiness.readOpenedStore(read, 'none');
        const failed = await readiness.ready();
        const opened = await readiness.ready();
        const afterReady = await readiness.readOpenedStore(read, 'none');

        expect(whileFailed).toBe('none');
        expect([failed.left?.cause, opened.right]).toEqual(['open-failed', 'ready']);
        expect(afterReady).toBe('row');
        expect(reads).toEqual(['read']);
    });

    it('rethrows an open failure that is no storage failure', async () => {
        const readiness = new ALStorageReadiness({
            openStores: async () => {
                throw new Error('ALM storage al-runtime still mismatches after reset');
            },
            startWork: async () => {},
            storageHealth: undefined
        });

        await expect(readiness.ready()).rejects.toThrow('still mismatches after reset');
    });
});
```

Create `packages/tests/shared/alm/outbound/al-outbound-storage-unavailable.test.ts`:

```ts
// packages/tests/shared/alm/outbound/al-outbound-storage-unavailable.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import {
    createCountingIndexedDbOperationObserver,
    createPassThroughIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createIndexedDbOutboundTestStores,
    createOutboundMessage,
    createRecordingOutboundTestRuntime,
    createVolatileOutboundTestStores,
    drainEngine,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';

const QUOTA = new DOMException('The quota has been exceeded.', 'QuotaExceededError');

describe('outbound storage unavailability', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // The failed transaction wrote nothing, so the send settles typed; the next commit is a recovery point.
    it('answers a send whose commit hits the quota storage-unavailable, then healthy at the next commit', async () => {
        const { stores, events } = createObservedStores();
        const runtime = createRecordingOutboundTestRuntime(stores, []);
        vi.spyOn(stores.backend, 'write').mockRejectedValueOnce(QUOTA);

        const refused = await runtime.enqueueIfAbsent(createOutboundMessage('storage-quota'));
        const admitted = await runtime.enqueueIfAbsent(createOutboundMessage('storage-recovered'));

        expect(refused.verdict).toEqual({
            kind: 'storage-unavailable',
            cause: 'quota',
            detail: 'QuotaExceededError: The quota has been exceeded.'
        });
        expect(refused.entries).toEqual([]);
        expect(refused.trackedReceiptAlgo).toBe('none');
        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: true });
        await vi.waitFor(() => expect(events.map(toHealthStatus)).toEqual(['failing', 'healthy']));
        expect(events[0]).toMatchObject({ lastFailure: { cause: 'quota' } });
    });

    // Every member of a group whose commit hits the quota is answered alone, each with its own verdict.
    it('answers each member of a group storage-unavailable when every commit hits the quota', async () => {
        const { stores } = createObservedStores();
        const runtime = createRecordingOutboundTestRuntime(stores, []);
        vi.spyOn(stores.backend, 'write').mockRejectedValue(QUOTA);

        const results = await runtime.enqueueAllIfAbsent([
            createOutboundMessage('storage-group-1'),
            createOutboundMessage('storage-group-2')
        ]);

        expect(results.map((result) => result.verdict.kind)).toEqual([
            'storage-unavailable',
            'storage-unavailable'
        ]);
    });

    // The lane's start answers the failed open as a value; the send reopens, fails again and settles typed.
    it('answers a durable send storage-unavailable while its store cannot open', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const events: ALStorageEvent[] = [];
        const stores = {
            ...createIndexedDbOutboundTestStores({
                observer: createPassThroughIndexedDbOperationObserver(),
                namespace: 'outbound-missing'
            }),
            storageHealth: new ALStorageHealth({
                storeId: 'outbound-missing',
                storage: (event) => events.push(event)
            })
        };
        const runtime = createRecordingOutboundTestRuntime(stores, []);

        const readiness = await runtime.ready();
        const result = await runtime.enqueueIfAbsent(createOutboundMessage('storage-missing'));

        const missing = {
            cause: 'missing',
            detail: 'IndexedDB is not available in this environment'
        } as const;
        expect(readiness.left).toEqual(missing);
        expect(result.verdict).toEqual({ kind: 'storage-unavailable', ...missing });
        await vi.waitFor(() => expect(events.map(toHealthStatus)).toEqual(['failing']));
    });

    // A lane whose open failed starts no work, so the engine's passes probe nothing and health states failing once.
    it('keeps the volatile lane admitting and the durable lane idle while its store cannot open', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const events: ALStorageEvent[] = [];
        const observer = createCountingIndexedDbOperationObserver();
        const engine = new InboxOutboxEngine();
        const volatileStores = createVolatileOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            queueEngine: engine,
            stores: {
                ...createIndexedDbOutboundTestStores({
                    observer,
                    namespace: 'outbound-missing-volatile'
                }),
                storageHealth: new ALStorageHealth({
                    storeId: 'outbound-missing',
                    storage: (event) => events.push(event)
                })
            },
            volatileStores,
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });

        const readiness = await runtime.ready();
        const fleeting = createOutboundMessage('volatile-without-storage');
        const result = await runtime.enqueueIfAbsent(fleeting);
        for (let pass = 0; pass < 3; pass += 1) {
            await drainEngine(engine);
        }

        expect(readiness.left?.cause).toBe('missing');
        expect(result.verdict.kind).toBe('admitted');
        expect(await volatileStores.admissionStore.hasSentMessageAdmission(fleeting.id.msgId)).toBe(
            true
        );
        expect(observer.getCounts().byOwner['al-work']).toBe(0);
        await vi.waitFor(() => expect(events.map(toHealthStatus)).toEqual(['failing']));
        runtime.dispose();
    });

    it('leaves a commit failure that is no storage failure a throw', async () => {
        const { stores } = createObservedStores();
        const runtime = createRecordingOutboundTestRuntime(stores, []);
        vi.spyOn(stores.backend, 'write').mockRejectedValueOnce(new Error('defect'));

        await expect(runtime.enqueueIfAbsent(createOutboundMessage('storage-defect'))).rejects
            .toThrow('defect');
    });
});

function createObservedStores(): Readonly<
    { stores: OutboundTestStores; events: ALStorageEvent[]; }
> {
    const events: ALStorageEvent[] = [];
    const stores: OutboundTestStores = {
        ...createDefaultOutboundTestStores(),
        storageHealth: new ALStorageHealth({
            storeId: 'outbound-test',
            storage: (event) => events.push(event)
        })
    };
    return { stores, events };
}

function toHealthStatus(event: ALStorageEvent): string {
    return event.kind === 'health' ? event.status : event.kind;
}
```

Create `packages/tests/shared/alm/inbound/al-inbound-storage-unavailable.test.ts`:

```ts
// packages/tests/shared/alm/inbound/al-inbound-storage-unavailable.test.ts
import { describe, expect, it, vi } from 'vitest';

import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE
} from '../inbound-runtime-test-fixture.ts';

const QUOTA = new DOMException('The quota has been exceeded.', 'QuotaExceededError');

describe('inbound storage unavailability', () => {
    // Nothing was written, so the message is not admitted and its sender's receipt retries it.
    it('answers a message whose admission hits the quota not admitted, then healthy at the next commit', async () => {
        const events: ALStorageEvent[] = [];
        const { backend, stores } = createInboundTestBackendStores({
            namespace: 'inbound-storage',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const fixture = createInboundTestRuntime({
            stores: {
                ...stores,
                storageHealth: new ALStorageHealth({
                    storeId: 'inbound-test',
                    storage: (event) => events.push(event)
                })
            },
            carrier: 'ws',
            effectWorkerId: 'al-inbound:storage'
        });
        vi.spyOn(backend, 'write').mockRejectedValueOnce(QUOTA);

        const refused = await fixture.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'inbound-quota' }),
            INBOUND_TEST_SOURCE
        );
        const admitted = await fixture.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'inbound-recovered' }),
            INBOUND_TEST_SOURCE
        );

        expect(refused.right).toEqual({ kind: 'not-admitted', reason: 'storage-unavailable' });
        expect(admitted.right).toEqual({ kind: 'admitted' });
        await vi.waitFor(() =>
            expect(events.map((event) => event.kind === 'health' ? event.status : event.kind))
                .toEqual(['failing', 'healthy'])
        );
    });
});
```

Add to `packages/tests/shared/alm/work/al-work-handler.test.ts`:

```diff
diff --git a/packages/tests/shared/alm/work/al-work-handler.test.ts b/packages/tests/shared/alm/work/al-work-handler.test.ts
index 2e24e9b43..7de1deee1 100644
--- a/packages/tests/shared/alm/work/al-work-handler.test.ts
+++ b/packages/tests/shared/alm/work/al-work-handler.test.ts
@@ -1,5 +1,7 @@
 import { Temporal } from '@js-temporal/polyfill';
 import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
+import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
+import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
 import type {
     ALWorkAttemptResult,
     ALWorkBatchDiagnostics,
@@ -1151,6 +1153,76 @@ describe('ALWorkHandler', () => {
             handler.dispose();
         }
     });
+
+    // A failed batch wrote nothing, so its rows wait for the next batch; the store's health says why.
+    it('states a storage failure of a batch as failing health instead of logging it', async () => {
+        const logged: unknown[][] = [];
+        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
+            logged.push(args);
+        });
+        const events: ALStorageEvent[] = [];
+        const handler = new ALWorkHandler({
+            workerId: 'storage-worker',
+            port: recordingPort([], []),
+            queueEngine: createEngine(),
+            ownsQueueEngine: false,
+            clock: { nowMs: () => 1_000 },
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            readNextReadyAtMs: async () => undefined,
+            selectReady: async () => {
+                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
+            },
+            runClaim: async () => ({ status: 'completed' }),
+            diagnostics: undefined,
+            storageHealth: new ALStorageHealth({ storeId: 'store-1', storage: (event) => events.push(event) })
+        });
+
+        await handler.ready();
+
+        await vi.waitFor(() =>
+            expect(events).toEqual([{
+                kind: 'health',
+                storeId: 'store-1',
+                status: 'failing',
+                lastFailure: { cause: 'quota', detail: 'QuotaExceededError: The quota has been exceeded.' },
+                lastRecoveryPointAtMs: undefined
+            }])
+        );
+        expect(logged).toEqual([]);
+        consoleErrorSpy.mockRestore();
+        handler.dispose();
+    });
+
+    // A batch that released claims committed them: a recovery point that ends a failure.
+    it('records a recovery point when a batch flushes its releases', async () => {
+        const events: ALStorageEvent[] = [];
+        const storageHealth = new ALStorageHealth({ storeId: 'store-1', storage: (event) => events.push(event) });
+        storageHealth.recordFailure({ cause: 'quota', detail: 'QuotaExceededError: full' });
+        const handler = new ALWorkHandler({
+            workerId: 'storage-worker',
+            port: recordingPort(['w-1'], []),
+            queueEngine: createEngine(),
+            ownsQueueEngine: false,
+            clock: { nowMs: () => 2_000 },
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            readNextReadyAtMs: async () => undefined,
+            selectReady: async (port, size) => toTestALWorkReadySelection(await port.claim({ maxCount: size, observedEntries: undefined })),
+            runClaim: async () => ({ status: 'completed' }),
+            diagnostics: undefined,
+            storageHealth
+        });
+
+        await handler.ready();
+
+        await vi.waitFor(() =>
+            expect(events.map((event) => event.kind === 'health' ? event.status : event.kind))
+                .toEqual(['failing', 'healthy'])
+        );
+        expect(events[1]).toMatchObject({ lastRecoveryPointAtMs: 2_000 });
+        handler.dispose();
+    });
 });
 
 function createEngine(): InboxOutboxEngine {
```

Add the failure row and the decoder rows:

```diff
diff --git a/packages/tests/shared/alm/delivery/al-delivery-failure.test.ts b/packages/tests/shared/alm/delivery/al-delivery-failure.test.ts
index 182fe4b35..f410d4dd9 100644
--- a/packages/tests/shared/alm/delivery/al-delivery-failure.test.ts
+++ b/packages/tests/shared/alm/delivery/al-delivery-failure.test.ts
@@ -152,6 +152,19 @@ const FAILURE_CASES: readonly FailureCase[] = [
         failure: { kind: 'admission-failed' },
         reason: 'Storage unavailable'
     },
+    {
+        meaning: 'an admission its store could not persist',
+        settlements: [
+            toAdmission({
+                kind: 'storage-unavailable',
+                cause: 'quota',
+                detail: 'QuotaExceededError: The quota has been exceeded.'
+            })
+        ],
+        state: 'failed',
+        failure: { kind: 'storage-unavailable', cause: 'quota' },
+        reason: 'QuotaExceededError: The quota has been exceeded.'
+    },
     {
         meaning: 'a skipped admission',
         settlements: [
```

```diff
diff --git a/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts b/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
index 96fc442f4..d17e40bb2 100644
--- a/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
+++ b/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
@@ -32,6 +32,7 @@ describe('the typed failure a delivery observation carries (D75, C2)', () => {
                 rejection: { relay: 'peer', peerId: 'relay-session', reason: 'resync-required' }
             },
             { kind: 'admission-failed' },
+            { kind: 'storage-unavailable', cause: 'quota' },
             { kind: 'skipped', reason: 'planner-drop' },
             { kind: 'unroutable', reason: 'no-route' },
             { kind: 'attempt-failed', outcome: 'no-targets' },
@@ -63,6 +64,7 @@ describe('the typed failure a delivery observation carries (D75, C2)', () => {
             },
             field: 'failure.rejection'
         },
+        { failure: { kind: 'storage-unavailable', cause: 'full' }, field: 'failure.cause' },
         { failure: { kind: 'skipped', reason: 'no-route' }, field: 'failure.reason' },
         { failure: { kind: 'unroutable', reason: 'planner-drop' }, field: 'failure.reason' },
         { failure: { kind: 'attempt-failed', outcome: 'sent' }, field: 'failure.outcome' },
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-storage-unavailable.test.ts packages/tests/shared/alm/inbound/al-inbound-storage-unavailable.test.ts packages/tests/shared/alm/storage/al-storage-readiness.test.ts packages/tests/shared/alm/work/al-work-handler.test.ts packages/tests/shared/alm/delivery/al-delivery-failure.test.ts packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
```

Expected (measured on Task 2's assembled commit `bdbdabd2d`): `Test Files  6 failed (6)`, `Tests  10 failed | 69 passed (79)`.
The readiness suite does not load; the three outbound cases that expect `storage-unavailable`, the idle-lane case
(`runtime.ready()` rejects with the raw `ALStorageUnavailableError`) and the inbound case fail (a raw
`QuotaExceededError` or `ALStorageUnavailableError` rejects the call); the two work cases fail (no health event; the
batch logs); the failure row and the two decoder rows fail. "leaves a commit failure that is no storage failure a
throw" passes already: it guards that only storage is classified.

- [ ] **Step 3: The verdict arm and the failure arm.**

```diff
diff --git a/packages/shared/alm/delivery/al-delivery-lifecycle.ts b/packages/shared/alm/delivery/al-delivery-lifecycle.ts
index 9b08de549..6f49a0f2a 100644
--- a/packages/shared/alm/delivery/al-delivery-lifecycle.ts
+++ b/packages/shared/alm/delivery/al-delivery-lifecycle.ts
@@ -1,5 +1,6 @@
 import type { ALAckMode } from '../../al-contracts/al-contract.ts';
 import type { ALAckAlgo, ALReceiptMode } from '../../al-contracts/al-policy.ts';
+import type { ALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
 import type { ALDeliveryFailure, ALDeliveryReceiptExhaustion } from './al-delivery-failure.ts';
 
 export type ALDeliveryState =
@@ -88,6 +89,8 @@ export type ALDeliveryAdmissionVerdict =
     | Readonly<{ kind: 'superseded'; detail: string; }>
     | Readonly<{ kind: 'expired'; detail: string; }>
     | Readonly<{ kind: 'skipped'; reason: ALDeliverySkippedReason; detail: string; }>
+    /** The durable store could not persist the admission, so it wrote nothing. */
+    | (Readonly<{ kind: 'storage-unavailable'; }> & ALStorageUnavailable)
     | Readonly<{ kind: 'failed'; detail: string; }>;
 
 export type ALDeliverySettlement =
```

```diff
diff --git a/packages/shared/alm/delivery/al-delivery-failure.ts b/packages/shared/alm/delivery/al-delivery-failure.ts
index 527881302..b36ec53a3 100644
--- a/packages/shared/alm/delivery/al-delivery-failure.ts
+++ b/packages/shared/alm/delivery/al-delivery-failure.ts
@@ -1,4 +1,5 @@
 import type { ALNackReason } from '../../al-contracts/al-control.ts';
+import type { ALStorageUnavailableCause } from '../storage/al-storage-unavailable.ts';
 import type {
     ALDeliveryAttemptOutcome,
     ALDeliveryRefusalReason,
@@ -17,6 +18,7 @@ export type ALDeliveryFailure =
     | Readonly<{ kind: 'refused'; reason: ALDeliveryRefusalReason; }>
     | Readonly<{ kind: 'relay-rejected'; rejection: ALDeliveryRelayRejection; }>
     | Readonly<{ kind: 'admission-failed'; }>
+    | Readonly<{ kind: 'storage-unavailable'; cause: ALStorageUnavailableCause; }>
     | Readonly<{ kind: 'skipped'; reason: ALDeliverySkippedReason; }>
     | Readonly<{ kind: 'unroutable'; reason: ALDeliveryUnroutableReason; }>
     | Readonly<{
```

```diff
diff --git a/packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts b/packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts
index b2337fc51..43db99c69 100644
--- a/packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts
+++ b/packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts
@@ -174,6 +174,8 @@ function toAdmissionLifecycle(
             return toFailureLifecycle(previous, { kind: 'expired' }, verdict.detail);
         case 'failed':
             return toFailureLifecycle(previous, { kind: 'admission-failed' }, verdict.detail);
+        case 'storage-unavailable':
+            return toFailureLifecycle(previous, { kind: 'storage-unavailable', cause: verdict.cause }, verdict.detail);
         case 'skipped':
             return toFailureLifecycle(previous, { kind: 'skipped', reason: verdict.reason }, verdict.detail);
     }
@@ -269,6 +271,7 @@ const AL_DELIVERY_FAILURE_STATES: Readonly<Record<ALDeliveryFailure['kind'], ALD
     refused: 'rejected',
     'relay-rejected': 'rejected',
     'admission-failed': 'failed',
+    'storage-unavailable': 'failed',
     skipped: 'failed',
     unroutable: 'failed',
     'attempt-failed': 'failed',
```

- [ ] **Step 4: Every exhaustive reader of the two unions.** `npx tsc -p packages/shared/tsconfig.json --noEmit`
      now reports the signaling switch; the shared-test typecheck reports the two decoder records:

```diff
diff --git a/packages/shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts b/packages/shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts
index 20bcef0bf..7c8e9e02c 100644
--- a/packages/shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts
+++ b/packages/shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts
@@ -144,6 +144,7 @@ function toSignalAdmissionOutcome(verdict: ALDeliveryAdmissionVerdict): SignalAd
         case 'superseded':
         case 'expired':
         case 'skipped':
+        case 'storage-unavailable':
         case 'failed':
             return 'terminal';
     }
```

```diff
diff --git a/packages/shared-server/rallar-system/websocket/router/rallar-server-ws-publish-result.ts b/packages/shared-server/rallar-system/websocket/router/rallar-server-ws-publish-result.ts
index 977943459..5bd4267ca 100644
--- a/packages/shared-server/rallar-system/websocket/router/rallar-server-ws-publish-result.ts
+++ b/packages/shared-server/rallar-system/websocket/router/rallar-server-ws-publish-result.ts
@@ -61,5 +61,8 @@ function toOutboxPublishStatus(verdict: ALDeliveryAdmissionVerdict): RallarServe
         case 'skipped':
         case 'failed':
             return verdict.kind;
+        // The PostgreSQL store never answers it; an unpersisted admission reads as a failed one.
+        case 'storage-unavailable':
+            return 'failed';
     }
 }
```

```diff
diff --git a/packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts b/packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts
index 5b529f15f..03c67d959 100644
--- a/packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts
+++ b/packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts
@@ -55,6 +55,7 @@ const ALM_ADMISSION_VERDICT_KINDS: Readonly<Record<ALDeliveryAdmissionVerdict['k
     superseded: true,
     expired: true,
     skipped: true,
+    'storage-unavailable': true,
     failed: true
 };
```

```diff
diff --git a/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts b/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
index 808ff1e9f..87dc609d4 100644
--- a/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
+++ b/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
@@ -6,6 +6,7 @@ import type {
     ALDeliverySkippedReason,
     ALDeliveryUnroutableReason
 } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
+import type { ALStorageUnavailableCause } from '@shared/alm/storage/al-storage-unavailable.ts';
 import { Either } from '@shared/resilience/Either.ts';
 
 import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
@@ -42,6 +43,16 @@ const ALM_FAILED_ATTEMPT_OUTCOMES: Readonly<Record<AlmFailedAttemptOutcome, true
     'no-targets': true
 };
 
+const ALM_STORAGE_UNAVAILABLE_CAUSES: Readonly<Record<ALStorageUnavailableCause, true>> = {
+    missing: true,
+    'open-failed': true,
+    'reset-blocked': true,
+    quota: true,
+    closed: true,
+    evicted: true,
+    'transaction-failed': true
+};
+
 const ALM_NACK_REASONS: Readonly<Record<ALNackReason, true>> = {
     duplicate: true,
     gap: true,
@@ -63,6 +74,9 @@ const ALM_FAILURE_DECODERS: Readonly<Record<ALDeliveryFailure['kind'], AlmFailur
         decodeAlmRelayRejection(failure.rejection, 'failure.rejection')
             .mapRight((rejection): ALDeliveryFailure => ({ kind: 'relay-rejected', rejection })),
     'admission-failed': () => Either.ofRight<string, ALDeliveryFailure>({ kind: 'admission-failed' }),
+    'storage-unavailable': (failure) =>
+        decodeAlmFailureKey(ALM_STORAGE_UNAVAILABLE_CAUSES, failure.cause, 'cause')
+            .mapRight((cause): ALDeliveryFailure => ({ kind: 'storage-unavailable', cause })),
     skipped: (failure) =>
         decodeAlmFailureKey(ALM_SKIPPED_REASONS, failure.reason, 'reason')
             .mapRight((reason): ALDeliveryFailure => ({ kind: 'skipped', reason })),
```

- [ ] **Step 5: Create `packages/shared/alm/storage/al-storage-readiness.ts`:**

```ts
// packages/shared/alm/storage/al-storage-readiness.ts
import { Either } from '../../resilience/Either.ts';
import { toError } from '../../resilience/to-error.ts';
import type { ALStorageHealth } from './al-storage-health.ts';
import { toALStorageUnavailable, type ALStorageUnavailable } from './al-storage-unavailable.ts';

export namespace ALStorageReadiness {
    export interface Input {
        readonly openStores: () => Promise<void>;
        /** Runs after every open that succeeded; the work owner's bootstrap, which runs once. */
        readonly startWork: () => Promise<void>;
        readonly storageHealth: ALStorageHealth | undefined;
    }

    export type Outcome = Either<ALStorageUnavailable, 'ready'>;
}

/**
 * Where a store lane meets its storage: its pair's open, begun at construction, then its work's
 * bootstrap, and each operation a caller of the lane runs. A storage failure is recorded on the
 * pair's health and answered as a value; an open that failed is tried again by the next call. Any
 * other failure throws.
 */
export class ALStorageReadiness {
    private readonly input: ALStorageReadiness.Input;
    private opening: Promise<ALStorageReadiness.Outcome> | undefined;

    constructor(input: ALStorageReadiness.Input) {
        this.input = input;
        this.opening = this.readOpen();
    }

    async ready(): Promise<ALStorageReadiness.Outcome> {
        this.opening ??= this.readOpen();
        const opened = await this.opening;
        if (opened.left !== undefined) {
            this.opening = undefined;
            return opened;
        }
        await this.input.startWork();
        return opened;
    }

    /** A read the idle engine makes: answered `whileUnavailable`, touching no storage, while the last open failed. */
    async readOpenedStore<T>(read: () => Promise<T>, whileUnavailable: T): Promise<T> {
        const opened = this.opening === undefined ? undefined : await this.opening;
        return opened?.right === undefined ? whileUnavailable : await read();
    }

    /** One operation over the pair; a storage failure of it is answered by `toAnswer`. */
    async runStoreOperation<T>(
        operation: () => Promise<T>,
        toAnswer: (unavailable: ALStorageUnavailable) => T
    ): Promise<T> {
        try {
            return await operation();
        }
        catch (error) {
            return toAnswer(this.recordStorageFailure(toError(error)));
        }
    }

    private async readOpen(): Promise<ALStorageReadiness.Outcome> {
        try {
            await this.input.openStores();
            return Either.ofRight('ready');
        }
        catch (error) {
            return Either.ofLeft(this.recordStorageFailure(toError(error)));
        }
    }

    /** Rethrows a failure that is not one of storage. */
    private recordStorageFailure(error: Error): ALStorageUnavailable {
        const unavailable = toALStorageUnavailable(error);
        if (unavailable === undefined) {
            throw error;
        }
        this.input.storageHealth?.recordFailure(unavailable);
        return unavailable;
    }
}
```

- [ ] **Step 6: The admission boundary turns a storage throw into the verdict.**

```diff
diff --git a/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts b/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts
index 0b97290c3..388990d9d 100644
--- a/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts
+++ b/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts
@@ -2,9 +2,11 @@ import type { ALMessage } from '../../al-contracts/al-contract.ts';
 import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
 import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
 import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
+import { toError } from '../../resilience/to-error.ts';
 import { RetryableConflictError } from '../../resilience/TryWith.ts';
 import type { ALStoreDurability } from '../al-runtime-stores.ts';
 import type { ALDeliveryAdmissionVerdict } from '../delivery/al-delivery-lifecycle.ts';
+import { toALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
 import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
 import type {
     ALOutboundAdmissionStore,
@@ -201,14 +203,16 @@ export class ALOutboundDispatchAdmission<TPrepared> {
             );
         }
         catch (error) {
-            if (!(error instanceof NonRetryableException) || dispatch.intent !== 'enqueue') {
+            const verdict = dispatch.intent === 'enqueue' ? toALOutboundThrownVerdict(toError(error)) : undefined;
+            if (verdict === undefined) {
                 throw error;
             }
             return {
-                computed: toALOutboundVerdictComputed(
-                    { kind: 'failed', detail: error.message },
-                    { msg: dispatch.msg, reason: error.message, entries: [] }
-                ),
+                computed: toALOutboundVerdictComputed(verdict, {
+                    msg: dispatch.msg,
+                    reason: verdict.detail,
+                    entries: []
+                }),
                 committed: false
             };
         }
@@ -645,6 +649,21 @@ export class ALOutboundDispatchAdmission<TPrepared> {
     }
 }
 
+/** The verdict a send settles when its commit threw instead of answering. */
+type ALOutboundThrownVerdict = Extract<
+    ALDeliveryAdmissionVerdict,
+    Readonly<{ kind: 'failed' | 'storage-unavailable'; }>
+>;
+
+/** A send whose commit threw for a non-retryable reason or for its storage settles typed; anything else throws. */
+function toALOutboundThrownVerdict(error: Error): ALOutboundThrownVerdict | undefined {
+    if (error instanceof NonRetryableException) {
+        return { kind: 'failed', detail: error.message };
+    }
+    const unavailable = toALStorageUnavailable(error);
+    return unavailable === undefined ? undefined : { kind: 'storage-unavailable', ...unavailable };
+}
+
 function toALOutboundSettledDecision<TPrepared>(
     verdict: ALDeliveryAdmissionVerdict,
     fields: Readonly<{ msg?: ALMessage; reason?: string; entries: readonly ResourceEntry[]; }>
```

- [ ] **Step 7: The work handler records instead of logging.**

```diff
diff --git a/packages/shared/alm/work/al-work-handler.ts b/packages/shared/alm/work/al-work-handler.ts
index 9726c8c7a..1677e1f03 100644
--- a/packages/shared/alm/work/al-work-handler.ts
+++ b/packages/shared/alm/work/al-work-handler.ts
@@ -3,6 +3,8 @@ import { toKeyAsString } from '../../queuebox/ResourceEntry.ts';
 import { toError } from '../../resilience/to-error.ts';
 import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS, type InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
 import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
+import type { ALStorageHealth } from '../storage/al-storage-health.ts';
+import { toALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
 import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort, ALWorkRelease } from './al-work-queue-port.ts';
 import {
     ALWorkReadinessMemory,
@@ -66,6 +68,11 @@ export interface ALWorkHandlerDependencies {
      */
     readonly runClaim: (claim: ALWorkClaim, batchStartedAtMs: number) => Promise<ALWorkAttemptResult>;
     readonly diagnostics: ((event: ALWorkDiagnostics) => void) | undefined;
+    /**
+     * The health a batch records its storage failure and its flushed releases into. Absent for an
+     * owner over a store no storage failure reaches (memory, PostgreSQL), whose failures are logged.
+     */
+    readonly storageHealth?: ALStorageHealth;
 }
 
 export type ALWorkDiagnostics = ALWorkBatchDiagnostics | ALWorkReadinessProbeDiagnostics;
@@ -466,10 +473,14 @@ export class ALWorkHandler {
         releases: readonly ALWorkRelease[],
         progress: ALWorkBatchProgress
     ): Promise<void> {
-        const { clock, port } = this.dependencies;
+        const { clock, port, storageHealth } = this.dependencies;
         const startedAtMs = clock.nowMs();
         await port.releaseAll(releases);
-        progress.releaseDurationMs = computeElapsedMs(startedAtMs, clock.nowMs());
+        const endedAtMs = clock.nowMs();
+        progress.releaseDurationMs = computeElapsedMs(startedAtMs, endedAtMs);
+        if (releases.length > 0) {
+            storageHealth?.recordRecoveryPoint(endedAtMs);
+        }
     }
 
     /**
@@ -489,8 +500,15 @@ export class ALWorkHandler {
             });
     }
 
+    /** A storage failure wrote nothing, so its rows wait for the next batch; the store's health states it. */
     private reportBatchFailure(error: Error): void {
-        console.error('ALM work batch failed', error);
+        const unavailable = toALStorageUnavailable(error);
+        const { storageHealth } = this.dependencies;
+        if (unavailable === undefined || storageHealth === undefined) {
+            console.error('ALM work batch failed', error);
+            return;
+        }
+        storageHealth.recordFailure(unavailable);
     }
 }
```

- [ ] **Step 8: The lanes, the runtimes and the resources.**

```diff
diff --git a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
--- a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
+++ b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
@@ -5,6 +5,7 @@ import { toKeyAsString, type ResourceEntry } from '../../../queuebox/ResourceEnt
 import type { ALStoreDurability } from '../../al-runtime-stores.ts';
 import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '../../ALStoreRetention.ts';
 import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
+import { ALStorageReadiness } from '../../storage/al-storage-readiness.ts';
 import {
     AL_WORK_READINESS_MEMORY_MS,
     ALWorkHandler,
@@ -76,7 +77,7 @@ export namespace ALOutboundStoreLane {
  */
 export class ALOutboundStoreLane<TPrepared> {
     private readonly input: ALOutboundStoreLane.Input<TPrepared>;
-    private readonly readyPromise: Promise<void>;
+    private readonly readiness: ALStorageReadiness;
     private readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
     private readonly repairAdmission: ALOutboundRepairAdmission<TPrepared>;
     private readonly receiptAdmission: ALOutboundReceiptAdmission<TPrepared>;
@@ -92,7 +93,6 @@ export class ALOutboundStoreLane<TPrepared> {
     constructor(input: ALOutboundStoreLane.Input<TPrepared>) {
         this.input = input;
         const { stores, runtime } = input;
-        this.readyPromise = stores.admissionStore.ready();
         this.leaseRecovery = createLimitedALWorkLeaseRecovery(AL_OUTBOUND_WORK_LEASE_MS, runtime.clock.nowMs());
         const workPort = createALOutboundLaneWorkPort(input, this.leaseRecovery);
         const settlements: ALOutboundSettlementEmitter = (fact) => input.settlements(this.toStoreFact(fact));
@@ -108,11 +108,17 @@ export class ALOutboundStoreLane<TPrepared> {
             ownsQueueEngine: runtime.ownsQueueEngine,
             clock: runtime.clock,
             pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
-            readNextReadyAtMs: (port) => this.readNextReadyAtMs(port),
+            readNextReadyAtMs: (port) => this.readiness.readOpenedStore(() => this.readNextReadyAtMs(port), undefined),
             readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
             selectReady: (port, pageSize) => this.selectOutboundWork(port, pageSize),
             runClaim: (claim) => this.runOutboundClaim(claim),
-            diagnostics: (event) => this.recordWorkDiagnostics(event)
+            diagnostics: (event) => this.recordWorkDiagnostics(event),
+            storageHealth: stores.storageHealth
+        });
+        this.readiness = new ALStorageReadiness({
+            openStores: () => stores.admissionStore.ready(),
+            startWork: () => this.work.ready(),
+            storageHealth: stores.storageHealth
         });
         this.effects = new ALOutboundMessageEffects({
             runtime,
@@ -128,9 +134,8 @@ export class ALOutboundStoreLane<TPrepared> {
             : stores.storageResets?.add(() => canonicalHandoff.clear());
     }
 
-    async ready(): Promise<void> {
-        await this.readyPromise;
-        await this.work.ready();
+    async ready(): Promise<ALStorageReadiness.Outcome> {
+        return await this.readiness.ready();
     }
 
     dispose(): void {
@@ -151,6 +156,7 @@ export class ALOutboundStoreLane<TPrepared> {
     ): Promise<ALOutboundComputedDto<TPrepared>> {
         const result = await this.dispatchAdmission.commit(dispatch);
         this.setCanonicalHandoff(result);
+        this.recordStorageHealth(result);
 
         if (hasWrittenWork(result)) {
             this.work.committed(computeALOutboundCommittedRows(this.input.stores.admissionStore.namespace, [result]));
@@ -168,7 +174,10 @@ export class ALOutboundStoreLane<TPrepared> {
             this.work.committed(AL_WORK_UNDESCRIBED_COMMIT);
             throw error;
         });
-        results.forEach((result) => this.setCanonicalHandoff(result));
+        results.forEach((result) => {
+            this.setCanonicalHandoff(result);
+            this.recordStorageHealth(result);
+        });
         if (results.some(hasWrittenWork)) {
             this.work.committed(computeALOutboundCommittedRows(this.input.stores.admissionStore.namespace, results));
         }
@@ -183,11 +192,27 @@ export class ALOutboundStoreLane<TPrepared> {
         }
     }
 
+    /** Every commit of the durable pair is a recovery point; a send its store refused is its failure. */
+    private recordStorageHealth(result: ALOutboundDispatchAdmission.Result<TPrepared>): void {
+        const { storageHealth } = this.input.stores;
+        const { verdict } = result.computed;
+        if (verdict.kind === 'storage-unavailable') {
+            storageHealth?.recordFailure({ cause: verdict.cause, detail: verdict.detail });
+        }
+        else if (result.committed) {
+            storageHealth?.recordRecoveryPoint(this.readNowMs());
+        }
+    }
+
+    /** A control its store cannot persist is not handled: it wrote nothing, and its sender sends it again. */
     async acceptControlMessage(
         msg: ALMessage,
         source: ALOutboundControlSource
     ): Promise<ALOutboundControlAdmissionResult> {
-        const admitted = await this.repairAdmission.acceptControlMessage(msg, source);
+        const admitted = await this.readiness.runStoreOperation(
+            () => this.repairAdmission.acceptControlMessage(msg, source),
+            (): ALOutboundControlAdmissionResult => ({ kind: 'not-handled' })
+        );
         // A foreign control and a rejected one write nothing, so they owe no batch.
         if (admitted.kind === 'committed' || admitted.kind === 'pending-control') {
             this.work.committed(AL_WORK_UNDESCRIBED_COMMIT);
@@ -196,12 +221,18 @@ export class ALOutboundStoreLane<TPrepared> {
     }
 
     async acceptReceipt(control: ALMessage): Promise<ALOutboundControlAdmissionResult> {
-        return await this.receiptAdmission.admit(control);
+        return await this.readiness.runStoreOperation(
+            () => this.receiptAdmission.admit(control),
+            (): ALOutboundControlAdmissionResult => ({ kind: 'not-handled' })
+        );
     }
 
-    /** A hand-over ends this lane's receipt of the message and states nothing (D56). */
+    /**
+     * A hand-over ends this lane's receipt of the message and states nothing. A receipt its store
+     * cannot end stays until it expires.
+     */
     async endReceipt(msgId: string): Promise<void> {
-        await this.repairAdmission.endReceipt(msgId);
+        await this.readiness.runStoreOperation(() => this.repairAdmission.endReceipt(msgId), () => undefined);
     }
 
     /** What the admission states, as this lane's store holds it: nothing on the memory pair survives the document. */
```

```diff
diff --git a/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts b/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
--- a/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
+++ b/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
@@ -4,6 +4,7 @@ import { NonRetryableException } from '../../../queuebox/resource-inbox/create-d
 import { Either } from '../../../resilience/Either.ts';
 import type { ALStoreDurability } from '../../al-runtime-stores.ts';
 import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '../../ALStoreRetention.ts';
+import { ALStorageReadiness } from '../../storage/al-storage-readiness.ts';
 import {
     AL_WORK_PROBE_EVERY_ROUND,
     ALWorkHandler,
@@ -71,7 +72,7 @@ export namespace ALInboundStoreLane {
 export class ALInboundStoreLane {
     private readonly input: ALInboundStoreLane.Input;
     private readonly dependencies: ALInboundMessageRuntime.Dependencies;
-    private readonly readyPromise: Promise<void>;
+    private readonly readiness: ALStorageReadiness;
     private readonly admission: ALInboundMessageAdmission;
     private readonly controlAdmission: ALInboundControlAdmission;
     private readonly delivery: ALInboundAdmittedDelivery;
@@ -91,7 +92,6 @@ export class ALInboundStoreLane {
     constructor(input: ALInboundStoreLane.Input) {
         this.input = input;
         this.dependencies = toALInboundLaneDependencies(input);
-        this.readyPromise = input.stores.admissionStore.ready();
         const workPort = createALInboundLaneWorkPort(this.dependencies);
         this.admission = new ALInboundMessageAdmission({ ...this.dependencies, workPort });
         this.controlAdmission = createALInboundLaneControlAdmission(this.dependencies, workPort);
@@ -109,18 +109,24 @@ export class ALInboundStoreLane {
             clock: this.dependencies.clock,
             pageSize: AL_INBOUND_WORK_PAGE_SIZE,
             // The rotation answers readiness: work the eligibility rules defer must not report as due.
-            readNextReadyAtMs: (port) => this.workSelector.readNextReadyAtMs(port),
+            readNextReadyAtMs: (port) =>
+                this.readiness.readOpenedStore(() => this.workSelector.readNextReadyAtMs(port), undefined),
             // The rotation advances one status per probe, so an answer of its own never stands.
             readinessMemoryMs: AL_WORK_PROBE_EVERY_ROUND,
             selectReady: (port, pageSize) => this.selectInboundWork(port, pageSize),
             runClaim: (claim, batchStartedAtMs) => this.runInboundClaim(claim, batchStartedAtMs),
-            diagnostics: (event) => this.recordWorkDiagnostics(event)
+            diagnostics: (event) => this.recordWorkDiagnostics(event),
+            storageHealth: input.stores.storageHealth
+        });
+        this.readiness = new ALStorageReadiness({
+            openStores: () => input.stores.admissionStore.ready(),
+            startWork: () => this.work.ready(),
+            storageHealth: input.stores.storageHealth
         });
     }
 
-    async ready(): Promise<void> {
-        await this.readyPromise;
-        await this.work.ready();
+    async ready(): Promise<ALStorageReadiness.Outcome> {
+        return await this.readiness.ready();
     }
 
     dispose(): void {
@@ -130,10 +136,22 @@ export class ALInboundStoreLane {
         this.delivery.dispose();
     }
 
+    /** A message its store cannot persist is not admitted: it wrote nothing, and its sender's receipt retries it. */
     async admitData(
         msg: ALMessage,
         source: ALInboundMessageRuntime.Source,
         planIncomingMessage: ALInboundPlanner
+    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
+        return await this.readiness.runStoreOperation(
+            () => this.admitDataInStore(msg, source, planIncomingMessage),
+            () => Either.ofRight({ kind: 'not-admitted', reason: 'storage-unavailable' })
+        );
+    }
+
+    private async admitDataInStore(
+        msg: ALMessage,
+        source: ALInboundMessageRuntime.Source,
+        planIncomingMessage: ALInboundPlanner
     ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
         const attempt = await this.admission.attempt(msg, source, planIncomingMessage);
         if (attempt.left) {
@@ -144,6 +162,7 @@ export class ALInboundStoreLane {
             return Either.ofRight(await this.retainConflictedAdmission(result.pending));
         }
         if (result.wroteWork) {
+            this.input.stores.storageHealth?.recordRecoveryPoint(this.readNowMs());
             this.commitWork();
         }
         return Either.ofRight(result.acceptance);
@@ -157,7 +176,10 @@ export class ALInboundStoreLane {
         msg: ALMessage,
         source: ALInboundMessageRuntime.Source
     ): Promise<ALInboundControlAdmissionResult> {
-        const admitted = await this.controlAdmission.admit(msg, source);
+        const admitted = await this.readiness.runStoreOperation(
+            () => this.controlAdmission.admit(msg, source),
+            (): ALInboundControlAdmissionResult => ({ kind: 'not-handled' })
+        );
         if (admitted.kind === 'pending-control' || admitted.kind === 'committed') {
             this.commitWork();
         }
```

```diff
diff --git a/packages/shared/alm/outbound/al-outbound-message-runtime.ts b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
index 9ae307f0b..d8c4e60a3 100644
--- a/packages/shared/alm/outbound/al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
@@ -20,6 +20,7 @@ import type {
 } from '../delivery/al-delivery-lifecycle.ts';
 import type { ALStorageResetListeners } from '../open-indexed-db-admission-database.ts';
 import type { ALStorageHealth } from '../storage/al-storage-health.ts';
+import type { ALStorageReadiness } from '../storage/al-storage-readiness.ts';
 import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
 import type { ALWorkReadinessProbeCause } from '../work/al-work-readiness-memory.ts';
 import type {
@@ -337,6 +338,8 @@ export namespace ALOutboundMessageRuntime {
         readonly workQueue: QueueBoxResourceEntryRepository;
         /** The durable pair's resets; `undefined` for a pair no reset reaches (memory, PostgreSQL). */
         readonly storageResets: ALStorageResetListeners | undefined;
+        /** The health of the durable pair; `undefined` for a pair no storage failure reaches (memory, PostgreSQL). */
+        readonly storageHealth: ALStorageHealth | undefined;
         /** The memory pair a volatile admission goes to; `undefined` keeps one backend for every admission. */
         readonly volatileStores: ALVolatileOutboundRuntimeStores<TPrepared> | undefined;
         readonly effectWorkerId: string;
@@ -451,8 +454,10 @@ export class ALOutboundMessageRuntime<TPrepared> {
         });
     }
 
-    async ready(): Promise<void> {
-        await Promise.all([this.durable.ready(), this.volatile?.ready()]);
+    /** What the storage of the durable lane answered; the memory pair of the volatile lane is always ready. */
+    async ready(): Promise<ALStorageReadiness.Outcome> {
+        const [durable] = await Promise.all([this.durable.ready(), this.volatile?.ready()]);
+        return durable;
     }
 
     dispose(): void {
```

```diff
diff --git a/packages/shared/alm/inbound/al-inbound-message-runtime.ts b/packages/shared/alm/inbound/al-inbound-message-runtime.ts
index b8735442f..78081195b 100644
--- a/packages/shared/alm/inbound/al-inbound-message-runtime.ts
+++ b/packages/shared/alm/inbound/al-inbound-message-runtime.ts
@@ -10,6 +10,7 @@ import { Either } from '../../resilience/Either.ts';
 import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
 import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';
 import type { ALStorageHealth } from '../storage/al-storage-health.ts';
+import type { ALStorageReadiness } from '../storage/al-storage-readiness.ts';
 import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
 import type { ALInboundAdmissionStore, ALInboundPlanner } from './al-inbound-admission-store.ts';
 import {
@@ -78,6 +79,8 @@ export namespace ALInboundMessageRuntime {
         /** The durable pair, and the only one of a runtime without `volatileStores`. */
         readonly admissionStore: ALInboundAdmissionStore;
         readonly workQueue: QueueBoxResourceEntryRepository;
+        /** The health of the durable pair; `undefined` for a pair no storage failure reaches (memory, PostgreSQL). */
+        readonly storageHealth: ALStorageHealth | undefined;
         /** The memory pair a volatile message goes to; `undefined` keeps one backend for every message. */
         readonly volatileStores: ALVolatileInboundRuntimeStores | undefined;
         readonly effectPreparation: ALInboundEffectPreparationDependencies;
@@ -181,8 +184,10 @@ export class ALInboundMessageRuntime {
         }
     }
 
-    async ready(): Promise<void> {
-        await Promise.all([this.durable.ready(), this.volatile?.ready()]);
+    /** What the storage of the durable lane answered; the memory pair of the volatile lane is always ready. */
+    async ready(): Promise<ALStorageReadiness.Outcome> {
+        const [durable] = await Promise.all([this.durable.ready(), this.volatile?.ready()]);
+        return durable;
     }
 
     dispose(): void {
```

```diff
diff --git a/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts b/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
index 43747a3bd..4dc269701 100644
--- a/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
@@ -113,6 +113,7 @@ export function createDefaultALOutboundRuntimeResources<TPrepared>(
         admissionStore: stores.admissionStore,
         workQueue: stores.workQueue,
         storageResets: stores.storageResets,
+        storageHealth: stores.storageHealth,
         volatileStores: input.volatileStores,
         effectWorkerId: `al-outbound:${crypto.randomUUID()}`,
         clock: { nowMs },
```

```diff
diff --git a/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts b/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts
index 2b9dd8aa3..59ff88ac3 100644
--- a/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts
+++ b/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts
@@ -47,6 +47,7 @@ export function createDefaultALInboundRuntimeResources(
     return {
         admissionStore: stores.admissionStore,
         workQueue: stores.workQueue,
+        storageHealth: stores.storageHealth,
         volatileStores: input.volatileStores,
         effectWorkerId: `al-inbound:${crypto.randomUUID()}`,
         effectPreparation: {
```

The two tests that build `Resources` by hand:

```diff
diff --git a/packages/tests/shared/al-outbound-message-runtime.test.ts b/packages/tests/shared/al-outbound-message-runtime.test.ts
index eca32dc85..078897121 100644
--- a/packages/tests/shared/al-outbound-message-runtime.test.ts
+++ b/packages/tests/shared/al-outbound-message-runtime.test.ts
@@ -59,6 +59,7 @@ describe('ALOutboundMessageRuntime', () => {
             admissionStore,
             workQueue: stores.workQueue,
             storageResets: undefined,
+            storageHealth: undefined,
             volatileStores: undefined,
             dequeue: { types: new Set<string>(), resilience: createDefaultALOutboundDequeueResilience() },
             effectWorkerId: 'injected-outbound-worker',
```

```diff
diff --git a/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts b/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts
index 2ba84a02e..d8607bbce 100644
--- a/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts
+++ b/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts
@@ -572,6 +572,7 @@ function createRuntimeDependencies(stores: ALInboundRuntimeStores): ALInboundMes
     return {
         admissionStore: stores.admissionStore,
         workQueue: stores.workQueue,
+        storageHealth: undefined,
         volatileStores: undefined,
         carrier: 'ws',
         planIncomingMessage,
```

(No comment added to either runtime file carries an apostrophe; see Task 2 Step 6 on the masked `boundary.unknown`
finding in `al-inbound-message-runtime.ts`.)

- [ ] **Step 9: Format, then run the focused tests and the pins.**

```sh
git diff --name-only HEAD | grep -E '\.(ts|md)$' | xargs npx dprint fmt
git ls-files --others --exclude-standard | grep -E '\.(ts|md)$' | xargs npx dprint fmt
npx vitest run packages/tests/shared/alm/storage packages/tests/shared/alm/outbound packages/tests/shared/alm/inbound packages/tests/shared/alm/work packages/tests/shared/alm/delivery packages/tests/shared-test/alm-delivery-failure-decoding.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/alm/al-inbound-admission-preparation.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts
```

Expected (measured on `4567aa673`): `Test Files  71 passed (71)`, `Tests  895 passed (895)`; the ledger and the
operation counts pass unchanged (no pin edited: the probe gate awaits an already settled open, no IndexedDB
operation).

- [ ] **Step 10: The navigation maps.**

```diff
diff --git a/packages/shared/alm/outbound/README.md b/packages/shared/alm/outbound/README.md
index 4fb8f2499..db714c2aa 100644
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -30,7 +30,9 @@ constructor builds its `ALWorkQueuePort`, asks the admission store for the scope
 [`ALOutboundControlAdmission`](./control/al-outbound-control-admission.ts), then
 constructs dispatch admission, repair admission, repair retransmission, the
 `ALWorkHandler`, and finally the message-effect owner. Registration does not invoke
-any of them. `ready()` awaits storage readiness before the first claim. Disposing the
+any of them. `ready()` answers the durable lane's storage as a value before the first claim:
+`ALStorageUnavailable` when its pair cannot open, recorded on the pair's health, and the next call
+opens again; any other open failure throws. Disposing the
 runtime closes dispatch admission, removes its engine task, and aborts owned RTC queue
 items; the same abort signal is what the effect owner reads as "disposed". A supplied
 engine remains available to its other tasks; a runtime-owned engine stops. An
@@ -633,6 +635,16 @@ queue write conflict degrades the batch once to releasing each entry serially. A
 is different: it releases on its own settlement, independently of any batch, one claim at a
 time, with no coalescing window or timer.
 
+A storage failure is a value at the lane, never a raw throw out of it
+([`toALStorageUnavailable`](../storage/al-storage-unavailable.ts) names its cause). A send whose
+commit fails for its storage settles `storage-unavailable` with that cause, where a
+`NonRetryableException` settles `failed`; it wrote nothing. A control or a receipt its store cannot
+persist is `not-handled`, and a hand-over whose receipt row cannot end leaves the row to expire. A
+commit inside a work claim (a dequeued row, a repair) still throws into its claim, which retries, and
+a batch that fails for its storage records the failure on the pair's health instead of logging it.
+Every durable commit and every flushed batch is a recovery point, which ends a `failing` health. A
+write deadline, a corrupt row, a conflict and a code defect keep their own meanings.
+
 Readiness reads queue status and timestamps only. It never needs a transport decoder
 or reparses terminal payloads. Payload validation occurs on the claimed item before
 any message effect is returned for execution.
```

```diff
diff --git a/packages/shared/alm/inbound/README.md b/packages/shared/alm/inbound/README.md
index 255f6f03c..b9dd8e6b7 100644
--- a/packages/shared/alm/inbound/README.md
+++ b/packages/shared/alm/inbound/README.md
@@ -479,6 +479,12 @@ terminal bookkeeping can omit an execution deadline without authorizing another
 
 ## Selection, failure, and cleanup
 
+A message its durable store cannot persist is `not-admitted` with reason `storage-unavailable`, and a
+control `not-handled`: the failed transaction wrote nothing, so the sender's receipt retries it. The
+failure is recorded on the pair's health, as is a work batch that fails for its storage; every
+admission that wrote work and every flushed batch is a recovery point. `ready()` answers a pair that
+cannot open as a value, and the next call opens again.
+
 The worker holds one 16-entry observation page. It reads through QueueBox's
 `readWorkPage` port and
 [`createALInboundWorkSelector`](./read-al-inbound-work-selection.ts) skips known
```

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
index b491eeeeb..323833993 100644
--- a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
+++ b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
@@ -408,7 +408,9 @@ only, in `relayRejection`.
 
 `failure` is present once the send ended `rejected`, `failed` or `expired`, and says why, typed:
 `refused` with the carrier's `reason` (`capacity`, a session over its volatile bound, never hands
-the send over), `relay-rejected` with its `rejection`, `admission-failed`, `skipped` with its
+the send over), `relay-rejected` with its `rejection`, `admission-failed`, `storage-unavailable` with
+its `cause` (`missing`, `open-failed`, `reset-blocked`, `quota`, `closed`, `evicted` or
+`transaction-failed`: the durable store wrote nothing), `skipped` with its
 `reason`, `unroutable` with its `reason`, `attempt-failed` with its `outcome`, `receipt-exhausted`
 with its `cause` (`budget`, or `hop-refused` with `hopPeerId` and `nackReason`), or `expired`.
 `reason` keeps the prose; a receipt-less send refused late keeps `transport-accepted` and no failure.
```

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
index 8a37f7a11..555041406 100644
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -475,6 +475,10 @@ event's `data` is the event itself, with `kind` and, except for `persist`, the
   states only a change of status, never one event per send: `failing` at its
   first storage failure, `healthy` at the first recovery point after it.
 
+  A durable lane records a storage failure of its open, of a send's commit, of a
+  control, receipt or inbound admission, and of a work batch; every durable
+  commit and every flushed batch is a recovery point.
+
 ## Compatibility
 
 Adding optional fields to diagnostic payloads is compatible.
```

- [ ] **Step 11: Constraint checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit                      # exit 0
npm --workspace @ar-eye-hunter/shared-web run typecheck                # exit 0
npm --workspace @ar-eye-hunter/shared-server run typecheck             # exit 0
npx tsc -p packages/shared-test/tsconfig.json --noEmit                 # exit 0
cd apps/api-v1 && deno task check && cd -                              # exit 0 (the shared-server publish status)
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1414 test files enforced, 0 files carrying known debt (0 errors).
# PASS: no new type errors in the maintained test project
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles   # Bundle budget check passed.
npx vitest run packages/tests/rallar-black-box-headless               # Tests  4 passed (4)
```

Measured on the assembled commit `4567aa673`: `browser/rallar.ts` 230.533 → 231.032 KiB, which crosses 231 (the
idle-probe gate adds 0.130 KiB to W-A's 230.902), and the bundle check fails with it. Raise
`packages/shared-web/bundle-budgets.json` `"browser/rallar.ts"` from 231 to 232, nothing more (R-I2a-i-48: the raise
lands in the task that crosses; Task 4 no longer raises it):

```diff
-  "browser/rallar.ts": 231,
+  "browser/rallar.ts": 232,
```

Rerun: `Bundle budget check passed.` The headless agent 294.231 → 294.560 KiB (budget 295, passes). `npm run test:unit:main` (sandbox disabled) before the
commit; in the sandbox, the wide run `npx vitest run packages/tests/shared packages/tests/shared-web packages/tests/shared-test`
measured `Tests  13 failed | 9853 passed | 12 skipped (9878)`, the 13 being loopback-port suites
(`api-v1-*-recipe*.test.ts`, `local-websocket-session.test.ts`, green unsandboxed: `Tests  54 passed (54)`) and two
load-sensitive ALM cases green alone (`al-inbound-queue-work.test.ts`, `al-outbound-dequeue-work.test.ts`:
`Tests  31 passed (31)`).

- [ ] **Step 12: Commit.**

```sh
git add -A packages/shared/alm packages/shared-web/bundle-budgets.json packages/shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts packages/shared-server/rallar-system/websocket/router/rallar-server-ws-publish-result.ts packages/shared-test/rallar-bb-test packages/tests/shared/alm packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
git commit -m "Settle an unpersisted admission storage-unavailable instead of throwing

A send whose commit fails for its storage settles a new verdict,
storage-unavailable with its cause, read as state failed with the failure
storage-unavailable. A store lane's ready() answers its open as an Either and
opens again on the next call; a control, receipt or inbound message its store
cannot persist is answered not-handled or not-admitted. A work batch that
fails for its storage records failing health instead of logging, and every
durable commit and flushed batch is a recovery point. A lane whose open
failed starts no work, and the idle probe reads no storage until a send or
admission opens the store again, so the volatile lane keeps working.

rallar.ts measures 231.032 KiB (230.533), so its budget rises from 231 to
232 KiB; the headless agent measures 294.560 KiB (294.231) under 295.

D8 reuse: Either for readiness, the existing NonRetryableException catch widened, one classifier and one health per store; the backends keep their I/O shape and no IndexedDB operation is added."
```

- [ ] **Step 13: Changed-range gates (need the commit).**

```sh
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings (c86ee9519… -> HEAD).
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: no current structure-coupled test candidates
# PASS: changed-range structure-coupling review has complete individual classifications
# PASS: registry entries are complete and current
```

(Measured notes: a first version returned `Extract<…> | undefined` inline from `toALOutboundThrownVerdict` and the
gate reported `function.output-contract`; the named `ALOutboundThrownVerdict` type clears it. The coupling gate
refused `toHaveBeenCalledTimes` on `vi.fn` open/start stubs and `not.toHaveBeenCalled()` on the console spy; the cases
now record calls and log lines in arrays.) `npm run check:test-reachability`: `1716 test files, 1710 reached by CI,
6 manual`.

---

### Task 4: `onStorageUnavailable` — the channel's choice when storage cannot hold a durable send

Prototyped in `scratch-B` as commit `6833efc3d` (red then green) on W-B's stubs of the Task 1, 2 and 3 shapes; the
stubs are dropped and the task is assembled as `222c4407b` on `scratch/i2a-assemble` over the real Tasks 1–3, where
it applies with one import line reconciled (R-I2a-i-49: `ALStorageUnavailable` comes from
`packages/shared/alm/storage/al-storage-unavailable.ts`, which Task 3 already imports into `al-delivery-lifecycle.ts`).
Decision D122, proposal §3.a ("The setting", "The decision sits in the browser dispatch"), fact sheet items 1, 6.
Depends on Task 3 (the `storage-unavailable` verdict and failure arms) and Task 2 (the `storage` port the facade
tests read).

**Files**

- Modify: `packages/shared-web/browser/messages/rallar-message-contracts.ts:109-116` — new exported
  `RallarStorageUnavailablePolicy = 'refuse' | 'volatile'` before `RallarTypedMessageChannelDefinition`, which gains
  `onStorageUnavailable?: RallarStorageUnavailablePolicy` (sparse public input; absent = `refuse`).
- Modify: `packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts:5-41` — the input gains
  `onStorageUnavailable?: string`; a private `RALLAR_STORAGE_UNAVAILABLE_POLICIES`; issue `invalid-on-storage-unavailable`
  at `$.onStorageUnavailable`.
- Modify: `packages/shared-web/browser/messages/to-browser-message-send-defaults.ts:10-13` — `BrowserTypedChannelPolicy`
  carries `onStorageUnavailable` required; new `resolveBrowserStorageUnavailablePolicy(channel)` (a lane send refuses).
- Modify: `packages/shared-web/browser/messages/browser-typed-message-channels.ts:43` — the policy applies `?? 'refuse'`.
- Modify: `packages/shared-web/browser/messages/browser-rallar-message-sender.ts:12-15`, `:126`, `:168`, `:236`, `:265`
  — the four `startDelivery` call sites pass `onStorageUnavailable: resolveBrowserStorageUnavailablePolicy(channel)`.
- Modify: `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts` (266 → 331 lines) — `Delivery` gains
  `onStorageUnavailable`; `CapturedMessageAdmission` gains `durabilityDowngrade`; `toCarrierAdmission` extracted from
  `writeCapturedMessage` (`:105-117`), which emits the `durability-downgrade` settlement before the admission;
  `admitCapturedMessage` (`:180-185`) calls the new `writeChannelAdmission`; new `toCapturedAdmission`,
  `toRequestedDurability`, `toVolatileALMessage`, `toDurabilityDowngradeSettlement`; `wakeQueueBoxEngineIfQueued`
  (`:259-266`) takes `Pick<ALOutboundEnqueueResult, 'verdict'>` so the harness callers keep passing an enqueue result.
- Modify: `packages/shared/alm/delivery/al-delivery-lifecycle.ts` — `ALDurabilityAlgo` import (`:2`); settlement arm
  `durability-downgrade` before `attempts-exhausted` (`:123`); `ALDeliveryDurabilityDowngrade` before
  `ALDeliveryCarrierFallback` (`:266`); evidence field `durabilityDowngrade` after `receiptDowngrade` (`:289`); initial
  value `undefined` (`:355`).
- Modify: `packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts` — the `Extract` alias (`:23`), the switch case
  (`:46`), `toDurabilityDowngradeLifecycle` before `AL_DELIVERY_FAILURE_STATES` (`:268`).
- Modify: `packages/shared-web/browser/rallar.ts:237`, `rallar-core.ts:103`, `rallar-messages.ts:15` — export
  `RallarStorageUnavailablePolicy`; `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` three entries.
- Modify: `docs/rallar-api-reference.md:666-667` — the storage paragraph; `docs/test-structure-coupling-exceptions.md` —
  four contracts and six entries (Step 9).
- Modify: `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` — 295 → 296 (measured 295.075 KiB on
  the assembled commit, Step 10). `browser/rallar.ts` already rose to 232 in Task 3 and stays under it (231.239).
- Test (create): `packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts` (120 lines, four cases).
- Test (modify): `browser-typed-message-channels.test.ts` (`:515-540` + a new case), `compute-al-delivery-lifecycle.test.ts`
  (a new `describe` before `transport-accepted terminality`, `:722`), and the typed literals that now need the field:
  `browser-ws-peer-send.test.ts:9`, `browser-rtc-peer-send.test.ts:33`, `browser-message-handle-admission.test.ts:171`,
  `browser-message-tracked-receipt.test.ts:270`, `browser-message-carrier-gap-hand-over.test.ts:141`,
  `browser-message-fallback-controller.test.ts:114-120`.
- Not touched: the persisted-QoS validator, the envelope, the server (the setting is a browser channel field, not an
  envelope field); `resolve-al-delivery-fallback-trigger.ts` (`storage-unavailable` is no fallback trigger: both carriers
  share one database); the harness evidence projection (`black-box-rallar-delivery-ledger.ts:68`,
  `rallar-black-box-alm-result-values.ts:41`) — Task 9 adds `durabilityDowngrade` there when its scenario reads it.

**Interfaces**

- Consumes (Task 3): `ALDeliveryAdmissionVerdict` arm `{ kind: 'storage-unavailable'; cause: ALStorageUnavailable['cause']; detail: string }`,
  read by `computeALDeliveryLifecycle` as state `failed` with failure `{ kind: 'storage-unavailable'; cause }`;
  `ALStorageUnavailable` from `packages/shared/alm/storage/al-storage-unavailable.ts` (Task 1). The carriers'
  `enqueueOutboxIfAbsent` returns that verdict for a durable admission storage cannot hold and commits nothing.
- Produces:
  ```ts
  // rallar-message-contracts.ts (public, exported from rallar.ts, rallar-core.ts, rallar-messages.ts)
  export type RallarStorageUnavailablePolicy = 'refuse' | 'volatile';
  interface RallarTypedMessageChannelDefinition { readonly onStorageUnavailable?: RallarStorageUnavailablePolicy; … }
  // to-browser-message-send-defaults.ts
  interface BrowserTypedChannelPolicy { readonly onStorageUnavailable: RallarStorageUnavailablePolicy; … }
  export function resolveBrowserStorageUnavailablePolicy(channel: BrowserTypedChannelPolicy | undefined): RallarStorageUnavailablePolicy;
  // browser-rallar-message-dispatch.ts
  BrowserRallarMessageDispatch.Delivery.onStorageUnavailable: RallarStorageUnavailablePolicy   // required
  export function wakeQueueBoxEngineIfQueued(engine, result: Pick<ALOutboundEnqueueResult, 'verdict'>): void;
  // al-delivery-lifecycle.ts
  ALDeliverySettlement arm: Readonly<{ kind: 'durability-downgrade'; msgId: string; carrier: ALDeliveryCarrier; atMs: number;
                                       requested: ALDurabilityAlgo; cause: ALStorageUnavailable['cause']; }>
  export interface ALDeliveryDurabilityDowngrade { readonly requested: ALDurabilityAlgo; readonly cause: ALStorageUnavailable['cause']; }
  ALDeliveryEvidence.durabilityDowngrade: ALDeliveryDurabilityDowngrade | undefined
  ```
  Behaviour: the dispatch asks the carrier as today. On `storage-unavailable` a `refuse` channel settles that verdict
  (the handle reads `failed`, `failure: { kind: 'storage-unavailable', cause }`); a `volatile` channel admits the same
  message (same msgId, `qos.durability = { algo: 'volatile' }`) once more on the same carrier, emits the evidence-only
  `durability-downgrade` settlement before that admission's settlement, and the handle reads `admittedDurable: false`
  with `durabilityDowngrade: { requested, cause }`. The downgraded envelope is the one any fallback leg receives, so
  storage is asked once per send. A lane send has no channel and refuses.

**D8 reuse inspection.** The downgrade reuses the evidence pattern twice: its settlement is evidence-only like
`carrier-fallback` (`al-delivery-lifecycle.ts:113-122`, `compute-al-delivery-lifecycle.ts:257-266`) and its evidence
field is shaped like `receiptDowngrade` (`:261-264`, `:289`). The volatile admission is the carrier's own
`enqueueOutboxIfAbsent` with the envelope's requested durability, i.e. the runtime's existing lane routing by `persist`
(`al-outbound-message-runtime.ts:390-411`) — no lane override, no new carrier method. Reused: the sender fixture
`browser-message-sender-fixture.ts`, the validator's issue shape, `BrowserTypedChannelPolicy`. Not added: no new port,
no retry, no `Either` (the verdict already is the value), no new state, no harness field (Task 9), no envelope or
persisted-QoS field. `packages/shared/cache` and `packages/shared/resilience` are not involved.

- [ ] **Step 1: Write the failing dispatch test.** Create `packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { createBrowserMessageSenderFixture } from './browser-message-sender-fixture.ts';

const COMMAND = {
    typeId: 'relic.command.v1',
    topicId: 'room.relic.command',
    payload: { kind: 'start-expedition' },
    roomId: 'room',
    peerId: 'server'
};

describe('a durable send whose browser storage is unavailable', () => {
    it('reads failed with the storage cause on a channel that refuses, and is admitted nowhere else', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admit = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementation(async (message) => toStorageUnavailableAdmission(message));

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));

        await expect.poll(() => handle.lifecycle().state).toBe('failed');
        expect(handle.lifecycle().evidence).toMatchObject({
            failure: { kind: 'storage-unavailable', cause: 'quota' },
            durabilityDowngrade: undefined,
            admittedDurable: undefined
        });
        expect(admit).toHaveBeenCalledTimes(1);
    });

    it('admits the same message once without storage on a channel that chose volatile', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admit = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementationOnce(async (message) => toStorageUnavailableAdmission(message))
            .mockImplementation(async (message) => toVolatileAdmission(message));

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('volatile'));

        await expect.poll(() => handle.lifecycle().state).toBe('queued');
        expect(admit).toHaveBeenCalledTimes(2);
        const [durable, volatile] = admit.mock.calls.map(([message]) => message);
        expect(durable!.qos?.durability).toEqual({ algo: 'local-outbox' });
        expect(volatile).toEqual({
            ...durable,
            qos: { ...durable!.qos, durability: { algo: 'volatile' } }
        });
        expect(handle.lifecycle().evidence).toMatchObject({
            admittedDurable: false,
            durabilityDowngrade: { requested: 'local-outbox', cause: 'quota' },
            failure: undefined
        });
    });

    it('states no downgrade for a send storage held, whatever the channel chose', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admit = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('volatile'));

        await expect.poll(() => handle.lifecycle().state).toBe('queued');
        expect(admit).toHaveBeenCalledTimes(1);
        expect(handle.lifecycle().evidence).toMatchObject({
            admittedDurable: true,
            durabilityDowngrade: undefined
        });
    });

    // The downgraded envelope is what the fallback carrier receives, so storage is asked once per send.
    it('hands the downgraded message to the fallback carrier without asking storage again', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admitRtc = vi.mocked(
            fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent
        )
            .mockImplementationOnce(async (message) => toStorageUnavailableAdmission(message))
            .mockImplementation(async (message) => toUnroutableAdmission(message));
        const admitWs = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementation(async (message) => toVolatileAdmission(message));

        const handle = await fixture.sender.sendTyped(
            { ...COMMAND, peerId: 'peer-b', strategy: 'rtc-with-ws-fallback' },
            toDurableChannel('volatile')
        );

        await expect.poll(() => handle.lifecycle().state).toBe('queued');
        expect(admitRtc).toHaveBeenCalledTimes(2);
        expect(admitWs).toHaveBeenCalledTimes(1);
        expect(admitWs.mock.calls[0]![0].qos?.durability).toEqual({ algo: 'volatile' });
        expect(handle.lifecycle().evidence).toMatchObject({
            admittedDurable: false,
            durabilityDowngrade: { requested: 'local-outbox', cause: 'quota' }
        });
    });
});

function toDurableChannel(
    onStorageUnavailable: BrowserTypedChannelPolicy['onStorageUnavailable']
): BrowserTypedChannelPolicy {
    return { purpose: 'command', durability: 'local-outbox', onStorageUnavailable };
}

function toStorageUnavailableAdmission(message: ALMessage): ALOutboundEnqueueResult {
    return {
        verdict: { kind: 'storage-unavailable', cause: 'quota', detail: 'QuotaExceededError' },
        message,
        entries: [],
        trackedReceiptAlgo: 'none'
    };
}

function toVolatileAdmission(message: ALMessage): ALOutboundEnqueueResult {
    return {
        verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
        message,
        entries: [],
        trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
    };
}

function toUnroutableAdmission(message: ALMessage): ALOutboundEnqueueResult {
    return {
        verdict: { kind: 'unroutable', reason: 'no-route', detail: 'No RTC route.' },
        message,
        entries: [],
        trackedReceiptAlgo: 'none'
    };
}
```

- [ ] **Step 2: Add the channel and reducer cases.** In `packages/tests/shared-web/messages/browser-typed-message-channels.test.ts`,
      append to the refusal case (`:532-539`, after the `invalid-durability` expectation) and add one case after it:

```ts
        expect(define({ typeId: 'chat.message.v1', purpose: 'command', onStorageUnavailable: 'drop' })).toThrow(
            expect.objectContaining({
                issues: [
                    expect.objectContaining({ path: '$.onStorageUnavailable', code: 'invalid-on-storage-unavailable' })
                ]
            })
        );
    });

    it('refuses a durable send storage cannot hold unless the channel chose to send it without storage', async () => {
        webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(async (message) => ({
            verdict: message.qos?.durability?.algo === 'volatile'
                ? { kind: 'admitted' as const, durable: false, queuedAttempts: 1 }
                : { kind: 'storage-unavailable' as const, cause: 'missing' as const, detail: 'No IndexedDB.' },
            message,
            entries: [],
            trackedReceiptAlgo: 'none'
        }));
        const facade = createFacade();
        const definition = {
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            purpose: 'command',
            durability: 'local-outbox'
        } as const;
        const refusing = facade.messages.channel<ChatMessage>(definition);
        const downgrading = facade.messages.channel<ChatMessage>({ ...definition, onStorageUnavailable: 'volatile' });

        const refused = await refusing.sendWs({ text: 'refused' }, { scope: 'all', resourceId: 'storage-refused-1' });
        const downgraded = await downgrading.sendWs({ text: 'sent' }, { scope: 'all', resourceId: 'storage-volatile-1' });

        await expect.poll(() => refused.lifecycle().state).toBe('failed');
        await expect.poll(() => downgraded.lifecycle().state).toBe('queued');
        expect(refused.lifecycle().evidence.failure).toEqual({ kind: 'storage-unavailable', cause: 'missing' });
        expect(downgraded.lifecycle().evidence.durabilityDowngrade).toEqual({ requested: 'local-outbox', cause: 'missing' });
    });
```

In `packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts`, before `describe('transport-accepted terminality'` (`:722`):

```ts
describe('a durable send admitted without storage', () => {
    it('records the downgrade as evidence and leaves the state to the volatile admission', () => {
        const downgraded = computeALDeliveryLifecycle(createLifecycle('receiver'), {
            kind: 'durability-downgrade',
            msgId: MSG_ID,
            carrier: 'ws',
            atMs: AT_MS,
            requested: 'local-outbox',
            cause: 'quota'
        });
        const admitted = computeALDeliveryLifecycle(
            downgraded,
            toAdmissionSettlement(downgraded, {
                kind: 'admitted',
                durable: false,
                queuedAttempts: 1
            })
        );

        expect(downgraded.state).toBe('submitted');
        expect(downgraded.evidence.durabilityDowngrade).toEqual({
            requested: 'local-outbox',
            cause: 'quota'
        });
        expect(admitted.state).toBe('queued');
        expect(admitted.evidence).toMatchObject({
            admittedDurable: false,
            durabilityDowngrade: { requested: 'local-outbox', cause: 'quota' }
        });
    });

    it('states no downgrade before one is settled', () => {
        expect(createLifecycle('receiver').evidence.durabilityDowngrade).toBeUndefined();
    });
});
```

- [ ] **Step 3: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts packages/tests/shared-web/messages/browser-typed-message-channels.test.ts packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts
```

Expected (measured on Task 3's assembled commit `4567aa673`): `Test Files  3 failed (3)`, `Tests  7 failed | 177 passed (184)` — the four dispatch cases (no
second admission, no downgrade evidence; the refusing case fails on `durabilityDowngrade: undefined` being absent),
the refusal case (no issue), the channel case and the reducer's downgrade case. "states no downgrade before one is
settled" passes already.

- [ ] **Step 4: The channel setting, its validation and its policy.** In `rallar-message-contracts.ts` replace
      `RallarTypedMessageChannelDefinition` (`:109-116`):

```ts
/** What a durable send does when browser storage cannot hold it: fail its handle, or send it once without storage. */
export type RallarStorageUnavailablePolicy = 'refuse' | 'volatile';

export interface RallarTypedMessageChannelDefinition {
    readonly topicId?: string;
    readonly typeId: string;
    /** Fixes the send defaults (D2): at-least-once, receipted, volatile, 30 s; a send option overrides each. */
    readonly purpose: ALChannelPurpose;
    /** Absent, the purpose's `volatile`; `local-outbox`/`local-inbox` opt the channel into browser storage. */
    readonly durability?: ALDurabilityAlgo;
    /** Absent, `refuse`: a durable send storage cannot hold reads `failed`. `volatile` sends it without storage. */
    readonly onStorageUnavailable?: RallarStorageUnavailablePolicy;
}
```

`validate-rallar-typed-channel-policy.ts` becomes:

```ts
import { AL_DURABILITY_ALGOS } from '@shared/al-contracts/al-policy.ts';
import { AL_CHANNEL_PURPOSES } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

import type { RallarStorageUnavailablePolicy } from './rallar-message-contracts.ts';

/** The definition as a JavaScript caller may pass it: any string, or nothing, in each field. */
export interface RallarTypedChannelPolicyInput {
    readonly purpose?: string;
    readonly durability?: string;
    readonly onStorageUnavailable?: string;
}

const RALLAR_STORAGE_UNAVAILABLE_POLICIES: readonly RallarStorageUnavailablePolicy[] = [
    'refuse',
    'volatile'
];

/** A realtime purpose belongs to `rallar.realtime` (D15, D52). */
export function validateRallarTypedChannelPolicy(
    definition: RallarTypedChannelPolicyInput
): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    if (definition.purpose === 'realtime') {
        issues.push({
            path: '$.purpose',
            code: 'unsupported',
            message:
                'A realtime channel belongs to rallar.realtime; a typed channel is a command or a notification.'
        });
    }
    else if (!AL_CHANNEL_PURPOSES.some((candidate) => candidate === definition.purpose)) {
        issues.push({
            path: '$.purpose',
            code: 'invalid-purpose',
            message: 'Purpose must be command or notification.'
        });
    }
    if (
        definition.durability !== undefined &&
        !AL_DURABILITY_ALGOS.some((candidate) => candidate === definition.durability)
    ) {
        issues.push({
            path: '$.durability',
            code: 'invalid-durability',
            message: 'Durability must be volatile, local-outbox or local-inbox.'
        });
    }
    if (
        definition.onStorageUnavailable !== undefined &&
        !RALLAR_STORAGE_UNAVAILABLE_POLICIES.some((candidate) =>
            candidate === definition.onStorageUnavailable
        )
    ) {
        issues.push({
            path: '$.onStorageUnavailable',
            code: 'invalid-on-storage-unavailable',
            message: 'onStorageUnavailable must be refuse or volatile.'
        });
    }
    return issues;
}
```

In `to-browser-message-send-defaults.ts`, the contracts import becomes
`import type { RallarMessageSendBase, RallarStorageUnavailablePolicy } from '@shared-web/browser/messages/rallar-message-contracts.ts';`
(one name per line), the policy gains the field and the resolver goes before `toBrowserMessageSendDefaults`:

```ts
export interface BrowserTypedChannelPolicy {
    readonly purpose: ALChannelPurpose;
    readonly durability: ALDurabilityAlgo | undefined;
    readonly onStorageUnavailable: RallarStorageUnavailablePolicy;
}

/** A lane send (`messages.rtc.send`, `messages.ws.send`) names no channel, so storage it cannot use refuses it. */
export function resolveBrowserStorageUnavailablePolicy(
    channel: BrowserTypedChannelPolicy | undefined
): RallarStorageUnavailablePolicy {
    return channel?.onStorageUnavailable ?? 'refuse';
}
```

`browser-typed-message-channels.ts:43`:

```ts
const policy: BrowserTypedChannelPolicy = {
    purpose: definition.purpose,
    durability: definition.durability,
    onStorageUnavailable: definition.onStorageUnavailable ?? 'refuse'
};
```

`browser-rallar-message-sender.ts`: import `resolveBrowserStorageUnavailablePolicy` beside `toBrowserMessageSendDefaults`
(`:12-15`), and at each of the four `startDelivery({ … })` literals (`:126`, `:168`, `:236`, `:265`):

```ts
payloadIssues: payloadValidation.issues,
onStorageUnavailable: resolveBrowserStorageUnavailablePolicy(channel)
```

Export `RallarStorageUnavailablePolicy` from `rallar.ts` (after `RallarStateListener,`, `:237`), `rallar-core.ts`
(after `RallarStateListener,`, `:103`) and `rallar-messages.ts` (after `RallarRtcSendInput,`, `:15`), and add
`'RallarStorageUnavailablePolicy',` to the three `types` lists of `shared-web-public-api-snapshots.test.ts` (before
`'RallarSubscriptionScope'` for `rallar.ts` and `rallar-core.ts`, before `'RallarTypedMessageChannel'` for
`rallar-messages.ts`).

- [ ] **Step 5: The downgrade's settlement and evidence.** In `al-delivery-lifecycle.ts` import
      `ALDurabilityAlgo` beside `ALAckAlgo` (`:2`); before the `attempts-exhausted` arm (`:123`):

```ts
/** Storage could not hold a durable message and its channel chose to send it without storage: evidence, never an end. */
| Readonly<{
    kind: 'durability-downgrade';
    msgId: string;
    carrier: ALDeliveryCarrier;
    atMs: number;
    requested: ALDurabilityAlgo;
    cause: ALStorageUnavailable['cause'];
}>
```

before `ALDeliveryCarrierFallback` (`:266`):

```ts
/** The durability the send's channel asked for, and why storage could not hold it, so it was sent without storage. */
export interface ALDeliveryDurabilityDowngrade {
    readonly requested: ALDurabilityAlgo;
    readonly cause: ALStorageUnavailable['cause'];
}
```

after `receiptDowngrade` in `ALDeliveryEvidence` (`:289`), and `durabilityDowngrade: undefined,` after
`receiptDowngrade: undefined,` in `createInitialALDeliveryLifecycle` (`:355`):

```ts
/** Undefined unless storage could not hold a durable send and its channel chose to send it without storage. */
readonly durabilityDowngrade: ALDeliveryDurabilityDowngrade | undefined;
```

In `compute-al-delivery-lifecycle.ts`, after the `ALDeliveryCarrierFallbackSettlement` alias (`:23`):

```ts
type ALDeliveryDurabilityDowngradeSettlement = Extract<
    ALDeliverySettlement,
    Readonly<{ kind: 'durability-downgrade'; }>
>;
```

after `case 'carrier-fallback': return toCarrierFallbackLifecycle(previous, settlement);` (`:46-47`):

```ts
case 'durability-downgrade':
    return toDurabilityDowngradeLifecycle(previous, settlement);
```

and before `AL_DELIVERY_FAILURE_STATES` (`:268`):

```ts
function toDurabilityDowngradeLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryDurabilityDowngradeSettlement
): ALDeliveryLifecycle {
    const { requested, cause } = settlement;
    return {
        ...previous,
        evidence: { ...previous.evidence, durabilityDowngrade: { requested, cause } }
    };
}
```

A late downgrade on a terminal handle only counts as a late settlement (`toTerminalLifecycle`'s default); the dispatch
always emits it before the admission, so that path is unreachable in practice.

- [ ] **Step 6: The decision in the dispatch.** In `browser-rallar-message-dispatch.ts`: import `ALDurabilityAlgo`
      beside `ALAckAlgo` (`:4`), `ALDeliveryDurabilityDowngrade` in the lifecycle import (`:5-9`), and
      `import type { RallarStorageUnavailablePolicy } from './rallar-message-contracts.ts';` after the session-deliveries
      import (`:20`). `CapturedMessageAdmission` (`:25-29`) and `Delivery` (`:41-47`) gain:

```ts
/** Undefined unless storage could not hold the message and its channel chose to send it without storage. */
readonly durabilityDowngrade: ALDeliveryDurabilityDowngrade | undefined;
```

```ts
readonly onStorageUnavailable: RallarStorageUnavailablePolicy;
```

In `writeCapturedMessage`, replace the `CarrierAdmission` literal and the admission emission (`:104-119`) with:

```ts
const admission = this.toCarrierAdmission(delivery, result);
this.watchFallbackLeg(delivery, result, lifetime);
if (result.durabilityDowngrade !== undefined) {
    sink(
        toDurabilityDowngradeSettlement(admission, result.durabilityDowngrade, this.input.nowMs())
    );
}
sink(toCarrierAdmissionSettlement(admission, this.input.nowMs()));
```

and add the extracted method after `writeCapturedMessage`:

```ts
private toCarrierAdmission(
    delivery: BrowserRallarMessageDispatch.Delivery,
    result: CapturedMessageAdmission
): CarrierAdmission {
    return {
        msgId: delivery.message.id.msgId,
        carrier: delivery.carrier,
        verdict: result.verdict,
        trackedReceiptAlgo: result.trackedReceiptAlgo,
        fallback: delivery.canFallback
            ? computeFallbackDisposition(
                result.verdict,
                result.message.constraints?.expiresAtMs,
                this.input.nowMs()
            )
            : 'stop'
    };
}
```

In `admitCapturedMessage`, `const { message, context } = delivery;` becomes `const { message } = delivery;` and the
`try` returns `await writeChannelAdmission(delivery);` (`:181`). Replace `toUnadmittedAdmission` (`:189-191`) with it and
the new functions:

```ts
function toUnadmittedAdmission(
    message: ALMessage,
    verdict: ALDeliveryAdmissionVerdict
): CapturedMessageAdmission {
    return { message, verdict, trackedReceiptAlgo: 'none', durabilityDowngrade: undefined };
}

/**
 * The carrier's admission of the send. When storage cannot hold it and its channel chose `volatile`, the same
 * message is admitted once more without storage: the durable admission committed nothing.
 */
async function writeChannelAdmission(
    delivery: BrowserRallarMessageDispatch.Delivery
): Promise<CapturedMessageAdmission> {
    const admitted = await writeCarrierOutboxAdmission(
        delivery.context,
        delivery,
        delivery.message
    );
    if (
        admitted.verdict.kind !== 'storage-unavailable' ||
        delivery.onStorageUnavailable === 'refuse'
    ) {
        return toCapturedAdmission(admitted, undefined);
    }
    const downgrade: ALDeliveryDurabilityDowngrade = {
        requested: toRequestedDurability(delivery.message),
        cause: admitted.verdict.cause
    };
    const volatileMessage = toVolatileALMessage(delivery.message);
    return toCapturedAdmission(
        await writeCarrierOutboxAdmission(delivery.context, delivery, volatileMessage),
        downgrade
    );
}

function toCapturedAdmission(
    result: ALOutboundEnqueueResult,
    durabilityDowngrade: ALDeliveryDurabilityDowngrade | undefined
): CapturedMessageAdmission {
    return {
        message: result.message,
        verdict: result.verdict,
        trackedReceiptAlgo: result.trackedReceiptAlgo,
        durabilityDowngrade
    };
}

function toRequestedDurability(message: ALMessage): ALDurabilityAlgo {
    return message.qos?.durability?.algo ?? 'volatile';
}

function toVolatileALMessage(message: ALMessage): ALMessage {
    return { ...message, qos: { ...message.qos, durability: { algo: 'volatile' } } };
}
```

before `toCarrierAdmissionEndSettlement` (`:238`):

```ts
function toDurabilityDowngradeSettlement(
    admission: CarrierAdmission,
    downgrade: ALDeliveryDurabilityDowngrade,
    atMs: number
): ALDeliverySettlement {
    return {
        kind: 'durability-downgrade',
        msgId: admission.msgId,
        carrier: admission.carrier,
        atMs,
        ...downgrade
    };
}
```

and `wakeQueueBoxEngineIfQueued`'s second parameter (`:261`) becomes `result: Pick<ALOutboundEnqueueResult, 'verdict'>`.

- [ ] **Step 7: The typed literals that now need the field.** `browser-ws-peer-send.test.ts:9` and
      `browser-rtc-peer-send.test.ts:33`:
      `const COMMAND_CHANNEL = { purpose: 'command', durability: undefined, onStorageUnavailable: 'refuse' } as const;`;
      `browser-message-handle-admission.test.ts:171`: `{ purpose: 'command', durability: undefined, onStorageUnavailable: 'refuse' }`;
      the three `dispatch.send({ … payloadIssues: [] })` literals (`browser-message-tracked-receipt.test.ts:270`,
      `browser-message-carrier-gap-hand-over.test.ts:141`, `browser-message-fallback-controller.test.ts:114-120`) add
      `onStorageUnavailable: 'refuse'`.

- [ ] **Step 8: The API reference.** In `docs/rallar-api-reference.md` replace `storage. A WS send with scope` (`:667`) so
      the paragraph reads:

```md
`durability: 'local-outbox'` or `'local-inbox'` opts the channel into browser
storage. When storage cannot hold a durable send, the handle reads `failed`
with `failure: { kind: 'storage-unavailable', cause }`; a channel defined with
`onStorageUnavailable: 'volatile'` sends it once without storage instead, and
its evidence names `durabilityDowngrade: { requested, cause }` beside
`admittedDurable: false`. A lane send names no channel, so it always refuses.
A WS send with scope `world` or `all`, and a `best-effort` send, ask
for no receipt unless the send states `ack`.
```

- [ ] **Step 9: Format, run green, register the counted interactions.**

```sh
npx dprint fmt packages/shared-web/browser/messages/rallar-message-contracts.ts packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts packages/shared-web/browser/messages/to-browser-message-send-defaults.ts packages/shared-web/browser/messages/browser-typed-message-channels.ts packages/shared-web/browser/messages/browser-rallar-message-sender.ts packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts packages/shared/alm/delivery/al-delivery-lifecycle.ts packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts packages/shared-web/browser/rallar.ts packages/shared-web/browser/rallar-core.ts packages/shared-web/browser/rallar-messages.ts packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts packages/tests/shared-web/messages/browser-typed-message-channels.test.ts packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts docs/rallar-api-reference.md
npx vitest run packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts packages/tests/shared-web/messages/browser-typed-message-channels.test.ts packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Expected (measured): `Test Files  3 passed (3)`, `Tests  184 passed (184)` for the first three, and `Tests  17 passed (17)`
for the two surface tests. The four dispatch cases' carrier-call counts are `mock-invocation-count-or-order` coupling
candidates; each is the interaction under test, so add four contracts (`browser-storage-unavailable-refuse-admits-once`,
`browser-storage-unavailable-volatile-admits-once-more`, `browser-storage-held-send-admits-once`,
`browser-storage-downgrade-reaches-fallback-once`; `interactionKind: count`, owned port "Carrier outbound admission port
(enqueueOutboxIfAbsent)") and six entries (ids `test-structure-coupling-19eea405be1b7baf`, `-745e430b2f546159`,
`-e0d383cef2b11ac5`, `-63953d25d3f8ee3b`, `-a0017b3df5d28f28`, `-a56fc05857187604`; `disposition: durable-boundary`,
`boundary: interaction`, each `semanticCoverage` equal to its contract's) to `docs/test-structure-coupling-exceptions.md`.
One contract per executable assertion: the checker refuses an entry whose `semanticCoverage` differs from its
contract's. The ids are the checker's; re-derive them with Step 11's command if the test text changes. The four
contracts go at the end of `contracts`, the six entries at the end of `entries`:

```diff
diff --git a/docs/test-structure-coupling-exceptions.md b/docs/test-structure-coupling-exceptions.md
--- a/docs/test-structure-coupling-exceptions.md
+++ b/docs/test-structure-coupling-exceptions.md
@@ -3418,6 +3418,66 @@ moved or changed test.
         "requiredConstraint": "The runtime falls back to REST only when the WS path returned no delivery (no server id known), never after a WS attempt.",
         "failureRationale": "The WS outcome reads the same whether or not a REST copy was also sent, and a REST copy after a WS command could apply the command twice on the server; the absent REST call is the only witness."
       }
+    },
+    {
+      "id": "browser-storage-unavailable-refuse-admits-once",
+      "domain": "Browser durable send storage cannot hold",
+      "owner": "Rallar browser maintainers",
+      "summary": "A refusing channel makes one durable admission and none without storage. Executable assertion: “reads failed with the storage cause on a channel that refuses, and is admitted nowhere else”.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#reads failed with the storage cause on a channel that refuses, and is admitted nowhere else",
+      "coverageRelation": "The test replaces the carrier outbound admission port with one that answers storage-unavailable or admits, sends through the real sender and dispatch, and reads the handle and the envelopes the port received.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Carrier outbound admission port (enqueueOutboxIfAbsent)",
+        "observableEffect": "One admission attempt for the send.",
+        "requiredConstraint": "A refusing channel never admits the message a second time.",
+        "failureRationale": "A second admission would send a message the application chose to fail."
+      }
+    },
+    {
+      "id": "browser-storage-unavailable-volatile-admits-once-more",
+      "domain": "Browser durable send storage cannot hold",
+      "owner": "Rallar browser maintainers",
+      "summary": "A volatile channel adds exactly one admission of the same message without storage to the failed durable one. Executable assertion: “admits the same message once without storage on a channel that chose volatile”.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#admits the same message once without storage on a channel that chose volatile",
+      "coverageRelation": "The test replaces the carrier outbound admission port with one that answers storage-unavailable or admits, sends through the real sender and dispatch, and reads the handle and the envelopes the port received.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Carrier outbound admission port (enqueueOutboxIfAbsent)",
+        "observableEffect": "Two admissions: the durable attempt, then one of the same msgId without storage.",
+        "requiredConstraint": "The admission without storage happens once and only after the durable admission committed nothing.",
+        "failureRationale": "A repeated admission without storage sends one message twice."
+      }
+    },
+    {
+      "id": "browser-storage-held-send-admits-once",
+      "domain": "Browser durable send storage cannot hold",
+      "owner": "Rallar browser maintainers",
+      "summary": "A durable send storage holds is admitted once even on a channel that chose volatile. Executable assertion: “states no downgrade for a send storage held, whatever the channel chose”.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#states no downgrade for a send storage held, whatever the channel chose",
+      "coverageRelation": "The test replaces the carrier outbound admission port with one that answers storage-unavailable or admits, sends through the real sender and dispatch, and reads the handle and the envelopes the port received.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Carrier outbound admission port (enqueueOutboxIfAbsent)",
+        "observableEffect": "One admission for a send storage held.",
+        "requiredConstraint": "Choosing volatile never adds an admission while storage holds the send.",
+        "failureRationale": "An extra admission would send a held message twice."
+      }
+    },
+    {
+      "id": "browser-storage-downgrade-reaches-fallback-once",
+      "domain": "Browser durable send storage cannot hold",
+      "owner": "Rallar browser maintainers",
+      "summary": "A fallback carrier receives the already-downgraded envelope, so storage is asked once per send. Executable assertion: “hands the downgraded message to the fallback carrier without asking storage again”.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#hands the downgraded message to the fallback carrier without asking storage again",
+      "coverageRelation": "The test replaces the carrier outbound admission port with one that answers storage-unavailable or admits, sends through the real sender and dispatch, and reads the handle and the envelopes the port received.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Carrier outbound admission port (enqueueOutboxIfAbsent)",
+        "observableEffect": "The first carrier sees the durable attempt and one admission without storage; the fallback carrier one volatile admission.",
+        "requiredConstraint": "The downgrade happens once per send, whichever carrier ends up holding it.",
+        "failureRationale": "Asking storage again on the fallback leg would repeat the durable failure and could downgrade twice."
+      }
     }
   ],
   "entries": [
@@ -7875,6 +7935,72 @@ moved or changed test.
       "owner": "Relic Hunters maintainers",
       "rationale": "`expect(deps.refreshRooms).toHaveBeenCalledTimes(1);` pins the room creation to a generated unique name and one rooms refresh; the hydrated room reads the same either way.",
       "semanticCoverage": "apps/relic-hunters-v1/tests/relic-hunters-runtime.test.ts#hydrates the created room with its current snapshot and refreshed room state"
+    },
+    {
+      "id": "test-structure-coupling-19eea405be1b7baf",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-unavailable-refuse-admits-once",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "A refusing channel makes the one durable admission and no second one.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#reads failed with the storage cause on a channel that refuses, and is admitted nowhere else"
+    },
+    {
+      "id": "test-structure-coupling-745e430b2f546159",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-unavailable-volatile-admits-once-more",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "A volatile channel adds exactly one admission without storage.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#admits the same message once without storage on a channel that chose volatile"
+    },
+    {
+      "id": "test-structure-coupling-e0d383cef2b11ac5",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-held-send-admits-once",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "A send storage held is admitted once.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#states no downgrade for a send storage held, whatever the channel chose"
+    },
+    {
+      "id": "test-structure-coupling-63953d25d3f8ee3b",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-downgrade-reaches-fallback-once",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "The first carrier sees the durable attempt and the one admission without storage.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#hands the downgraded message to the fallback carrier without asking storage again"
+    },
+    {
+      "id": "test-structure-coupling-a0017b3df5d28f28",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-downgrade-reaches-fallback-once",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "The fallback carrier admits the downgraded message once.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#hands the downgraded message to the fallback carrier without asking storage again"
+    },
+    {
+      "id": "test-structure-coupling-a56fc05857187604",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-downgrade-reaches-fallback-once",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "The envelope the fallback carrier receives is already volatile.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#hands the downgraded message to the fallback carrier without asking storage again"
     }
   ]
 }
```

- [ ] **Step 10: Constraint checks and bundles.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit                        # exit 0
npm --workspace @ar-eye-hunter/shared-web run typecheck                  # exit 0
npm --workspace @ar-eye-hunter/shared-server run typecheck                # exit 0
(cd apps/api-v1 && deno task check)                                      # exit 0
node scripts/check-tests-typecheck.mjs
# PASS: no new type errors in the maintained test project
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles     # Bundle budget check passed.
npx vitest run packages/tests/rallar-black-box-headless
```

Measured on the assembled commit `222c4407b` (brotli q11, the gates' method): `rallar.ts` 231.032 → 231.239 KiB
against 232 (Task 3 raised it; passes); the headless agent 294.560 → 295.075 KiB, which fails
`headless-bundle-boundary.test.ts` against 295. Raise it to the next whole KiB, nothing more (R-I2a-i-48):

```json
{
  "brotliBudgetKiB": 296
}
```

(`packages/tests/rallar-black-box-headless/headless-bundle-budget.json`; rerun: `Tests  4 passed (4)`.) Then
`npx vitest run --project unit` once (sandbox disabled): measured 1330 files / 12401 tests green on the prototype's
Task 5 head.

- [ ] **Step 11: Commit, then the changed-range gates.**

```sh
git add packages/tests/rallar-black-box-headless/headless-bundle-budget.json packages/shared-web/browser/messages packages/shared-web/browser/rallar.ts packages/shared-web/browser/rallar-core.ts packages/shared-web/browser/rallar-messages.ts packages/shared/alm/delivery packages/tests/shared-web/messages packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts docs/rallar-api-reference.md docs/test-structure-coupling-exceptions.md
git commit -m "Let a typed channel choose what a durable send does when storage cannot hold it

A typed channel definition gains onStorageUnavailable: 'refuse' | 'volatile',
absent meaning refuse, validated with the issue invalid-on-storage-unavailable
and carried on the channel policy. The browser dispatch holds the decision: on a
storage-unavailable admission a refusing channel settles the handle with that
verdict (failed, cause in evidence); a volatile channel admits the same message
once more without storage and the handle's evidence names durabilityDowngrade
{ requested, cause } beside admittedDurable false. The downgraded envelope is the
one a fallback carrier receives, so storage is asked once per send.

The headless agent measures 295.075 KiB (294.560 before), so its budget
rises from 295 to 296 KiB; rallar.ts measures 231.239 KiB under 232.

D8 reuse: the downgrade is evidence-only like carrier-fallback and shaped like receiptDowngrade; the existing sender fixture, validator and channel policy are widened, no new port, cache or retry."
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: all 7 current structure-coupling candidates are individually classified
# PASS: changed-range structure-coupling review has complete individual classifications
# PASS: registry entries are complete and current
```

(Measured on the prototype against the stub head and the base: both PASS; the seventh candidate is the existing,
registered `test-structure-coupling-a11dc68fc52eaed6` in the touched channel test.)

---

### Task 5: Storage availability per connect, the end of the silent memory fallback, and the persistence request

Prototyped in `scratch-B` as commit `93a487b83` on its Task 4 (`6833efc3d`) and a stub of the lanes' storage boundary
(`11fad7b97`), red then green; the stub is dropped and the task is assembled as `b67e43022` on `scratch/i2a-assemble`
over the real Tasks 1–4, with the import paths reconciled (R-I2a-i-49), the configure and middleware hunks written
against Task 2's `storage` port, and `persisted()` read before `persist()` (R-I2a-i-42). Decisions D122, D127;
proposal §3.a ("Availability", "Persistence"), §1.1; fact sheet items 1, 2, 8, 12. Depends on Task 3 (a durable lane
whose store storage cannot open leaves the volatile lane running, R-I2a-i-50), Task 4 (the dispatch decision) and
Task 2 (the `storage` port and the `persist` arm).

**Files**

- Create: `packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts` (93 lines) — `ALStorageAvailability`,
  `BrowserStoragePersistRequest`, the class `BrowserALStorageAvailability` (an `ObservableLatestValue` of the
  availability, `getDurableLaneSkip()`, `requestPersistentStorage()`), `toInitialALStorageAvailability`,
  `computeALStorageAvailability`, `toBrowserStoragePersistRequest`.
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts` (187 → 188 lines) — the memory branches
  of `createBrowserALInboundRuntimeStores` (`:102-114`) and `createBrowserALOutboundRuntimeStores` (`:116-125`) and the
  memory backends of `configureBrowserALRuntimeStores` (`:150-169`) go; `configureBrowserALRuntimeStores` returns the
  connect's `BrowserALStorageAvailability`. Imports of `createInMemoryALAdmissionState`, `InMemoryAdmissionBackend`,
  `createDefaultInMemoryALInbound/OutboundRuntimeStores` go (`:2`, `:7-8`).
- Modify: `packages/shared-web/browser/rallar-connection-facade.ts:38-46` — `RallarBrowserMiddleware.storageAvailability`.
- Modify: `packages/shared-web/browser/connection/initialise-browser-middleware.ts:209`, `:235-239`, `:273-283` —
  `initialiseBrowserRuntimeStores` returns the availability and `initialiseMiddleware` puts it on the middleware.
- Modify: `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts` — `writeChannelAdmission` (Task 4)
  calls the new `writeStorageAdmission` (skip while missing; record each verdict); new `recordStorageVerdict`.
- Modify: `docs/rallar-api-reference.md` (the paragraph Task 4 wrote) and `docs/test-structure-coupling-exceptions.md`
  (seven contracts, nine entries).
- Test (create): `packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts` (186 lines; runs without
  fake-indexeddb, as a browser without IndexedDB does).
- Test (modify): `browser-message-storage-unavailable.test.ts` (a second `describe`, five cases), the fixture hooks
  `packages/tests/shared-web/api-middleware-test-double.ts` (a `storageAvailability` double) and
  `browser-message-sender-fixture.ts` (a third parameter, the middleware).
- Test (the fallback's dependants): delete `packages/tests/shared-web/messages/acknowledgement-under-transport-hold.test.ts`
  (the memory twin; its five case groups are a subset of `acknowledgement-under-transport-hold-indexeddb.test.ts`);
  `packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts` and
  `packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts` move onto `setup-browser-indexeddb.ts`.
- Not touched: `packages/shared/alm/al-runtime-stores.ts` (the server and the in-memory default runtime keep their memory
  factories; `isIndexedDbALRuntimeStoreSupported` stays the one support check), `browser-al-runtime-cleanup.ts:206`
  (cleanup with no IndexedDB stays a silent zero: there is nothing to delete), the transaction ledger and operation-count
  pins (no IndexedDB operation is added; `persist()` is not IndexedDB).

**Interfaces**

- Consumes (Task 3): a durable lane whose store storage cannot open does not reject `runtime.ready()` (it resolves
  the lane's `Left`), runs no work bootstrap and probes no storage on the idle engine (`readOpenedStore`, R-I2a-i-50),
  so the volatile lane keeps admitting and delivering; without it every volatile send in a browser with no IndexedDB
  fails (`create-browser-web-socket-queue-box.test.ts`'s two volatile cases went red on the prototype until W-B
  stubbed the same behaviour). Task 1's opener raises `ALStorageUnavailableError` with cause `missing` and detail
  `IndexedDB is not available in this environment`, which `toALStorageUnavailable` reads back.
  (Task 4): `writeChannelAdmission`, `toRequestedDurability`. (Task 2): `RallarDiagnosticsPorts.storage: ALStorageEventSink`
  and the arm `{ kind: 'persist'; outcome: ALStoragePersistOutcome }` (`'granted' | 'denied' | 'unsupported'`).
  `ObservableLatestValue` from `packages/shared/cache/ObservableLatestValue.ts`.
- Produces:
  ```ts
  // browser-al-storage-availability.ts
  export type ALStorageAvailability =
      | Readonly<{ kind: 'available'; }>
      | Readonly<{ kind: 'unavailable'; reason: ALStorageUnavailable; }>;
  export type BrowserStoragePersistRequest = (() => Promise<boolean>) | undefined;
  export namespace BrowserALStorageAvailability {
      export interface Input {
          readonly initial: ALStorageAvailability;
          readonly requestPersist: BrowserStoragePersistRequest;
          readonly storage: (event: ALStorageEvent) => void;
      }
  }
  export class BrowserALStorageAvailability {
      readonly availability: ObservableLatestValue<ALStorageAvailability>;
      constructor(input: BrowserALStorageAvailability.Input);
      getDurableLaneSkip(): ALStorageUnavailable | undefined;   // the reason while `missing`, else undefined
      requestPersistentStorage(): void;                           // once per instance; never awaited
  }
  export function toInitialALStorageAvailability(indexedDbSupported: boolean): ALStorageAvailability;
  export function computeALStorageAvailability(previous: ALStorageAvailability, verdict: ALDeliveryAdmissionVerdict): ALStorageAvailability;
  /** Reads `persisted()` first: an origin that already persists answers `true` without `persist()` being asked. */
  export function toBrowserStoragePersistRequest(
      storageManager: Readonly<{ persist?: () => Promise<boolean>; persisted?: () => Promise<boolean>; }> | undefined
  ): BrowserStoragePersistRequest;
  // browser-al-runtime-stores.ts
  export function configureBrowserALRuntimeStores(sessionId: string, input: ConfigureBrowserALRuntimeStoresInput): BrowserALStorageAvailability;
  // rallar-connection-facade.ts
  RallarBrowserMiddleware.storageAvailability: BrowserALStorageAvailability
  ```
  Behaviour: each connect decides once: `typeof indexedDB === 'undefined'` → `unavailable { cause: 'missing' }`, else
  `available`. The durable pairs are always IndexedDB. The dispatch skips the carrier for a durable message (requested
  durability not `volatile`) only while the reason is `missing`, producing the verdict
  `{ kind: 'storage-unavailable', cause: 'missing', detail }` that Task 4's decision then reads. Every admission that
  reaches a carrier re-decides availability (`storage-unavailable` → unavailable with its cause; a durable `admitted` →
  available; anything else keeps it), so `quota`, `closed` and the rest are tried by the next durable send. The first
  durable `admitted` verdict of the connect calls `requestPersistentStorage()` (R-I2a-i-42): it reads
  `navigator.storage.persisted()` and, unless the origin already persists, calls `navigator.storage.persist()`, once
  per connect and awaited by neither the send nor the dispatch; the outcome (`true` → `granted`, `false` or a
  rejection → `denied`, no `persist` → `unsupported`) is emitted later as `storage({ kind: 'persist', outcome })`. A
  denial is asked again by the next connect; a granted origin is never prompted again.

**D8 reuse inspection.** The availability is held in `packages/shared/cache`'s `ObservableLatestValue` (the frame's
decided holder; its change listeners are where a later observer subscribes, nothing listens in I2a-i). The durable
pairs reuse `createDefaultIndexedDbALInbound/OutboundRuntimeStores` unchanged; the one support check stays
`isIndexedDbALRuntimeStoreSupported` (`al-runtime-stores.ts:290`); the decision is a pure `computeXxx` beside its owner,
and the dispatch already held the verdict. Not added: no raw `Map` or flag outside the class (the one boolean
`persistRequested` is the request's own once-guard), no timer, no retry loop (a retry is the next send), no new
IndexedDB operation (pins unchanged: measured `test:unit:main` green with the ledger and operation-count suites), no
probe open at connect (a probe would cost an operation on every connect and duplicate the lane's own open), no new
diagnostics port (the `persist` arm is Task 2's). The middleware test double and the sender fixture are widened rather
than a second harness written.

- [ ] **Step 1: Write the failing tests.** Create `packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts`:

```ts
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    configureBrowserALRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import {
    BrowserALStorageAvailability,
    computeALStorageAvailability,
    toBrowserStoragePersistRequest,
    type ALStorageAvailability,
    type BrowserStoragePersistRequest
} from '@shared-web/browser/al-runtime/browser-al-storage-availability.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { toALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

const AVAILABLE: ALStorageAvailability = { kind: 'available' };
const QUOTA: ALStorageAvailability = {
    kind: 'unavailable',
    reason: { cause: 'quota', detail: 'QuotaExceededError' }
};
const MISSING: ALStorageAvailability = {
    kind: 'unavailable',
    reason: { cause: 'missing', detail: 'No IndexedDB.' }
};

describe('the storage availability a connect decides', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // This file runs without fake-indexeddb, as a browser without IndexedDB does.
    it('reads missing without IndexedDB and gives the durable pairs no memory store to fall back on', async () => {
        const sessionId = `no-indexeddb-${crypto.randomUUID()}`;

        const storage = configureBrowserALRuntimeStores(sessionId, {
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
        });
        const outbound = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
        const inbound = resolveBrowserSessionALInboundRuntimeStores(sessionId);

        expect(storage.availability.get()).toEqual({
            kind: 'unavailable',
            reason: { cause: 'missing', detail: expect.any(String) }
        });
        expect(outbound.workQueue).not.toBeInstanceOf(InMemoryQueueBox);
        expect(inbound.workQueue).not.toBeInstanceOf(InMemoryQueueBox);
        await expect(outbound.admissionStore.ready()).rejects.toSatisfy((error: Error) =>
            toALStorageUnavailable(error)?.cause === 'missing'
        );
    });

    it('reads available where IndexedDB exists', () => {
        vi.stubGlobal('indexedDB', fakeIndexedDB);

        const storage = configureBrowserALRuntimeStores(`indexeddb-${crypto.randomUUID()}`, {
            diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
        });

        expect(storage.availability.get()).toEqual(AVAILABLE);
    });
});

describe('a durable admission re-decides availability', () => {
    it.each<{
        label: string;
        previous: ALStorageAvailability;
        verdict: ALDeliveryAdmissionVerdict;
        next: ALStorageAvailability;
    }>([
        {
            label: 'a storage failure makes it unavailable with its cause',
            previous: AVAILABLE,
            verdict: { kind: 'storage-unavailable', cause: 'quota', detail: 'QuotaExceededError' },
            next: QUOTA
        },
        {
            label: 'a durable admission makes it available again',
            previous: QUOTA,
            verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 },
            next: AVAILABLE
        },
        {
            label: 'a volatile admission says nothing about storage',
            previous: QUOTA,
            verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
            next: QUOTA
        },
        {
            label: 'a refusal says nothing about storage',
            previous: QUOTA,
            verdict: { kind: 'refused', reason: 'oversized', detail: 'Too large.' },
            next: QUOTA
        }
    ])('$label', ({ previous, verdict, next }) => {
        expect(computeALStorageAvailability(previous, verdict)).toEqual(next);
    });

    it('skips the durable lane only while storage is missing; any other cause is tried again', () => {
        const missing = createStorageAvailability(MISSING, undefined, () => {});
        const quota = createStorageAvailability(QUOTA, undefined, () => {});
        const available = createStorageAvailability(AVAILABLE, undefined, () => {});

        expect(missing.getDurableLaneSkip()).toEqual({ cause: 'missing', detail: 'No IndexedDB.' });
        expect(quota.getDurableLaneSkip()).toBeUndefined();
        expect(available.getDurableLaneSkip()).toBeUndefined();
    });
});

describe('the request for persistent storage', () => {
    it('asks once and reports the outcome as a persist event after the call returns', async () => {
        const requestPersist = vi.fn(async () => true);
        const events: ALStorageEvent[] = [];
        const storage = createStorageAvailability(
            AVAILABLE,
            requestPersist,
            (event) => events.push(event)
        );

        storage.requestPersistentStorage();
        storage.requestPersistentStorage();

        expect(requestPersist).toHaveBeenCalledTimes(1);
        expect(events).toEqual([]);
        await vi.waitFor(() => expect(events).toEqual([{ kind: 'persist', outcome: 'granted' }]));
    });

    it.each<{ label: string; requestPersist: BrowserStoragePersistRequest; outcome: string; }>([
        { label: 'a refusal reads denied', requestPersist: async () => false, outcome: 'denied' },
        {
            label: 'a rejected request reads denied',
            requestPersist: async () => {
                throw new Error('persist failed');
            },
            outcome: 'denied'
        },
        {
            label: 'a browser without the API reads unsupported',
            requestPersist: undefined,
            outcome: 'unsupported'
        }
    ])('$label', async ({ requestPersist, outcome }) => {
        const events: ALStorageEvent[] = [];
        const storage = createStorageAvailability(
            AVAILABLE,
            requestPersist,
            (event) => events.push(event)
        );

        storage.requestPersistentStorage();

        await vi.waitFor(() => expect(events).toEqual([{ kind: 'persist', outcome }]));
    });

    // A browser that already persists this origin reads granted without being asked again.
    it('reads an earlier grant without asking again', async () => {
        const calls: string[] = [];
        const requestPersist = toBrowserStoragePersistRequest({
            persisted: async () => {
                calls.push('persisted');
                return true;
            },
            persist: async () => {
                calls.push('persist');
                return true;
            }
        });

        await expect(requestPersist?.()).resolves.toBe(true);
        expect(calls).toEqual(['persisted']);
    });

    it('asks after reading no earlier grant', async () => {
        const calls: string[] = [];
        const requestPersist = toBrowserStoragePersistRequest({
            persisted: async () => {
                calls.push('persisted');
                return false;
            },
            persist: async () => {
                calls.push('persist');
                return false;
            }
        });

        await expect(requestPersist?.()).resolves.toBe(false);
        expect(calls).toEqual(['persisted', 'persist']);
    });

    it('asks through the browser storage manager where it has persist', async () => {
        const persist = vi.fn(async () => true);

        const requestPersist = toBrowserStoragePersistRequest({ persist });

        expect(toBrowserStoragePersistRequest(undefined)).toBeUndefined();
        expect(toBrowserStoragePersistRequest({})).toBeUndefined();
        await expect(requestPersist?.()).resolves.toBe(true);
        expect(persist).toHaveBeenCalledTimes(1);
    });
});

function createStorageAvailability(
    initial: ALStorageAvailability,
    requestPersist: BrowserStoragePersistRequest,
    storage: (event: ALStorageEvent) => void
): BrowserALStorageAvailability {
    return new BrowserALStorageAvailability({ initial, requestPersist, storage });
}
```

In `packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts` add the imports
`BrowserALStorageAvailability`, `type ALStorageAvailability` (from `@shared-web/browser/al-runtime/browser-al-storage-availability.ts`),
`type ALStorageEvent` (from `@shared/alm/storage/al-storage-event.ts`) and `createDefaultApiMiddlewareTestDouble` (from
`../api-middleware-test-double.ts`), and after the first `describe` (the helper `toLaneAdmission` goes before `toUnroutableAdmission`):

```ts
describe('the connect\'s storage availability at the dispatch', () => {
    it('skips the durable lane while storage is missing, so a refusing channel fails without reaching the carrier', async () => {
        const fixture = createStorageFixture(MISSING);
        const admit = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));

        await expect.poll(() => handle.lifecycle().state).toBe('failed');
        expect(handle.lifecycle().evidence.failure).toEqual({
            kind: 'storage-unavailable',
            cause: 'missing'
        });
        expect(admit).not.toHaveBeenCalled();
    });

    it('sends a missing-storage message on a volatile channel with one carrier admission, without storage', async () => {
        const fixture = createStorageFixture(MISSING);
        const admit = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementation(async (message) => toVolatileAdmission(message));

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('volatile'));

        await expect.poll(() => handle.lifecycle().state).toBe('queued');
        expect(admit).toHaveBeenCalledTimes(1);
        expect(admit.mock.calls[0]![0].qos?.durability).toEqual({ algo: 'volatile' });
        expect(handle.lifecycle().evidence.durabilityDowngrade).toEqual({
            requested: 'local-outbox',
            cause: 'missing'
        });
    });

    it('never skips a volatile send', async () => {
        const fixture = createStorageFixture(MISSING);
        const admit = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendWs(COMMAND, {
            ...toDurableChannel('refuse'),
            durability: 'volatile'
        });

        expect(admit).toHaveBeenCalledTimes(1);
    });

    it('tries the durable lane again after a quota failure and reads available once storage holds a send', async () => {
        const fixture = createStorageFixture(AVAILABLE);
        const admit = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementationOnce(async (message) => toStorageUnavailableAdmission(message));
        const storage = fixture.middleware.middleware.storageAvailability;

        const refused = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));
        await expect.poll(() => refused.lifecycle().state).toBe('failed');
        expect(storage.availability.get()).toEqual({
            kind: 'unavailable',
            reason: { cause: 'quota', detail: 'QuotaExceededError' }
        });

        const held = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));
        await expect.poll(() => held.lifecycle().state).toBe('queued');
        expect(admit).toHaveBeenCalledTimes(2);
        expect(storage.availability.get()).toEqual(AVAILABLE);
    });

    it('asks for persistent storage on the first durable admission only', async () => {
        const requestPersist = vi.fn(async () => true);
        const events: ALStorageEvent[] = [];
        const fixture = createStorageFixture(
            AVAILABLE,
            requestPersist,
            (event) => events.push(event)
        );
        vi.mocked(fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .mockImplementation(async (message) => toLaneAdmission(message));

        const volatile = await fixture.sender.sendWs(COMMAND, {
            ...toDurableChannel('refuse'),
            durability: 'volatile'
        });
        await expect.poll(() => volatile.lifecycle().state).toBe('queued');
        expect(requestPersist).not.toHaveBeenCalled();

        const first = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));
        const second = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));
        await expect.poll(() => [first.lifecycle().state, second.lifecycle().state]).toEqual([
            'queued',
            'queued'
        ]);

        expect(requestPersist).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(events).toEqual([{ kind: 'persist', outcome: 'granted' }]));
    });
});

const AVAILABLE: ALStorageAvailability = { kind: 'available' };
const MISSING: ALStorageAvailability = {
    kind: 'unavailable',
    reason: { cause: 'missing', detail: 'No IndexedDB.' }
};

function createStorageFixture(
    initial: ALStorageAvailability,
    requestPersist: (() => Promise<boolean>) | undefined = undefined,
    storage: (event: ALStorageEvent) => void = () => {}
): ReturnType<typeof createBrowserMessageSenderFixture> {
    const storageAvailability = new BrowserALStorageAvailability({
        initial,
        requestPersist,
        storage
    });
    return createBrowserMessageSenderFixture(
        undefined,
        undefined,
        createDefaultApiMiddlewareTestDouble({ middleware: { storageAvailability } })
    );
}

/** Admitted on the lane its durability names, as the carrier's runtime routes it. */
function toLaneAdmission(message: ALMessage): ALOutboundEnqueueResult {
    return {
        verdict: {
            kind: 'admitted',
            durable: message.qos?.durability?.algo !== 'volatile',
            queuedAttempts: 1
        },
        message,
        entries: [],
        trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
    };
}
```

Widen the fixtures. `browser-message-sender-fixture.ts:23-27` — the middleware becomes the third parameter:

```ts
export function createBrowserMessageSenderFixture(
    maxPayloadBytes = 64 * 1024,
    registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, ...BROWSER_DELIVERY_RETENTION, cancel: () => {} }),
    middleware = createDefaultApiMiddlewareTestDouble()
): BrowserMessageSenderFixture {
```

(the body's `const middleware = createDefaultApiMiddlewareTestDouble();` goes). `api-middleware-test-double.ts` imports
`BrowserALStorageAvailability`, the middleware literal (`:51-55`) gains
`storageAvailability: createStorageAvailabilityDouble(middlewareOverrides.storageAvailability)` after `heartbeat`, and
before `createQboxEngineDouble`:

```ts
/** A storage availability the test built is used as it is; otherwise storage is available and never asks to persist. */
function createStorageAvailabilityDouble(
    override: Partial<RallarBrowserMiddleware['storageAvailability']> | undefined
): RallarBrowserMiddleware['storageAvailability'] {
    return override instanceof BrowserALStorageAvailability
        ? override
        : new BrowserALStorageAvailability({
            initial: { kind: 'available' },
            requestPersist: undefined,
            storage: () => {}
        });
}
```

(The double's spread pattern would strip a class instance's methods, hence the `instanceof` pass-through.)

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts
```

Expected (measured on Task 4's assembled commit `222c4407b`): `Test Files  2 failed (2)`, `Tests  no tests` — both
fail to import `browser-al-storage-availability.ts`.

- [ ] **Step 3: The availability.** Create `packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts`:

```ts
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALStorageEvent,
    ALStoragePersistOutcome
} from '@shared/alm/storage/al-storage-event.ts';
import type { ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';

export type ALStorageAvailability =
    | Readonly<{ kind: 'available'; }>
    | Readonly<{ kind: 'unavailable'; reason: ALStorageUnavailable; }>;

/** The browser's request for persistent storage; undefined where `navigator.storage.persist` does not exist. */
export type BrowserStoragePersistRequest = (() => Promise<boolean>) | undefined;

export namespace BrowserALStorageAvailability {
    export interface Input {
        readonly initial: ALStorageAvailability;
        readonly requestPersist: BrowserStoragePersistRequest;
        readonly storage: (event: ALStorageEvent) => void;
    }
}

/**
 * One connect's storage availability for durable admissions, and its one request for persistent storage.
 * Storage missing for the document holds until the next connect; any other cause is tried again by the next
 * durable admission, whose verdict re-decides it.
 */
export class BrowserALStorageAvailability {
    readonly availability = new ObservableLatestValue<ALStorageAvailability>();
    private readonly input: BrowserALStorageAvailability.Input;
    private persistRequested = false;

    constructor(input: BrowserALStorageAvailability.Input) {
        this.input = input;
        this.availability.accept(input.initial);
    }

    /** Why a durable admission skips the carrier's durable lane, or undefined while that lane is worth trying. */
    getDurableLaneSkip(): ALStorageUnavailable | undefined {
        const current = this.availability.get();
        return current.kind === 'unavailable' && current.reason.cause === 'missing'
            ? current.reason
            : undefined;
    }

    /** Asks once per connect and returns at once: the outcome arrives later as a `persist` event. */
    requestPersistentStorage(): void {
        if (this.persistRequested) {
            return;
        }
        this.persistRequested = true;
        void readStoragePersistOutcome(this.input.requestPersist).then((outcome) =>
            this.input.storage({ kind: 'persist', outcome })
        );
    }
}

export function toInitialALStorageAvailability(indexedDbSupported: boolean): ALStorageAvailability {
    return indexedDbSupported
        ? { kind: 'available' }
        : {
            kind: 'unavailable',
            reason: { cause: 'missing', detail: 'This browser has no IndexedDB.' }
        };
}

/** A storage failure or a durable admission re-decides availability; any other verdict says nothing about storage. */
export function computeALStorageAvailability(
    previous: ALStorageAvailability,
    verdict: ALDeliveryAdmissionVerdict
): ALStorageAvailability {
    if (verdict.kind === 'storage-unavailable') {
        return { kind: 'unavailable', reason: { cause: verdict.cause, detail: verdict.detail } };
    }
    return verdict.kind === 'admitted' && verdict.durable ? { kind: 'available' } : previous;
}

/** Reads an earlier grant first, so a browser that already persists this origin is not asked again. */
export function toBrowserStoragePersistRequest(
    storageManager:
        | Readonly<{ persist?: () => Promise<boolean>; persisted?: () => Promise<boolean>; }>
        | undefined
): BrowserStoragePersistRequest {
    const persist = storageManager?.persist;
    if (persist === undefined) {
        return undefined;
    }
    const persisted = storageManager?.persisted;
    return async () =>
        (await persisted?.call(storageManager)) === true || await persist.call(storageManager);
}

async function readStoragePersistOutcome(
    requestPersist: BrowserStoragePersistRequest
): Promise<ALStoragePersistOutcome> {
    if (requestPersist === undefined) {
        return 'unsupported';
    }
    return await requestPersist().then(
        (granted): ALStoragePersistOutcome => granted ? 'granted' : 'denied',
        (): ALStoragePersistOutcome => 'denied'
    );
}
```

- [ ] **Step 4: End the memory fallback; decide availability per connect.** In `browser-al-runtime-stores.ts` the
      memory branches and the memory backends go, the two `createBrowserAL*RuntimeStores` always open IndexedDB, and
      `configureBrowserALRuntimeStores` returns the connect's availability. Task 2's `toBrowserStoreOptions` and the
      `storage` port stay as they are:

```diff
diff --git a/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts b/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
@@ -1,11 +1,8 @@
 import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
-import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
 import type { CreateDefaultALRuntimeStoresInput } from '@shared/alm/al-runtime-stores.ts';
 import {
     createDefaultIndexedDbALInboundRuntimeStores,
     createDefaultIndexedDbALOutboundRuntimeStores,
-    createDefaultInMemoryALInboundRuntimeStores,
-    createDefaultInMemoryALOutboundRuntimeStores,
     createVolatileALInboundRuntimeStores,
     createVolatileALOutboundRuntimeStores,
     isIndexedDbALRuntimeStoreSupported
@@ -39,6 +36,11 @@ import {
     toBrowserSessionALInboundRuntimeStoreId,
     toBrowserWsClientALRuntimeStoreId
 } from './browser-al-runtime-identity.ts';
+import {
+    BrowserALStorageAvailability,
+    toBrowserStoragePersistRequest,
+    toInitialALStorageAvailability
+} from './browser-al-storage-availability.ts';
 
 type BrowserALRuntimeOptions = Omit<CreateDefaultALRuntimeStoresInput, 'dbName' | 'namespace'>;
 
@@ -115,29 +117,29 @@ function toBrowserStoreOptions(
     };
 }
 
+/** Always IndexedDB: without it the pair fails at open, and the connect's availability says `missing`. */
 export function createBrowserALInboundRuntimeStores(
     name: string,
     options: BrowserALRuntimeOptions = {}
 ): ALInboundRuntimeStores {
-    const namespace = `browser:${name}`;
-    return isIndexedDbALRuntimeStoreSupported()
-        ? createDefaultIndexedDbALInboundRuntimeStores({
-            ...options,
-            dbName: BROWSER_AL_RUNTIME_DB_NAME,
-            namespace
-        })
-        : createDefaultInMemoryALInboundRuntimeStores({ ...options, namespace });
+    return createDefaultIndexedDbALInboundRuntimeStores({
+        ...options,
+        dbName: BROWSER_AL_RUNTIME_DB_NAME,
+        namespace: `browser:${name}`
+    });
 }
 
+/** Always IndexedDB: without it the pair fails at open, and the connect's availability says `missing`. */
 export function createBrowserALOutboundRuntimeStores(
     name: string,
     options: BrowserALRuntimeOptions = {}
 ): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
-    const namespace = `browser:${name}`;
-    const outbound = { ...options, namespace, decodePrepared: decodeALOutboundTransportMessage };
-    return isIndexedDbALRuntimeStoreSupported()
-        ? createDefaultIndexedDbALOutboundRuntimeStores({ ...outbound, dbName: BROWSER_AL_RUNTIME_DB_NAME })
-        : createDefaultInMemoryALOutboundRuntimeStores(outbound);
+    return createDefaultIndexedDbALOutboundRuntimeStores({
+        ...options,
+        namespace: `browser:${name}`,
+        decodePrepared: decodeALOutboundTransportMessage,
+        dbName: BROWSER_AL_RUNTIME_DB_NAME
+    });
 }
 
 /** Always memory, whatever the browser supports: the pair a carrier routes volatile admissions to. */
@@ -163,24 +165,23 @@ export function createBrowserALVolatileInboundRuntimeStores(
     return createVolatileALInboundRuntimeStores({ namespace: `browser:${name}:volatile` }, budget);
 }
 
+/** Configures one connect's store scopes and decides, once, whether its durable pairs have storage. */
 export function configureBrowserALRuntimeStores(
     sessionId: string,
     input: ConfigureBrowserALRuntimeStoresInput
-): void {
+): BrowserALStorageAvailability {
     const { diagnosticsPorts, ...options } = input;
-    const inMemory = !isIndexedDbALRuntimeStoreSupported();
     const scoped: BrowserALRuntimeOptions = {
         ...options,
         observer: diagnosticsPorts.indexedDbOperationObserver,
-        canonicalScope: `browser-session:${sessionId}`,
-        inboundBackend: inMemory
-            ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
-            : options.inboundBackend,
-        outboundBackend: inMemory
-            ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
-            : options.outboundBackend
+        canonicalScope: `browser-session:${sessionId}`
     };
     configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped, diagnosticsPorts.storage));
+    return new BrowserALStorageAvailability({
+        initial: toInitialALStorageAvailability(isIndexedDbALRuntimeStoreSupported()),
+        requestPersist: toBrowserStoragePersistRequest(globalThis.navigator?.storage),
+        storage: diagnosticsPorts.storage
+    });
 }
 
 export function resolveBrowserSessionALInboundRuntimeStores(
```

`rallar-connection-facade.ts`: import type `BrowserALStorageAvailability`, and `RallarBrowserMiddleware` gains after
`heartbeat` (`:45`):

```ts
/** Whether this connect's durable admissions have browser storage, re-decided by each durable admission. */
readonly storageAvailability: BrowserALStorageAvailability;
```

`initialise-browser-middleware.ts`: `initialiseBrowserRuntimeStores` returns the availability and
`initialiseMiddleware` puts it on the middleware (Task 2's `storage` port feeds the eviction loop unchanged):

```diff
diff --git a/packages/shared-web/browser/connection/initialise-browser-middleware.ts b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
--- a/packages/shared-web/browser/connection/initialise-browser-middleware.ts
+++ b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
@@ -59,6 +59,7 @@ import {
     createBrowserALVolatileInboundRuntimeStores,
     resolveBrowserSessionALInboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import type { BrowserALStorageAvailability } from '@shared-web/browser/al-runtime/browser-al-storage-availability.ts';
 import { createBrowserQueueBoxEngine } from '@shared-web/browser/queuebox/create-browser-queue-box-engine.ts';
 import * as rtcEngine from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
 import * as heartbeat from '@shared-web/browser/session/browser-session-heartbeat.ts';
@@ -206,7 +207,7 @@ export async function initialiseMiddleware(
     rtcSignalingTopicId: string,
     options: MiddlewareInitOptions
 ): Promise<RallarBrowserMiddleware> {
-    initialiseBrowserRuntimeStores(session.sessionId, options.diagnosticsPorts);
+    const storageAvailability = initialiseBrowserRuntimeStores(session.sessionId, options.diagnosticsPorts);
     const transportInput = createBrowserTransportInput(session, options);
     const webSocketTransport = await initialiseBrowserWebSocketTransport(transportInput);
     const rtcTransport = await initialiseBrowserRtcTransport({
@@ -235,7 +236,8 @@ export async function initialiseMiddleware(
     return {
         ...webSocketTransport,
         ...rtcTransport,
-        heartbeat: heartbeatHandle
+        heartbeat: heartbeatHandle,
+        storageAvailability
     };
 }
 
@@ -273,12 +275,13 @@ export function createBrowserTransportInput(
 function initialiseBrowserRuntimeStores(
     sessionId: string,
     diagnosticsPorts: RallarDiagnosticsPorts
-): void {
+): BrowserALStorageAvailability {
     initialiseBrowserCacheRepositories();
-    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
+    const storageAvailability = configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
     initBrowserALRuntimeExpiryEviction({ storage: diagnosticsPorts.storage }).catch((error) =>
         console.error('Failed to initialise browser AL runtime expiry eviction:', toError(error))
     );
+    return storageAvailability;
 }
 
 async function initialiseBrowserWebSocketTransport(
```

- [ ] **Step 5: The dispatch skips while missing and records every verdict.** In `browser-rallar-message-dispatch.ts`
      import `computeALStorageAvailability` and `type BrowserALStorageAvailability` from
      `@shared-web/browser/al-runtime/browser-al-storage-availability.ts` (first import), make `writeChannelAdmission`'s
      first line `const admitted = await writeStorageAdmission(delivery);`, and add after `writeChannelAdmission`:

```ts
/**
 * A durable message skips the carrier while storage is missing for the document. Any admission that reaches
 * the carrier re-decides the connect's availability, and the first durable one asks for persistent storage.
 */
async function writeStorageAdmission(
    delivery: BrowserRallarMessageDispatch.Delivery
): Promise<ALOutboundEnqueueResult> {
    const storage = delivery.context.middleware.storageAvailability;
    const skipped = toRequestedDurability(delivery.message) === 'volatile'
        ? undefined
        : storage.getDurableLaneSkip();
    if (skipped !== undefined) {
        const verdict: ALDeliveryAdmissionVerdict = { kind: 'storage-unavailable', ...skipped };
        return { verdict, message: delivery.message, entries: [], trackedReceiptAlgo: 'none' };
    }
    const admitted = await writeCarrierOutboxAdmission(
        delivery.context,
        delivery,
        delivery.message
    );
    recordStorageVerdict(storage, admitted.verdict);
    return admitted;
}

function recordStorageVerdict(
    storage: BrowserALStorageAvailability,
    verdict: ALDeliveryAdmissionVerdict
): void {
    storage.availability.accept(computeALStorageAvailability(storage.availability.get(), verdict));
    if (verdict.kind === 'admitted' && verdict.durable) {
        storage.requestPersistentStorage();
    }
}
```

- [ ] **Step 6: Run the new tests green, then the suites that leaned on the fallback.**

```sh
npx vitest run packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts
npx vitest run packages/tests/shared-web packages/tests/shared/alm packages/tests/shared-test packages/tests/rallar-black-box-headless
```

Expected (measured on `b67e43022`): `Tests  23 passed (23)` for the first (the two `persisted()` cases included). The second, sandbox disabled, before Step 7: `Test Files
4 failed | 432 passed (436)`, `Tests  33 failed | 4579 passed (4612)` — the four files that ran durable work in Node
without IndexedDB and got memory stores (`acknowledgement-under-transport-hold.test.ts` 29, `ws-retained-work-fault.test.ts`
2, `browser-session-inbound-store.test.ts` 1, and `create-browser-web-socket-queue-box.test.ts` 2 volatile cases that need
Task 3's non-blocking durable lane; with Task 3 in place those two pass unchanged).

- [ ] **Step 7: Move the fallback's dependants onto IndexedDB.**

```sh
git rm packages/tests/shared-web/messages/acknowledgement-under-transport-hold.test.ts
```

`ws-retained-work-fault.test.ts`: add `import '../../setup-browser-indexeddb.ts';` before the
`outbound-runtime-test-fixture.ts` import, and the `beforeEach`'s `vi.useFakeTimers();` becomes:

```ts
// fake-indexeddb completes on `setImmediate`, so it stays real, as in `ws-durable-owner-recovery.test.ts`.
vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
});
```

`browser-session-inbound-store.test.ts`: `import '../../setup-browser-indexeddb.ts';` first, the vitest import shrinks to
`describe, expect, it`, the `afterEach` and the `vi.stubGlobal('indexedDB', undefined)` go, and the case is renamed
`'shares one admission state across every resolve of one session'` (the invariant — two carriers' resolves read one
dedup state — now holds through the one database).

Re-run the second command: `Test Files  435 passed (435)` expected (measured 1802/1802 on the prototype's focused
subset `messages`, `al-runtime`, `websocket`, `shared/alm/delivery`, the two surface tests, `rallar-black-box-headless`,
`tests/repo`: `Test Files  131 passed (131)`; on the assembled commit `b67e43022` the subset `messages`, `al-runtime`,
`websocket`, `shared/alm/delivery` and the two surface tests measured `Test Files  38 passed (38)`,
`Tests  602 passed (602)`).

- [ ] **Step 8: The API reference.** In `docs/rallar-api-reference.md`, after Task 4's
      `` `admittedDurable: false`. A lane send names no channel, so it always refuses. `` line:

```md
A browser without IndexedDB has no durable storage and no memory stand-in:
each connect decides that once, and its durable sends follow the same rule
without reaching the carrier. Any other storage failure is tried again by the
next durable send. The first durable admission of a connect asks for
persistent storage: it reads `navigator.storage.persisted()` and, unless the
origin already persists, calls `navigator.storage.persist()`; the send awaits
neither, and the outcome arrives as a `persist` event on the storage
diagnostics port. A denial is asked again by the next connect.
```

- [ ] **Step 9: Register the counted interactions, and the `persist` event in the diagnostics contract.** Nine new
      `mock-invocation-count-or-order` candidates (ids `test-structure-coupling-8c505289aafb62eb`,
      `-5bda6f9678cade56`, `-5cfc88ff29db5327`, `-32072a4545dad5be`, `-722c81978c153256`, `-c0bae618e1fb4c74`,
      `-64b9e7b82ad05884`, `-0e36d98d5c4b3055`, `-e68c595e34c57225`) are the interactions under test (no carrier
      admission while missing; one volatile admission; persist asked once). The two `persisted()` cases record their
      calls in an array and add no candidate. Add seven contracts, one per executable assertion, at the end of
      `contracts`, and the nine entries at the end of `entries` of `docs/test-structure-coupling-exceptions.md`:

```diff
diff --git a/docs/test-structure-coupling-exceptions.md b/docs/test-structure-coupling-exceptions.md
--- a/docs/test-structure-coupling-exceptions.md
+++ b/docs/test-structure-coupling-exceptions.md
@@ -3478,6 +3478,111 @@ moved or changed test.
         "requiredConstraint": "The downgrade happens once per send, whichever carrier ends up holding it.",
         "failureRationale": "Asking storage again on the fallback leg would repeat the durable failure and could downgrade twice."
       }
+    },
+    {
+      "id": "browser-storage-missing-skips-carrier",
+      "domain": "Browser storage availability per connect",
+      "owner": "Rallar browser maintainers",
+      "summary": "While storage is missing a durable send on a refusing channel fails without a carrier admission. Executable assertion: “skips the durable lane while storage is missing, so a refusing channel fails without reaching the carrier”.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#skips the durable lane while storage is missing, so a refusing channel fails without reaching the carrier",
+      "coverageRelation": "The test gives the middleware a storage availability, sends through the real sender and dispatch, and reads the handle, the availability and the carrier admission port.",
+      "interactionRequirement": {
+        "interactionKind": "absence",
+        "ownedPort": "Carrier outbound admission port (enqueueOutboxIfAbsent)",
+        "observableEffect": "No admission reaches the carrier.",
+        "requiredConstraint": "Missing storage holds for the document without a carrier round trip.",
+        "failureRationale": "Reaching a carrier whose durable lane cannot open spends a failing admission on every send."
+      }
+    },
+    {
+      "id": "browser-storage-missing-volatile-admits-once",
+      "domain": "Browser storage availability per connect",
+      "owner": "Rallar browser maintainers",
+      "summary": "While storage is missing a volatile channel reaches the carrier once, with the volatile envelope only. Executable assertion: “sends a missing-storage message on a volatile channel with one carrier admission, without storage”.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#sends a missing-storage message on a volatile channel with one carrier admission, without storage",
+      "coverageRelation": "The test gives the middleware a storage availability, sends through the real sender and dispatch, and reads the handle, the availability and the carrier admission port.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Carrier outbound admission port (enqueueOutboxIfAbsent)",
+        "observableEffect": "One admission, of the volatile envelope.",
+        "requiredConstraint": "The skipped durable attempt never reaches the carrier.",
+        "failureRationale": "A durable attempt first would fail at the lane and cost an admission per send."
+      }
+    },
+    {
+      "id": "browser-storage-missing-never-skips-volatile",
+      "domain": "Browser storage availability per connect",
+      "owner": "Rallar browser maintainers",
+      "summary": "A volatile send reaches the carrier while storage is missing. Executable assertion: “never skips a volatile send”.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#never skips a volatile send",
+      "coverageRelation": "The test gives the middleware a storage availability, sends through the real sender and dispatch, and reads the handle, the availability and the carrier admission port.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Carrier outbound admission port (enqueueOutboxIfAbsent)",
+        "observableEffect": "One admission for a volatile send.",
+        "requiredConstraint": "The skip applies to durable sends only.",
+        "failureRationale": "Skipping a volatile send would refuse a message that needs no storage."
+      }
+    },
+    {
+      "id": "browser-storage-quota-retried-next-send",
+      "domain": "Browser storage availability per connect",
+      "owner": "Rallar browser maintainers",
+      "summary": "A storage failure other than missing is tried again by the next durable send, which re-decides availability. Executable assertion: “tries the durable lane again after a quota failure and reads available once storage holds a send”.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#tries the durable lane again after a quota failure and reads available once storage holds a send",
+      "coverageRelation": "The test gives the middleware a storage availability, sends through the real sender and dispatch, and reads the handle, the availability and the carrier admission port.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Carrier outbound admission port (enqueueOutboxIfAbsent)",
+        "observableEffect": "Two admissions: the failed one and the retried one.",
+        "requiredConstraint": "Only missing storage is skipped; quota, closed and the rest are retried.",
+        "failureRationale": "Skipping after a quota failure would refuse every later send even after space frees."
+      }
+    },
+    {
+      "id": "browser-storage-persist-first-durable-admission",
+      "domain": "Browser persistent storage request",
+      "owner": "Rallar browser maintainers",
+      "summary": "A connect asks navigator.storage.persist() once, on its first durable admission and never for a volatile one. Executable assertion: “asks for persistent storage on the first durable admission only”.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#asks for persistent storage on the first durable admission only",
+      "coverageRelation": "The test injects the persist request port, sends a volatile then two durable messages through the real dispatch, and reads the port and the storage events.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Browser storage persist request port (navigator.storage.persist)",
+        "observableEffect": "Exactly one persist request per connect, raised by the first durable admission.",
+        "requiredConstraint": "Apps that never send durably never ask, and a connect asks at most once.",
+        "failureRationale": "Firefox asks the user on persist(); asking per send or for apps that store nothing prompts users needlessly."
+      }
+    },
+    {
+      "id": "browser-storage-persist-requested-once",
+      "domain": "Browser persistent storage request",
+      "owner": "Rallar browser maintainers",
+      "summary": "The availability asks the browser once however often it is told to, and reports the outcome later. Executable assertion: “asks once and reports the outcome as a persist event after the call returns”.",
+      "semanticCoverage": "packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts#asks once and reports the outcome as a persist event after the call returns",
+      "coverageRelation": "The test calls the request twice with an injected persist port and reads the port and the events.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Browser storage persist request port (navigator.storage.persist)",
+        "observableEffect": "One persist request for two calls.",
+        "requiredConstraint": "The request is made once per connect and never awaited by its caller.",
+        "failureRationale": "Repeated requests can prompt the user repeatedly."
+      }
+    },
+    {
+      "id": "browser-storage-persist-through-storage-manager",
+      "domain": "Browser persistent storage request",
+      "owner": "Rallar browser maintainers",
+      "summary": "The persist request built from the browser storage manager calls its persist once per request. Executable assertion: “asks through the browser storage manager where it has persist”.",
+      "semanticCoverage": "packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts#asks through the browser storage manager where it has persist",
+      "coverageRelation": "The test builds the request from a storage manager double and calls it once.",
+      "interactionRequirement": {
+        "interactionKind": "count",
+        "ownedPort": "Browser storage persist request port (navigator.storage.persist)",
+        "observableEffect": "One persist call per request.",
+        "requiredConstraint": "The request forwards to the browser once, bound to its storage manager.",
+        "failureRationale": "A request that called persist more than once would prompt the user more than once."
+      }
     }
   ],
   "entries": [
@@ -8001,6 +8106,105 @@ moved or changed test.
       "owner": "Rallar browser maintainers",
       "rationale": "The envelope the fallback carrier receives is already volatile.",
       "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#hands the downgraded message to the fallback carrier without asking storage again"
+    },
+    {
+      "id": "test-structure-coupling-8c505289aafb62eb",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-missing-skips-carrier",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "No carrier admission while storage is missing.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#skips the durable lane while storage is missing, so a refusing channel fails without reaching the carrier"
+    },
+    {
+      "id": "test-structure-coupling-5bda6f9678cade56",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-missing-volatile-admits-once",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "One carrier admission, without the skipped durable attempt.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#sends a missing-storage message on a volatile channel with one carrier admission, without storage"
+    },
+    {
+      "id": "test-structure-coupling-5cfc88ff29db5327",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-missing-volatile-admits-once",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "The one admission is the volatile envelope.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#sends a missing-storage message on a volatile channel with one carrier admission, without storage"
+    },
+    {
+      "id": "test-structure-coupling-32072a4545dad5be",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-missing-never-skips-volatile",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "A volatile send reaches the carrier.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#never skips a volatile send"
+    },
+    {
+      "id": "test-structure-coupling-722c81978c153256",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-quota-retried-next-send",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "The next durable send reaches the carrier again.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#tries the durable lane again after a quota failure and reads available once storage holds a send"
+    },
+    {
+      "id": "test-structure-coupling-c0bae618e1fb4c74",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-persist-first-durable-admission",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "A volatile admission does not ask.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#asks for persistent storage on the first durable admission only"
+    },
+    {
+      "id": "test-structure-coupling-64b9e7b82ad05884",
+      "path": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-persist-first-durable-admission",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "Two durable admissions ask once.",
+      "semanticCoverage": "packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts#asks for persistent storage on the first durable admission only"
+    },
+    {
+      "id": "test-structure-coupling-0e36d98d5c4b3055",
+      "path": "packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-persist-requested-once",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "Two calls reach the browser once.",
+      "semanticCoverage": "packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts#asks once and reports the outcome as a persist event after the call returns"
+    },
+    {
+      "id": "test-structure-coupling-e68c595e34c57225",
+      "path": "packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts",
+      "kind": "mock-invocation-count-or-order",
+      "contract": "browser-storage-persist-through-storage-manager",
+      "disposition": "durable-boundary",
+      "boundary": "interaction",
+      "owner": "Rallar browser maintainers",
+      "rationale": "One request calls persist once.",
+      "semanticCoverage": "packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts#asks through the browser storage manager where it has persist"
     }
   ]
 }
```

`packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` § Storage Diagnostics names the `persist`
event after the `health` paragraph Task 3 wrote:

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -479,6 +479,12 @@ event's `data` is the event itself, with `kind` and, except for `persist`, the
   control, receipt or inbound admission, and of a work batch; every durable
   commit and every flushed batch is a recovery point.
 
+- `persist`: `outcome` (`granted`, `denied` or `unsupported`), once per connect
+  after its first durable admission: `granted` when the origin already
+  persisted or the browser granted the request, `denied` when it refused or the
+  request failed, `unsupported` without `navigator.storage.persist`. It has no
+  `storeId`.
+
 ## Compatibility
 
 Adding optional fields to diagnostic payloads is compatible.
```

- [ ] **Step 10: Format and the constraint checks.**

```sh
npx dprint fmt packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts packages/shared-web/browser/connection/initialise-browser-middleware.ts packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts packages/shared-web/browser/rallar-connection-facade.ts packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts packages/tests/shared-web/api-middleware-test-double.ts packages/tests/shared-web/messages/browser-message-sender-fixture.ts packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts docs/rallar-api-reference.md docs/test-structure-coupling-exceptions.md packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
npx tsc -p packages/shared/tsconfig.json --noEmit                        # exit 0
npm --workspace @ar-eye-hunter/shared-web run typecheck                  # exit 0
npm --workspace @ar-eye-hunter/shared-server run typecheck                # exit 0
(cd apps/api-v1 && deno task check)                                      # exit 0
node scripts/check-tests-typecheck.mjs
# PASS: no new type errors in the maintained test project
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless
# Tests  21 passed (21)
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles     # Bundle budget check passed.
npm run test:unit:main                                                   # sandbox disabled
# Test Files  1330 passed | 4 skipped (1334)   Tests  12401 passed | 12 skipped (12413)   (measured)
```

Measured on the assembled commit `b67e43022` (brotli q11, the gates' method): `rallar.ts` 231.239 → 231.677 KiB
against 232; the headless agent 295.075 → 295.495 KiB against 296 (Task 4 raised it). Neither crosses. The ledger and
operation-count pins (`al-indexeddb-transaction-ledger.test.ts`, `al-indexeddb-operation-counts.test.ts`) are inside
`test:unit:main` and unchanged: no IndexedDB operation was added (`persisted()` and `persist()` are no IndexedDB
operation). No public export changes (`RallarBrowserMiddleware` gains a field; the snapshot lists names only).

- [ ] **Step 11: Commit, then the changed-range gates.**

```sh
git add packages/shared-web/browser/al-runtime packages/shared-web/browser/connection/initialise-browser-middleware.ts packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts packages/shared-web/browser/rallar-connection-facade.ts packages/tests/shared-web docs/rallar-api-reference.md docs/test-structure-coupling-exceptions.md packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
git commit -m "Decide browser storage availability once per connect and end the memory fallback

configureBrowserALRuntimeStores no longer hands the durable pairs memory
backends where IndexedDB is missing: the pairs are always IndexedDB, and the
connect's BrowserALStorageAvailability, carried on the middleware, holds an
ObservableLatestValue of available or unavailable with its reason. While
storage is missing for the document the dispatch skips the durable lane, so a
durable send reads storage-unavailable without reaching the carrier and the
channel's onStorageUnavailable decides; any other cause is re-tried by the next
durable admission, whose verdict re-decides availability. The connect's first
durable admission reads navigator.storage.persisted() and, unless the origin
already persists, asks navigator.storage.persist(); neither is awaited, and
the outcome is reported as a persist storage event.

The memory twin of the acknowledgement-under-hold suite tested the removed
fallback and goes; its cases run over IndexedDB in the -indexeddb twin. The
retained-work and session-inbound tests move onto fake IndexedDB.

rallar.ts measures 231.677 KiB under 232, the headless agent 295.495 KiB
under 296.

D8 reuse: availability is an ObservableLatestValue and the stores' own IndexedDB factories; no new port, cache, timer or retry, and the persist request adds no IndexedDB operation."
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: all 16 current structure-coupling candidates are individually classified
# PASS: changed-range structure-coupling review has complete individual classifications
# PASS: registry entries are complete and current
```

(Measured on the prototype: both PASS. A first version caught the rejection with `(error: unknown) => error` in the
availability test and the changed-style gate reported `boundary.unknown`; the test asserts with `rejects.toSatisfy`
instead, as shown in Step 1.)

---

### Task 6: One database per scope, and the purge on login over a session and a session switch

Prototyped in `scratch-C` (branch `scratch/i2a-C`) as commit `8573bcd9f`, red then green, on W-A's Tasks 1–3
(`b122c166f`); assembled as `7b5bf4442` on `scratch/i2a-assemble` over the real Tasks 1–5. Decision D120, proposal
§1.4, §3.c, §3.d; survey items 1, 7, 12.

`file:line` anchors are at `7e6f0a117`. The diffs of Steps 1 (the stores test), 3, 4, 6 and 8 are cut from the
assembled commits (`b67e43022` → `7b5bf4442`), so they carry Task 5's shapes: the durable pairs are always
IndexedDB and `configureBrowserALRuntimeStores` returns the connect's `BrowserALStorageAvailability`. The other diffs
are against `b122c166f`; Tasks 4 and 5 do not touch those files, so they apply unchanged. The database name encodes
each scope part with `encodeURIComponent`, as `toStateScopeHttpPath` does (R-I2a-i-25), so plain ids read exactly as
D120 states them and an id with a colon cannot alias another scope.

**Files**

- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts`.
  `BROWSER_AL_RUNTIME_DB_NAME` (`:8`) is replaced by `BROWSER_AL_RUNTIME_DB_NAME_PREFIX` and
  `toBrowserALRuntimeDbName(scope)`. New `toBrowserSessionALRuntimeStoreIds`, built from the list at
  `:36-44`; `toBrowserSessionALRuntimeEntryKeyPrefixes` now maps over it. `toBrowserALRuntimeNamespace`
  (`:47-49`) becomes module-private: no other file imports it, and without the change the file
  reaches 12 runtime exports (`file.responsibility-count`).
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts`.
  - `BrowserALRuntimeOptions` (`:41`) carries a required `dbName`.
  - `ConfigureBrowserALRuntimeStoresInput` (`:43-46`) gains a required `scope: StateScope`.
  - The two `createBrowserAL*RuntimeStores` (`:102-125`) take `dbName` from their options and lose the
    `= {}` default.
  - `configureBrowserALRuntimeStores` (`:154-160`) names the database from the scope.
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts` (418 to 456 lines).
  - The result's `dbName` becomes `dbNames` (`:65-71`).
  - The three option contracts gain a required `currentScope` (`:73-77`, `:107-110`, `:131-134`).
  - `deleteBrowserALRuntimeEntriesMatching` and `openBrowserALRuntimeDatabase` (`:182-237`) give way
    to `readBrowserALRuntimeDbNames`, `deleteBrowserALRuntimeEntriesInEveryDatabase` and
    `deleteBrowserALRuntimeEntriesInDatabase`.
  - `readBrowserALRuntimeCleanup` (`:239-248`) takes the deletion contract.
  - `toBrowserALRuntimeCleanupResult` (`:400-412`) sums the per-database counts.

  Functions stay under 40 lines. The longest is the untouched
  `validateBrowserALRuntimeCleanupMutation` at 33; the new `deleteBrowserALRuntimeEntriesInDatabase`
  is 30. The changed-style gate reports no cognitive-load finding.
- Modify: `packages/shared-web/browser/connection/initialise-browser-middleware.ts`.
  `initialiseMiddleware` (`:209`) resolves `options.scope ?? defaultStateScope()` once, the same
  default `:631` applies. `initialiseBrowserRuntimeStores` (`:274-283`) takes that scope and hands it
  to the stores and the eviction loop.
- Create: `packages/shared-web/browser/session/delete-ended-session-al-runtime-entries.ts` (32 lines).
  It owns the purge of an ended session and turns a failure into storage health.
- Modify: `packages/shared-web/browser/session/session-auth-lifecycle.ts`.
  - `activateLoginSession` (`:133-137`) and `reconcileActiveMiddleware` (`:232-239`) purge the
    replaced session.
  - `cleanupEndedSession` (`:308-322`) loses its swallowing `try {} catch {}`.
  - New private methods `deleteReplacedSessionALRuntimeEntries` and `resolveStorageScope`.
- No budget file changes: on the assembled commit `browser/rallar.ts` measures 231.863 KiB against the 232 Task 3
  set, and the headless agent 295.511 KiB against the 296 Task 4 set.
- Test (modify): `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts` (793 to 968
  lines at `b122c166f`).
  - Seven new tests.
  - The 60 s eviction test widened to two scopes.
  - Every existing case moved to the scope's database, including Task 2's storage-port case.
  - The helpers take a `dbName`.
- Test (modify): `packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts` (349 to 433
  lines) with four new tests. `browser-auth-session-contract-fixture.ts` (`:27-35`, `:187-193`) takes
  the `dbNames` result shape.
- Test (modify): `packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts` (Task 5's): its two
  `configureBrowserALRuntimeStores` calls gain `scope: defaultStateScope()`, now required.
- Test (modify, moved with the name):
  - under `packages/tests/shared-web/`: `al-runtime/browser-outbound-cleanup.test.ts`,
    `messages/acks-read-eviction-race.ts`, `al-runtime/browser-session-inbound-store.test.ts`,
    `connection/initialise-browser-middleware.test.ts`, `messages/acknowledgement-under-hold-fixture.ts`,
    `rtc/initialise-browser-rtc-runtime.test.ts`, `rtc/rtc-durable-owner-recovery.test.ts`,
    `websocket/create-browser-web-socket-queue-box.test.ts`, `websocket/ws-durable-owner-recovery.test.ts`,
    `websocket/ws-retained-work-fault.test.ts`;
  - `packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts` and
    `rtc-message-nack-diagnostics.test.ts`;
  - `tests/playwright/alm/harness/create-durable-send-harness.ts`.
- Docs (navigation maps): `packages/shared-web/browser/README.md` (`:175-180`),
  `packages/shared/alm/inbound/README.md` (`:583`) and
  `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (`:444`).
- Not touched: `AL_ADMISSION_SCHEMA_ID` (no row shape changes), the key builders, the work-namespace
  builders, `browser-al-work-cleanup.ts`, `packages/shared/alm/**` and the server. No code opens,
  lists into a purge, or deletes `ar-eye-hunter-al-runtime` (D120).

**Interfaces**

- Consumes (Task 1): `toALStorageUnavailable(error: Error): ALStorageUnavailable | undefined` from
  `packages/shared/alm/storage/al-storage-unavailable.ts`. A non-`Error` catch value goes through
  `toError` from `packages/shared/resilience/to-error.ts`.
- Consumes (Task 2):
  - `ALStorageEventSink` and `toALStorageResetSink(storage, storeId)` from
    `packages/shared/alm/storage/al-storage-event.ts`;
  - the `health` arm `Readonly<{ kind: 'health'; storeId: string }> & ALStorageHealthState`;
  - `RallarDiagnosticsPorts.storage`;
  - the cleanup option field `storage: ALStorageEventSink`, which Task 2 put in place of
    `onStorageReset`;
  - Task 2's convention that a reset the cleanup causes names the database it opens. This task
    keeps the convention, once per database.
- Consumes (other): `StateScope` (`packages/shared/api/state-types.ts:16-19`) and `defaultStateScope()`
  (`packages/shared-web/browser/api/state-http-path.ts:3`).
- Produces (`browser-al-runtime-identity.ts`):
  ```ts
  export const BROWSER_AL_RUNTIME_DB_NAME_PREFIX = 'rallar-al-runtime:';
  export function toBrowserALRuntimeDbName(scope: StateScope): string; // `rallar-al-runtime:${encode(applicationId)}:${encode(workspaceId)}`
  export function toBrowserSessionALRuntimeStoreIds(
      sessionId: string
  ): readonly ALRuntimeStoreId<ALOutboundTransportMessage>[];
  // removed: BROWSER_AL_RUNTIME_DB_NAME; toBrowserALRuntimeNamespace is no longer exported
  ```
- Produces (`browser-al-runtime-stores.ts`):
  ```ts
  export interface ConfigureBrowserALRuntimeStoresInput
      extends
          Omit<
              BrowserALRuntimeOptions,
              'dbName' | 'observer' | 'onStorageReset' | 'storageHealth'
          > {
      readonly scope: StateScope;
      readonly diagnosticsPorts: RallarDiagnosticsPorts;
  }
  export function createBrowserALInboundRuntimeStores(
      name: string,
      options: BrowserALRuntimeOptions
  ): ALInboundRuntimeStores;
  export function createBrowserALOutboundRuntimeStores(
      name: string,
      options: BrowserALRuntimeOptions
  ): ALOutboundRuntimeStores<ALOutboundTransportMessage>;
  // module-private: interface BrowserALRuntimeOptions extends Omit<CreateDefaultALRuntimeStoresInput, 'dbName' | 'namespace'> { readonly dbName: string }
  ```
- Produces (`browser-al-runtime-cleanup.ts`):
  ```ts
  export interface BrowserALRuntimeCleanupResult {
      readonly dbNames: readonly string[];
      readonly storeName: string;
      readonly keyPrefixes: readonly string[];
      readonly scanned: number;
      readonly deleted: number;
  }
  export interface DeleteExpiredBrowserALRuntimeEntriesOptions {
      readonly currentScope: StateScope;
      readonly storage: ALStorageEventSink;
      readonly nowMs?: number;
      readonly keyPrefixes?: readonly string[];
  }
  export interface DeleteBrowserALRuntimeEntriesForSessionOptions {
      readonly currentScope: StateScope;
      readonly storage: ALStorageEventSink;
  }
  export interface InitBrowserALRuntimeExpiryEvictionInput {
      readonly currentScope: StateScope;
      readonly storage: ALStorageEventSink;
      readonly intervalMs?: number;
  }
  export function deleteBrowserALRuntimeEntriesForSession(
      sessionId: string,
      options: DeleteBrowserALRuntimeEntriesForSessionOptions
  ): Promise<BrowserALRuntimeCleanupResult>;
  // deleteExpiredBrowserALRuntimeEntries, deleteExpiredBrowserALRuntimeEntriesForSession, evictExpiredBrowserALRuntimeEntries
  // and initBrowserALRuntimeExpiryEviction keep their signatures over the widened option contracts.
  ```
  Behaviour of every cleanup helper:
  - It visits each database that `indexedDB.databases()` lists with the prefix `rallar-al-runtime:`,
    in listing order. Without `databases()` it visits `toBrowserALRuntimeDbName(currentScope)` alone.
  - A failing database does not stop the others. The first failure is rethrown after all have been
    tried.
  - A schema reset that a sweep causes is reported as `reset` with `storeId` set to that database's
    name.
  - The 60 s loop holds the `currentScope` of the connect that started it.
- Produces (`session/delete-ended-session-al-runtime-entries.ts`):
  ```ts
  export interface DeleteEndedSessionALRuntimeEntriesInput {
      readonly currentScope: StateScope;
      readonly diagnosticsPorts: RallarDiagnosticsPorts;
  }
  export function deleteEndedSessionALRuntimeEntries(
      sessionId: string,
      input: DeleteEndedSessionALRuntimeEntriesInput
  ): Promise<void>;
  ```
  It never rejects on a purge failure. Instead it emits
  `{ kind: 'health', storeId, status: 'failing', lastFailure: toALStorageUnavailable(toError(error)), lastRecoveryPointAtMs: undefined }`
  once for each of the session's three store ids.
- Lifecycle behaviour (`BrowserSessionAuthLifecycle`):
  - Logout purges as before, and a failure now emits `health`.
  - A login over a session purges the previous session after the disconnect, `endSession` and
    `closeDataScopes`. So does a session switch in `connect`.
  - Either purge runs only when the session id differs. Rows are keyed by session id, so a renewal
    that keeps the id keeps its rows.
  - The fallback scope is `connectionRuntime.resolveOperationScope() ?? defaultStateScope()`.

**D8 reuse inspection.** Reused:

- `deleteBrowserALRuntimeEntriesForSession` and the whole read, compute, validate and write pipeline
  of the cleanup, now run once per database;
- `openIndexedDbAdmissionDatabase`, whose reset-on-mismatch path is unchanged, per database;
- Task 2's `toALStorageResetSink` for the per-database reset, and the store factories' existing
  `dbName` input (`al-runtime-stores.ts:89`);
- the existing key and work-namespace builders, `StateScope`, `defaultStateScope()`, `toError`;
- Task 2's `health` arm and `RallarDiagnosticsPorts.storage`, Task 1's `toALStorageUnavailable`,
  and `indexedDB.databases()`.

Not added:

- no scope index row or store scan: the database names list the scopes;
- no delete code for the legacy database (D120), and no schema id bump;
- no new timer: the existing 60 s loop visits the extra databases;
- no in-memory registry of the scopes a document used. Without `databases()` the fallback is the
  current scope, and a `Set` or `LatestRepository` of opened names would be state kept for a browser
  corner case: `databases()` ships in current Chromium, Safari and Firefox.
- the purge does not go through Task 2's per-store `ALStorageHealth`. An ended session's stores are
  gone, so no `healthy` transition can follow. The purge emits once per store instead of holding a
  value nothing would read again.

- [ ] **Step 1: Write the failing tests.** Apply this change to
      `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts` (hunks at `b122c166f`).
      - Constants: the two scope database names are spelled out, so a change to the naming scheme
      fails here first.
      - Existing cases move to the default scope's database:
      - `configureBrowserALRuntimeStores` gains `scope: SCOPE`;
      - `createBrowserALOutboundRuntimeStores` gains `dbName: SCOPE_DB_NAME`;
      - every cleanup call gains `currentScope: SCOPE`;
      - the result's `dbName` becomes `dbNames`;
      - Task 2's storage-port case seeds and expects `SCOPE_DB_NAME`.
      - Helpers: the raw-row helpers take a `dbName`, and the single-database delete becomes a delete
      of every database that `indexedDB.databases()` lists.
      - The 60 s eviction test is widened to two scopes.
      - Seven new tests:
      - the name;
      - each scope part encoded, so `a:b`/`c` and `a`/`b:c` name two databases (R-I2a-i-25);
      - two scopes of one session see disjoint rows;
      - the purge covers every scope's database;
      - without `databases()` the purge covers the current scope only;
      - the legacy database and its rows are left in place;
      - one failing database does not stop the sweep of the others.

      The four new tests that persist a message pin `Date`, as the existing ones do. The fixture
      message carries a 20 ms TTL, and under a loaded sweep a real clock made the legacy test's
      admission read `expired`.

```diff
diff --git a/packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts b/packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts
--- a/packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts
@@ -11,8 +11,8 @@ import {
     initBrowserALRuntimeExpiryEviction
 } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
 import {
-    BROWSER_AL_RUNTIME_DB_NAME,
     BROWSER_AL_RUNTIME_STORE_NAME,
+    toBrowserALRuntimeDbName,
     toBrowserALRuntimeEntryKeyPrefix,
     toBrowserRtcOverlayALRuntimeStoreId,
     toBrowserSessionALInboundRuntimeStoreId,
@@ -26,13 +26,17 @@ import {
     resolveBrowserRtcOverlayALOutboundRuntimeStores,
     resolveBrowserWsClientALOutboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import {
     createPassThroughALInboundRuntimeDiagnosticsSink,
     createPassThroughALOutboundRuntimeDiagnosticsSink,
     toRallarDiagnosticsPorts
 } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
-import { AL_ADMISSION_SCHEMA_ID, openIndexedDbAdmissionDatabase } from '@shared/alm/open-indexed-db-admission-database.ts';
+import {
+    AL_ADMISSION_SCHEMA_ID,
+    openIndexedDbAdmissionDatabase
+} from '@shared/alm/open-indexed-db-admission-database.ts';
 import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
 import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
 import {
@@ -40,6 +44,7 @@ import {
     AL_VOLATILE_SESSION_MAX_BYTES,
     ALVolatileSessionBudget
 } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
+import type { StateScope } from '@shared/api/state-types.ts';
 import {
     newALUnicastMessage,
     type ALMessage,
@@ -61,18 +66,25 @@ import {
 import { createDefaultVolatileSessionBudget } from '../default-volatile-session-budget.ts';
 
 const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);
+const SCOPE = defaultStateScope();
+const OTHER_SCOPE: StateScope = { applicationId: 'other-app', workspaceId: 'other-workspace' };
+// The names are spelled out so a change to the naming scheme fails here first.
+const SCOPE_DB_NAME = 'rallar-al-runtime:rallar-server:default';
+const OTHER_SCOPE_DB_NAME = 'rallar-al-runtime:other-app:other-workspace';
+const LEGACY_DB_NAME = 'ar-eye-hunter-al-runtime';
 
 describe('Browser AL runtime IndexedDB stores', () => {
     beforeEach(async () => {
         vi.useRealTimers();
-        await deleteBrowserALRuntimeDatabase();
+        await deleteEveryIndexedDbDatabase();
     });
 
     afterEach(async () => {
         vi.clearAllTimers();
         vi.useRealTimers();
         vi.restoreAllMocks();
-        await deleteBrowserALRuntimeDatabase();
+        showIndexedDbDatabaseListing();
+        await deleteEveryIndexedDbDatabase();
     });
 
     it('evicts expired rows only for the scanned browser session prefix', async () => {
@@ -87,11 +99,11 @@ describe('Browser AL runtime IndexedDB stores', () => {
         const currentSessionId = `current-${crypto.randomUUID()}`;
         const oldSessionId = `old-${crypto.randomUUID()}`;
         const unrelatedRuntimeName = `unrelated-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(currentSessionId, { retention, diagnosticsPorts });
-        configureBrowserALRuntimeStores(oldSessionId, { retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(currentSessionId, { scope: SCOPE, retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(oldSessionId, { scope: SCOPE, retention, diagnosticsPorts });
         const currentAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(currentSessionId).admissionStore;
         const oldAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(oldSessionId).admissionStore;
-        const unrelatedAdmissionStore = createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { retention }).admissionStore;
+        const unrelatedAdmissionStore = createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { dbName: SCOPE_DB_NAME, retention }).admissionStore;
         const currentExpiredMsgId = 'current-expired';
         const currentFreshMsgId = 'current-fresh';
         const oldExpiredMsgId = 'old-expired';
@@ -134,7 +146,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         ]);
 
         const freshSessionId = `fresh-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(freshSessionId, { retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(freshSessionId, { scope: SCOPE, retention, diagnosticsPorts });
         const freshSessionAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(freshSessionId).admissionStore;
 
         expect(await readSentMessageIds(freshSessionAdmissionStore)).toEqual([]);
@@ -152,8 +164,8 @@ describe('Browser AL runtime IndexedDB stores', () => {
         };
         const sessionId = `restore-${crypto.randomUUID()}`;
         const replacementSessionId = `replacement-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(sessionId, { retention, diagnosticsPorts });
-        configureBrowserALRuntimeStores(replacementSessionId, { retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(replacementSessionId, { scope: SCOPE, retention, diagnosticsPorts });
         const firstSessionAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore;
         const persistedMsgId = 'restore-unexpired';
 
@@ -178,11 +190,11 @@ describe('Browser AL runtime IndexedDB stores', () => {
         const currentSessionId = `cleanup-current-${crypto.randomUUID()}`;
         const oldSessionId = `cleanup-old-${crypto.randomUUID()}`;
         const unrelatedRuntimeName = `cleanup-unrelated-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(currentSessionId, { retention, diagnosticsPorts });
-        configureBrowserALRuntimeStores(oldSessionId, { retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(currentSessionId, { scope: SCOPE, retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(oldSessionId, { scope: SCOPE, retention, diagnosticsPorts });
         const currentAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(currentSessionId).admissionStore;
         const oldAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(oldSessionId).admissionStore;
-        const unrelatedAdmissionStore = createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { retention }).admissionStore;
+        const unrelatedAdmissionStore = createBrowserALOutboundRuntimeStores(unrelatedRuntimeName, { dbName: SCOPE_DB_NAME, retention }).admissionStore;
         const nonBrowserKey = 'custom:outside-browser-al-runtime:expired';
 
         await persistSentMessage(currentAdmissionStore, 'current-expired');
@@ -208,10 +220,10 @@ describe('Browser AL runtime IndexedDB stores', () => {
         );
         const unrelatedSentPrefix = toBrowserOutboundSentPrefix(unrelatedRuntimeName);
 
-        const result = await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
+        const result = await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });
 
         expect(result).toMatchObject({
-            dbName: BROWSER_AL_RUNTIME_DB_NAME,
+            dbNames: [SCOPE_DB_NAME],
             storeName: BROWSER_AL_RUNTIME_STORE_NAME,
             keyPrefixes: ['browser:'],
             // AL_OUTBOUND work rows are expired via the QueueBox's own cleanupAsync sweep now,
@@ -237,6 +249,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
 
         const runtimeName = `indexed-cleanup-${crypto.randomUUID()}`;
         const admissionStore = createBrowserALOutboundRuntimeStores(runtimeName, {
+            dbName: SCOPE_DB_NAME,
             retention: { sentMessageTtlMs: 20, controlHistoryTtlMs: 20, msgOwnerTtlMs: 20 }
         }).admissionStore;
         await persistSentMessage(admissionStore, 'expired');
@@ -246,7 +259,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
             throw new Error('Periodic expiry cleanup must not scan the complete object store');
         });
 
-        const result = await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
+        const result = await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });
 
         // The AL_OUTBOUND work row's own expiry now goes through cleanupAsync, off this count.
         expect(result.deleted).toBe(2);
@@ -259,7 +272,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         { label: 'negative-zero expiry', expireAtTimestamp: -0 }
     ])('preserves a corrupt browser admission row with $label', async ({ expireAtTimestamp }) => {
         const sessionId = `corrupt-cleanup-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
         await resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore.ready();
         const key = `${toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId))}:corrupt`;
         await putRawBrowserALRuntimeEntry({
@@ -270,6 +283,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
 
         await expect(
             deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
+                currentScope: SCOPE,
                 storage: diagnosticsPorts.storage
             })
         ).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
@@ -287,8 +301,8 @@ describe('Browser AL runtime IndexedDB stores', () => {
         };
         const targetSessionId = `expired-target-${crypto.randomUUID()}`;
         const otherSessionId = `expired-other-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(targetSessionId, { retention, diagnosticsPorts });
-        configureBrowserALRuntimeStores(otherSessionId, { retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(targetSessionId, { scope: SCOPE, retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(otherSessionId, { scope: SCOPE, retention, diagnosticsPorts });
         const targetAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId).admissionStore;
         const otherAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(otherSessionId).admissionStore;
 
@@ -306,6 +320,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         );
 
         const result = await deleteExpiredBrowserALRuntimeEntriesForSession(targetSessionId, {
+            currentScope: SCOPE,
             storage: diagnosticsPorts.storage
         });
 
@@ -328,10 +343,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         const sessionId = `owner-retention-${crypto.randomUUID()}`;
         const msgId = 'browser-owner-short-lived';
         const expireAtTimestamp = Date.now() + 15_000;
-        configureBrowserALRuntimeStores(sessionId, {
-            retention: { msgOwnerTtlMs: 15_000, controlHistoryTtlMs: 15_000 },
-            diagnosticsPorts
-        });
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, retention: { msgOwnerTtlMs: 15_000, controlHistoryTtlMs: 15_000 }, diagnosticsPorts });
         const stores = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
         await stores.admissionStore.commitBundle({
             senderId: sessionId,
@@ -360,6 +372,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         await vi.advanceTimersByTimeAsync(15_001);
 
         const result = await deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
+            currentScope: SCOPE,
             storage: diagnosticsPorts.storage
         });
 
@@ -376,8 +389,8 @@ describe('Browser AL runtime IndexedDB stores', () => {
         };
         const targetSessionId = `purge-target-${crypto.randomUUID()}`;
         const otherSessionId = `purge-other-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(targetSessionId, { retention, diagnosticsPorts });
-        configureBrowserALRuntimeStores(otherSessionId, { retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(targetSessionId, { scope: SCOPE, retention, diagnosticsPorts });
+        configureBrowserALRuntimeStores(otherSessionId, { scope: SCOPE, retention, diagnosticsPorts });
         const targetWsAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId).admissionStore;
         const targetOverlayAdmissionStore = resolveBrowserRtcOverlayALOutboundRuntimeStores(targetSessionId).admissionStore;
         const otherAdmissionStore = resolveBrowserWsClientALOutboundRuntimeStores(otherSessionId).admissionStore;
@@ -412,6 +425,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         );
 
         const result = await deleteBrowserALRuntimeEntriesForSession(targetSessionId, {
+            currentScope: SCOPE,
             storage: diagnosticsPorts.storage
         });
 
@@ -425,11 +439,145 @@ describe('Browser AL runtime IndexedDB stores', () => {
         ]);
     });
 
+    it('names one database per scope', () => {
+        expect(toBrowserALRuntimeDbName(SCOPE)).toBe(SCOPE_DB_NAME);
+        expect(toBrowserALRuntimeDbName(OTHER_SCOPE)).toBe(OTHER_SCOPE_DB_NAME);
+    });
+
+    // Scope ids carry no pattern, so a colon inside one must not let two scopes share a database.
+    it('encodes each scope part, so a colon inside an id names a database of its own', () => {
+        expect(toBrowserALRuntimeDbName({ applicationId: 'a:b', workspaceId: 'c' })).toBe('rallar-al-runtime:a%3Ab:c');
+        expect(toBrowserALRuntimeDbName({ applicationId: 'a', workspaceId: 'b:c' })).toBe('rallar-al-runtime:a:b%3Ac');
+    });
+
+    it('keeps two scopes of one session in disjoint databases', async () => {
+        vi.useFakeTimers({ toFake: ['Date'] });
+        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
+        const sessionId = `two-scopes-${crypto.randomUUID()}`;
+        const sentPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId));
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
+        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'first-scope');
+
+        configureBrowserALRuntimeStores(sessionId, { scope: OTHER_SCOPE, diagnosticsPorts });
+        const otherScopeStore = resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore;
+        expect(await otherScopeStore.readSentMessage('first-scope')).toBeUndefined();
+        await persistSentMessage(otherScopeStore, 'other-scope');
+
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
+        const firstScopeStore = resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore;
+        expect(await firstScopeStore.readSentMessage('first-scope')).toBeDefined();
+        expect(await firstScopeStore.readSentMessage('other-scope')).toBeUndefined();
+        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([`${sentPrefix}:first-scope`]);
+        expect(await readBrowserALRuntimeEntryKeys(sentPrefix, OTHER_SCOPE_DB_NAME)).toEqual([
+            `${sentPrefix}:other-scope`
+        ]);
+    });
+
+    it('purges one session\'s rows from every scope\'s database', async () => {
+        vi.useFakeTimers({ toFake: ['Date'] });
+        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
+        const targetSessionId = `scoped-purge-target-${crypto.randomUUID()}`;
+        const otherSessionId = `scoped-purge-other-${crypto.randomUUID()}`;
+        const targetPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(targetSessionId));
+        const otherPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(otherSessionId));
+        configureBrowserALRuntimeStores(otherSessionId, { scope: SCOPE, diagnosticsPorts });
+        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(otherSessionId).admissionStore, 'other');
+        configureBrowserALRuntimeStores(targetSessionId, { scope: SCOPE, diagnosticsPorts });
+        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId).admissionStore, 'first');
+        configureBrowserALRuntimeStores(targetSessionId, { scope: OTHER_SCOPE, diagnosticsPorts });
+        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(targetSessionId).admissionStore, 'second');
+
+        const result = await deleteBrowserALRuntimeEntriesForSession(targetSessionId, {
+            currentScope: SCOPE,
+            storage: diagnosticsPorts.storage
+        });
+
+        expect([...result.dbNames].sort()).toEqual([OTHER_SCOPE_DB_NAME, SCOPE_DB_NAME]);
+        expect(await readBrowserALRuntimeEntryKeys(targetPrefix)).toEqual([]);
+        expect(await readBrowserALRuntimeEntryKeys(targetPrefix, OTHER_SCOPE_DB_NAME)).toEqual([]);
+        expect(await readBrowserALRuntimeEntryKeys(otherPrefix)).toEqual([`${otherPrefix}:other`]);
+    });
+
+    it('purges the current scope\'s database only where the browser cannot list its databases', async () => {
+        vi.useFakeTimers({ toFake: ['Date'] });
+        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
+        hideIndexedDbDatabaseListing();
+        const sessionId = `unlisted-purge-${crypto.randomUUID()}`;
+        const sentPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId));
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
+        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'first');
+        configureBrowserALRuntimeStores(sessionId, { scope: OTHER_SCOPE, diagnosticsPorts });
+        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'second');
+
+        const result = await deleteBrowserALRuntimeEntriesForSession(sessionId, {
+            currentScope: OTHER_SCOPE,
+            storage: diagnosticsPorts.storage
+        });
+
+        expect(result.dbNames).toEqual([OTHER_SCOPE_DB_NAME]);
+        expect(await readBrowserALRuntimeEntryKeys(sentPrefix, OTHER_SCOPE_DB_NAME)).toEqual([]);
+        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([`${sentPrefix}:first`]);
+    });
+
+    it('leaves the legacy database and its rows where they are', async () => {
+        vi.useFakeTimers({ toFake: ['Date'] });
+        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
+        const sessionId = `legacy-${crypto.randomUUID()}`;
+        const legacyKey = `${toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId))}:legacy`;
+        const legacyDb = await openIndexedDbAdmissionDatabase({
+            dbName: LEGACY_DB_NAME,
+            storeName: BROWSER_AL_RUNTIME_STORE_NAME,
+            schemaId: AL_ADMISSION_SCHEMA_ID,
+            onStorageReset: () => {}
+        });
+        legacyDb.close();
+        const legacyRow = { key: legacyKey, value: { msgId: 'legacy' }, expireAtTimestamp: 1, writeToken: 'legacy', revision: 1 };
+        await putRawBrowserALRuntimeEntry(legacyRow, LEGACY_DB_NAME);
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
+        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'scoped');
+
+        await deleteBrowserALRuntimeEntriesForSession(sessionId, {
+            currentScope: SCOPE,
+            storage: diagnosticsPorts.storage
+        });
+        await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });
+
+        expect(await readIndexedDbDatabaseNames()).toEqual([LEGACY_DB_NAME, SCOPE_DB_NAME]);
+        expect(await readBrowserALRuntimeEntry(legacyKey, LEGACY_DB_NAME)).toEqual(legacyRow);
+    });
+
+    it('sweeps every scope\'s database before it reports the first failure', async () => {
+        vi.useFakeTimers({ toFake: ['Date'] });
+        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
+        const sessionId = `failing-scope-${crypto.randomUUID()}`;
+        const sentPrefix = toBrowserOutboundSentPrefix(toBrowserWsClientALRuntimeStoreId(sessionId));
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
+        await resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore.ready();
+        await putRawBrowserALRuntimeEntry({ key: `${sentPrefix}:corrupt`, value: { msgId: 'corrupt' } });
+        configureBrowserALRuntimeStores(sessionId, {
+            scope: OTHER_SCOPE,
+            retention: { sentMessageTtlMs: 20, controlHistoryTtlMs: 20, msgOwnerTtlMs: 20 },
+            diagnosticsPorts
+        });
+        await persistSentMessage(resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore, 'expired');
+        await vi.advanceTimersByTimeAsync(21);
+
+        await expect(
+            deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
+                currentScope: SCOPE,
+                storage: diagnosticsPorts.storage
+            })
+        ).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
+
+        expect(await readBrowserALRuntimeEntryKeys(sentPrefix, OTHER_SCOPE_DB_NAME)).toEqual([]);
+        expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([`${sentPrefix}:corrupt`]);
+    });
+
     it('does not delete a generic persistence row refreshed after cleanup reads it', async () => {
         const sessionId = `cleanup-race-${crypto.randomUUID()}`;
         const keyPrefix = `${toBrowserALRuntimeEntryKeyPrefix(toBrowserSessionALInboundRuntimeStoreId(sessionId))}inbound:admission`;
         const key = `${keyPrefix}:refreshed`;
-        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
         await resolveBrowserWsClientALOutboundRuntimeStores(sessionId).admissionStore.ready();
         await putRawBrowserALRuntimeEntry({
             key,
@@ -464,6 +612,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         await expect(
             deleteExpiredBrowserALRuntimeEntriesForSession(sessionId, {
                 nowMs: 100,
+                currentScope: SCOPE,
                 storage: diagnosticsPorts.storage
             })
         ).rejects.toThrow('cleanup conflicted');
@@ -475,7 +624,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         });
     });
 
-    it('initialises repeated browser AL runtime expiry eviction', async () => {
+    it('initialises repeated browser AL runtime expiry eviction over every scope\'s database', async () => {
         vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
         vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
 
@@ -485,18 +634,25 @@ describe('Browser AL runtime IndexedDB stores', () => {
             msgOwnerTtlMs: 20
         };
         const runtimeName = `interval-runtime-${crypto.randomUUID()}`;
-        const admissionStore = createBrowserALOutboundRuntimeStores(runtimeName, { retention }).admissionStore;
+        const admissionStore = createBrowserALOutboundRuntimeStores(runtimeName, { dbName: SCOPE_DB_NAME, retention }).admissionStore;
+        const otherScopeAdmissionStore = createBrowserALOutboundRuntimeStores(runtimeName, {
+            dbName: OTHER_SCOPE_DB_NAME,
+            retention
+        }).admissionStore;
         const sentPrefix = toBrowserOutboundSentPrefix(runtimeName);
 
         await persistSentMessage(admissionStore, 'initial-expired');
+        await persistSentMessage(otherScopeAdmissionStore, 'other-scope-expired');
         await vi.advanceTimersByTimeAsync(21);
 
         const stop = await initBrowserALRuntimeExpiryEviction({
+            currentScope: SCOPE,
             storage: diagnosticsPorts.storage,
             intervalMs: 50
         });
         try {
             expect(await readBrowserALRuntimeEntryKeys(sentPrefix)).toEqual([]);
+            expect(await readBrowserALRuntimeEntryKeys(sentPrefix, OTHER_SCOPE_DB_NAME)).toEqual([]);
 
             await persistSentMessage(admissionStore, 'interval-expired');
             await vi.advanceTimersByTimeAsync(21);
@@ -516,6 +672,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         const observer = createCountingIndexedDbOperationObserver();
         const sessionId = `observer-${crypto.randomUUID()}`;
         configureBrowserALRuntimeStores(sessionId, {
+            scope: SCOPE,
             diagnosticsPorts: {
                 submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
                 transportFaultPort: createPassThroughTransportFaultPort(),
@@ -535,7 +692,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
     // Each store states its reset and its health under its own id, and every resolve of it shares one health.
     it('names each store on the reset and the health it states through the storage port', async () => {
         const seeded = await openIndexedDbAdmissionDatabase({
-            dbName: BROWSER_AL_RUNTIME_DB_NAME,
+            dbName: SCOPE_DB_NAME,
             storeName: BROWSER_AL_RUNTIME_STORE_NAME,
             schemaId: 'rallar-alm-previous',
             onStorageReset: () => {}
@@ -545,6 +702,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         const sessionId = `storage-port-${crypto.randomUUID()}`;
         const wsClientId = toBrowserWsClientALRuntimeStoreId(sessionId);
         configureBrowserALRuntimeStores(sessionId, {
+            scope: SCOPE,
             diagnosticsPorts: toRallarDiagnosticsPorts({ storage: (event) => events.push(event) })
         });
         const stores = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
@@ -560,7 +718,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
                 kind: 'reset',
                 storeId: wsClientId,
                 event: {
-                    dbName: BROWSER_AL_RUNTIME_DB_NAME,
+                    dbName: SCOPE_DB_NAME,
                     previousSchemaId: 'rallar-alm-previous',
                     schemaId: AL_ADMISSION_SCHEMA_ID,
                     reason: 'schema-id-mismatch'
@@ -610,7 +768,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
 
     it('keeps the session inbound memory pair out of IndexedDB, so session cleanup never reaches it', async () => {
         const sessionId = `inbound-memory-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
+        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
         const volatile = createBrowserALVolatileInboundRuntimeStores(
             toBrowserSessionALInboundRuntimeStoreId(sessionId),
             createDefaultVolatileSessionBudget()
@@ -622,7 +780,7 @@ describe('Browser AL runtime IndexedDB stores', () => {
         expect(volatile.admissionStore.namespace).toBe(
             `browser:${toBrowserSessionALInboundRuntimeStoreId(sessionId)}:volatile:inbound:admission`
         );
-        await deleteBrowserALRuntimeEntriesForSession(sessionId, { storage: diagnosticsPorts.storage });
+        await deleteBrowserALRuntimeEntriesForSession(sessionId, { currentScope: SCOPE, storage: diagnosticsPorts.storage });
         expect(await volatile.workQueue.getAllKeys()).toHaveLength(1);
     });
 });
@@ -681,9 +839,10 @@ function toBrowserOutboundSentPrefix(runtimeStoreName: string): string {
 }
 
 async function readBrowserALRuntimeEntryKeys(
-    keyPrefix: string
+    keyPrefix: string,
+    dbName = SCOPE_DB_NAME
 ): Promise<readonly string[]> {
-    const db = await openBrowserALRuntimeDatabase();
+    const db = await openBrowserALRuntimeDatabase(dbName);
 
     try {
         return await new Promise<readonly string[]>((resolve, reject) => {
@@ -724,8 +883,8 @@ async function readBrowserALRuntimeEntryKeys(
     }
 }
 
-async function putRawBrowserALRuntimeEntry(entry: object): Promise<void> {
-    const db = await openBrowserALRuntimeDatabase();
+async function putRawBrowserALRuntimeEntry(entry: object, dbName = SCOPE_DB_NAME): Promise<void> {
+    const db = await openBrowserALRuntimeDatabase(dbName);
     try {
         await new Promise<void>((resolve, reject) => {
             const tx = db.transaction(BROWSER_AL_RUNTIME_STORE_NAME, 'readwrite');
@@ -740,8 +899,8 @@ async function putRawBrowserALRuntimeEntry(entry: object): Promise<void> {
     }
 }
 
-async function readBrowserALRuntimeEntry(key: string): Promise<IDBRequest['result']> {
-    const db = await openBrowserALRuntimeDatabase();
+async function readBrowserALRuntimeEntry(key: string, dbName = SCOPE_DB_NAME): Promise<IDBRequest['result']> {
+    const db = await openBrowserALRuntimeDatabase(dbName);
     try {
         return await new Promise((resolve, reject) => {
             const tx = db.transaction(BROWSER_AL_RUNTIME_STORE_NAME, 'readonly');
@@ -755,9 +914,9 @@ async function readBrowserALRuntimeEntry(key: string): Promise<IDBRequest['resul
     }
 }
 
-async function openBrowserALRuntimeDatabase(): Promise<IDBDatabase> {
+async function openBrowserALRuntimeDatabase(dbName: string): Promise<IDBDatabase> {
     return await new Promise<IDBDatabase>((resolve, reject) => {
-        const request = indexedDB.open(BROWSER_AL_RUNTIME_DB_NAME);
+        const request = indexedDB.open(dbName);
 
         request.onerror = () =>
             reject(
@@ -776,9 +935,17 @@ async function openBrowserALRuntimeDatabase(): Promise<IDBDatabase> {
     });
 }
 
-async function deleteBrowserALRuntimeDatabase(): Promise<void> {
+async function deleteEveryIndexedDbDatabase(): Promise<void> {
+    for (const { name } of await indexedDB.databases()) {
+        if (name !== undefined) {
+            await deleteIndexedDbDatabase(name);
+        }
+    }
+}
+
+async function deleteIndexedDbDatabase(dbName: string): Promise<void> {
     await new Promise<void>((resolve, reject) => {
-        const request = indexedDB.deleteDatabase(BROWSER_AL_RUNTIME_DB_NAME);
+        const request = indexedDB.deleteDatabase(dbName);
 
         request.onsuccess = () => resolve();
         request.onerror = () =>
@@ -791,3 +958,17 @@ async function deleteBrowserALRuntimeDatabase(): Promise<void> {
             );
     });
 }
+
+/** Hides `indexedDB.databases()`, as a browser without it would, until the suite's `afterEach` shows it again. */
+function hideIndexedDbDatabaseListing(): void {
+    Object.defineProperty(indexedDB, 'databases', { configurable: true, value: undefined });
+}
+
+function showIndexedDbDatabaseListing(): void {
+    Reflect.deleteProperty(indexedDB, 'databases');
+}
+
+async function readIndexedDbDatabaseNames(): Promise<readonly string[]> {
+    const databases = await indexedDB.databases();
+    return databases.flatMap(({ name }) => name === undefined ? [] : [name]).sort();
+}
```

Then apply this change to `packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts`, and the
`dbNames` result shape to `browser-auth-session-contract-fixture.ts`. Four new tests:

- a login that replaces the session purges the old session after the disconnect, with the default
  scope;
- a renewal that keeps the session id purges nothing;
- a session switch in `connect` purges the previous session after the disconnect;
- a failed purge emits `health` `failing` for each of the session's three store ids, with the
  classified `lastFailure` (`{ cause: 'quota', detail: 'QuotaExceededError: quota exceeded' }`). The
  logout still resolves and disconnects. This test uses a facade scope, `purge-app`.

They read an ordered step log, not mock call counts, so the structure-coupling gate stays clean.

```diff
--- a/packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts
+++ b/packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts
@@ -1,5 +1,7 @@
+import { toBrowserSessionALRuntimeStoreIds } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
 import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type { RallarWsLifecycleEvent } from '@shared-web/browser/rallar-realtime-facade.ts';
+import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
 import {
     beforeEach,
     describe,
@@ -85,7 +87,7 @@ describe('Rallar auth logout and transport cleanup contract', () => {
             async (sessionId) => {
                 deletedSessionIds.push(sessionId);
                 return {
-                    dbName: 'rallar-browser-al-runtime',
+                    dbNames: ['rallar-al-runtime:rallar-server:default'],
                     storeName: 'entries',
                     keyPrefixes: [],
                     scanned: 0,
@@ -101,6 +103,72 @@ describe('Rallar auth logout and transport cleanup contract', () => {
         expect(deletedSessionIds).toEqual(['session-1']);
     });
 
+    it('purges the replaced session\'s browser AL runtime rows after the disconnect when a login replaces it', async () => {
+        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
+        const steps = recordDisconnectAndPurgeSteps();
+        let currentSession = mocks.ctx.session;
+        mocks.readSession.mockImplementation(() => currentSession);
+        mocks.writeSession.mockImplementation((session) => {
+            currentSession = session;
+        });
+        mocks.loginToApi.mockResolvedValue({ ...mocks.ctx.session, sessionId: 'session-2', accessToken: 'token-2' });
+        const facade = createRallarFacade();
+        await facade.connect();
+
+        await facade.auth.login({ username: 'principal-2', password: 'password-2' });
+
+        expect(steps).toEqual(['disconnect', 'purge:session-1 in rallar-server:default']);
+    });
+
+    it('keeps the rows when a login renews the session it already holds', async () => {
+        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
+        const steps = recordDisconnectAndPurgeSteps();
+        mocks.loginToApi.mockResolvedValue({ ...mocks.ctx.session, accessToken: 'renewed' });
+        const facade = createRallarFacade();
+        await facade.connect();
+
+        await facade.auth.login({ username: 'principal-1', password: 'password-1' });
+
+        expect(steps).toEqual(['disconnect']);
+    });
+
+    it('purges the previous session\'s browser AL runtime rows after the disconnect when connect switches sessions', async () => {
+        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
+        const steps = recordDisconnectAndPurgeSteps();
+        let currentSession = mocks.ctx.session;
+        mocks.readSession.mockImplementation(() => currentSession);
+        const facade = createRallarFacade();
+        await facade.connect();
+        currentSession = { ...mocks.ctx.session, sessionId: 'session-2', accessToken: 'token-2' };
+
+        await facade.connect();
+
+        expect(steps).toEqual(['disconnect', 'purge:session-1 in rallar-server:default']);
+    });
+
+    it('reports a failed purge as failing storage health and still ends the session', async () => {
+        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
+        const events: ALStorageEvent[] = [];
+        const steps = recordDisconnectAndPurgeSteps(new DOMException('quota exceeded', 'QuotaExceededError'));
+        const facade = createRallarFacade();
+        facade.setDefaults({ applicationId: 'purge-app', diagnosticsPorts: { storage: (event) => events.push(event) } });
+        await facade.connect();
+
+        await expect(facade.auth.logout()).resolves.toBeUndefined();
+
+        expect(steps).toEqual(['disconnect', 'purge:session-1 in purge-app:default']);
+        expect(facade.isConnected()).toBe(false);
+        expect(events).toEqual(
+            toBrowserSessionALRuntimeStoreIds('session-1').map((storeId) => ({
+                kind: 'health',
+                storeId,
+                status: 'failing',
+                lastFailure: { cause: 'quota', detail: 'QuotaExceededError: quota exceeded' },
+                lastRecoveryPointAtMs: undefined
+            }))
+        );
+    });
+
     it('does not reconnect with a stale session while manual logout is in progress', async () => {
         const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
         let storedSession: typeof mocks.ctx.session | undefined = mocks.ctx.session;
@@ -347,3 +415,19 @@ describe('Rallar auth logout and transport cleanup contract', () => {
         });
     });
 });
+
+/** Logs each disconnect and each purge with the scope it would cover; a given failure rejects every purge. */
+function recordDisconnectAndPurgeSteps(purgeFailure?: Error): string[] {
+    const steps: string[] = [];
+    mocks.webSocketQueueBox.close.mockImplementation(() => {
+        steps.push('disconnect');
+    });
+    mocks.deleteBrowserALRuntimeEntriesForSession.mockImplementation(async (sessionId, options) => {
+        steps.push(`purge:${sessionId} in ${options.currentScope.applicationId}:${options.currentScope.workspaceId}`);
+        if (purgeFailure) {
+            throw purgeFailure;
+        }
+        return { dbNames: [], storeName: 'entries', keyPrefixes: [], scanned: 0, deleted: 0 };
+    });
+    return steps;
+}
--- a/packages/tests/shared-web/session/browser-auth-session-contract-fixture.ts
+++ b/packages/tests/shared-web/session/browser-auth-session-contract-fixture.ts
@@ -26,7 +26,7 @@ const mocks = await vi.hoisted(async () => {
         onCacheChange: vi.fn<ContractModules.StateCacheLifecycle['browserStateCacheLifecycle']['onChange']>(() => vi.fn()),
         deleteBrowserALRuntimeEntriesForSession: vi.fn<ContractModules.BrowserALRuntimeCleanup['deleteBrowserALRuntimeEntriesForSession']>(() =>
             Promise.resolve({
-                dbName: '',
+                dbNames: [],
                 storeName: '',
                 keyPrefixes: [],
                 scanned: 0,
@@ -185,7 +185,7 @@ function resetSessionAndRoomMocks(): void {
     mocks.readSession.mockReturnValue(mocks.ctx.session);
     mocks.logoutFromApi.mockResolvedValue({ loggedOut: true });
     mocks.deleteBrowserALRuntimeEntriesForSession.mockResolvedValue({
-        dbName: 'rallar-browser-al-runtime',
+        dbNames: ['rallar-al-runtime:rallar-server:default'],
         storeName: 'entries',
         keyPrefixes: [],
         scanned: 0,
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts
```

Expected (measured on Task 5's assembled commit `b67e43022`): `Test Files  2 failed (2)`,
`Tests  23 failed | 15 passed (38)`.

- 20 failures in the stores file:
  - every case that reads or writes a scope database, Task 2's storage-port case included, because
    production still opens `ar-eye-hunter-al-runtime`;
  - `names one database per scope` and the encoding case, with `toBrowserALRuntimeDbName is not a function`.
- 3 session failures: the two purge-order tests and the health test.
- 15 passes, five in the stores file and ten in the session file.
  - Stores file: the two memory-pair cases, the budget case, the observer case and the expiry-index
    case. The store factories still override `dbName`, so the last two run against the legacy
    database.
  - Session file: its nine existing cases, plus the renewal test, which holds before and after.

- [ ] **Step 3: Name the database per scope in `browser-al-runtime-identity.ts`.**

```diff
diff --git a/packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts b/packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts
@@ -3,12 +3,19 @@ import {
     type ALRuntimeStoreId
 } from '@shared/alm/ALRuntimeStoreRegistry.ts';
 import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
+import type { StateScope } from '@shared/api/state-types.ts';
 import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
 
-export const BROWSER_AL_RUNTIME_DB_NAME = 'ar-eye-hunter-al-runtime';
+export const BROWSER_AL_RUNTIME_DB_NAME_PREFIX = 'rallar-al-runtime:';
 export const BROWSER_AL_RUNTIME_STORE_NAME = IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
 export const BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX = 'browser:';
 
+/** One database per scope, each part encoded as `toStateScopeHttpPath` does; the keys inside stay session-scoped. */
+export function toBrowserALRuntimeDbName(scope: StateScope): string {
+    const applicationId = encodeURIComponent(scope.applicationId);
+    return `${BROWSER_AL_RUNTIME_DB_NAME_PREFIX}${applicationId}:${encodeURIComponent(scope.workspaceId)}`;
+}
+
 /** One inbound admission store per browser session, whichever carrier delivered the message (S2b). */
 export function toBrowserSessionALInboundRuntimeStoreId(
     sessionId: string
@@ -33,18 +40,25 @@ export function toBrowserALRuntimeEntryKeyPrefix(name: string): string {
     return `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${name}:`;
 }
 
-export function toBrowserSessionALRuntimeEntryKeyPrefixes(
+/** Every durable store one browser session owns: its inbound store and its two outbound stores. */
+export function toBrowserSessionALRuntimeStoreIds(
     sessionId: string
-): readonly string[] {
+): readonly ALRuntimeStoreId<ALOutboundTransportMessage>[] {
     return [
-        toBrowserALRuntimeEntryKeyPrefix(toBrowserSessionALInboundRuntimeStoreId(sessionId)),
-        toBrowserALRuntimeEntryKeyPrefix(toBrowserWsClientALRuntimeStoreId(sessionId)),
-        toBrowserALRuntimeEntryKeyPrefix(toBrowserRtcOverlayALRuntimeStoreId(sessionId))
+        toBrowserSessionALInboundRuntimeStoreId(sessionId),
+        toBrowserWsClientALRuntimeStoreId(sessionId),
+        toBrowserRtcOverlayALRuntimeStoreId(sessionId)
     ];
 }
 
+export function toBrowserSessionALRuntimeEntryKeyPrefixes(
+    sessionId: string
+): readonly string[] {
+    return toBrowserSessionALRuntimeStoreIds(sessionId).map(toBrowserALRuntimeEntryKeyPrefix);
+}
+
 /** The namespace an admission store built from this store id actually enqueues work under. */
-export function toBrowserALRuntimeNamespace(name: string): string {
+function toBrowserALRuntimeNamespace(name: string): string {
     return `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${name}`;
 }
```

- [ ] **Step 4: Pass the scope's name through the store composition in `browser-al-runtime-stores.ts`.**
      Only the `dbName` lines, the options contract and the `scope` destructuring change; Task 5's
      availability and Task 2's `storage` port stay as they are.

```diff
diff --git a/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts b/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
@@ -29,9 +29,10 @@ import {
 import { toALStorageResetSink, type ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
 import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
 import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
+import type { StateScope } from '@shared/api/state-types.ts';
 
 import {
-    BROWSER_AL_RUNTIME_DB_NAME,
+    toBrowserALRuntimeDbName,
     toBrowserRtcOverlayALRuntimeStoreId,
     toBrowserSessionALInboundRuntimeStoreId,
     toBrowserWsClientALRuntimeStoreId
@@ -42,10 +43,14 @@ import {
     toInitialALStorageAvailability
 } from './browser-al-storage-availability.ts';
 
-type BrowserALRuntimeOptions = Omit<CreateDefaultALRuntimeStoresInput, 'dbName' | 'namespace'>;
+interface BrowserALRuntimeOptions extends Omit<CreateDefaultALRuntimeStoresInput, 'dbName' | 'namespace'> {
+    readonly dbName: string;
+}
 
 export interface ConfigureBrowserALRuntimeStoresInput
-    extends Omit<BrowserALRuntimeOptions, 'observer' | 'onStorageReset' | 'storageHealth'> {
+    extends Omit<BrowserALRuntimeOptions, 'dbName' | 'observer' | 'onStorageReset' | 'storageHealth'> {
+    /** The scope the connect resolved; it names the database. */
+    readonly scope: StateScope;
     readonly diagnosticsPorts: RallarDiagnosticsPorts;
 }
 
@@ -120,25 +125,20 @@ function toBrowserStoreOptions(
 /** Always IndexedDB: without it the pair fails at open, and the connect's availability says `missing`. */
 export function createBrowserALInboundRuntimeStores(
     name: string,
-    options: BrowserALRuntimeOptions = {}
+    options: BrowserALRuntimeOptions
 ): ALInboundRuntimeStores {
-    return createDefaultIndexedDbALInboundRuntimeStores({
-        ...options,
-        dbName: BROWSER_AL_RUNTIME_DB_NAME,
-        namespace: `browser:${name}`
-    });
+    return createDefaultIndexedDbALInboundRuntimeStores({ ...options, namespace: `browser:${name}` });
 }
 
 /** Always IndexedDB: without it the pair fails at open, and the connect's availability says `missing`. */
 export function createBrowserALOutboundRuntimeStores(
     name: string,
-    options: BrowserALRuntimeOptions = {}
+    options: BrowserALRuntimeOptions
 ): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
     return createDefaultIndexedDbALOutboundRuntimeStores({
         ...options,
         namespace: `browser:${name}`,
-        decodePrepared: decodeALOutboundTransportMessage,
-        dbName: BROWSER_AL_RUNTIME_DB_NAME
+        decodePrepared: decodeALOutboundTransportMessage
     });
 }
 
@@ -170,9 +170,10 @@ export function configureBrowserALRuntimeStores(
     sessionId: string,
     input: ConfigureBrowserALRuntimeStoresInput
 ): BrowserALStorageAvailability {
-    const { diagnosticsPorts, ...options } = input;
+    const { diagnosticsPorts, scope, ...options } = input;
     const scoped: BrowserALRuntimeOptions = {
         ...options,
+        dbName: toBrowserALRuntimeDbName(scope),
         observer: diagnosticsPorts.indexedDbOperationObserver,
         canonicalScope: `browser-session:${sessionId}`
     };
```

- [ ] **Step 5: Sweep and purge every scope's database in `browser-al-runtime-cleanup.ts`.**

```diff
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts
@@ -11,6 +11,7 @@ import {
     writeIndexedDbAdmissionMutations,
     type IndexedDbAdmissionMutation
 } from '@shared/alm/write-indexed-db-admission-mutations.ts';
+import type { StateScope } from '@shared/api/state-types.ts';
 import type { StoredResourceEntry } from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
 import type { ComputedIndexedDbQueueMutation } from '@shared/queuebox/indexed-db-queue-box-entry.ts';
 import { jsonEquals } from '@shared/repository/state-utils.ts';
@@ -22,9 +23,10 @@ import {
 } from './browser-al-work-cleanup.ts';
 
 import {
-    BROWSER_AL_RUNTIME_DB_NAME,
+    BROWSER_AL_RUNTIME_DB_NAME_PREFIX,
     BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX,
     BROWSER_AL_RUNTIME_STORE_NAME,
+    toBrowserALRuntimeDbName,
     toBrowserSessionALRuntimeEntryKeyPrefixes,
     toBrowserSessionALRuntimeWorkNamespaces
 } from './browser-al-runtime-identity.ts';
@@ -63,7 +65,7 @@ export interface BrowserALRuntimeCleanupValidationIssue {
 }
 
 export interface BrowserALRuntimeCleanupResult {
-    readonly dbName: string;
+    readonly dbNames: readonly string[];
     readonly storeName: string;
     readonly keyPrefixes: readonly string[];
     readonly scanned: number;
@@ -71,28 +73,49 @@ export interface BrowserALRuntimeCleanupResult {
 }
 
 export interface DeleteExpiredBrowserALRuntimeEntriesOptions {
+    /** The one database swept where the browser cannot list its databases. */
+    readonly currentScope: StateScope;
     readonly storage: ALStorageEventSink;
     readonly nowMs?: number;
     readonly keyPrefixes?: readonly string[];
 }
 
+export interface DeleteBrowserALRuntimeEntriesForSessionOptions {
+    /** The one database purged where the browser cannot list its databases. */
+    readonly currentScope: StateScope;
+    readonly storage: ALStorageEventSink;
+}
+
+interface BrowserALRuntimeEntriesDeletion {
+    readonly keyPrefixes: readonly string[];
+    readonly workNamespaces: readonly string[];
+    readonly canonicalScopes: readonly string[];
+    readonly deletionPolicy: BrowserALRuntimeDeletionPolicy;
+    readonly storage: ALStorageEventSink;
+}
+
+interface BrowserALRuntimeCleanupCounts {
+    readonly scanned: number;
+    readonly deleted: number;
+}
+
 export async function deleteExpiredBrowserALRuntimeEntries(
     options: DeleteExpiredBrowserALRuntimeEntriesOptions
 ): Promise<BrowserALRuntimeCleanupResult> {
-    const nowMs = options.nowMs ?? Date.now();
-
-    return await deleteBrowserALRuntimeEntriesMatching({
+    return await deleteBrowserALRuntimeEntriesInEveryDatabase(options.currentScope, {
         keyPrefixes: options.keyPrefixes ?? [BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX],
-        deletionPolicy: { kind: 'expired', nowMs },
+        workNamespaces: [],
+        canonicalScopes: [],
+        deletionPolicy: { kind: 'expired', nowMs: options.nowMs ?? Date.now() },
         storage: options.storage
     });
 }
 
 /**
  * Deletes this session's expired KV admission-metadata rows only. AL work-row expiry is a side
- * effect of every call here, and it is store-wide (see `writeBrowserALWorkExpiryCleanup`): other
- * sessions' expired AL work rows are removed too, while their live rows and their expired KV rows
- * are untouched.
+ * effect of every call here, and it is store-wide in every scope's database (see
+ * `writeBrowserALWorkExpiryCleanup`): other sessions' expired AL work rows are removed too, while
+ * their live rows and their expired KV rows are untouched.
  */
 export async function deleteExpiredBrowserALRuntimeEntriesForSession(
     sessionId: string,
@@ -104,11 +127,12 @@ export async function deleteExpiredBrowserALRuntimeEntriesForSession(
     });
 }
 
+/** Deletes every row the session owns, in every scope's database. */
 export async function deleteBrowserALRuntimeEntriesForSession(
     sessionId: string,
-    options: Readonly<{ storage: ALStorageEventSink; }>
+    options: DeleteBrowserALRuntimeEntriesForSessionOptions
 ): Promise<BrowserALRuntimeCleanupResult> {
-    return await deleteBrowserALRuntimeEntriesMatching({
+    return await deleteBrowserALRuntimeEntriesInEveryDatabase(options.currentScope, {
         keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId),
         workNamespaces: toBrowserSessionALRuntimeWorkNamespaces(sessionId),
         canonicalScopes: [`browser-session:${sessionId}`],
@@ -129,6 +153,8 @@ export async function evictExpiredBrowserALRuntimeEntries(
 }
 
 export interface InitBrowserALRuntimeExpiryEvictionInput {
+    /** The one database swept where the browser cannot list its databases. */
+    readonly currentScope: StateScope;
     readonly storage: ALStorageEventSink;
     readonly intervalMs?: number;
 }
@@ -167,7 +193,10 @@ function startBrowserALRuntimeExpiryEviction(
     return tryRunInIntervals(
         async () => {
             if (!stopped) {
-                await evictExpiredBrowserALRuntimeEntries({ storage: input.storage });
+                await evictExpiredBrowserALRuntimeEntries({
+                    currentScope: input.currentScope,
+                    storage: input.storage
+                });
             }
         },
         input.intervalMs ?? BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS
@@ -179,56 +208,70 @@ function startBrowserALRuntimeExpiryEviction(
         });
 }
 
-/** The cleanup opens the whole database for no one store, so a reset it causes names the database. */
-function openBrowserALRuntimeDatabase(storage: ALStorageEventSink): Promise<IDBDatabase> {
-    return openIndexedDbAdmissionDatabase({
-        dbName: BROWSER_AL_RUNTIME_DB_NAME,
-        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
-        schemaId: AL_ADMISSION_SCHEMA_ID,
-        onStorageReset: toALStorageResetSink(storage, BROWSER_AL_RUNTIME_DB_NAME)
-    });
+/**
+ * Every scope's database this origin holds, or the current scope's alone where the browser cannot
+ * list them. The prefix leaves the pre-scope database out, so it stays until the browser evicts it.
+ */
+async function readBrowserALRuntimeDbNames(currentScope: StateScope): Promise<readonly string[]> {
+    if (typeof indexedDB.databases !== 'function') {
+        return [toBrowserALRuntimeDbName(currentScope)];
+    }
+    const databases = await indexedDB.databases();
+    return databases.flatMap(({ name }) => name?.startsWith(BROWSER_AL_RUNTIME_DB_NAME_PREFIX) ? [name] : []);
 }
 
-async function deleteBrowserALRuntimeEntriesMatching(
-    options: Readonly<{
-        keyPrefixes: readonly string[];
-        workNamespaces?: readonly string[];
-        canonicalScopes?: readonly string[];
-        deletionPolicy: BrowserALRuntimeDeletionPolicy;
-        storage: ALStorageEventSink;
-    }>
+/** A failing database does not keep the others from being swept; its failure is rethrown after them. */
+async function deleteBrowserALRuntimeEntriesInEveryDatabase(
+    currentScope: StateScope,
+    deletion: BrowserALRuntimeEntriesDeletion
 ): Promise<BrowserALRuntimeCleanupResult> {
-    const keyPrefixes = [...new Set(options.keyPrefixes)].filter((prefix) => prefix.length > 0);
-    const workNamespaces = options.workNamespaces ?? [];
-    const canonicalScopes = options.canonicalScopes ?? [];
-
+    const keyPrefixes = [...new Set(deletion.keyPrefixes)].filter((prefix) => prefix.length > 0);
     if (keyPrefixes.length === 0 || !isIndexedDbALRuntimeStoreSupported()) {
-        return toBrowserALRuntimeCleanupResult(keyPrefixes, 0, 0);
+        return toBrowserALRuntimeCleanupResult([], keyPrefixes, []);
     }
+    const dbNames = await readBrowserALRuntimeDbNames(currentScope);
+    const counts: BrowserALRuntimeCleanupCounts[] = [];
+    const failures: unknown[] = [];
+    for (const dbName of dbNames) {
+        try {
+            counts.push(await deleteBrowserALRuntimeEntriesInDatabase(dbName, { ...deletion, keyPrefixes }));
+        }
+        catch (error) {
+            failures.push(error);
+        }
+    }
+    if (failures.length > 0) {
+        throw failures[0];
+    }
+    return toBrowserALRuntimeCleanupResult(dbNames, keyPrefixes, counts);
+}
 
-    const db = await openBrowserALRuntimeDatabase(options.storage);
-
+/** The cleanup opens a whole database for no one store, so a reset it causes names the database. */
+async function deleteBrowserALRuntimeEntriesInDatabase(
+    dbName: string,
+    deletion: BrowserALRuntimeEntriesDeletion
+): Promise<BrowserALRuntimeCleanupCounts> {
+    const db = await openIndexedDbAdmissionDatabase({
+        dbName,
+        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
+        schemaId: AL_ADMISSION_SCHEMA_ID,
+        onStorageReset: toALStorageResetSink(deletion.storage, dbName)
+    });
     try {
-        if (options.deletionPolicy.kind === 'expired') {
-            await writeBrowserALWorkExpiryCleanup(db, options.deletionPolicy.nowMs);
+        if (deletion.deletionPolicy.kind === 'expired') {
+            await writeBrowserALWorkExpiryCleanup(db, deletion.deletionPolicy.nowMs);
         }
-        const read = await readBrowserALRuntimeCleanup(db, {
-            keyPrefixes,
-            workNamespaces,
-            canonicalScopes,
-            policy: options.deletionPolicy
-        });
-        const computed = computeBrowserALRuntimeCleanup(read, options.deletionPolicy);
-        const issues = validateBrowserALRuntimeCleanup(read, options.deletionPolicy, computed);
+        const read = await readBrowserALRuntimeCleanup(db, deletion);
+        const computed = computeBrowserALRuntimeCleanup(read, deletion.deletionPolicy);
+        const issues = validateBrowserALRuntimeCleanup(read, deletion.deletionPolicy, computed);
         if (issues.length > 0) {
             throw new TypeError(issues.map((issue) => issue.message).join('; '));
         }
         await writeBrowserALRuntimeCleanup(db, computed);
-        return toBrowserALRuntimeCleanupResult(
-            keyPrefixes,
-            read.rows.length + read.workRows.length,
-            computed.mutations.length + computed.queueMutations.length
-        );
+        return {
+            scanned: read.rows.length + read.workRows.length,
+            deleted: computed.mutations.length + computed.queueMutations.length
+        };
     }
     finally {
         db.close();
@@ -237,14 +280,9 @@ async function deleteBrowserALRuntimeEntriesMatching(
 
 async function readBrowserALRuntimeCleanup(
     db: IDBDatabase,
-    options: Readonly<{
-        keyPrefixes: readonly string[];
-        workNamespaces: readonly string[];
-        canonicalScopes: readonly string[];
-        policy: BrowserALRuntimeDeletionPolicy;
-    }>
+    deletion: Omit<BrowserALRuntimeEntriesDeletion, 'storage'>
 ): Promise<BrowserALRuntimeCleanupRead> {
-    const { keyPrefixes, workNamespaces, canonicalScopes, policy } = options;
+    const { keyPrefixes, workNamespaces, canonicalScopes, deletionPolicy: policy } = deletion;
     const readsExpiryIndex = policy.kind === 'expired' &&
         keyPrefixes.length === 1 &&
         keyPrefixes[0] === BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX;
@@ -397,16 +435,16 @@ async function writeBrowserALRuntimeCleanup(
 }
 
 function toBrowserALRuntimeCleanupResult(
+    dbNames: readonly string[],
     keyPrefixes: readonly string[],
-    scanned: number,
-    deleted: number
+    counts: readonly BrowserALRuntimeCleanupCounts[]
 ): BrowserALRuntimeCleanupResult {
     return {
-        dbName: BROWSER_AL_RUNTIME_DB_NAME,
+        dbNames,
         storeName: BROWSER_AL_RUNTIME_STORE_NAME,
         keyPrefixes,
-        scanned,
-        deleted
+        scanned: counts.reduce((total, count) => total + count.scanned, 0),
+        deleted: counts.reduce((total, count) => total + count.deleted, 0)
     };
 }
```

- [ ] **Step 6: Hand the connect's scope to the stores and the eviction loop in `initialise-browser-middleware.ts`.**
      `StateScope` (`:17`) and `defaultStateScope` (`:39`) are already imported; Task 5's `storageAvailability` stays.

```diff
diff --git a/packages/shared-web/browser/connection/initialise-browser-middleware.ts b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
--- a/packages/shared-web/browser/connection/initialise-browser-middleware.ts
+++ b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
@@ -207,7 +207,11 @@ export async function initialiseMiddleware(
     rtcSignalingTopicId: string,
     options: MiddlewareInitOptions
 ): Promise<RallarBrowserMiddleware> {
-    const storageAvailability = initialiseBrowserRuntimeStores(session.sessionId, options.diagnosticsPorts);
+    const storageAvailability = initialiseBrowserRuntimeStores(
+        session.sessionId,
+        options.scope ?? defaultStateScope(),
+        options.diagnosticsPorts
+    );
     const transportInput = createBrowserTransportInput(session, options);
     const webSocketTransport = await initialiseBrowserWebSocketTransport(transportInput);
     const rtcTransport = await initialiseBrowserRtcTransport({
@@ -274,11 +278,12 @@ export function createBrowserTransportInput(
 
 function initialiseBrowserRuntimeStores(
     sessionId: string,
+    scope: StateScope,
     diagnosticsPorts: RallarDiagnosticsPorts
 ): BrowserALStorageAvailability {
     initialiseBrowserCacheRepositories();
-    const storageAvailability = configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
-    initBrowserALRuntimeExpiryEviction({ storage: diagnosticsPorts.storage }).catch((error) =>
+    const storageAvailability = configureBrowserALRuntimeStores(sessionId, { scope, diagnosticsPorts });
+    initBrowserALRuntimeExpiryEviction({ currentScope: scope, storage: diagnosticsPorts.storage }).catch((error) =>
         console.error('Failed to initialise browser AL runtime expiry eviction:', toError(error))
     );
     return storageAvailability;
```

- [ ] **Step 7: Purge the replaced session and report a failed purge.** Create
      `packages/shared-web/browser/session/delete-ended-session-al-runtime-entries.ts`:

```ts
import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { toBrowserSessionALRuntimeStoreIds } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { toALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

export interface DeleteEndedSessionALRuntimeEntriesInput {
    /** The one database purged where the browser cannot list its databases. */
    readonly currentScope: StateScope;
    readonly diagnosticsPorts: RallarDiagnosticsPorts;
}

/**
 * Purges an ended session's rows from every scope's database. A failure leaves rows behind but
 * never keeps the session from ending, so each of the session's stores reports failing health.
 */
export async function deleteEndedSessionALRuntimeEntries(
    sessionId: string,
    input: DeleteEndedSessionALRuntimeEntriesInput
): Promise<void> {
    const { storage } = input.diagnosticsPorts;
    try {
        await deleteBrowserALRuntimeEntriesForSession(sessionId, {
            currentScope: input.currentScope,
            storage
        });
    }
    catch (error) {
        const lastFailure = toALStorageUnavailable(toError(error));
        for (const storeId of toBrowserSessionALRuntimeStoreIds(sessionId)) {
            storage({
                kind: 'health',
                storeId,
                status: 'failing',
                lastFailure,
                lastRecoveryPointAtMs: undefined
            });
        }
    }
}
```

Then change `packages/shared-web/browser/session/session-auth-lifecycle.ts`. The swallowing
`try {} catch { /* best-effort */ }` goes. The purge and its failure report sit in the module above,
which keeps this file under the cognitive-load warning tier. A first draft with the `try`/`catch`
and loop inline measured 51 and failed the changed-style gate.

```diff
--- a/packages/shared-web/browser/session/session-auth-lifecycle.ts
+++ b/packages/shared-web/browser/session/session-auth-lifecycle.ts
@@ -1,5 +1,5 @@
-import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
 import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import * as authApi from '@shared-web/browser/auth/session-http-api.ts';
 import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
 import type {
@@ -27,8 +27,10 @@ import {
     readSession,
     writeSession
 } from '@shared/api/auth.ts';
+import type { StateScope } from '@shared/api/state-types.ts';
 import { Command } from '@shared/cache/Command.ts';
 
+import { deleteEndedSessionALRuntimeEntries } from './delete-ended-session-al-runtime-entries.ts';
 import type { RallarSessionConnectionLifecycle } from './session-connection-lifecycle.ts';
 
 const MAX_AUTH_EXPIRY_TIMEOUT_MS = 2_147_483_647;
@@ -134,6 +136,7 @@ export class BrowserSessionAuthLifecycle implements RallarSessionAuthLifecycle {
         if (previousSession) {
             this.input.sessionDeliveries.endSession(previousSession);
             await this.input.closeDataScopes(previousSession);
+            await this.deleteReplacedSessionALRuntimeEntries(previousSession, session);
         }
         this.input.sessionDeliveries.beginSession(session);
         writeSession(session);
@@ -236,6 +239,7 @@ export class BrowserSessionAuthLifecycle implements RallarSessionAuthLifecycle {
         ) {
             this.input.sessionDeliveries.endSession(activeMiddleware.session);
             await this.disconnect();
+            await this.deleteReplacedSessionALRuntimeEntries(activeMiddleware.session, session);
         }
     }
 
@@ -310,15 +314,29 @@ export class BrowserSessionAuthLifecycle implements RallarSessionAuthLifecycle {
         diagnosticsPorts: RallarDiagnosticsPorts
     ): Promise<Error | undefined> {
         const dataCleanupError = await captureError(() => this.input.closeDataScopes(session));
-        try {
-            await deleteBrowserALRuntimeEntriesForSession(session.sessionId, {
-                storage: diagnosticsPorts.storage
+        await deleteEndedSessionALRuntimeEntries(session.sessionId, {
+            currentScope: this.resolveStorageScope(),
+            diagnosticsPorts
+        });
+        return dataCleanupError;
+    }
+
+    /** Rows are keyed by the session id alone, so a login that keeps the session id keeps its rows. */
+    private async deleteReplacedSessionALRuntimeEntries(
+        replaced: AuthSession,
+        replacement: AuthSession
+    ): Promise<void> {
+        if (replaced.sessionId !== replacement.sessionId) {
+            await deleteEndedSessionALRuntimeEntries(replaced.sessionId, {
+                currentScope: this.resolveStorageScope(),
+                diagnosticsPorts: this.readDiagnosticsPorts()
             });
         }
-        catch {
-            // Browser-local AL cleanup is best-effort.
-        }
-        return dataCleanupError;
+    }
+
+    /** The scope a connect without its own resolves; a purge covers its database where the browser cannot list them. */
+    private resolveStorageScope(): StateScope {
+        return this.input.connectionRuntime.resolveOperationScope() ?? defaultStateScope();
     }
 
     private resolveSession(session?: AuthSession): AuthSession | undefined {
```

- [ ] **Step 8: Move the remaining callers to the scope.** Two files read the database by name:

```diff
diff --git a/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts b/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts
--- a/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts
@@ -18,7 +18,7 @@ import {
     deleteExpiredBrowserALRuntimeEntriesForSession,
     initBrowserALRuntimeExpiryEviction
 } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
-import { BROWSER_AL_RUNTIME_DB_NAME, BROWSER_AL_RUNTIME_STORE_NAME } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
+import { BROWSER_AL_RUNTIME_STORE_NAME, toBrowserALRuntimeDbName } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
 import {
     configureBrowserALRuntimeStores,
     resolveBrowserSessionALInboundRuntimeStores,
@@ -28,6 +28,7 @@ import {
     readBrowserALWorkCleanupRows,
     writeBrowserALWorkExpiryCleanup
 } from '@shared-web/browser/al-runtime/browser-al-work-cleanup.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import {
     AL_ADMISSION_SCHEMA_ID,
@@ -60,6 +61,8 @@ interface RawWorkRow {
 }
 
 const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);
+const SCOPE = defaultStateScope();
+const SCOPE_DB_NAME = toBrowserALRuntimeDbName(SCOPE);
 
 describe('browser canonical outbound cleanup', () => {
     afterEach(() => {
@@ -77,12 +80,13 @@ describe('browser canonical outbound cleanup', () => {
         const unrelated = toResourceEntryWithKey({ topicId: 'unrelated', contextId: 'test', resourceId: crypto.randomUUID() }, 'unrelated', {});
         await other.queue.enqueueIfAbsent(unrelated);
         vi.setSystemTime(Date.now() + 11);
-        await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
+        await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });
         let rows = await readRawWorkRows();
         expect(rows.some((row) => row.resource === expired.resource)).toBe(false);
         expect(rows.some((row) => row.resource === target.resource)).toBe(true);
         expect(rows.some((row) => row.resource === other.resource)).toBe(true);
         await deleteBrowserALRuntimeEntriesForSession(targetSession, {
+            currentScope: SCOPE,
             storage: diagnosticsPorts.storage
         });
         rows = await readRawWorkRows();
@@ -100,13 +104,13 @@ describe('browser canonical outbound cleanup', () => {
         await fresh.store.workQueue.enqueueIfAbsent(unrelated);
         await vi.advanceTimersByTimeAsync(11);
 
-        await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
+        await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });
         const remaining = await readRawWorkRows();
 
         expect(remaining.filter((row) => expired.keys.has(row.keyString))).toEqual([]);
         expect(remaining.filter((row) => fresh.keys.has(row.keyString))).toHaveLength(fresh.keys.size);
         expect(remaining.some((row) => row.keyString.includes(unrelated.key.resourceId))).toBe(true);
-        await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
+        await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });
         expect(await readRawWorkRows()).toEqual(remaining);
     });
 
@@ -120,14 +124,14 @@ describe('browser canonical outbound cleanup', () => {
         expect(await expired.store.workQueue.getItem(toALOutboundIdentityKey(reference.key))).toBeUndefined();
         expect((await readRawWorkRows()).filter((row) => expired.keys.has(row.keyString))).toHaveLength(2);
 
-        await deleteExpiredBrowserALRuntimeEntries({ storage: diagnosticsPorts.storage });
+        await deleteExpiredBrowserALRuntimeEntries({ currentScope: SCOPE, storage: diagnosticsPorts.storage });
 
         expect((await readRawWorkRows()).filter((row) => expired.keys.has(row.keyString))).toEqual([]);
     });
 
     it('excludes a namespace whose resource id is only a string prefix of the owned one', async () => {
         const db = await openIndexedDbAdmissionDatabase({
-            dbName: BROWSER_AL_RUNTIME_DB_NAME,
+            dbName: SCOPE_DB_NAME,
             storeName: BROWSER_AL_RUNTIME_STORE_NAME,
             schemaId: AL_ADMISSION_SCHEMA_ID,
             onStorageReset: () => {}
@@ -163,6 +167,7 @@ describe('browser canonical outbound cleanup', () => {
         const otherLive = await admitForSession(otherLiveSession, 60_000);
 
         await deleteExpiredBrowserALRuntimeEntriesForSession(targetSession, {
+            currentScope: SCOPE,
             storage: diagnosticsPorts.storage
         });
 
@@ -176,6 +181,7 @@ describe('browser canonical outbound cleanup', () => {
         vi.setSystemTime(new Date('2030-08-01T00:00:00Z'));
         const first = await admitForSession(`timer-first-${crypto.randomUUID()}`, 20);
         const stop = await initBrowserALRuntimeExpiryEviction({
+            currentScope: SCOPE,
             storage: diagnosticsPorts.storage,
             intervalMs: 10
         });
@@ -199,6 +205,7 @@ describe('browser canonical outbound cleanup', () => {
         await other.store.workQueue.enqueueIfAbsent(unrelated);
 
         await deleteBrowserALRuntimeEntriesForSession(targetSession, {
+            currentScope: SCOPE,
             storage: diagnosticsPorts.storage
         });
         const remaining = await readRawWorkRows();
@@ -212,7 +219,7 @@ describe('browser canonical outbound cleanup', () => {
         const nowMs = Date.now();
         const expiredCount = INDEXED_DB_QUEUE_CLEANUP_MAX_EXPIRED_TO_DELETE + 40;
         const session = `budget-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(session, { diagnosticsPorts });
+        configureBrowserALRuntimeStores(session, { scope: SCOPE, diagnosticsPorts });
         const stores = resolveBrowserSessionALInboundRuntimeStores(session);
         await stores.admissionStore.ready();
         const keyStrings = new Set<string>();
@@ -229,7 +236,7 @@ describe('browser canonical outbound cleanup', () => {
             await stores.workQueue.enqueue(entry);
         }
         const db = await openIndexedDbAdmissionDatabase({
-            dbName: BROWSER_AL_RUNTIME_DB_NAME,
+            dbName: SCOPE_DB_NAME,
             storeName: BROWSER_AL_RUNTIME_STORE_NAME,
             schemaId: AL_ADMISSION_SCHEMA_ID,
             onStorageReset: () => {}
@@ -267,6 +274,7 @@ describe('browser canonical outbound cleanup', () => {
         });
 
         await deleteBrowserALRuntimeEntriesForSession(targetSession, {
+            currentScope: SCOPE,
             storage: diagnosticsPorts.storage
         });
         openCursorSpy.mockRestore();
@@ -291,7 +299,7 @@ describe('browser canonical outbound cleanup', () => {
 });
 
 async function admitForSession(sessionId: string, ttlMs: number) {
-    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
+    configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
     const store = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
     const before = new Set((await readRawWorkRows()).map((row) => row.keyString));
     const runtime = createOutboundTestRuntimeFor({
@@ -316,7 +324,7 @@ async function admitForSession(sessionId: string, ttlMs: number) {
 
 async function readRawWorkRows(): Promise<readonly RawWorkRow[]> {
     const db = await openIndexedDbAdmissionDatabase({
-        dbName: BROWSER_AL_RUNTIME_DB_NAME,
+        dbName: SCOPE_DB_NAME,
         storeName: BROWSER_AL_RUNTIME_STORE_NAME,
         schemaId: AL_ADMISSION_SCHEMA_ID,
         onStorageReset: () => {}
@@ -331,7 +339,7 @@ async function readRawWorkRows(): Promise<readonly RawWorkRow[]> {
 }
 
 async function retainPendingForSession(sessionId: string, ttlMs: number) {
-    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
+    configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts });
     const stores = resolveBrowserSessionALInboundRuntimeStores(sessionId);
     const store = stores.admissionStore;
     await store.ready();
diff --git a/packages/tests/shared-web/messages/acks-read-eviction-race.ts b/packages/tests/shared-web/messages/acks-read-eviction-race.ts
--- a/packages/tests/shared-web/messages/acks-read-eviction-race.ts
+++ b/packages/tests/shared-web/messages/acks-read-eviction-race.ts
@@ -1,6 +1,7 @@
 import { onTestFinished, vi } from 'vitest';
 
-import { BROWSER_AL_RUNTIME_DB_NAME } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
+import { toBrowserALRuntimeDbName } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import type { ALAdmissionDecoder } from '@shared/alm/al-admission-decoder.ts';
 import { decodeALAdmissionControlValue } from '@shared/alm/al-admission-value-validation.ts';
 import type { ALAdmissionReadSession } from '@shared/alm/al-admission-work-backend.ts';
@@ -20,7 +21,7 @@ import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-
  */
 export async function setNextAcksReadEvictionRaced(namespace: string, msgId: string): Promise<void> {
     const competitor = new IndexedDbAdmissionBackend({
-        dbName: BROWSER_AL_RUNTIME_DB_NAME,
+        dbName: toBrowserALRuntimeDbName(defaultStateScope()),
         storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
         nowMs: Date.now,
         newWriteToken: crypto.randomUUID.bind(crypto),
```

The rest only gain the now-required `scope: defaultStateScope()`, or `currentScope: defaultStateScope()`
on a purge, plus the import. The durable send harness gains `dbName`. dprint also reflows one call in
`acknowledgement-under-hold-fixture.ts` (`:248-254`, `createNativeRtcConnectionFixture`): the file
was not dprint-clean at the base, so formatting it brings that hunk with it.

```diff
diff --git a/packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts b/packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts
--- a/packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts
@@ -8,6 +8,7 @@ import {
     resolveBrowserRtcOverlayALOutboundRuntimeStores,
     resolveBrowserWsClientALOutboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
@@ -46,7 +47,7 @@ const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);
 /** Both carrier outbounds of one browser session over its real stores; nothing is ever ready to submit. */
 function createSessionOutbounds(): SessionOutbounds {
     const sessionId = `replay-${crypto.randomUUID()}`;
-    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
+    configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts });
     const stores = {
         rtc: resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId),
         ws: resolveBrowserWsClientALOutboundRuntimeStores(sessionId)
@@ -56,7 +57,7 @@ function createSessionOutbounds(): SessionOutbounds {
     onTestFinished(async () => {
         rtc.dispose();
         ws.dispose();
-        await deleteBrowserALRuntimeEntriesForSession(sessionId, { storage: diagnosticsPorts.storage });
+        await deleteBrowserALRuntimeEntriesForSession(sessionId, { currentScope: defaultStateScope(), storage: diagnosticsPorts.storage });
     });
     const wake = vi.fn();
     const replayed: ALMessage[] = [];
diff --git a/packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts b/packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts
--- a/packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts
@@ -7,6 +7,7 @@ import { computeOutboundTestAdmission } from '../../shared/alm/outbound-runtime-
 import { readBlackBoxRtcMessageNacks } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
 import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
 import { configureBrowserALRuntimeStores, resolveBrowserRtcOverlayALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
 import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
@@ -23,7 +24,7 @@ const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);
 describe('RTC message diagnostic receipts', () => {
     it('reads the admitted receiver receipt without creating sent messages or changing the evidence', async () => {
         const sessionId = `nack-diagnostics-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
+        configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts });
         try {
             const stores = resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId);
             const { admissionStore } = stores;
@@ -67,6 +68,7 @@ describe('RTC message diagnostic receipts', () => {
         }
         finally {
             await deleteBrowserALRuntimeEntriesForSession(sessionId, {
+                currentScope: defaultStateScope(),
                 storage: diagnosticsPorts.storage
             });
         }
diff --git a/packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts b/packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts
--- a/packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts
@@ -13,10 +13,11 @@ import {
     type ALStorageAvailability,
     type BrowserStoragePersistRequest
 } from '@shared-web/browser/al-runtime/browser-al-storage-availability.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
+import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
 import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
 import { toALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
-import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
 import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
 
 const AVAILABLE: ALStorageAvailability = { kind: 'available' };
@@ -32,7 +33,10 @@ describe('the storage availability a connect decides', () => {
     it('reads missing without IndexedDB and gives the durable pairs no memory store to fall back on', async () => {
         const sessionId = `no-indexeddb-${crypto.randomUUID()}`;
 
-        const storage = configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+        const storage = configureBrowserALRuntimeStores(sessionId, {
+            scope: defaultStateScope(),
+            diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
+        });
         const outbound = resolveBrowserWsClientALOutboundRuntimeStores(sessionId);
         const inbound = resolveBrowserSessionALInboundRuntimeStores(sessionId);
 
@@ -49,6 +53,7 @@ describe('the storage availability a connect decides', () => {
         vi.stubGlobal('indexedDB', fakeIndexedDB);
 
         const storage = configureBrowserALRuntimeStores(`indexeddb-${crypto.randomUUID()}`, {
+            scope: defaultStateScope(),
             diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
         });
 
diff --git a/packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts b/packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts
--- a/packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts
@@ -6,6 +6,7 @@ import {
     configureBrowserALRuntimeStores,
     resolveBrowserSessionALInboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import {
     createInboundTestMessage,
@@ -16,7 +17,7 @@ import {
 describe('browser session inbound admission store', () => {
     it('shares one admission state across every resolve of one session', async () => {
         const sessionId = `session-inbound-${crypto.randomUUID()}`;
-        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+        configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
         const first = resolveBrowserSessionALInboundRuntimeStores(sessionId);
         const second = resolveBrowserSessionALInboundRuntimeStores(sessionId);
         const msg = createInboundTestMessage({ msgId: 'admitted-through-the-first-resolve' });
diff --git a/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts b/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
--- a/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
+++ b/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
@@ -1,6 +1,7 @@
 import { describe, expect, it, onTestFinished } from 'vitest';
 
 import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import {
     createBrowserTransportInput,
     toBrowserWebSocketQueueBoxInput,
@@ -33,7 +34,7 @@ const OPTIONS: MiddlewareInitOptions = {
 
 describe('the one volatile bound a browser session hands its carriers (D74)', () => {
     it('gives the inbound pair, the WS client and the RTC overlay the same budget and provider', () => {
-        configureBrowserALRuntimeStores(SESSION.sessionId, { diagnosticsPorts: OPTIONS.diagnosticsPorts });
+        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
         const qboxEngine = new InboxOutboxEngine();
         onTestFinished(() => qboxEngine.stop());
         const input = createBrowserTransportInput(SESSION, OPTIONS);
@@ -58,7 +59,7 @@ describe('the one volatile bound a browser session hands its carriers (D74)', ()
     });
 
     it('bounds the budget by the limits the session reads', () => {
-        configureBrowserALRuntimeStores(SESSION.sessionId, { diagnosticsPorts: OPTIONS.diagnosticsPorts });
+        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
         const { budget } = createBrowserTransportInput(SESSION, OPTIONS).volatileBound;
         const nowMs = Date.now();
 
diff --git a/packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts b/packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts
--- a/packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts
+++ b/packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts
@@ -8,6 +8,7 @@ import {
     resolveBrowserSessionALInboundRuntimeStores,
     resolveBrowserWsClientALOutboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
 import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
@@ -193,7 +194,7 @@ export async function openRtcHoldSender(): Promise<HoldSender> {
     vi.useFakeTimers({ toFake: ['Date'] });
     onTestFinished(() => void vi.useRealTimers());
     configureTestCacheRepositories();
-    configureBrowserALRuntimeStores('self', { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+    configureBrowserALRuntimeStores('self', { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
     const group = createAcceptedGroupSnapshotFixture(['self', 'receiver']);
     groupStateSnapshotsRepository.setGroupStateSnapshot(group);
     overlaysRepository.setAcceptedOverlayById(toScopedOverlayId(group.group), createAcceptedOverlayFixture(group, 1, ['receiver']));
@@ -245,13 +246,17 @@ function createRtcLifecycleMessages(groupRef: GroupSnapshot['group']): (resource
 
 function openRtcReceiverPeer(faults: ScriptedTransportFaultPort) {
     const nativeRuntime = installNativeRtcRuntime();
-    const fixture = createNativeRtcConnectionFixture({
-        sessionId: 'self',
-        token: 'fixture-token',
-        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
-        dataChannelName: 'test',
-        rtcSignalingTopicId: 'rtc'
-    }, nativeRuntime, faults);
+    const fixture = createNativeRtcConnectionFixture(
+        {
+            sessionId: 'self',
+            token: 'fixture-token',
+            iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
+            dataChannelName: 'test',
+            rtcSignalingTopicId: 'rtc'
+        },
+        nativeRuntime,
+        faults
+    );
     onTestFinished(() => {
         fixture.dispose();
         nativeRuntime.dispose();
@@ -303,7 +308,7 @@ export async function openWsHoldSender(): Promise<HoldSender> {
         TestWebSocket.instances.length = 0;
     });
     const sessionId = crypto.randomUUID();
-    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+    configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
     const runtime = createHoldSenderRuntime();
     const { service, native } = await connectWsQueueBox(runtime, sessionId);
     const readiness = vi.spyOn(runtime.faults, 'decideSubmissionReadiness');
diff --git a/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts b/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts
--- a/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts
+++ b/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts
@@ -15,6 +15,7 @@ import '../../setup-browser-indexeddb.ts';
 import { captureOutboundWorkRunnable } from '../../shared/alm/outbound-runtime-test-fixture.ts';
 
 import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { configureBrowserRtcPeerCreationPolicies } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import {
@@ -61,7 +62,7 @@ describe('browser RTC runtime composition', () => {
     afterEach(() => vi.restoreAllMocks());
     beforeEach(() => {
         configureTestCacheRepositories();
-        configureBrowserALRuntimeStores('self', { diagnosticsPorts });
+        configureBrowserALRuntimeStores('self', { scope: defaultStateScope(), diagnosticsPorts });
     });
 
     it('retains an incoming offer while signaling starts and admits it after the selected layout is ready', async () => {
diff --git a/packages/tests/shared-web/rtc/rtc-durable-owner-recovery.test.ts b/packages/tests/shared-web/rtc/rtc-durable-owner-recovery.test.ts
--- a/packages/tests/shared-web/rtc/rtc-durable-owner-recovery.test.ts
+++ b/packages/tests/shared-web/rtc/rtc-durable-owner-recovery.test.ts
@@ -13,6 +13,7 @@ import {
     configureBrowserALRuntimeStores,
     resolveBrowserRtcOverlayALOutboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { AL_RTC_OVERLAY_CAPABILITIES, toALCarrierQosInputProvider } from '@shared/al-contracts/al-carrier-capabilities.ts';
 import { newALBroadcastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
@@ -256,7 +257,7 @@ class RtcRecoveryOwner {
     constructor(sessionId: string) {
         this.sessionId = sessionId;
         this.roomRef = { applicationId: 'reload-app', workspaceId: 'workspace', groupId: sessionId };
-        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+        configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
         this.connection = new WebRtcConnectionService({ connect: async () => {}, send: async () => {} }, {
             sessionId,
             token: 'fixture-token',
diff --git a/packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts b/packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts
--- a/packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts
+++ b/packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts
@@ -13,6 +13,7 @@ import {
     createBrowserALVolatileInboundRuntimeStores,
     resolveBrowserSessionALInboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
 import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
@@ -48,7 +49,7 @@ describe('createBrowserWebSocketQueueBox', () => {
             vi.unstubAllGlobals();
             TestWebSocket.instances.length = 0;
         });
-        configureBrowserALRuntimeStores(clientData.sessionId, { diagnosticsPorts });
+        configureBrowserALRuntimeStores(clientData.sessionId, { scope: defaultStateScope(), diagnosticsPorts });
     });
 
     it('returns an open service for the session after the initial socket opens', async () => {
@@ -260,7 +261,7 @@ describe('the session volatile bound on the WS client (C3)', () => {
             vi.unstubAllGlobals();
             TestWebSocket.instances.length = 0;
         });
-        configureBrowserALRuntimeStores(clientData.sessionId, { diagnosticsPorts });
+        configureBrowserALRuntimeStores(clientData.sessionId, { scope: defaultStateScope(), diagnosticsPorts });
     });
 
     it('counts a received and a sent volatile message against the one budget both of its memory pairs carry', async () => {
diff --git a/packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts b/packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts
--- a/packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts
+++ b/packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts
@@ -17,6 +17,7 @@ import {
     createBrowserALVolatileInboundRuntimeStores,
     resolveBrowserSessionALInboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
 import {
@@ -70,7 +71,7 @@ it('a fresh WS owner recovers the same pending IndexedDB original with a fresh f
     vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
     vi.stubGlobal('WebSocket', TestWebSocket);
     const sessionId = crypto.randomUUID();
-    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+    configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
     const oldFaults = createScriptedTransportFaultPort();
     oldFaults.inject({
         faultId: 'until-document-ends',
@@ -125,7 +126,7 @@ it('a fresh WS owner recovers the same pending IndexedDB original with a fresh f
     oldEngine.stop();
 
     // Recreate both runtime store wrappers and transport owners while keeping the same real IndexedDB namespace/session.
-    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+    configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
     const freshFaults = createScriptedTransportFaultPort();
     const freshEngine = new InboxOutboxEngine();
     const drainFresh = captureOutboundWorkRunnable(freshEngine);
@@ -451,7 +452,7 @@ async function openRecoveryOwner(
     principalId: string,
     faults: ReturnType<typeof createScriptedTransportFaultPort>
 ) {
-    configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+    configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
     const engine = new InboxOutboxEngine();
     const drain = captureOutboundWorkRunnable(engine);
     const settlements: ALDeliverySettlement[] = [];
diff --git a/packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts b/packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts
--- a/packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts
+++ b/packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts
@@ -15,6 +15,7 @@ import {
     createBrowserALVolatileInboundRuntimeStores,
     resolveBrowserSessionALInboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
 import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
@@ -49,7 +50,7 @@ describe('WS retained-work faults', () => {
 
     it('supersedes held work through the real configured QoS normalizer and submits only its replacement', async () => {
         const sessionId = crypto.randomUUID();
-        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+        configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
         const faults = createScriptedTransportFaultPort();
         const fault = {
             faultId: 'hold',
@@ -131,7 +132,7 @@ describe('WS retained-work faults', () => {
 
     it('holds original durable work before every callback and releases it exactly once without retry charges', async () => {
         const sessionId = crypto.randomUUID();
-        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
+        configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
         const faults = createScriptedTransportFaultPort();
         const fault = {
             faultId: 'hold-original',
diff --git a/tests/playwright/alm/harness/create-durable-send-harness.ts b/tests/playwright/alm/harness/create-durable-send-harness.ts
--- a/tests/playwright/alm/harness/create-durable-send-harness.ts
+++ b/tests/playwright/alm/harness/create-durable-send-harness.ts
@@ -1,5 +1,9 @@
-import { toBrowserWsClientALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
+import {
+    toBrowserALRuntimeDbName,
+    toBrowserWsClientALRuntimeStoreId
+} from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
 import { createBrowserALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { createBrowserUnicastMessage } from '@shared-web/browser/messages/create-browser-unicast-message.ts';
 import {
     AL_WS_CLIENT_CAPABILITIES,
@@ -284,7 +288,7 @@ export async function createDurableSendHarness(
     const observation = new DurableSendObservation({ frameLoad, batchEnd: DURABLE_SEND_PLAN_BATCH_ENDS[plan] });
     const stores = createBrowserALOutboundRuntimeStores(
         toBrowserWsClientALRuntimeStoreId(sessionId),
-        { canonicalScope: `browser-session:${sessionId}` }
+        { dbName: toBrowserALRuntimeDbName(defaultStateScope()), canonicalScope: `browser-session:${sessionId}` }
     );
     const runtime = createDefaultALOutboundMessageRuntime<ALOutboundTransportMessage>({
         stores,
```

- [ ] **Step 9: Update the navigation maps.**

```diff
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -445,7 +445,8 @@ detects it independently and emits its own event, so a single cutover can
 leave behind N events, one per concurrent opener. The event's `data` is the
 event itself:
 
-- `dbName`: the IndexedDB database that was reset
+- `dbName`: the IndexedDB database that was reset; for the browser runtime, the
+  scope's database `rallar-al-runtime:<applicationId>:<workspaceId>`
 - `previousSchemaId`: the schema id read back before the reset, or `undefined`
   either when the store set itself did not match (so no schema id could be
   read) or when the stores matched but the database carried no schema record
--- a/packages/shared-web/browser/README.md
+++ b/packages/shared-web/browser/README.md
@@ -173,11 +173,22 @@ the typed result or failure visible without crossing a feature-blind module.
 The browser transport storage and WebSocket owners are feature-colocated:
 
 - [browser-al-runtime-identity.ts](./al-runtime/browser-al-runtime-identity.ts)
-  owns the persisted database, store, and session-key names;
+  owns the persisted database, store, and session-key names: one database per
+  scope, `rallar-al-runtime:<applicationId>:<workspaceId>`, with session-scoped
+  keys inside;
   [browser-al-runtime-stores.ts](./al-runtime/browser-al-runtime-stores.ts)
-  owns session-scoped AL runtime store factories;
+  owns session-scoped AL runtime store factories over the database of the scope
+  the connect resolved;
   [browser-al-runtime-cleanup.ts](./al-runtime/browser-al-runtime-cleanup.ts)
-  owns IndexedDB scanning, expiry scheduling, and session cleanup.
+  owns IndexedDB scanning, expiry scheduling, and session cleanup over every
+  scope's database that `indexedDB.databases()` lists, or the current scope's
+  alone where the browser cannot list them. The pre-scope database
+  `ar-eye-hunter-al-runtime` is never opened or deleted; the browser evicts it.
+- [delete-ended-session-al-runtime-entries.ts](./session/delete-ended-session-al-runtime-entries.ts)
+  purges an ended session's rows on logout, and a replaced session's rows after
+  the disconnect on a login over it or a session switch in `connect`; a failed
+  purge reports failing `health` on the `storage` port for each of the session's
+  stores, and the session ends anyway.
 - [browser-al-work-cleanup.ts](./al-runtime/browser-al-work-cleanup.ts)
   selects canonical payload, identity and action rows in the shared admission
   QueueBox for expiry and session cleanup. The current scan visits the AL work
--- a/packages/shared/alm/inbound/README.md
+++ b/packages/shared/alm/inbound/README.md
@@ -586,7 +586,7 @@ successful finalization.
 
 Browser expiry and session cleanup are owned by
 [`browser-al-work-cleanup.ts`](../../../shared-web/browser/al-runtime/browser-al-work-cleanup.ts)
-in the shared admission database. Because every AL-owned key leads with its owner,
+in each scope's admission database. Because every AL-owned key leads with its owner,
 cleanup deletes one bounded key range per owned `AL_INBOUND`/`AL_OUTBOUND` namespace
 and per owned canonical scope, and each range ends its `resourceId` with the `/`
 delimiter so a neighbouring owner whose id is a string prefix is never pulled in.
```

- [ ] **Step 10: The budgets stay** (see Step 13): Tasks 3 and 4 already raised them past this task's figures.

- [ ] **Step 11: Format the touched files.**

```sh
npx dprint fmt packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts packages/shared-web/browser/connection/initialise-browser-middleware.ts packages/shared-web/browser/session/delete-ended-session-al-runtime-entries.ts packages/shared-web/browser/session/session-auth-lifecycle.ts packages/shared-web/browser/README.md packages/shared/alm/inbound/README.md packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts packages/tests/shared-web/connection/initialise-browser-middleware.test.ts packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts packages/tests/shared-web/messages/acks-read-eviction-race.ts packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts packages/tests/shared-web/rtc/rtc-durable-owner-recovery.test.ts packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts packages/tests/shared-web/session/browser-auth-session-contract-fixture.ts packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts tests/playwright/alm/harness/create-durable-send-harness.ts
```

- [ ] **Step 12: Run the focused tests and every suite that configures the stores.**

```sh
npx vitest run packages/tests/shared-web/al-runtime packages/tests/shared-web/session
# Test Files  16 passed (16)
# Tests  114 passed (114)
npx vitest run packages/tests/shared-web/connection packages/tests/shared-web/messages packages/tests/shared-web/rtc packages/tests/shared-web/websocket packages/tests/shared-test/rallar-browser-runtime packages/tests/shared-web/rallar-facade-defaults.test.ts packages/tests/shared-web/composition
# Test Files  66 passed (66)
# Tests  772 passed (772)
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless
# Tests  21 passed (21)
```

In the sandbox, a sweep of `packages/tests/shared-web` and `packages/tests/shared-test` also shows
10 failures, in `api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe` and
`local-websocket-session`. They are `listen EPERM: operation not permitted 127.0.0.1`, and the same
10 fail at `7e6f0a117`. `browser-session-disconnect-before-connect.test.ts` 'resolves disconnect on a page that never
connected' timed out once while another full sweep ran beside it and passed alone twice (load, not this task).

- [ ] **Step 13: Constraint checks and bundle budgets.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit                        # exit 0
npm --workspace @ar-eye-hunter/shared-web run typecheck                  # exit 0
npm --workspace @ar-eye-hunter/shared-server run typecheck               # exit 0
(cd apps/api-v1 && deno task check)                                      # exit 0
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1414 test files enforced, 0 files carrying known debt (0 errors).
# PASS: no new type errors in the maintained test project
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
# | browser/rallar.ts | … | 231.9 KiB | < 232.0 KiB | ok |   Bundle budget check passed.
```

No public shared-web export changes, and the snapshot test passes unchanged.
`tests/playwright/alm/harness/create-durable-send-harness.ts` is in no tsconfig project. Checked
alone through `packages/tests/tsconfig.json`, it shows only the environmental `@js-temporal/polyfill`
lib error and none of its own.

The figures below are brotli q11, measured the gates' way (the shared-web measure script's facade bundle, and the
headless agent built by esbuild), on Task 5's assembled commit and this task's:

| Bundle              | Before (`b67e43022`) |       After |  Delta | Budget              |
| ------------------- | -------------------: | ----------: | -----: | ------------------- |
| `browser/rallar.ts` |          231.677 KiB | 231.863 KiB | +0.186 | 232 (Task 3), under |
| headless agent      |          295.495 KiB | 295.511 KiB | +0.016 | 296 (Task 4), under |

(The prototype measured +0.309 / +0.184 on W-A's head; brotli does not add linearly across tasks.)

- [ ] **Step 14: Commit.**

```sh
git add packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts packages/shared-web/browser/connection/initialise-browser-middleware.ts packages/shared-web/browser/session/delete-ended-session-al-runtime-entries.ts packages/shared-web/browser/session/session-auth-lifecycle.ts packages/shared-web/browser/README.md packages/shared/alm/inbound/README.md packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts packages/tests/shared-web/al-runtime/browser-session-inbound-store.test.ts packages/tests/shared-web/connection/initialise-browser-middleware.test.ts packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts packages/tests/shared-web/messages/acks-read-eviction-race.ts packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts packages/tests/shared-web/rtc/rtc-durable-owner-recovery.test.ts packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts packages/tests/shared-web/session/browser-auth-session-contract-fixture.ts packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts packages/tests/shared-test/rallar-browser-runtime/rtc-message-nack-diagnostics.test.ts tests/playwright/alm/harness/create-durable-send-harness.ts
git commit -F - <<'MSG'
Name the browser ALM database per scope and purge a replaced session

The browser durable stores open rallar-al-runtime:<applicationId>:<workspaceId>
for the scope the connect resolved. The keys inside stay session-scoped and the
schema id does not change. The expiry sweep and the session purge visit every
scope's database that indexedDB.databases() lists, or only the current scope's
where the browser cannot list them. A failing database no longer keeps the
others from being swept. The pre-scope database ar-eye-hunter-al-runtime is
never opened or deleted.

A login over a session and a session switch in connect now purge the previous
session's rows after the disconnect, as logout does. A failed purge reports
failing health on the storage port for each of the session's stores, and the
session still ends. Each scope part of the name is URI-encoded, so an id with
a colon cannot alias another scope. rallar.ts measures 231.863 KiB under 232,
the headless agent 295.511 KiB under 296.

D8 reuse: deleteBrowserALRuntimeEntriesForSession and openIndexedDbAdmissionDatabase run per scope database, the storage port's health arm and toALStorageUnavailable carry the failure, and nothing new holds state.
MSG
```

- [ ] **Step 15: Changed-range gates (need the commit).**

```sh
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings (measured for the prototype alone and on the assembled branch)
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: no current structure-coupled test candidates
# PASS: changed-range structure-coupling review has complete individual classifications
# PASS: registry entries are complete and current
```

Measured notes:

- A first draft kept the purge's `try`/`catch` and the event loop in `session-auth-lifecycle.ts`. It
  failed with `file.cognitive-load` (51, against a warn tier of 50) and `boundary.unknown` (a helper
  taking `error: unknown`). Moving both into `delete-ended-session-al-runtime-entries.ts` clears both
  findings.
- Exporting the prefix took `browser-al-runtime-identity.ts` to 12 runtime exports
  (`file.responsibility-count`). Un-exporting the unused `toBrowserALRuntimeNamespace` brings it back
  to 11.
- The first session tests used `toHaveBeenCalledWith` and `not.toHaveBeenCalled`, and the coupling
  gate flagged two candidates. The step log replaces them.

This task changes no server, Postgres or `packages/shared/alm/**` code, so
`npm run test:postgres:integration` and the black-box gates are not its to run.

---

### Task 7: identity dedup holds through the message deadline plus the grace, capped at the message-owner lifetime

Prototyped in `scratch-D` as commit `3d5213981` on `7e6f0a117` (red then green); assembled unchanged as `a8db6195c` on
`scratch/i2a-assemble` over Tasks 1–6 (R-I2a-i-1 to R-I2a-i-7 are this task's rulings). Decision D125, proposal §1.5 and
§3.e, QoS plan §5 ("Replays are duplicates"), fact sheet item 5. Server-shared: the WS server admits through the same
`createALInboundAdmissionStore` over `PSqlAdmissionWorkBackend`
(`packages/shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts:70-89`), so this one mutation changes
memory, IndexedDB and PostgreSQL alike.

**Files**

- Modify: `packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts` — the `al-policy.ts` import
  (`:2` at base) also takes `ALDedupAlgo`, `ALDedupOptions`, `ALEffectiveAlgorithm`; new
  `ComputeALInboundDedupExpiryInput` after the imports; `toALInboundAdmittedMessageMutations` reads the message's own
  deadline once (`:16-17` at base) and the `set-dedup` expiry (`:37-41` at base) calls the new
  `computeALInboundDedupExpiryMs`, placed after its sibling `computeALInboundMessageOwnerExpiryMs` (`:45-52` at base).
  The file grows 132 → 168 lines; `toALInboundAdmittedMessageMutations` is 36 lines (≤ 40).
- Modify: `packages/shared/alm/inbound/README.md` — the relay-rows paragraph (`:102-109` at base, the dedup row
  sentence at `:106`) and a new `### Dedup retention` subsection after the session-logical keys paragraph
  (`:128-131` at base), before "What is partitioned per carrier".
- Test (create): `packages/tests/shared/alm/inbound/compute-al-inbound-dedup-expiry-ms.test.ts` (55 lines) — the pure
  computation.
- Test (create): `packages/tests/shared/alm/inbound/al-inbound-dedup-retention.test.ts` (131 lines) — the replay and the
  semantic-key window over the real inbound runtime on memory and IndexedDB.
- Test (create): `packages/tests/shared-server/al-runtime/postgres/p-sql-inbound-dedup-retention.test.ts` (65 lines) —
  the same replay over the server's PostgreSQL store on PGlite, beside `p-sql-inbound-ingress-audience.test.ts`.
- Not touched, checked: the four tests the proposal named as candidates do not move, because none pins the window's
  length — `packages/tests/shared/al-indexeddb-runtime-stores.test.ts:110` and `al-durable-runtime.test.ts:56` replay
  at once across a restart (dedup inside any window), `al-inbound-message-runtime.test.ts:225` is sender-scoped dedup
  of two senders at once, `al-policy.test.ts:383` is semantic-key's default key in the planner. The one test that pins
  a dedup expiry, `packages/tests/shared/multicast/rtc-relay-row-retention.test.ts:81`
  (`dedup: relayed.admittedAtMs + DEDUP_WINDOW_MS`), also stays: its origin copy's deadline is `ttlMs: 30_000`
  (`rtc-origin-overlay-fixture.ts:116`) on a frozen clock, so deadline + grace = admission + 60 s = the window, and the
  maximum is the same instant. `validate-al-inbound-admission-mutation.ts` bounds no dedup expiry; no row shape, no
  schema id, no setting changes.

**Interfaces**

- Consumes: `resolveALMessageExpireAtMs(msg, effective)` (`packages/shared/al-contracts/al-policy.ts:418`),
  `computeALReceiptRetentionExpiryMs(deadlineAtMs)`
  (`packages/shared/alm/delivery/compute-al-receipt-retention-expiry-ms.ts:3-5`, + `AL_RECEIPT_DEADLINE_GRACE_MS =
  30_000`), `NormalizedALRuntimeStoreRetentionConfig.msgOwnerTtlMs` (`packages/shared/alm/ALStoreRetention.ts:23`,
  default 60 min).
- Produces (exported from `packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts`):
  ```ts
  export interface ComputeALInboundDedupExpiryInput {
      readonly nowMs: number;
      readonly dedup: ALEffectiveAlgorithm<ALDedupAlgo, ALDedupOptions>;
      /** The message's own deadline; undefined when it names none, which keeps the window. */
      readonly messageDeadlineAtMs: number | undefined;
      readonly msgOwnerTtlMs: number;
  }
  export function computeALInboundDedupExpiryMs(input: ComputeALInboundDedupExpiryInput): number;
  ```
  Behaviour: `window = nowMs + max(0, windowMs)`; for `semantic-key`, or a message without its own deadline, the result
  is `window`; otherwise `max(window, min(deadline + 30 s, nowMs + msgOwnerTtlMs))`. `deadline` is the message's own
  `resolveALMessageExpireAtMs`, not the 30 min `durableEffectTtlMs` fallback the owner and work rows use. A `ttlHops ≤ 0`
  message resolves to deadline 0, so the window wins, as today. The cap equals a durable message-owner row's own
  lifetime (`nowMs + msgOwnerTtlMs`), so the two identity rows share one bound; a volatile owner row ends at
  deadline + grace, which the dedup row now matches whenever that is past the window.

**D8 reuse inspection.** Reused: `computeALReceiptRetentionExpiryMs` (the grace helper the volatile owner row already
uses in the same file), `resolveALMessageExpireAtMs` (the one deadline resolver), `retention.msgOwnerTtlMs` (the
existing normalized retention, no new setting), the sibling pattern `computeALInboundMessageOwnerExpiryMs` (a pure
`computeXxx` beside the mutation in the same file), and in tests the inbound runtime fixture
(`packages/tests/shared/alm/inbound-runtime-test-fixture.ts`: `createInboundTestRuntime`, `createInboundTestStores`
with `'memory' | 'indexeddb'`) and the PGlite admission storage (`create-p-sql-admission-test-storage.ts`). Not added:
no new production file (the computation sits beside its sibling, as the frame asks), no new constant (the 60 s
default, the 5 min clamp and the 30 s grace stay where they are), no new QoS option or capability, no change to the
persisted QoS validator or the envelope, no row shape or schema id change, no eviction change. `packages/shared/cache`
and `packages/shared/resilience` are not involved: this is an expiry timestamp on an existing row, not in-memory state
or an expected failure.

- [ ] **Step 1: Write the failing unit test of the computation.** Create
      `packages/tests/shared/alm/inbound/compute-al-inbound-dedup-expiry-ms.test.ts`:

```ts
import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import type { ALDedupAlgo } from '@shared/al-contracts/al-policy.ts';
import { DEFAULT_AL_REPOSITORY_TTL_MS } from '@shared/alm/ALStoreRetention.ts';
import { computeALInboundDedupExpiryMs } from '@shared/alm/inbound/admission/al-inbound-delivery-mutations.ts';
import { describe, expect, it } from 'vitest';

const NOW_MS = 1_000_000;
const WINDOW_MS = 60_000;
/** The default message-owner lifetime, which caps the deadline term. */
const MSG_OWNER_TTL_MS = DEFAULT_AL_REPOSITORY_TTL_MS;

function computeExpiryMs(algo: ALDedupAlgo, messageDeadlineAtMs: number | undefined): number {
    return computeALInboundDedupExpiryMs({
        nowMs: NOW_MS,
        dedup: { algo, opts: { windowMs: WINDOW_MS } },
        messageDeadlineAtMs,
        msgOwnerTtlMs: MSG_OWNER_TTL_MS
    });
}

describe('computeALInboundDedupExpiryMs', () => {
    it.each<ALDedupAlgo>(['msg-id', 'msg-id+sender'])(
        'holds %s dedup through a deadline past the window plus the receipt grace',
        (algo) => {
            expect(computeExpiryMs(algo, NOW_MS + 120_000)).toBe(
                NOW_MS + 120_000 + AL_RECEIPT_DEADLINE_GRACE_MS
            );
        }
    );

    it('keeps the window as the floor when the deadline plus the grace ends first', () => {
        expect(computeExpiryMs('msg-id', NOW_MS + 10_000)).toBe(NOW_MS + WINDOW_MS);
    });

    it('keeps the window for a message that names no deadline', () => {
        expect(computeExpiryMs('msg-id', undefined)).toBe(NOW_MS + WINDOW_MS);
    });

    // A sender's deadline never sets the row's lifetime past the message-owner row's.
    it('caps the deadline term at the message-owner lifetime', () => {
        expect(computeExpiryMs('msg-id+sender', NOW_MS + 2 * MSG_OWNER_TTL_MS)).toBe(
            NOW_MS + MSG_OWNER_TTL_MS
        );
    });

    // Stretching a semantic key to the deadline would drop new messages that share the key.
    it('keeps the window for semantic-key dedup whatever the deadline', () => {
        expect(computeExpiryMs('semantic-key', NOW_MS + 120_000)).toBe(NOW_MS + WINDOW_MS);
    });

    it('counts a negative window as none', () => {
        expect(computeALInboundDedupExpiryMs({
            nowMs: NOW_MS,
            dedup: { algo: 'semantic-key', opts: { windowMs: -1 } },
            messageDeadlineAtMs: undefined,
            msgOwnerTtlMs: MSG_OWNER_TTL_MS
        })).toBe(NOW_MS);
    });
});
```

- [ ] **Step 2: Write the failing runtime test on memory and IndexedDB.** Create
      `packages/tests/shared/alm/inbound/al-inbound-dedup-retention.test.ts`. The replay is a copy addressed to this
      peer as its one next hop (D25), so a duplicate is answered with this peer's own ACK again
      (`compute-al-inbound-duplicate-changes.ts:62-63`); the ACK poll comes first so the replay's batch has settled
      before any verdict (an assertion thrown while a batch is in flight can leave the PGlite case of Step 3 hanging
      at teardown — observed while prototyping). The semantic-key case passes at base too: it is the regression guard
      that the key keeps its window.

```ts
import '../../../setup-browser-indexeddb.ts';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage, type ALAckStatus } from '@shared/al-contracts/al-control.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    type InboundTestRuntime,
    type InboundTestStorage
} from '../inbound-runtime-test-fixture.ts';

const SOURCE: ALInboundMessageRuntime.Source = {
    kind: 'rtc-peer',
    peerId: INBOUND_TEST_SENDER_PEER_ID
};
/** Twice the default 60 s dedup window, so a replay can land past the window and inside the deadline. */
const DEADLINE_MS = 120_000;
const INSIDE_THE_WINDOW_MS = 30_000;
const PAST_THE_WINDOW_MS = 61_000;

interface ObservedAck {
    readonly toPeerId: string;
    readonly ackedMsgId: string;
    readonly status: ALAckStatus;
}

function createRuntime(storage: InboundTestStorage): InboundTestRuntime {
    return createInboundTestRuntime({
        carrier: 'rtc',
        stores: createInboundTestStores({
            namespace: 'inbound-dedup-retention',
            storage,
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: 'inbound-dedup-retention-worker'
    });
}

/** An acknowledged copy the sender addresses to this peer as its one next hop, so a replay is answered. */
function createRetriedCopy(msgId: string): ALMessage {
    const message = createInboundTestMessage({ msgId, acknowledged: true });
    return {
        ...message,
        constraints: { ...message.constraints, expiresAtMs: Date.now() + DEADLINE_MS },
        forwarding: { ...message.forwarding, nextHopPeerIds: [INBOUND_TEST_SELF_PEER_ID] }
    };
}

/** A message deduplicated on a key it shares with every other message this helper builds. */
function createKeyedMessage(msgId: string): ALMessage {
    const message = createInboundTestMessage({ msgId });
    return {
        ...message,
        constraints: { ...message.constraints, expiresAtMs: Date.now() + DEADLINE_MS },
        qos: { dedup: { algo: 'semantic-key', opts: { semanticKey: 'room-presence' } } }
    };
}

function readAcks(runtime: InboundTestRuntime): readonly ObservedAck[] {
    return runtime.controlSends.flat().flatMap((msg): ObservedAck[] => {
        const control = parseALControlMessage(msg);
        return control?.type === 'ack'
            ? [{
                toPeerId: control.payload.toPeerId,
                ackedMsgId: control.payload.ackedMsgId,
                status: control.payload.status
            }]
            : [];
    });
}

describe('inbound dedup retention', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each<InboundTestStorage>(['memory', 'indexeddb'])(
        'acknowledges a replay after the window inside its deadline again without delivering it twice over %s',
        async (storage) => {
            const runtime = createRuntime(storage);
            const startedAtMs = Date.now();
            const copy = createRetriedCopy('replayed-past-the-window');
            const ack = {
                toPeerId: INBOUND_TEST_SENDER_PEER_ID,
                ackedMsgId: copy.id.msgId,
                status: 'delivered'
            };

            await runtime.runtime.ready();
            expect((await runtime.runtime.admitIncomingMessage(copy, SOURCE)).right).toEqual({
                kind: 'admitted'
            });
            await expect.poll(() => readAcks(runtime)).toEqual([ack]);

            vi.setSystemTime(startedAtMs + PAST_THE_WINDOW_MS);
            const replay = await runtime.runtime.admitIncomingMessage(copy, SOURCE);

            // The replay's answer is read first, so the replay's own batch has settled before any verdict.
            await expect.poll(() => readAcks(runtime)).toEqual([ack, ack]);
            expect(replay.right).toEqual({ kind: 'duplicate' });
            expect(runtime.delivered).toEqual(['dispatched']);
        }
    );

    it.each<InboundTestStorage>(['memory', 'indexeddb'])(
        'keeps the semantic-key window although the message deadline is longer over %s',
        async (storage) => {
            const runtime = createRuntime(storage);
            const startedAtMs = Date.now();

            await runtime.runtime.ready();
            const first = await runtime.runtime.admitIncomingMessage(
                createKeyedMessage('first'),
                SOURCE
            );
            await expect.poll(() => runtime.delivered).toEqual(['dispatched']);

            vi.setSystemTime(startedAtMs + INSIDE_THE_WINDOW_MS);
            const insideTheWindow = await runtime.runtime.admitIncomingMessage(
                createKeyedMessage('inside'),
                SOURCE
            );

            vi.setSystemTime(startedAtMs + PAST_THE_WINDOW_MS);
            const pastTheWindow = await runtime.runtime.admitIncomingMessage(
                createKeyedMessage('past'),
                SOURCE
            );

            expect([first.right, insideTheWindow.right, pastTheWindow.right]).toEqual([
                { kind: 'admitted' },
                { kind: 'duplicate' },
                { kind: 'admitted' }
            ]);
            await expect.poll(() => runtime.delivered).toEqual(['dispatched', 'dispatched']);
        }
    );
});
```

- [ ] **Step 3: Write the failing PostgreSQL replay.** Create
      `packages/tests/shared-server/al-runtime/postgres/p-sql-inbound-dedup-retention.test.ts` (runs in `test:unit:main`
      on PGlite, the store the WS server builds):

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createPSqlALInboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SOURCE
} from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import { createPSqlAdmissionTestStorage } from './create-p-sql-admission-test-storage.ts';

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
    vi.useRealTimers();
});

/** An acknowledged copy addressed to this peer as its one next hop, due twice the 60 s window after it was sent. */
function createRetriedCopy(msgId: string): ALMessage {
    const message = createInboundTestMessage({ msgId, acknowledged: true });
    return {
        ...message,
        constraints: { ...message.constraints, expiresAtMs: Date.now() + 120_000 },
        forwarding: { ...message.forwarding, nextHopPeerIds: [INBOUND_TEST_SELF_PEER_ID] }
    };
}

it('acknowledges a replay after the dedup window inside its deadline again without a second delivery over PostgreSQL', async () => {
    const { repository } = await createPSqlAdmissionTestStorage();
    const fixture = createInboundTestRuntime({
        stores: createPSqlALInboundRuntimeStores({
            repository,
            namespace: 'psql-dedup-retention',
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: undefined
        }),
        carrier: 'ws',
        effectWorkerId: 'al-inbound:psql-dedup-retention'
    });
    const startedAtMs = Date.now();
    const copy = createRetriedCopy('replayed-past-the-window');
    const readAckedMsgIds = () =>
        fixture.controlSends.flat().flatMap((msg) => {
            const control = parseALControlMessage(msg);
            return control?.type === 'ack' ? [control.payload.ackedMsgId] : [];
        });

    await fixture.runtime.ready();
    expect((await fixture.runtime.admitIncomingMessage(copy, INBOUND_TEST_SOURCE)).right).toEqual({
        kind: 'admitted'
    });
    await expect.poll(readAckedMsgIds).toEqual([copy.id.msgId]);

    vi.setSystemTime(startedAtMs + 61_000);
    const replay = await fixture.runtime.admitIncomingMessage(copy, INBOUND_TEST_SOURCE);

    // The replay's answer is read first, so the replay's own batch has settled before any verdict.
    await expect.poll(readAckedMsgIds).toEqual([copy.id.msgId, copy.id.msgId]);
    expect(replay.right).toEqual({ kind: 'duplicate' });
    expect(fixture.delivered).toEqual(['dispatched']);
});
```

- [ ] **Step 4: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared/alm/inbound/compute-al-inbound-dedup-expiry-ms.test.ts packages/tests/shared/alm/inbound/al-inbound-dedup-retention.test.ts packages/tests/shared-server/al-runtime/postgres/p-sql-inbound-dedup-retention.test.ts
```

Expected (measured at `7e6f0a117`): `Test Files  3 failed (3)`, `Tests  10 failed | 2 passed (12)`. The seven unit
cases fail with `TypeError: computeALInboundDedupExpiryMs is not a function`; the three replay cases (memory,
IndexedDB, PostgreSQL) fail with `expected { kind: 'admitted' } to deeply equal { kind: 'duplicate' }` — at base the
dedup row lapsed at 60 s, so the replay at 61 s was admitted and delivered a second time; the two semantic-key cases
pass.

- [ ] **Step 5: Compute the expiry.** In `packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts`,
      replace the `al-policy.ts` import (`:2` at base):

```ts
import {
    resolveALMessageExpireAtMs,
    type ALDedupAlgo,
    type ALDedupOptions,
    type ALEffectiveAlgorithm
} from '../../../al-contracts/al-policy.ts';
```

After the last import (`import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';`), add:

```ts
export interface ComputeALInboundDedupExpiryInput {
    readonly nowMs: number;
    readonly dedup: ALEffectiveAlgorithm<ALDedupAlgo, ALDedupOptions>;
    /** The message's own deadline; undefined when it names none, which keeps the window. */
    readonly messageDeadlineAtMs: number | undefined;
    readonly msgOwnerTtlMs: number;
}
```

In `toALInboundAdmittedMessageMutations`, the deadline lines (`:16-17` at base) become:

```ts
const messageDeadlineAtMs = resolveALMessageExpireAtMs(read.msg, read.plan.effective);
const deadlineAtMs = messageDeadlineAtMs ?? read.nowMs + read.retention.durableEffectTtlMs;
```

and the `set-dedup` push (`:37-41` at base) becomes:

```ts
mutations.push({
    kind: 'set-dedup',
    dedupKey: read.plan.dedupKey,
    expireAtTimestamp: computeALInboundDedupExpiryMs({
        nowMs: read.nowMs,
        dedup: read.plan.effective.dedup,
        messageDeadlineAtMs,
        msgOwnerTtlMs: read.retention.msgOwnerTtlMs
    })
});
```

After `computeALInboundMessageOwnerExpiryMs` (`:45-52` at base), add:

```ts
/**
 * Identity dedup holds its row until the message deadline plus the receipt grace, so a replay inside the
 * deadline meets its first admission; the window stays the floor, and the message-owner lifetime caps the
 * deadline term so a sender's deadline never sets the row's lifetime. A semantic key keeps its window:
 * held to the deadline it would drop new messages that share the key.
 */
export function computeALInboundDedupExpiryMs(input: ComputeALInboundDedupExpiryInput): number {
    const windowExpiryMs = input.nowMs + Math.max(0, input.dedup.opts.windowMs);
    if (input.dedup.algo === 'semantic-key' || input.messageDeadlineAtMs === undefined) {
        return windowExpiryMs;
    }
    const deadlineExpiryMs = Math.min(
        computeALReceiptRetentionExpiryMs(input.messageDeadlineAtMs),
        input.nowMs + input.msgOwnerTtlMs
    );
    return Math.max(windowExpiryMs, deadlineExpiryMs);
}
```

- [ ] **Step 6: Document the rule in `packages/shared/alm/inbound/README.md`.** In the relay-rows paragraph, the
      sentence ending `the dedup row for the 60 s dedup window. Once its child's ACK arrives it adds an
      acknowledgement-history row, kept until the deadline plus the grace as well.` (`:105-107` at base) becomes:

```md
the dedup row for the longer of the 60 s dedup window and the deadline plus the grace (see the dedup retention
below). Once its child's ACK arrives it adds an acknowledgement-history row, kept until the deadline plus the grace
as well.
```

After the paragraph `Every stored key stays session-logical: … delivered them.` (`:128-131` at base) insert:

```md
### Dedup retention

An admitted message writes one dedup row, whose expiry
[`computeALInboundDedupExpiryMs`](./admission/al-inbound-delivery-mutations.ts) computes; a copy that meets it is
`duplicate`, is never delivered again, and is answered as the duplicate answers below describe. Identity dedup
(`msg-id`, `msg-id+sender`) keeps the row for the longer of the dedup window (60 s by default, at most 5 min) and
the message's own deadline plus the 30 s receipt grace, so a replay inside the deadline meets its first admission
(D125). The deadline term is capped at the message-owner lifetime (`msgOwnerTtlMs`,
60 min by default), the bound a durable message-owner row already has, so a sender's deadline never sets how long
a receiver keeps the row: a replay after the cap and before a deadline further out is delivered again. A message
that names no deadline keeps the window. `semantic-key` dedup keeps the window whatever the deadline, since held
to the deadline it would drop new messages that share the key. Memory, IndexedDB and the WS server's PostgreSQL
store write the row through the one mutation.
```

- [ ] **Step 7: Format the touched files.**

```sh
npx dprint fmt packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts packages/shared/alm/inbound/README.md packages/tests/shared/alm/inbound/compute-al-inbound-dedup-expiry-ms.test.ts packages/tests/shared/alm/inbound/al-inbound-dedup-retention.test.ts packages/tests/shared-server/al-runtime/postgres/p-sql-inbound-dedup-retention.test.ts
```

- [ ] **Step 8: Run the new tests, then every suite that admits inbound or pins a retention row.**

```sh
npx vitest run packages/tests/shared/alm/inbound/compute-al-inbound-dedup-expiry-ms.test.ts packages/tests/shared/alm/inbound/al-inbound-dedup-retention.test.ts packages/tests/shared-server/al-runtime/postgres/p-sql-inbound-dedup-retention.test.ts
```

Expected (measured): `Test Files  3 passed (3)`, `Tests  12 passed (12)` (five repeated runs on the prototype, all green;
the same on `a8db6195c`).

```sh
npx vitest run packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/al-durable-runtime.test.ts packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/al-policy.test.ts packages/tests/shared/multicast/rtc-relay-row-retention.test.ts packages/tests/shared/alm/inbound packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts
```

Expected (measured on `a8db6195c`, where Task 3's `al-inbound-storage-unavailable.test.ts` sits in the same folder):
`Test Files  27 passed (27)`, `Tests  280 passed (280)` (the prototype on the base: 26 / 279) — the four
proposal-named tests, the relay-row pin and the transaction/operation pins unchanged (no new IndexedDB operation: the
dedup row was already written in the admission transaction, only its timestamp moves).

```sh
npx vitest run packages/tests/shared/alm packages/tests/shared/multicast packages/tests/shared-server/al-runtime packages/tests/shared-web/al-runtime packages/tests/shared/webrtc-rx-policy.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts
```

Expected (measured before Step 3's file existed): `Test Files  123 passed (123)`, `Tests  1544 passed (1544)`; with it,
one file and one test more.

- [ ] **Step 9: Constraint checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit                    # exit 0
npm --workspace @ar-eye-hunter/shared-web run typecheck              # exit 0
npm --workspace @ar-eye-hunter/shared-server run typecheck           # exit 0
(cd apps/api-v1 && deno task check)                                  # exit 0
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1418 test files enforced, 0 files carrying known debt (0 errors).   (on a8db6195c)
# PASS: no new type errors in the maintained test project
npm run check:test-reachability
# Test reachability: 1720 test files, 1714 reached by CI, 6 manual.   (on a8db6195c)
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
# | browser/rallar.ts | … | 231.9 KiB | < 232.0 KiB | ok | …   Bundle budget check passed.
npx vitest run packages/tests/rallar-black-box-headless
# Test Files  2 passed (2)   Tests  4 passed (4)
```

Bundle figures (brotli q11, measured with the scripts' own esbuild options) on the assembled commit `a8db6195c`:
`browser/rallar.ts` 231.863 → 231.925 KiB (budget 232), headless agent 295.511 → 295.597 KiB (budget 296). No budget is
crossed. (The prototype measured 230.106 → 230.091 and 293.694 → 293.771 on the base.)

- [ ] **Step 10: Commit.**

```sh
git add packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts packages/shared/alm/inbound/README.md packages/tests/shared/alm/inbound/compute-al-inbound-dedup-expiry-ms.test.ts packages/tests/shared/alm/inbound/al-inbound-dedup-retention.test.ts packages/tests/shared-server/al-runtime/postgres/p-sql-inbound-dedup-retention.test.ts
git commit -m "Hold identity dedup through the message deadline plus the receipt grace

A msg-id or msg-id+sender dedup row now expires at the later of the
dedup window and the message's own deadline plus the 30 s receipt
grace, the deadline term capped at the message-owner lifetime, so a
replay after the window but inside the deadline meets its first
admission instead of being delivered twice. The window stays the
floor; a message without a deadline and semantic-key dedup keep the
window. Memory, IndexedDB and the server's PostgreSQL store share the
one mutation, and each is pinned by a replay test.

D8 reuse: computeALReceiptRetentionExpiryMs, resolveALMessageExpireAtMs and retention.msgOwnerTtlMs give the deadline term and its cap; the inbound runtime fixture and the PGlite admission storage carry the tests; no new production file, constant, setting or row shape."
```

- [ ] **Step 11: Changed-range gates (need the commit).**

```sh
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings (… -> HEAD).
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: no current structure-coupled test candidates
# PASS: changed-range structure-coupling review has complete individual classifications
# PASS: registry entries are complete and current
```

- [ ] **Step 12: The PostgreSQL integration suite (the mutation is shared with the server).** Sandbox off. Check the
      shared container first and start it only if stopped; never `db:test:up` or `db:down`:

```sh
docker ps --filter name=ar-eye-hunter-postgres --format '{{.Names}} {{.Status}}'
# ar-eye-hunter-postgres Up … (healthy)      — if absent: docker start ar-eye-hunter-postgres
npm run test:postgres:integration
```

Expected (measured on the prototype): `Test Files  1 failed | 25 passed (26)`, `Tests  1 failed | 83 passed (84)`;
the one red is the known local-only `rtc-topology-replay-consumer.test.ts` ("lets passive live C poll and drain
independent A/B streams without a notification wake"), unrelated to ALM and reported, not fixed. The other known
local-only red, `topology-app-outbox-concurrency.test.ts`, passed in this run; if it reds, report it the same way.
`al-inbound-work-recovery.test.ts` and `al-inbound-supersedence.test.ts` (the suite's inbound admissions over real
PostgreSQL) pass.

- [ ] **Step 13: The API-v1 black-box memory profile.** Sandbox off, foreground; the verdict is the summary line.
      Ports 18080–18082 must be free; if a lane holds them, skip this step and say so in the task report:

```sh
for port in 18080 18081 18082; do lsof -nP -iTCP:$port -sTCP:LISTEN; done   # prints nothing
npm run test:api-v1:black-box:memory
```

Expected (measured on the prototype): the summary line `Matrix profile api-v1-black-box: passed=60 failed=0 skipped=0`, exit 0 (it ran longer than 10 min locally; the memory runner skips the cluster profile).

**What the close task's server gates prove for this change.** The server admits every WS client message through this
mutation, so `npm run test:api-v1:black-box:postgres:medium-scale` and the api-v1 cluster profile prove that the
longer identity-dedup rows break no server path under real concurrency and cross-server delivery: admission,
duplicate handling and the convergence assertions unchanged, with the dedup row now living up to deadline + 30 s
(capped at 60 min) instead of 60 s. Neither gate replays a message after 60 s, so neither proves the new retention
itself; that proof is Steps 2–3 (memory, IndexedDB, PostgreSQL on PGlite). They also bound the cost: more live dedup
rows per server only for messages whose deadline is past 30 s, at most one row per admitted message for at most
60 min, the same bound the durable message-owner row already holds.

---

### Task 8: The storage fault port (interceptor seam, `ScriptedStorageFaultPort`, `carrier: 'storage'`)

Prototyped in `scratch-E` (branch `scratch/i2a-E`) as commit `c3c1bdef7` on `7e6f0a117` (red, then green); assembled
unchanged but for the two budget files as `3561cc9f3` on `scratch/i2a-assemble`. Proposal §1.6 and §3.i; fact sheet items 2, 9 and 12. Task 8 depends on no earlier I2a-i
task: it touches only the observer seam, its three IndexedDB owners and the harness, so the anchors below are the
base commit's and stay valid after Tasks 1–7 unless a task edits the same lines (none of 1–7 does).

**Files**

- Modify: `packages/shared/persistence/indexed-db-operation-observer.ts` — `observe` may return a held decision
  (`:24-26`); two exported lists `INDEXED_DB_OPERATION_OWNERS` and `INDEXED_DB_OPERATION_KINDS` beside the types
  they enumerate (the harness schema and decoder read them, so the kinds are spelled once).
- Create: `packages/shared/persistence/storage-fault-port.ts` (98 lines) — `StorageFaultMatch`,
  `ScriptedStorageFault`, `StorageFaultObservation`, `ScriptedStorageFaultPort`, `createScriptedStorageFaultPort`.
- Modify: the 3 + 3 + 18 call sites: `packages/shared/alm/indexed-db-admission-backend.ts` (`:125`, `:148`, `:184`),
  `packages/shared/alm/indexed-db-admission-read-session.ts` (`:74`, `:88`, `:103`),
  `packages/shared/queuebox/indexed-db-queue-box.ts` (`:168`, `:180`, `:203`, `:232`, `:243`, `:276`, `:307`, the four
  reservation writes `:383`, `:422`, `:464`, `:518` through `#observeReservation` `:605-607`, `:526`, `:629`, `:648`,
  `:663`, `:675`, `:704`).
- Modify (harness): `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts`
  (`BlackBoxBrowserDiagnosticsDependency` `:137-140`, the dependency `:182-183`, `:220`),
  `black-box-rallar-diagnostics.ts` (`:116`), `connection/black-box-rallar-connection-runtime.ts` (`:5`, `:226-229`),
  `connection/black-box-rallar-close-operation.ts` (`:85`), `messaging/decode-black-box-rallar-messaging-input.ts`
  (`:66-99`, `:126`).
- Modify (recipe surface): `packages/shared-test/rallar-bb-test/schema.ts` (`:439-449`, `:646-656`),
  `schema/rallar-black-box-command-fields.ts` (`:252-253`, `:299-300`), `rallar-black-box-test-contracts.ts`
  (`:8`, `:382-390`), `alm/validate-alm-control-command.ts` (`:235-292`), `alm/rallar-black-box-alm-command-capabilities.ts`
  (`:130-133`), `docs/schema-and-capabilities.md` (after `:463`), `conformance/alm/assess-alm-reload-identity.ts`
  (`:3-8`, `:192`).
- Test (create): `packages/tests/shared/persistence/storage-fault-port.test.ts` (140 lines),
  `packages/tests/shared/alm/indexed-db-storage-faults.test.ts` (153 lines),
  `packages/tests/shared-test/alm-storage-fault-contract.test.ts` (59 lines).
- Test (modify): `packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts`,
  `fault-lifetime-cleanup.test.ts`, `browser-runtime-facade-test-double.ts`; four type narrowings the widened
  `fault.inject` union needs (`packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts:194`,
  `packages/tests/shared-test/alm-conformance-recipes.test.ts:71`, `alm-identity-assessment.test.ts:285`,
  `alm-cross-carrier-duplicate-outcome.test.ts:76-79`) and the Deno fixture
  `apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts:303`.
- Modify: `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (296 → 297) and
  `packages/shared-web/bundle-budgets.json` `browser/rallar.ts` (232 → 233), both measured on the assembled commit.
- Not touched: `al-indexeddb-transaction-ledger.test.ts`, `al-indexeddb-operation-counts.test.ts` (they pass unchanged:
  the pass-through observer returns nothing, so no operation, transaction or microtask is added),
  `ScriptedTransportFaultPort` (`packages/shared/transport-faults/transport-fault-port.ts`), production
  `toRallarDiagnosticsPorts` (its observer stays the pass-through).

**Interfaces**

- Consumes: `IndexedDbOperation`, `IndexedDbOperationOwner`, `IndexedDbOperationKind`
  (`indexed-db-operation-observer.ts:1-22`); `LatestRepository` (`packages/shared/cache/LatestRepository.ts`);
  the transport port's shape as the model (`transport-fault-port.ts:31-49`).
- Produces:
  ```ts
  // packages/shared/persistence/indexed-db-operation-observer.ts
  export const INDEXED_DB_OPERATION_OWNERS: readonly IndexedDbOperationOwner[];
  export const INDEXED_DB_OPERATION_KINDS: readonly IndexedDbOperationKind[];
  export interface IndexedDbOperationObserver {
      observe(operation: IndexedDbOperation): Promise<void> | void;
  }
  // packages/shared/persistence/storage-fault-port.ts
  export interface StorageFaultMatch {
      readonly owner: IndexedDbOperationOwner;
      readonly kind: IndexedDbOperationKind | undefined;
  }
  export interface ScriptedStorageFault {
      readonly faultId: string;
      readonly carrier: 'storage';
      readonly match: StorageFaultMatch;
      readonly action: 'fail' | 'quota' | Readonly<{ delayMs: number; }>;
      readonly remaining: number | 'until-cleared';
  }
  export interface StorageFaultObservation {
      readonly faultId: string;
      readonly operation: IndexedDbOperation;
      readonly decision: 'fail' | 'quota' | 'delay';
  }
  export interface ScriptedStorageFaultPort extends IndexedDbOperationObserver {
      inject(fault: ScriptedStorageFault): void;
      clear(): void;
      getObservations(): readonly StorageFaultObservation[];
  }
  export function createScriptedStorageFaultPort(): ScriptedStorageFaultPort;
  // packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts
  export interface BlackBoxBrowserDiagnosticsDependency {
      readonly faults: ScriptedTransportFaultPort;
      readonly storage: CountingIndexedDbOperationObserver;
      readonly storageFaults: ScriptedStorageFaultPort;
  }
  // packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
  export type RallarBlackBoxTestFaultInjectCommand =
      | RallarBlackBoxTestTransportFaultInjectCommand // the former type, unchanged
      | RallarBlackBoxTestStorageFaultInjectCommand; // carrier 'storage', match { owner, kind? }
  // decode-black-box-rallar-messaging-input.ts
  export function decodeBlackBoxRallarFaultInput(
      value: unknown
  ): Either<BlackBoxRallarInputIssue, ScriptedTransportFault | ScriptedStorageFault>;
  ```
  Behaviour: a decision exists only while a fault matches; `fail` rejects with `DOMException('…', 'UnknownError')`
  (Task 1's classifier reads it as `transaction-failed`), `quota` rejects only a write kind (`write`, `work-write`,
  `work-reserve`, `work-release`, `work-cleanup`) with `QuotaExceededError` (→ `quota`) and lets every read through,
  `{ delayMs }` holds the operation. A counted fault spends one per decision; re-injecting the same `faultId` with
  `remaining: 0` releases it (the recipes' existing release convention); `close` clears storage faults with the
  transport faults. The harness's observer counts first, then asks the fault port, so `storage.counters` still counts
  a failed operation.

**D8 reuse inspection.** Reused: the transport fault port's whole shape (`inject`/`clear`/`getObservations`, a counted
or `until-cleared` `remaining`, release by re-injecting `remaining: 0`, cleared on close beside it), the one operation
observer seam the counting observer already uses (widened, not duplicated), `LatestRepository` for the fault set (no raw
`Map`), the existing operation kinds (exported once as lists the schema and the decoder share), the existing
`faultDelayAction` field set and its validator (one `validateFaultDelayAction` for both carriers), the existing
`fault.inject` command (a third `oneOf` branch, not a new command kind). Not added: no `fault.clear` command (the
`remaining: 0` release already exists and the lane recipes use it), no second observer port, no production use (the
facade's default stays the pass-through), no microtask helper (an `async` helper would add a microtask per operation;
each site awaits only a returned promise), no `IndexedDbConnection` wrapper, no new timer outside the scripted delay
itself. `packages/shared/resilience` is not involved: a fault is a rejected promise by design, since it imitates a
native IndexedDB failure that Task 1's classifier turns into a value.

- [ ] **Step 1: Write the failing port test.** Create `packages/tests/shared/persistence/storage-fault-port.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createScriptedStorageFaultPort,
    type ScriptedStorageFault
} from '@shared/persistence/storage-fault-port.ts';

const QUOTA_ON_ADMISSION_WRITES: ScriptedStorageFault = {
    faultId: 'quota-admission',
    carrier: 'storage',
    match: { owner: 'al-admission', kind: undefined },
    action: 'quota',
    remaining: 'until-cleared'
};

describe('ScriptedStorageFaultPort', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('lets every operation through at once while nothing is injected', () => {
        const port = createScriptedStorageFaultPort();

        expect(port.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();
        expect(port.getObservations()).toEqual([]);
    });

    it('fails a matching write with QuotaExceededError', async () => {
        const port = createScriptedStorageFaultPort();
        port.inject(QUOTA_ON_ADMISSION_WRITES);

        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toMatchObject({
            name: 'QuotaExceededError'
        });
        expect(port.getObservations()).toEqual([{
            faultId: 'quota-admission',
            operation: { owner: 'al-admission', kind: 'write' },
            decision: 'quota'
        }]);
    });

    // A full disk refuses writes, so a quota fault leaves reads and the other owner alone.
    it.each(
        [
            { owner: 'al-admission', kind: 'read' },
            { owner: 'al-admission', kind: 'list' },
            { owner: 'al-work', kind: 'work-write' }
        ] as const
    )('lets $owner $kind through under a quota fault on al-admission', (operation) => {
        const port = createScriptedStorageFaultPort();
        port.inject(QUOTA_ON_ADMISSION_WRITES);

        expect(port.observe(operation)).toBeUndefined();
        expect(port.getObservations()).toEqual([]);
    });

    it.each(['work-write', 'work-reserve', 'work-release', 'work-cleanup'] as const)(
        'counts %s as a write of the work owner',
        async (kind) => {
            const port = createScriptedStorageFaultPort();
            port.inject({
                ...QUOTA_ON_ADMISSION_WRITES,
                match: { owner: 'al-work', kind: undefined }
            });

            await expect(port.observe({ owner: 'al-work', kind })).rejects.toMatchObject({
                name: 'QuotaExceededError'
            });
        }
    );

    it('fails any matching kind with UnknownError', async () => {
        const port = createScriptedStorageFaultPort();
        port.inject({
            faultId: 'fail-read',
            carrier: 'storage',
            match: { owner: 'al-admission', kind: 'read' },
            action: 'fail',
            remaining: 1
        });

        expect(port.observe({ owner: 'al-admission', kind: 'list' })).toBeUndefined();
        const failed = port.observe({ owner: 'al-admission', kind: 'read' });
        await expect(failed).rejects.toBeInstanceOf(DOMException);
        await expect(failed).rejects.toMatchObject({ name: 'UnknownError' });
    });

    it('holds a matching operation for its delay', async () => {
        vi.useFakeTimers();
        const port = createScriptedStorageFaultPort();
        port.inject({
            faultId: 'slow-page',
            carrier: 'storage',
            match: { owner: 'al-work', kind: 'work-page' },
            action: { delayMs: 50 },
            remaining: 'until-cleared'
        });
        let released = false;

        void port.observe({ owner: 'al-work', kind: 'work-page' })?.then(() => {
            released = true;
        });
        await vi.advanceTimersByTimeAsync(49);
        expect(released).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(released).toBe(true);
        expect(port.getObservations()).toEqual([{
            faultId: 'slow-page',
            operation: { owner: 'al-work', kind: 'work-page' },
            decision: 'delay'
        }]);
    });

    it('spends a counted fault and keeps an until-cleared one', async () => {
        const port = createScriptedStorageFaultPort();
        port.inject({ ...QUOTA_ON_ADMISSION_WRITES, faultId: 'once', remaining: 1 });

        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toThrow();
        expect(port.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();

        port.inject(QUOTA_ON_ADMISSION_WRITES);
        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toThrow();
        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toThrow();
    });

    // Re-injecting the same fault id with nothing remaining is how a recipe releases a held fault.
    it('releases a fault re-injected with nothing remaining', () => {
        const port = createScriptedStorageFaultPort();
        port.inject(QUOTA_ON_ADMISSION_WRITES);
        port.inject({ ...QUOTA_ON_ADMISSION_WRITES, remaining: 0 });

        expect(port.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();
    });

    it('forgets its faults and observations on clear', async () => {
        const port = createScriptedStorageFaultPort();
        port.inject(QUOTA_ON_ADMISSION_WRITES);
        await expect(port.observe({ owner: 'al-admission', kind: 'write' })).rejects.toThrow();

        port.clear();

        expect(port.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();
        expect(port.getObservations()).toEqual([]);
    });
});
```

- [ ] **Step 2: Write the failing owner test.** Create `packages/tests/shared/alm/indexed-db-storage-faults.test.ts` — a fault through the real IndexedDB owners fails before the transaction or between the reservation's read and its write, so nothing is half-written:

```ts
import { describe, expect, it } from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import type {
    IndexedDbOperation,
    IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { createScriptedStorageFaultPort } from '@shared/persistence/storage-fault-port.ts';
import { EntityStatus, NEW_AND_RETRY_STATUSES } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import '../../setup-browser-indexeddb.ts';

const WORK_TYPE = 'STORAGE_FAULT_WORK';

describe('storage faults through the IndexedDB owners', () => {
    it('fails an admission write with QuotaExceededError and writes nothing', async () => {
        const faults = createScriptedStorageFaultPort();
        const backend = createBackend(faults);
        faults.inject({
            faultId: 'quota',
            carrier: 'storage',
            match: { owner: 'al-admission', kind: 'write' },
            action: 'quota',
            remaining: 1
        });

        await expect(backend.write((tx) => tx.set('kept', 'value'))).rejects.toMatchObject({
            name: 'QuotaExceededError'
        });

        expect(await backend.read('kept', String)).toBeUndefined();
        await backend.write((tx) => tx.set('kept', 'value'));
        expect(await backend.read('kept', String)).toBe('value');
    });

    it('fails a read-session read before it reaches the snapshot', async () => {
        const faults = createScriptedStorageFaultPort();
        const backend = createBackend(faults);
        await backend.write((tx) => tx.set('session', 'value'));
        faults.inject({
            faultId: 'session-read',
            carrier: 'storage',
            match: { owner: 'al-admission', kind: 'read' },
            action: 'fail',
            remaining: 1
        });

        await expect(backend.readWithin((session) => session.read('session', String))).rejects
            .toMatchObject({
                name: 'UnknownError'
            });
        expect(await backend.readWithin((session) => session.read('session', String))).toBe(
            'value'
        );
    });

    // The reservation's decision sits between its finished read and its write: the row stays claimable.
    it('fails a reservation write and leaves the row unreserved', async () => {
        const faults = createScriptedStorageFaultPort();
        const backend = createBackend(faults);
        const entry = workEntry();
        await backend.workQueue.enqueue(entry);
        faults.inject({
            faultId: 'reserve',
            carrier: 'storage',
            match: { owner: 'al-work', kind: 'work-reserve' },
            action: 'quota',
            remaining: 1
        });

        await expect(reserveOne(backend)).rejects.toMatchObject({ name: 'QuotaExceededError' });

        const stored = await backend.workQueue.getItem(entry.key);
        expect(stored?.status).toBe(EntityStatus.NEW);
        expect(stored?.dequeueAudit.attempts).toBe(0);
        expect([...(await reserveOne(backend)).values()].map((reserved) => reserved.resource))
            .toEqual([
                entry.resource
            ]);
    });

    it.each(
        [
            { owner: 'al-admission', kind: 'read' },
            { owner: 'al-work', kind: 'work-page' }
        ] as const
    )('holds a $owner $kind until its decision settles', async (held) => {
        const gate = createHeldObserver(held);
        const backend = createBackend(gate.observer);
        await backend.write((tx) => tx.set('held', 'value'));
        let settled = false;

        const operation = (held.kind === 'read'
            ? backend.read('held', String)
            : backend.workQueue.readWorkPage({
                typeId: WORK_TYPE,
                status: EntityStatus.NEW,
                maxToRead: 1,
                cursor: null
            }))
            .then(() => {
                settled = true;
            });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        gate.release();
        await operation;
        expect(settled).toBe(true);
    });
});

function createBackend(observer: IndexedDbOperationObserver): IndexedDbAdmissionBackend {
    return new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `storage-faults-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer
    });
}

/** Holds the first operation that matches `held` until `release`; every other operation runs at once. */
function createHeldObserver(
    held: IndexedDbOperation
): { observer: IndexedDbOperationObserver; release(): void; } {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let armed = true;
    return {
        observer: {
            observe(operation) {
                if (!armed || operation.owner !== held.owner || operation.kind !== held.kind) {
                    return undefined;
                }
                armed = false;
                return gate;
            }
        },
        release: () => release()
    };
}

async function reserveOne(backend: IndexedDbAdmissionBackend) {
    return await backend.workQueue.reserveEntries({
        typeIds: new Set([WORK_TYPE]),
        statusIds: new Set(NEW_AND_RETRY_STATUSES),
        reservationInput: { maxToReserve: 1, maxAttempts: 5 },
        observedEntries: undefined
    });
}

function workEntry() {
    return QueueBoxUtilities.toResourceEntryFromMsg(
        newALUnicastMessage(
            'sender',
            newALEventRoute('test', crypto.randomUUID()),
            'receiver',
            'test',
            { value: 1 }
        ),
        WORK_TYPE
    );
}
```

- [ ] **Step 3: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared/persistence/storage-fault-port.test.ts packages/tests/shared/alm/indexed-db-storage-faults.test.ts
```

Expected (measured at `7e6f0a117`): `Test Files  2 failed (2)`, `Tests  no tests` — both fail to import `@shared/persistence/storage-fault-port.ts`.

- [ ] **Step 4: Create the port.** Create `packages/shared/persistence/storage-fault-port.ts`:

```ts
import { LatestRepository } from '../cache/LatestRepository.ts';
import type {
    IndexedDbOperation,
    IndexedDbOperationKind,
    IndexedDbOperationObserver,
    IndexedDbOperationOwner
} from './indexed-db-operation-observer.ts';

export interface StorageFaultMatch {
    readonly owner: IndexedDbOperationOwner;
    /** Undefined matches every kind of the owner; a `quota` fault still fails only its writes. */
    readonly kind: IndexedDbOperationKind | undefined;
}

export interface ScriptedStorageFault {
    readonly faultId: string;
    /** Names the storage beside the transport carriers a scripted fault can name. */
    readonly carrier: 'storage';
    readonly match: StorageFaultMatch;
    /** `fail` rejects with `UnknownError`; `quota` rejects a write with `QuotaExceededError`; a delay holds the operation. */
    readonly action: 'fail' | 'quota' | Readonly<{ delayMs: number; }>;
    readonly remaining: number | 'until-cleared';
}

export interface StorageFaultObservation {
    readonly faultId: string;
    readonly operation: IndexedDbOperation;
    readonly decision: 'fail' | 'quota' | 'delay';
}

/** The harness's interceptor of the IndexedDB owners: a decision lands before a transaction opens or before a computed write. */
export interface ScriptedStorageFaultPort extends IndexedDbOperationObserver {
    inject(fault: ScriptedStorageFault): void;
    clear(): void;
    getObservations(): readonly StorageFaultObservation[];
}

const WRITE_KINDS: ReadonlySet<IndexedDbOperationKind> = new Set([
    'write',
    'work-write',
    'work-reserve',
    'work-release',
    'work-cleanup'
]);

export function createScriptedStorageFaultPort(): ScriptedStorageFaultPort {
    return new ScriptedStorageFaults();
}

class ScriptedStorageFaults implements ScriptedStorageFaultPort {
    private readonly faults = new LatestRepository<string, ScriptedStorageFault>();
    private readonly observations: StorageFaultObservation[] = [];

    inject(fault: ScriptedStorageFault): void {
        this.faults.set(fault.faultId, fault);
    }

    clear(): void {
        this.faults.clearAll();
        this.observations.length = 0;
    }

    getObservations(): readonly StorageFaultObservation[] {
        return [...this.observations];
    }

    observe(operation: IndexedDbOperation): Promise<void> | void {
        const fault = this.faults.readAllValues().find((candidate) =>
            matchesStorageFault(candidate, operation)
        );
        if (fault === undefined) {
            return undefined;
        }
        if (fault.remaining !== 'until-cleared') {
            this.faults.set(fault.faultId, { ...fault, remaining: fault.remaining - 1 });
        }
        const decision = typeof fault.action === 'string' ? fault.action : 'delay';
        this.observations.push({ faultId: fault.faultId, operation, decision });
        return toStorageFaultDecision(fault.action);
    }
}

function matchesStorageFault(fault: ScriptedStorageFault, operation: IndexedDbOperation): boolean {
    return (fault.remaining === 'until-cleared' || fault.remaining > 0) &&
        fault.match.owner === operation.owner &&
        (fault.match.kind === undefined || fault.match.kind === operation.kind) &&
        (fault.action !== 'quota' || WRITE_KINDS.has(operation.kind));
}

function toStorageFaultDecision(action: ScriptedStorageFault['action']): Promise<void> {
    if (action === 'quota') {
        return Promise.reject(
            new DOMException('Scripted storage quota fault', 'QuotaExceededError')
        );
    }
    if (action === 'fail') {
        return Promise.reject(new DOMException('Scripted storage fault', 'UnknownError'));
    }
    return new Promise((resolve) => {
        setTimeout(resolve, action.delayMs);
    });
}
```

Run step 3's command. Expected (measured): `Tests  5 failed | 14 passed (19)` — the port test passes; every owner test fails (`promise resolved "undefined" instead of rejecting`, the held read settles before its release) because no call site awaits a decision yet, and the two rejected decisions surface as unhandled rejections.

- [ ] **Step 5: Let the observer return a decision, and await it at every call site.** In `packages/shared/persistence/indexed-db-operation-observer.ts`:

```diff
diff --git a/packages/shared/persistence/indexed-db-operation-observer.ts b/packages/shared/persistence/indexed-db-operation-observer.ts
index 9e3ae3e15..3bd0dd5e2 100644
--- a/packages/shared/persistence/indexed-db-operation-observer.ts
+++ b/packages/shared/persistence/indexed-db-operation-observer.ts
@@ -1,5 +1,7 @@
 export type IndexedDbOperationOwner = 'al-admission' | 'al-work';
 
+export const INDEXED_DB_OPERATION_OWNERS: readonly IndexedDbOperationOwner[] = ['al-admission', 'al-work'];
+
 /**
  * `work-page` and `work-probe` are an owner's inspections: a readiness read, and a reservation read that
  * computed no write. `work-reserve` is a reservation that computed a write, even one that then conflicted.
@@ -16,13 +18,31 @@ export type IndexedDbOperationKind =
     | 'work-probe'
     | 'work-cleanup';
 
+export const INDEXED_DB_OPERATION_KINDS: readonly IndexedDbOperationKind[] = [
+    'read',
+    'list',
+    'write',
+    'work-read',
+    'work-write',
+    'work-page',
+    'work-reserve',
+    'work-release',
+    'work-probe',
+    'work-cleanup'
+];
+
 export interface IndexedDbOperation {
     readonly owner: IndexedDbOperationOwner;
     readonly kind: IndexedDbOperationKind;
 }
 
+/**
+ * Told of every operation an IndexedDB owner starts, before its transaction opens or before a write it
+ * computed from a finished read. A returned promise holds the operation until it settles and fails it
+ * with its rejection; returning nothing lets it run at once, so a pass-through observer adds no microtask.
+ */
 export interface IndexedDbOperationObserver {
-    observe(operation: IndexedDbOperation): void;
+    observe(operation: IndexedDbOperation): Promise<void> | void;
 }
 
 export interface IndexedDbOperationCounts {
```

Every call site becomes the same three statements (dprint keeps the braces), awaiting only a returned promise so the pass-through costs no microtask. `packages/shared/alm/indexed-db-admission-backend.ts`:

```diff
diff --git a/packages/shared/alm/indexed-db-admission-backend.ts b/packages/shared/alm/indexed-db-admission-backend.ts
index 34807ec2a..0ec387a41 100644
--- a/packages/shared/alm/indexed-db-admission-backend.ts
+++ b/packages/shared/alm/indexed-db-admission-backend.ts
@@ -122,7 +122,10 @@ export class IndexedDbAdmissionBackend implements ALAdmissionWorkBackend {
     }
 
     async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
-        this.#observer.observe({ owner: 'al-admission', kind: 'read' });
+        const decision = this.#observer.observe({ owner: 'al-admission', kind: 'read' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         const stored = (await readIndexedDbAdmissionSnapshot(db, this.#storeName, { kind: 'key', key }))[0];
         if (stored === undefined) {
@@ -145,7 +148,10 @@ export class IndexedDbAdmissionBackend implements ALAdmissionWorkBackend {
     }
 
     async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
-        this.#observer.observe({ owner: 'al-admission', kind: 'list' });
+        const decision = this.#observer.observe({ owner: 'al-admission', kind: 'list' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         const rows = await readIndexedDbAdmissionSnapshot(
             db,
@@ -181,7 +187,10 @@ export class IndexedDbAdmissionBackend implements ALAdmissionWorkBackend {
         fn: (tx: ALAdmissionWorkWriteContext) => Promise<T>,
         executionExpiresAtMs: number | null = null
     ): Promise<T> {
-        this.#observer.observe({ owner: 'al-admission', kind: 'write' });
+        const decision = this.#observer.observe({ owner: 'al-admission', kind: 'write' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         const fenced = await this.#readFencedWrite(db, fn);
         const deadline = executionExpiresAtMs === null
```

`packages/shared/alm/indexed-db-admission-read-session.ts`:

```diff
diff --git a/packages/shared/alm/indexed-db-admission-read-session.ts b/packages/shared/alm/indexed-db-admission-read-session.ts
index 48512adad..39cdfb2ac 100644
--- a/packages/shared/alm/indexed-db-admission-read-session.ts
+++ b/packages/shared/alm/indexed-db-admission-read-session.ts
@@ -71,7 +71,10 @@ export class IndexedDbAdmissionReadSession implements ALAdmissionReadSession {
     }
 
     async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
-        this.#observer.observe({ owner: 'al-admission', kind: 'read' });
+        const decision = this.#observer.observe({ owner: 'al-admission', kind: 'read' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const stored = await this.readRow(key);
         if (stored === undefined) {
             return undefined;
@@ -85,7 +88,10 @@ export class IndexedDbAdmissionReadSession implements ALAdmissionReadSession {
     }
 
     async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
-        this.#observer.observe({ owner: 'al-admission', kind: 'list' });
+        const decision = this.#observer.observe({ owner: 'al-admission', kind: 'list' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const nowMs = this.#nowMs();
         const entries: ALAdmissionBackendEntry<V>[] = [];
         for (const stored of await this.readRows(prefix)) {
@@ -100,7 +106,10 @@ export class IndexedDbAdmissionReadSession implements ALAdmissionReadSession {
     }
 
     async readWork(key: Key): Promise<ResourceEntry | undefined> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-read' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-read' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const stored = await this.readStoredWork(toKeyAsString(key));
         return stored === undefined ||
                 isStoredQueueEntryExpired(stored, Temporal.Instant.fromEpochMilliseconds(this.#nowMs()))
```

`packages/shared/queuebox/indexed-db-queue-box.ts` (the reservation's decision sits after its readonly read transaction ended and before `#write` opens the readwrite one; `#observeReservation` returns the decision):

```diff
diff --git a/packages/shared/queuebox/indexed-db-queue-box.ts b/packages/shared/queuebox/indexed-db-queue-box.ts
index ccb5a558b..597049440 100644
--- a/packages/shared/queuebox/indexed-db-queue-box.ts
+++ b/packages/shared/queuebox/indexed-db-queue-box.ts
@@ -165,7 +165,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
     }
 
     async readWorkPage(input: ResourceInboxWorkPage.Request): Promise<ResourceInboxWorkPage> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-page' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-page' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const request = toValidatedWorkPageRequest(input);
         const db = await this.#connection.open();
         const stored = await readStoredQueueWorkPage(db, this.#storeName, request);
@@ -177,7 +180,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
         if (inputs.length === 0) {
             return [];
         }
-        this.#observer.observe({ owner: 'al-work', kind: 'work-page' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-page' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const requests = inputs.map((input) => toValidatedWorkPageRequest(input));
         const db = await this.#connection.open();
         const pages = await readStoredQueueWorkPages(db, this.#storeName, requests);
@@ -200,7 +206,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
      * until some later trigger.
      */
     async cleanupAsync(): Promise<IndexedDbQueueCleanupResult> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-cleanup' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-cleanup' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         const now = this.#now();
         const expired = await this.#readExpiredEntries(db, now);
@@ -229,7 +238,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
     }
 
     async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         const keyString = toKeyAsString(resourceEntry.key);
         const stored = await readStoredQueueEntry(db, this.#storeName, keyString);
@@ -240,7 +252,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
     }
 
     async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         const stored = await readStoredQueueEntry(
             db,
@@ -273,7 +288,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
         expected: ResourceEntry,
         replacement: ResourceEntry
     ): Promise<ResourceEntry | null> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         if (toKeyAsString(expected.key) !== toKeyAsString(replacement.key)) {
             throw new TypeError('Queue replacement key differs from its observation');
         }
@@ -304,7 +322,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
     }
 
     async releaseEntries(releases: readonly ResourceInboxRelease[]): Promise<Map<Key, ResourceEntry>> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-release' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-release' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const validated = toValidatedResourceInboxReleases(releases);
         if (validated.length === 0) {
             return new Map<Key, ResourceEntry>();
@@ -380,7 +401,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
                 stored.dequeueAudit.attempts < maxAttempts &&
                 isStoredQueueEntryTimedOut({ stored, typeIds, duration: timeSinceStartTs, now })
         });
-        this.#observeReservation(selection.mutations);
+        const decision = this.#observeReservation(selection.mutations);
+        if (decision instanceof Promise) {
+            await decision;
+        }
         return await this.#write(db, { mutations: selection.mutations, result: selection.reserved });
     }
 
@@ -420,7 +444,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
                 .filter((stored) => isStoredQueueEntryExpired(stored, now))
                 .map(computeIndexedDbQueueDelete)
         ];
-        this.#observeReservation(mutations);
+        const decision = this.#observeReservation(mutations);
+        if (decision instanceof Promise) {
+            await decision;
+        }
         return await this.#write(db, { mutations, result: selection.reserved });
     }
 
@@ -462,7 +489,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
             now,
             requestedTypes
         });
-        this.#observeReservation(computed.mutations);
+        const decision = this.#observeReservation(computed.mutations);
+        if (decision instanceof Promise) {
+            await decision;
+        }
         return await this.#write(db, computed);
     }
 
@@ -515,7 +545,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
             reserved.set(updated.key, { entry: updated, selectedDueTs });
             mutations.push(computeIndexedDbQueuePut(stored, updated));
         }
-        this.#observeReservation(mutations);
+        const decision = this.#observeReservation(mutations);
+        if (decision instanceof Promise) {
+            await decision;
+        }
         return await this.#write(db, { mutations, result: reserved });
     }
 
@@ -523,7 +556,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
         typeIds: Set<string>,
         workInput: ResourceInboxWorkAdvertisementOptions
     ): Promise<boolean> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-probe' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-probe' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const options = toResourceInboxWorkAdvertisementOptions(workInput);
         const db = await this.#connection.open();
         const now = this.#now();
@@ -602,8 +638,11 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
     }
 
     /** A reservation read that changed nothing is the owner's idle inspection; one that writes is a reservation. */
-    #observeReservation(mutations: readonly ComputedIndexedDbQueueMutation[]): void {
-        this.#observer.observe({ owner: 'al-work', kind: mutations.length === 0 ? 'work-probe' : 'work-reserve' });
+    #observeReservation(mutations: readonly ComputedIndexedDbQueueMutation[]): Promise<void> | void {
+        return this.#observer.observe({
+            owner: 'al-work',
+            kind: mutations.length === 0 ? 'work-probe' : 'work-reserve'
+        });
     }
 
     async #write<Result>(
@@ -626,7 +665,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
     }
 
     async getItem(key: Key): Promise<ResourceEntry | undefined> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-read' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-read' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         const keyString = toKeyAsString(key);
         const stored = await readStoredQueueEntry(db, this.#storeName, keyString);
@@ -645,7 +687,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
         value: ResourceEntry,
         _options: PersistenceSetItemOptions
     ): Promise<void> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         const entry: ResourceEntry = {
             ...value,
@@ -660,7 +705,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
     }
 
     async removeItem(key: Key): Promise<void> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-write' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         await writeComputedIndexedDbQueueMutations({
             db: db,
@@ -672,7 +720,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
     }
 
     async getAllKeys(): Promise<Key[]> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-read' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-read' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         // Unscoped by type or status: every other read narrows by an index, this one cannot, so
         // it reads the store directly instead of a single-caller store-module export for it.
@@ -701,7 +752,10 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
      * signal that more expired rows remain, so the bound belongs to the caller and not to a loop here.
      */
     async deleteExpired(): Promise<number> {
-        this.#observer.observe({ owner: 'al-work', kind: 'work-cleanup' });
+        const decision = this.#observer.observe({ owner: 'al-work', kind: 'work-cleanup' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
         const db = await this.#connection.open();
         const expired = await this.#readExpiredEntries(db, this.#now());
         return await this.#write(db, {
```

Run:

```sh
npx vitest run packages/tests/shared/persistence packages/tests/shared/alm/indexed-db-storage-faults.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
```

Expected (measured): `Test Files  6 passed (6)`, `Tests  57 passed (57)` (the path filter also matches `persistence-provider.test.ts`): the port 14, the owners 5, the ledger 4 and the operation counts 20 — the ledger and the counts unchanged.

- [ ] **Step 6: Write the failing harness tests.** Create `packages/tests/shared-test/alm-storage-fault-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { decodeBlackBoxRallarFaultInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts';
import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

describe('ALM storage fault command', () => {
    const command = {
        kind: 'fault.inject',
        faultId: 'quota-admission',
        carrier: 'storage',
        match: { owner: 'al-admission', kind: 'write' },
        action: 'quota',
        remaining: 'until-cleared'
    };

    it.each([
        { action: 'quota', match: { owner: 'al-admission', kind: 'write' } },
        { action: 'fail', match: { owner: 'al-work' } },
        { action: { delayMs: 25 }, match: { owner: 'al-work', kind: 'work-page' } }
    ])(
        'admits the storage fault $action on $match.owner through every command boundary',
        ({ action, match }) => {
            const fault = { ...command, action, match };
            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, fault).ok).toBe(true);
            expect(validateAlmControlCommand(fault, 'fault.inject')).toEqual([]);
            expect(decodeBlackBoxRallarFaultInput(fault).right).toEqual({
                faultId: 'quota-admission',
                carrier: 'storage',
                match: { owner: match.owner, kind: match.kind },
                action,
                remaining: 'until-cleared'
            });
        }
    );

    it.each([
        { name: 'a transport action', fault: { ...command, action: 'drop' } },
        { name: 'a missing owner', fault: { ...command, match: { kind: 'write' } } },
        { name: 'an unknown owner', fault: { ...command, match: { owner: 'al-cache' } } },
        {
            name: 'an unknown kind',
            fault: { ...command, match: { owner: 'al-admission', kind: 'commit' } }
        },
        {
            name: 'a transport matcher',
            fault: { ...command, match: { owner: 'al-admission', typeId: 'held' } }
        }
    ])('refuses $name on the storage carrier before runtime invocation', ({ fault }) => {
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, fault).ok).toBe(false);
        expect(validateAlmControlCommand(fault, 'fault.inject').length).toBeGreaterThan(0);
    });

    it.each([
        { name: 'a transport action', fault: { ...command, action: 'drop' } },
        { name: 'a missing owner', fault: { ...command, match: { kind: 'write' } } },
        {
            name: 'an unknown kind',
            fault: { ...command, match: { owner: 'al-admission', kind: 'commit' } }
        }
    ])('the page decoder refuses $name on the storage carrier', ({ fault }) => {
        expect(decodeBlackBoxRallarFaultInput(fault).left).toBeDefined();
    });

    it('refuses a storage matcher on a transport carrier', () => {
        const fault = { ...command, carrier: 'ws', action: 'drop' };
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, fault).ok).toBe(false);
        expect(validateAlmControlCommand(fault, 'fault.inject').length).toBeGreaterThan(0);
    });
});
```

Add the routing test to `packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts` and the close test to `fault-lifetime-cleanup.test.ts`, and give the facade double its storage fault port:

```diff
diff --git a/packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts b/packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts
index 26966c1cd..ee99edc69 100644
--- a/packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts
@@ -127,6 +127,34 @@ it('applies a command-injected hold through the configured readiness owner and r
     await runtime.close();
 });
 
+// The storage counters count the operation the fault then fails, so a counted window still sees it.
+it('routes a storage fault to the IndexedDB interceptor after the counting observer', async () => {
+    const { runtime } = await loadConnectedMessageRuntime('messages.ws');
+    const observer = facade.records.defaultWrites.at(-1)?.diagnosticsPorts?.indexedDbOperationObserver;
+    if (!observer) {
+        throw new Error('Scoped connection must install the IndexedDB operation observer.');
+    }
+    const fault = {
+        faultId: 'quota',
+        carrier: 'storage',
+        match: { owner: 'al-admission', kind: 'write' },
+        action: 'quota',
+        remaining: 'until-cleared'
+    };
+
+    await runtime.injectFault(fault);
+
+    await expect(observer.observe({ owner: 'al-admission', kind: 'write' })).rejects.toMatchObject({
+        name: 'QuotaExceededError'
+    });
+    expect(observer.observe({ owner: 'al-admission', kind: 'read' })).toBeUndefined();
+    expect(facade.rallar.diagnostics.storage.getCounts().byOwner['al-admission']).toBe(2);
+    expect(facade.rallar.diagnostics.faults.getObservations()).toEqual([]);
+    await runtime.injectFault({ ...fault, remaining: 0 });
+    expect(observer.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();
+    await runtime.close();
+});
+
 it('passes the connected room reference through RTC message sends', async () => {
     const { runtime } = await loadConnectedMessageRuntime('messages.rtc');
```

```diff
diff --git a/packages/tests/shared-test/rallar-browser-runtime/fault-lifetime-cleanup.test.ts b/packages/tests/shared-test/rallar-browser-runtime/fault-lifetime-cleanup.test.ts
index a6a732980..071d7794b 100644
--- a/packages/tests/shared-test/rallar-browser-runtime/fault-lifetime-cleanup.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/fault-lifetime-cleanup.test.ts
@@ -99,6 +99,26 @@ it('targeted active recipe cleanup releases its real fault even when disconnect
     }
 });
 
+it('releases an indefinite storage hold on close', async () => {
+    const { runtime } = await createHeldFaultRuntime();
+    const injected = await runtime.execute({
+        kind: 'fault.inject',
+        commandId: 'storage-hold',
+        faultId: 'storage-hold',
+        carrier: 'storage',
+        match: { owner: 'al-admission' },
+        action: 'fail',
+        remaining: 'until-cleared'
+    });
+    expect(injected.ok, injected.error?.message).toBe(true);
+    const failed = facade.rallar.diagnostics.storageFaults.observe({ owner: 'al-admission', kind: 'read' });
+    await expect(failed).rejects.toMatchObject({ name: 'UnknownError' });
+
+    expect((await runtime.execute({ kind: 'close' })).ok).toBe(true);
+
+    expect(facade.rallar.diagnostics.storageFaults.observe({ owner: 'al-admission', kind: 'read' })).toBeUndefined();
+});
+
 it('closes the exact idle successful prefix through its existing close operation', async () => {
     const { runtime, frame } = await createHeldFaultRuntime();
     const close = { kind: 'close' as const, targetCommandId: 'hold-prefix' };
```

```diff
diff --git a/packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts b/packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts
index 0ac1407f0..b674cc2c2 100644
--- a/packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts
@@ -40,6 +40,10 @@ import {
     createCountingIndexedDbOperationObserver,
     type CountingIndexedDbOperationObserver
 } from '@shared/persistence/indexed-db-operation-observer.ts';
+import {
+    createScriptedStorageFaultPort,
+    type ScriptedStorageFaultPort
+} from '@shared/persistence/storage-fault-port.ts';
 import {
     createScriptedTransportFaultPort,
     type ScriptedTransportFaultPort
@@ -347,6 +351,7 @@ const director: BlackBoxBrowserDirectorDependency = {
 
 let scriptedFaults = createScriptedTransportFaultPort();
 let countingStorage = createCountingIndexedDbOperationObserver();
+let scriptedStorageFaults = createScriptedStorageFaultPort();
 let deliveryRegistry = createFacadeDeliveryRegistry();
 let deliverySequence = 0;
 
@@ -374,6 +379,9 @@ const diagnostics: BlackBoxBrowserDiagnosticsDependency = {
     },
     get storage(): CountingIndexedDbOperationObserver {
         return countingStorage;
+    },
+    get storageFaults(): ScriptedStorageFaultPort {
+        return scriptedStorageFaults;
     }
 };
 
@@ -420,6 +428,7 @@ export function resetBrowserRuntimeFacadeTestDouble(): void {
     clearRecords();
     scriptedFaults = createScriptedTransportFaultPort();
     countingStorage = createCountingIndexedDbOperationObserver();
+    scriptedStorageFaults = createScriptedStorageFaultPort();
     deliveryRegistry = createFacadeDeliveryRegistry();
     facadeBehavior.login.mockResolvedValue(facadeSession);
     facadeBehavior.registerAndLogin.mockResolvedValue(facadeSession);
```

Run:

```sh
npx vitest run packages/tests/shared-test/alm-storage-fault-contract.test.ts packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts packages/tests/shared-test/rallar-browser-runtime/fault-lifetime-cleanup.test.ts
```

Expected (measured with steps 1–5 applied and the harness at base): `Test Files  3 failed (3)`, `Tests  5 failed | 38 passed (43)` — the three storage acceptance cases of the contract test (the schema has no `storage` branch), the routing test (the decoder refuses carrier `storage`) and the close test (the `fault.inject` result is not ok); the refusal cases already pass.

- [ ] **Step 7: Add `carrier: 'storage'` to the recipe surface.** `packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts b/packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts
index 68fcb2bb5..48b165f76 100644
--- a/packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts
+++ b/packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts
@@ -1,4 +1,8 @@
 import { AL_DURABILITY_ALGOS } from '@shared/al-contracts/al-policy.ts';
+import {
+    INDEXED_DB_OPERATION_KINDS,
+    INDEXED_DB_OPERATION_OWNERS
+} from '@shared/persistence/indexed-db-operation-observer.ts';
 import type { RallarBlackBoxTestCommandKind } from '../rallar-black-box-test-contracts.ts';
 
 export interface RallarBlackBoxCommandFieldSet {
@@ -251,6 +255,7 @@ export const RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS = {
     httpResponse: { required: [], optional: ['body', 'maxBodyChars', 'acceptedStatusCodes'] },
     faultMatch: { required: [], optional: ['controlType', 'typeId', 'msgId'] },
     faultDelayAction: { required: ['delayMs'], optional: [] },
+    storageFaultMatch: { required: ['owner'], optional: ['kind'] },
     messagesReplay: { required: ['handleId', 'carrier'], optional: [] },
     messagesSnapshotFloor: { required: [], optional: ['absolute', 'aboveCurrentBy'] },
     messagesQos: { required: ['ack'], optional: [] },
@@ -296,6 +301,9 @@ export const RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES = {
     messagesToPeer: ['server', 'receiver'],
     /** One carrier leg: the carrier a replay or a raw control is admitted on. */
     messagesCarrierLeg: ['ws', 'rtc'],
-    faultCarrier: ['ws', 'rtc'],
-    faultControlType: ['ack', 'nack', 'repair']
+    faultCarrier: ['ws', 'rtc', 'storage'],
+    faultControlType: ['ack', 'nack', 'repair'],
+    storageFaultOwner: INDEXED_DB_OPERATION_OWNERS,
+    storageFaultKind: INDEXED_DB_OPERATION_KINDS,
+    storageFaultAction: ['fail', 'quota']
 } as const;
```

`packages/shared-test/rallar-bb-test/schema.ts` (a third `oneOf` branch; the delay action and the lifetime schema are shared by name):

```diff
diff --git a/packages/shared-test/rallar-bb-test/schema.ts b/packages/shared-test/rallar-bb-test/schema.ts
index 516184466..1c52b197e 100644
--- a/packages/shared-test/rallar-bb-test/schema.ts
+++ b/packages/shared-test/rallar-bb-test/schema.ts
@@ -441,10 +441,21 @@ const faultMatchSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIEL
     typeId: stringSchema,
     msgId: stringSchema
 });
+const faultDelayActionSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.faultDelayAction, {
+    delayMs: numberSchema
+});
 const faultActionSchema: JsonSchema = {
+    oneOf: [{ type: 'string', enum: ['drop', 'not-ready'] }, faultDelayActionSchema]
+};
+const faultRemainingSchema: JsonSchema = { oneOf: [numberSchema, { const: 'until-cleared' }] };
+const storageFaultMatchSchema = strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.storageFaultMatch, {
+    owner: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.storageFaultOwner },
+    kind: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.storageFaultKind }
+});
+const storageFaultActionSchema: JsonSchema = {
     oneOf: [
-        { type: 'string', enum: ['drop', 'not-ready'] },
-        strictObjectSchema(RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.faultDelayAction, { delayMs: numberSchema })
+        { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.storageFaultAction },
+        faultDelayActionSchema
     ]
 };
 
@@ -644,15 +655,24 @@ const COMMAND_SCHEMAS: Readonly<Record<RallarBlackBoxTestCommandKind, JsonSchema
         toPeerId: stringSchema
     }),
     'fault.inject': {
-        oneOf: ['ws', 'rtc'].map((carrier) =>
+        oneOf: [
+            ...['ws', 'rtc'].map((carrier) =>
+                strictCommandSchema('fault.inject', {
+                    faultId: stringSchema,
+                    carrier: { const: carrier },
+                    match: faultMatchSchema,
+                    action: carrier === 'ws' ? faultActionSchema : { const: 'drop' },
+                    remaining: faultRemainingSchema
+                })
+            ),
             strictCommandSchema('fault.inject', {
                 faultId: stringSchema,
-                carrier: { const: carrier },
-                match: faultMatchSchema,
-                action: carrier === 'ws' ? faultActionSchema : { const: 'drop' },
-                remaining: { oneOf: [numberSchema, { const: 'until-cleared' }] }
+                carrier: { const: 'storage' },
+                match: storageFaultMatchSchema,
+                action: storageFaultActionSchema,
+                remaining: faultRemainingSchema
             })
-        )
+        ]
     },
     'storage.counters': strictCommandSchema('storage.counters', {
         reset: booleanSchema
```

`packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts b/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
index 9cb93edec..6d264a5ac 100644
--- a/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
+++ b/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
@@ -5,6 +5,11 @@ import type {
     ALDeliveryCarrier,
     ALDeliveryState
 } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
+import type {
+    IndexedDbOperationKind,
+    IndexedDbOperationOwner
+} from '@shared/persistence/indexed-db-operation-observer.ts';
+import type { ScriptedStorageFault } from '@shared/persistence/storage-fault-port.ts';
 import type { ScriptedTransportFault } from '@shared/transport-faults/transport-fault-port.ts';
 
 import type { RallarBlackBoxTestMessagesControlFields } from './alm/rallar-black-box-test-messages-control-fields.ts';
@@ -380,6 +385,10 @@ export type RallarBlackBoxTestMessagesControlCommand =
     & RallarBlackBoxTestMessagesControlFields;
 
 export type RallarBlackBoxTestFaultInjectCommand =
+    | RallarBlackBoxTestTransportFaultInjectCommand
+    | RallarBlackBoxTestStorageFaultInjectCommand;
+
+export type RallarBlackBoxTestTransportFaultInjectCommand =
     & RallarBlackBoxTestCommandBase<'fault.inject'>
     & Readonly<{
         faultId: string;
@@ -389,6 +398,17 @@ export type RallarBlackBoxTestFaultInjectCommand =
         remaining: ScriptedTransportFault['remaining'];
     }>;
 
+/** An absent `match.kind` faults every operation of the owner; `quota` still fails only its writes. */
+export type RallarBlackBoxTestStorageFaultInjectCommand =
+    & RallarBlackBoxTestCommandBase<'fault.inject'>
+    & Readonly<{
+        faultId: string;
+        carrier: 'storage';
+        match: Readonly<{ owner: IndexedDbOperationOwner; kind?: IndexedDbOperationKind; }>;
+        action: ScriptedStorageFault['action'];
+        remaining: ScriptedStorageFault['remaining'];
+    }>;
+
 export type RallarBlackBoxTestStorageCountersCommand =
     & RallarBlackBoxTestCommandBase<'storage.counters'>
     & Readonly<{ reset?: boolean; }>;
```

`packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts b/packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts
index 89e98b706..6f50a5f50 100644
--- a/packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts
+++ b/packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts
@@ -242,8 +242,9 @@ function validateFaultInjectCommand(command: RallarBlackBoxTestRecord): readonly
             path,
             allowed: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.faultCarrier
         }),
-        ...validateFaultMatchField(command),
-        ...validateFaultActionField(command),
+        ...(command.carrier === 'storage'
+            ? [...validateStorageFaultMatchField(command), ...validateStorageFaultActionField(command)]
+            : [...validateFaultMatchField(command), ...validateFaultActionField(command)]),
         ...(command.remaining === 'until-cleared' ? [] : validateNumberField(command, 'remaining', path))
     ];
 }
@@ -267,6 +268,45 @@ function validateFaultMatchField(command: RallarBlackBoxTestRecord): readonly Co
     ];
 }
 
+function validateStorageFaultMatchField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
+    const match = command.match;
+    const path = 'fault.inject.match';
+    if (!isJsonRecordValue(match)) {
+        return [toControlCommandIssue(`${path} must be an object.`)];
+    }
+    const fields = RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.storageFaultMatch;
+    return [
+        ...validateAllowedFields(match, fields, path),
+        ...validateRequiredFields({ record: match, fields, path, ownMessageFields: [] }),
+        ...validateEnumField({
+            record: match,
+            key: 'owner',
+            path,
+            allowed: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.storageFaultOwner
+        }),
+        ...validateEnumField({
+            record: match,
+            key: 'kind',
+            path,
+            allowed: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.storageFaultKind
+        })
+    ];
+}
+
+function validateStorageFaultActionField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
+    const action = command.action;
+    const path = 'fault.inject.action';
+    if (action === 'fail' || action === 'quota') {
+        return [];
+    }
+    if (!isJsonRecordValue(action)) {
+        return [
+            toControlCommandIssue(`${path} must be "fail", "quota" or an object with delayMs on the storage carrier.`)
+        ];
+    }
+    return validateFaultDelayAction(action, path);
+}
+
 function validateFaultActionField(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
     const action = command.action;
     const path = 'fault.inject.action';
@@ -282,6 +322,10 @@ function validateFaultActionField(command: RallarBlackBoxTestRecord): readonly C
     if (!isJsonRecordValue(action)) {
         return [toControlCommandIssue(`${path} must be "drop", "not-ready" or an object with delayMs.`)];
     }
+    return validateFaultDelayAction(action, path);
+}
+
+function validateFaultDelayAction(action: RallarBlackBoxTestRecord, path: string): readonly ControlCommandIssue[] {
     const fields = RALLAR_BLACK_BOX_COMMAND_OBJECT_FIELDS.faultDelayAction;
     return [
         ...validateAllowedFields(action, fields, path),
```

`packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts b/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts
index 84f04155e..b82a718c9 100644
--- a/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts
+++ b/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts
@@ -128,8 +128,10 @@ export const RALLAR_BLACK_BOX_ALM_COMMAND_CAPABILITIES: readonly Omit<
     },
     {
         kind: 'fault.inject',
-        title: 'Inject Transport Fault',
+        title: 'Inject Transport or Storage Fault',
         description: 'Schedules a drop for matching WS/RTC traffic, or WS-only delay or not-ready submission faults. ' +
+            'carrier storage instead faults the IndexedDB operations of match.owner (al-admission or al-work) and ' +
+            'optionally match.kind: fail, quota (writes only) or a delay. ' +
             'remaining is a finite match count or until-cleared; replacing the same faultId with remaining:0 releases it.',
         supportedProviderModes: ['browser-rallar', 'rallar-browser', 'rallar-remote-browser'],
         runtimeSurfaces: ['spa-local', 'control-agent'],
```

`packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md` (the navigation map for the command):

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
index b491eeeeb..e0ac9d324 100644
--- a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
+++ b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
@@ -458,6 +458,19 @@ id. A top-level `typeId` never matches. The fault's observations are not
 readable from a recipe in this release, so a fault's effect can only be inferred
 from what the receiver did or did not get.
 
+`fault.inject` with `carrier: 'storage'` faults the AL-owned IndexedDB
+operations instead: `match.owner` is `al-admission` or `al-work`, and
+`match.kind`, when present, narrows it to one operation kind (the kinds
+`storage.counters` reports). `action: 'fail'` rejects the operation with an
+`UnknownError` `DOMException`, `action: 'quota'` rejects a write (`write`,
+`work-write`, `work-reserve`, `work-release`, `work-cleanup`) with a
+`QuotaExceededError` and lets reads through, and `{ delayMs }` holds the
+operation. The decision lands before the operation's transaction opens, or
+between a reservation's finished read and its write, so a fault never leaves
+half a write. The operation is still counted by `storage.counters`. Replacing
+the same `faultId` with `remaining: 0` releases it, and `close` clears every
+storage fault with the transport faults.
+
 `storage.counters` reads the AL-owned IndexedDB operation counters as
 `{ total, byOwner: { 'al-admission', 'al-work' }, byKind, workProbeCount,
 workNonProbeCount, reset }`, and `reset: true` reads and then clears them.
```

- [ ] **Step 8: Decode, route and clear the storage fault in the page runtime.** `messaging/decode-black-box-rallar-messaging-input.ts`:

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts
index 6df2ab285..b9b7ffede 100644
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts
@@ -1,4 +1,9 @@
 import { AL_DELIVERY_STATES, type ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
+import {
+    INDEXED_DB_OPERATION_KINDS,
+    INDEXED_DB_OPERATION_OWNERS
+} from '@shared/persistence/indexed-db-operation-observer.ts';
+import type { ScriptedStorageFault, StorageFaultMatch } from '@shared/persistence/storage-fault-port.ts';
 import { Either } from '@shared/resilience/Either.ts';
 import type {
     ScriptedTransportFault,
@@ -15,6 +20,7 @@ import {
     decodeBlackBoxCommandNumber,
     decodeBlackBoxCommandString,
     isBlackBoxCommandRecord,
+    type BlackBoxRallarCommandRecord,
     type BlackBoxRallarInputIssue
 } from '../decode-black-box-rallar-command-input.ts';
 
@@ -65,13 +71,19 @@ export function decodeBlackBoxRallarDeliveryObserveInput(
 
 export function decodeBlackBoxRallarFaultInput(
     value: unknown
-): Either<BlackBoxRallarInputIssue, ScriptedTransportFault> {
+): Either<BlackBoxRallarInputIssue, ScriptedTransportFault | ScriptedStorageFault> {
     if (!isBlackBoxCommandRecord(value)) {
         return toInputIssue('fault.inject input must be an object.');
     }
+    return value.carrier === 'storage' ? decodeStorageFault(value) : decodeTransportFault(value);
+}
+
+function decodeTransportFault(
+    value: BlackBoxRallarCommandRecord
+): Either<BlackBoxRallarInputIssue, ScriptedTransportFault> {
     const carrier = value.carrier;
     if (!isFaultCarrier(carrier)) {
-        return toInputIssue('fault.inject.carrier must be ws or rtc.');
+        return toInputIssue('fault.inject.carrier must be ws, rtc or storage.');
     }
     return decodeFaultAction(value.action).flatMap(
         (issue) => Either.ofLeft(issue),
@@ -98,6 +110,30 @@ export function decodeBlackBoxRallarFaultInput(
     );
 }
 
+function decodeStorageFault(
+    value: BlackBoxRallarCommandRecord
+): Either<BlackBoxRallarInputIssue, ScriptedStorageFault> {
+    const faultId = decodeBlackBoxCommandString(value.faultId);
+    if (faultId === undefined) {
+        return toInputIssue('fault.inject.faultId is required.');
+    }
+    return decodeStorageFaultAction(value.action).flatMap(
+        (issue) => Either.ofLeft(issue),
+        (action) =>
+            decodeStorageFaultMatch(value.match).flatMap(
+                (issue) => Either.ofLeft(issue),
+                (match) =>
+                    decodeFaultRemaining(value.remaining).mapRight((remaining) => ({
+                        faultId,
+                        carrier: 'storage',
+                        match,
+                        action,
+                        remaining
+                    }))
+            )
+    );
+}
+
 export function decodeBlackBoxRallarStorageCountersInput(
     value: unknown
 ): Either<BlackBoxRallarInputIssue, BlackBoxRallarStorageCountersInput> {
@@ -123,6 +159,34 @@ function decodeFaultAction(value: unknown): Either<BlackBoxRallarInputIssue, Scr
         : Either.ofRight({ delayMs });
 }
 
+function decodeStorageFaultAction(value: unknown): Either<BlackBoxRallarInputIssue, ScriptedStorageFault['action']> {
+    if (value === 'fail' || value === 'quota') {
+        return Either.ofRight(value);
+    }
+    const delayMs = isBlackBoxCommandRecord(value) ? decodeBlackBoxCommandNumber(value.delayMs) : undefined;
+    return delayMs === undefined
+        ? toInputIssue(
+            'fault.inject.action must be "fail", "quota" or an object naming delayMs on the storage carrier.'
+        )
+        : Either.ofRight({ delayMs });
+}
+
+function decodeStorageFaultMatch(value: unknown): Either<BlackBoxRallarInputIssue, StorageFaultMatch> {
+    if (!isBlackBoxCommandRecord(value)) {
+        return toInputIssue('fault.inject.match must be an object.');
+    }
+    const owner = INDEXED_DB_OPERATION_OWNERS.find((candidate) => candidate === value.owner);
+    if (owner === undefined) {
+        return toInputIssue('fault.inject.match.owner must be al-admission or al-work on the storage carrier.');
+    }
+    const kind = value.kind ?? undefined;
+    const knownKind = INDEXED_DB_OPERATION_KINDS.find((candidate) => candidate === kind);
+    if (kind !== undefined && knownKind === undefined) {
+        return toInputIssue(`fault.inject.match.kind must be one of ${INDEXED_DB_OPERATION_KINDS.join(', ')}.`);
+    }
+    return Either.ofRight({ owner, kind: knownKind });
+}
+
 function decodeFaultRemaining(value: unknown): Either<BlackBoxRallarInputIssue, ScriptedTransportFault['remaining']> {
     if (value === 'until-cleared') {
         return Either.ofRight(value);
```

`browser-rallar-runtime-composition.ts`:

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts
index 66bae3e97..8f7ee5e56 100644
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts
@@ -57,6 +57,10 @@ import {
     createCountingIndexedDbOperationObserver,
     type CountingIndexedDbOperationObserver
 } from '@shared/persistence/indexed-db-operation-observer.ts';
+import {
+    createScriptedStorageFaultPort,
+    type ScriptedStorageFaultPort
+} from '@shared/persistence/storage-fault-port.ts';
 import {
     createScriptedTransportFaultPort,
     type ScriptedTransportFaultPort
@@ -137,6 +141,8 @@ export interface BlackBoxBrowserPeersDependency extends Pick<RallarConnectionOpe
 export interface BlackBoxBrowserDiagnosticsDependency {
     readonly faults: ScriptedTransportFaultPort;
     readonly storage: CountingIndexedDbOperationObserver;
+    /** Decides each IndexedDB operation after `storage` has counted it. */
+    readonly storageFaults: ScriptedStorageFaultPort;
 }
 
 export interface BlackBoxBrowserRealtimeDependency
@@ -181,6 +187,7 @@ export function createBlackBoxBrowserRallarRuntimeDependency(
 ): BlackBoxBrowserRallarRuntimeDependency {
     const faults = createScriptedTransportFaultPort();
     const storage = createCountingIndexedDbOperationObserver();
+    const storageFaults = createScriptedStorageFaultPort();
     const { foundation, state, session, stateEvents, messaging, realtime } = createBlackBoxBrowserTransportComposition(
         input.readVolatileSessionLimits
     );
@@ -217,7 +224,7 @@ export function createBlackBoxBrowserRallarRuntimeDependency(
         realtime,
         crdt,
         director,
-        diagnostics: { faults, storage },
+        diagnostics: { faults, storage, storageFaults },
         ...toBlackBoxBrowserMessagingPorts({ session, state })
     });
 }
```

`black-box-rallar-diagnostics.ts` (the counting observer first, then the fault port):

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts
index baf0aafc7..54485252d 100644
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts
@@ -113,7 +113,12 @@ export function createBlackBoxRallarDiagnosticsPorts(
     return {
         transportFaultPort: effects.faults,
         submissionReadinessFaultPort: effects.faults,
-        indexedDbOperationObserver: effects.storage,
+        indexedDbOperationObserver: {
+            observe: (operation) => {
+                effects.storage.observe(operation);
+                return effects.storageFaults.observe(operation);
+            }
+        },
         outboundDiagnostics: (event) =>
             diagnostics.emit({
                 kind: 'diagnostic',
```

`connection/black-box-rallar-connection-runtime.ts`:

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-runtime.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-runtime.ts
index 95f261916..f6b87bae6 100644
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-runtime.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-runtime.ts
@@ -2,6 +2,7 @@ import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rall
 import type { RallarRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
 import { throwRallarValidation } from '@shared/api/rallar-validation.ts';
 import type { IndexedDbOperationCounts } from '@shared/persistence/indexed-db-operation-observer.ts';
+import type { ScriptedStorageFault } from '@shared/persistence/storage-fault-port.ts';
 import type { ScriptedTransportFault } from '@shared/transport-faults/transport-fault-port.ts';
 
 import { BlackBoxRallarCrdtController } from '../black-box-rallar-crdt-controller.ts';
@@ -223,9 +224,14 @@ export class BlackBoxRallarConnectionRuntime {
         });
     }
 
-    #injectFault(fault: ScriptedTransportFault): void {
+    #injectFault(fault: ScriptedTransportFault | ScriptedStorageFault): void {
         this.#requireScriptedPorts('fault.inject');
-        this.#foundation.rallar.diagnostics.faults.inject(fault);
+        const { diagnostics } = this.#foundation.rallar;
+        if (fault.carrier === 'storage') {
+            diagnostics.storageFaults.inject(fault);
+            return;
+        }
+        diagnostics.faults.inject(fault);
     }
 
     #readStorageCounters(counters: BlackBoxRallarStorageCountersInput): IndexedDbOperationCounts {
```

`connection/black-box-rallar-close-operation.ts`:

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-close-operation.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-close-operation.ts
index f203fb694..1a385b5bb 100644
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-close-operation.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-close-operation.ts
@@ -82,7 +82,10 @@ export class BlackBoxRallarCloseOperation {
                 authentication.clear();
                 throw error;
             }
-        }, activeCrdtOpens).finally(() => this.#input.rallar.diagnostics.faults.clear());
+        }, activeCrdtOpens).finally(() => {
+            this.#input.rallar.diagnostics.faults.clear();
+            this.#input.rallar.diagnostics.storageFaults.clear();
+        });
     };
 
     #resolveCloseConfig(
```

- [ ] **Step 9: Narrow the widened `fault.inject` union where code reads a transport matcher.** `conformance/alm/assess-alm-reload-identity.ts` (a reload hold is a transport fault):

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts b/packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts
index ae8a00d3d..697e024ed 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts
@@ -4,6 +4,7 @@ import type {
     RallarBlackBoxTestAgentReloadCommand,
     RallarBlackBoxTestCommand,
     RallarBlackBoxTestMessagesSendCommand,
+    RallarBlackBoxTestTransportFaultInjectCommand,
     RallarBlackBoxTestWaitCommand
 } from '../../rallar-black-box-test-contracts.ts';
 import { decodeJsonValue } from '../../runtime/decode-runtime-result-values.ts';
@@ -190,7 +191,9 @@ function assessReloadCommands(evidence: ReloadEvidence): readonly string[] {
 function hasReloadNativeHolds({ send, prefix }: ReloadEvidence): boolean {
     const selectedCarriers = send.carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [send.carrier];
     const sendIndex = prefix.indexOf(send);
-    const holds = prefix.filter((command) => command.kind === 'fault.inject');
+    const holds = prefix.filter((command): command is RallarBlackBoxTestTransportFaultInjectCommand =>
+        command.kind === 'fault.inject' && command.carrier !== 'storage'
+    );
     const matchingHolds = selectedCarriers.every((carrier) =>
         holds.some((hold) =>
             hold.carrier === carrier && hold.action === (carrier === 'ws' ? 'not-ready' : 'drop') &&
```

And the four tests and the Deno fixture that read `match.typeId`/`match.controlType` or build the diagnostics dependency:

```diff
diff --git a/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts b/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
index 79162425d..cd83748a6 100644
--- a/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
+++ b/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
@@ -191,7 +191,10 @@ describe('ALM combined recipient-b ACK-hold ordering', () => {
             // previous block's own last command — the one that must hold the ACK open — sits just before it.
             for (let i = 2; i < commands.length; i++) {
                 const command = commands[i]!;
-                if (command.kind !== 'fault.inject' || command.match.controlType !== 'ack' || command.remaining !== 'until-cleared') {
+                if (
+                    command.kind !== 'fault.inject' || command.carrier === 'storage' || command.match.controlType !== 'ack' ||
+                    command.remaining !== 'until-cleared'
+                ) {
                     continue;
                 }
                 const currentPrefix = prefixOf(command.commandId);
```

```diff
diff --git a/packages/tests/shared-test/alm-conformance-recipes.test.ts b/packages/tests/shared-test/alm-conformance-recipes.test.ts
index ffc0dd3d1..74207466c 100644
--- a/packages/tests/shared-test/alm-conformance-recipes.test.ts
+++ b/packages/tests/shared-test/alm-conformance-recipes.test.ts
@@ -68,7 +68,7 @@ function toRoutedTypeIds(command: RallarBlackBoxTestCommand): readonly string[]
         case 'wait':
             return command.match.topic === INBOUND_DIAGNOSTICS_TOPIC ? toAdmissionOutcomeTypeIds(command.match.contains) : [];
         case 'fault.inject':
-            return command.match.typeId === undefined ? [] : [command.match.typeId];
+            return command.carrier === 'storage' || command.match.typeId === undefined ? [] : [command.match.typeId];
         default:
             return [];
     }
```

```diff
diff --git a/packages/tests/shared-test/alm-identity-assessment.test.ts b/packages/tests/shared-test/alm-identity-assessment.test.ts
index 606ece8b6..5a589d0c9 100644
--- a/packages/tests/shared-test/alm-identity-assessment.test.ts
+++ b/packages/tests/shared-test/alm-identity-assessment.test.ts
@@ -283,6 +283,9 @@ describe('ALM recipe identity assessment', () => {
         (defect) => {
             const transcript = new IdentityTranscript('reload', 'rtc-with-ws-fallback');
             const hold = transcript.sender.command('fault.inject', 1);
+            if (hold.carrier === 'storage') {
+                throw new Error('The reload hold is a transport fault.');
+            }
             if (defect === 'missing') {
                 transcript.sender.removeCommand(hold);
             }
```

```diff
diff --git a/packages/tests/shared-test/alm-cross-carrier-duplicate-outcome.test.ts b/packages/tests/shared-test/alm-cross-carrier-duplicate-outcome.test.ts
index ab915899d..dc1d1c0ca 100644
--- a/packages/tests/shared-test/alm-cross-carrier-duplicate-outcome.test.ts
+++ b/packages/tests/shared-test/alm-cross-carrier-duplicate-outcome.test.ts
@@ -17,6 +17,7 @@ import {
 import { createRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
 import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
 import { createCountingIndexedDbOperationObserver, createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
+import { createScriptedStorageFaultPort } from '@shared/persistence/storage-fault-port.ts';
 import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
 
 import {
@@ -75,7 +76,8 @@ async function runDuplicateOutcomeCommands(
     });
     const ports = createBlackBoxRallarDiagnosticsPorts(pageDiagnostics, {
         faults: createScriptedTransportFaultPort(),
-        storage: createCountingIndexedDbOperationObserver()
+        storage: createCountingIndexedDbOperationObserver(),
+        storageFaults: createScriptedStorageFaultPort()
     });
     const { runtime, diagnostics } = createInboundTestRuntime({
         carrier: 'rtc',
```

```diff
diff --git a/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts b/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
index ff36c6ce9..86b2449a7 100644
--- a/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
+++ b/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
@@ -300,7 +300,7 @@ class GeneratedAlmPorts {
         if (command.remaining === 0) {
             this.holds.delete(command.faultId);
         }
-        else {
+        else if (command.carrier !== 'storage') {
             this.holds.set(command.faultId, String(command.match?.typeId));
         }
         for (const message of this.messages) {
```

(Task 9 replaces the fixture's `else if (command.carrier !== 'storage')` with an early storage return when it models the storage scenario.)

- [ ] **Step 10: Run the harness tests green.**

```sh
npx vitest run packages/tests/shared-test packages/tests/shared/persistence packages/tests/shared/alm packages/tests/shared/queuebox packages/tests/shared-web/al-runtime packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
```

Expected (measured, sandbox disabled): every file passes; `alm-storage-fault-contract` 12, `messaging` 16, `fault-lifetime-cleanup` 15. Under the sandbox, `api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe` and `local-websocket-session` fail with `listen EPERM` (environmental; 48 passed unsandboxed), and `browser-al-runtime-stores` 'keeps the session inbound memory pair out of IndexedDB' timed out once under full parallel load and passed 3 of 3 alone.

- [ ] **Step 11: The budgets.**

```sh
npx vitest run packages/tests/rallar-black-box-headless
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

Expected first (measured on the assembled commit `3561cc9f3`): the headless agent measures 296.491 KiB against 296
(295.597 after Task 7) — the port, the decoder branch, the schema branch and the capability text — and
`browser/rallar.ts` 232.010 KiB against 232 (231.925), since the facade bundle carries the widened observer seam and
the operation lists. Raise each to the next whole KiB, nothing more (R-I2a-i-48):

```diff
diff --git a/packages/tests/rallar-black-box-headless/headless-bundle-budget.json b/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
--- a/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
+++ b/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
@@ -1,3 +1,3 @@
 {
-  "brotliBudgetKiB": 296
+  "brotliBudgetKiB": 297
 }
diff --git a/packages/shared-web/bundle-budgets.json b/packages/shared-web/bundle-budgets.json
--- a/packages/shared-web/bundle-budgets.json
+++ b/packages/shared-web/bundle-budgets.json
@@ -1,5 +1,5 @@
 {
-  "browser/rallar.ts": 232,
+  "browser/rallar.ts": 233,
   "browser/rallar-core.ts": 100,
   "browser/rallar-realtime.ts": 100,
   "browser/rallar-data.ts": 20,
```

Rerun: `Tests  4 passed (4)` and `Bundle budget check passed.` (The prototype on the base measured 294.467 KiB headless
and 230.2 KiB `rallar.ts`; brotli does not add linearly, so the crossing is read on the real tree.)

- [ ] **Step 12: Per-task checks.**

```sh
npx dprint fmt apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-close-operation.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-runtime.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts packages/shared-test/rallar-bb-test/schema.ts packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts packages/shared-web/bundle-budgets.json packages/shared/alm/indexed-db-admission-backend.ts packages/shared/alm/indexed-db-admission-read-session.ts packages/shared/persistence/indexed-db-operation-observer.ts packages/shared/persistence/storage-fault-port.ts packages/shared/queuebox/indexed-db-queue-box.ts packages/tests/rallar-black-box-headless/headless-bundle-budget.json packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-cross-carrier-duplicate-outcome.test.ts packages/tests/shared-test/alm-identity-assessment.test.ts packages/tests/shared-test/alm-storage-fault-contract.test.ts packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts packages/tests/shared-test/rallar-browser-runtime/fault-lifetime-cleanup.test.ts packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts packages/tests/shared/alm/indexed-db-storage-faults.test.ts packages/tests/shared/persistence/storage-fault-port.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-test/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
node scripts/check-tests-typecheck.mjs
(cd apps/rallar-black-box-control-server && deno task check)
(cd apps/api-v1 && deno task check)
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx vitest run packages/tests/rallar-black-box-headless
```

Expected (measured on `3561cc9f3`): every typecheck silent; `check-tests-typecheck: 1421 test files enforced … PASS: no new type errors`; both Deno checks exit 0; `Bundle budget check passed.`; headless `4 passed`. After committing:

```sh
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
npm run check:test-reachability
```

Expected: `PASS: no new repository style findings`; the coupling check `PASS` (no candidate of this task's); `Test reachability: 1723 test files, 1717 reached by CI, 6 manual.` (measured on `3561cc9f3`).

- [ ] **Step 13: Commit.**

```sh
git add -A && git commit -F - <<'EOF'
Let a scripted storage fault fail or hold an IndexedDB operation

The IndexedDB operation observer becomes an interceptor: observe(operation)
may return a promise that holds the operation or fails it with a
DOMException by name, and every call site in the admission backend, its read
session and the queue box awaits only a returned promise, before its
transaction opens or between a reservation's finished read and its write.
The production pass-through returns nothing and adds no microtask; the
ledger and operation-count pins are unchanged.

ScriptedStorageFaultPort follows ScriptedTransportFaultPort (inject, clear,
getObservations; fail, quota on writes only, or a delay), and fault.inject
gains carrier 'storage' through the schema, the control validator and the
page decoder, decided after the counting observer and cleared on close.

The headless agent measures 296.491 KiB brotli, so its budget rises from 296
to 297 KiB; browser/rallar.ts measures 232.010 KiB, so its budget rises from
232 to 233 KiB.

D8 reuse: ScriptedTransportFaultPort's shape and remaining:0 release, LatestRepository for the fault set, the existing operation kinds and delay-action field set; no second observer seam, no fault.clear command, no new timer outside the scripted delay.
EOF
```

---

### Task 9: The `storage-unavailable` scenario, `delivery-reload` reading `recovery`, and each durable store's recovery outcome

Prototyped in `scratch-E` as commit `7586f33e1` on Task 8 and a scratch stub of the Task 1–3 shapes (the stub is
dropped); assembled as `285d9d1b0` on `scratch/i2a-assemble` over the real Tasks 1–8, reconciled to the rulings:
the recovery reporter is its own module in `packages/shared/alm/storage/` (R-I2a-i-57; the changed-style gate passes
with this fifth `al-storage-*` file, so it is not folded into the health module); it states a recovery through
`ALStorageHealth.recordRecovery(outcome)`, which this task adds, and an eviction through the same health's
`recordFailure` (R-I2a-i-22, R-I2a-i-55, R-I2a-i-56), so `browser-al-runtime-stores.ts` does not change (Task 2's
`toBrowserStoreOptions` already gives each store its health); the factories build the reporter from the store pair's
`storageHealth` instead of a separate `onStorageRecovery` input; the three harness projections carry
`durabilityDowngrade` (R-I2a-i-51, Steps 9 and 11); manifest 18's description names `storage-unavailable`
(R-I2a-i-61, Step 14). The diffs below are cut from the assembled commits (`3561cc9f3` → `285d9d1b0`). Proposal §3.h,
§3.j and D124; fact sheet items 4, 9 and 12.

**Files**

- Modify: `packages/shared/persistence/open-indexed-db.ts` — `OpenedIndexedDb.created` (`:30-34`), set by
  `upgradeneeded` (`:182-203`).
- Modify: `packages/shared/alm/open-indexed-db-admission-database.ts` — `ALStorageOpening`,
  `OpenedIndexedDbAdmissionStorage`, the document's database memory (a `LatestRepository` fed by a `versionchange`
  listener) and `openIndexedDbAdmissionStorage` (the existing `openIndexedDbAdmissionDatabase` now returns its `.db`).
  The file ends at 314 lines.
- Create: `packages/shared/alm/storage/al-storage-recovery-reporter.ts` (72 lines) — `ALStorageRecoveryReporter`,
  `CreateALStorageRecoveryReporterInput`, `createALStorageRecoveryReporter` and the private `computeALStorageRecovery`.
- Modify: `packages/shared/alm/storage/al-storage-health.ts` — `recordRecovery(outcome)` (R-I2a-i-22);
  `packages/shared/alm/storage/al-storage-event.ts` — `storage-reset`'s `reason` gains `'other-context'`.
- Modify: `packages/shared/alm/indexed-db-admission-backend.ts` — records each open's `ALStorageOpening`
  (`getStorageOpening()`); `packages/shared/queuebox/indexed-db-queue-box.ts` — counts the expired rows
  `reserveEntries` deletes (`getReservationExpiredDeleteCount()`, `:415-421`).
- Modify: `packages/shared/alm/al-runtime-stores.ts` — the two IndexedDB factories build the reporter for a backend
  they open when the pair has a `storageHealth` (restructured into `createIndexedDbAdmissionBackend` +
  `toIndexedDb*RuntimeStores`, so neither factory needs a non-null assertion).
- Modify: `packages/shared/alm/inbound/al-inbound-message-runtime.ts`, `outbound/al-outbound-message-runtime.ts`
  (`storageRecovery` on the stores and the `Resources`), `create-default-al-{in,out}bound-message-runtime.ts`,
  `inbound/lane/al-inbound-store-lane.ts` and `outbound/lane/al-outbound-store-lane.ts` (the first `work-batch`
  diagnostic reports).
- Modify (harness): `messages.send` carries `onStorageUnavailable`: `rallar-bb-test/schema.ts`,
  `schema/rallar-black-box-command-fields.ts`, `rallar-black-box-test-contracts.ts`, `alm/validate-alm-control-command.ts`,
  `alm/rallar-black-box-alm-command-capabilities.ts`, `black-box-runner/.../black-box-rallar-operation-contracts.ts`,
  `messaging/decode-black-box-rallar-message-send-input.ts` (the four enum options folded into one
  `decodeKnownSendOption`, which keeps the file under the cognitive-load warn tier), `messaging/black-box-rallar-typed-channels.ts`,
  `messaging/black-box-rallar-delivery-ledger.ts` (the observation's `durabilityDowngrade`, R-I2a-i-51's first
  projection).
- Modify (R-I2a-i-51, the other two projections): `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts`
  (`RallarBlackBoxTestMessagesObserveResultValue` picks `durabilityDowngrade`),
  `packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts` (`readAlmDurabilityDowngradeField`),
  `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts` (`decodeAlmDurabilityDowngrade`, reusing
  the cause map and `decodeAlmFailureKey`).
- Modify (catalog): `conformance/alm/alm-conformance-fault-commands.ts` (`toAdmissionQuotaFaultCommand`),
  `alm-conformance-message-commands.ts` (`onStorageUnavailable` on the send delivery), `alm-conformance-scenario-definition.ts`
  (the `scenarioId` union), `create-alm-conformance-recipes.ts` (the registry, after `deliveryReload`),
  `scenarios/delivery-reload.ts` (the recovery waits), `assess-alm-reload-identity.ts` (a `wait` in the suffix).
- Create: `conformance/alm/scenarios/storage-unavailable.ts` (159 lines).
- Modify: `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts` — manifest 18's description names the
  scenario (R-I2a-i-61; no entry, family or recipe change); regenerate
  `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json` (manifest 22 unchanged).
- Modify (Deno fixtures): `apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts` — the
  quota, the downgrade, the health transitions and the recoveries the generated manifest now reads;
  `apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts:409` — `durabilityDowngrade: undefined` in
  its fabricated result value.
- Docs: `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (the `recovery` bullet of § Storage
  Diagnostics), `packages/shared/alm/outbound/README.md` ("Atomic IndexedDB work storage"),
  `packages/shared/alm/inbound/README.md` ("The memory and IndexedDB lanes").
- Test (create): `packages/tests/shared/alm/al-storage-recovery.test.ts` (203 lines),
  `packages/tests/shared-web/al-runtime/browser-al-storage-recovery.test.ts` (73),
  `packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts` (191).
- Test (modify): `packages/tests/shared-test/alm-delivery-failure-decoding.test.ts` (three downgrade cases); the pinned
  scenario lists in `alm-conformance-recipes.test.ts`, `alm-conformance-recipe-validation.test.ts`,
  `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`; `storageRecovery: undefined` in the two
  literal runtime resources (`packages/tests/shared/al-outbound-message-runtime.test.ts:61`,
  `packages/tests/shared/alm/al-inbound-admission-preparation.test.ts:572`); `durabilityDowngrade: undefined` in the
  typed observation literals (`packages/tests/rallar-black-box/live-rtc-control-client.test.ts`, six;
  `packages/tests/shared-test/alm-lifecycle-recipes.test.ts:117`).
- Modify: `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (297 → 298).
- Not touched: the ledger and operation-count pins, `browser-al-runtime-stores.ts`, manifest 22, the reload pair
  checkpoint (`toReloadCheckpoint`: the waits sit inside the existing suffix, before `storage-counters-recovered`),
  `packages/shared-web/bundle-budgets.json` (232.585 KiB under the 233 Task 8 set).

**Interfaces**

- Consumes:
  - Task 8: `ScriptedStorageFaultPort`, `RallarBlackBoxTestStorageFaultInjectCommand`, `fault.inject` with
    `carrier: 'storage'`.
  - Task 1: `ALStorageUnavailable` (`packages/shared/alm/storage/al-storage-unavailable.ts`).
  - Task 2: `ALStorageEvent` with the recovery arm `{ kind: 'recovery'; storeId; outcome: ALStorageRecoveryOutcome }`;
    `ALStorageHealth` (`packages/shared/alm/storage/al-storage-health.ts`), one per browser store per connect, on the
    store pair as `storageHealth`; `RallarDiagnosticsPorts.storage`; the harness topic `rallar.browser.alm.storage`
    emitting `data: { ...event }` in the arms' declared key order (`kind`, `storeId`, `outcome` / `status`,
    `lastFailure`, `lastRecoveryPointAtMs`, R-I2a-i-58), which the recipes' `contains` matches rely on.
  - Task 3: a refused durable send settles `failed` with `evidence.failure = { kind: 'storage-unavailable'; cause }`;
    a store's `health` is emitted on transitions, `failing` on the quota failure and `healthy` on the next commit, and
    a `healthy` event keeps that failure as `lastFailure` (the healthy wait matches
    `"status":"healthy","lastFailure":{"cause":"quota"`).
  - Task 4: `RallarTypedMessageChannelDefinition.onStorageUnavailable?: 'refuse' | 'volatile'`;
    `ALDeliveryEvidence.durabilityDowngrade: ALDeliveryDurabilityDowngrade | undefined`; `admittedDurable` false for
    the downgraded send.
  - Task 5: a quota cause is retried by the next admission (the third send commits once the fault is released).
- Produces:
  ```ts
  // packages/shared/persistence/open-indexed-db.ts
  export interface OpenedIndexedDb { readonly db: IDBDatabase; readonly schemaIssues: readonly string[]; readonly created: boolean; }
  // packages/shared/alm/open-indexed-db-admission-database.ts
  export type ALStorageOpening =
      | Readonly<{ kind: 'existing'; }>
      | Readonly<{ kind: 'created'; }>
      | Readonly<{ kind: 'reset'; reason: ALStorageResetEvent['reason'] | 'other-context'; }>
      | Readonly<{ kind: 'evicted'; }>;
  export interface OpenedIndexedDbAdmissionStorage { readonly db: IDBDatabase; readonly opening: ALStorageOpening; }
  export function openIndexedDbAdmissionStorage(input: OpenIndexedDbAdmissionDatabaseInput): Promise<OpenedIndexedDbAdmissionStorage>;
  // packages/shared/alm/storage/al-storage-recovery-reporter.ts
  export interface ALStorageRecoveryReporter { reportFirstBatch(claimedCount: number): void; }
  export interface CreateALStorageRecoveryReporterInput {
      readonly getStorageOpening: () => ALStorageOpening | undefined;
      readonly getReservationExpiredDeleteCount: () => number;
      readonly storageHealth: ALStorageHealth;
  }
  export function createALStorageRecoveryReporter(input: CreateALStorageRecoveryReporterInput): ALStorageRecoveryReporter;
  // packages/shared/alm/storage/al-storage-health.ts
  ALStorageHealth.recordRecovery(outcome: ALStorageRecoveryOutcome): void;   // states { kind: 'recovery', storeId, outcome }
  // packages/shared/alm/storage/al-storage-event.ts
  ALStorageRecoveryOutcome 'storage-reset': Readonly<{ kind: 'storage-reset'; reason: ALStorageResetEvent['reason'] | 'other-context'; }>
  // IndexedDbAdmissionBackend.getStorageOpening(): ALStorageOpening | undefined
  // IndexedDbQueueBox.getReservationExpiredDeleteCount(): number
  // ALInboundRuntimeStores.storageRecovery?: ALStorageRecoveryReporter; ALOutboundRuntimeStores.storageRecovery?: …
  // ALInboundMessageRuntime.Resources.storageRecovery / ALOutboundMessageRuntime.Resources.storageRecovery: ALStorageRecoveryReporter | undefined
  // harness: messages.send.onStorageUnavailable?: 'refuse' | 'volatile';
  //          BlackBoxRallarDeliveryObservation.durabilityDowngrade, RallarBlackBoxTestMessagesObserveResultValue.durabilityDowngrade
  //          decodeAlmDurabilityDowngrade(value: unknown): Either<string, ALDeliveryDurabilityDowngrade>
  // catalog: AlmConformanceScenarioId 'storage-unavailable'; toAdmissionQuotaFaultCommand(step, name, remaining);
  //          RELOAD_RECOVERED_STORE_PREFIXES (delivery-reload.ts)
  ```
  Behaviour: `storage-created` from `upgradeneeded` the first time this document opens the database; `storage-reset`
  from the open's own reset (it wins over the creation it causes), or from a creation after another context's
  `versionchange` closed a database this document had opened (`other-context`); a creation of a database this document
  had opened without a `versionchange` is an eviction, `{ cause: 'evicted', detail }`, recorded as a failure of the
  store's health (a `failing` `health` event, R-I2a-i-56); an existing database reports `restored { claimed, expired }`
  from its first work batch's claims and the expired rows that batch's reservation deleted, or
  `expired-at-recovery { expired }` when it claimed nothing and something expired (`restored { 0, 0 }` when neither).
  One reporter per store pair, and only for a pair the factory opens whose store has a health (every browser store;
  no server or memory pair): the session inbound pair is shared by both carriers' lanes, and whichever first batch
  runs first reports. A durable store whose work never starts (storage missing, Task 3) reports no recovery; its
  unavailability is reported instead (R-I2a-i-55). No IndexedDB operation is added.

**D8 reuse inspection.** Reused: `LatestRepository` for the document's per-database memory (no raw `Map`/`Set`);
`Either` for the recovery value (an eviction is a `Left`, as Task 1's classifier makes storage failure a value),
folded into Task 2's `ALStorageHealth`, the one emitter per store (a recovery is `recordRecovery`, an eviction
`recordFailure`); the lanes' existing `work-batch` diagnostic as the first-batch signal (no new `ALWorkHandler`
dependency or return value); the reservation's existing expired deletes as the `expired` count
(`indexed-db-queue-box.ts:415-421`, counted after its write commits, no new read); the existing `storageResets` relay's
shape for the per-pair `storageRecovery` (present only on a pair the factory opens); the existing `upgradeneeded`
handler for creation; the transport fault release convention and Task 8's storage fault for the scenario; the existing
`toSendCommand`, `toObserveCommand`, `toAdmissionCommands`, `toResultAssertion` and `toPayloadWait` builders; the
reload's existing `toReloadSurvivalTtlMs` as the recovery waits' budget; the failure decoder's cause map and key
reader for the downgrade decoder. Not added: no second health emitter or direct `health` event from the browser
composition (R-I2a-i-56); no new file directly under `packages/shared/alm` (the reporter sits in Task 1's
`storage/` folder; the directory-density gate passes there with five `al-storage-*` files; had the
`layout.feature-prefix-cluster` review fired, the reporter would fold into `al-storage-health.ts`, R-I2a-i-57); no
`indexedDB.databases()` probe or extra read for eviction; no new command kind (`fault.clear` is the existing
`remaining: 0` release); no shared-web import in the catalog (the Deno control server has no `@shared-web` alias, so
the three store-id prefixes are literal and a Vitest test pins them to `toBrowser*ALRuntimeStoreId`); no timer.

- [ ] **Step 1: Write the failing recovery test.** Create `packages/tests/shared/alm/al-storage-recovery.test.ts`:

```ts
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { createDefaultIndexedDbALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import type {
    ALStorageEvent,
    ALStorageRecoveryOutcome
} from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { NEW_AND_RETRY_STATUSES, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import '../../setup-browser-indexeddb.ts';

import { createInboundTestRuntime } from './inbound-runtime-test-fixture.ts';

const STORE_ID = 'recovery-store';
const WORK_TYPE = 'RECOVERY_WORK';
const START_MS = 1_800_000_000_000;

describe('storage recovery outcome of a durable store', () => {
    it('reads storage-created when its open created the database', async () => {
        const store = await openRecoveryStore(newDbName());

        store.report(0);

        expect(store.events).toEqual([toRecoveryEvent({ kind: 'storage-created' })]);
    });

    // A reset recreates the database too: the reset is what the store reports.
    it('reads storage-reset over the creation when its open reset a mismatched schema', async () => {
        const dbName = newDbName();
        (await openIndexedDbAdmissionDatabase({
            ...toDatabaseInput(dbName),
            schemaId: 'an-older-schema'
        })).close();

        const store = await openRecoveryStore(dbName);
        store.report(0);

        expect(store.events).toEqual([
            toRecoveryEvent({ kind: 'storage-reset', reason: 'schema-id-mismatch' })
        ]);
    });

    it('reads storage-reset from another context when a versionchange preceded the creation', async () => {
        const dbName = newDbName();
        await openIndexedDbAdmissionDatabase(toDatabaseInput(dbName));
        await deleteDatabase(dbName);

        const store = await openRecoveryStore(dbName);
        store.report(0);

        expect(store.events).toEqual([
            toRecoveryEvent({ kind: 'storage-reset', reason: 'other-context' })
        ]);
    });

    // An eviction closes the connection without a versionchange, then the next open creates the database.
    it('records failing health with cause evicted when a database this document opened is created again', async () => {
        const dbName = newDbName();
        (await openIndexedDbAdmissionDatabase(toDatabaseInput(dbName))).close();
        await deleteDatabase(dbName);

        const store = await openRecoveryStore(dbName);
        store.report(0);

        await vi.waitFor(() =>
            expect(store.events).toEqual([{
                kind: 'health',
                storeId: STORE_ID,
                status: 'failing',
                lastFailure: { cause: 'evicted', detail: expect.any(String) },
                lastRecoveryPointAtMs: undefined
            }])
        );
    });

    it('reads restored with the first batch\'s claims and the expired rows its reservation deleted', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const previous = await openRecoveryStore(dbName, clock);
        await previous.stores.workQueue.enqueue(workEntry(undefined));
        await previous.stores.workQueue.enqueue(workEntry(START_MS + 1_000));
        clock.nowMs = START_MS + 2_000;

        const store = await openRecoveryStore(dbName, clock);
        const claimed = await reserveAll(store.stores.workQueue);
        store.report(claimed.size);

        expect(claimed.size).toBe(1);
        expect(store.events).toEqual([
            toRecoveryEvent({ kind: 'restored', claimed: 1, expired: 1 })
        ]);
    });

    it('reads expired-at-recovery when the first batch claimed nothing and its reservation deleted expired rows', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const previous = await openRecoveryStore(dbName, clock);
        await previous.stores.workQueue.enqueue(workEntry(START_MS + 1_000));
        clock.nowMs = START_MS + 2_000;

        const store = await openRecoveryStore(dbName, clock);
        store.report((await reserveAll(store.stores.workQueue)).size);

        expect(store.events).toEqual([
            toRecoveryEvent({ kind: 'expired-at-recovery', expired: 1 })
        ]);
    });

    it('reads restored with nothing claimed when an existing database held no work', async () => {
        const dbName = newDbName();
        await openRecoveryStore(dbName);

        const store = await openRecoveryStore(dbName);
        store.report(0);

        expect(store.events).toEqual([
            toRecoveryEvent({ kind: 'restored', claimed: 0, expired: 0 })
        ]);
    });

    it('reports once per store, from the first batch only', async () => {
        const store = await openRecoveryStore(newDbName());

        store.report(0);
        store.report(3);

        expect(store.events).toHaveLength(1);
    });

    it('reports one outcome from a durable lane\'s first work batch', async () => {
        const events: ALStorageEvent[] = [];
        const stores = createDefaultIndexedDbALInboundRuntimeStores({
            dbName: newDbName(),
            namespace: 'recovery-lane',
            storageHealth: new ALStorageHealth({
                storeId: STORE_ID,
                storage: (event) => events.push(event)
            })
        });
        const { runtime } = createInboundTestRuntime({
            stores,
            carrier: 'ws',
            effectWorkerId: 'al-inbound:recovery'
        });

        await runtime.ready();
        await runtime.ready();

        expect(events).toEqual([toRecoveryEvent({ kind: 'storage-created' })]);
    });
});

interface RecoveryStore {
    readonly stores: ReturnType<typeof createDefaultIndexedDbALInboundRuntimeStores>;
    readonly events: readonly ALStorageEvent[];
    report(claimedCount: number): void;
}

async function openRecoveryStore(
    dbName: string,
    clock = { nowMs: START_MS }
): Promise<RecoveryStore> {
    const events: ALStorageEvent[] = [];
    const stores = createDefaultIndexedDbALInboundRuntimeStores({
        dbName,
        namespace: 'recovery',
        nowMs: () => clock.nowMs,
        storageHealth: new ALStorageHealth({
            storeId: STORE_ID,
            storage: (event) => events.push(event)
        })
    });
    await stores.admissionStore.ready();
    return {
        stores,
        events,
        report: (claimedCount) => stores.storageRecovery?.reportFirstBatch(claimedCount)
    };
}

function toRecoveryEvent(outcome: ALStorageRecoveryOutcome): ALStorageEvent {
    return { kind: 'recovery', storeId: STORE_ID, outcome };
}

async function reserveAll(queue: RecoveryStore['stores']['workQueue']) {
    return await queue.reserveEntries({
        typeIds: new Set([WORK_TYPE]),
        statusIds: new Set(NEW_AND_RETRY_STATUSES),
        reservationInput: { maxToReserve: 16, maxAttempts: 5 },
        observedEntries: undefined
    });
}

/** Undefined `expiresAtMs` keeps the row until it is claimed. */
function workEntry(expiresAtMs: number | undefined): ResourceEntry {
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(
        newALUnicastMessage(
            'sender',
            newALEventRoute('test', crypto.randomUUID()),
            'receiver',
            'test',
            { value: 1 }
        ),
        WORK_TYPE
    );
    return expiresAtMs === undefined
        ? entry
        : {
            ...entry,
            audit: { ...entry.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(expiresAtMs) }
        };
}

function toDatabaseInput(dbName: string) {
    return {
        dbName,
        storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    };
}

function newDbName(): string {
    return `storage-recovery-${crypto.randomUUID()}`;
}

async function deleteDatabase(dbName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}
```

- [ ] **Step 2: Run it and see it fail.**

```sh
npx vitest run packages/tests/shared/alm/al-storage-recovery.test.ts
```

Expected (measured on Task 8's assembled commit `3561cc9f3`): `Tests  9 failed (9)` — no store carries a
`storageRecovery`, so nothing is reported.

- [ ] **Step 3: Say what an open found.** `packages/shared/persistence/open-indexed-db.ts`:

```diff
diff --git a/packages/shared/persistence/open-indexed-db.ts b/packages/shared/persistence/open-indexed-db.ts
--- a/packages/shared/persistence/open-indexed-db.ts
+++ b/packages/shared/persistence/open-indexed-db.ts
@@ -31,6 +31,13 @@ export interface OpenedIndexedDb {
     readonly db: IDBDatabase;
     /** Empty when the opened database is the required schema; every reason it is not otherwise. */
     readonly schemaIssues: readonly string[];
+    /** The open ran `upgradeneeded`: an open that names no version does so only when the database did not exist. */
+    readonly created: boolean;
+}
+
+interface OpenedIndexedDbHandle {
+    readonly db: IDBDatabase;
+    readonly created: boolean;
 }
 
 /** Thrown when an existing database's store, key path, auto-increment, or index set is not the required schema. */
@@ -90,9 +97,9 @@ export async function openIndexedDbWithValidatedStores<InitialRecord extends obj
     if (validated.left) {
         throw validated.left;
     }
-    const db = await openIndexedDb(dbName, stores);
+    const { db, created } = await openIndexedDb(dbName, stores);
     db.onversionchange = () => db.close();
-    return { db, schemaIssues: validateIndexedDbDatabaseSchema(db, stores) };
+    return { db, schemaIssues: validateIndexedDbDatabaseSchema(db, stores), created };
 }
 
 /** The same open for a caller whose contract is that a schema mismatch is a defect, not an outcome. */
@@ -182,11 +189,13 @@ function formatKeyPath(keyPath: string | string[] | null): string {
 async function openIndexedDb<InitialRecord extends object>(
     dbName: string,
     stores: readonly IndexedDbStoreSchema<InitialRecord>[]
-): Promise<IDBDatabase> {
-    return await new Promise<IDBDatabase>((resolve, reject) => {
+): Promise<OpenedIndexedDbHandle> {
+    return await new Promise<OpenedIndexedDbHandle>((resolve, reject) => {
         const request = indexedDB.open(dbName);
         let schemaWriteError: Error | undefined;
+        let created = false;
         request.onupgradeneeded = () => {
+            created = true;
             try {
                 for (const store of stores) {
                     createIndexedDbStore(request.result, store);
@@ -197,7 +206,7 @@ async function openIndexedDb<InitialRecord extends object>(
                 request.transaction!.abort();
             }
         };
-        request.onsuccess = () => resolve(request.result);
+        request.onsuccess = () => resolve({ db: request.result, created });
         request.onerror = () => reject(schemaWriteError ?? request.error ?? new Error('IndexedDB open failed'));
     });
 }
```

- [ ] **Step 4: Classify the admission open, and add the reporter beside the health it reports through.**
      `packages/shared/alm/open-indexed-db-admission-database.ts` (the `missing` check is Task 1's, now at the head of
      `openIndexedDbAdmissionStorage`):

```diff
diff --git a/packages/shared/alm/open-indexed-db-admission-database.ts b/packages/shared/alm/open-indexed-db-admission-database.ts
--- a/packages/shared/alm/open-indexed-db-admission-database.ts
+++ b/packages/shared/alm/open-indexed-db-admission-database.ts
@@ -1,3 +1,4 @@
+import { LatestRepository } from '../cache/LatestRepository.ts';
 import { readIndexedDbRequest } from '../persistence/indexed-db-request.ts';
 import {
     openIndexedDbWithValidatedStores,
@@ -29,6 +30,22 @@ export interface ALStorageResetEvent {
     readonly reason: 'schema-id-mismatch' | 'store-schema-mismatch';
 }
 
+/**
+ * What one open found. `created` is a first creation in this document; a creation of a database this
+ * document opened before is another context's reset after a `versionchange` closed it here, and an
+ * eviction without one.
+ */
+export type ALStorageOpening =
+    | Readonly<{ kind: 'existing'; }>
+    | Readonly<{ kind: 'created'; }>
+    | Readonly<{ kind: 'reset'; reason: ALStorageResetEvent['reason'] | 'other-context'; }>
+    | Readonly<{ kind: 'evicted'; }>;
+
+export interface OpenedIndexedDbAdmissionStorage {
+    readonly db: IDBDatabase;
+    readonly opening: ALStorageOpening;
+}
+
 export interface OpenIndexedDbAdmissionDatabaseInput {
     readonly dbName: string;
     readonly storeName: string;
@@ -50,9 +67,14 @@ export class ALStorageResetBlockedError extends ALStorageUnavailableError {
 type OpenOrResetAttempt = 'after-reset' | undefined;
 
 type OpenOrResetResult =
-    | Readonly<{ kind: 'open'; db: IDBDatabase; }>
+    | Readonly<{ kind: 'open'; db: IDBDatabase; created: boolean; }>
     | Readonly<{ kind: 'reset'; event: ALStorageResetEvent; }>;
 
+/** What this document saw of each admission database: that it opened it, and whether a `versionchange` closed it since. */
+type DocumentAdmissionDatabase = 'opened' | 'versionchange';
+
+const DOCUMENT_ADMISSION_DATABASES = new LatestRepository<string, DocumentAdmissionDatabase>();
+
 export function createPassThroughALStorageResetSink(): (event: ALStorageResetEvent) => void {
     return () => {};
 }
@@ -87,31 +109,61 @@ export class ALStorageResetListeners {
 export async function openIndexedDbAdmissionDatabase(
     input: OpenIndexedDbAdmissionDatabaseInput
 ): Promise<IDBDatabase> {
+    return (await openIndexedDbAdmissionStorage(input)).db;
+}
+
+/** The same open, with what it found: the recovery outcome of the store that opened it starts here. */
+export async function openIndexedDbAdmissionStorage(
+    input: OpenIndexedDbAdmissionDatabaseInput
+): Promise<OpenedIndexedDbAdmissionStorage> {
     if (typeof indexedDB === 'undefined') {
         throw new ALStorageUnavailableError({
             cause: 'missing',
             detail: 'IndexedDB is not available in this environment'
         });
     }
+    const seen = DOCUMENT_ADMISSION_DATABASES.read(input.dbName);
     const first = await openOrReset(input, undefined);
     if (first.kind === 'open') {
-        return first.db;
+        return rememberAdmissionDatabase(input.dbName, first.db, toALStorageOpening(first.created, seen));
     }
     input.onStorageReset(first.event);
     const second = await openOrReset(input, 'after-reset');
     if (second.kind === 'open') {
-        return second.db;
+        return rememberAdmissionDatabase(input.dbName, second.db, { kind: 'reset', reason: first.event.reason });
     }
     throw new Error(`ALM storage ${input.dbName} still mismatches after reset`);
 }
 
+function toALStorageOpening(created: boolean, seen: DocumentAdmissionDatabase | undefined): ALStorageOpening {
+    if (!created) {
+        return { kind: 'existing' };
+    }
+    if (seen === undefined) {
+        return { kind: 'created' };
+    }
+    return seen === 'versionchange' ? { kind: 'reset', reason: 'other-context' } : { kind: 'evicted' };
+}
+
+function rememberAdmissionDatabase(
+    dbName: string,
+    db: IDBDatabase,
+    opening: ALStorageOpening
+): OpenedIndexedDbAdmissionStorage {
+    DOCUMENT_ADMISSION_DATABASES.set(dbName, 'opened');
+    db.addEventListener('versionchange', () => {
+        DOCUMENT_ADMISSION_DATABASES.set(dbName, 'versionchange');
+    });
+    return { db, opening };
+}
+
 async function openOrReset(
     input: OpenIndexedDbAdmissionDatabaseInput,
     attempt: OpenOrResetAttempt
 ): Promise<OpenOrResetResult> {
     const opened = await openAdmissionStores(input);
     if (opened.schemaIssues.length === 0) {
-        return await toSchemaIdMismatchReset(input, attempt, opened.db);
+        return await toSchemaIdMismatchReset(input, attempt, opened);
     }
     opened.db.close();
     if (attempt === 'after-reset') {
@@ -158,13 +210,13 @@ async function toStoreSchemaMismatchReset(
 async function toSchemaIdMismatchReset(
     input: OpenIndexedDbAdmissionDatabaseInput,
     attempt: OpenOrResetAttempt,
-    db: IDBDatabase
+    opened: OpenedIndexedDb
 ): Promise<OpenOrResetResult> {
-    const storedSchemaId = await readStoredSchemaId(db, input.storeName);
+    const storedSchemaId = await readStoredSchemaId(opened.db, input.storeName);
     if (storedSchemaId === input.schemaId) {
-        return { kind: 'open', db };
+        return { kind: 'open', db: opened.db, created: opened.created };
     }
-    db.close();
+    opened.db.close();
     if (attempt === 'after-reset') {
         throw new Error(`ALM schema id mismatch persisted in "${input.dbName}" after reset`);
     }
```

Create `packages/shared/alm/storage/al-storage-recovery-reporter.ts`:

```ts
import { Either } from '../../resilience/Either.ts';
import type { ALStorageOpening } from '../open-indexed-db-admission-database.ts';
import type { ALStorageRecoveryOutcome } from './al-storage-event.ts';
import type { ALStorageHealth } from './al-storage-health.ts';
import type { ALStorageUnavailable } from './al-storage-unavailable.ts';

/** A durable store's recovery: what it restored, or why its storage is unavailable. */
type ALStorageRecovery = Either<ALStorageUnavailable, ALStorageRecoveryOutcome>;

/** What the store's first work batch claimed, and the expired rows its reservation deleted on the way. */
interface ALStorageBootstrap {
    readonly claimedCount: number;
    readonly expiredCount: number;
}

/** Reports a durable store's one recovery of this connect; only a pair whose backend opened IndexedDB has one. */
export interface ALStorageRecoveryReporter {
    /** The store's first work batch ended: its claims are what the store restored. Later batches report nothing. */
    reportFirstBatch(claimedCount: number): void;
}

export interface CreateALStorageRecoveryReporterInput {
    /** What the store's latest open found; undefined before its first open. */
    readonly getStorageOpening: () => ALStorageOpening | undefined;
    /** The expired rows the store's reservations deleted since the store was built. */
    readonly getReservationExpiredDeleteCount: () => number;
    /** The store's health: a recovery is stated through it, and an eviction is a failure of it. */
    readonly storageHealth: ALStorageHealth;
}

export function createALStorageRecoveryReporter(
    input: CreateALStorageRecoveryReporterInput
): ALStorageRecoveryReporter {
    let reported = false;
    return {
        reportFirstBatch(claimedCount) {
            const opening = input.getStorageOpening();
            if (reported || opening === undefined) {
                return;
            }
            reported = true;
            const expiredCount = input.getReservationExpiredDeleteCount();
            computeALStorageRecovery(opening, { claimedCount, expiredCount }).fold(
                (failure) => input.storageHealth.recordFailure(failure),
                (outcome) => input.storageHealth.recordRecovery(outcome)
            );
        }
    };
}

/** A reset wins over the creation it caused; only a database that already existed restores anything. */
function computeALStorageRecovery(
    opening: ALStorageOpening,
    bootstrap: ALStorageBootstrap
): ALStorageRecovery {
    switch (opening.kind) {
        case 'reset':
            return Either.ofRight({ kind: 'storage-reset', reason: opening.reason });
        case 'created':
            return Either.ofRight({ kind: 'storage-created' });
        case 'evicted':
            return Either.ofLeft({
                cause: 'evicted',
                detail: 'A database this document opened was created again without a versionchange.'
            });
        case 'existing':
            return Either.ofRight(computeALStorageRestoredOutcome(bootstrap));
    }
}

function computeALStorageRestoredOutcome(bootstrap: ALStorageBootstrap): ALStorageRecoveryOutcome {
    return bootstrap.claimedCount === 0 && bootstrap.expiredCount > 0
        ? { kind: 'expired-at-recovery', expired: bootstrap.expiredCount }
        : { kind: 'restored', claimed: bootstrap.claimedCount, expired: bootstrap.expiredCount };
}
```

`ALStorageHealth` states the recovery of its store (`packages/shared/alm/storage/al-storage-health.ts`), and the
recovery outcome's `storage-reset` names another context's reset (`packages/shared/alm/storage/al-storage-event.ts`):

```diff
diff --git a/packages/shared/alm/storage/al-storage-health.ts b/packages/shared/alm/storage/al-storage-health.ts
--- a/packages/shared/alm/storage/al-storage-health.ts
+++ b/packages/shared/alm/storage/al-storage-health.ts
@@ -1,5 +1,5 @@
 import { ObservableLatestValue } from '../../cache/ObservableLatestValue.ts';
-import type { ALStorageEventSink, ALStorageHealthState } from './al-storage-event.ts';
+import type { ALStorageEventSink, ALStorageHealthState, ALStorageRecoveryOutcome } from './al-storage-event.ts';
 import type { ALStorageUnavailable } from './al-storage-unavailable.ts';
 
 export namespace ALStorageHealth {
@@ -17,9 +17,11 @@ export class ALStorageHealth {
     private readonly state = new ObservableLatestValue<ALStorageHealthState>({
         equals: (left, right) => left.status === right.status
     });
+    private readonly input: ALStorageHealth.Input;
     private lastRecoveryPointAtMs: number | undefined = undefined;
 
     constructor(input: ALStorageHealth.Input) {
+        this.input = input;
         this.state.accept({ status: 'healthy', lastFailure: undefined, lastRecoveryPointAtMs: undefined });
         this.state.onUpdatedDo(({ value }) => {
             if (value !== undefined) {
@@ -43,4 +45,9 @@ export class ALStorageHealth {
             this.state.accept({ status: 'healthy', lastFailure: state.lastFailure, lastRecoveryPointAtMs: atMs });
         }
     }
+
+    /** States what the store found when its lane started; the store's one recovery of this connect. */
+    recordRecovery(outcome: ALStorageRecoveryOutcome): void {
+        this.input.storage({ kind: 'recovery', storeId: this.input.storeId, outcome });
+    }
 }
diff --git a/packages/shared/alm/storage/al-storage-event.ts b/packages/shared/alm/storage/al-storage-event.ts
--- a/packages/shared/alm/storage/al-storage-event.ts
+++ b/packages/shared/alm/storage/al-storage-event.ts
@@ -16,7 +16,7 @@ export type ALStorageRecoveryOutcome =
     | Readonly<{ kind: 'restored'; claimed: number; expired: number; }>
     | Readonly<{ kind: 'expired-at-recovery'; expired: number; }>
     | Readonly<{ kind: 'storage-created'; }>
-    | Readonly<{ kind: 'storage-reset'; reason: ALStorageResetEvent['reason']; }>;
+    | Readonly<{ kind: 'storage-reset'; reason: ALStorageResetEvent['reason'] | 'other-context'; }>;
 
 export type ALStoragePersistOutcome = 'granted' | 'denied' | 'unsupported';
```

- [ ] **Step 5: Record the opening and count the reservation's expired deletes.**

`packages/shared/alm/indexed-db-admission-backend.ts`:

```diff
diff --git a/packages/shared/alm/indexed-db-admission-backend.ts b/packages/shared/alm/indexed-db-admission-backend.ts
--- a/packages/shared/alm/indexed-db-admission-backend.ts
+++ b/packages/shared/alm/indexed-db-admission-backend.ts
@@ -42,7 +42,8 @@ import {
 } from './indexed-db-admission-row.ts';
 import {
     AL_ADMISSION_WORK_STORE_NAME,
-    openIndexedDbAdmissionDatabase,
+    openIndexedDbAdmissionStorage,
+    type ALStorageOpening,
     type ALStorageResetEvent
 } from './open-indexed-db-admission-database.ts';
 import { readIndexedDbAdmissionSnapshot } from './read-indexed-db-admission-snapshot.ts';
@@ -70,20 +71,23 @@ export class IndexedDbAdmissionBackend implements ALAdmissionWorkBackend {
     readonly #nowMs: () => number;
     readonly #newWriteToken: () => string;
     readonly #observer: IndexedDbOperationObserver;
+    #opening: ALStorageOpening | undefined;
 
     constructor(input: IndexedDbAdmissionBackend.Input) {
         this.#storeName = input.storeName;
         this.#nowMs = input.nowMs;
         this.#newWriteToken = input.newWriteToken;
         this.#observer = input.observer;
-        this.#connection = new IndexedDbConnection(() =>
-            openIndexedDbAdmissionDatabase({
+        this.#connection = new IndexedDbConnection(async () => {
+            const opened = await openIndexedDbAdmissionStorage({
                 dbName: input.dbName,
                 storeName: input.storeName,
                 schemaId: input.schemaId,
                 onStorageReset: input.onStorageReset
-            })
-        );
+            });
+            this.#opening = opened.opening;
+            return opened.db;
+        });
         this.workQueue = new IndexedDbQueueBox({
             now: () => Temporal.Instant.fromEpochMilliseconds(this.#nowMs()),
             connection: this.#connection,
@@ -97,6 +101,11 @@ export class IndexedDbAdmissionBackend implements ALAdmissionWorkBackend {
         await this.#connection.open();
     }
 
+    /** What the latest open of this backend's database found; undefined before the first. */
+    getStorageOpening(): ALStorageOpening | undefined {
+        return this.#opening;
+    }
+
     async readWithin<T>(read: (session: ALAdmissionReadSession) => Promise<T>): Promise<T> {
         const db = await this.#connection.open();
         const session = this.#createReadSession(db);
```

`packages/shared/queuebox/indexed-db-queue-box.ts`:

```diff
diff --git a/packages/shared/queuebox/indexed-db-queue-box.ts b/packages/shared/queuebox/indexed-db-queue-box.ts
--- a/packages/shared/queuebox/indexed-db-queue-box.ts
+++ b/packages/shared/queuebox/indexed-db-queue-box.ts
@@ -137,6 +137,7 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
     readonly #storeName: string;
     readonly #completedRetention: QueueBoxCompletedRetention;
     readonly #observer: IndexedDbOperationObserver;
+    #reservationExpiredDeleteCount = 0;
 
     readonly #cleanupRateLimiter: RateLimiter = RateLimiter.init(
         ResourceInboxResilience.RATE_LIMITER_RESERVED_TIMEOUT_SLIDING_WINDOW_DURATION_MS,
@@ -438,17 +439,22 @@ export class IndexedDbQueueBox implements QueueBoxResourceEntryRepository {
             isReservable: (stored) => isStoredQueueEntryReservable({ stored, typeIds, statusIds, now, maxAttempts })
         });
         // An unreservable row that is also expired is swept by the write this claim already owes.
-        const mutations = [
-            ...selection.mutations,
-            ...selection.ineligible
-                .filter((stored) => isStoredQueueEntryExpired(stored, now))
-                .map(computeIndexedDbQueueDelete)
-        ];
+        const expiredDeletes = selection.ineligible
+            .filter((stored) => isStoredQueueEntryExpired(stored, now))
+            .map(computeIndexedDbQueueDelete);
+        const mutations = [...selection.mutations, ...expiredDeletes];
         const decision = this.#observeReservation(mutations);
         if (decision instanceof Promise) {
             await decision;
         }
-        return await this.#write(db, { mutations, result: selection.reserved });
+        const reserved = await this.#write(db, { mutations, result: selection.reserved });
+        this.#reservationExpiredDeleteCount += expiredDeletes.length;
+        return reserved;
+    }
+
+    /** The expired rows `reserveEntries` deleted since this queue was constructed: a store's recovery counts them. */
+    getReservationExpiredDeleteCount(): number {
+        return this.#reservationExpiredDeleteCount;
     }
 
     async reserveOverdueRetryEntries(
```

- [ ] **Step 6: Build the reporter in the IndexedDB factories from the pair's health, and carry it to the lanes.**

`packages/shared/alm/al-runtime-stores.ts`:

```diff
diff --git a/packages/shared/alm/al-runtime-stores.ts b/packages/shared/alm/al-runtime-stores.ts
--- a/packages/shared/alm/al-runtime-stores.ts
+++ b/packages/shared/alm/al-runtime-stores.ts
@@ -40,6 +40,10 @@ import type {
     ALVolatileOutboundRuntimeStores
 } from './outbound/al-outbound-message-runtime.ts';
 import type { ALStorageHealth } from './storage/al-storage-health.ts';
+import {
+    createALStorageRecoveryReporter,
+    type ALStorageRecoveryReporter
+} from './storage/al-storage-recovery-reporter.ts';
 import type { ALVolatileSessionBudget } from './volatile-budget/al-volatile-session-budget.ts';
 
 /**
@@ -137,18 +141,68 @@ export function createInMemoryALOutboundRuntimeStores<TPrepared>(
 export function createIndexedDbALInboundRuntimeStores(
     input: CreateIndexedDbALRuntimeStoresInput
 ): ALInboundRuntimeStores {
-    const backend = input.inboundBackend ??
-        new IndexedDbAdmissionBackend({
-            dbName: input.dbName ?? DEFAULT_INDEXED_DB_NAME,
-            storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
-            nowMs: input.nowMs,
-            newWriteToken: crypto.randomUUID.bind(crypto),
-            observer: input.observer,
-            schemaId: input.schemaId,
-            onStorageReset: input.onStorageReset
+    if (input.inboundBackend !== undefined) {
+        return toIndexedDbALInboundRuntimeStores(input, input.inboundBackend, undefined);
+    }
+    const backend = createIndexedDbAdmissionBackend(input, input.onStorageReset);
+    const storageRecovery = toALStorageRecoveryReporter(backend, input.storageHealth);
+    return toIndexedDbALInboundRuntimeStores(input, backend, storageRecovery);
+}
+
+export function createIndexedDbALOutboundRuntimeStores<TPrepared>(
+    input: CreateIndexedDbALOutboundRuntimeStoresInput<TPrepared>
+): ALOutboundRuntimeStores<TPrepared> {
+    // Only a backend this factory opens reports its resets and its recovery here; a supplied one reports to its opener.
+    if (input.outboundBackend !== undefined) {
+        return toIndexedDbALOutboundRuntimeStores(input, input.outboundBackend, {
+            storageResets: undefined,
+            storageRecovery: undefined
         });
+    }
+    const storageResets = new ALStorageResetListeners();
+    const backend = createIndexedDbAdmissionBackend(input, (event) => {
+        storageResets.notify(event);
+        input.onStorageReset(event);
+    });
+    const storageRecovery = toALStorageRecoveryReporter(backend, input.storageHealth);
+    return toIndexedDbALOutboundRuntimeStores(input, backend, { storageResets, storageRecovery });
+}
+
+/** Only a store whose health someone reads reports its recovery; the health states it. */
+function toALStorageRecoveryReporter(
+    backend: IndexedDbAdmissionBackend,
+    storageHealth: ALStorageHealth | undefined
+): ALStorageRecoveryReporter | undefined {
+    return storageHealth === undefined ? undefined : createALStorageRecoveryReporter({
+        getStorageOpening: () => backend.getStorageOpening(),
+        getReservationExpiredDeleteCount: () => backend.workQueue.getReservationExpiredDeleteCount(),
+        storageHealth
+    });
+}
+
+function createIndexedDbAdmissionBackend(
+    input: CreateIndexedDbALRuntimeStoresInput,
+    onStorageReset: (event: ALStorageResetEvent) => void
+): IndexedDbAdmissionBackend {
+    return new IndexedDbAdmissionBackend({
+        dbName: input.dbName ?? DEFAULT_INDEXED_DB_NAME,
+        storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
+        nowMs: input.nowMs,
+        newWriteToken: crypto.randomUUID.bind(crypto),
+        observer: input.observer,
+        schemaId: input.schemaId,
+        onStorageReset
+    });
+}
+
+function toIndexedDbALInboundRuntimeStores(
+    input: CreateIndexedDbALRuntimeStoresInput,
+    backend: ALAdmissionWorkBackend,
+    storageRecovery: ALStorageRecoveryReporter | undefined
+): ALInboundRuntimeStores {
     return {
         storageHealth: input.storageHealth,
+        storageRecovery,
         admissionStore: createALInboundAdmissionStore({
             nowMs: input.nowMs,
             namespace: `${input.namespace}:inbound:admission`,
@@ -161,26 +215,19 @@ export function createIndexedDbALInboundRuntimeStores(
     };
 }
 
-export function createIndexedDbALOutboundRuntimeStores<TPrepared>(
-    input: CreateIndexedDbALOutboundRuntimeStoresInput<TPrepared>
+/** The relays a factory-opened pair carries; both absent for a backend its caller opened. */
+interface IndexedDbALOutboundRelays {
+    readonly storageResets: ALStorageResetListeners | undefined;
+    readonly storageRecovery: ALStorageRecoveryReporter | undefined;
+}
+
+function toIndexedDbALOutboundRuntimeStores<TPrepared>(
+    input: CreateIndexedDbALOutboundRuntimeStoresInput<TPrepared>,
+    backend: ALAdmissionWorkBackend,
+    relays: IndexedDbALOutboundRelays
 ): ALOutboundRuntimeStores<TPrepared> {
-    // Only a backend this factory opens reports its resets here; a supplied one reports to its opener.
-    const storageResets = input.outboundBackend === undefined ? new ALStorageResetListeners() : undefined;
-    const backend = input.outboundBackend ??
-        new IndexedDbAdmissionBackend({
-            dbName: input.dbName ?? DEFAULT_INDEXED_DB_NAME,
-            storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
-            nowMs: input.nowMs,
-            newWriteToken: crypto.randomUUID.bind(crypto),
-            observer: input.observer,
-            schemaId: input.schemaId,
-            onStorageReset: (event) => {
-                storageResets?.notify(event);
-                input.onStorageReset(event);
-            }
-        });
     return {
-        storageResets,
+        ...relays,
         storageHealth: input.storageHealth,
         admissionStore: createALOutboundAdmissionStore({
             nowMs: input.nowMs,
```

`packages/shared/alm/inbound/al-inbound-message-runtime.ts`:

```diff
diff --git a/packages/shared/alm/inbound/al-inbound-message-runtime.ts b/packages/shared/alm/inbound/al-inbound-message-runtime.ts
--- a/packages/shared/alm/inbound/al-inbound-message-runtime.ts
+++ b/packages/shared/alm/inbound/al-inbound-message-runtime.ts
@@ -11,6 +11,7 @@ import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
 import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';
 import type { ALStorageHealth } from '../storage/al-storage-health.ts';
 import type { ALStorageReadiness } from '../storage/al-storage-readiness.ts';
+import type { ALStorageRecoveryReporter } from '../storage/al-storage-recovery-reporter.ts';
 import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
 import type { ALInboundAdmissionStore, ALInboundPlanner } from './al-inbound-admission-store.ts';
 import {
@@ -37,6 +38,8 @@ export interface ALInboundRuntimeStores {
     readonly workQueue: QueueBoxResourceEntryRepository;
     /** Records the storage failures and the commits of the lanes over this pair; absent where no storage failure reaches. */
     readonly storageHealth?: ALStorageHealth;
+    /** Reports the pair's recovery after its first work batch; absent for a pair that recovers nothing (memory, PostgreSQL). */
+    readonly storageRecovery?: ALStorageRecoveryReporter;
 }
 
 /** The session's inbound memory pair: nothing in it survives the document, and each lane over it sweeps it. */
@@ -81,6 +84,8 @@ export namespace ALInboundMessageRuntime {
         readonly workQueue: QueueBoxResourceEntryRepository;
         /** The health of the durable pair; `undefined` for a pair no storage failure reaches (memory, PostgreSQL). */
         readonly storageHealth: ALStorageHealth | undefined;
+        /** The durable pair's recovery; `undefined` for a pair that recovers nothing (memory, PostgreSQL). */
+        readonly storageRecovery: ALStorageRecoveryReporter | undefined;
         /** The memory pair a volatile message goes to; `undefined` keeps one backend for every message. */
         readonly volatileStores: ALVolatileInboundRuntimeStores | undefined;
         readonly effectPreparation: ALInboundEffectPreparationDependencies;
```

`packages/shared/alm/outbound/al-outbound-message-runtime.ts`:

```diff
diff --git a/packages/shared/alm/outbound/al-outbound-message-runtime.ts b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
--- a/packages/shared/alm/outbound/al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
@@ -21,6 +21,7 @@ import type {
 import type { ALStorageResetListeners } from '../open-indexed-db-admission-database.ts';
 import type { ALStorageHealth } from '../storage/al-storage-health.ts';
 import type { ALStorageReadiness } from '../storage/al-storage-readiness.ts';
+import type { ALStorageRecoveryReporter } from '../storage/al-storage-recovery-reporter.ts';
 import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
 import type { ALWorkReadinessProbeCause } from '../work/al-work-readiness-memory.ts';
 import type {
@@ -181,6 +182,8 @@ export interface ALOutboundRuntimeStores<TPrepared> {
     readonly storageResets?: ALStorageResetListeners;
     /** Records the storage failures and the commits of the lanes over this pair; absent where no storage failure reaches. */
     readonly storageHealth?: ALStorageHealth;
+    /** Reports the pair's recovery after its first work batch; absent for a pair that recovers nothing (memory, PostgreSQL). */
+    readonly storageRecovery?: ALStorageRecoveryReporter;
 }
 
 /** The memory pair of a carrier runtime: nothing in it survives the document, and its lane sweeps it. */
@@ -340,6 +343,8 @@ export namespace ALOutboundMessageRuntime {
         readonly storageResets: ALStorageResetListeners | undefined;
         /** The health of the durable pair; `undefined` for a pair no storage failure reaches (memory, PostgreSQL). */
         readonly storageHealth: ALStorageHealth | undefined;
+        /** The durable pair's recovery; `undefined` for a pair that recovers nothing (memory, PostgreSQL). */
+        readonly storageRecovery: ALStorageRecoveryReporter | undefined;
         /** The memory pair a volatile admission goes to; `undefined` keeps one backend for every admission. */
         readonly volatileStores: ALVolatileOutboundRuntimeStores<TPrepared> | undefined;
         readonly effectWorkerId: string;
```

`packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts`:

```diff
diff --git a/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts b/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts
--- a/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts
+++ b/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts
@@ -48,6 +48,7 @@ export function createDefaultALInboundRuntimeResources(
         admissionStore: stores.admissionStore,
         workQueue: stores.workQueue,
         storageHealth: stores.storageHealth,
+        storageRecovery: stores.storageRecovery,
         volatileStores: input.volatileStores,
         effectWorkerId: `al-inbound:${crypto.randomUUID()}`,
         effectPreparation: {
```

`packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts`:

```diff
diff --git a/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts b/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
--- a/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
@@ -114,6 +114,7 @@ export function createDefaultALOutboundRuntimeResources<TPrepared>(
         workQueue: stores.workQueue,
         storageResets: stores.storageResets,
         storageHealth: stores.storageHealth,
+        storageRecovery: stores.storageRecovery,
         volatileStores: input.volatileStores,
         effectWorkerId: `al-outbound:${crypto.randomUUID()}`,
         clock: { nowMs },
```

`packages/shared/alm/inbound/lane/al-inbound-store-lane.ts`:

```diff
diff --git a/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts b/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
--- a/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
+++ b/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
@@ -245,6 +245,7 @@ export class ALInboundStoreLane {
      */
     private recordWorkDiagnostics(event: ALWorkDiagnostics): void {
         if (event.kind === 'work-batch') {
+            this.input.stores.storageRecovery?.reportFirstBatch(event.claimedCount);
             this.recordWorkBatch(event);
         }
     }
```

`packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`:

```diff
diff --git a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
--- a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
+++ b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
@@ -459,6 +459,9 @@ export class ALOutboundStoreLane<TPrepared> {
      */
     private recordWorkDiagnostics(event: ALWorkDiagnostics): void {
         const { diagnostics } = this.input.runtime;
+        if (event.kind === 'work-batch') {
+            this.input.stores.storageRecovery?.reportFirstBatch(event.claimedCount);
+        }
         if (event.kind === 'readiness-probe') {
             diagnostics?.({
                 kind: 'readiness-probe',
```

`packages/tests/shared/al-outbound-message-runtime.test.ts`:

```diff
diff --git a/packages/tests/shared/al-outbound-message-runtime.test.ts b/packages/tests/shared/al-outbound-message-runtime.test.ts
--- a/packages/tests/shared/al-outbound-message-runtime.test.ts
+++ b/packages/tests/shared/al-outbound-message-runtime.test.ts
@@ -60,6 +60,7 @@ describe('ALOutboundMessageRuntime', () => {
             workQueue: stores.workQueue,
             storageResets: undefined,
             storageHealth: undefined,
+            storageRecovery: undefined,
             volatileStores: undefined,
             dequeue: { types: new Set<string>(), resilience: createDefaultALOutboundDequeueResilience() },
             effectWorkerId: 'injected-outbound-worker',
```

`packages/tests/shared/alm/al-inbound-admission-preparation.test.ts`:

```diff
diff --git a/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts b/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts
--- a/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts
+++ b/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts
@@ -573,6 +573,7 @@ function createRuntimeDependencies(stores: ALInboundRuntimeStores): ALInboundMes
         admissionStore: stores.admissionStore,
         workQueue: stores.workQueue,
         storageHealth: undefined,
+        storageRecovery: undefined,
         volatileStores: undefined,
         carrier: 'ws',
         planIncomingMessage,
```

- [ ] **Step 7: Run it green; the pins hold.**

```sh
npx vitest run packages/tests/shared/alm/al-storage-recovery.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/indexed-db-storage-faults.test.ts
```

Expected (measured on `285d9d1b0`): recovery `9 passed`, ledger `4 passed`, operation counts `20 passed`, storage faults `5 passed` — no
pin moves.

- [ ] **Step 8: Write the browser test.** Create `packages/tests/shared-web/al-runtime/browser-al-storage-recovery.test.ts`:

```ts
// @vitest-environment happy-dom
import '../../setup-browser-indexeddb.ts';

import { expect, it } from 'vitest';

import {
    BROWSER_AL_RUNTIME_STORE_NAME,
    toBrowserALRuntimeDbName,
    toBrowserSessionALInboundRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import {
    configureBrowserALRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import type { StateScope } from '@shared/api/state-types.ts';

// The two phases share one scope's browser database, so they run in order in one test.
it('names each browser store on the storage port: an eviction as failing health, then a restore', async () => {
    const scope: StateScope = { applicationId: 'recovery-app', workspaceId: crypto.randomUUID() };
    const dbName = toBrowserALRuntimeDbName(scope);
    const events: ALStorageEvent[] = [];
    const diagnosticsPorts = toRallarDiagnosticsPorts({ storage: (event) => events.push(event) });
    (await openIndexedDbAdmissionDatabase({
        dbName,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    })).close();
    await deleteDatabase(dbName);

    const evictedSession = `evicted-${crypto.randomUUID()}`;
    configureBrowserALRuntimeStores(evictedSession, { scope, diagnosticsPorts });
    const evicted = resolveBrowserWsClientALOutboundRuntimeStores(evictedSession);
    await evicted.admissionStore.ready();
    evicted.storageRecovery?.reportFirstBatch(0);

    const restoredSession = `restored-${crypto.randomUUID()}`;
    configureBrowserALRuntimeStores(restoredSession, { scope, diagnosticsPorts });
    const restored = resolveBrowserSessionALInboundRuntimeStores(restoredSession);
    await restored.admissionStore.ready();
    restored.storageRecovery?.reportFirstBatch(0);

    expect(events).toEqual([
        {
            kind: 'health',
            storeId: toBrowserWsClientALRuntimeStoreId(evictedSession),
            status: 'failing',
            lastFailure: { cause: 'evicted', detail: expect.any(String) },
            lastRecoveryPointAtMs: undefined
        },
        {
            kind: 'recovery',
            storeId: toBrowserSessionALInboundRuntimeStoreId(restoredSession),
            outcome: { kind: 'restored', claimed: 0, expired: 0 }
        }
    ]);
});

async function deleteDatabase(dbName: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}
```

Run `npx vitest run packages/tests/shared-web/al-runtime/browser-al-storage-recovery.test.ts`. Expected: `Tests  1 passed (1)`
after Steps 3–7 (measured on `285d9d1b0`); on Task 8's commit it fails with `events` empty (measured on `3561cc9f3`).
No browser composition change is needed: Task 2's `toBrowserStoreOptions` already gives each browser store its own
`ALStorageHealth` named by its store id, and Step 6's factories build the reporter from it. The eviction's `health`
event arrives on the health's listener queue, after the awaits of the second phase, so the order shown is the
emitted order.

- [ ] **Step 9: The control side's delivery observation carries `durabilityDowngrade` (R-I2a-i-51).** The page's
      ledger projects it in Step 11; the control side's result value and its decoder carry it here, so the
      scenario's downgrade assertion reads a decoded field. Write the failing cases in
      `packages/tests/shared-test/alm-delivery-failure-decoding.test.ts`:

```diff
diff --git a/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts b/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
--- a/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
+++ b/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
@@ -87,3 +87,24 @@ describe('the typed failure a delivery observation carries (D75, C2)', () => {
             .toThrowError(`The page runtime returned no usable delivery observation.${field}.`);
     });
 });
+
+describe('the durability downgrade a delivery observation carries', () => {
+    it('reads the requested durability and the storage cause of a downgraded send', () => {
+        const durabilityDowngrade = { requested: 'local-outbox', cause: 'quota' };
+
+        expect(decodeAlmDeliveryResultValue({ ...OBSERVATION, durabilityDowngrade }).durabilityDowngrade)
+            .toEqual(durabilityDowngrade);
+    });
+
+    it('reads an observation without a downgrade as none', () => {
+        expect(decodeAlmDeliveryResultValue(OBSERVATION).durabilityDowngrade).toBeUndefined();
+    });
+
+    it.each([
+        { durabilityDowngrade: { requested: 'disk', cause: 'quota' }, field: 'durabilityDowngrade.requested' },
+        { durabilityDowngrade: { requested: 'local-outbox', cause: 'full' }, field: 'durabilityDowngrade.cause' }
+    ])('refuses a downgrade whose $field is unusable', ({ durabilityDowngrade, field }) => {
+        expect(() => decodeAlmDeliveryResultValue({ ...OBSERVATION, durabilityDowngrade }))
+            .toThrowError(`The page runtime returned no usable delivery observation.${field}.`);
+    });
+});
```

Run `npx vitest run packages/tests/shared-test/alm-delivery-failure-decoding.test.ts`. Expected (measured on
`3561cc9f3`): `Tests  3 failed | 24 passed (27)` — the decoder drops the field and accepts any value.

The decoder reuses the failure decoder's cause map and key reader
(`packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`), the runtime-result decoder reads the field
(`decode-alm-runtime-result.ts`), and the result value picks it from `ALDeliveryEvidence`
(`rallar-black-box-alm-result-values.ts`):

```diff
diff --git a/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts b/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
--- a/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
+++ b/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
@@ -1,6 +1,8 @@
 import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
+import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
 import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
 import type {
+    ALDeliveryDurabilityDowngrade,
     ALDeliveryRefusalReason,
     ALDeliveryRelayRejection,
     ALDeliverySkippedReason,
@@ -53,6 +55,12 @@ const ALM_STORAGE_UNAVAILABLE_CAUSES: Readonly<Record<ALStorageUnavailableCause,
     'transaction-failed': true
 };
 
+const ALM_DURABILITY_ALGOS: Readonly<Record<ALDurabilityAlgo, true>> = {
+    volatile: true,
+    'local-outbox': true,
+    'local-inbox': true
+};
+
 const ALM_NACK_REASONS: Readonly<Record<ALNackReason, true>> = {
     duplicate: true,
     gap: true,
@@ -155,6 +163,20 @@ function decodeAlmReceiptExhaustedFailure(
         }));
 }
 
+/** The durability a send asked for and the storage cause that sent it without storage. */
+export function decodeAlmDurabilityDowngrade(value: unknown): Either<string, ALDeliveryDurabilityDowngrade> {
+    const downgrade = decodeAlmRuntimeRecord(value);
+    const requested = decodeAlmFailureKey(ALM_DURABILITY_ALGOS, downgrade.requested, 'requested').right;
+    const cause = decodeAlmFailureKey(ALM_STORAGE_UNAVAILABLE_CAUSES, downgrade.cause, 'cause').right;
+    if (requested === undefined) {
+        return Either.ofLeft('durabilityDowngrade.requested');
+    }
+    if (cause === undefined) {
+        return Either.ofLeft('durabilityDowngrade.cause');
+    }
+    return Either.ofRight({ requested, cause });
+}
+
 function decodeAlmFailureKey<TKey extends string>(
     keys: Readonly<Record<TKey, true>>,
     value: unknown,
diff --git a/packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts b/packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts
--- a/packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts
+++ b/packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts
@@ -6,6 +6,7 @@ import {
     type ALDeliveryAttemptOutcome,
     type ALDeliveryCarrier,
     type ALDeliveryCarrierFallback,
+    type ALDeliveryDurabilityDowngrade,
     type ALDeliveryFallbackReason,
     type ALDeliveryRelayRejection,
     type ALDeliveryState
@@ -16,7 +17,11 @@ import type {
     RallarBlackBoxTestRecord
 } from '../rallar-black-box-test-contracts.ts';
 import { RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES } from '../schema/rallar-black-box-command-fields.ts';
-import { decodeAlmDeliveryFailure, decodeAlmRelayRejection } from './decode-alm-delivery-failure.ts';
+import {
+    decodeAlmDeliveryFailure,
+    decodeAlmDurabilityDowngrade,
+    decodeAlmRelayRejection
+} from './decode-alm-delivery-failure.ts';
 import { decodeAlmRuntimeRecord } from './decode-alm-runtime-record.ts';
 import type {
     RallarBlackBoxTestMessagesControlResultValue,
@@ -150,6 +155,7 @@ export function decodeAlmDeliveryResultValue(
         relayRejection: readAlmRelayRejectionField(record, path),
         failure: readAlmFailureField(record, path),
         carrierFallback: readAlmCarrierFallbackField(record, path),
+        durabilityDowngrade: readAlmDurabilityDowngradeField(record, path),
         confirmedHopPeerIds: requireAlmStringListField(record, path, 'confirmedHopPeerIds'),
         unconfirmedHopPeerIds: requireAlmStringListField(record, path, 'unconfirmedHopPeerIds'),
         expectedRecipientPeerIds: requireAlmStringListField(
@@ -289,6 +295,21 @@ function readAlmFailureField(
     return decoded.right;
 }
 
+/** Absent unless storage could not hold a durable send and its channel sent it volatile. */
+function readAlmDurabilityDowngradeField(
+    record: RallarBlackBoxTestRecord,
+    path: string
+): ALDeliveryDurabilityDowngrade | undefined {
+    if (record.durabilityDowngrade === undefined) {
+        return undefined;
+    }
+    const decoded = decodeAlmDurabilityDowngrade(record.durabilityDowngrade);
+    if (decoded.left !== undefined) {
+        throw toAlmInvalidRuntimeResultError(`${path}.${decoded.left}`);
+    }
+    return decoded.right;
+}
+
 /** Absent unless the strategy handed the admitted message to its second carrier (D56). */
 function readAlmCarrierFallbackField(
     record: RallarBlackBoxTestRecord,
diff --git a/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts b/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts
--- a/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts
+++ b/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts
@@ -38,7 +38,9 @@ export interface RallarBlackBoxTestMessagesControlResultValue {
 }
 
 export interface RallarBlackBoxTestMessagesObserveResultValue
-    extends ALDeliveryReceiptEvidence, Pick<ALDeliveryEvidence, 'relayRejection' | 'failure' | 'carrierFallback'> {
+    extends
+        ALDeliveryReceiptEvidence,
+        Pick<ALDeliveryEvidence, 'relayRejection' | 'failure' | 'carrierFallback' | 'durabilityDowngrade'> {
     readonly handleId: string;
     readonly state: ALDeliveryState;
     readonly submitted: boolean;
```

The field is required (`ALDeliveryDurabilityDowngrade | undefined`), so the two typed literals of the result value
gain it: the lifecycle recipes' fixture and the Deno control server's fabricated receipts value
(`deno task check` of `apps/rallar-black-box-control-server` fails on it otherwise; `check-tests-typecheck` on the
other):

```diff
diff --git a/packages/tests/shared-test/alm-lifecycle-recipes.test.ts b/packages/tests/shared-test/alm-lifecycle-recipes.test.ts
--- a/packages/tests/shared-test/alm-lifecycle-recipes.test.ts
+++ b/packages/tests/shared-test/alm-lifecycle-recipes.test.ts
@@ -115,6 +115,7 @@ describe('ALM lifecycle recipe evidence', () => {
             attemptCarriers: [],
             relayRejection: undefined,
             carrierFallback: undefined,
+            durabilityDowngrade: undefined,
             failure: undefined,
             reason: undefined
         };
diff --git a/apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts b/apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts
--- a/apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts
+++ b/apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts
@@ -407,6 +407,7 @@ function toReceiptsFabricatedValue(
         attemptCarriers: [send?.carrier === 'ws' ? 'ws' : 'rtc'],
         relayRejection: undefined,
         carrierFallback: undefined,
+        durabilityDowngrade: undefined,
         failure: undefined,
         reason: undefined
     };
```

Rerun the decoder test: `Tests  27 passed (27)`.

- [ ] **Step 10: Write the failing scenario test.** Create `packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { RELOAD_RECOVERED_STORE_PREFIXES } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserSessionALInboundRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';

function findScenario(
    carrier: (typeof ALM_CONFORMANCE_CARRIERS)[number],
    scenarioId: string
): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${carrier}.`);
    }
    return scenario;
}

/** The scenario's own commands, past the connect prologue and before the trailing stats. */
function toScenarioCommands(
    commands: readonly RallarBlackBoxTestCommand[]
): readonly RallarBlackBoxTestCommand[] {
    return commands.filter((command) =>
        !['http.request', 'rtc.connect', 'storage.counters', 'stats'].includes(command.kind)
    );
}

function toShape(command: RallarBlackBoxTestCommand): string {
    switch (command.kind) {
        case 'fault.inject':
            return `fault.inject:${command.carrier}:${String(command.remaining)}`;
        case 'messages.send':
            return 'replayOnCarrier' in command
                ? 'replay'
                : `send:${command.durability ?? 'volatile'}:${
                    command.onStorageUnavailable ?? 'default'
                }`;
        case 'messages.observe':
            return `observe:${command.state.length === 1 ? command.state[0] : 'admitted'}`;
        case 'wait':
            return `wait:${command.match.kind}${command.absent === true ? ':absent' : ''}`;
        default:
            return command.kind;
    }
}

describe('storage-unavailable conformance scenario', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)(
        'runs on two agents over %s in the full tag only',
        (carrier) => {
            const scenario = findScenario(carrier, 'storage-unavailable');

            expect(scenario.laneFamily).toBe('two-agent');
            expect(scenario.roles).toEqual(['sender', 'receiver']);
            expect(scenario.tags).toEqual(['full']);
        }
    );

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'refuses, downgrades, then recovers a durable send under a held %s admission quota',
        (carrier) => {
            const { sender } = findScenario(carrier, 'storage-unavailable');

            expect(toScenarioCommands(sender.commands).map(toShape)).toEqual([
                'fault.inject:storage:until-cleared',
                'send:local-outbox:default',
                'observe:failed',
                'assert',
                'assert',
                'assert',
                'wait:diagnostic',
                'send:local-outbox:volatile',
                'observe:admitted',
                'assert',
                'assert',
                'assert',
                'assert',
                'fault.inject:storage:0',
                'send:local-outbox:default',
                'observe:admitted',
                'assert',
                'assert',
                'wait:diagnostic'
            ]);
        }
    );

    it('holds and releases one fault id that fails admission writes with a quota error', () => {
        const faults = findScenario('rtc', 'storage-unavailable').sender.commands
            .filter((command) => command.kind === 'fault.inject');

        expect(faults).toHaveLength(2);
        expect(new Set(faults.map((fault) => fault.faultId)).size).toBe(1);
        expect(faults[0]).toMatchObject({
            carrier: 'storage',
            match: { owner: 'al-admission', kind: 'write' },
            action: 'quota',
            remaining: 'until-cleared'
        });
        expect(faults[1]).toMatchObject({ remaining: 0 });
    });

    it('asserts the typed refusal, the named downgrade and the recovered commit on the sender\'s handles', () => {
        const asserts = findScenario('ws', 'storage-unavailable').sender.commands
            .filter((command) => command.kind === 'assert')
            .map((
                command
            ) => [
                command.source.replace(/^resultCache\.alm-ws-storage-unavailable-sender-/, ''),
                command.expected
            ]);

        expect(asserts).toEqual([
            ['observe-failed-1.value.failure.kind', 'storage-unavailable'],
            ['observe-failed-1.value.failure.cause', 'quota'],
            ['observe-failed-1.value.submitted', false],
            [
                'observe-admitted-2.value.state',
                '^(accepted|queued|transport-accepted|acknowledged)$'
            ],
            ['observe-admitted-2.value.enqueued', false],
            ['observe-admitted-2.value.durabilityDowngrade.requested', 'local-outbox'],
            ['observe-admitted-2.value.durabilityDowngrade.cause', 'quota'],
            [
                'observe-admitted-3.value.state',
                '^(accepted|queued|transport-accepted|acknowledged)$'
            ],
            ['observe-admitted-3.value.enqueued', true]
        ]);
    });

    it('reads the store failing, then healthy with the quota still its last failure', () => {
        const waits = findScenario('rtc-with-ws-fallback', 'storage-unavailable').sender.commands
            .filter((command) => command.kind === 'wait');

        expect(waits.map((wait) => wait.match)).toEqual([
            {
                kind: 'diagnostic',
                topic: STORAGE_TOPIC,
                payloadPath: 'data',
                contains: '"status":"failing","lastFailure":{"cause":"quota"'
            },
            {
                kind: 'diagnostic',
                topic: STORAGE_TOPIC,
                payloadPath: 'data',
                contains: '"status":"healthy","lastFailure":{"cause":"quota"'
            }
        ]);
    });

    it('has the receiver get the downgraded and the recovered send, never the refused one', () => {
        const receiver = findScenario('ws', 'storage-unavailable').receiver;
        const waits = receiver.commands.filter((command) => command.kind === 'wait');

        expect(waits.map((wait) => [wait.match.equals, wait.absent === true])).toEqual([
            [{ marker: 'storage-unavailable', send: '2' }, false],
            [{ marker: 'storage-unavailable', send: '3' }, false],
            [{ marker: 'storage-unavailable', send: '1' }, true]
        ]);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)(
        'writes every %s command the control validator accepts',
        (carrier) => {
            const scenario = findScenario(carrier, 'storage-unavailable');

            for (const command of [...scenario.sender.commands, ...scenario.receiver.commands]) {
                expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({
                    ok: true
                });
            }
        }
    );
});

describe('delivery-reload recovery reads', () => {
    it.each(
        [
            ['ws', 'browser-ws-client'],
            ['rtc', 'browser-rtc-overlay'],
            ['rtc-with-ws-fallback', 'browser-rtc-overlay']
        ] as const
    )(
        'waits after the %s reload for one restored recovery of the session inbound store and of %s',
        (carrier, originalStore) => {
            const { sender } = findScenario(carrier, 'delivery-reload');
            const reconnect = sender.commands.findIndex((command) =>
                command.commandId?.endsWith('-sender-reconnect')
            );
            const recoveries = sender.commands.slice(reconnect).filter((command) =>
                command.kind === 'wait' && command.match.topic === STORAGE_TOPIC
            );
            const sessionId =
                `{resultCache.alm-${carrier}-delivery-reload-sender-reconnect.value.sessionId}`;

            expect(recoveries.map((wait) => wait.kind === 'wait' ? wait.match.contains : undefined))
                .toEqual([
                    `"kind":"recovery","storeId":"browser-session-inbound:${sessionId}","outcome":{"kind":"restored"`,
                    `"kind":"recovery","storeId":"${originalStore}:${sessionId}","outcome":{"kind":"restored"`
                ]);
            expect(sender.commands.at(-2)?.commandId).toBe(
                `alm-${carrier}-delivery-reload-sender-storage-counters-recovered`
            );
        }
    );

    it('names the stores by the browser\'s own store ids', () => {
        expect(`${RELOAD_RECOVERED_STORE_PREFIXES.sessionInbound}:s`).toBe(
            String(toBrowserSessionALInboundRuntimeStoreId('s'))
        );
        expect(`${RELOAD_RECOVERED_STORE_PREFIXES.ws}:s`).toBe(
            String(toBrowserWsClientALRuntimeStoreId('s'))
        );
        expect(`${RELOAD_RECOVERED_STORE_PREFIXES.rtc}:s`).toBe(
            String(toBrowserRtcOverlayALRuntimeStoreId('s'))
        );
    });
});
```

Run it. Expected (measured on `3561cc9f3` with this file): `Tests  17 failed (17)` — no `storage-unavailable` scenario, no
recovery waits, no `RELOAD_RECOVERED_STORE_PREFIXES`.

- [ ] **Step 11: Carry `onStorageUnavailable` through `messages.send` and `durabilityDowngrade` into the observation.**

`packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts b/packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts
--- a/packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts
+++ b/packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts
@@ -108,6 +108,7 @@ export const RALLAR_BLACK_BOX_COMMAND_FIELDS = {
             'reliability',
             'ack',
             'durability',
+            'onStorageUnavailable',
             'ttlMs',
             'orderingKey',
             'seq',
@@ -296,6 +297,7 @@ export const RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES = {
     messagesReliability: ['best-effort', 'at-least-once'],
     messagesAck: ['none', 'receiver', 'all-logical-recipients', 'group-leader'],
     messagesDurability: AL_DURABILITY_ALGOS,
+    messagesOnStorageUnavailable: ['refuse', 'volatile'],
     messagesQosAckAlgo: ['none', 'hop', 'subtree', 'receiver'],
     /** Roles, not session ids: no session exists when a recipe is written. */
     messagesToPeer: ['server', 'receiver'],
```

`packages/shared-test/rallar-bb-test/schema.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/schema.ts b/packages/shared-test/rallar-bb-test/schema.ts
--- a/packages/shared-test/rallar-bb-test/schema.ts
+++ b/packages/shared-test/rallar-bb-test/schema.ts
@@ -616,6 +616,10 @@ const COMMAND_SCHEMAS: Readonly<Record<RallarBlackBoxTestCommandKind, JsonSchema
         reliability: messagesReliabilitySchema,
         ack: messagesAckSchema,
         durability: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesDurability },
+        onStorageUnavailable: {
+            type: 'string',
+            enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesOnStorageUnavailable
+        },
         ttlMs: { type: 'integer', minimum: 0 },
         orderingKey: stringSchema,
         seq: numberSchema,
```

`packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts b/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
--- a/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
+++ b/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
@@ -328,6 +328,8 @@ export type RallarBlackBoxTestMessagesSendCommand =
         reliability?: 'best-effort' | 'at-least-once';
         ack?: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
         durability?: 'volatile' | 'local-outbox' | 'local-inbox';
+        /** What the typed channel does when its durable storage is unavailable; absent, it refuses. */
+        onStorageUnavailable?: 'refuse' | 'volatile';
         ttlMs?: number;
         orderingKey?: string;
         seq?: number;
```

`packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts b/packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts
--- a/packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts
+++ b/packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts
@@ -96,6 +96,12 @@ function validateOrdinaryMessagesSendCommand(command: RallarBlackBoxTestRecord):
         ...validateEnumField({ record: command, key: 'reliability', path, allowed: values.messagesReliability }),
         ...validateEnumField({ record: command, key: 'ack', path, allowed: values.messagesAck }),
         ...validateEnumField({ record: command, key: 'durability', path, allowed: values.messagesDurability }),
+        ...validateEnumField({
+            record: command,
+            key: 'onStorageUnavailable',
+            path,
+            allowed: values.messagesOnStorageUnavailable
+        }),
         ...validateEnumField({ record: command, key: 'toPeer', path, allowed: values.messagesToPeer }),
         ...validateIntegerField({ record: command, key: 'ttlMs', path, minimum: 0 }),
         ...validateNumberField(command, 'seq', path),
```

`packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts b/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts
--- a/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts
+++ b/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts
@@ -13,7 +13,8 @@ export const RALLAR_BLACK_BOX_ALM_COMMAND_CAPABILITIES: readonly Omit<
             'minSnapshotVersion states a room snapshot floor, absolute or aboveCurrentBy the sender\'s version at ' +
             'send time. qos: { ack: { algo } } passes a QoS ack algorithm request (none, hop, subtree, receiver) to ' +
             'the product as given. durability (volatile, local-outbox, local-inbox) declares the typed channel\'s ' +
-            'durability; absent, the send is volatile. ' +
+            'durability; absent, the send is volatile. onStorageUnavailable (refuse, volatile) declares what the ' +
+            'channel does when its durable storage is unavailable; absent, it refuses. ' +
             'toPeer (server or receiver) addresses one peer by its lane role, which the page resolves at send time to ' +
             'the WS server\'s peer id or to the one other live session of the room; a role it cannot resolve fails ' +
             'the send and opens no handle. ' +
```

`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts`:

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts
@@ -294,6 +294,8 @@ export interface BlackBoxRallarMessageSendInput {
     readonly ack: ALAckMode | undefined;
     /** Absent, the send is volatile. */
     readonly durability: ALDurabilityAlgo | undefined;
+    /** Absent, the channel refuses a durable send its storage cannot take. */
+    readonly onStorageUnavailable: 'refuse' | 'volatile' | undefined;
     readonly ttlMs: number | undefined;
     readonly orderingKey: string | undefined;
     readonly seq: number | undefined;
@@ -364,7 +366,9 @@ export interface BlackBoxRallarMessageSendDiagnostics {
 }
 
 export interface BlackBoxRallarDeliveryObservation
-    extends ALDeliveryReceiptEvidence, Pick<ALDeliveryEvidence, 'relayRejection' | 'failure' | 'carrierFallback'> {
+    extends
+        ALDeliveryReceiptEvidence,
+        Pick<ALDeliveryEvidence, 'relayRejection' | 'failure' | 'carrierFallback' | 'durabilityDowngrade'> {
     readonly handleId: string;
     readonly state: ALDeliveryState;
     readonly submitted: boolean;
```

`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts`:

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts
@@ -26,7 +26,7 @@ type MessageSendIdentity = Pick<
 
 type MessageSendOptions = Pick<
     BlackBoxRallarMessageSendInput,
-    'roomRef' | 'scope' | 'reliability' | 'ack' | 'durability' | 'minSnapshotVersion' | 'qos'
+    'roomRef' | 'scope' | 'reliability' | 'ack' | 'durability' | 'onStorageUnavailable' | 'minSnapshotVersion' | 'qos'
 >;
 
 const MESSAGE_CARRIERS: readonly BlackBoxRallarMessageSendInput['carrier'][] = ['ws', 'rtc', 'rtc-with-ws-fallback'];
@@ -36,6 +36,10 @@ const MESSAGE_RELIABILITIES: readonly NonNullable<BlackBoxRallarMessageSendInput
     'at-least-once'
 ];
 const QOS_ACK_ALGOS: readonly ALAckAlgo[] = ['none', 'hop', 'subtree', 'receiver'];
+const ON_STORAGE_UNAVAILABLE: readonly NonNullable<BlackBoxRallarMessageSendInput['onStorageUnavailable']>[] = [
+    'refuse',
+    'volatile'
+];
 const REPLAY_CARRIERS: readonly ALDeliveryCarrier[] = ['ws', 'rtc'];
 const MESSAGE_PEER_ROLES: readonly NonNullable<BlackBoxRallarMessageSendInput['toPeer']>[] = [
     'server',
@@ -52,6 +56,7 @@ const REPLAY_REFUSED_FIELDS = [
     'reliability',
     'ack',
     'durability',
+    'onStorageUnavailable',
     'ttlMs',
     'orderingKey',
     'seq',
@@ -158,43 +163,55 @@ function decodeMessageSendIdentity(
         : Either.ofRight({ timeoutMs, connection, carrier, typeId, handleId });
 }
 
-/** A null scope, reliability or durability reads as absent, the way the recipe schema writes an unset option. */
+/** A null scope, reliability, durability or storage choice reads as absent, the way the recipe schema writes an unset option. */
 function decodeMessageSendOptions(
     record: BlackBoxRallarCommandRecord
 ): Either<BlackBoxRallarInputIssue, MessageSendOptions> {
-    const scope = record.scope ?? undefined;
-    const reliability = record.reliability ?? undefined;
-    const durability = record.durability ?? undefined;
-    const knownScope = MESSAGE_SCOPES.find((candidate) => candidate === scope);
-    const knownReliability = MESSAGE_RELIABILITIES.find((candidate) => candidate === reliability);
-    const knownDurability = AL_DURABILITY_ALGOS.find((candidate) => candidate === durability);
+    const scope = decodeKnownSendOption(record.scope, MESSAGE_SCOPES, 'scope must be room, world, or all');
+    const reliability = decodeKnownSendOption(
+        record.reliability,
+        MESSAGE_RELIABILITIES,
+        'reliability must be best-effort or at-least-once'
+    );
+    const durability = decodeKnownSendOption(
+        record.durability,
+        AL_DURABILITY_ALGOS,
+        'durability must be volatile, local-outbox or local-inbox'
+    );
+    const onStorageUnavailable = decodeKnownSendOption(
+        record.onStorageUnavailable,
+        ON_STORAGE_UNAVAILABLE,
+        'onStorageUnavailable must be refuse or volatile'
+    );
     const minSnapshotVersion = decodeMessageSnapshotFloor(record.minSnapshotVersion);
     const qos = decodeMessageQos(record.qos);
     return decodeBlackBoxCommandRouting(record).flatMap(
         (issue) => Either.ofLeft(issue),
         (routing) => {
-            if (scope !== undefined && knownScope === undefined) {
-                return Either.ofLeft({ message: 'messages.send.scope must be room, world, or all.' });
+            if (isInputIssue(scope)) {
+                return Either.ofLeft(scope);
+            }
+            if (isInputIssue(reliability)) {
+                return Either.ofLeft(reliability);
             }
-            if (reliability !== undefined && knownReliability === undefined) {
-                return Either.ofLeft({ message: 'messages.send.reliability must be best-effort or at-least-once.' });
+            if (isInputIssue(durability)) {
+                return Either.ofLeft(durability);
             }
-            if (durability !== undefined && knownDurability === undefined) {
-                return Either.ofLeft({
-                    message: 'messages.send.durability must be volatile, local-outbox or local-inbox.'
-                });
+            if (isInputIssue(onStorageUnavailable)) {
+                return Either.ofLeft(onStorageUnavailable);
             }
-            if (minSnapshotVersion !== undefined && 'message' in minSnapshotVersion) {
+            if (isInputIssue(minSnapshotVersion)) {
                 return Either.ofLeft(minSnapshotVersion);
             }
-            if (qos !== undefined && 'message' in qos) {
+            if (isInputIssue(qos)) {
                 return Either.ofLeft(qos);
             }
             return Either.ofRight({
                 ...routing,
-                scope: knownScope,
-                reliability: knownReliability,
-                durability: knownDurability,
+                scope,
+                reliability,
+                durability,
+                onStorageUnavailable,
                 minSnapshotVersion,
                 qos
             });
@@ -202,6 +219,20 @@ function decodeMessageSendOptions(
     );
 }
 
+/** An absent option is undefined; a value outside `allowed` is the issue `rule` states. */
+function decodeKnownSendOption<T extends string>(
+    value: unknown,
+    allowed: readonly T[],
+    rule: string
+): T | BlackBoxRallarInputIssue | undefined {
+    const known = allowed.find((candidate) => candidate === value);
+    return value === undefined || value === null || known !== undefined ? known : { message: `messages.send.${rule}.` };
+}
+
+function isInputIssue<T>(value: T | BlackBoxRallarInputIssue): value is BlackBoxRallarInputIssue {
+    return typeof value === 'object' && value !== null && 'message' in value;
+}
+
 /** Absent, the send states no floor of its own. */
 function decodeMessageSnapshotFloor(
     value: unknown
```

`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts`:

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts
@@ -23,6 +23,7 @@ export interface TypedChannelRoute {
     readonly topicId: string | undefined;
     readonly roomRef: GroupRef | undefined;
     readonly durability: ALDurabilityAlgo | undefined;
+    readonly onStorageUnavailable: 'refuse' | 'volatile' | undefined;
     readonly purpose: ALChannelPurpose;
 }
 
@@ -58,7 +59,8 @@ export class BlackBoxRallarTypedChannels {
             roomId: config.roomId,
             roomRef: route.roomRef,
             purpose: route.purpose,
-            ...(route.durability === undefined ? {} : { durability: route.durability })
+            ...(route.durability === undefined ? {} : { durability: route.durability }),
+            ...(route.onStorageUnavailable === undefined ? {} : { onStorageUnavailable: route.onStorageUnavailable })
         });
         const selector = config.rallar.messageSelector
             ? normalizeRallarMessageSelector(config.rallar.messageSelector)
@@ -102,6 +104,7 @@ export class BlackBoxRallarTypedChannels {
             topicId: resolveBlackBoxRallarTopicId(config),
             roomRef: blackBoxRallarRoomRefOf(config),
             durability: undefined,
+            onStorageUnavailable: undefined,
             purpose: 'notification'
         });
     }
```

`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts`:

```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts
@@ -66,6 +66,7 @@ export function toDeliveryObservation(
         attemptCarriers: attempts.flatMap((attempt) => attempt.outcome === undefined ? [] : [attempt.carrier]),
         relayRejection: lifecycle?.evidence.relayRejection,
         carrierFallback: lifecycle?.evidence.carrierFallback,
+        durabilityDowngrade: lifecycle?.evidence.durabilityDowngrade,
         failure: lifecycle?.evidence.failure,
         reason: lifecycle?.evidence.reason,
         backpressured: attempts.some((attempt) =>
@@ -103,6 +104,7 @@ export class BlackBoxRallarDeliveryLedger {
             topicId: send.topicId,
             roomRef,
             durability: send.durability,
+            onStorageUnavailable: send.onStorageUnavailable,
             purpose: send.toPeer === undefined ? 'notification' : 'command'
         });
         this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.messages.send_started', {
```

Keep the contracts doc line free of an apostrophe: the style walker misreads `channel's` inside a type literal and re-keys five `boundary.unknown` findings later in the file (measured; with "What the typed channel does …" the file reports none).

The observation's `Pick` now includes `durabilityDowngrade` (required), so the six typed observation literals of the
live RTC control client's test gain it:

```diff
diff --git a/packages/tests/rallar-black-box/live-rtc-control-client.test.ts b/packages/tests/rallar-black-box/live-rtc-control-client.test.ts
--- a/packages/tests/rallar-black-box/live-rtc-control-client.test.ts
+++ b/packages/tests/rallar-black-box/live-rtc-control-client.test.ts
@@ -211,6 +211,7 @@ describe('live RTC control client', () => {
                             attemptCarriers: [],
                             relayRejection: undefined,
                             carrierFallback: undefined,
+                            durabilityDowngrade: undefined,
                             failure: undefined,
                             backpressured: false,
                             enqueued: false
@@ -325,6 +326,7 @@ describe('live RTC control client', () => {
                             attemptCarriers: [],
                             relayRejection: undefined,
                             carrierFallback: undefined,
+                            durabilityDowngrade: undefined,
                             failure: undefined,
                             backpressured: false,
                             enqueued: true
@@ -438,6 +440,7 @@ describe('live RTC control client', () => {
                         attemptCarriers: [],
                         relayRejection: undefined,
                         carrierFallback: undefined,
+                        durabilityDowngrade: undefined,
                         failure: undefined,
                         backpressured: false,
                         enqueued: false
@@ -507,6 +510,7 @@ describe('live RTC control client', () => {
                             attemptCarriers: [],
                             relayRejection: undefined,
                             carrierFallback: undefined,
+                            durabilityDowngrade: undefined,
                             failure: undefined,
                             backpressured: false,
                             enqueued: true
@@ -705,6 +709,7 @@ describe('live RTC control client', () => {
                                 attemptCarriers: [],
                                 relayRejection: undefined,
                                 carrierFallback: undefined,
+                                durabilityDowngrade: undefined,
                                 failure: undefined,
                                 backpressured: false,
                                 enqueued: true
@@ -772,6 +777,7 @@ describe('live RTC control client', () => {
                             attemptCarriers: [],
                             relayRejection: undefined,
                             carrierFallback: undefined,
+                            durabilityDowngrade: undefined,
                             failure: undefined,
                             backpressured: false,
                             enqueued: true
```

- [ ] **Step 12: The quota fault builder and the scenario.**

`packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-fault-commands.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-fault-commands.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-fault-commands.ts
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-fault-commands.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-fault-commands.ts
@@ -1,6 +1,7 @@
 import type {
     RallarBlackBoxTestCommand,
-    RallarBlackBoxTestFaultInjectCommand
+    RallarBlackBoxTestStorageFaultInjectCommand,
+    RallarBlackBoxTestTransportFaultInjectCommand
 } from '../../rallar-black-box-test-contracts.ts';
 
 import { toBudgetMs } from './alm-conformance-budgets.ts';
@@ -58,9 +59,30 @@ export function toRtcDropFaultCommand(
     });
 }
 
+/**
+ * Fails every admission write of this page with `QuotaExceededError` while held; the same fault id with
+ * `remaining: 0` releases it. Reads and the work queue's own writes go through.
+ */
+export function toAdmissionQuotaFaultCommand(
+    step: AlmConformanceStepInput,
+    name: string,
+    remaining: 'until-cleared' | 0
+): RallarBlackBoxTestStorageFaultInjectCommand {
+    return {
+        kind: 'fault.inject',
+        commandId: toCommandId(step, name),
+        faultId: `quota-admission-${toScenarioTypeId(step)}`,
+        carrier: 'storage',
+        match: { owner: 'al-admission', kind: 'write' },
+        action: 'quota',
+        remaining,
+        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, step.input.deadlineMs)
+    };
+}
+
 function toFaultCommand(
     input: AlmConformanceFaultCommandInput
-): RallarBlackBoxTestFaultInjectCommand {
+): RallarBlackBoxTestTransportFaultInjectCommand {
     const typeId = toScenarioTypeId(input.step);
     return {
         kind: 'fault.inject',
```

`packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts
@@ -30,6 +30,8 @@ interface AlmConformanceSendDelivery {
     readonly ack?: 'receiver' | 'all-logical-recipients';
     readonly reliability?: 'at-least-once';
     readonly durability?: 'local-outbox' | 'local-inbox';
+    /** Absent, the channel refuses a durable send its storage cannot take. */
+    readonly onStorageUnavailable?: 'refuse' | 'volatile';
     readonly orderingKey?: string;
     readonly seq?: number;
     readonly minSnapshotVersion?: RallarBlackBoxTestMessagesSendCommand['minSnapshotVersion'];
```

`packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
@@ -31,6 +31,7 @@ export type AlmConformanceScenarioId =
     | 'receipt-exhausted-fallback'
     | 'receipted-audience'
     | 'server-command'
+    | 'storage-unavailable'
     | 'unicast-fallback'
     | 'volatile-default'
     | 'ws-unicast-receipt';
```

`packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts b/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
--- a/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
@@ -43,6 +43,7 @@ import { orderingResync } from './scenarios/ordering-resync.ts';
 import { receiptExhaustedFallback } from './scenarios/receipt-exhausted-fallback.ts';
 import { receiptedAudience } from './scenarios/receipted-audience.ts';
 import { serverCommand } from './scenarios/server-command.ts';
+import { storageUnavailable } from './scenarios/storage-unavailable.ts';
 import { unicastFallback } from './scenarios/unicast-fallback.ts';
 import { volatileDefault } from './scenarios/volatile-default.ts';
 import { wsUnicastReceipt } from './scenarios/ws-unicast-receipt.ts';
@@ -86,6 +87,7 @@ const ALM_CONFORMANCE_SCENARIOS: readonly AlmConformanceScenarioDefinition[] = [
     deliveryLifecycle,
     durableOptIn,
     deliveryReload,
+    storageUnavailable,
     orderingResync,
     ...crossCarrierDuplicate,
     ...notYetInSync,
```

Create `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/storage-unavailable.ts` (the health wait stays private to it; `alm-conformance-message-commands.ts` is at 11 runtime exports and a 13th fails the responsibility-count review):

```ts
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toAdmissionQuotaFaultCommand } from '../alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toPayloadWait } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceMessageStepInput,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';

/**
 * A full disk under a durable channel: while every admission write fails with a quota error, the channel that refuses
 * fails its send typed and the channel that goes volatile delivers it without storage, saying so; once the quota
 * frees, the next durable send commits and the store reads healthy again. One type id carries both channels: the
 * channel's choice is its own, not the type's.
 */
export const storageUnavailable: AlmConformanceScenarioDefinition = {
    scenarioId: 'storage-unavailable',
    scenarioKey: 'storage-unavailable',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toStorageUnavailableSenderCommands,
    toRecipientCommands: toStorageUnavailableReceiverCommands
};

function toStorageUnavailableSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toAdmissionQuotaFaultCommand(sender, 'quota-hold', 'until-cleared'),
        ...toRefusedSendCommands({ ...sender, index: 1 }),
        toQuotaHealthWait(sender, 'health-failing', 'failing'),
        ...toDowngradedSendCommands({ ...sender, index: 2 }),
        toAdmissionQuotaFaultCommand(sender, 'quota-release', 0),
        ...toDurableSendCommands({ ...sender, index: 3 }),
        toQuotaHealthWait(sender, 'health-healthy', 'healthy')
    ];
}

/** The default channel refuses: the handle fails with the storage cause and nothing is sent. */
function toRefusedSendCommands(
    send: AlmConformanceMessageStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...send,
            payload: toPayload(send),
            delivery: { durability: 'local-outbox' }
        }),
        toObserveCommand({ ...send, state: 'failed' }),
        ...([['failure.kind', 'storage-unavailable'], ['failure.cause', 'quota'], [
            'submitted',
            false
        ]] as const).map((
            [field, expected]
        ) => toResultAssertion({
            step: send,
            name: `assert-refused-${field.replace('.', '-')}-${send.index}`,
            resultName: `observe-failed-${send.index}`,
            field,
            operator: 'equals',
            expected
        }))
    ];
}

/** The volatile channel admits the same message on the memory pair once and names the durability it lost. */
function toDowngradedSendCommands(
    send: AlmConformanceMessageStepInput
): readonly RallarBlackBoxTestCommand[] {
    const facts = [
        ['enqueued', false],
        ['durabilityDowngrade.requested', 'local-outbox'],
        ['durabilityDowngrade.cause', 'quota']
    ] as const;
    return [
        toSendCommand({
            ...send,
            payload: toPayload(send),
            delivery: { durability: 'local-outbox', onStorageUnavailable: 'volatile' }
        }),
        ...toAdmissionCommands(send),
        ...facts.map(([field, expected]) =>
            toResultAssertion({
                step: send,
                name: `assert-downgraded-${field.replace('.', '-')}-${send.index}`,
                resultName: `observe-admitted-${send.index}`,
                field,
                operator: 'equals',
                expected
            })
        )
    ];
}

function toDurableSendCommands(
    send: AlmConformanceMessageStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...send,
            payload: toPayload(send),
            delivery: { durability: 'local-outbox' }
        }),
        ...toAdmissionCommands(send),
        toResultAssertion({
            step: send,
            name: `assert-enqueued-${send.index}`,
            resultName: `observe-admitted-${send.index}`,
            field: 'enqueued',
            operator: 'equals',
            expected: true
        })
    ];
}

/** The downgraded and the recovered sends arrive; the refused one never does. */
function toStorageUnavailableReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toPayloadWait({
            step: receiver,
            name: 'receive-2',
            payload: toPayload({ ...receiver, index: 2 }),
            absent: false
        }),
        {
            ...toPayloadWait({
                step: receiver,
                name: 'receive-3',
                payload: toPayload({ ...receiver, index: 3 }),
                absent: false
            }),
            timeoutMs: receiver.input.deadlineMs + 2 * NON_EXPIRING_SEND_TIMEOUT_MS
        },
        toPayloadWait({
            step: receiver,
            name: 'absent-1',
            payload: toPayload({ ...receiver, index: 1 }),
            absent: true
        })
    ];
}

function toPayload(step: AlmConformanceMessageStepInput): Readonly<Record<string, string>> {
    return { marker: step.scenarioId, send: String(step.index) };
}

/**
 * A durable store's `health` transition on the storage port, matched in its emitted key order (`status`, then
 * `lastFailure`): a quota failure names the move to `failing`, and stays the last failure once the store reads `healthy`
 * again, so the healthy match cannot be an earlier healthy reading.
 */
function toQuotaHealthWait(
    step: AlmConformanceStepInput,
    name: string,
    status: 'failing' | 'healthy'
): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: {
            kind: 'diagnostic',
            topic: STORAGE_TOPIC,
            payloadPath: 'data',
            contains: `"status":"${status}","lastFailure":{"cause":"quota"`
        },
        timeoutMs: toBudgetMs(NON_EXPIRING_SEND_TIMEOUT_MS, step.input.deadlineMs)
    };
}
```

- [ ] **Step 13: `delivery-reload` reads one recovery per store after the reload.**

`packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
--- a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
@@ -33,6 +33,19 @@ import type { AlmReloadCheckpoint } from '../alm-reload-pair.ts';
  */
 const RELOAD_RECOVERY_MARGIN_MS = 60_000;
 
+const STORAGE_TOPIC = 'rallar.browser.alm.storage';
+
+/**
+ * The browser's store ids, `<prefix>:<sessionId>` (`browser-al-runtime-identity.ts`, which this Deno-loaded catalog
+ * cannot import). The session inbound store batches every engine round; the outbound store that holds the original
+ * runs its first batch when it reclaims it.
+ */
+export const RELOAD_RECOVERED_STORE_PREFIXES = {
+    sessionInbound: 'browser-session-inbound',
+    ws: 'browser-ws-client',
+    rtc: 'browser-rtc-overlay'
+} as const;
+
 export const deliveryReload: AlmConformanceScenarioDefinition = {
     scenarioId: 'delivery-reload',
     scenarioKey: 'delivery-reload',
@@ -105,10 +118,33 @@ function toDeliveryReloadSenderCommands(sender: AlmConformanceStepInput): readon
             operator: 'equals',
             expected: 'unobservable'
         }),
+        ...toRecoveredStoreWaits(sender),
         toStorageCountersCommand(sender, 'storage-counters-recovered', false)
     ];
 }
 
+/** One `recovery` per durable store the reloaded document batches over: each restored, none created or reset. */
+function toRecoveredStoreWaits(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
+    const originalStore = sender.input.carrier === 'ws'
+        ? RELOAD_RECOVERED_STORE_PREFIXES.ws
+        : RELOAD_RECOVERED_STORE_PREFIXES.rtc;
+    const timeoutMs = toReloadSurvivalTtlMs(sender.input.deadlineMs);
+    return [
+        toStoreRecoveryWait(sender, {
+            name: 'recovered-session-inbound',
+            storeIdPrefix: RELOAD_RECOVERED_STORE_PREFIXES.sessionInbound,
+            connectName: 'reconnect',
+            timeoutMs
+        }),
+        toStoreRecoveryWait(sender, {
+            name: 'recovered-original-store',
+            storeIdPrefix: originalStore,
+            connectName: 'reconnect',
+            timeoutMs
+        })
+    ];
+}
+
 function toReloadOriginalSend(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
     return toSendCommand({
         ...sender,
@@ -141,3 +177,25 @@ function toReloadHealthCommand(step: AlmConformanceStepInput, name: string): Ral
 function toReloadSurvivalTtlMs(deadlineMs: number): number {
     return deadlineMs - RESPONSE_MARGIN_MS + RELOAD_RECOVERY_MARGIN_MS;
 }
+
+/**
+ * The one `recovery` a durable store reports after its first work batch, matched in its emitted key order (`kind`,
+ * `storeId`, `outcome`). The store id embeds the session the reconnect restored, read from that connect's result.
+ */
+function toStoreRecoveryWait(
+    step: AlmConformanceStepInput,
+    store: Readonly<{ name: string; storeIdPrefix: string; connectName: string; timeoutMs: number; }>
+): RallarBlackBoxTestCommand {
+    const sessionId = `{resultCache.${toCommandId(step, store.connectName)}.value.sessionId}`;
+    return {
+        kind: 'wait',
+        commandId: toCommandId(step, store.name),
+        match: {
+            kind: 'diagnostic',
+            topic: STORAGE_TOPIC,
+            payloadPath: 'data',
+            contains: `"kind":"recovery","storeId":"${store.storeIdPrefix}:${sessionId}","outcome":{"kind":"restored"`
+        },
+        timeoutMs: store.timeoutMs
+    };
+}
```

`packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts b/packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts
--- a/packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts
@@ -163,7 +163,9 @@ function assessReloadCommands(evidence: ReloadEvidence): readonly string[] {
         suffix[0].rallar.username === '' && suffix[0].rallar.password === '' &&
         suffix[0].connection === send.connection &&
         suffix.at(-1)?.kind === 'storage.counters' &&
-        suffix.slice(1).every((command) => ['messages.observe', 'assert', 'storage.counters'].includes(command.kind));
+        suffix.slice(1).every((command) =>
+            ['messages.observe', 'assert', 'wait', 'storage.counters'].includes(command.kind)
+        );
     const receiverPreserved =
         [...receiverBefore, ...recovery].every((command) =>
             ['http.request', 'rtc.connect', 'health', 'stats', 'wait', 'barrier'].includes(command.kind)
```

- [ ] **Step 14: Pin the new scenario in the lists and regenerate manifest 18.**

`packages/tests/shared-test/alm-conformance-recipes.test.ts`:

```diff
diff --git a/packages/tests/shared-test/alm-conformance-recipes.test.ts b/packages/tests/shared-test/alm-conformance-recipes.test.ts
--- a/packages/tests/shared-test/alm-conformance-recipes.test.ts
+++ b/packages/tests/shared-test/alm-conformance-recipes.test.ts
@@ -124,6 +124,7 @@ const SCENARIO_KEYS_BY_CARRIER = {
         'delivery-lifecycle',
         'durable-opt-in',
         'delivery-reload',
+        'storage-unavailable',
         'ordering-resync',
         'ws-unicast-receipt',
         'server-command',
@@ -137,6 +138,7 @@ const SCENARIO_KEYS_BY_CARRIER = {
         'delivery-lifecycle',
         'durable-opt-in',
         'delivery-reload',
+        'storage-unavailable',
         'ordering-resync',
         'not-yet-in-sync-delivered-after-refresh',
         'not-yet-in-sync-expires',
@@ -151,6 +153,7 @@ const SCENARIO_KEYS_BY_CARRIER = {
         'delivery-lifecycle',
         'durable-opt-in',
         'delivery-reload',
+        'storage-unavailable',
         'ordering-resync',
         'cross-carrier-duplicate-rtc-then-ws',
         'cross-carrier-duplicate-ws-then-rtc',
@@ -349,7 +352,7 @@ describe('alm-conformance recipe family', () => {
         }
     });
 
-    it('keeps reload and ordering-resync full-only while preserving the smoke scenarios', () => {
+    it('keeps reload, storage-unavailable and ordering-resync full-only while preserving the smoke scenarios', () => {
         expect(
             createAlmConformanceRecipes(toConformanceInput('ws'))
                 .filter((scenario) => scenario.tags.includes('smoke'))
@@ -368,6 +371,7 @@ describe('alm-conformance recipe family', () => {
                 .map((scenario) => scenario.scenarioId)
         ).toEqual([
             'delivery-reload',
+            'storage-unavailable',
             'ordering-resync',
             'cross-carrier-duplicate',
             'cross-carrier-duplicate',
@@ -401,6 +405,7 @@ describe('alm-conformance recipe family', () => {
             ['full'],
             ['full'],
             ['full'],
+            ['full'],
             ['full']
         ]);
     });
```

`packages/tests/shared-test/alm-conformance-recipe-validation.test.ts`:

```diff
diff --git a/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts b/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
--- a/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
+++ b/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
@@ -35,6 +35,7 @@ const CARRIER_SCENARIO_IDS = {
         'delivery-lifecycle',
         'durable-opt-in',
         'delivery-reload',
+        'storage-unavailable',
         'ordering-resync',
         'ws-unicast-receipt',
         'server-command',
@@ -49,6 +50,7 @@ const CARRIER_SCENARIO_IDS = {
         'delivery-lifecycle',
         'durable-opt-in',
         'delivery-reload',
+        'storage-unavailable',
         'ordering-resync',
         'not-yet-in-sync',
         'not-yet-in-sync',
@@ -64,6 +66,7 @@ const CARRIER_SCENARIO_IDS = {
         'delivery-lifecycle',
         'durable-opt-in',
         'delivery-reload',
+        'storage-unavailable',
         'ordering-resync',
         'cross-carrier-duplicate',
         'cross-carrier-duplicate',
```

`packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`:

```diff
diff --git a/packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts b/packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
--- a/packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
+++ b/packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
@@ -1175,6 +1175,7 @@ describe('Hetzner distributed manifest catalog', () => {
                 'delivery-baseline',
                 'delivery-lifecycle',
                 'durable-opt-in',
+                'storage-unavailable',
                 'ordering-resync',
                 'ws-unicast-receipt',
                 'server-command',
```

Manifest 18's description names the new scenario (R-I2a-i-61); the entry's families, recipes and targets do not
change, and manifest 22 is untouched:

```diff
diff --git a/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts b/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts
--- a/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts
+++ b/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts
@@ -70,8 +70,9 @@ export function createAlmConformance2AgentEntry(): HetznerDistributedManifestEnt
             'baseline, lifecycle, the durable opt-in, durable reload, ordering resync, the cross-carrier duplicate, ' +
             'not-yet-in-sync, fallback within the deadline: a dropped RTC leg, a spent RTC receipt, and no ' +
             'fallback after the deadline, and the addressed sends: a command to the receiver, its unicast ' +
-            'fallback, a command to the server, and the volatile session bound) across ws, rtc, and ' +
-            'rtc-with-ws-fallback carriers.',
+            'fallback, a command to the server, and the volatile session bound, and storage unavailable: a ' +
+            'durable send refused typed and one downgraded to volatile) across ws, rtc, and rtc-with-ws-fallback ' +
+            'carriers.',
         distributedRunId: 'hetzner-alm-conformance-2-agent',
         recipes: [
             toAlmConformanceCombinedRecipe(scenarios, 'sender', 'two-agent'),
```

```sh
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
```

Expected (measured; tsx needs the sandbox off for its IPC pipe): 67 `wrote` lines, `git status` shows only
`18-alm-conformance-2-agent.json` among the manifests changed (+1145 −118 against Task 8's commit, its description
line included), then `checked 67 Hetzner distributed manifest(s)`.

- [ ] **Step 15: Teach the Deno fixture the scenario and the recoveries.** The generated manifest 18 now holds the quota fault, the two storage-port waits and the recovery waits, which the fixture must answer:

`apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts`:

```diff
diff --git a/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts b/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
--- a/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
+++ b/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
@@ -36,9 +36,14 @@ interface PortMessage {
     submitted: boolean;
     attemptCarriers: readonly ('rtc' | 'ws')[];
     attemptOutcomes: readonly ('not-ready' | 'sent')[];
-    /** The volatile bound's refusal (D78); undefined for every send it admits. */
-    readonly failure: Readonly<{ kind: 'refused'; reason: 'capacity'; }> | undefined;
+    /** The volatile bound's refusal (D78) or a refused durable send under a storage quota; undefined for every send admitted. */
+    readonly failure:
+        | Readonly<{ kind: 'refused'; reason: 'capacity'; }>
+        | Readonly<{ kind: 'storage-unavailable'; cause: 'quota'; }>
+        | undefined;
     carrierFallback: ALDeliveryCarrierFallback | undefined;
+    /** A durable send a volatile channel admitted volatile while its storage was full. */
+    readonly durabilityDowngrade: Readonly<{ requested: string; cause: 'quota'; }> | undefined;
 }
 
 interface HandedOverOutcome {
@@ -85,6 +90,9 @@ class GeneratedAlmPorts {
     readonly messages: PortMessage[] = [];
     readonly handles = new Map<string, PortMessage>();
     readonly holds = new Map<string, string>();
+    /** A held storage fault fails every durable admission of the sender's page with a quota error. */
+    storageQuota = false;
+    storageFailing = false;
     readonly receiver: RallarBlackBoxTestRuntime;
     sender: RallarBlackBoxTestRuntime;
     private absence: { duration: number; release: () => void; } | undefined;
@@ -147,6 +155,7 @@ class GeneratedAlmPorts {
             case 'http.request':
                 return { status: 'ok', value: { status: 200 } };
             case 'rtc.connect':
+                this.reportStoreRecoveries(role, session.sessionId);
                 this.deliverRecoveredOriginals(role);
                 return { status: 'ok', value: { document, ...session } };
             case 'health':
@@ -195,8 +204,9 @@ class GeneratedAlmPorts {
         if (message && command.state.length === 1 && command.state[0] === 'expired') {
             message.state = 'expired';
         }
-        // Only a send that opted into a durability is enqueued; the default is volatile.
-        const enqueued = (message?.command.durability ?? 'volatile') !== 'volatile';
+        // Only a send that opted into a durability and committed it is enqueued; the default is volatile.
+        const enqueued = (message?.command.durability ?? 'volatile') !== 'volatile' &&
+            message?.durabilityDowngrade === undefined && message?.state !== 'failed';
         return {
             status: 'ok',
             value: {
@@ -209,6 +219,7 @@ class GeneratedAlmPorts {
                 attemptOutcomes: message?.attemptOutcomes ?? [],
                 failure: message?.failure,
                 carrierFallback: message?.carrierFallback,
+                durabilityDowngrade: message?.durabilityDowngrade,
                 ...(message?.command.toPeer !== undefined && message.state === 'acknowledged'
                     ? toAddresseeReceipt(message.command.toPeer)
                     : {})
@@ -296,11 +307,53 @@ class GeneratedAlmPorts {
         }
     }
 
+    /** Every durable store of the page reports what it restored once its first batch ran; the fixture runs it at connect. */
+    private reportStoreRecoveries(role: 'sender' | 'receiver', sessionId: string): void {
+        if (role !== 'sender') {
+            return;
+        }
+        for (const prefix of ['browser-session-inbound', 'browser-ws-client', 'browser-rtc-overlay']) {
+            this.sender.recordEvent({
+                kind: 'diagnostic',
+                topic: 'rallar.browser.alm.storage',
+                payload: {
+                    data: {
+                        kind: 'recovery',
+                        storeId: `${prefix}:${sessionId}`,
+                        outcome: { kind: 'restored', claimed: 0, expired: 0 }
+                    }
+                }
+            });
+        }
+    }
+
+    /** A store's health, stated on its transitions only. */
+    private reportStoreHealth(status: 'failing' | 'healthy'): void {
+        this.storageFailing = status === 'failing';
+        this.sender.recordEvent({
+            kind: 'diagnostic',
+            topic: 'rallar.browser.alm.storage',
+            payload: {
+                data: {
+                    kind: 'health',
+                    storeId: 'browser-ws-client:sender-stored-session',
+                    status,
+                    lastFailure: { cause: 'quota', detail: 'The fixture storage is full.' },
+                    lastRecoveryPointAtMs: undefined
+                }
+            }
+        });
+    }
+
     private injectFault(command: RallarBlackBoxTestFaultInjectCommand): RallarBlackBoxTestCommandOutcome {
+        if (command.carrier === 'storage') {
+            this.storageQuota = command.remaining !== 0;
+            return { status: 'ok', value: { faultId: command.faultId } };
+        }
         if (command.remaining === 0) {
             this.holds.delete(command.faultId);
         }
-        else if (command.carrier !== 'storage') {
+        else {
             this.holds.set(command.faultId, String(command.match?.typeId));
         }
         for (const message of this.messages) {
@@ -315,21 +368,35 @@ class GeneratedAlmPorts {
         assert(isJsonRecordValue(command.payload));
         // The lowered volatile bound refuses the third capacity send at admission (D78): no attempt, nothing delivered.
         const capacityRefused = command.payload.marker === 'capacity' && command.payload.index === 3;
-        const rejected = command.payload.marker === 'bounded-rejection' || capacityRefused;
+        const durable = (command.durability ?? 'volatile') !== 'volatile';
+        const storageRefused = durable && this.storageQuota && command.onStorageUnavailable !== 'volatile';
+        const downgraded = durable && this.storageQuota && command.onStorageUnavailable === 'volatile';
+        const rejected = command.payload.marker === 'bounded-rejection' || capacityRefused || storageRefused;
         const message: PortMessage = {
             command,
             msgId: `port-message-${this.messages.length + 1}`,
-            state: rejected ? 'rejected' : command.payload.seq === 300 ? 'queued' : 'accepted',
+            state: storageRefused ? 'failed' : rejected ? 'rejected' : command.payload.seq === 300 ? 'queued' : 'accepted',
             submitted: false,
             attemptCarriers: [],
             attemptOutcomes: [],
-            failure: capacityRefused ? { kind: 'refused', reason: 'capacity' } : undefined,
-            carrierFallback: undefined
+            failure: capacityRefused
+                ? { kind: 'refused', reason: 'capacity' }
+                : storageRefused
+                ? { kind: 'storage-unavailable', cause: 'quota' }
+                : undefined,
+            carrierFallback: undefined,
+            durabilityDowngrade: downgraded ? { requested: String(command.durability), cause: 'quota' } : undefined
         };
+        if (storageRefused && !this.storageFailing) {
+            this.reportStoreHealth('failing');
+        }
+        if (durable && !this.storageQuota && this.storageFailing) {
+            this.reportStoreHealth('healthy');
+        }
         this.messages.push(message);
         assert(command.handleId);
         this.handles.set(command.handleId, message);
-        if ((command.durability ?? 'volatile') !== 'volatile') {
+        if (durable && !this.storageQuota) {
             this.writes.sender += 1;
         }
         if (command.payload.revision === 'replacement') {
@@ -346,7 +413,7 @@ class GeneratedAlmPorts {
                 msgId: message.msgId,
                 handleId: command.handleId,
                 carrier: command.carrier,
-                status: rejected ? 'rejected' : 'accepted',
+                status: storageRefused ? 'failed' : rejected ? 'rejected' : 'accepted',
                 reason: capacityRefused
                     ? 'The volatile session bound refused the admission.'
                     : rejected
```

```sh
cd apps/rallar-black-box-control-server && deno task check && deno task test
```

Expected (measured on `285d9d1b0`): check exits 0 (with Step 9's `control-alm-evidence.test.ts` literal);
`ok | 192 passed | 0 failed`.

- [ ] **Step 16: Navigation maps.**

`packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`:

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -486,6 +486,29 @@ event's `data` is the event itself, with `kind` and, except for `persist`, the
   request failed, `unsupported` without `navigator.storage.persist`. It has no
   `storeId`.
 
+- `recovery`: one event per durable store per connect, `outcome` being what
+  the store found when its lane started. A store reports after its first work
+  batch, so a store that never runs a batch (an outbound store with no work on
+  its carrier) reports nothing. `outcome` is:
+  - `storage-created`: the store's open created the database, the first time
+    this document opened it
+  - `storage-reset` with `reason`: the open reset a mismatched database
+    (`schema-id-mismatch`, `store-schema-mismatch`), or created again a
+    database this document had opened after another context's `versionchange`
+    closed it (`other-context`); a reset wins over the creation it caused
+  - `restored` with `claimed` and `expired`: the database existed; `claimed` is
+    what the first batch claimed, `expired` the expired rows its reservation
+    deleted on the way
+  - `expired-at-recovery` with `expired`: the first batch claimed nothing and
+    its reservation deleted expired rows
+
+  A creation of a database this document had opened, without a `versionchange`
+  first, is an eviction: the store's health records it as a failure, so it
+  reads as a `health` event with `status: 'failing'` and
+  `lastFailure.cause: 'evicted'` instead of a recovery. `delivery-reload` waits
+  after the reload for a `restored` recovery of the session inbound store and
+  of the outbound store that held the original.
+
 ## Compatibility
 
 Adding optional fields to diagnostic payloads is compatible.
```

`packages/shared/alm/outbound/README.md`:

```diff
diff --git a/packages/shared/alm/outbound/README.md b/packages/shared/alm/outbound/README.md
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -792,6 +792,16 @@ the fixed admission and `alm-work` stores together. The work store uses the cano
 can use the same `IndexedDbConnection` as admission; opening that connection remains
 an explicit storage effect.
 
+Each open also says what it found ([`ALStorageOpening`](../open-indexed-db-admission-database.ts)):
+the database existed, was created, was reset, or was created again after this document
+had opened it (another context's reset after a `versionchange`, an eviction without one).
+A pair the factory opens itself, and whose store has an `ALStorageHealth`, carries an
+[`ALStorageRecoveryReporter`](../storage/al-storage-recovery-reporter.ts) on its stores; the lane's
+first `work-batch` diagnostic hands it the batch's claims, and it states the store's one
+recovery outcome of this connect, with the expired rows that batch's reservation deleted,
+through that health (`recordRecovery`); an eviction is a failure of the health instead
+(`recordFailure`, cause `evicted`). No IndexedDB operation is added for it.
+
 [`writeIndexedDbAdmissionMutations`](../write-indexed-db-admission-mutations.ts)
 accepts already computed admission and QueueBox mutations. The pure QueueBox
 validator returns an `Either` before transaction entry. The joint transaction uses
```

`packages/shared/alm/inbound/README.md`:

```diff
diff --git a/packages/shared/alm/inbound/README.md b/packages/shared/alm/inbound/README.md
--- a/packages/shared/alm/inbound/README.md
+++ b/packages/shared/alm/inbound/README.md
@@ -53,7 +53,10 @@ volatile duplicate over the other carrier still meets its first admission. The W
 server's runtime has no memory pair and keeps one backend for every message.
 [`ALInboundMessageRuntime`](./al-inbound-message-runtime.ts) routes; each
 [`ALInboundStoreLane`](./lane/al-inbound-store-lane.ts) admits, retains and delivers over
-its own pair on the shared engine.
+its own pair on the shared engine. The IndexedDB pair is one store with one
+[`ALStorageRecoveryReporter`](../storage/al-storage-recovery-reporter.ts): whichever carrier's lane runs
+the first work batch reports the store's one recovery outcome of the connect through the
+store's health, and the other's first batch reports nothing.
 
 - **The durability is the sender's, carried on the envelope.** A data message goes to
   the lane [`resolveALInboundStoreDurability`](./lane/resolve-al-inbound-store-durability.ts)
```

- [ ] **Step 17: Run the conformance and black-box tests green.**

```sh
npx vitest run packages/tests/shared-test packages/tests/rallar-black-box packages/tests/shared/alm packages/tests/shared-web/al-runtime
```

Expected (measured on `285d9d1b0`'s tree, sandbox off): `Test Files  480 passed (480)`, `Tests  5287 passed (5287)`;
`alm-conformance-storage-unavailable` 17, `browser-al-storage-recovery` 1. Load-sensitive cases seen red once in the full sweep and green alone: `headless-worker-script` 'exits gracefully when SIGTERM interrupts agent registration', `outbound-delivery-settlements` '… resync-required NACK … over indexeddb', `browser-auth-session-cleanup` two logout cases (5 s timeouts).

- [ ] **Step 18: The headless budget.**

```sh
npx vitest run packages/tests/rallar-black-box-headless
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

Expected first (measured on the assembled commit): the headless agent measures 297.231 KiB against 297 (296.491 after
Task 8). Raise it to the next whole KiB, nothing more:

```diff
diff --git a/packages/tests/rallar-black-box-headless/headless-bundle-budget.json b/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
--- a/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
+++ b/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
@@ -1,3 +1,3 @@
 {
-  "brotliBudgetKiB": 297
+  "brotliBudgetKiB": 298
 }
```

Rerun: `Tests  4 passed (4)`. `browser/rallar.ts` measures 232.585 KiB under the 233 Task 8 set
(`| browser/rallar.ts | … | 232.6 KiB | < 233.0 KiB | ok |`, `Bundle budget check passed.`).

- [ ] **Step 19: Per-task checks.**

```sh
npx dprint fmt apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-fault-commands.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts packages/shared-test/rallar-bb-test/conformance/alm/scenarios/storage-unavailable.ts packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts packages/shared-test/rallar-bb-test/schema.ts packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts packages/shared/alm/al-runtime-stores.ts packages/shared/alm/inbound/README.md packages/shared/alm/inbound/al-inbound-message-runtime.ts packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts packages/shared/alm/inbound/lane/al-inbound-store-lane.ts packages/shared/alm/indexed-db-admission-backend.ts packages/shared/alm/open-indexed-db-admission-database.ts packages/shared/alm/outbound/README.md packages/shared/alm/outbound/al-outbound-message-runtime.ts packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts packages/shared/alm/storage/al-storage-event.ts packages/shared/alm/storage/al-storage-health.ts packages/shared/alm/storage/al-storage-recovery-reporter.ts packages/shared/persistence/open-indexed-db.ts packages/shared/queuebox/indexed-db-queue-box.ts packages/tests/rallar-black-box-headless/headless-bundle-budget.json packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/rallar-black-box/live-rtc-control-client.test.ts packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts packages/tests/shared-test/alm-delivery-failure-decoding.test.ts packages/tests/shared-test/alm-lifecycle-recipes.test.ts packages/tests/shared-web/al-runtime/browser-al-storage-recovery.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/alm/al-inbound-admission-preparation.test.ts packages/tests/shared/alm/al-storage-recovery.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-test/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
node scripts/check-tests-typecheck.mjs
(cd apps/api-v1 && deno task check)
(cd apps/rallar-black-box-control-server && deno task check)
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Expected (measured on `285d9d1b0`): typechecks silent; `check-tests-typecheck: 1424 test files enforced … PASS`; both Deno
checks exit 0; the snapshot and boundary files pass (no public shared-web export changes in this task); the whole
`npm run typecheck` exits 0. After committing:

```sh
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
npm run check:test-reachability
```

Expected (measured on the assembled branch, `origin/main..285d9d1b0`): `PASS: no new repository style findings`; the
coupling check `PASS: all 16 current structure-coupling candidates are individually classified` (none of them this
task's); `Test reachability: 1726 test files, 1720 reached by CI, 6 manual.`

- [ ] **Step 20: Commit.**

```sh
git add -A && git commit -F - <<'EOF'
Report each durable store's recovery and add the storage-unavailable scenario

An admission database open now says what it found: it existed, it was
created, it was reset, or this document had opened it before and it was
created again (another context's reset after a versionchange, otherwise an
eviction). A pair the factory opens, and whose store has a storage health,
carries an ALStorageRecoveryReporter; the lane's first work batch hands it its
claims, and the store's health states the one outcome of the connect
(storage-created, storage-reset, restored with the claims and the expired
rows that batch's reservation deleted, or expired-at-recovery) as a recovery
event, and an eviction as failing health. No IndexedDB operation is added;
the ledger and operation-count pins hold.

The harness's messages.send carries onStorageUnavailable to the typed
channel, and the page's observation, the control side's result value and its
decoder carry the handle's durabilityDowngrade. The storage-unavailable
scenario (two agents, every carrier, full) holds a quota fault on admission
writes: the refusing channel's send fails typed with the quota cause, the
volatile channel's send is delivered with its downgrade, and after the
release the next durable send commits and the store reads healthy.
delivery-reload waits after the reload for a restored recovery of the session
inbound store and of the store that held the original. Manifest 18 is
regenerated and its description names the scenario; the control-server
fixture models the quota and the recoveries.

The headless agent measures 297.231 KiB brotli, so its budget rises from 297
to 298 KiB; browser/rallar.ts measures 232.585 KiB under 233.

D8 reuse: LatestRepository for the document's database memory, Either for the recovery folded into the store's one ALStorageHealth, the lanes' existing work-batch diagnostic as the first-batch signal, the reservation's existing expired deletes as the count, the failure decoder's cause map for the downgrade; no new IndexedDB operation, no new timer, no second emitter per store.
EOF
```

---

### Task 10: Close: pins, gates, hosted proofs, the PR body and the plan file

Runs after tasks 1–9 are committed, reviewed and pushed. It confirms the pins did not move, runs the local merge bar,
runs one final whole-branch review with one fix wave, takes the branch through the Branch Release Gate, the hosted
ALM manifests and the ALM observation (where the new `storage-unavailable` scenario is read cell by cell), publishes
the PR title and body, and deletes this plan file in its last commit. It never merges and never takes the PR out of
draft on its own.

**Files**

- Modify: `playground/alm/alm-qos-product-plan.md` §8 (one line per delivered I2a-i bullet reading "delivered
  (I2a-i, <H1>)"), `packages/shared-web/bundle-budgets.json` and
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` only if a budget is crossed.
- Modify (fix wave only): the files the final review's Critical and Important findings name.
- Delete (last commit): `plans/active/alm-i2a-i-storage-truth-implementation-plan.md`.
- Create (never committed): `tmp/i2a-i-task10/**` (logs, artifacts, `pr-body.md`, `hosted.md`).
- Test: the local merge bar (steps 3–7); no new test file.

**Interfaces**

- Consumes: tasks 1–9 pushed; the ledger and cold pins at their P1b figures (chain 6, total 8, 37 requests,
  `al-admission` 10, `al-work` 5; cold 10 + 9; inbound 9/11, 11/13, 5/7); the `storage-unavailable` scenario (Task 9)
  in the `two-agent` family with the `full` tag.
- Produces: code head `H1` (reviewed and gated), final head `H2` (H1 plus the last commit), the PR title and body.

Throughout: `WT=/Users/knuthelge/ProjectLocker/github/ar-eye-hunter/.claude/worktrees/alm-i2a`,
`R=intact-software-systems/ar-eye-hunter`, `B=claude/alm-i2a-storage-lifetime`, `T=$WT/tmp/i2a-i-task10`. Every
`gh`, `git fetch`, `git push`, `docker` command, every lane, Playwright run and black-box runner, and `npm run test:unit`
need the sandbox disabled. Use `gh run list`, `gh run view` and
`gh api repos/$R/actions/runs?head_sha=<full sha>`, never `gh pr checks`. Any red is diagnosed from its downloaded
artifacts, copied to `$T` BEFORE any rerun, never from a theory; a product fix needs a counter-case test.

**Lane rule.** One lane at a time on this machine: the ALM lane, `test:e2e`, `test:full-stack:memory` and the
black-box runners share ports 18080–18082, 5177, 5178 and 5180, and Playwright attaches to whatever already listens
there. Before every lane:

```sh
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(18080|18081|18082|5177|5178|5180) ' ; ps aux | grep -E 'black-box-run.mts|playwright test' | grep -v grep
```

Expected: no output. Nothing in the worktree is edited while a lane runs. A lane's verdict is its summary line,
never its exit code.

- [ ] **Step 1: Preconditions**

```sh
mkdir -p $T
git -C $WT status --short
git -C $WT fetch origin
git -C $WT rev-parse HEAD origin/$B
git -C $WT log --oneline HEAD..origin/main | wc -l
gh variable list -R $R | grep -c RALLAR_BLACK_BOX_ALM_SCOPE
gh pr view 629 -R $R --json mergeable,mergeStateStatus --jq '[.mergeable, .mergeStateStatus] | @tsv'
```

Expected: no status output; the two hashes equal; `0` variables; `MERGEABLE`. If main moved (the `wc -l` is not
`0`) or the PR reads `CONFLICTING`, merge main first: `git -C $WT merge --no-ff origin/main -m "Merge origin/main
into $B"`, resolve keeping both sides' behaviour and tests, `npm ci` if `package-lock.json` changed, then
`npm run typecheck 2>&1 | tail -3` and `node scripts/check-test-reachability.mjs` before step 2.

- [ ] **Step 2: Pins and bundle figures**

```sh
cd $WT && npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts 2>&1 | grep -E "✓|✗|Tests  "
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles | grep -E "browser/rallar(-core|-realtime|-data|-crdt)?\.ts "
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts 2>&1 | grep -E "KiB|Tests  "
```

Expected: the three pin files pass with the P1b figures (the storage snapshot per message state unchanged) (chain `6`, total `8`, `al-admission` `10`, `al-work` `5`; cold
`10` + `9`; inbound unchanged): I2a-i adds no IndexedDB operation to a send (the interceptor seam returns no
decision in production, the availability value is decided per connect, `persist()` is no IndexedDB operation).
Record the bundle lines and the headless figure in `$T/figures.md`. The assembled branch measured
`browser/rallar.ts` 232.585 KiB against 233 and the headless agent 297.231 KiB against 298 (the raises landed in
Tasks 1, 3, 4, 8 and 9, each in the commit that crossed). If `browser/rallar.ts` or the headless bundle exceeds its
budget, set the budget to the next whole KiB above the measured figure in the data file (never higher),
and commit `Raise the <entry> bundle budget to <N> KiB (measured <x.xx> KiB at <sha>)`; the figure and the reason go
into the PR body.

- [ ] **Step 3: Local merge bar, static checks**

```sh
cd $WT
npm run typecheck 2>&1 | tail -3
npm run build 2>&1 | tail -15
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
npm run check:test-reachability
(cd apps/api-v1 && deno task check) && (cd apps/rallar-black-box-control-server && deno task check) && (cd apps/relic-hunter-server-v1 && deno task check)
npx dprint check $(git diff --name-only origin/main HEAD | tr '\n' ' ')
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts 2>&1 | grep -E "Tests  "
```

Expected: `check-tests-typecheck: N test files enforced, 0 files carrying known debt (0 errors)`; build exits 0 with
no `error` line; `PASS: no new repository style findings`; the coupling check prints `PASS:`;
`check:test-reachability` exits 0; the three Deno checks exit 0; dprint check exits 0; the two public-surface tests
pass (the `storage` port rename and the storage types are in the snapshot Task 2 updated, the policy type in Task 4's).

- [ ] **Step 4: Local merge bar, `test:ci`**

Sandbox disabled, lane rule applies:

```sh
cd $WT && npm run test:ci 2>&1 | tee $T/test-ci.log | grep -E "Test Files|Tests  |ok \||passed|failed|flaky"
```

Expected, in order: Vitest `Test Files  N passed | K skipped (N)` and `Tests  N passed | K skipped (N)` with 0
failed; four Deno blocks each `ok | N passed | 0 failed`; Playwright `test:rallar` and the recipe console `N passed`;
the in-memory full stack `N passed`. Known intermittent reds that pass alone: `repo-style-changed-check.test.ts` and
`state-write-malformed-evidence.test.ts` (timeouts under load), the memory-QueueBox work-page test,
`headless-worker-script.test.ts` and `full-stack-quick-test-ws`. Rerun such a file alone, record both results, then
rerun `npm run test:ci`; a red that repeats alone is a defect.

- [ ] **Step 5: Local merge bar, Postgres integration and API black-box on Postgres**

```sh
docker ps --filter name=ar-eye-hunter-postgres --format '{{.Status}}'
cd $WT && npm run test:postgres:integration 2>&1 | tee $T/pg-integration.log | grep -E "Test Files|Tests  |✗|FAIL"
npm run test:api-v1:black-box:memory 2>&1 | tee $T/bb-memory.log | grep "Matrix profile\|FAILED"
npm run test:api-v1:black-box:postgres 2>&1 | tee $T/bb-postgres.log | grep "Matrix profile\|FAILED"
npm run test:api-v1:black-box:postgres:medium-scale 2>&1 | tee $T/bb-medium.log | grep "Matrix profile\|FAILED"
```

Expected: the container `Up ...` (if stopped: `docker start ar-eye-hunter-postgres`; never `db:test:up`, never
`db:down`); the Postgres integration suite green except the two known local-only reds
(`rtc-topology-replay-consumer`, `topology-app-outbox-concurrency`), which are reported, not fixed; every
`Matrix profile <name>: passed=N failed=0 skipped=K` line with `failed=0`, both `Matrix profile` lines of the Postgres
run (standard and cluster) included. The dedup retention change (Task 7) is server-shared, so the cluster profile and
the medium-scale gate ARE required; the medium-scale gate's constants, operation matrix and assertions are unchanged.

- [ ] **Step 6: Local merge bar, the full ALM lane**

```sh
cd $WT && rm -rf apps/rallar-black-box/test-results
RALLAR_BLACK_BOX_ALM_SCOPE=full npm run -s test:rallar:full-stack:memory:alm 2>&1 | tee $T/alm-full.log | grep -E "family over|passed|failed|flaky|skipped"
for F in apps/rallar-black-box/test-results/alm-observation/*-full*.json; do case $F in *-snapshot.json|*-page-diagnostics.json) ;; *) printf '%s ' $F; jq -r '.cellOutcome + " " + .regime' $F;; esac; done
grep -h -o '"recipeId":"alm-[a-z-]*storage-unavailable[a-z-]*"[^}]*"outcome":"[a-z-]*"' apps/rallar-black-box/test-results/alm-observation/*-full.json | sort | uniq -c
```

Expected: every `baseline`, `addressed` and `three-agent` family over `ws`, `rtc` and `rtc-with-ws-fallback` in
`(full)` passes; `storage-unavailable` appears in the baseline family over every carrier with outcome `completed`;
`delivery-reload` reads one `recovery` event per durable store; the summary shows `N passed` and no `failed` or
`flaky`; every cell file reads `passed`. Harness budgets unchanged (`git diff origin/main --
packages/shared-test/rallar-bb-test/conformance` touches no timeout constant).

- [ ] **Step 7: Final whole-branch review, three seats, and one fix wave**

Per the subagent-driven-development skill's final review: dispatch the reviewer on the most capable model with the
whole-branch diff (`git diff origin/main...HEAD`, packaged to a file), the spec (`playground/alm/alm-i2a-design-proposal.md`
§2.2, §3.a–3.e, 3.h–3.j, §5) and the Global Constraints, in three seats: product (no guarantee weakens; the typed
outcome and the downgrade are truthful; a lane whose storage cannot open probes nothing and the volatile lane keeps working; the per-scope database and the purge leave no row of a previous session;
dedup retention covers the deadline on both sides), harness (the fault port is harness-only and adds no operation;
the scenario asserts what it claims), and code quality (repo style, sizes, names, READMEs true, the public snapshot).
ONE fix dispatch for every Critical and Important finding, one scoped re-review, residual minors adjudicated in the
ledger. Each fix is a TDD commit. Then repeat steps 2, 3 and the focused tests the fixes touched; steps 4–6 are
repeated only if a fix touched product code.

- [ ] **Step 8: Push the code head and read the gate**

```sh
cd $WT && git push origin HEAD:$B && git rev-parse HEAD > $T/H1
gh api "repos/$R/actions/runs?head_sha=$(cat $T/H1)&per_page=20" --jq '.workflow_runs[] | "\(.id) \(.name) \(.status) \(.conclusion)"'
```

Poll `gh run view <RUN> -R $R --json status,conclusion` every few minutes (foreground `gh`, sandbox disabled).
Expected: `Branch Release Gate`, `API v1 Formation Gate` and `API v1 Medium-Scale Gate` `success` on H1. Read every
failed job from its log and artifacts (`gh run view <RUN> --log-failed`, `gh run download`), copied to `$T` before
any rerun; known intermittent recipes (`api-v1-debounced-replanning`, `api-v1-group-presence-lease-lifecycle`,
`api-v1-websocket-addressed-sends`' 2 s deadline race) rerun with `gh run rerun <RUN> --failed` after the copy; any
other red is a fix as a TDD commit with a counter-case, pushed, and the gate is read again on the new head.

- [ ] **Step 9: Hosted manifests 18 and 22 from the branch**

```sh
for M in 18-alm-conformance-2-agent 22-alm-conformance-3-agent; do
  gh workflow run hetzner-distributed-recipe.yml -R $R --ref $B -f ref=$B -f register_before_login=true \
    -f manifest_path=apps/rallar-black-box/manifests/hetzner/$M.json
  echo "dispatched $M"
  gh run list -R $R --workflow "Run Hetzner Distributed Recipe" --branch $B --limit 1 --json databaseId,createdAt
done
```

After each dispatch, repeat the `gh run list` until a newer run appears, record `manifest -> run id` in
`$T/hosted.md`, and read each finished run:

```sh
gh run view <RUN> -R $R --json conclusion,createdAt,updatedAt --jq '[.conclusion, .createdAt, .updatedAt] | @tsv'
gh run download <RUN> -R $R -D $T/hosted-<RUN>
find $T/hosted-<RUN> -name fleet-report-summary.md -o -name failures.json | head
```

Expected: both runs `success`, each taking minutes (a green run of about 40 s ran nothing: read its log before
counting it). A red is diagnosed from `failures.json` and `fleet-report-summary.md`, fixed on the branch with a TDD
commit, and re-dispatched from the branch; main is never the test bed.

- [ ] **Step 10: ALM observation, smoke on three consecutive runs and at most two full reads**

The gate on H1 started the ALM conformance observation job beside it (smoke). Add two smoke re-runs of that job with
no push in between, then at most two full reads. Copy each run's `alm-conformance-lane-*` artifact to `$T` before any
rerun and record outcome and regime per cell.

```sh
gh variable list -R $R | grep -c RALLAR_BLACK_BOX_ALM_SCOPE
gh run view <GATE_RUN> -R $R --json jobs --jq '.jobs[] | select(.name | test("ALM conformance observation")) | "\(.databaseId) \(.status) \(.conclusion)"'
gh run rerun <GATE_RUN> -R $R --job <OBS_JOB>
gh run view <GATE_RUN> -R $R --log --job <OBS_JOB> 2>/dev/null | grep -oE "ALM observation [a-z-]+: regime=[a-z]+ .*" | tail -6
```

Expected: `0` variables; three attempts each `success`, each log showing every `(smoke)` family `passed`. Then, for
each full read (the second only if the first ran fewer cells than the lane has, or a fix went in after it):

```sh
gh variable set RALLAR_BLACK_BOX_ALM_SCOPE -R $R --body full
gh run rerun <GATE_RUN> -R $R --job <OBS_JOB>
gh run view <GATE_RUN> -R $R --json status,conclusion
```

Poll until `completed` (at most 30 minutes), then at once:

```sh
gh variable delete RALLAR_BLACK_BOX_ALM_SCOPE -R $R
gh variable list -R $R | grep -c RALLAR_BLACK_BOX_ALM_SCOPE
gh run download <GATE_RUN> -R $R -n <alm-conformance-lane artifact> -D $T/alm-full-read-<k>
```

Expected: the delete succeeds and the count is `0` (if the session may end before the job completes, write in
`$T/hosted.md`: "delete RALLAR_BLACK_BOX_ALM_SCOPE once run <id> completes"). Acceptance, cell by cell, against
P1b's accepted read: every `ws` cell passed; `addressed` and `three-agent` over `rtc` passed; `baseline` over `rtc`
passed or failed only at `not-yet-in-sync-delivered-after-refresh` `received-1`; `rtc-with-ws-fallback` cells any
outcome, recorded (the 30-minute job timeout cuts them); the `storage-unavailable` scenario's outcome is recorded per
carrier and regime, and a red in it is diagnosed from the artifact before a second read (its hosted regime may be
slow; a quota fault's typed outcome does not depend on the regime, so a red there is not noise). Any WS red, or an
RTC red at another step, is not accepted: download the artifact and diagnose before a second read.

- [ ] **Step 11: The last commit: the delivered lines and the plan file**

In `playground/alm/alm-qos-product-plan.md` §8, each bullet I2a-i delivers (no silent fallback, persistent storage,
typed recovery outcomes, the health vocabulary, scope and privacy, dedup retention) gains "delivered (I2a-i, <H1>)";
the "One durable owner" bullet stays open for I2a-ii. Then delete this plan file:

```sh
cd $WT && git rm plans/active/alm-i2a-i-storage-truth-implementation-plan.md
npx dprint fmt playground/alm/alm-qos-product-plan.md
git add playground/alm/alm-qos-product-plan.md
git commit -m "Record I2a-i as delivered and close its plan"
git push origin HEAD:$B && git rev-parse HEAD > $T/H2
```

Expected: the commit contains only the two paths; the Branch Release Gate runs again on H2 and is read as in step 8
(docs-only, so the earlier hosted and observation reads on H1 stand; the PR body names both heads).

- [ ] **Step 12: The PR title and body**

Title: `ALM Release 4, I2a-i: storage truth (D119–D128)`. Body sections in this order: Goal; Changes (one bullet per
task); Public surface (the `storage` port replacing `onStorageReset` on `RallarDiagnosticsPortsInput`, the
`storage-unavailable` verdict and failure arms, `onStorageUnavailable` on the channel definition,
`durabilityDowngrade` on the evidence, the `rallar-al-runtime:` database name, `fault.inject` `carrier: 'storage'`,
and what changed in the shared-web public API snapshot); Acceptance (the pins unchanged with their figures; the
bundle figures and every budget raise with its task and measured figure: headless 294 → 295 (Task 1, 294.028),
295 → 296 (Task 4, 295.075), 296 → 297 (Task 8, 296.491), 297 → 298 (Task 9, 297.231); `rallar.ts` 231 → 232
(Task 3, 231.032), 232 → 233 (Task 8, 232.010), each re-measured on the real commits; the ALM lane full read cell by cell with the `storage-unavailable` outcomes per
carrier; manifests 18 and 22, run ids); Validation (steps 3–6 and 8–10 with counts and run ids, measured on H1; the
H2 gate; every red named with its classification and evidence, never softened); Rulings (every `R-I2a-i-N` of this
plan and every `Ruling:` line from the SDD ledger, with what it costs if wrong); Limits (what the evidence cannot show:
no hosted takeover yet, I2a-ii; the legacy database left to eviction; deadlines beyond the message-owner TTL not
covered by dedup; `storage-created` indistinguishable from eviction at first open; the fault port faults operations,
not the browser's own quota); a control replayed inside the `admit-control` claim after a storage failure is not handed over a
second time, because the inbound admission is already committed, and the receipt timeout and re-ACK heal it, pre-existing (R-I2a-i-66); Risk and rollback (revert the merge commit; the per-scope database name means a revert
reopens the legacy name and leaves the new databases to eviction; no schema id change); Follow-up (I2a-ii: the
durable owner, the cross-tab wake and relay, `durable-takeover`, Relic to `local-outbox`; the masked `boundary.unknown`
at `admitIncomingMessage(value: unknown)` (R-I2a-i-24); the style walker's apostrophe misread in type-literal doc
comments (R-I2a-i-63); the parked minors), and the
attribution line. Publish with `gh pr edit 629 -R $R --title "..." --body-file $T/pr-body.md`. Leave the PR in draft;
the maintainer reviews and merges. Then write `Task 10: complete` and `PLAN COMPLETE <date>: PR #629 at <H2>` in the
ledger.

- [ ] **Step 13: After the maintainer merges**

Watch main's `Push on main`, `Deploy Web + API` and `Run Hetzner Supported Distributed Manifests` on the merge commit
(`gh api repos/$R/actions/runs?head_sha=<merge sha>`), report them, and record I2a-i as delivered in memory. I2a-ii's
plan is written next on a new branch from main.

---

## Self-review

Run by the assembler against the writing-plans checklist, on the assembled scratch branch `scratch/i2a-assemble`
(head `285d9d1b0`; one commit per task, listed under Global Constraints).

**Composition evidence.** Every task commit typechecks on its own (`tsc` for `packages/shared` and
`packages/shared-test`, the shared-web and shared-server typechecks, `check-tests-typecheck`); the tip passes
`npm run typecheck` (exit 0), both Deno checks, the control server's `deno task test` (192 passed), the manifests'
`--check` (67), `check:repo-style:changed` and the coupling check against `origin/main` (PASS), and
`check:test-reachability` (1726 / 1720 / 6). Each task's named focused runs pass on its own commit (counts in the
steps); the wide run `packages/tests/shared packages/tests/shared-web packages/tests/shared-test
packages/tests/rallar-black-box packages/tests/shared-server/al-runtime` measured `1256 passed | 4 skipped` files and
`11783 passed | 12 skipped` tests on the tip before the last three fixes (the R-I2a-i-25 encoding, the Deno literal,
two README links), and W-E's Step 17 sweep `480 / 5287` after them. The ledger and operation-count pins pass
unedited on every commit. Not run here: `test:ci`, the Postgres integration and black-box gates, the ALM lane and the
hosted manifests (Task 10's).

**Bundle figures on the assembled commits** (brotli q11, the gates' method; budget after the commit):

| After            | `browser/rallar.ts` | budget | headless agent | budget |
| ---------------- | ------------------: | -----: | -------------: | -----: |
| base `7e6f0a117` |             230.106 |    231 |        293.694 |    294 |
| Task 1           |             230.370 |    231 |        294.028 |    295 |
| Task 2           |             230.533 |    231 |        294.231 |    295 |
| Task 3           |             231.032 |    232 |        294.560 |    295 |
| Task 4           |             231.239 |    232 |        295.075 |    296 |
| Task 5           |             231.677 |    232 |        295.495 |    296 |
| Task 6           |             231.863 |    232 |        295.511 |    296 |
| Task 7           |             231.925 |    232 |        295.597 |    296 |
| Task 8           |             232.010 |    233 |        296.491 |    297 |
| Task 9           |             232.585 |    233 |        297.231 |    298 |

### (a) Spec coverage

| Requirement                                                                                                                                           | Task, step                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| §3.a the value and its seven causes; the classifier beside the opener                                                                                 | Task 1 Steps 1–4 (in `alm/storage/`, R-I2a-i-9; `Error` parameter, R-I2a-i-10)                           |
| §3.a backends keep their I/O shape; the lanes' boundary classifies; `ready()` as `Either`                                                             | Task 3 Steps 5–8 (`'ready'` right, R-I2a-i-11; enqueue only, R-I2a-i-14)                                 |
| §3.a the verdict arm and the failure arm, read as `failed`                                                                                            | Task 3 Steps 3–4                                                                                         |
| §3.a the setting, its validator issue, the required policy field                                                                                      | Task 4 Steps 1–4                                                                                         |
| §3.a the decision in the dispatch: `refuse` typed, `volatile` once with `durabilityDowngrade`                                                         | Task 4 Steps 5–6                                                                                         |
| §3.a availability per connect, no memory backends, skip while missing, re-decided by the next admission                                               | Task 5 Steps 3–5 (skip only while `missing`, R-I2a-i-38; no probe open, R-I2a-i-43)                      |
| §3.a work batches emit `health` instead of `console.error`                                                                                            | Task 3 Step 7                                                                                            |
| §3.a persistence on the first durable admission, not awaited                                                                                          | Task 5 Steps 3, 5 (`persisted()` first, once per connect, R-I2a-i-42)                                    |
| §3.a evidence: a test per cause; one per `onStorageUnavailable` value; the lane                                                                       | Task 1 Step 1; Task 8 Step 2 (quota and fail through the real owners); Task 4 Step 1; Task 9 Steps 10–12 |
| §3.b `storage` replaces `onStorageReset`; four arms naming `storeId`                                                                                  | Task 2 Steps 4, 7–9                                                                                      |
| §3.b health on transitions in an `ObservableLatestValue` per store                                                                                    | Task 2 Step 5; key order pinned, Task 2 Step 1 (R-I2a-i-58)                                              |
| §3.b the `alm/` factory input `onStorageReset` stays, adapted into `reset`                                                                            | Task 2 Step 8 (`toALStorageResetSink`)                                                                   |
| §3.b harness: `storage_reset` unchanged, new `rallar.browser.alm.storage`                                                                             | Task 2 Step 11 (R-I2a-i-19)                                                                              |
| §3.b the public snapshot and the five sites                                                                                                           | Task 2 Steps 7–10                                                                                        |
| §3.b evidence: a test per kind on the sink                                                                                                            | reset and health Task 2 Step 1; persist Task 5 Step 1; recovery Task 9 Step 1                            |
| §3.c one database per scope from the connect's scope, keys session-scoped, no schema bump, legacy left                                                | Task 6 Steps 1, 3–4, 6 (encoded parts, R-I2a-i-25)                                                       |
| §3.c evidence: two scopes see disjoint rows                                                                                                           | Task 6 Step 1                                                                                            |
| §3.d purge on login over a session and the session switch, after the disconnect; failure emits `health`                                               | Task 6 Step 7 (R-I2a-i-27, -28, -32)                                                                     |
| §3.d evidence: no rows of the previous session left                                                                                                   | Task 6 Step 1 (session cleanup cases)                                                                    |
| §3.e the capped dedup expiry for identity algorithms; the window as floor; no deadline keeps the window                                               | Task 7 Steps 1, 5 (R-I2a-i-1, -3)                                                                        |
| §3.e evidence: replay after 60 s inside 120 s on memory and IndexedDB; `semantic-key` keeps its window; server gates                                  | Task 7 Steps 2–3 (and PostgreSQL on PGlite, R-I2a-i-4), Steps 12–13; Task 10 Step 5                      |
| §3.h one outcome per durable store per connect; created, reset (wins), other-context, evicted                                                         | Task 9 Steps 3–4                                                                                         |
| §3.h restored and expired-at-recovery from the bootstrap batch; no new IndexedDB operation                                                            | Task 9 Steps 5–7                                                                                         |
| §3.h evidence: a test per outcome; `delivery-reload` reads it                                                                                         | Task 9 Steps 1, 13                                                                                       |
| §3.i the interceptor, no production microtask; the fault port; `carrier: 'storage'`                                                                   | Task 8 Steps 4–9 (R-I2a-i-52, -53, -54)                                                                  |
| §3.j `storage-unavailable`; `delivery-reload` reading recovery; hosted manifests                                                                      | Task 9 Steps 10–15; Task 10 Steps 6, 9                                                                   |
| §5 I2a-i unit rows                                                                                                                                    | the rows above                                                                                           |
| §5 pins, bundle figures, API snapshot and bundle boundaries, cluster profile and medium-scale, lane reads, hosted 18/22, D8 inspection in the PR body | every task's checks; Task 10 Steps 2–6, 9–10, 12                                                         |

Gaps and deviations, each a ruling or a carry:

- §3.c says the purge without `indexedDB.databases()` covers "the current and the default scope"; the plan covers the
  current scope only (R-I2a-i-26).
- §3.h's "exactly one outcome per durable store per connect" holds for every store that runs a work batch; a store
  whose work never starts (storage missing) reports its unavailability instead, and an outbound store with no work on
  its carrier reports nothing (R-I2a-i-55).
- §3.d's "when the session key differs" is read as the session id (R-I2a-i-27).
- §3.a's signatures `toALStorageUnavailable(error: unknown)` and `Either<ALStorageUnavailable, void>` become `Error`
  and `'ready'` (R-I2a-i-10, -11); D127's "session's first durable admission" becomes once per connect after a
  `persisted()` read (R-I2a-i-42).
- §5's "the storage snapshot per message state" is the roadmap's standard storage-snapshot workload,
  `packages/tests/shared/alm/al-storage-snapshot.test.ts`; Task 10 Step 2 runs it with the other pins and the PR body
  reports it unchanged (controller's placement).
- The lane itself runs only in Task 10; Task 9 proves the scenario through the conformance unit tests and the Deno
  fixture (the frame's rule for writers).

### (b) Placeholder scan

`grep -nE 'TBD|TODO|similar to Task|add validation|<every|exact JSON is in|task-[0-9a]+\.patch'` over the plan finds
this line only. Every step that writes code
shows the code or the diff; the two registry steps (Tasks 4 and 5) carry their JSON; Task 8's and Task 9's format
steps list their files explicitly; Tasks 2 and 3 format the files `git diff --name-only HEAD` lists (touched files,
never a glob).

### (c) Type consistency (each cross-task name, its defining task, its later users)

| Name                                                                                                                                                                                                                                                                                          | Defined                                          | Used by                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `ALStorageUnavailable`, `ALStorageUnavailableCause`, `ALStorageUnavailableError`, `toALStorageUnavailable(error: Error)`                                                                                                                                                                      | Task 1 (`alm/storage/al-storage-unavailable.ts`) | Tasks 2, 3, 4 (`ALStorageUnavailable['cause']`), 5, 6, 9                              |
| `ALStorageResetBlockedError` (now a subclass)                                                                                                                                                                                                                                                 | Task 1                                           | unchanged callers                                                                     |
| `ALStorageEvent`, `ALStorageEventSink`, `ALStorageHealthState`, `ALStorageRecoveryOutcome`, `ALStoragePersistOutcome`, `toALStorageResetSink`, `createPassThroughALStorageEventSink`                                                                                                          | Task 2 (`alm/storage/al-storage-event.ts`)       | Tasks 3, 5, 6, 9 (Task 9 widens `storage-reset`'s `reason` with `'other-context'`)    |
| `ALStorageHealth` (`recordFailure`, `recordRecoveryPoint`; `recordRecovery`)                                                                                                                                                                                                                  | Task 2; `recordRecovery` Task 9                  | Tasks 3, 9                                                                            |
| `RallarDiagnosticsPorts.storage` / `RallarDiagnosticsPortsInput.storage`                                                                                                                                                                                                                      | Task 2                                           | Tasks 5, 6, 8 (harness composition), 9                                                |
| `storageHealth` on the store pairs and the factory inputs; `Resources.storageHealth`                                                                                                                                                                                                          | Task 2; `Resources` Task 3                       | Tasks 3, 9 (the reporter is built from it)                                            |
| `ALStorageReadiness` (`Outcome`, `ready`, `readOpenedStore`, `runStoreOperation`)                                                                                                                                                                                                             | Task 3                                           | Task 5 (relies on the idle gate)                                                      |
| verdict arm `storage-unavailable`, failure arm `storage-unavailable`                                                                                                                                                                                                                          | Task 3                                           | Tasks 4, 5, 9                                                                         |
| `RallarStorageUnavailablePolicy`, `onStorageUnavailable`, `resolveBrowserStorageUnavailablePolicy`, `ALDeliveryDurabilityDowngrade`, `durability-downgrade` settlement, `ALDeliveryEvidence.durabilityDowngrade`                                                                              | Task 4                                           | Tasks 5, 9 (harness projections, R-I2a-i-51)                                          |
| `ALStorageAvailability`, `BrowserALStorageAvailability`, `BrowserStoragePersistRequest`, `toInitialALStorageAvailability`, `computeALStorageAvailability`, `toBrowserStoragePersistRequest`, `RallarBrowserMiddleware.storageAvailability`                                                    | Task 5                                           | Task 6 (`configureBrowserALRuntimeStores` keeps the return)                           |
| `toBrowserALRuntimeDbName`, `BROWSER_AL_RUNTIME_DB_NAME_PREFIX`, `toBrowserSessionALRuntimeStoreIds`, `ConfigureBrowserALRuntimeStoresInput.scope`, `currentScope`, `dbNames`, `deleteEndedSessionALRuntimeEntries`                                                                           | Task 6                                           | Task 9 (the browser recovery test names its database with `toBrowserALRuntimeDbName`) |
| `computeALInboundDedupExpiryMs`, `ComputeALInboundDedupExpiryInput`                                                                                                                                                                                                                           | Task 7                                           | —                                                                                     |
| `IndexedDbOperationObserver.observe(): Promise<void> \| void`, `ScriptedStorageFault`, `ScriptedStorageFaultPort`, `createScriptedStorageFaultPort`, `RallarBlackBoxTestStorageFaultInjectCommand`                                                                                            | Task 8                                           | Task 9 (`toAdmissionQuotaFaultCommand`)                                               |
| `OpenedIndexedDb.created`, `ALStorageOpening`, `openIndexedDbAdmissionStorage`, `ALStorageRecoveryReporter`, `createALStorageRecoveryReporter`, `storageRecovery`, `getStorageOpening`, `getReservationExpiredDeleteCount`, `decodeAlmDurabilityDowngrade`, `RELOAD_RECOVERED_STORE_PREFIXES` | Task 9                                           | —                                                                                     |

The names W-B and W-E coded against stubs were rewritten to these (R-I2a-i-49): the stub modules
`packages/shared/alm/al-storage-{event,unavailable}.ts` became `packages/shared/alm/storage/…`; W-E's
`onStorageRecovery` factory input and `toALStorageRecoveryEvent` browser mapping are gone (the reporter takes the
pair's `storageHealth`); W-B's lane stub is replaced by Task 3's real readiness. Every commit typechecks, which is
the mechanical check of this table.

### (d) Files touched by two or more tasks, in the order their edits land

| File                                                                                                                                                                                                                                                                                                                                                                                                | Tasks, in order   | What each adds                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts` (`configureBrowserALRuntimeStores`)                                                                                                                                                                                                                                                                                           | 2 → 5 → 6         | 2: `toBrowserStoreOptions` (health and named reset per store), the `storage` port into the scopes; 5: always IndexedDB, returns `BrowserALStorageAvailability`; 6: `scope` input, `dbName` from `toBrowserALRuntimeDbName`. Task 9 does not touch it. |
| `packages/shared-web/browser/connection/initialise-browser-middleware.ts`                                                                                                                                                                                                                                                                                                                           | 2 → 5 → 6         | 2: the eviction loop takes `storage`; 5: the availability on the middleware; 6: the resolved scope to the stores and the loop                                                                                                                         |
| `packages/shared-web/browser/connection/rallar-diagnostics-ports.ts`                                                                                                                                                                                                                                                                                                                                | 2                 | the `storage` port (one task)                                                                                                                                                                                                                         |
| `packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts`                                                                                                                                                                                                                                                                                                                              | 2 → 6             | 2: `storage` options, the cleanup's reset names its database; 6: every scope database, `dbNames`, `currentScope`                                                                                                                                      |
| `packages/shared-web/browser/session/session-auth-lifecycle.ts`                                                                                                                                                                                                                                                                                                                                     | 2 → 6             | 2: passes `storage`; 6: the purges and the reporter module                                                                                                                                                                                            |
| `packages/shared/alm/delivery/al-delivery-lifecycle.ts`                                                                                                                                                                                                                                                                                                                                             | 3 → 4             | 3: the verdict arm (imports `ALStorageUnavailable`); 4: `ALDurabilityAlgo`, the downgrade settlement and evidence                                                                                                                                     |
| `packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts`                                                                                                                                                                                                                                                                                                                                     | 3 → 4             | 3: `storage-unavailable` → `failed`; 4: the downgrade reducer                                                                                                                                                                                         |
| `packages/shared/alm/open-indexed-db-admission-database.ts`                                                                                                                                                                                                                                                                                                                                         | 1 → 9             | 1: `missing`, `open-failed`, the reset-blocked subclass; 9: `ALStorageOpening`, `openIndexedDbAdmissionStorage`, the document memory (the `missing` check moves to its head)                                                                          |
| `packages/shared/alm/al-runtime-stores.ts`                                                                                                                                                                                                                                                                                                                                                          | 2 → 9             | 2: `storageHealth` input and on the pairs; 9: the reporter from the health, the factory restructure                                                                                                                                                   |
| `packages/shared/alm/{in,out}bound/al-*-message-runtime.ts`                                                                                                                                                                                                                                                                                                                                         | 2 → 3 → 9         | 2: `storageHealth` on the stores; 3: on `Resources`, `ready()` answers `Either`; 9: `storageRecovery`                                                                                                                                                 |
| `packages/shared/alm/{in,out}bound/lane/al-*-store-lane.ts`, `create-default-al-*-message-runtime.ts`                                                                                                                                                                                                                                                                                               | 3 → 9             | 3: readiness, health, the idle gate; 9: the first-batch report                                                                                                                                                                                        |
| `packages/shared/alm/storage/al-storage-event.ts`, `al-storage-health.ts`                                                                                                                                                                                                                                                                                                                           | 2 → 9             | 9: `'other-context'`, `recordRecovery`                                                                                                                                                                                                                |
| `packages/shared/alm/indexed-db-admission-backend.ts`, `packages/shared/queuebox/indexed-db-queue-box.ts`                                                                                                                                                                                                                                                                                           | 8 → 9             | 8: the awaited observe decision; 9: the opening record, the expired count                                                                                                                                                                             |
| `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts`                                                                                                                                                                                                                                                                                                                           | 4 → 5             | 4: the decision; 5: the skip while missing and the verdict record                                                                                                                                                                                     |
| `packages/shared-web/browser/rallar.ts`, `rallar-core.ts`; the public API snapshot test                                                                                                                                                                                                                                                                                                             | 2 → 4             | 2: the four storage types; 4: `RallarStorageUnavailablePolicy` (also `rallar-messages.ts`)                                                                                                                                                            |
| `packages/shared-web/bundle-budgets.json`                                                                                                                                                                                                                                                                                                                                                           | 3 → 8             | 231 → 232 → 233                                                                                                                                                                                                                                       |
| `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`                                                                                                                                                                                                                                                                                                                              | 1 → 4 → 8 → 9     | 294 → 295 → 296 → 297 → 298                                                                                                                                                                                                                           |
| `docs/test-structure-coupling-exceptions.md` (the coupling registry)                                                                                                                                                                                                                                                                                                                                | 4 → 5             | 4: four contracts, six entries; 5: seven contracts, nine entries                                                                                                                                                                                      |
| `docs/rallar-api-reference.md`                                                                                                                                                                                                                                                                                                                                                                      | 4 → 5             | 4: the storage paragraph; 5: availability and persistence                                                                                                                                                                                             |
| `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`                                                                                                                                                                                                                                                                                                                           | 2 → 3 → 5 → 6 → 9 | 2: § Storage Diagnostics; 3: the health paragraph's failure sites; 5: `persist`; 6: the reset's per-scope `dbName`; 9: `recovery`                                                                                                                     |
| `packages/shared/alm/outbound/README.md`                                                                                                                                                                                                                                                                                                                                                            | 2 → 3 → 9         | reset arm; read and failure boundaries; the opening and the reporter                                                                                                                                                                                  |
| `packages/shared/alm/inbound/README.md`                                                                                                                                                                                                                                                                                                                                                             | 3 → 6 → 7 → 9     | failure; per-scope cleanup; dedup retention; the shared reporter                                                                                                                                                                                      |
| `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`, `decode-alm-runtime-result.ts`; `alm-delivery-failure-decoding.test.ts`                                                                                                                                                                                                                                                   | 3 → 9             | 3: the failure arm; 9: `durabilityDowngrade`                                                                                                                                                                                                          |
| `packages/shared-test/rallar-bb-test/schema.ts`, `schema/rallar-black-box-command-fields.ts`, `rallar-black-box-test-contracts.ts`, `alm/validate-alm-control-command.ts`, `alm/rallar-black-box-alm-command-capabilities.ts`, `conformance/alm/assess-alm-reload-identity.ts`, `alm-conformance-recipes.test.ts`, `apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts` | 8 → 9             | 8: `carrier: 'storage'`; 9: `onStorageUnavailable`, the scenario, the reload's recovery waits                                                                                                                                                         |
| `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`                                                                                                                                                                                                                                                                                                                               | 3 → 8             | 3: the failure arm; 8: the storage fault                                                                                                                                                                                                              |
| `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts`                                                                                                                                                                                                                                                                                              | 2 → 8             | 2: the two topics; 8: the storage fault observer                                                                                                                                                                                                      |
| `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts`, `browser-outbound-cleanup.test.ts`, `replay-captured-message.test.ts`, `rtc-message-nack-diagnostics.test.ts`                                                                                                                                                                                                             | 2 → 6             | 2: the port rename; 6: the scope                                                                                                                                                                                                                      |
| `packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts`, `browser-session-inbound-store.test.ts`, `websocket/ws-retained-work-fault.test.ts`                                                                                                                                                                                                                                 | 5 → 6             | 5: created or moved onto IndexedDB; 6: the scope                                                                                                                                                                                                      |
| `packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts`                                                                                                                                                                                                                                                                                                                    | 4 → 5             | 4: the dispatch cases; 5: the missing-storage cases                                                                                                                                                                                                   |
| `packages/tests/shared/al-outbound-message-runtime.test.ts`, `packages/tests/shared/alm/al-inbound-admission-preparation.test.ts`                                                                                                                                                                                                                                                                   | 3 → 9             | `storageHealth: undefined`, then `storageRecovery: undefined`                                                                                                                                                                                         |

### What the assembly changed against the writers' texts

- Task 3 gains the idle-probe gate R-I2a-i-50 asks for (`readOpenedStore`, both lanes, a lane test and a unit case);
  without it the engine probed a missing database on every pass.
- Budget raises moved to the commits that cross on the real tree (R-I2a-i-48): `rallar.ts` in Tasks 3 and 8 (not 4
  or 6), headless in Tasks 1, 4, 8 and 9.
- Task 5 reads `persisted()` before `persist()` (R-I2a-i-42) and documents the `persist` event; its configure and
  middleware hunks are written against Task 2's port, its imports against Task 1's folder.
- Task 6 encodes the scope parts (R-I2a-i-25) and adds `scope` to Task 5's availability test; its stores, middleware
  and caller hunks are cut against Task 5's tree.
- Task 9's reporter lives in `alm/storage/al-storage-recovery-reporter.ts` and reports through `ALStorageHealth`
  (R-I2a-i-22, -55, -56, -57), so the browser composition needs no change; Step 9 now carries the other two
  harness projections (R-I2a-i-51) and four typed literals (one in a Deno test, caught only by its `deno task
  check`); manifest 18's description names the scenario (R-I2a-i-61); the READMEs link the new module.
- On the scratch branch the memory twin `acknowledgement-under-transport-hold.test.ts` is deleted in the Task 4
  commit (W-B's patch carried it there); the plan deletes it in Task 5 Step 7, where its subject goes. The final
  trees are identical.
- Load-sensitive, green alone: `browser-session-disconnect-before-connect.test.ts` timed out once on the Task 6 commit
  while two sweeps ran side by side (113 / 113 twice alone).
