# ALM I2b: checkpointed durability (`local-checkpoint`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `local-checkpoint`, the fourth durability tier between `volatile` and `local-outbox` (D84). A `local-checkpoint` send is admitted and dispatched from memory and spends no storage operation on its way to the carrier. The tab that owns the session's durable work checkpoints the memory lane's changed rows into the existing `entries` and `alm-work` stores of the session's database, in one readwrite per checkpoint, at most once per interval target (1,000 ms) and when the page hides, and writes nothing while the lane is clean (D129, D133). The next connect that owns the session's work restores the checkpoint before its first work batch (D130, D132). A send that states a client `seq` is refused `unsupported` (D131). Beyond the 10,000 ms recovery-lag bound the store reads `failing` with cause `checkpoint-lag`, and new `local-checkpoint` sends follow the channel's `onStorageUnavailable`. Prove it with unit tests, the D55 zero pin extended to the tier, three lane scenarios (`checkpoint-recovery`, `checkpoint-lag`, `flush-on-hide`), and a reload mid-command in Relic Hunters, whose command channel moves to the tier (D134, D135).

**Architecture:** Task 1 widens the vocabulary: `ALDurabilityAlgo` gains `'local-checkpoint'`, `ALStoreDurability` gains `'checkpoint'`, one selector `resolveALOutboundStoreDurability` replaces `shouldPersistOutbox`, `ALOutboundDispatchPlan.persist` becomes `lane`, and `computeALOutboundOrderingRefusal` refuses a tier send with a `seq`. Task 2 adds dirty tracking: keyed `onChangeDo` and `peek` on `InMemoryQueueBox` and `InMemoryAdmissionBackend`, `ALCheckpointDirtySet` (per-key revisions in `LatestRepository`), and `computeALCheckpointMutations`, the synchronous capture into the existing row formats with a new `put-unconditionally` queue mutation. Task 3 adds `ALCheckpointWriter` (one injected `schedule` timer, single flight, coalescing, the `delayed`/`failing`/`checkpoint-lag` health) and makes the shared `writeIndexedDbAdmissionMutations` commit its readwrite once its last request is issued. Task 4 adds the third store lane over a memory pair, `ALCheckpoint` (owner-only tracking, writer and restore, the takeover marking), `createCheckpointALOutboundRuntimeStores`, the browser checkpoint store ids, and the purge, eviction and relay coverage. Task 5 composes the two checkpoint pairs per connect in the browser (settings on the store factory, the registry's checkpoint factory, the carriers' inputs), the lag skip in the dispatch, and `BrowserPageLifecycleFlush`, which flushes the two checkpoint ports `initialiseMiddleware` returns. Task 6 pins the tier's send at zero storage and its checkpoint at one write. Task 7 adds the three lane scenarios, the Deno fixture's model and the hosted withholding. Task 8 moves Relic's command channel and adds the reload-mid-command Playwright case. Task 9 closes.

**Tech Stack:** TypeScript, Vitest (fake-indexeddb, fake timers, the counting IndexedDB operation observer), IndexedDB (`IDBTransaction.commit()`), the Page Lifecycle events (`visibilitychange`, `pagehide`, `freeze`), Playwright (Chromium, two pages of one context, CDP `Page.crash`, `context.routeWebSocket`), Deno (the control server's generated-recipe fixture), dprint.

**Spec:** `playground/alm/alm-i2b-design-proposal.md` (§1 the problem, §2.a–2.k the design per concern, §3 the decisions, §4 the corrections, §5 the carries). QoS product plan `playground/alm/alm-qos-product-plan.md` §3.1 (realtime demands), §4 (the `local-checkpoint` contract), §5 (the external-visibility rule), §6 (settings), §7.2 and §7.5 (budgets, the spike's findings), §8 (storage lifetime), §9.2 (the I2b requirement-to-evidence rows), §9.3 (the three scenarios), §10.2 (the I2b reading and the consumer). Roadmap `playground/alm/alm-improvement-plan.md`: D84, D85, D86, D88, D115, D118, D125, D126, the row "4 I2b", and the maintainer's decisions D129–D135 of 2026-10-02 (D135 amended 2026-10-03). Base commit `5e06c6ab0` (main after #630, I2a-ii) on branch `claude/alm-i2b-local-checkpoint`. Survey facts: the controller's fact sheet (binding evidence, cited as "fact §N" or "surprise N").

## Global Constraints

- **The maintainer's notes, verbatim: "No legacy, avoid duplication, no migration code, prefer existing repo patterns."** There is no compatibility path: `local-checkpoint` joins the vocabulary in one step (D3: an older peer refuses it as malformed; there are no users).
- **D8 reuse first**, with these named reuses (each task verifies them at `file:line`):
  - the admission row shape and `writeIndexedDbAdmissionMutations` (one readwrite over `entries` + `alm-work`);
  - P1a's `encodeStoredResourceEntry`/`decodeStoredResourceEntry`;
  - `IndexedDbAdmissionBackend.list/read` for the restore read;
  - `InMemoryQueueBox`'s starting map and `writeIfAllObserved`;
  - `ALStorageReadiness` (`openStores`/`startWork`) for "restore before the first work batch";
  - `ALStorageRecoveryReporter.reportFirstBatch`;
  - `ALStorageHealth` (`ObservableLatestValue`) for `delayed`;
  - the storage event union;
  - `ALDurableWorkOwnership.owned` for owner-only;
  - the volatile store factories for the memory pair;
  - the existing `unsupported` refusal shape (`computeALOutboundAckRefusal` → `dropReasonCode: 'unsupported'`);
  - the harness fault port (`fault.inject carrier: 'storage'`), `toStoreRecoveryWait`, the reload pair, `agent.reload`;
  - `packages/shared/cache` for keyed and latest state (no raw `Map` where a repository fits; a listener set is a `Set`, stated in the D8 line).

  Every task carries a D8 reuse inspection paragraph, and its commit one `D8 reuse:` line.
- **No guarantee weakens.**
  - The volatile lane (budget, retention, the D55 zero pin), the durable lane (the warm ledger chain 6 / total 8 / 37 requests / 10 + 5, the cold pin 10 + 9, the inbound pins 9/11, 11/13, 5/7, the storage snapshot) and the I2a-ii ownership stay unedited. Pins only fall.
  - The checkpoint tier's send path performs zero storage operations (the D55 pin extended to the tier); nothing runs while the lane is clean; at most one readwrite per checkpoint.
  - An interrupted write leaves the prior rows intact (IndexedDB transaction atomicity, tested with an aborted transaction); an older completion never marks newer state saved (per-key dirty revisions).
- **Coherence.** A capture is synchronous (one event-loop turn: dirty keys → current memory values → mutations); it never spans an `await`. The memory backend's writes and the work port's queue mutations both mark dirty keys.
- **Server and Node untouched** except the vocabulary: `shouldAwaitALRoute` keeps treating any non-volatile value as routed (receivers route the tier to memory, as `local-outbox`); no AppInbox change; no schema id bump; no new dependency. One new timer (the interval) is the recorded S3 waiver; the lifecycle listeners are side effects in one named adapter owned by the connect lifetime.
- **Bundle budgets** live in `packages/shared-web/bundle-budgets.json` (`browser/rallar.ts` 235 at the base, 234.340 KiB measured) and `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (299, 298.848 KiB). A crossed budget is raised to the next whole KiB, with the measured figure in the commit message and the PR body. This plan raises (R-I2b-18, R-I2b-39, confirmed by the controller; R-I2b-23's targets of 237 and 301 are superseded):
  - the headless budget 299 → 300 in Task 1 (299.144 KiB measured);
  - `browser/rallar.ts` 235 → 236 in Task 4 (235.214 KiB measured);
  - `browser/rallar.ts` 236 → 238 and the headless budget 300 → 303 in Task 5 (237.287 and 302.151 KiB measured), where the writer, the restore and the lane first become reachable from the facade.

  Every figure is read with a private `TMPDIR` (R-I2b-23): the bundle script and the headless boundary test write their bundles under `os.tmpdir()`, which every worktree of the machine shares.
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`):
  - Use the canonical verbs. Functions are at most 40 lines, with at most 3 positional parameters.
  - Use `interface` for object contracts. Fields are required by default; a field is optional only where absence has domain meaning, stated in its doc line.
  - Use `Either` for expected failure. File names are kebab-case and named after the primary export. No role folders.
  - No comments except an essential invariant, an external constraint or a tradeoff. Test-intent comments in tests are fine. No `// packages/...` path headers, and no doc comments that restate the code.
  - No plan, decision, task, PR or ruling id in code or tests.
  - Cognitive-load tiers: warn at 50, review at 110, and 330 or more needs a registered exception. Twelve or more runtime exports prompts a split review.
  - A widened union's consumers are swept by enumeration (`ALStoreDurability` has about 15 consumers; `ALDurabilityAlgo` lists in five harness places plus the channel validator's text).
- **Formatting:** dprint runs only on touched files, by explicit list (`npx dprint fmt <file> <file>`), never on a glob.
- **Per-task checks** (each task lists its own commands and the figures measured at its assembled commit):
  - the focused Vitest files;
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`, and the shared-web, shared-server and shared-test typechecks (`npm --workspace @ar-eye-hunter/<name> run typecheck`);
  - `cd apps/api-v1 && deno task check`, then `rm -rf apps/api-v1/node_modules/.deno` and `find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete` (a left-behind `.deno` and its dangling links break the next check);
  - `node scripts/check-tests-typecheck.mjs`;
  - the pins (`al-indexeddb-transaction-ledger.test.ts`, `al-indexeddb-operation-counts.test.ts`, `al-storage-snapshot.test.ts`, `al-indexeddb-empty-audience-counts.test.ts`);
  - the bundle checks after any `packages/shared` or `shared-web` change, with a private `TMPDIR`;
  - before the push, `npm run check:repo-style:changed -- origin/main HEAD` and `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` (both need the commit);
  - `npm run check:test-reachability` when a test file is added or deleted (it counts tracked files, so it runs after the commit);
  - `npm run test:postgres:integration` for any change under `packages/shared/alm/inbound/**` or `alm/work/**` source (none in this plan: only `alm/inbound/README.md` changes). It uses the shared container: `docker start` only if stopped, never `db:test:up` or `db:down`;
  - for a public shared-web surface change, `shared-web-public-api-snapshots.test.ts` and `shared-web-browser-bundle-boundaries.test.ts`;
  - for the harness tasks, a typecheck of `tests/playwright/**` with a scratch tsconfig and the control server's `deno task check && deno task test`.
- **Navigation maps** are updated in the task that changes what they describe: `packages/shared/alm/outbound/README.md` (Task 6 also fixes the stale "10 and 11" pin text to the test's 10 and 9), `alm/inbound/README.md`, `runtime-diagnostic-contract.md`, `schema-and-capabilities.md`, `alm-observation-artifact.md`, the shared-web browser README, `docs/rallar-api-reference.md`, Relic's `runtime-data-flow.md`.
- **Git:**
  - The implementer makes one commit per task, with one `D8 reuse:` line and no attribution lines.
  - The controller pushes after review.
  - Never `git stash`, never push, never merge, never run `pr:delivery ready`.
- **Sandbox notes.** Port-binding suites fail sandboxed with `listen EPERM` (five unit files bind loopback port 0: `api-v1-rtc-rtt-recipe-semantics.test.ts`, `api-v1-state-write-convergence-recipe.test.ts`, `local-websocket-session.test.ts`, `headless-worker-script.test.ts`, `live-rtc-control-client.test.ts`; the control server's `control-dispatch-triggers.test.ts` and `control-reload-socket.test.ts` spawn servers); run them with the sandbox disabled or classify them as such. `npx tsx` fails sandboxed on its IPC pipe: use `node --import tsx`. Never run a Playwright lane or bind ports 18080–18082, 5177, 5178 or 5180 outside Task 9's lane rule.

## File structure

| Area                           | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Responsibility                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vocabulary and routing (1)     | `packages/shared/al-contracts/al-policy.ts`, `normalize-al-qos-policy.ts`; `packages/shared/alm/al-runtime-stores.ts` (`ALStoreDurability`); `alm/outbound/al-outbound-message-runtime.ts`, `admission/al-outbound-admission-validation.ts`, `admission/compute-al-outbound-ordering-refusal.ts` (new); the WS and RTC planners, the WS server's planning (vocabulary only); the channel validator; the five harness lists and the observation decoder                                                                                                                                                                                     | `local-checkpoint` in the D84 order; `resolveALOutboundStoreDurability`; `plan.lane`; the `seq` refusal                                                         |
| Dirty tracking and capture (2) | `packages/shared/queuebox/in-memory-queue-box.ts`, `indexed-db-queue-box-entry.ts`, `write-computed-indexed-db-queue-mutations.ts`; `packages/shared/alm/al-admission-backend.ts`; `alm/checkpoint/al-checkpoint-dirty-set.ts`, `compute-al-checkpoint-mutations.ts` (new)                                                                                                                                                                                                                                                                                                                                                                 | Keyed change notification and `peek`; per-key revisions; the synchronous capture; `put-unconditionally`                                                         |
| Writer (3)                     | `alm/checkpoint/al-checkpoint-writer.ts` (new); `alm/storage/al-storage-event.ts`, `al-storage-health.ts`, `al-storage-unavailable.ts`; `alm/write-indexed-db-admission-mutations.ts`; `queuebox/write-computed-indexed-db-queue-mutations.ts`; the harness cause record; the purge's health builder                                                                                                                                                                                                                                                                                                                                       | The interval, single flight, revisions, one readwrite, `delayed`/`failing`/`checkpoint-lag`, `flush()`; the readwrite committed once its last request is issued |
| Lane and restore (4)           | `alm/checkpoint/al-checkpoint.ts` (new), `al-checkpoint-dirty-set.ts`; `alm/al-runtime-stores.ts` (`createCheckpointALOutboundRuntimeStores`); `alm/al-admission-backend.ts`, `queuebox/in-memory-queue-box.ts` (`peekKeys`, `loadIfAbsent`); `alm/indexed-db-admission-backend.ts`; `alm/storage/read-al-work-rows-in-ranges.ts` (new, moved); `alm/outbound/al-outbound-message-runtime.ts`, `lane/al-outbound-store-lane.ts`, `lane/compute-al-outbound-committed-rows.ts` (new, moved); the memory retention branches; `shared-web/browser/al-runtime/browser-al-checkpoint-store-ids.ts` (new), the identity, cleanup and relay files | The third lane; owner-only tracking and restore; the takeover marking; the store ids; purge, eviction and relay coverage                                        |
| Browser composition (5)        | `shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts`, `browser-page-lifecycle-flush.ts` (new); `browser-al-runtime-stores.ts`, `browser-al-storage-availability.ts`; `messages/browser-rallar-message-dispatch.ts`; `connection/initialise-browser-middleware.ts`, `browser-transport-runtime.ts`; the WS and RTC carrier inputs; `packages/shared/alm/ALRuntimeStoreRegistry.ts`; `services/ws-queue-box-client-service.ts`; `rallar.ts`, `rallar-core.ts`                                                                                                                                                                     | The settings; one checkpoint pair per carrier per connect; the lag skip; the lifecycle flush over the two checkpoint ports; the public `ALStorageHealthStatus`  |
| Pins (6)                       | `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`; `alm/outbound/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Zero storage on the tier's send; one write per checkpoint; nothing while clean                                                                                  |
| Harness (7)                    | `packages/shared-test/rallar-bb-test/conformance/alm/**` (`scenarios/local-checkpoint/` new: `checkpoint-recovery.ts`, `checkpoint-lag.ts`, `flush-on-hide.ts`); the harness docs; `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`, `full-stack-same-context-run.ts`; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`; the control server's `control-generated-alm-reload.test.ts`                                                                                                                                                                                                              | The three scenarios; reload sync points as a definition field; flush-and-crash in the same-context runner; hosted withholding; the fixture's model              |
| Relic (8)                      | `apps/relic-hunters-v1/src/game/send-relic-ws-command.ts`, its test, `docs/runtime-data-flow.md`; `tests/playwright/relic-hunters/full-stack-propagation.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `local-checkpoint` with `refuse`; the reload-mid-command case                                                                                                   |
| Tests                          | `packages/tests/shared/**`, `packages/tests/shared-web/**`, `packages/tests/shared-test/**`, `packages/tests/rallar-black-box/**`, the Relic test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Red first per task; the pins unedited                                                                                                                           |
| Docs and budgets               | the navigation maps above; `packages/shared-web/bundle-budgets.json` (Tasks 4, 5), `headless-bundle-budget.json` (Tasks 1, 5); `playground/alm/alm-qos-product-plan.md` §10.1 (Task 9)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Maps true to the code; budgets raised where crossed                                                                                                             |

## Task order

1 (vocabulary) → 2 (dirty tracking) → 3 (writer) → 4 (lane and restore) → 5 (browser composition) → 6 (pins) → 7 (harness) → 8 (Relic) → 9 (close).

- Task 1 consumes nothing new. It produces `'local-checkpoint'`, `ALStoreDurability 'checkpoint'`, `resolveALOutboundStoreDurability`, `ALOutboundDispatchPlan.lane` and `computeALOutboundOrderingRefusal`, with a one-task bridge (a `checkpoint` plan runs on the durable lane) that Task 4 removes.
- Task 2 consumes nothing of Task 1. It produces `InMemoryQueueBox.onChangeDo/peek`, `InMemoryAdmissionBackend.onChangeDo/peek`, `ALCheckpointDirtySet` (`onMarkedDo`, `isClean`, `getOldestDirtiedAtMs`, `getSnapshot`, `clearSaved`, `dispose`), `computeALCheckpointMutations` and the `put-unconditionally` queue mutation.
- Task 3 consumes Task 2's dirty set and capture. It produces `ALCheckpointWriter` (`Settings`, `Timers { schedule }`, `Input`, `flush`, `dispose`), `ALStorageHealthStatus 'delayed'`, `ALStorageHealthState.oldestUnsavedAgeMs`, the cause `checkpoint-lag`, `ALStorageHealth.recordDelayed`/`recordLagFailure`, and `SubmitComputedIndexedDbQueueMutationsInput` with `onIssued`.
- Task 4 consumes Tasks 1–3. It produces `ALCheckpointPort` and `ALCheckpoint` in `checkpoint/al-checkpoint.ts`, `ALCheckpointOutboundRuntimeStores` (in `al-outbound-message-runtime.ts`), `createCheckpointALOutboundRuntimeStores`, `Resources.checkpointStores`, `ALOutboundMessageRuntime.flushCheckpoint()`, `ALCheckpointDirtySet.loadWithoutMarking`/`markHeld`, `peekKeys()` on both memory stores, `InMemoryAdmissionBackend.loadIfAbsent`, `readALWorkRowsInRanges`, and the store ids in `browser-al-checkpoint-store-ids.ts`; it replaces Task 1's bridge (R-I2b-14, R-I2b-20).
- Task 5 consumes Task 4's factory, port and ids. It produces the browser settings, `resolveBrowserALCheckpointStores`, `BrowserConnectedMiddleware`, `BrowserPageLifecycleFlush`, the lag skip and the public `ALStorageHealthStatus`.
- Task 6 consumes Tasks 3–5 (the fixture pass-through is Task 4's) and produces only the pin.
- Task 7 consumes the browser behaviour of Tasks 3–5 through the lane (the store ids, the `recovery` and `health` events, the lifecycle adapter's `freeze` listener on `document`). It touches no product code.
- Task 8 is independent of Task 7 and consumes Task 5's tier in the browser.

Each task's patch was prototyped on `5e06c6ab0` with the earlier writers' patches applied first; Tasks 5–6 were written against a scaffold of Tasks 3–4 and are reconciled to the real Tasks 3–4 here. The chain was composed on a scratch tree from `5e06c6ab0` as eight commits, one per task, and every task's typechecks, focused tests, pins, bundle checks and changed-range gates are green at its own commit (the figures per task are in each task's text and in the Self-review).

---

## Maintainer decisions (2026-10-02, recommended option taken on each; D135 amended 2026-10-03)

- **D129 Checkpoint = changed rows in the existing row formats.** The checkpoint is the memory lane's dirty rows applied
  to the existing `entries` and `alm-work` object stores of the session's database, under the checkpoint lane's own
  store id, in one readwrite transaction, at the interval or on hide. Restore is the durable lane's existing bootstrap
  read into the memory store. No new row shape, no schema-id bump, no new codec; purge and eviction already cover the
  rows. The cost pin is one readwrite per checkpoint with as many requests as dirty rows.
- **D130 A third `checkpoint` store lane.** The same `ALOutboundStoreLane` class, a memory admission pair from the
  existing volatile factories, plus the checkpoint writer and a restore in its readiness. `ALStoreDurability` gains
  `'checkpoint'`; the three `shouldPersistOutbox` consumers get a three-way answer. Volatile keeps its budget,
  retention and zero pin; the checkpoint lane has its own first-batch recovery event and health.
- **D131 Refusal = `seq` only.** A restored checkpoint can reuse a position only through a client `seq`; an ordering key
  alone carries no position (every room send carries the default group key), so room sends work on the tier.
  Latest-wins is allowed: a copy superseded after the checkpoint was never seen outside the runtime. Narrows D85 (D118).
- **D132 Owner-only checkpoint; a non-owner's rows are not checkpointed (stated limit).** Only the per-session durable
  owner writes and restores. A non-owner tab's `local-checkpoint` sends dispatch from its memory and die with the tab;
  their `admitted` verdict reads `durable: false`. On takeover the restore merges into the live memory store with
  if-absent semantics. Cross-tab coverage is a follow-up.
- **D133 Settings: interval target 1,000 ms, recovery-lag bound 10,000 ms**, composition-root settings on the browser
  store factory with these defaults; the health event carries the oldest unsaved age.
- **D134 Relic's command channel moves to `local-checkpoint`, keeps `onStorageUnavailable: 'refuse'`**; the consumer
  proof is a reload-mid-command case in the Relic full-stack Playwright spec (manual suite); the limit: admissions
  inside the last interval are lost with the page and read `unobservable`.
- **D135 Lifecycle flush: listeners in the connect lifetime (`visibilitychange` → hidden, `pagehide`, `freeze`), owner
  only, removed at release; proven by a Playwright-only `flush-on-hide` cell driven through CDP
  `Page.setWebLifecycleState`, as the perf harness drives CPU throttling; hosted manifests byte-identical; the
  control-server fixture models the flush.
- **D135 amended (maintainer, 2026-10-03):** CDP `Page.setWebLifecycleState` is a measured no-op on Playwright's headless
  Chromium (no `freeze`, timers keep running), so the `flush-on-hide` cell dispatches a synthetic `freeze` on the owner
  page's document, waits 250 ms, crashes the page through CDP `Page.crash` (no `pagehide`, no later timer) and closes it;
  the successor restores the rows the flush wrote. It proves that a flush begun in the lifecycle listener lands before an
  abrupt end; the browser's real freeze and hide stay unproven in the lane and join H5 as a stated limit. The cell joins
  the `same-context` family (`SameContextPages.ownerEnd: 'close' | 'flush-and-crash'`), runs over `ws` and `rtc` only,
  and ends the owner page instead of reloading it (a reload's own `pagehide` flush would confound the proof).

## Rulings made while writing the plan

Each ruling is a choice the spec does not settle. R-I2b-1..12 come from the controller's frame; R-I2b-13..35 come from the controller's review of the writers' prototypes (W-A wrote Tasks 1–2, W-B Tasks 3–4, W-C Tasks 5–6, W-D Tasks 7–8), and they override a task text that differs; they are copied verbatim. R-I2b-36..42 come from this plan's assembly, and R-I2b-43..46 from the controller's review of the assembly (R-I2b-36 and R-I2b-39 confirmed there; R-I2b-43 replaces R-I2b-38's shape). The maintainer can undo any of them; _Cost if wrong_ says what a wrong ruling costs. Rulings are cited by id in the plan text only, never in code or tests.

- **R-I2b-1:** No schema-id bump. D129 adds no row shape or index; the wire cutover is the enum widening (D3, D84's bump clause is overtaken by D129).
  _Why:_ D129 adds no row shape or index; the enum widening is the D3 cutover. _Cost if wrong:_ None: an older peer refuses the value as malformed, and there are no users.
- **R-I2b-2:** The checkpoint lane's store ids are new ids in `browser-al-runtime-identity.ts`, not a suffix on the durable ids, so the durable lane's bootstrap, purge and recovery waits never see checkpoint rows and vice versa.
  _Why:_ The durable lane's bootstrap, purge and recovery waits must never read checkpoint rows. _Cost if wrong:_ Two more prefixes in the purge, the eviction and the work namespaces (Task 4 adds them).
- **R-I2b-3:** The capture reads current memory values for the dirty keys (not a per-mutation log): a key dirtied several times writes once; a key deleted since writes a delete.
  _Why:_ A key changed several times writes once, and a key deleted since writes a delete. _Cost if wrong:_ None.
- **R-I2b-4:** "Older completion never marks newer state saved" is implemented with per-key revisions captured at write start and compared at completion; no global generation counter.
  _Why:_ A completed write clears only what it captured, with no global counter to order. _Cost if wrong:_ None.
- **R-I2b-5:** `delayed` is a health status (`'healthy' | 'delayed' | 'failing'`), emitted on transitions; the oldest unsaved age is a field on the health state; the lag beyond the bound is `failing` with cause `checkpoint-lag`, a new `ALStorageUnavailableCause`; new admissions then follow `onStorageUnavailable` through the existing availability path.
  _Why:_ Health states transitions only; one cause vocabulary serves the availability path. _Cost if wrong:_ The harness decoders learn one status and one cause.
- **R-I2b-6:** The non-owner's checkpoint lane runs its own work (dispatch from memory) and never writes; its admissions read `durable: false`; no relay of its rows. On takeover the restore runs before the taken-over lane's first batch and merges if-absent.
  _Why:_ D132. _Cost if wrong:_ A non-owner's tier sends die with its tab (Limits).
- **R-I2b-7:** The lifecycle flush is best effort: it starts the readwrite and does not await it; a flush that does not complete leaves the prior rows intact (D129 atomicity). Stated as a limit; H5 stays unmeasured.
  _Why:_ An unload cannot await a transaction. _Cost if wrong:_ H5 stays unmeasured (Limits).
- **R-I2b-8:** Hosted manifests 18 and 22 stay byte-identical; the three new scenarios are full-tag, run locally and in the hosted full read; `flush-on-hide` is Playwright-only (CDP).
  _Why:_ D124 and D135: a hosted agent has no second page in its context. _Cost if wrong:_ No hosted proof of `flush-on-hide`.
- **R-I2b-9:** The harness's `AlmReloadCheckpoint` (reload sync points) keeps its name; the tier's types are `ALCheckpoint*`. The navigation docs state the distinction once.
  _Why:_ A rename would churn the reload-pair harness for no behaviour. _Cost if wrong:_ Two meanings of "checkpoint" in the harness; the docs state the distinction once.
- **R-I2b-10:** The outbound README's stale pin text ("10 and 11") is corrected to the test's 10 and 9 in Task 6.
  _Why:_ The README's pin text was stale against the test (fact surprise 10). _Cost if wrong:_ None.
- **R-I2b-11:** Relic's reload-mid-command case lives in the manual full-stack suite (tests/manual-suites.json already owns it); it is run once at the close with its summary line in the PR body.
  _Why:_ `tests/manual-suites.json` already owns the Relic full-stack suite. _Cost if wrong:_ The consumer proof needs one manual run at the close (Task 9).
- **R-I2b-12:** `WriteBehindObservableLatestRepository` is not reused for the writer (per-key immediate writes, no coalescing, no single transaction); the writer is one new module, and the D8 line says why.
  _Why:_ It writes each key at once on a promise chain, without coalescing, interval or one transaction. _Cost if wrong:_ One new module.
- **R-I2b-13:** The captured outbound row keeps `persist: boolean` (persisted in IndexedDB and Postgres; a rename would be a row-shape change against R-I2b-1); `captureALOutboundPolicy` stores `lane !== 'volatile'` and `toALOutboundCapturedLane` maps the boolean back where no re-plan exists. `ALMessageHandlingPlan.forwarding.persist` stays a boolean for the same reason and reads "kept beyond the volatile lane"; the RTC planner reads the lane from the effective durability.
  _Why:_ The captured row is persisted in IndexedDB and Postgres; renaming its field is a row-shape change (R-I2b-1). _Cost if wrong:_ The field name `persist` reads "kept beyond the volatile lane".
- **R-I2b-14:** A `checkpoint` plan in a runtime that holds no checkpoint lane (the server, Node, a composition without `checkpointStores`) routes to the volatile lane and its admission reads `durable: false`; it never routes to the durable lane (that would add storage work the tier promises not to spend). Task 1's interim bridge to the durable lane is replaced by this rule in Task 4.
  _Why:_ The tier promises no storage work on the send path. _Cost if wrong:_ Such an admission reads `durable: false`.
- **R-I2b-15:** The restore loads the memory pair without marking: `ALCheckpointDirtySet` exposes a synchronous `loadWithoutMarking(load: () => void)` (notifications suspended for the duration of the synchronous load), used by the restore at first connect and on takeover alike.
  _Why:_ A restore must not mark the rows it loaded as unsaved. _Cost if wrong:_ None.
- **R-I2b-16:** The checkpoint lane's admission rows use the memory retention rule (deadline plus receipt grace, the `durability !== 'durable'` branch), not the durable TTL; the volatile admission-store factories take the lane's `ALStoreDurability` instead of hard-coding `'volatile'`. `toStoreVerdict` reads `durable: lane !== 'volatile' && owned`; the settlement relay relays `durable` and `checkpoint`; `compute-al-volatile-control-row-expiry-ms.ts` and `al-outbound-admission-mutations.ts:331` are widened by enumeration in Task 4.
  _Why:_ The tier is memory-first: its rows expire with the message, not with the durable TTL. _Cost if wrong:_ The memory retention branches widen by enumeration.
- **R-I2b-17:** W-A's refinements are adopted as decided shapes: `onChangeDo(listener): Unsubscribe` keyed change notification on `InMemoryQueueBox` and the memory backend (from `storeEntry`/`removeEntry` and `setStored`/`deleteStored`); `peek(key)` instead of `entries()`; the new queue mutation kind `put-unconditionally` (`computeIndexedDbQueueUnconditionalPut`) because the compare-and-set puts cannot be used by a synchronous capture; the feature folder `packages/shared/alm/checkpoint/` for the dirty set, the capture and the writer; the dirty set API `onMarkedDo`, `isClean`, `getOldestDirtiedAtMs`, `getSnapshot → {marks, takenAtMs}`, `clearSaved(snapshot)`, `dispose`; `computeALOutboundOrderingRefusal({ msg, policy })` chained beside the ACK refusal in the WS client planner and the RTC `planOutgoingMessage`.
  _Why:_ A synchronous capture cannot read before it writes, so the compare-and-set puts conflict; `peek` reads without the lazy expiry. _Cost if wrong:_ One new queue mutation kind.
- **R-I2b-18:** The headless budget moves 299 → 300 at Task 1 (299.144 KiB measured); `browser/rallar.ts` stays 235.
  _Why:_ The global constraint: Task 1 crosses 299. _Cost if wrong:_ None.
- **R-I2b-19:** With IndexedDB `missing`, a `local-checkpoint` admission follows `onStorageUnavailable` like a `local-outbox` one (refused by default): the tier promises a checkpoint and none can be written. Only `failing` with `checkpoint-lag` (and the existing causes) skips the lane; `delayed` never does.
  _Why:_ The tier promises a checkpoint, and none can be written without IndexedDB. _Cost if wrong:_ A browser without IndexedDB refuses the tier by default, or downgrades with a note under `volatile`.
- **R-I2b-20:** R-I2b-14 completed: a checkpoint plan routes to the volatile lane where one exists; a runtime with neither a checkpoint nor a volatile lane (one-lane Node compositions) routes it to its only lane, the durable one, and the server's planner never produces a checkpoint plan (it sets `durable`/`volatile` from `awaitsRoute`). Stated in the runtime's class doc once.
  _Why:_ One-lane Node compositions have neither memory pair. _Cost if wrong:_ There the tier runs on the durable lane.
- **R-I2b-21:** Task 4 owns `Resources.checkpointStores`, the default resource factory pass-through and the shared test fixtures (`outbound-runtime-test-fixture.ts`, `session-outbound-test-runtime.ts`); Task 5 owns the browser composition; Task 6 only the pins.
  _Why:_ Task 4's lane tests need the fixtures. _Cost if wrong:_ None.
- **R-I2b-22:** No `flushCheckpoints()` on the public middleware type. The lifecycle adapter receives the two `ALCheckpointPort`s from the composition that built them (once per connect, under the claim) and calls `flush()` directly; the public API snapshot stays unchanged except for the widened health types.
  _Why:_ The public middleware type stays narrow. _Cost if wrong:_ An internal type carries the ports (R-I2b-38).
- **R-I2b-23:** Bundle figures are read with a private `TMPDIR` (the bundle script and the headless test write to the shared temp directory, `measure-browser-bundles.mjs:20`, `headless-bundle-boundary.test.ts:30`); every task text says so. Budgets after W-C: `browser/rallar.ts` 236.151 → 237 (raised at Task 5, where the checkpoint code first becomes reachable from the facade), headless 300.935 → 301.
  _Why:_ The shared temp directory races bundle figures between worktrees. _Cost if wrong:_ None; the figures are superseded by R-I2b-39.
- **R-I2b-24:** The settings live on the existing `ConfigureBrowserALRuntimeStoresInput` (optional, with defaults); the checkpoint pairs are built through the existing store registry once per connect under the claim.
  _Why:_ Every knob of that input is optional with a default. _Cost if wrong:_ Two optional fields on the input.
- **R-I2b-25:** `writeIndexedDbAdmissionMutations` calls `transaction.commit()` when the method exists, after issuing its requests, for every caller; the same edit creates the completion promise's handlers before the submits so a synchronously thrown `put` cannot escape as an unhandled rejection (W-B surprise 2). Measured unload landing rate (0/4 without, 2/4–3/4 with) stated in Limits. Lives in Task 3.
  _Why:_ Unload-time readwrites landed 0/4 without `commit()` and 2/4–3/4 with it; the pre-existing unhandled rejection (W-B surprise 2) sits on the same lines. _Cost if wrong:_ Realised by R-I2b-36.
- **R-I2b-26:** The `flush-on-hide` attribution rests on the owner page ending inside the 1 s interval after the send (the cell waits 250 ms); stated as a limit; no harness-lengthened interval.
  _Why:_ A harness-lengthened interval would test a configuration production never runs. _Cost if wrong:_ A page that ends after the interval would let the interval's write, not the flush, save the row (Limits).
- **R-I2b-27:** D126 stands: no request-id idempotency key for Relic; Task 9 runs the manual Relic full-stack suite once and its green summary line is the proof; a red there is diagnosed before any key is added.
  _Why:_ Msg-id dedup within the deadline plus the grace suffices if the suite is green. _Cost if wrong:_ A red there needs a diagnosis before any key is added.
- **R-I2b-28:** A non-owner runtime does not accumulate dirty marks: the dirty set subscribes only while owned; when ownership turns true the restore merges first, then every live key of the memory pair is marked once, so the first checkpoint after a takeover writes the live state (a takeover is rare; the cost is one write of the live rows).
  _Why:_ A waiting tab would otherwise accumulate marks without bound. _Cost if wrong:_ One write of the live rows after a takeover. Realised by R-I2b-37.
- **R-I2b-29:** A message handed over from RTC to WS may be restored by both carriers' checkpoint pairs after a reload (the send controls live in memory); the receiver's msgId dedup absorbs the duplicate and the RTC copy settles not-ready or exhausted. Stated limit; one writer per session store stays.
  _Why:_ The send controls live in memory, per carrier. _Cost if wrong:_ A duplicate the receiver drops; the RTC copy settles not-ready or exhausted (Limits).
- **R-I2b-30:** No lag check runs while a write is in flight and nothing is armed during it; the write's completion or failure is the next check (IndexedDB aborts a hung transaction). Accepted; stated once in the writer's doc line.
  _Why:_ A watchdog would arm a timer while clean and break Task 6's idle pin. _Cost if wrong:_ A hung transaction delays the lag statement until IndexedDB aborts it.
- **R-I2b-31:** `isIndexedDbALRuntimeStoreSupported` is removed (callers use `IndexedDbStringPersistenceProvider.isSupported()`); no 12-export exception. Task 5's text and patch follow Task 4's removal (the one textual conflict at assembly).
  _Why:_ A one-line wrapper with two callers; keeping it puts `al-runtime-stores.ts` at 12 runtime exports. _Cost if wrong:_ None.
- **R-I2b-32:** The checkpoint pair's IndexedDB connection is opened per connect and not closed, as the durable pair's is (`ALRuntimeStoreRegistry.ts:70-81`); unchanged.
  _Why:_ As the durable pair's connection (`ALRuntimeStoreRegistry.ts:70-81`). _Cost if wrong:_ One open connection per pair and connect (carried).
- **R-I2b-33:** W-B's shapes are the decided shapes where W-C assumed differently: `Timers { schedule(run, delayMs): () => void }`; `ALCheckpointPort` (`restore`, `flush`, `dispose`, `isOwned`, `onTakenOverDo`, `reportFirstBatch`) declared in `checkpoint/al-checkpoint.ts`; store ids in `browser-al-checkpoint-store-ids.ts`; `recordDelayed(oldestUnsavedAgeMs, lastFailure)` and `recordLagFailure(failure, oldestUnsavedAgeMs)`; the factory `createCheckpointALOutboundRuntimeStores` with the canonical scope forced to the pair's namespace; `computeALOutboundCommittedRows`/`hasWrittenWork` moved to `outbound/lane/compute-al-outbound-committed-rows.ts`; `readALWorkRowsInRanges` in `alm/storage/`; expired rows not loaded at restore and counted as `expired`; an unreadable store at restore records `failing` and the lane opens from memory; the session fixture's `<namespace>-checkpoint` pairs with `session.checkpointStorage`/`checkpointObserver`. The assembler reconciles Task 5's and Task 6's texts and patches to these.
  _Why:_ Tasks 3–4 are the real code; Tasks 5–6 were written against a scaffold. _Cost if wrong:_ Tasks 5 and 6 are reconciled at assembly (this plan).
- **R-I2b-34:** `CARRIER_TEST_TIMEOUT_MS` 480 → 540 s is an estimate (the fallback baseline cell gains about 90 s); Task 9 re-measures the longest cell in the local full lane and the PR body states the margin.
  _Why:_ The fallback baseline cell gains about 90 s over its measured 7.1 min. _Cost if wrong:_ Task 9 re-measures; the margin goes in the PR body.
- **R-I2b-35:** W-D's harness shapes are adopted: scenarios under `scenarios/local-checkpoint/`; `CHECKPOINT_INTERVAL_MS` and `CHECKPOINT_LAG_BOUND_MS` in the scenario modules; `RECOVERED_STORE_PREFIXES.wsCheckpoint`/`rtcCheckpoint` and `toCheckpointStorePrefix`; the interval witness is the storage counters (`byKind.write > 0` after 2 s); both restoring cells wait out one lease; `AlmConformanceScenarioDefinition.toReloadCheckpoint?` replaces the `'delivery-reload'` id test; `checkpoint-recovery` and `checkpoint-lag` join the hosted withheld list; `checkpoint-lag` adds a third send after `healthy`; the Relic hold is Playwright `context.routeWebSocket` withholding `relic.command.v1` frames and the witness is `start-expedition`'s event count. Task 3 adds `'checkpoint-lag'` to `decode-alm-delivery-failure.ts`'s record (or Task 7 does, whichever the assembler finds owns the file after the patches apply).
  _Why:_ The scenarios directory is at the density threshold; the budgets file would reach 13 runtime exports; the hosted list must stay byte-identical. _Cost if wrong:_ None.

- **R-I2b-36:** (Assembly; realises R-I2b-25; confirmed by the controller 2026-10-03.) `writeIndexedDbAdmissionMutations` calls `transaction.commit?.()` once the write's last request is issued, for every caller: synchronously for a write whose requests are all issued in its opening turn (an empty fence, no guarded removal, only unconditional queue mutations: the checkpoint), otherwise from the callback that issues the last write (after the fence re-reads, the guarded removals and each compare-and-set read). The queue submitter takes one input object, `SubmitComputedIndexedDbQueueMutationsInput { store, mutations, eligibility, onIssued }`, and calls `onIssued` when its last conditional write is issued (at once when it has none); a conflict, a stored-value error or an expiry never calls it, so a failing write keeps the browser's own commit. A write with a persistence deadline never calls `commit()`. The completion promise gets a no-op rejection handler before any request is issued, so a `put` its aborted transaction refuses rejects the write with that error and leaves no unhandled rejection.
  _Why:_ `commit()` forbids every later request (a fenced write issues its puts from read callbacks) and makes `abort()` throw `InvalidStateError`, so an early commit would break the compare-and-set writes and the deadline's abort on expiry. _Cost if wrong:_ A deadline-bound durable write started at unload lands at the pre-I2b rate (no regression); the queue submitter's three positional parameters became one input object (two callers).
- **R-I2b-37:** (Assembly; realises R-I2b-28.) `ALCheckpoint` builds its dirty set and writer (`ALCheckpointTracking`) only while this runtime owns the work: at construction when it owns it, otherwise once the takeover's restore has run (also when that restore failed), and then `ALCheckpointDirtySet.markHeld()` marks every key the pair holds, read through new `peekKeys()` methods on `InMemoryAdmissionBackend` and `InMemoryQueueBox` (every key held now, expired or not, removing nothing; beside the existing `peek`). The restore loads without marking only where tracking already exists. A disposed checkpoint never starts tracking. The takeover's marking alone arms the writer after a takeover; the writer takes no ownership input, has no owner guard and subscribes to no ownership change (R-I2b-44, R-I2b-46).
  _Why:_ R-I2b-28's letter ("the dirty set subscribes only while owned") with no change to Task 2's API: the dirty set does not exist before ownership. _Cost if wrong:_ A takeover rewrites the restored rows once, which R-I2b-28 accepts.
- **R-I2b-38:** (Assembly; realises R-I2b-22. Its shape is superseded by R-I2b-43: the result is two fields, and no runtime property is added to the middleware; the reasoning about where the ports travel stands.) `initialiseMiddleware` returns `BrowserConnectedMiddleware`, an internal type of `initialise-browser-middleware.ts` that extends `RallarBrowserMiddleware` with `checkpoints: readonly Pick<ALCheckpointPort, 'flush'>[]` (the WS client's and the RTC overlay's checkpoint ports, from the pairs `createBrowserTransportInput` built under the claim). `BrowserTransportRuntime` hands them to `new BrowserPageLifecycleFlush({ page, ownership, checkpoints })` once the middleware is active and releases it first in `shutdown()`; it keeps the returned object as the public middleware. `RallarBrowserMiddleware`, `rallar-connection-facade.ts` and the public snapshot carry nothing; W-C's `flushCheckpoints()` and `flushBrowserALCheckpoints` do not exist. The test double's middleware is typed `BrowserConnectedMiddleware` (`ApiMiddlewareTestDouble`, `checkpoints: []`), and 13 test files that type their `initialiseMiddleware` mock retype it (Task 5, Step 11).
  _Why:_ The adapter must live in the connect lifetime the transport runtime owns (released at shutdown, never created for a cancelled connect), while the ports exist only inside `initialiseMiddleware`, after the store registry is configured; returning them beside the middleware is the one path that adds nothing to the public type. _Cost if wrong:_ The public middleware object carries a `checkpoints` property at runtime that no public type names (reachable only through a cast); stripping it would break the object identity two facade tests pin.
- **R-I2b-39:** (Assembly; refines R-I2b-23; confirmed by the controller 2026-10-03, R-I2b-23's targets superseded. The Task 5 figures below are the final tree's after R-I2b-43.) Budgets as measured on the assembled tree: `browser/rallar.ts` first crosses at Task 4 (235.214 KiB, where R-I2b-36's and R-I2b-37's code joins the lane; W-B's prototype read 234.943) and rises 235 → 236 there; at Task 5 it reads 237.287 KiB and rises 236 → 238, and the headless agent reads 302.151 KiB and rises 300 → 303. R-I2b-23's 237 and 301 were measured on W-C's scaffold of Tasks 3–4, which is smaller than the real writer, restore and lane.
  _Why:_ The global constraint: a crossed budget rises to the next whole KiB where it is first crossed. _Cost if wrong:_ None (the maintainer's ruling: budgets are adjustable).
- **R-I2b-40:** (Assembly; Task 5's tests.) The checkpoint pair exposes no `storageHealth` (the lane would read every memory commit as a recovery point and end a lag that no checkpoint ended), so Task 5's two tests that drove the scaffold's `storageHealth.recordFailure` now drive a real lag: an IndexedDB operation observer rejects every `write` with `QuotaExceededError` while a flag holds, under the settings 20 / 100 ms. The interval test fakes `Date` with `setTimeout` and `clearTimeout`: with a real clock the timer is armed for the change's age, which can move by a millisecond between the change and the arm, and the checkpoint then fires at 249 ms (seen once in eight runs before the fix).
  _Why:_ W-B's pair is right not to expose the health; the tests must go through the writer. _Cost if wrong:_ Two tests on real timers with short settings (8/8 green under parallel load) that could slow down under heavy load; the waits are `vi.waitFor` with the default bound.
- **R-I2b-41:** (Assembly; Task 6's red.) Task 4 owns the fixture pass-through (R-I2b-21), so Task 6's pin passes at its first run: it pins what Tasks 3–5 built. Its red step is a mutation check (the pin's plan names `lane: 'durable'` and the pin fails `expected false to be true`), and the pin's figures are read on the assembled tree.
  _Why:_ A pin of existing behaviour has no natural red; the mutation shows it bites. _Cost if wrong:_ None.
- **R-I2b-42:** (Assembly; Task 9's last commit.) The delivered line goes on the QoS plan's §10.1 bullet "**I2b, checkpointed durability:**" (QoS §8 holds the I2a storage-lifetime bullets and has no I2b bullet; §4 states the `local-checkpoint` contract).
  _Why:_ §10.1 is where the slice is listed. _Cost if wrong:_ One line moves.
- **R-I2b-43:** (Controller, 2026-10-03; replaces the shape of R-I2b-38.) `initialiseMiddleware` returns a two-field result `{ middleware: RallarBrowserMiddleware; checkpoints: readonly ALCheckpointPort[] }` (or the named interface `BrowserConnectedMiddleware` with exactly those two fields), never an object that carries an extra runtime property beyond the public type. The facade identity tests keep passing because `middleware` is the same object; the lifecycle adapter takes `checkpoints`.
  _Why:_ A runtime field absent from the public type is hidden surface. _Cost if wrong:_ Thirteen test-double retypes move again (as assembled: twenty-five test files answer `{ middleware, checkpoints: [] }` from their `initialiseMiddleware` mock; the test double is unchanged).
- **R-I2b-44:** (Controller, 2026-10-03.) Delete the writer's ownership subscription that can never fire once the dirty set and writer are built only while owned (R-I2b-28/R-I2b-37); the takeover path is `ALCheckpoint`'s alone.
  _Why:_ Dead code is a reader's false lead. _Cost if wrong:_ A missed arm after takeover, which the Task 4 takeover test must pin (it does: after the takeover, with no flush, the interval checkpoint saves every row the runtime holds).
- **R-I2b-45:** (Controller, 2026-10-03.) In Task 3's commit, make `inbound-admission-diagnostics.test.ts`'s "settles the claim as a retry … over indexeddb" wait for the drain event it asserts (the existing wait helper of that file or its siblings), as a test-intent fix stated in the Task 3 text; never widen a timeout.
  _Why:_ `commit()` changes IndexedDB completion timing and the test read the event without waiting. _Cost if wrong:_ One more flaky red classified at the close.
- **R-I2b-46:** (Controller, 2026-10-03.) The writer takes no `ownership` input and has no `isOwned()` guard; ownership is `ALCheckpoint`'s concern alone (it builds the dirty set and the writer only while owned, R-I2b-28/R-I2b-37/R-I2b-44). Remove the input from `ALCheckpointWriter`, its construction sites in Task 4/5 code, and the writer test that exercised the guard (replace it with nothing; the takeover test in Task 4 pins the arm).
  _Why:_ A guard that cannot fail is a false lead. _Cost if wrong:_ A write from a non-owner, which the Task 4 takeover test and the D55 pin would show. (As assembled: the one construction site is `ALCheckpoint.createTracking` in Task 4; Task 5 builds no writer; the takeable-ownership test helper moved from Task 3's support module to Task 4, its first user.)

## Corrections to the proposal and the roadmap

Task 9's PR body carries these corrections. The proposal, the QoS plan and the roadmap are left as written; they are design records.

1. **The refusal is `seq` only** (D131). QoS §4 "Restrictions" and §5's "`local-checkpoint` therefore refuses ordered and latest-wins sends" read: only a send with a client `seq` is refused `unsupported`; an ordering key alone and latest-wins pass.
2. **Capture and write are changed rows** (D129). QoS §4's "one readwrite that replaces the previous point" is the lane's changed rows in the existing `entries` and `alm-work` stores (QoS §7.5 item 4); an interrupted write leaves the prior rows intact.
3. **The two session-store settings have defaults** (D133): 1,000 ms and 10,000 ms, optional on `ConfigureBrowserALRuntimeStoresInput` (R-I2b-24).
4. **No schema-id bump** (R-I2b-1). D84's bump clause is overtaken by D129: nothing persisted changes shape.
5. **The roadmap row "4 I2b" stands**; its "Relic Hunters commands as the consumer" is D134.
6. **Dirty tracking has no `entries()` export** (R-I2b-17, R-I2b-37). Proposal §2.c's `entries()` is `peek(key)` beside a keyed `onChangeDo(listener)` on both memory stores (a capture reads only dirty keys, without the lazy expiry of `getItem`/`read`), plus `peekKeys()` for the takeover's marking.
7. **A failed write delays; only the bound fails** (W-B's refinement, R-I2b-19). Proposal §2.d's "`failing` with cause `checkpoint-lag` when it exceeds the bound or a write fails" reads: a failed write leaves its keys unsaved and is retried an interval later; the next check states `delayed`, naming the write's own cause; `failing` with `checkpoint-lag` comes only at the lag bound, naming the last failed write.
8. **The commit is issued once the last request is** (R-I2b-36, confirmed). D135's amendment and proposal §2.i say the shared mutation writer calls `transaction.commit()` for every caller "at once"; it calls it once the write's last request is issued, and never for a write with a deadline.
9. **The lifecycle adapter flushes ports, not the middleware** (R-I2b-22, R-I2b-43). There is no `flushCheckpoints()` on `RallarBrowserMiddleware`; `initialiseMiddleware` returns `{ middleware, checkpoints }` and the adapter receives the two `ALCheckpointPort`s.
10. **A takeover marks the live rows** (R-I2b-28, R-I2b-37). Proposal §2.e/2.f's "mark nothing dirty" holds for a runtime that owned the work from its connect; a runtime that takes the work over tracks nothing while it waits and marks every row it holds once its restore ran, so its first checkpoint rewrites the restored rows.
11. **The checkpoint code lives in `packages/shared/alm/checkpoint/`** (R-I2b-17), not in `alm/storage/` as the frame first sketched; the store ids live in `browser-al-checkpoint-store-ids.ts`, not in `browser-al-runtime-identity.ts` (R-I2b-33), which keeps the identity file under twelve runtime exports.
12. **The flush-on-hide proof is a synthetic freeze and a crash** (D135 amended). CDP `Page.setWebLifecycleState` is a measured no-op on headless Chromium.
13. **The budgets** (R-I2b-39). R-I2b-23's `browser/rallar.ts` 237 and headless 301 became 236 at Task 4 and 238 / 303 at Task 5 on the assembled tree.

## Limits (carried; Task 9 states them in the PR body)

- **A non-owner's rows are not checkpointed** (D132, R-I2b-6). A waiting tab's `local-checkpoint` sends dispatch from its own memory and die with the tab; their `admitted` verdict reads `durable: false`. Cross-tab coverage is a follow-up.
- **The loss window is one interval, and more at an unload** (D134, R-I2b-7). What was admitted after the last completed checkpoint is lost with the page: up to one interval target (1,000 ms), more when the page ends before its hide flush lands. An interrupted checkpoint leaves the previous one intact. A Relic command admitted inside the last interval reads `unobservable` after a reload.
- **An unload-time flush may not land even with `commit()`** (R-I2b-25, R-I2b-36). Measured on headless Chromium (W-D's probe): a readwrite started in a `pagehide` listener landed 0/4 on reload and 0/4 on close without `IDBTransaction.commit()`, 2/4 and 3/4 with it. A write with a deadline (a durable admission with an execution deadline) keeps the browser's own commit.
- **The browser's real freeze and hide are unproven in the lane; H5 stays unmeasured** (D135 amended, R-I2b-7). `flush-on-hide` dispatches a synthetic `freeze` on the document, waits 250 ms and crashes the page through CDP; it proves that a flush begun in the lifecycle listener lands before an abrupt end, not that a phone's browser runs the listener or completes the write.
- **`flush-on-hide`'s attribution rests on timing** (R-I2b-26). The owner page must end inside the 1 s interval after the send (the cell waits 250 ms); a page that ends later lets the interval's write, not the flush, save the row.
- **A handed-over message can be restored by both carriers** (R-I2b-29). A message handed over from RTC to WS may be restored by both carriers' checkpoint pairs after a reload; the receiver's msgId dedup drops the duplicate and the RTC copy settles not-ready or exhausted.
- **No lag check while a write is in flight** (R-I2b-30). A hung transaction delays the lag statement until IndexedDB aborts it.
- **The server treats the tier as routed** (Global Constraints). `shouldAwaitALRoute` treats any non-volatile value as routed, so the WS server awaits the route for a `local-checkpoint` message as for `local-outbox`; receivers keep it in memory.
- **The inbound memory lane is not checkpointed** (proposal §5). A receiver's dedup state for the tier dies with its page, as it does for `local-outbox` receivers today.
- **A takeover rewrites the restored rows once** (R-I2b-28, R-I2b-37), one write of the live rows at the first checkpoint after the takeover.
- **`missing` IndexedDB refuses the tier** (R-I2b-19), by default, or downgrades it with a note under `onStorageUnavailable: 'volatile'`.
- **`delayed` is stated on a late timer or a failed write** (R-I2b-5). A checkpoint that starts on time and completes reads `healthy` throughout; health and ownership reach their listeners one turn late (the availability's lag skip and a hide right at a takeover lag by one turn).
- **The 540 s carrier-test ceiling is an estimate** (R-I2b-34): the fallback baseline cell measured 7.1 min before this plan and gains about 90 s; Task 9 re-measures the longest cell and states the margin.
- **No hosted checkpoint proof** (R-I2b-8, R-I2b-35). `flush-on-hide` is Playwright-only (the `same-context` family, which the hosted manifests never select); `checkpoint-recovery` and `checkpoint-lag` are withheld from hosted manifest 18 on every carrier, so manifests 18 and 22 are byte-identical and their hosted runs are regression reads. The observation job's full read runs all three cells.
- **The pair's IndexedDB connection is opened per connect and not closed** (R-I2b-32), as the durable pair's is.
- **Task 5's lag tests run on real timers** (R-I2b-40) with 20 / 100 ms settings.

---

### Task 1: Vocabulary and routing — `local-checkpoint`, the `checkpoint` store lane, `plan.lane`, the `seq` refusal

Prototyped in scratch as commit `2348174ec` on `5e06c6ab0` (red then green). Decisions D84 (one durability axis,
`volatile` < `local-checkpoint` < `local-outbox` < `local-inbox`), D130 (`ALStoreDurability` gains `'checkpoint'`;
the three `shouldPersistOutbox` consumers get a three-way answer), D131 (the refusal is `seq` only; an ordering key
alone and latest-wins pass; narrows D85 as D118 asked) and D3 (no compatibility path: an older peer refuses the value
as malformed). Rulings R-I2b-1 (no schema-id bump: no persisted row shape changes in this task) and R-I2b-2 (the
checkpoint lane's own store ids are Task 4's). Facts: surprise 1 (`shouldPersistOutbox` = non-volatile at
`al-policy.ts:394`; lane choice by a boolean at `al-outbound-message-runtime.ts:627`), surprise 2 and the controller
check (every room send carries `ordering.orderingKey`, `browser-rallar-message-sender.ts:406-407`, so the refusal keys
on `seq`), §1 (the vocabulary lists and their five harness copies), §2 (`ALOutboundDispatchPlan.persist` `:155`).

**Assembly.** Commit `13125ae0d` on `5e06c6ab0` in the composed chain: W-A's patch applied unchanged, so every figure
below is the assembled commit's. Bundle figures are read with a private `TMPDIR` (R-I2b-23): the bundle script and the headless boundary test write
under `os.tmpdir()`, which every worktree of the machine shares. After every `cd apps/api-v1 && deno task check`, run
`rm -rf apps/api-v1/node_modules/.deno` and `find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete` (a
left-behind `.deno` breaks the next check).

**The one-task bridge (removed in Task 4).** This task makes `'checkpoint'` a legal plan lane but adds no checkpoint
lane. Until Task 4 builds it, `ALOutboundMessageRuntime.resolveLaneForPlan` sends a `checkpoint` plan to the durable
lane (IndexedDB), the lane every non-volatile plan reached before this task. Task 4 replaces `resolveLaneForPlan`
with a three-way choice over `durable`, `checkpoint` and `volatile`, and deletes the class doc's bridge sentence and
the README's "while the runtime holds no checkpoint lane" clause; no part of the bridge survives the plan.

**Files**

- Modify: `packages/shared/al-contracts/al-policy.ts` — `ALDurabilityAlgo` gains `'local-checkpoint'` (`:50`);
  `shouldPersistOutbox` (`:393-396`) is deleted and replaced by `resolveALOutboundStoreDurability(durability)` over an
  exhaustive `Record<ALDurabilityAlgo, ALStoreDurability>`; the handling plan's `forwarding.persist` (`:531`) reads
  it (`!== 'volatile'`); `shouldAwaitALRoute`'s doc no longer names the deleted function. One type-only import of
  `ALStoreDurability` (the file already type-imports from `alm/` siblings in `al-contracts`, e.g.
  `al-control.ts:1`).
- Modify: `packages/shared/al-contracts/normalize-al-qos-policy.ts` — `AL_DURABILITY_ALGOS` (`:89`),
  `DURABILITY_ORDER` (`:111-115`, both in the D84 order) and the normalization preference (`:420`, between
  `local-outbox` and `volatile`).
- Modify: `packages/shared/alm/al-runtime-stores.ts` — `ALStoreDurability = 'volatile' | 'checkpoint' | 'durable'`
  (`:51-56`) and its doc.
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` — `ALOutboundDispatchPlan.persist: boolean`
  (`:155`) becomes `lane: ALStoreDurability`; `resolveLaneForPlan` (`:626-628`) reads it (the bridge above); the class
  doc (`:401-404`).
- Modify: `packages/shared/alm/outbound/admission/al-outbound-admission-validation.ts` — the captured policy row keeps
  its `persist: boolean` (a persisted row field, R-I2b-1), now documented; `captureALOutboundPolicy` stores
  `plan.lane !== 'volatile'`; new `toALOutboundCapturedLane(policy)`; `applyALOutboundCapturedPolicy` keeps the re-plan's
  lane when it agrees with the row, else the row's.
- Modify: `packages/shared/alm/outbound/al-outbound-message-effects.ts` (`:404`, the retained pending admission's plan),
  `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts` (`:95`, the route verdict reads
  `lane !== 'volatile'`), `packages/shared/alm/outbound/admission/compute-al-outbound-ack-refusal.ts` (`:31`).
- Create: `packages/shared/alm/outbound/admission/compute-al-outbound-ordering-refusal.ts` —
  `computeALOutboundOrderingRefusal`.
- Modify (planners): `packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts` (`:57` and
  the refusal chain), `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts` (`:533`, `:561`, `:618`, `:647`,
  `:661`, `:668`, `:685`, `:696`, `:707`, `:715`, `:932`, `:940`), `packages/shared/multicast/web-rtc-overlay-frozen-audience.ts`
  (`:76`, `:129`), `packages/shared/multicast/web-rtc-overlay-missing-recipient-repair.ts` (`:99`).
- Modify (server, vocabulary only): `packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts`
  (`:139`, `:165-166`, `:185`, `:256`, `:341`; the local `persist` becomes `awaitsRoute`),
  `ws-queue-box-server-control-delivery.ts:83`, `ws-queue-box-server-receipt-aggregation.ts:298`,
  `ws-queue-box-server-service.ts:420`. The server builds its runtime without a memory pair, so every server plan still
  runs in its one lane; `lane: 'durable'`/`'volatile'` reproduces `persist: true`/`false` exactly.
- Modify (web): `packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts:42` (the text),
  `packages/shared-web/browser/messages/rallar-message-contracts.ts:116` (the doc).
- Modify (harness lists, facts §1): `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts:330`
  (`ALDurabilityAlgo`, one canonical name instead of a literal copy), `.../conformance/alm/alm-conformance-message-commands.ts:32`
  (`Exclude<ALDurabilityAlgo, 'volatile'>`), `.../alm/decode-alm-delivery-failure.ts:58-62` (the exhaustive record),
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts:179`
  (the text), `.../schema/rallar-black-box-command-fields.ts:299` (reads `AL_DURABILITY_ALGOS`, unchanged); plus the
  capability text `.../alm/rallar-black-box-alm-command-capabilities.ts:15` and its doc
  `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md:157`; the observation decoder
  `.../conformance/alm/alm-observation-snapshot.ts:416-421` accepts `'checkpoint'` (it decodes an `ALStoreDurability`).
- Modify: `tests/playwright/alm/harness/create-durable-send-harness.ts:198` (a plan literal),
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts:280`
  (a plan literal, swept in Step 7).
- Modify: `packages/shared/alm/outbound/README.md` (routing by durability, the refusal, the diagnostic lane).
- Modify: `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (299 → 300, measured 299.144).
- Test (create): `packages/tests/shared/alm/outbound/al-outbound-checkpoint-ordering-refusal.test.ts`.
- Test (modify, red): `packages/tests/shared/al-policy.test.ts`, `.../shared/alm/outbound/apply-al-outbound-captured-policy.test.ts`,
  `.../shared-web/messages/browser-typed-message-channels.test.ts`, `.../shared-test/rallar-browser-runtime/delivery.test.ts`,
  `.../shared-test/alm-delivery-failure-decoding.test.ts`, `.../shared-test/alm-observation-regime.test.ts`,
  `.../shared/services/to-ws-queue-box-client-dispatch-plan.test.ts`.
- Test (modify, the field rename): the 56 files of Step 7's list (55 under `packages/tests/**` plus the shared-test
  composition above), and `.../shared/services/ws-queue-box-server-outbound-planning.test.ts:171`,
  `.../shared/services/ws-room-provenance-planning.test.ts:53`. Of the pins, only plan literals change
  (`al-indexeddb-operation-counts.test.ts` 4 literals, `al-indexeddb-transaction-ledger.test.ts` 1,
  `al-storage-snapshot.test.ts` 1); their constants and assertions are unedited.

**Readers of the three `persist` fields, enumerated (the frame's sweep).**

| Field                                          | Readers at `5e06c6ab0`                                                                                                                                                                                                   | After this task                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ALOutboundDispatchPlan.persist`               | `resolveLaneForPlan` `:627`; route verdict `compute-al-outbound-dispatch.ts:95`; `captureALOutboundPolicy` `al-outbound-admission-validation.ts:50`; server `ws-queue-box-server-service.ts:420` (decode before enqueue) | `lane`; each reads `lane` (`!== 'volatile'` where a boolean is meant)                                                                                                                                                                                                                                                                                                                                                          |
| `ALMessageHandlingPlan.forwarding.persist`     | `isRtcCarrierGapHeld` `compute-rtc-outbound-carrier-availability.ts:119`; `planOutboundDispatch` `web-rtc-overlay-multicast-manager.ts:715`; decoder `decode-al-inbound-plan.ts:113-120`                                 | **stays a boolean**: the handling plan is persisted in inbound rows and decoded field by field, so its shape is a row shape (R-I2b-1). It now means "kept beyond the volatile lane" (true for `local-checkpoint`, so a carrier gap holds a checkpoint send as it holds a `local-outbox` one). `:715` reads the lane from the plan's effective durability instead (equivalent: that branch runs only for a plan without a drop) |
| `ALMessageHandlingPlan.localDelivery.persist`  | decoder `decode-al-inbound-plan.ts:106-108` only                                                                                                                                                                         | unchanged: inbound, `shouldPersistInbox`                                                                                                                                                                                                                                                                                                                                                                                       |
| `ALOutboundCapturedPolicy.persist` (persisted) | `applyALOutboundCapturedPolicy` `:90`; `toALOutboundRetainedDispatchPlan` `al-outbound-message-effects.ts:404`; the pending-admission compare `al-outbound-pending-admission.ts:101`                                     | **stays a boolean** (a persisted outbound row field, IndexedDB and Postgres; R-I2b-1). `toALOutboundCapturedLane` turns it back into a lane where no re-plan exists; a re-plan keeps its own lane when it agrees                                                                                                                                                                                                               |

**Unchanged on purpose.** `shouldPersistInbox` (only `local-inbox` persists on the receiver); `resolveALInboundStoreDurability`
(`inbound/lane/resolve-al-inbound-store-durability.ts:9-11` already routes `local-checkpoint` to memory, as QoS §4 "Wire"
says receivers do); `shouldAwaitALRoute` (`al-policy.ts:403`: any non-volatile value waits for a route, so the WS server
and the RTC missing-peer check treat the tier as routed, like `local-outbox`); `browser-rallar-message-dispatch.ts:237-239`
(a non-volatile request with IndexedDB missing follows `onStorageUnavailable`; the checkpoint needs storage too);
`al-control.ts:293,344` (controls stay volatile). The inbound lanes, the inbound README (`lane: 'durable' | 'volatile'`
stays true there: inbound lanes never name `checkpoint`) and the settlement relay (`browser-delivery-settlements.ts:49`,
Task 4) are untouched.

**Interfaces**

- Consumes: nothing new.
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // packages/shared/al-contracts/al-policy.ts
  export type ALDurabilityAlgo = 'volatile' | 'local-checkpoint' | 'local-outbox' | 'local-inbox';
  export function resolveALOutboundStoreDurability(durability: ALDurabilityAlgo): ALStoreDurability;
  //   volatile -> 'volatile'; local-checkpoint -> 'checkpoint'; local-outbox, local-inbox -> 'durable'
  // (shouldPersistOutbox is deleted)
  // packages/shared/alm/al-runtime-stores.ts
  export type ALStoreDurability = 'volatile' | 'checkpoint' | 'durable';
  // packages/shared/alm/outbound/al-outbound-message-runtime.ts
  export interface ALOutboundDispatchPlan<TPrepared> {
      /** The store lane the admission runs in: the message's durability, or `volatile` for a dropping plan. */
      readonly lane: ALStoreDurability;   // replaces `persist: boolean`
      // every other field unchanged
  }
  // packages/shared/alm/outbound/admission/al-outbound-admission-validation.ts
  export function toALOutboundCapturedLane(policy: ALOutboundCapturedPolicy): ALStoreDurability; // persist ? 'durable' : 'volatile'
  // packages/shared/alm/outbound/admission/compute-al-outbound-ordering-refusal.ts
  export interface ComputeALOutboundOrderingRefusalInput {
      readonly msg: ALMessage;
      readonly policy: ALQosNormalizationResult;
  }
  export function computeALOutboundOrderingRefusal<TPrepared>(
      input: ComputeALOutboundOrderingRefusalInput
  ): Either<ALOutboundDispatchPlan<TPrepared>, ALMessage>;
  //   Left { msg, dropReason: `A local-checkpoint send cannot carry sequence ${seq}`, dropReasonCode: 'unsupported',
  //          lane: 'volatile', preparedMessages: [] } when effective durability is local-checkpoint and msg.ordering?.seq !== undefined
  ```

  Refinement of the decided shape `computeALOutboundOrderingRefusal(plan, msg)`: it takes the same input as its sibling
  `computeALOutboundAckRefusal` (`{ msg, policy }`) and returns the same `Either`, so both planners chain it between
  the ack refusal and the RTC frozen-audience refusal. It runs in the two browser origin planners only (WS client,
  RTC `planOutgoingMessage`), never on the server, which only relays a client's message; a refused plan names the
  `volatile` lane as every other dropping plan does, so it is stated without a storage operation. The verdict is
  `{ kind: 'refused', reason: 'unsupported', detail }` (`compute-al-outbound-dispatch.ts:249-272`).

**D8 reuse inspection.** The refusal reuses the ack refusal's shape, its `Either` and its `unsupported` drop code (the
existing refusal path to `refused/unsupported`); no new verdict or code. The lane type is the existing
`ALStoreDurability`, widened, not a second union; `resolveALOutboundStoreDurability` is one exhaustive record, so a
fifth durability fails the compile instead of silently landing in IndexedDB (surprise 1). The vocabulary lists stay
the existing ones, widened; the harness contract type and the conformance send type now name `ALDurabilityAlgo`
instead of copying its literals, which removes two of the five copies. No store, cache, list or registry is added,
and no persisted shape changes (`ALOutboundCapturedPolicy.persist` and the handling plan's `forwarding.persist` stay
booleans).

**Limits.**

- The bridge: a `local-checkpoint` send admitted in a Task 1 tree commits to IndexedDB like `local-outbox`. No caller
  sends `local-checkpoint` until Task 8 (Relic), and Task 4 replaces the routing.
- A captured row records only whether its copy outlives memory. Where a re-plan disagrees with it (a drop re-plan of a
  persisted message), the applied plan reads `durable`; the only readers of an applied plan's lane are the route
  verdict and the pending-admission compare, both of which read only "volatile or not", and lane selection for an
  existing message is by `ownsMessage`, not by the plan.
- `AL_DURABILITY_ALGOS` and `DURABILITY_ORDER` hold the same four values in the same order; they stay two names
  because one is a capability set and the other a ranking (as at base).
- Older peers refuse `local-checkpoint` as a malformed `qos.durability` (`assert-persisted-al-qos.ts:21`): the D3
  cutover, with no compatibility path.

- [ ] **Step 1: Write the failing tests.**

  (a) Create `packages/tests/shared/alm/outbound/al-outbound-checkpoint-ordering-refusal.test.ts`:

<!-- dprint-ignore -->
```ts
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy, type ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import { computeALOutboundOrderingRefusal } from '@shared/alm/outbound/admission/compute-al-outbound-ordering-refusal.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

import {
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM
} from '../../multicast/rtc-origin-overlay-fixture.ts';

const WS_CONTEXT = {
    sessionId: 'a',
    serverPeerId: 'server',
    socketOpen: true,
    qosProvider: toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined)
};

interface RoomSendInput {
    readonly durability: ALDurabilityAlgo;
    readonly seq?: number;
    readonly orderingKey?: string;
    readonly latestWins?: boolean;
}

function roomSend(resourceId: string, input: RoomSendInput): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'room.state', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'room.state.v1',
        { resourceId },
        {
            ttlMs: 30_000,
            seq: input.seq,
            orderingKey: input.orderingKey,
            qos: {
                durability: { algo: input.durability },
                ...(input.latestWins ? { supersedence: { algo: 'latest-wins' as const } } : {})
            }
        }
    );
}

describe('the checkpointed tier refuses a client sequence', () => {
    it('refuses a local-checkpoint send that carries a seq as unsupported, kept in memory', () => {
        const msg = roomSend('sequenced', { durability: 'local-checkpoint', seq: 4 });

        const refusal = computeALOutboundOrderingRefusal({ msg, policy: normalizeALQosPolicy(msg) });

        expect(refusal.left).toMatchObject({
            msg,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
        expect(refusal.left?.dropReason).toContain('local-checkpoint');
    });

    it.each([
        { name: 'an ordering key alone', input: { durability: 'local-checkpoint' as const, orderingKey: 'track' } },
        { name: 'latest-wins supersedence', input: { durability: 'local-checkpoint' as const, latestWins: true } },
        { name: 'a seq on local-outbox', input: { durability: 'local-outbox' as const, seq: 4 } },
        { name: 'a seq on volatile', input: { durability: 'volatile' as const, seq: 4 } }
    ])('passes $name', ({ input }) => {
        const msg = roomSend('passes', input);

        const refusal = computeALOutboundOrderingRefusal({ msg, policy: normalizeALQosPolicy(msg) });

        expect(refusal.right).toBe(msg);
    });
});

describe('the WS client plan of a checkpointed send', () => {
    it('names the checkpoint lane for a room send with only its default ordering key', () => {
        const plan = toWsQueueBoxClientDispatchPlan(roomSend('room-send', { durability: 'local-checkpoint' }), WS_CONTEXT);

        expect(plan.dropReasonCode).toBeUndefined();
        expect(plan.lane).toBe('checkpoint');
        expect(plan.preparedMessages).toHaveLength(1);
    });

    it('refuses a sequenced send before it plans a copy', () => {
        const plan = toWsQueueBoxClientDispatchPlan(
            roomSend('sequenced', { durability: 'local-checkpoint', seq: 1 }),
            WS_CONTEXT
        );

        expect(plan).toMatchObject({ dropReasonCode: 'unsupported', lane: 'volatile', preparedMessages: [] });
    });
});

describe('the RTC origin plan of a checkpointed send', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('admits a room send that carries only the default ordering key', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b']
        });
        const message = roomSend('room-send', { durability: 'local-checkpoint' });

        const admitted = await enqueueAndDrain(fixture.manager, message);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(fixture.channels.b!.sent.map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
    });

    it('refuses a sequenced room send as unsupported and sends nothing', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b']
        });

        const refused = await enqueueAndDrain(
            fixture.manager,
            roomSend('sequenced', { durability: 'local-checkpoint', seq: 1 })
        );

        expect(refused.verdict).toEqual({
            kind: 'refused',
            reason: 'unsupported',
            detail: 'A local-checkpoint send cannot carry sequence 1'
        });
        expect(fixture.channels.b!.sent).toEqual([]);
    });
});
```

(b) The policy, the captured lane, the channel validator, the observation decoder, the failure decoder and the WS
plan:

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/al-policy.test.ts b/packages/tests/shared/al-policy.test.ts
index b8a680259..780fe0416 100644
--- a/packages/tests/shared/al-policy.test.ts
+++ b/packages/tests/shared/al-policy.test.ts
@@ -14,10 +14,10 @@ import {
 import {
     normalizeALQosPolicy,
     planALMessageHandling,
+    resolveALOutboundStoreDurability,
     resolveALQosNormalizationInput,
     shouldAwaitALRoute,
     shouldPersistInbox,
-    shouldPersistOutbox,
     type ALMessagePlanningContext,
     type ALQosInputProvider,
     type ALQosNormalizationInput
@@ -729,15 +729,16 @@ describe('durability decoupled from retry (S3a)', () => {
 
         expect(effective.durability.algo).toBe('volatile');
         expect(effective.retry.algo).toBe('exp-backoff');
-        expect(shouldPersistOutbox(effective)).toBe(false);
+        expect(resolveALOutboundStoreDurability(effective.durability.algo)).toBe('volatile');
         expect(shouldAwaitALRoute(effective)).toBe(true);
     });
 
     it.each([
-        { algo: 'volatile' as const, outbox: false, inbox: false },
-        { algo: 'local-outbox' as const, outbox: true, inbox: false },
-        { algo: 'local-inbox' as const, outbox: true, inbox: true }
-    ])('honours a requested $algo: outbox $outbox, inbox $inbox', ({ algo, outbox, inbox }) => {
+        { algo: 'volatile' as const, outbox: 'volatile', inbox: false },
+        { algo: 'local-checkpoint' as const, outbox: 'checkpoint', inbox: false },
+        { algo: 'local-outbox' as const, outbox: 'durable', inbox: false },
+        { algo: 'local-inbox' as const, outbox: 'durable', inbox: true }
+    ])('honours a requested $algo: outbox lane $outbox, inbox $inbox', ({ algo, outbox, inbox }) => {
         const message = newALMulticastMessage('self', route, room, 'chat.message.v1', {}, {
             reliability: 'at-least-once',
             qos: { durability: { algo } }
@@ -746,10 +747,45 @@ describe('durability decoupled from retry (S3a)', () => {
         const { effective } = normalizeALQosPolicy(message);
 
         expect(effective.durability.algo).toBe(algo);
-        expect(shouldPersistOutbox(effective)).toBe(outbox);
+        expect(resolveALOutboundStoreDurability(effective.durability.algo)).toBe(outbox);
         expect(shouldPersistInbox(effective)).toBe(inbox);
     });
 
+    it('lets a best-effort checkpointed message wait for a route and forwards it as kept beyond memory', () => {
+        const message = newALMulticastMessage('self', route, room, 'chat.message.v1', {}, {
+            qos: { durability: { algo: 'local-checkpoint' } }
+        });
+        const { effective } = normalizeALQosPolicy(message);
+
+        const plan = planALMessageHandling(message, {
+            nowMs: message.id.ts,
+            selfPeerId: 'self',
+            groupMemberPeerIds: ['self', 'peer'],
+            overlayNeighborPeerIds: ['peer'],
+            connectedPeerIds: ['peer']
+        });
+
+        expect(shouldAwaitALRoute(effective)).toBe(true);
+        expect(plan.forwarding.persist).toBe(true);
+        expect(plan.localDelivery.persist).toBe(false);
+    });
+
+    it.each([
+        { requested: 'local-outbox' as const, maxDurability: 'local-checkpoint' as const, effective: 'local-checkpoint' },
+        { requested: 'local-checkpoint' as const, maxDurability: 'volatile' as const, effective: 'volatile' },
+        { requested: 'local-checkpoint' as const, maxDurability: 'local-outbox' as const, effective: 'local-checkpoint' }
+    ])('ranks local-checkpoint between volatile and local-outbox: $requested under $maxDurability is $effective', (
+        { requested, maxDurability, effective }
+    ) => {
+        const message = newALMulticastMessage('self', route, room, 'chat.message.v1', {}, {
+            qos: { durability: { algo: requested } }
+        });
+
+        const normalized = normalizeALQosPolicy(message, { authorization: { maxDurability } });
+
+        expect(normalized.effective.durability.algo).toBe(effective);
+    });
+
     it('lets a best-effort volatile message be refused for lacking a route', () => {
         const message = newALMulticastMessage('self', route, room, 'chat.typing.v1', {});
 
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/alm/outbound/apply-al-outbound-captured-policy.test.ts b/packages/tests/shared/alm/outbound/apply-al-outbound-captured-policy.test.ts
index 07d91dd34..4a522bd83 100644
--- a/packages/tests/shared/alm/outbound/apply-al-outbound-captured-policy.test.ts
+++ b/packages/tests/shared/alm/outbound/apply-al-outbound-captured-policy.test.ts
@@ -1,8 +1,10 @@
 import { describe, expect, it } from 'vitest';
 
 import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
+import type { ALStoreDurability } from '@shared/alm/al-runtime-stores.ts';
 import {
     applyALOutboundCapturedPolicy,
+    captureALOutboundPolicy,
     type ALOutboundCapturedPolicy
 } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
 import type {
@@ -83,6 +85,28 @@ describe('a re-plan under the policy its message was admitted with', () => {
     });
 });
 
+describe('the lane of a re-plan under its captured policy', () => {
+    it.each([
+        { lane: 'volatile' as const, persist: false },
+        { lane: 'checkpoint' as const, persist: true },
+        { lane: 'durable' as const, persist: true }
+    ])('captures a $lane plan as persist $persist', ({ lane, persist }) => {
+        expect(captureALOutboundPolicy(replan({}, lane)).persist).toBe(persist);
+    });
+
+    it.each([
+        { planned: 'checkpoint' as const, persist: true, lane: 'checkpoint' },
+        { planned: 'durable' as const, persist: true, lane: 'durable' },
+        { planned: 'volatile' as const, persist: false, lane: 'volatile' },
+        { planned: 'volatile' as const, persist: true, lane: 'durable' },
+        { planned: 'checkpoint' as const, persist: false, lane: 'volatile' }
+    ])('keeps a $planned re-plan under persist $persist in the $lane lane', ({ planned, persist, lane }) => {
+        const applied = applyALOutboundCapturedPolicy(replan({}, planned), { ...captured(null), persist });
+
+        expect(applied.lane).toBe(lane);
+    });
+});
+
 function tracking(
     mode: ALOutboundAckTrackingPlan['mode'],
     expectedPeerIds: readonly string[],
@@ -110,12 +134,13 @@ function captured(ackTracking: ALOutboundAckTrackingPlan | null): ALOutboundCapt
 }
 
 function replan(
-    overrides: Pick<ALOutboundDispatchPlan<never>, 'ackTracking' | 'receiptNextHopPeerIds'>
+    overrides: Pick<ALOutboundDispatchPlan<never>, 'ackTracking' | 'receiptNextHopPeerIds'>,
+    lane: ALStoreDurability = 'volatile'
 ): ALOutboundDispatchPlan<never> {
     return {
         msg: MESSAGE,
         dropReasonCode: undefined,
-        persist: false,
+        lane,
         preparedMessages: [],
         ...overrides
     };
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/messages/browser-typed-message-channels.test.ts b/packages/tests/shared-web/messages/browser-typed-message-channels.test.ts
index ed92a2206..76401926f 100644
--- a/packages/tests/shared-web/messages/browser-typed-message-channels.test.ts
+++ b/packages/tests/shared-web/messages/browser-typed-message-channels.test.ts
@@ -536,10 +536,15 @@ describe('Rallar typed message channel', () => {
             .toThrow(
                 expect.objectContaining({
                     issues: [
-                        expect.objectContaining({ path: '$.durability', code: 'invalid-durability' })
+                        expect.objectContaining({
+                            path: '$.durability',
+                            code: 'invalid-durability',
+                            message: 'Durability must be volatile, local-checkpoint, local-outbox or local-inbox.'
+                        })
                     ]
                 })
             );
+        expect(define({ typeId: 'chat.message.v1', purpose: 'command', durability: 'local-checkpoint' })).not.toThrow();
         expect(define({ typeId: 'chat.message.v1', purpose: 'command', onStorageUnavailable: 'drop' })).toThrow(
             expect.objectContaining({
                 issues: [
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-test/alm-observation-regime.test.ts b/packages/tests/shared-test/alm-observation-regime.test.ts
index 740d2bff3..0c1aecd5b 100644
--- a/packages/tests/shared-test/alm-observation-regime.test.ts
+++ b/packages/tests/shared-test/alm-observation-regime.test.ts
@@ -922,12 +922,13 @@ describe('decodeALMObservationSnapshot', () => {
             events: [
                 toLaneNamedEvent(toCommitPhaseEvent(1_000, 12, 'send'), 'volatile'),
                 toLaneNamedEvent(toCommitPhaseEvent(1_001, 12, 'send'), 'memory'),
+                toLaneNamedEvent(toCommitPhaseEvent(1_004, 12, 'send'), 'checkpoint'),
                 toLaneNamedEvent(toReadinessProbeEvent(1_002, SENDER_AGENT_ID, { cause: 'age-bound', durationMs: 0 }), 'volatile'),
                 toLaneNamedEvent(toReadinessProbeEvent(1_003, SENDER_AGENT_ID, { cause: 'age-bound', durationMs: 0 }), 7)
             ]
         });
 
-        expect(decoded.right?.commitPhases.map((phase) => phase.lane)).toEqual(['volatile']);
+        expect(decoded.right?.commitPhases.map((phase) => phase.lane)).toEqual(['volatile', 'checkpoint']);
         expect(decoded.right?.readinessProbes.map((probe) => probe.lane)).toEqual(['volatile']);
     });
 
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts b/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
index a05cb09a5..40fe6eede 100644
--- a/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
+++ b/packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
@@ -96,6 +96,13 @@ describe('the durability downgrade a delivery observation carries', () => {
             .toEqual(durabilityDowngrade);
     });
 
+    it('reads a downgraded local-checkpoint send', () => {
+        const durabilityDowngrade = { requested: 'local-checkpoint', cause: 'missing' };
+
+        expect(decodeAlmDeliveryResultValue({ ...OBSERVATION, durabilityDowngrade }).durabilityDowngrade)
+            .toEqual(durabilityDowngrade);
+    });
+
     it('reads an observation without a downgrade as none', () => {
         expect(decodeAlmDeliveryResultValue(OBSERVATION).durabilityDowngrade).toBeUndefined();
     });
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts b/packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts
index 6d1383de2..afcddbe2f 100644
--- a/packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts
+++ b/packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts
@@ -37,7 +37,7 @@ describe('the WS client dispatch plan', () => {
         const plan = toWsQueueBoxClientDispatchPlan(commandToServer(), CONTEXT);
 
         expect(plan).toMatchObject({
-            persist: true,
+            lane: 'durable',
             ackTracking: {
                 enabled: true,
                 mode: 'receiver',
```

(c) Only the decode hunks of `delivery.test.ts` here (its plan literal at `:335` is Step 7's sweep):

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts b/packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
index a4f90400e..4e34b6786 100644
--- a/packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
@@ -616,12 +616,14 @@ it('decodes a declared send durability and refuses an unknown one', () => {
 
     expect(decodeBlackBoxRallarMessageSendInput({ ...send, durability: 'local-outbox' }).right)
         .toMatchObject({ durability: 'local-outbox' });
+    expect(decodeBlackBoxRallarMessageSendInput({ ...send, durability: 'local-checkpoint' }).right)
+        .toMatchObject({ durability: 'local-checkpoint' });
     expect(decodeBlackBoxRallarMessageSendInput(send).right).toMatchObject({
         durability: undefined
     });
     expect(decodeBlackBoxRallarMessageSendInput({ ...send, durability: 'forever' }).left)
         .toEqual({
-            message: 'messages.send.durability must be volatile, local-outbox or local-inbox.'
+            message: 'messages.send.durability must be volatile, local-checkpoint, local-outbox or local-inbox.'
         });
 });
 
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared/al-policy.test.ts packages/tests/shared/alm/outbound/al-outbound-checkpoint-ordering-refusal.test.ts \
  packages/tests/shared/alm/outbound/apply-al-outbound-captured-policy.test.ts packages/tests/shared-web/messages/browser-typed-message-channels.test.ts \
  packages/tests/shared-test/alm-delivery-failure-decoding.test.ts packages/tests/shared-test/alm-observation-regime.test.ts \
  packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
```

Expected (measured at `5e06c6ab0`): `Test Files  8 failed (8)`, `Tests  18 failed | 177 passed (195)`: the refusal file
fails to load (`Cannot find package '@shared/alm/outbound/admission/compute-al-outbound-ordering-refusal.ts'`);
`al-policy.test.ts` 8 (`resolveALOutboundStoreDurability is not a function`, `expected 'volatile' to be
'local-checkpoint'`, `expected 'local-outbox' to be 'local-checkpoint'`, `expected false to be true`); the captured-lane
cases 5; one each in the channel validator (`expected error to match asymmetric matcher`), the delivery decoder
(`expected undefined to match object { durability: 'local-checkpoint' }`), the failure decoder, the observation
decoder (`expected [ 'volatile' ] to deeply equal [ 'volatile', 'checkpoint' ]`) and the WS plan
(`to match object { lane: 'durable', …(3) }`).

- [ ] **Step 3: The vocabulary and the selector.**

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/al-contracts/al-policy.ts b/packages/shared/al-contracts/al-policy.ts
index 4582922cb..2a0e10d0a 100644
--- a/packages/shared/al-contracts/al-policy.ts
+++ b/packages/shared/al-contracts/al-policy.ts
@@ -1,3 +1,4 @@
+import type { ALStoreDurability } from '../alm/al-runtime-stores.ts';
 import type { ALMessage, ALTargets } from './al-contract.ts';
 
 import type { ALOrderingObservation, ALSupersedenceObservation } from './al-runtime.ts';
@@ -47,7 +48,7 @@ export type ALFanoutAlgo = 'all' | 'limit' | 'random-k';
 
 export type ALCongestionAlgo = 'drop-low' | 'defer' | 'reject';
 
-export type ALDurabilityAlgo = 'volatile' | 'local-outbox' | 'local-inbox';
+export type ALDurabilityAlgo = 'volatile' | 'local-checkpoint' | 'local-outbox' | 'local-inbox';
 
 export type ALOwnershipAlgo = 'shared' | 'exclusive';
 
@@ -390,15 +391,22 @@ export function shouldPersistInbox(effective: ALQosEffectivePolicy): boolean {
     return effective.durability.algo === 'local-inbox';
 }
 
-/** The sender keeps its copy in browser storage exactly when the channel chose a durability above volatile. */
-export function shouldPersistOutbox(effective: ALQosEffectivePolicy): boolean {
-    return effective.durability.algo !== 'volatile';
+const AL_OUTBOUND_STORE_DURABILITY: Readonly<Record<ALDurabilityAlgo, ALStoreDurability>> = {
+    volatile: 'volatile',
+    'local-checkpoint': 'checkpoint',
+    'local-outbox': 'durable',
+    'local-inbox': 'durable'
+};
+
+/** The sender's store lane for a durability: memory, memory checkpointed to browser storage, or browser storage. */
+export function resolveALOutboundStoreDurability(durability: ALDurabilityAlgo): ALStoreDurability {
+    return AL_OUTBOUND_STORE_DURABILITY[durability];
 }
 
 /**
  * An admission that may wait for a route instead of being refused for lacking one: a message that
- * retries or persists. This is what `shouldPersistOutbox` meant before S3a; the WS server's recipient
- * resolution and the RTC missing-channel check keep that meaning.
+ * retries or is kept beyond the volatile lane. The WS server's recipient resolution and the RTC
+ * missing-channel check read it.
  */
 export function shouldAwaitALRoute(effective: ALQosEffectivePolicy): boolean {
     return effective.durability.algo !== 'volatile' || effective.retry.algo !== 'none';
@@ -528,7 +536,8 @@ function computeMessageDelivery(
         forwarding: {
             enabled: nextHopPeerIds.length > 0,
             nextHopPeerIds,
-            persist: !dropped && shouldPersistOutbox(decision.result.effective)
+            persist: !dropped &&
+                resolveALOutboundStoreDurability(decision.result.effective.durability.algo) !== 'volatile'
         }
     };
 }
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/al-contracts/normalize-al-qos-policy.ts b/packages/shared/al-contracts/normalize-al-qos-policy.ts
index 55f0f0924..1dc1a34df 100644
--- a/packages/shared/al-contracts/normalize-al-qos-policy.ts
+++ b/packages/shared/al-contracts/normalize-al-qos-policy.ts
@@ -86,7 +86,12 @@ interface ALAlgorithmAuthorizationPolicy<TAlgo extends string, TOpts extends obj
     readonly supported: readonly TAlgo[];
 }
 
-export const AL_DURABILITY_ALGOS: readonly ALDurabilityAlgo[] = ['volatile', 'local-outbox', 'local-inbox'];
+export const AL_DURABILITY_ALGOS: readonly ALDurabilityAlgo[] = [
+    'volatile',
+    'local-checkpoint',
+    'local-outbox',
+    'local-inbox'
+];
 
 export const DEFAULT_AL_QOS_CAPABILITIES: ALQosCapabilities = {
     supportedDelivery: ['best-effort', 'at-least-once'],
@@ -110,6 +115,7 @@ export const DEFAULT_AL_QOS_CAPABILITIES: ALQosCapabilities = {
 
 const DURABILITY_ORDER: readonly ALDurabilityAlgo[] = [
     'volatile',
+    'local-checkpoint',
     'local-outbox',
     'local-inbox'
 ];
@@ -417,7 +423,7 @@ function pickFallbackAlgorithm<TAlgo extends string>(
         supersedence: ['latest-wins', 'none'],
         fanout: ['limit', 'all', 'random-k'],
         congestion: ['drop-low', 'defer', 'reject'],
-        durability: ['local-inbox', 'local-outbox', 'volatile'],
+        durability: ['local-inbox', 'local-outbox', 'local-checkpoint', 'volatile'],
         ownership: ['shared', 'exclusive']
     };
 
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/al-runtime-stores.ts b/packages/shared/alm/al-runtime-stores.ts
index c0b2e79d2..d5230a819 100644
--- a/packages/shared/alm/al-runtime-stores.ts
+++ b/packages/shared/alm/al-runtime-stores.ts
@@ -49,11 +49,12 @@ import {
 import type { ALVolatileSessionBudget } from './volatile-budget/al-volatile-session-budget.ts';
 
 /**
- * Which store pair of a runtime a lane runs over: the IndexedDB pair (`durable`) or the session's memory
- * pair (`volatile`). A lane names it on every diagnostic it states, so a reader of storage timings can keep
- * the two apart; the WS server's single-lane runtime is always `durable`.
+ * Which store pair of a runtime a lane runs over: the IndexedDB pair (`durable`), the session's memory
+ * pair (`volatile`), or a memory pair whose rows a checkpoint copies to IndexedDB (`checkpoint`). A lane
+ * names it on every diagnostic it states, so a reader of storage timings can keep them apart; the WS
+ * server's single-lane runtime is always `durable`.
  */
-export type ALStoreDurability = 'volatile' | 'durable';
+export type ALStoreDurability = 'volatile' | 'checkpoint' | 'durable';
 
 export interface CreateInMemoryALRuntimeStoresInput {
     readonly nowMs: () => number;
```

- [ ] **Step 4: The plan names its lane; the runtime routes by it (with the one-task bridge); the captured row keeps
      its boolean.**

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/outbound/al-outbound-message-runtime.ts b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
index e2538c03d..27fa3399e 100644
--- a/packages/shared/alm/outbound/al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
@@ -152,7 +152,8 @@ export interface ALOutboundDispatchPlan<TPrepared> {
     readonly dropReason?: string;
     /** Required so every planner states its drop code; `undefined` means the plan is not dropping the message. */
     readonly dropReasonCode: ALOutboundDropReasonCode | undefined;
-    readonly persist: boolean;
+    /** The store lane the admission runs in: the message's durability, or `volatile` for a dropping plan. */
+    readonly lane: ALStoreDurability;
     readonly preparedMessages: readonly TPrepared[];
     readonly ackTracking?: ALOutboundAckTrackingPlan;
     /**
@@ -399,7 +400,8 @@ export namespace ALOutboundMessageRuntime {
  * cancellation, the settlement guard and disposal.
  *
  * - An admission (`enqueueIfAbsent`, each member of `enqueueAllIfAbsent`) goes to the lane its plan's
- *   `persist` names: the durability decision (`shouldPersistOutbox`) on every browser planner. The plan
+ *   `lane` names: the durability decision (`resolveALOutboundStoreDurability`) on every browser planner.
+ *   Until the runtime holds a checkpoint lane, a `checkpoint` plan goes to the durable lane. The plan
  *   is computed once and handed to that lane's admission of the same message, so the admission never
  *   plans the message twice. The lane over the memory pair states no admission durable.
  * - Members with different durability plans stay in one logical enqueue group but route to separate store lanes.
@@ -622,9 +624,9 @@ export class ALOutboundMessageRuntime<TPrepared> {
         return { lane, planner: toPlannedOnce(msg, bounded, planOutgoingMessage) };
     }
 
-    /** The lane a durable plan names, or the only lane of a runtime with one backend. */
+    /** The memory lane for a volatile plan; every other plan, and every plan of a one-backend runtime, is durable. */
     private resolveLaneForPlan(plan: ALOutboundDispatchPlan<TPrepared>): ALOutboundStoreLane<TPrepared> {
-        return plan.persist || this.volatile === undefined ? this.durable : this.volatile;
+        return plan.lane === 'volatile' && this.volatile !== undefined ? this.volatile : this.durable;
     }
 
     /** A memory read, so a control about a volatile message never reaches IndexedDB. */
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/outbound/admission/al-outbound-admission-validation.ts b/packages/shared/alm/outbound/admission/al-outbound-admission-validation.ts
index 9e21e705f..81adf0ebc 100644
--- a/packages/shared/alm/outbound/admission/al-outbound-admission-validation.ts
+++ b/packages/shared/alm/outbound/admission/al-outbound-admission-validation.ts
@@ -13,6 +13,7 @@ import type {
     ALOutboundPendingAckSnapshot,
     ALOutboundRepairAttemptSnapshot
 } from '../../al-runtime-state-stores.ts';
+import type { ALStoreDurability } from '../../al-runtime-stores.ts';
 import { decodeALOutboundMessageReference, type ALOutboundMessageReference } from '../al-outbound-canonical-message.ts';
 import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';
 import { toALOutboundEffectId } from '../to-al-outbound-effect-id.ts';
@@ -33,6 +34,7 @@ export interface ALStoredOutboundMessage {
 }
 
 export interface ALOutboundCapturedPolicy {
+    /** Whether the copy outlives the volatile lane; the row keeps no finer lane. */
     readonly persist: boolean;
     readonly ackTracking: NonNullable<ALOutboundDispatchPlan<never>['ackTracking']> | null;
     readonly retryTracking: NonNullable<ALOutboundDispatchPlan<never>['retryTracking']> | null;
@@ -47,7 +49,7 @@ export interface ALOutboundCapturedPolicy {
 
 export function captureALOutboundPolicy<TPrepared>(plan: ALOutboundDispatchPlan<TPrepared>): ALOutboundCapturedPolicy {
     return {
-        persist: plan.persist,
+        persist: plan.lane !== 'volatile',
         ackTracking: plan.ackTracking ?? null,
         retryTracking: plan.retryTracking ?? null,
         repairTracking: plan.repairTracking ?? null,
@@ -81,13 +83,17 @@ export function toALOutboundSentPolicy<TPrepared>(
         : stored;
 }
 
+export function toALOutboundCapturedLane(policy: ALOutboundCapturedPolicy): ALStoreDurability {
+    return policy.persist ? 'durable' : 'volatile';
+}
+
 export function applyALOutboundCapturedPolicy<TPrepared>(
     plan: ALOutboundDispatchPlan<TPrepared>,
     policy: ALOutboundCapturedPolicy
 ): ALOutboundDispatchPlan<TPrepared> {
     return {
         ...plan,
-        persist: policy.persist,
+        lane: policy.persist === (plan.lane !== 'volatile') ? plan.lane : toALOutboundCapturedLane(policy),
         ackTracking: policy.ackTracking
             ? {
                 ...policy.ackTracking,
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/outbound/al-outbound-message-effects.ts b/packages/shared/alm/outbound/al-outbound-message-effects.ts
index 301f20ed7..6dd722db9 100644
--- a/packages/shared/alm/outbound/al-outbound-message-effects.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-effects.ts
@@ -10,6 +10,7 @@ import type {
     ALOutboundDurableEffect,
     ALOutboundEffectSnapshot
 } from './admission/al-outbound-admission-store.ts';
+import { toALOutboundCapturedLane } from './admission/al-outbound-admission-validation.ts';
 import type { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
 import type {
     ALOutboundDispatchPlan,
@@ -401,7 +402,7 @@ function toALOutboundRetainedDispatchPlan<TPrepared>(
     return {
         msg,
         dropReasonCode: undefined,
-        persist: pending.policy.persist,
+        lane: toALOutboundCapturedLane(pending.policy),
         preparedMessages: pending.preparedMessages,
         ackTracking: pending.policy.ackTracking ?? undefined,
         retryTracking: pending.policy.retryTracking ?? undefined,
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/outbound/compute-al-outbound-dispatch.ts b/packages/shared/alm/outbound/compute-al-outbound-dispatch.ts
index 62a134f2b..abd561dd4 100644
--- a/packages/shared/alm/outbound/compute-al-outbound-dispatch.ts
+++ b/packages/shared/alm/outbound/compute-al-outbound-dispatch.ts
@@ -92,7 +92,11 @@ export function computeALOutboundDispatch<TPrepared>(
         durableEffects.push(...ackTracking.durableEffects);
     }
 
-    const verdict = computeALOutboundRouteVerdict(read, awaitPhysicalDispatch || read.plan.persist, queuedAttempts);
+    const verdict = computeALOutboundRouteVerdict(
+        read,
+        awaitPhysicalDispatch || read.plan.lane !== 'volatile',
+        queuedAttempts
+    );
     return {
         ...toALOutboundComputedResult(
             verdict,
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/outbound/admission/compute-al-outbound-ack-refusal.ts b/packages/shared/alm/outbound/admission/compute-al-outbound-ack-refusal.ts
index 42d9ad157..5acc4eb0f 100644
--- a/packages/shared/alm/outbound/admission/compute-al-outbound-ack-refusal.ts
+++ b/packages/shared/alm/outbound/admission/compute-al-outbound-ack-refusal.ts
@@ -28,7 +28,7 @@ export function computeALOutboundAckRefusal<TPrepared>(
             msg,
             dropReason: issue.detail,
             dropReasonCode: 'unsupported',
-            persist: false,
+            lane: 'volatile',
             preparedMessages: []
         });
 }
```

- [ ] **Step 5: The refusal, and every planner on the lane.** Create
      `packages/shared/alm/outbound/admission/compute-al-outbound-ordering-refusal.ts`:

<!-- dprint-ignore -->
```ts
import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALQosNormalizationResult } from '../../../al-contracts/al-policy.ts';
import { Either } from '../../../resilience/Either.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';

export interface ComputeALOutboundOrderingRefusalInput {
    readonly msg: ALMessage;
    readonly policy: ALQosNormalizationResult;
}

/**
 * A restored checkpoint could send a client sequence position again for different content, so a
 * `local-checkpoint` send that carries a `seq` is the admission's `unsupported` refusal. An ordering key
 * alone carries no position, and a superseded unsent copy was never seen outside the runtime.
 */
export function computeALOutboundOrderingRefusal<TPrepared>(
    input: ComputeALOutboundOrderingRefusalInput
): Either<ALOutboundDispatchPlan<TPrepared>, ALMessage> {
    const { msg, policy } = input;
    return policy.effective.durability.algo !== 'local-checkpoint' || msg.ordering?.seq === undefined
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg,
            dropReason: `A local-checkpoint send cannot carry sequence ${msg.ordering.seq}`,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}
```

The explicit `flatMap<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage>` type arguments are needed:
without them `Either.ofLeft(refusal)` widens the right side to `unknown` and the next `flatMap` fails to compile.

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts b/packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts
index 6b30ed1b4..d8d3492b1 100644
--- a/packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts
+++ b/packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts
@@ -1,13 +1,14 @@
 import type { ALMessage } from '../../al-contracts/al-contract.ts';
 import {
     normalizeALQosPolicy,
+    resolveALOutboundStoreDurability,
     resolveALQosNormalizationInput,
     resolveSupersedenceKey,
-    shouldPersistOutbox,
     type ALQosEffectivePolicy,
     type ALQosInputProvider
 } from '../../al-contracts/al-policy.ts';
 import { computeALOutboundAckRefusal } from '../../alm/outbound/admission/compute-al-outbound-ack-refusal.ts';
+import { computeALOutboundOrderingRefusal } from '../../alm/outbound/admission/compute-al-outbound-ordering-refusal.ts';
 import type {
     ALOutboundDispatchPlan,
     ALOutboundRetryTrackingPlan,
@@ -18,6 +19,7 @@ import {
     type ALOutboundTransportMessage
 } from '../../alm/outbound/al-outbound-transport-message.ts';
 import { toALOutboundMessage } from '../../alm/outbound/to-al-outbound-message.ts';
+import { Either } from '../../resilience/Either.ts';
 import { toWsQueueBoxClientAckTrackingPlan } from './ws-queue-box-client-receipt-tracking.ts';
 
 export interface WsQueueBoxClientDispatchContext {
@@ -48,13 +50,16 @@ export function toWsQueueBoxClientDispatchPlan(
         msg: message,
         carrier: 'ws',
         policy: normalized
-    });
+    }).flatMap<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage>(
+        (refused) => Either.ofLeft(refused),
+        (admissible) => computeALOutboundOrderingRefusal({ msg: admissible, policy: normalized })
+    );
     return refusal.fold<ALOutboundDispatchPlan<ALOutboundTransportMessage>>(
         (refused) => refused,
         () => ({
             msg: message,
             dropReasonCode: undefined,
-            persist: shouldPersistOutbox(normalized.effective),
+            lane: resolveALOutboundStoreDurability(normalized.effective.durability.algo),
             preparedMessages: [toALOutboundTransportMessage(message)],
             ackTracking: toWsQueueBoxClientAckTrackingPlan(
                 normalized.effective,
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/multicast/web-rtc-overlay-multicast-manager.ts b/packages/shared/multicast/web-rtc-overlay-multicast-manager.ts
index 9192af99e..7ceb3437c 100644
--- a/packages/shared/multicast/web-rtc-overlay-multicast-manager.ts
+++ b/packages/shared/multicast/web-rtc-overlay-multicast-manager.ts
@@ -8,10 +8,10 @@ import {
     ALQosNormalizationResult,
     normalizeALQosPolicy,
     planALMessageHandling,
+    resolveALOutboundStoreDurability,
     resolveALQosNormalizationInput,
     resolveSupersedenceKey,
     shouldAwaitALRoute,
-    shouldPersistOutbox,
     type ALMessageDropReasonCode,
     type ALMessagePlanningObservations
 } from '../al-contracts/al-policy.ts';
@@ -21,6 +21,7 @@ import type {
 } from '../alm/delivery/al-delivery-lifecycle.ts';
 import type { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
 import { computeALOutboundAckRefusal } from '../alm/outbound/admission/compute-al-outbound-ack-refusal.ts';
+import { computeALOutboundOrderingRefusal } from '../alm/outbound/admission/compute-al-outbound-ordering-refusal.ts';
 import type {
     ALOutboundCancelOutcome,
     ALOutboundEnqueueResult,
@@ -531,6 +532,10 @@ export class WebRtcOverlayMulticastManager {
         const policy = this.readOutgoingQosPolicy(frozen, context);
         const msg = toALOutboundMessage(frozen, policy.effective);
         const plan = computeALOutboundAckRefusal<ALOutboundTransportMessage>({ msg, carrier: 'rtc', policy })
+            .flatMap<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage>(
+                (refusal) => Either.ofLeft(refusal),
+                (admissible) => computeALOutboundOrderingRefusal({ msg: admissible, policy })
+            )
             .flatMap((refusal) => Either.ofLeft(refusal), computeRtcFrozenAudienceRefusal)
             .fold((refusal) => refusal, () => this.planOriginatingDispatch(msg, availability, alreadyOwned));
         return toRtcFrozenAudienceDispatchPlan(toRtcEmptyAudienceDispatchPlan(plan, policy.effective), selfPeerId);
@@ -558,7 +563,7 @@ export class WebRtcOverlayMulticastManager {
             return {
                 dropReason: availability.reason,
                 dropReasonCode: availability.kind === 'pending' ? 'not-yet-in-sync' : 'unauthorized',
-                persist: false,
+                lane: 'volatile',
                 msg,
                 preparedMessages: []
             };
@@ -615,7 +620,7 @@ export class WebRtcOverlayMulticastManager {
         }
         return {
             msg,
-            persist: true,
+            lane: resolveALOutboundStoreDurability(handling.effective.durability.algo),
             preparedMessages: [],
             dropReasonCode: undefined,
             ackTracking: toRtcAckTrackingPlan(handling.effective, []),
@@ -644,7 +649,7 @@ export class WebRtcOverlayMulticastManager {
         return {
             msg,
             dropReasonCode: 'no-route',
-            persist: false,
+            lane: 'volatile',
             preparedMessages: [],
             dropReason: `Skipping RTC outbound message ${msg.id.msgId} ${reason}`
         };
@@ -658,14 +663,14 @@ export class WebRtcOverlayMulticastManager {
             return {
                 dropReason: `Skipping RTC outbound message ${msg.id.msgId} without targets or next hop`,
                 dropReasonCode: 'no-route',
-                persist: false,
+                lane: 'volatile',
                 msg,
                 preparedMessages: []
             };
         }
         return {
             dropReasonCode: undefined,
-            persist: shouldPersistOutbox(effective),
+            lane: resolveALOutboundStoreDurability(effective.durability.algo),
             msg,
             preparedMessages: [toALOutboundTransportMessage(msg)],
             ackTracking: toRtcAckTrackingPlan(effective, msg.forwarding.nextHopPeerIds),
@@ -682,7 +687,7 @@ export class WebRtcOverlayMulticastManager {
             return {
                 dropReason: `Skipping planned RTC dispatch: ${plan.handlingPlan.dropReason}`,
                 dropReasonCode: toALOutboundDropReasonCodeFromHandlingPlan(plan.handlingPlan.dropReasonCode),
-                persist: false,
+                lane: 'volatile',
                 msg,
                 preparedMessages: []
             };
@@ -693,7 +698,7 @@ export class WebRtcOverlayMulticastManager {
                 dropReason: this.describeNoDispatchReason(plan),
                 // A repair request has a real (if unimplemented) route; only the no-transport default is routeless.
                 dropReasonCode: plan.handlingPlan.repair.enabled ? 'planner-drop' : 'no-route',
-                persist: false,
+                lane: 'volatile',
                 msg,
                 preparedMessages: []
             };
@@ -704,7 +709,7 @@ export class WebRtcOverlayMulticastManager {
             return {
                 dropReason: `Skipping immediate RTC dispatch without RTC channel for peer ${missingPeerId}`,
                 dropReasonCode: 'no-route',
-                persist: false,
+                lane: 'volatile',
                 msg,
                 preparedMessages: []
             };
@@ -712,7 +717,7 @@ export class WebRtcOverlayMulticastManager {
 
         return {
             dropReasonCode: undefined,
-            persist: plan.handlingPlan.forwarding.persist,
+            lane: resolveALOutboundStoreDurability(plan.handlingPlan.effective.durability.algo),
             msg,
             preparedMessages: plan.transportMessages.map(toALOutboundTransportMessage),
             receiptNextHopPeerIds: plan.transportMessages.flatMap((message) =>
@@ -929,7 +934,7 @@ export class WebRtcOverlayMulticastManager {
             return {
                 dropReason: admission.kind === 'pending' ? 'not-yet-in-sync' : 'unauthorized',
                 dropReasonCode: admission.kind === 'pending' ? 'not-yet-in-sync' : 'unauthorized',
-                persist: false,
+                lane: 'volatile',
                 msg,
                 preparedMessages: []
             };
@@ -937,7 +942,7 @@ export class WebRtcOverlayMulticastManager {
         const normalized = this.readOutgoingQosPolicy(msg, toAcceptedOverlayContext(this.readOutboundObservation(msg)));
         return {
             dropReasonCode: undefined,
-            persist: false,
+            lane: 'volatile',
             msg,
             preparedMessages: [toRtcTargetedRepairCopy({
                 dispatch: this.planOutgoingMessage(msg),
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/multicast/web-rtc-overlay-frozen-audience.ts b/packages/shared/multicast/web-rtc-overlay-frozen-audience.ts
index 91eb57f73..a76afd584 100644
--- a/packages/shared/multicast/web-rtc-overlay-frozen-audience.ts
+++ b/packages/shared/multicast/web-rtc-overlay-frozen-audience.ts
@@ -5,7 +5,7 @@ import {
     type ALFrozenMulticastAudience
 } from '../al-contracts/al-frozen-multicast-audience.ts';
 import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
-import { shouldPersistOutbox, type ALQosEffectivePolicy } from '../al-contracts/al-policy.ts';
+import { resolveALOutboundStoreDurability, type ALQosEffectivePolicy } from '../al-contracts/al-policy.ts';
 import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
 import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';
 import { Either } from '../resilience/Either.ts';
@@ -73,7 +73,7 @@ export function computeRtcFrozenAudienceRefusal(
             dropReason:
                 `RTC room multicast audience of ${recipientCount} recipients exceeds the RTC room limit of ${limit}`,
             dropReasonCode: 'unsupported',
-            persist: false,
+            lane: 'volatile',
             preparedMessages: []
         });
 }
@@ -126,7 +126,7 @@ export function toRtcEmptyAudienceDispatchPlan(
     }
     return {
         dropReasonCode: undefined,
-        persist: shouldPersistOutbox(effective),
+        lane: resolveALOutboundStoreDurability(effective.durability.algo),
         msg: plan.msg,
         preparedMessages: [],
         ackTracking: toRtcAckTrackingPlan(effective, [])
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/multicast/web-rtc-overlay-missing-recipient-repair.ts b/packages/shared/multicast/web-rtc-overlay-missing-recipient-repair.ts
index 3450f4670..16d7b7011 100644
--- a/packages/shared/multicast/web-rtc-overlay-missing-recipient-repair.ts
+++ b/packages/shared/multicast/web-rtc-overlay-missing-recipient-repair.ts
@@ -96,7 +96,7 @@ export function toRtcRetriedCopyRetransmission(
         ? {
             dropReason: `No RTC forwarding route for the retried copy of ${copy.msg.id.msgId}`,
             dropReasonCode: 'no-route',
-            persist: false,
+            lane: 'volatile',
             msg: copy.msg,
             preparedMessages: []
         }
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts b/packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts
index 37b38fd35..fd0c2c38b 100644
--- a/packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts
+++ b/packages/shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts
@@ -136,7 +136,7 @@ export class WsQueueBoxServerOutboundPlanning {
         if (issues.length > 0) {
             return {
                 msg: message,
-                persist: false,
+                lane: 'volatile',
                 preparedMessages: [],
                 dropReasonCode: 'unauthorized',
                 dropReason: 'WS message has no verified scoped audience'
@@ -162,8 +162,8 @@ export class WsQueueBoxServerOutboundPlanning {
         const recipientScope = request.recipientScope === undefined ? undefined : { ...request.recipientScope };
         const directBroadcast = isWsQueueBoxServerDirectScopedBroadcastRow(message, request.referenceKey);
         const audience = admittedAudience ?? resolveALFrozenMulticastAudience(message.targets)?.recipientPeerIds;
-        const persist = shouldAwaitALRoute(normalized.effective);
-        const resolveRecipients = phase === 'dequeue' || !persist;
+        const awaitsRoute = shouldAwaitALRoute(normalized.effective);
+        const resolveRecipients = phase === 'dequeue' || !awaitsRoute;
         const resolved = this.readRecipients(message, {
             resolveRecipients,
             representNoCurrentRecipient: phase === 'dequeue',
@@ -182,7 +182,7 @@ export class WsQueueBoxServerOutboundPlanning {
         return {
             msg: message,
             dropReasonCode: undefined,
-            persist,
+            lane: awaitsRoute ? 'durable' : 'volatile',
             preparedMessages: phase === 'dequeue' && clusterPublisherRegistered
                 ? toClusterPreparedMessages(message, recipients)
                 : this.toPreparedRecipients(message, recipients, { ...request, recipientScope }),
@@ -253,7 +253,7 @@ export class WsQueueBoxServerOutboundPlanning {
         return {
             msg: message,
             dropReasonCode: undefined,
-            persist: false,
+            lane: 'volatile',
             preparedMessages: this.toPreparedRecipients(message, recipients, request),
             admittedAudience: request.admittedAudience,
             recipientScope: request.recipientScope,
@@ -338,7 +338,7 @@ function toNoRouteDispatchPlan(
     message: ALMessage,
     dropReason: string
 ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
-    return { msg: message, dropReason, dropReasonCode: 'no-route', persist: false, preparedMessages: [] };
+    return { msg: message, dropReason, dropReasonCode: 'no-route', lane: 'volatile', preparedMessages: [] };
 }
 
 interface ToExpectedPeerIdsInput {
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/services/ws-queue-box-server/ws-queue-box-server-control-delivery.ts b/packages/shared/services/ws-queue-box-server/ws-queue-box-server-control-delivery.ts
index 8185a7c54..64be109f0 100644
--- a/packages/shared/services/ws-queue-box-server/ws-queue-box-server-control-delivery.ts
+++ b/packages/shared/services/ws-queue-box-server/ws-queue-box-server-control-delivery.ts
@@ -80,5 +80,5 @@ function toWsQueueBoxServerHandedOffControl(message: ALMessage, nowMs: number):
 function toWsQueueBoxServerHandedOffControlPlan(
     message: ALMessage
 ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
-    return { msg: message, dropReasonCode: undefined, persist: true, preparedMessages: [] };
+    return { msg: message, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] };
 }
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts b/packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts
index ecc1d4d0c..1e70c83b1 100644
--- a/packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts
+++ b/packages/shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts
@@ -295,7 +295,7 @@ export class WsQueueBoxServerReceiptAggregation {
 function toWsQueueBoxServerReceiptDispatchPlan(
     message: ALMessage
 ): ALOutboundDispatchPlan<WsQueueBoxServerPreparedMessage> {
-    return { msg: message, dropReasonCode: undefined, persist: true, preparedMessages: [] };
+    return { msg: message, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] };
 }
 
 /** Every reason this ACK may not count; an absent aggregate makes the rest moot. */
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts b/packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts
index c165c2809..72bef43c1 100644
--- a/packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts
+++ b/packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts
@@ -417,7 +417,7 @@ export class WsQueueBoxServerService {
             admittedAudience: authority?.admittedAudience,
             recipientScope: authority?.recipientScope
         });
-        const outgoingMessage = dispatchPlan.persist
+        const outgoingMessage = dispatchPlan.lane !== 'volatile'
             ? decodePersistedALMessageValue(message)
             : message;
 
```

<!-- dprint-ignore -->
```diff
diff --git a/tests/playwright/alm/harness/create-durable-send-harness.ts b/tests/playwright/alm/harness/create-durable-send-harness.ts
index 0eda85038..eba756e28 100644
--- a/tests/playwright/alm/harness/create-durable-send-harness.ts
+++ b/tests/playwright/alm/harness/create-durable-send-harness.ts
@@ -195,7 +195,7 @@ function toDurablePlan(msg: ALMessage): ALOutboundDispatchPlan<ALOutboundTranspo
     return {
         msg,
         dropReasonCode: undefined,
-        persist: true,
+        lane: 'durable',
         preparedMessages: [toALOutboundTransportMessage(msg)]
     };
 }
```

- [ ] **Step 6: The channel validator, the harness lists and the docs.**

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts b/packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts
index c3fea53c6..9540c56af 100644
--- a/packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts
+++ b/packages/shared-web/browser/messages/validate-rallar-typed-channel-policy.ts
@@ -39,7 +39,7 @@ export function validateRallarTypedChannelPolicy(
         issues.push({
             path: '$.durability',
             code: 'invalid-durability',
-            message: 'Durability must be volatile, local-outbox or local-inbox.'
+            message: 'Durability must be volatile, local-checkpoint, local-outbox or local-inbox.'
         });
     }
     if (
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/messages/rallar-message-contracts.ts b/packages/shared-web/browser/messages/rallar-message-contracts.ts
index 49d2b3832..155be2dfc 100644
--- a/packages/shared-web/browser/messages/rallar-message-contracts.ts
+++ b/packages/shared-web/browser/messages/rallar-message-contracts.ts
@@ -113,7 +113,10 @@ export interface RallarTypedMessageChannelDefinition {
     readonly typeId: string;
     /** Fixes the send defaults (D2): at-least-once, receipted, volatile, 30 s; a send option overrides each. */
     readonly purpose: ALChannelPurpose;
-    /** Absent, the purpose's `volatile`; `local-outbox`/`local-inbox` opt the channel into browser storage. */
+    /**
+     * Absent, the purpose's `volatile`; `local-checkpoint`, `local-outbox` and `local-inbox` opt the
+     * channel into browser storage.
+     */
     readonly durability?: ALDurabilityAlgo;
     /**
      * Absent, `refuse`: a durable send storage cannot hold reads `failed`. `volatile` sends it once without
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts b/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
index 17e4d3eef..891db0cf5 100644
--- a/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
+++ b/packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts
@@ -1,4 +1,4 @@
-import type { ALAckAlgo } from '@shared/al-contracts/al-policy.ts';
+import type { ALAckAlgo, ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
 import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
 
 import type {
@@ -327,7 +327,7 @@ export type RallarBlackBoxTestMessagesSendCommand =
         scope?: 'room' | 'world' | 'all';
         reliability?: 'best-effort' | 'at-least-once';
         ack?: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
-        durability?: 'volatile' | 'local-outbox' | 'local-inbox';
+        durability?: ALDurabilityAlgo;
         /** What the typed channel does when its durable storage is unavailable; absent, it refuses. */
         onStorageUnavailable?: 'refuse' | 'volatile';
         ttlMs?: number;
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts
index 1cd95386b..68d732f79 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts
@@ -1,4 +1,5 @@
 import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
+import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
 import { AL_DELIVERY_ADMITTED_STATES, type ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
 
 import type {
@@ -29,7 +30,7 @@ interface AlmConformanceSendDelivery {
     readonly commandTimeoutMs?: number;
     readonly ack?: 'receiver' | 'all-logical-recipients';
     readonly reliability?: 'at-least-once';
-    readonly durability?: 'local-outbox' | 'local-inbox';
+    readonly durability?: Exclude<ALDurabilityAlgo, 'volatile'>;
     /** Absent, the channel refuses a durable send its storage cannot take. */
     readonly onStorageUnavailable?: 'refuse' | 'volatile';
     readonly orderingKey?: string;
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts b/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
index 3f0f6f78e..609e3c5e0 100644
--- a/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
+++ b/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
@@ -57,6 +57,7 @@ const ALM_STORAGE_UNAVAILABLE_CAUSES: Readonly<Record<ALStorageUnavailableCause,
 
 const ALM_DURABILITY_ALGOS: Readonly<Record<ALDurabilityAlgo, true>> = {
     volatile: true,
+    'local-checkpoint': true,
     'local-outbox': true,
     'local-inbox': true
 };
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts
index d3af6fa83..c1ed3c5c9 100644
--- a/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts
+++ b/packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts
@@ -176,7 +176,7 @@ function decodeMessageSendOptions(
     const durability = decodeKnownSendOption(
         record.durability,
         AL_DURABILITY_ALGOS,
-        'durability must be volatile, local-outbox or local-inbox'
+        'durability must be volatile, local-checkpoint, local-outbox or local-inbox'
     );
     const onStorageUnavailable = decodeKnownSendOption(
         record.onStorageUnavailable,
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts b/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts
index d6fcefd02..b43242855 100644
--- a/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts
+++ b/packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts
@@ -12,7 +12,8 @@ export const RALLAR_BLACK_BOX_ALM_COMMAND_CAPABILITIES: readonly Omit<
             'Sends an ALM-addressed message over ws, rtc, or rtc-with-ws-fallback and returns delivery status. ' +
             'minSnapshotVersion states a room snapshot floor, absolute or aboveCurrentBy the sender\'s version at ' +
             'send time. qos: { ack: { algo } } passes a QoS ack algorithm request (none, hop, subtree, receiver) to ' +
-            'the product as given. durability (volatile, local-outbox, local-inbox) declares the typed channel\'s ' +
+            'the product as given. durability (volatile, local-checkpoint, local-outbox, local-inbox) declares the ' +
+            'typed channel\'s ' +
             'durability; absent, the send is volatile. onStorageUnavailable (refuse, volatile) declares what the ' +
             'channel does when its durable storage is unavailable; absent, it refuses. ' +
             'toPeer (server or receiver) addresses one peer by its lane role, which the page resolves at send time to ' +
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
index 79ee2c237..0ad29110a 100644
--- a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
+++ b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
@@ -154,7 +154,7 @@ that refusal fails the step.
 and `payload`, and optionally `connection`, `topicId`, `roomRef`, `scope`,
 `reliability`, `ack`, `durability`, `onStorageUnavailable`, `ttlMs`, `orderingKey`, `seq`, `handleId`,
 `minSnapshotVersion`, `qos` and `toPeer`. It returns `{ handleId, msgId, carrier, status, reason? }`.
-`durability` (`volatile`, `local-outbox`, `local-inbox`) declares the typed
+`durability` (`volatile`, `local-checkpoint`, `local-outbox`, `local-inbox`) declares the typed
 channel's durability; absent, the send is volatile. `onStorageUnavailable`
 (`refuse`, `volatile`) is the channel's choice when its storage cannot hold a
 durable send: `refuse` fails the send with `failure.kind: 'storage-unavailable'`,
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts
index b28c6a6ea..25ebc5562 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts
@@ -417,7 +417,7 @@ function decodeLane(value: unknown): ALStoreDurability | undefined {
     if (value === undefined) {
         return 'durable';
     }
-    return value === 'durable' || value === 'volatile' ? value : undefined;
+    return value === 'durable' || value === 'volatile' || value === 'checkpoint' ? value : undefined;
 }
 
 function decodeBoolean(value: unknown): boolean | undefined {
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/outbound/README.md b/packages/shared/alm/outbound/README.md
index 95f964588..dfb3cf069 100644
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -88,13 +88,22 @@ admission, repair retransmission, work handler and engine task over its one pair
 shared engine. The WS server builds the runtime without a memory pair (`volatileStores: undefined`), so
 every server message keeps its one backend.
 
-- **Routing by durability.** An admission goes to the lane its plan's `persist` names, and every
-  browser planner states `persist` as `shouldPersistOutbox(effective)`: the message's effective
-  durability alone. `local-outbox` and `local-inbox` go to IndexedDB; `volatile`, the default for
-  every send that names none, goes to memory. Reliability no longer implies durability: a default
+- **Routing by durability.** An admission goes to the lane its plan's `lane` names, and every
+  browser planner states `lane` as `resolveALOutboundStoreDurability(effective.durability.algo)`: the
+  message's effective durability alone. `local-outbox` and `local-inbox` name `durable` and go to
+  IndexedDB; `volatile`, the default for every send that names none, goes to memory; `local-checkpoint`
+  names `checkpoint`, which goes to the durable lane while the runtime holds no checkpoint lane. A
+  dropping plan names `volatile`. A captured policy row keeps only whether its copy outlives memory
+  (`persist`), so a re-plan under it keeps its own lane when the two agree and reads `durable` or
+  `volatile` when they do not. Reliability no longer implies durability: a default
   typed send is at-least-once, receipted and volatile (D2, D52), and a lane send that names no
   durability is volatile too (R-S3a-0). The plan is computed once and handed to that lane's admission. The admission verdict's
   `durable` says whether rows were persisted: the memory lane states every admission `durable: false`.
+- **A `local-checkpoint` send carries no client sequence.** A restored checkpoint could send a `seq`
+  again for different content, so both browser planners refuse a `local-checkpoint` send that carries
+  one as `unsupported` ([`computeALOutboundOrderingRefusal`](./admission/compute-al-outbound-ordering-refusal.ts)).
+  An ordering key alone carries no position (every room send carries its group key), and a superseded
+  unsent copy was never seen outside the runtime, so both pass.
 - **Grouped sends.** A group whose members differ in durability commits as one group per lane: there
   is no cross-store atomicity. No caller mixes today; an ACK batch is all volatile.
 - **Controls, receipts and retransmission** go to the volatile lane when it owns the target message
@@ -128,8 +137,8 @@ every server message keeps its one backend.
   so it completes within the caller's microtask chain, and a loop of awaited volatile sends yields no
   task turn until it ends (R-S3a-7). A burst loop should yield or batch; fairness is V1's.
 - **Every lane-emitted diagnostic names its lane.** `commit-phases`, `effect-drain` and
-  `readiness-probe` carry a required `lane: 'durable' | 'volatile'` (R-S3a-15), so a reader of the
-  runner's storage speed can leave the memory lane out.
+  `readiness-probe` carry a required `lane` (`ALStoreDurability`: `durable`, `checkpoint` or
+  `volatile`) (R-S3a-15), so a reader of the runner's storage speed can leave the memory lane out.
 
 The storage cost is pinned in
 [`al-indexeddb-operation-counts.test.ts`](../../../tests/shared/alm/al-indexeddb-operation-counts.test.ts):
```

- [ ] **Step 7: Move every test plan literal to the lane.** First the mechanical rename over the files `tsc` names
      (write the list, run the substitution, format):

```sh
cat > $TMPDIR/i2b-task1-sweep.txt <<'EOF'
packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts
packages/tests/api-v1/psql-admission-optimistic-retry.test.ts
packages/tests/shared-server/integration/postgres/al-admission-queue-work.test.ts
packages/tests/shared-server/rallar-system/websocket/outbox/ws-room-provenance-delivery.test.ts
packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
packages/tests/shared-test/rallar-browser-runtime/replay-captured-message.test.ts
packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts
packages/tests/shared-web/director/director-command-storage-volume.test.ts
packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts
packages/tests/shared/al-durable-runtime.test.ts
packages/tests/shared/al-indexeddb-runtime-stores.test.ts
packages/tests/shared/al-outbound-durable-effects.test.ts
packages/tests/shared/al-outbound-message-runtime.test.ts
packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
packages/tests/shared/alm/al-outbound-admission-decoding.test.ts
packages/tests/shared/alm/al-outbound-control-admission.test.ts
packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts
packages/tests/shared/alm/al-outbound-message-expiry.test.ts
packages/tests/shared/alm/al-outbound-pending-admission.test.ts
packages/tests/shared/alm/al-outbound-repair-policy.test.ts
packages/tests/shared/alm/al-outbound-retention-commit.test.ts
packages/tests/shared/alm/al-outbound-store-lane.test.ts
packages/tests/shared/alm/al-storage-snapshot.test.ts
packages/tests/shared/alm/outbound-ack-conflict-replay.test.ts
packages/tests/shared/alm/outbound-admission-read-order.test.ts
packages/tests/shared/alm/outbound-admission-verdict.test.ts
packages/tests/shared/alm/outbound-admitted-audience.test.ts
packages/tests/shared/alm/outbound-canonical-storage.test.ts
packages/tests/shared/alm/outbound-commit-phase-diagnostics.test.ts
packages/tests/shared/alm/outbound-control-handoff.test.ts
packages/tests/shared/alm/outbound-delivery-settlements.test.ts
packages/tests/shared/alm/outbound-dispatch-values.test.ts
packages/tests/shared/alm/outbound-planned-message-validation.test.ts
packages/tests/shared/alm/outbound-readiness-probe-diagnostics.test.ts
packages/tests/shared/alm/outbound-room-repair-authority.test.ts
packages/tests/shared/alm/outbound-runtime-test-fixture.ts
packages/tests/shared/alm/outbound-supersedence-concurrency.test.ts
packages/tests/shared/alm/outbound/al-outbound-acknowledged-receipt-timeout.test.ts
packages/tests/shared/alm/outbound/al-outbound-admission-fences.test.ts
packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts
packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts
packages/tests/shared/alm/outbound/al-outbound-control-handoff-two-tabs.test.ts
packages/tests/shared/alm/outbound/al-outbound-dequeue-work.test.ts
packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts
packages/tests/shared/alm/outbound/al-outbound-receipt-exhaustion.test.ts
packages/tests/shared/alm/outbound/al-outbound-storage-unavailable.test.ts
packages/tests/shared/alm/outbound/al-outbound-tracked-receipt-algo.test.ts
packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts
packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts
packages/tests/shared/alm/outbound/to-al-outbound-dispatch-completion-receipt.test.ts
packages/tests/shared/alm/session-outbound-test-runtime.ts
packages/tests/shared/alm/work/al-work-lease-recovery.test.ts
packages/tests/shared/services/ws-dequeue-authority.test.ts
packages/tests/shared/services/ws-public-unicast-scope.test.ts
packages/tests/shared/services/ws-queue-box-server-control-delivery.test.ts
EOF
perl -pi -e "s/\bpersist: true\b/lane: 'durable'/g; s/\bpersist: false\b/lane: 'volatile'/g" $(cat $TMPDIR/i2b-task1-sweep.txt)
cat $TMPDIR/i2b-task1-sweep.txt | xargs npx dprint fmt
```

Then the edits the substitution cannot make (a computed `persist`, a literal that needs `as const` outside a
contextual type, a spread the compiler's excess-property check does not see, and one captured policy _row_ literal
at `al-outbound-admission-decoding.test.ts:176` that must stay `persist: true`), shown against the substituted tree:

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/director/director-command-storage-volume.test.ts b/packages/tests/shared-web/director/director-command-storage-volume.test.ts
index 4d52fdcd3..88309306f 100644
--- a/packages/tests/shared-web/director/director-command-storage-volume.test.ts
+++ b/packages/tests/shared-web/director/director-command-storage-volume.test.ts
@@ -9,7 +9,7 @@ import type {
     RallarTypedMessageChannelDefinition
 } from '@shared-web/browser/messages/rallar-message-contracts.ts';
 import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
-import { shouldPersistOutbox } from '@shared/al-contracts/al-policy.ts';
+import { resolveALOutboundStoreDurability } from '@shared/al-contracts/al-policy.ts';
 import { normalizeALQosPolicy } from '@shared/al-contracts/normalize-al-qos-policy.ts';
 import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
 import {
@@ -62,7 +62,7 @@ describe('director command browser storage volume (D60, D87)', () => {
             planOutgoingMessage: (msg) => ({
                 msg,
                 dropReasonCode: undefined,
-                persist: shouldPersistOutbox(normalizeALQosPolicy(msg).effective),
+                lane: resolveALOutboundStoreDurability(normalizeALQosPolicy(msg).effective.durability.algo),
                 preparedMessages: [{ kind: 'send' }]
             }),
             sendPreparedMessage: async () => {
diff --git a/packages/tests/shared/al-outbound-message-runtime.test.ts b/packages/tests/shared/al-outbound-message-runtime.test.ts
index 1051fc56f..2eb6a3961 100644
--- a/packages/tests/shared/al-outbound-message-runtime.test.ts
+++ b/packages/tests/shared/al-outbound-message-runtime.test.ts
@@ -238,7 +238,7 @@ describe('ALOutboundMessageRuntime', () => {
         await enqueueOutboundOrThrow(runtime, msg);
 
         const nextMessage = createOutboundMessage('next-message-for-same-sender');
-        const plan = (msg: ALMessage) => ({ msg: msg, dropReasonCode: undefined, lane: 'volatile', preparedMessages: [] });
+        const plan = (msg: ALMessage) => ({ msg: msg, dropReasonCode: undefined, lane: 'volatile' as const, preparedMessages: [] });
         const beforeAck = await admissionStore.readOutgoingMessage({ msg: nextMessage, planner: plan, observedCanonicalEntry: undefined, intent: 'enqueue' });
         await runtime.acceptControlMessage(
             newALAckControlMessage(
diff --git a/packages/tests/shared/alm/al-outbound-admission-decoding.test.ts b/packages/tests/shared/alm/al-outbound-admission-decoding.test.ts
index ca200ec95..575f98a86 100644
--- a/packages/tests/shared/alm/al-outbound-admission-decoding.test.ts
+++ b/packages/tests/shared/alm/al-outbound-admission-decoding.test.ts
@@ -173,7 +173,7 @@ describe('outbound admission persisted-record validation', () => {
                 orderingSeq: null,
                 creationExpiry: captureALOutboundCreationExpiry(msg),
                 policy: {
-                    lane: 'durable',
+                    persist: true,
                     ackTracking: null,
                     retryTracking: null,
                     repairTracking: null,
diff --git a/packages/tests/shared/alm/al-outbound-store-lane.test.ts b/packages/tests/shared/alm/al-outbound-store-lane.test.ts
index 40d27e108..70dbcf7be 100644
--- a/packages/tests/shared/alm/al-outbound-store-lane.test.ts
+++ b/packages/tests/shared/alm/al-outbound-store-lane.test.ts
@@ -51,7 +51,7 @@ describe('outbound store lanes (S3a, D54)', () => {
             volatileStores,
             planOutgoingMessage: (msg) => ({
                 ...planVolatileSend(msg),
-                persist: msg.id.msgId === kept.id.msgId
+                lane: msg.id.msgId === kept.id.msgId ? 'durable' : 'volatile'
             }),
             sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
         });
diff --git a/packages/tests/shared/alm/al-storage-snapshot.test.ts b/packages/tests/shared/alm/al-storage-snapshot.test.ts
index 4cdd015de..f88ef4881 100644
--- a/packages/tests/shared/alm/al-storage-snapshot.test.ts
+++ b/packages/tests/shared/alm/al-storage-snapshot.test.ts
@@ -212,7 +212,7 @@ async function sendOutboundWorkload(
         planOutgoingMessage: (msg) => ({
             msg,
             dropReasonCode: undefined,
-            persist: volatileStores === undefined,
+            lane: volatileStores === undefined ? 'durable' : 'volatile',
             preparedMessages: [{ message: JSON.stringify(msg) }],
             supersedenceTracking: { enabled: true, algo: 'latest-wins', key: toSupersedenceKey(msg) }
         }),
diff --git a/packages/tests/shared/alm/outbound-admission-verdict.test.ts b/packages/tests/shared/alm/outbound-admission-verdict.test.ts
index 19232bd93..ec6031bc0 100644
--- a/packages/tests/shared/alm/outbound-admission-verdict.test.ts
+++ b/packages/tests/shared/alm/outbound-admission-verdict.test.ts
@@ -236,7 +236,7 @@ describe('outbound admission verdict', () => {
         const planner = () => ({
             msg: message,
             dropReasonCode: undefined,
-            lane: 'durable',
+            lane: 'durable' as const,
             preparedMessages: [] as readonly OutboundTestPayload[]
         });
         const commitInput = { msg: message, planner, intent: 'enqueue' as const, phase: 'immediate' as const, origin: 'send' as const, options: {} };
@@ -258,7 +258,7 @@ describe('outbound admission verdict', () => {
         const toPlan = (msg: typeof newer) => () => ({
             msg,
             dropReasonCode: undefined,
-            lane: 'durable',
+            lane: 'durable' as const,
             preparedMessages: [] as readonly OutboundTestPayload[],
             supersedenceTracking
         });
diff --git a/packages/tests/shared/alm/outbound-commit-phase-diagnostics.test.ts b/packages/tests/shared/alm/outbound-commit-phase-diagnostics.test.ts
index 3ad6467c9..3fcb5fa53 100644
--- a/packages/tests/shared/alm/outbound-commit-phase-diagnostics.test.ts
+++ b/packages/tests/shared/alm/outbound-commit-phase-diagnostics.test.ts
@@ -255,7 +255,7 @@ it('names the lane on the commit, readiness and drain events each store lane sta
         planOutgoingMessage: (msg) => ({
             msg,
             dropReasonCode: undefined,
-            persist: msg.id.msgId === durable.id.msgId,
+            lane: msg.id.msgId === durable.id.msgId ? 'durable' : 'volatile',
             preparedMessages: [{ kind: 'send' }]
         }),
         sendPreparedMessage: async () => {
diff --git a/packages/tests/shared/alm/outbound-delivery-settlements.test.ts b/packages/tests/shared/alm/outbound-delivery-settlements.test.ts
index 1449d36b8..0075c4002 100644
--- a/packages/tests/shared/alm/outbound-delivery-settlements.test.ts
+++ b/packages/tests/shared/alm/outbound-delivery-settlements.test.ts
@@ -136,7 +136,10 @@ it('stamps every settlement with the lane that stated it, and its own cancel wit
         stores: createStores('memory'),
         volatileStores: createVolatileOutboundTestStores(),
         settlements: (settlement) => settlements.push(settlement),
-        planOutgoingMessage: (msg) => ({ ...planSend()(msg), persist: msg.route.resourceId === 'msg-durable-lane' }),
+        planOutgoingMessage: (msg) => ({
+            ...planSend()(msg),
+            lane: msg.route.resourceId === 'msg-durable-lane' ? 'durable' : 'volatile'
+        }),
         sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
     });
     const durable = createOutboundMessage('msg-durable-lane');
diff --git a/packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts b/packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts
index 56aa78b05..c8b01ac7f 100644
--- a/packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts
+++ b/packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts
@@ -35,7 +35,7 @@ function createHandOverFixture(persist: boolean, receiptTimeoutMs = 60_000) {
         planOutgoingMessage: (msg) => ({
             msg,
             dropReasonCode: undefined,
-            persist,
+            lane: persist ? 'durable' : 'volatile',
             preparedMessages: [{ message: msg.id.msgId }],
             ackTracking: { ...trackOutboundTestAcks(['peer-1']), timeoutMs: receiptTimeoutMs }
         }),
diff --git a/packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts b/packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts
index 78d96dc0d..73d525ea3 100644
--- a/packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts
+++ b/packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts
@@ -37,7 +37,7 @@ function planByTypeId(
     return {
         msg: toALOutboundMessage(msg, normalizeALQosPolicy(msg, normalization).effective),
         dropReasonCode: undefined,
-        persist: msg.payload.typeId === DURABLE_TYPE_ID,
+        lane: msg.payload.typeId === DURABLE_TYPE_ID ? 'durable' : 'volatile',
         preparedMessages: [{ kind: 'send' }]
     };
 }
diff --git a/packages/tests/shared/alm/session-outbound-test-runtime.ts b/packages/tests/shared/alm/session-outbound-test-runtime.ts
index e92ca0ec2..48dccb672 100644
--- a/packages/tests/shared/alm/session-outbound-test-runtime.ts
+++ b/packages/tests/shared/alm/session-outbound-test-runtime.ts
@@ -72,7 +72,7 @@ export function createSessionOutboundTestRuntime<TOwnership extends ALDurableWor
         planOutgoingMessage: (msg) => ({
             msg,
             dropReasonCode: undefined,
-            persist: msg.route.resourceId.startsWith('durable'),
+            lane: msg.route.resourceId.startsWith('durable') ? 'durable' : 'volatile',
             preparedMessages: [{ peer: 'receiver' }]
         }),
         sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
diff --git a/packages/tests/shared/alm/work/al-work-lease-recovery.test.ts b/packages/tests/shared/alm/work/al-work-lease-recovery.test.ts
index c9880b77b..488f47521 100644
--- a/packages/tests/shared/alm/work/al-work-lease-recovery.test.ts
+++ b/packages/tests/shared/alm/work/al-work-lease-recovery.test.ts
@@ -195,7 +195,7 @@ function createLeaseRecoveryRun(options: { withVolatileLane?: boolean; } = {}):
         planOutgoingMessage: (msg) => ({
             msg,
             dropReasonCode: undefined,
-            persist: msg.route.resourceId !== 'volatile-first',
+            lane: msg.route.resourceId !== 'volatile-first' ? 'durable' : 'volatile',
             preparedMessages: [{ peer: 'receiver' }]
         }),
         sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
```

And the two expectations outside the list (no compile error there; `toMatchObject` reads them at run time):

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts b/packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts
index 9e77a9789..a7ec5cff7 100644
--- a/packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts
+++ b/packages/tests/shared/services/ws-queue-box-server-outbound-planning.test.ts
@@ -168,7 +168,7 @@ describe('WS server outbound planning', () => {
             admittedAudience: undefined
         });
 
-        expect(plan).toMatchObject({ dropReasonCode: undefined, persist: true, preparedMessages: [] });
+        expect(plan).toMatchObject({ dropReasonCode: undefined, lane: 'durable', preparedMessages: [] });
     });
 
     it('repairs a room message only to a requester of the audience it was admitted to, never to a later joiner (D24, D43)', () => {
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/services/ws-room-provenance-planning.test.ts b/packages/tests/shared/services/ws-room-provenance-planning.test.ts
index 8390cca6a..1f7106309 100644
--- a/packages/tests/shared/services/ws-room-provenance-planning.test.ts
+++ b/packages/tests/shared/services/ws-room-provenance-planning.test.ts
@@ -50,7 +50,7 @@ describe('room publication identity at WS planning', () => {
             recipientScope: SCOPE,
             referenceKey
         });
-        expect(plan).toMatchObject({ persist: false, preparedMessages: [], dropReasonCode: 'unauthorized' });
+        expect(plan).toMatchObject({ lane: 'volatile', preparedMessages: [], dropReasonCode: 'unauthorized' });
     });
 
     it.each([CANONICAL_KEY, DIRECT_KEY])('repairs only the retained audience for $topicId', (referenceKey) => {
```

Do not touch the other `persist` keys under `packages/tests/**`: `queue-box-pub-sub-bridge.test.ts:891`
(`readCapturedPolicy`, a captured row), `inbound-admission-diagnostics.test.ts:257` and
`al-inbound-persistence-validation.test.ts:438-439` (handling plans), and the CRDT and storage-manager `persist`.
Verify none is left on a dispatch plan, including in spreads:

```sh
grep -rn "persist" packages/tests packages/shared-test tests --include='*.ts' | grep -E "persist\s*[:,]|persist$" | grep -v -i crdt
```

Expected: exactly the lines named in the paragraph above, `hand-over.test.ts:23,56` (a fixture parameter),
`rtc-snapshot-nack.test.ts:103` (a parameter), `remote-browser-command-preparation.test.ts:39`,
`browser-al-storage-availability.test.ts:190,207`, `schema.ts:723`, `rallar-black-box-command-capabilities.ts:476` and
the new captured-lane cases in `apply-al-outbound-captured-policy.test.ts`.

- [ ] **Step 8: The headless bundle budget.** `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`:
      `"brotliBudgetKiB": 299` → `300` (measured 299.144 KiB after this task; the maintainer ruling raises a crossed
      budget to the next whole KiB).

- [ ] **Step 9: Format the touched files only.**

```sh
git diff --name-only | grep -v -E '\.json$' | xargs npx dprint fmt
npx dprint fmt packages/shared/alm/outbound/admission/compute-al-outbound-ordering-refusal.ts \
  packages/tests/shared/alm/outbound/al-outbound-checkpoint-ordering-refusal.test.ts
```

- [ ] **Step 10: Run the red tests green, then every touched test.**

```sh
npx vitest run packages/tests/shared/al-policy.test.ts packages/tests/shared/alm/outbound/al-outbound-checkpoint-ordering-refusal.test.ts \
  packages/tests/shared/alm/outbound/apply-al-outbound-captured-policy.test.ts packages/tests/shared-web/messages/browser-typed-message-channels.test.ts \
  packages/tests/shared-test/alm-delivery-failure-decoding.test.ts packages/tests/shared-test/alm-observation-regime.test.ts \
  packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
git diff --name-only -- packages/tests | grep '\.test\.ts$' | grep -v -E 'integration/postgres|api-v1/' | xargs npx vitest run
npx vitest run --project unit
```

Expected (measured): `Test Files  8 passed (8)`, `Tests  204 passed (204)`; the touched set
`Test Files  60 passed (60)`, `Tests  786 passed (786)` (the Postgres integration file and the api-v1 file are run by
their own lanes; both change only plan literals and type-check); the unit project `Test Files  6 failed | 1349 passed |
4 skipped (1359)`, every failure a sandboxed port bind (`listen EPERM` in `live-rtc-control-client`,
`api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe`, `local-websocket-session`,
`headless-worker-script`) plus `headless-bundle-boundary` before Step 8 (299.144 against 299); after Step 8 it passes.
Unsandboxed, the unit project passes.

- [ ] **Step 11: Per-task checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
npm --workspace @ar-eye-hunter/shared-test run typecheck
(cd apps/api-v1 && deno task check); rm -rf apps/api-v1/node_modules/.deno; find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
npm run check:test-reachability
WT=$PWD; cat > $TMPDIR/tsconfig.playwright.json <<EOF
{ "extends": "$WT/packages/tests/tsconfig.json",
  "compilerOptions": { "noEmit": true, "typeRoots": ["$WT/node_modules/@types"], "types": ["node"] },
  "include": ["$WT/tests/playwright/**/*.ts"] }
EOF
npx tsc -p $TMPDIR/tsconfig.playwright.json --pretty false | grep "error TS" | grep -v node_modules
(cd apps/rallar-black-box && npx tsc --noEmit)
node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
(cd apps/rallar-black-box-control-server && deno task check && deno task test)
```

Expected (measured): no `tsc` output; the three workspace typechecks exit 0; `deno task check` exit 0;
`check-tests-typecheck: 1435 test files enforced, 0 files carrying known debt (0 errors).` `PASS`; the pins
`Test Files  3 passed (3)`, `Tests  25 passed (25)`, constants and assertions unedited; `browser/rallar.ts` 234.341 KiB
(the table prints 234.3, budget 235, `Bundle budget check passed.`); headless 299.144 KiB (budget 300) and both boundary
tests pass; `Test reachability: 1737 test files, 1731 reached by CI, 6 manual.` (one test file added); the Playwright
scratch typecheck prints the 27 pre-existing errors, none under `tests/playwright/alm/**`; `apps/rallar-black-box` exit
0; `checked 67 Hetzner distributed manifest(s)` (manifests 18 and 22 byte-identical; the capability text is not in a
manifest); the control server `deno task check` exit 0 and `deno task test` `189 passed | 7 failed` in the sandbox,
the 7 being `Control server did not start` (port bind), all passing unsandboxed. `npx tsx` itself fails in the sandbox
(`listen EPERM` on its IPC pipe); `node --import tsx` runs the same script.

`npm run test:postgres:integration` is not required (nothing under `alm/inbound/**` or `alm/work/**` changes); its
one touched file (`al-admission-queue-work.test.ts`) changes two plan literals only.

- [ ] **Step 12: Commit, then run the changed-range gates.**

```sh
git add -A
git commit -F - <<'EOF'
Add local-checkpoint to the durability vocabulary and route plans by lane

ALDurabilityAlgo, AL_DURABILITY_ALGOS, the strength order and the
normalization preference gain local-checkpoint between volatile and
local-outbox, and ALStoreDurability gains checkpoint. One selector,
resolveALOutboundStoreDurability, replaces shouldPersistOutbox at the WS
and RTC planners and the handling plan, and ALOutboundDispatchPlan names
the store lane its admission runs in instead of a persist flag. Until the
runtime holds a checkpoint lane, a checkpoint plan goes to the durable
lane. The captured policy row keeps its persist field, so its row shape
is unchanged. Both browser planners refuse a local-checkpoint send that
carries a client seq as unsupported; an ordering key alone and
latest-wins pass. The channel validator, the harness lists and the
observation decoder carry the new values.

The headless bundle measures 299.144 KiB (budget raised 299 -> 300);
browser/rallar.ts measures 234.341 KiB (budget 235).

D8 reuse: the refusal follows computeALOutboundAckRefusal's Either shape and its unsupported drop code, the lane type is the existing ALStoreDurability, and the vocabulary lists stay the existing ones widened; no new store, list or cache is added.
EOF
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured): `PASS: no new repository style findings (5e06c6ab0… -> HEAD).`; one touched candidate
`test-structure-coupling-11102ca02776726f` (`outbound-runtime-test-fixture.ts:353`, already classified), then `PASS: all
11 current structure-coupling candidates are individually classified`, `PASS: changed-range structure-coupling review
has complete individual classifications`, `PASS: registry entries are complete and current`.

---

### Task 2: Dirty tracking and the synchronous capture (`ALCheckpointDirtySet`, `computeALCheckpointMutations`)

Prototyped in scratch as commit `c2eafe2c4` on Task 1's `2348174ec` (red then green). Decisions D129 (the checkpoint
is the memory lane's changed rows in the existing `entries` and `alm-work` row formats, one readwrite, as many
requests as dirty rows) and D130 (the third lane runs over a memory pair from the volatile factories). Rulings
R-I2b-3 (the capture reads current memory values for the dirty keys, not a mutation log: a key dirtied several
times writes once, a key deleted since writes a delete) and R-I2b-4 (per-key revisions captured at write start and
compared at completion; no global generation counter). Facts: surprise 3 and §2 "Coherent-capture hazards"
(`InMemoryQueueBox` has no change signal and no export, its map is private; the work port mutates the queue
outside the backend's write tail; reads expire rows lazily; `isAnyEntryToLock` starts a background cleanup) and
surprise 4 (`al-admission-backend.ts:144-173` serialises admission writes only).

**Assembly.** Commit `2ec605ba5` on `13125ae0d` (Task 1) in the composed chain: W-A's patch applied unchanged, so every
figure below is the assembled commit's. Task 4 later adds `peekKeys()` beside this task's `peek` on both memory stores,
and `loadWithoutMarking`/`markHeld` to the dirty set (R-I2b-15, R-I2b-37). Bundle figures are read with a private `TMPDIR` (R-I2b-23): the bundle script and the headless boundary test write
under `os.tmpdir()`, which every worktree of the machine shares. After every `cd apps/api-v1 && deno task check`, run
`rm -rf apps/api-v1/node_modules/.deno` and `find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete` (a
left-behind `.deno` breaks the next check).

This task adds no writer, no timer and no lane: Task 3 consumes the dirty set and the capture, Task 4 builds the
lane over them.

**Files**

- Modify: `packages/shared/queuebox/in-memory-queue-box.ts` — `onChangeDo(listener: (key) => void): Unsubscribe`
  and `peek(key)`. Every mutation of the queue already funnels through the two private choke points
  `storeEntry` / `removeEntry` (`:109-117` at base: `enqueue`, `writeIfAllObserved`, `releaseEntries`, the four
  reservation paths, `cleanup`, `getItem`'s lazy expiry, `setItem`, `removeItem`, `deleteExpired`), so both notify
  there. `removeEntry` of an absent key now returns early and notifies nothing (`workIndex.remove(key, undefined)`
  was already a no-op).
- Modify: `packages/shared/alm/al-admission-backend.ts` — `InMemoryAdmissionBackend.onChangeDo` and `peek(key)`;
  the four writers of `state.data` (`evictExpired` `:86`, `read`'s lazy expiry `:113`, `list`'s lazy expiry
  `:131`, the write's apply loop `:166`) go through two private choke points `setStored` / `deleteStored`, which
  notify. `deleteStored` of an absent key notifies nothing. A write whose callback throws or whose queue writes
  conflict applies nothing and so notifies nothing.
- Modify: `packages/shared/queuebox/indexed-db-queue-box-entry.ts` — a fifth `ComputedIndexedDbQueueMutation`
  kind, `put-unconditionally`, beside the existing `delete-unconditionally`, with
  `computeIndexedDbQueueUnconditionalPut(entry)`; the validator accepts it (decoded value, key equals the value's
  `keyString`), with the put's value check moved into one private `validateStoredQueueValue` both puts share.
- Modify: `packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts` — the submitter puts a
  `put-unconditionally` value without reading the row first (one request).
- Create: `packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts` — `ALCheckpointDirtySet`.
- Create: `packages/shared/alm/checkpoint/compute-al-checkpoint-mutations.ts` — `computeALCheckpointMutations`.
- Test (create): `packages/tests/shared/in-memory-queuebox-changes.test.ts` (beside the in-memory QueueBox
  family `in-memory-queuebox{,-dequeue,-value-ownership}.test.ts`).
- Test (create): `packages/tests/shared/alm/checkpoint/al-checkpoint-dirty-set.test.ts`,
  `packages/tests/shared/alm/checkpoint/compute-al-checkpoint-mutations.test.ts` and their shared entry builder
  `packages/tests/shared/alm/checkpoint/checkpoint-test-entry.ts`.
- Test (modify): `packages/tests/shared/alm/al-admission-backend.test.ts` (a `memory pair change notification`
  describe after `memory pair eviction`), `packages/tests/shared/indexeddb-queuebox-computed-write.test.ts` (one
  case).
- Not touched: the D55 zero pin and every other pin (`al-indexeddb-operation-counts.test.ts`,
  `al-indexeddb-transaction-ledger.test.ts`, `al-storage-snapshot.test.ts`): a notification is an in-memory loop
  over an empty listener set on every existing path, and no existing caller subscribes.

**Interfaces**

- Consumes: nothing from Task 1; the dirty set and the capture are lane-agnostic (Task 4 builds them for the `checkpoint` lane).
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // packages/shared/queuebox/in-memory-queue-box.ts
  class InMemoryQueueBox {
      onChangeDo(listener: (key: ResourceEntryKeyString) => void): Unsubscribe;   // Unsubscribe from cache/RepositoryInterfaces.ts
      peek(key: ResourceEntryKeyString): ResourceEntry | undefined;               // a snapshot; expired entries included; removes nothing
  }
  // packages/shared/alm/al-admission-backend.ts
  class InMemoryAdmissionBackend {
      onChangeDo(listener: (key: string) => void): Unsubscribe;
      peek(key: string): ALAdmissionStoredValue | undefined;                      // { key, value, expireAtTimestamp }; removes nothing
  }
  // packages/shared/queuebox/indexed-db-queue-box-entry.ts
  export function computeIndexedDbQueueUnconditionalPut(entry: ResourceEntry):
      { kind: 'put-unconditionally'; keyString: ResourceEntryKeyString; value: StoredResourceEntry };   // value = encodeStoredResourceEntry(entry, 0)
  // packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts
  export namespace ALCheckpointDirtySet {
      type Space = 'admission' | 'queue';
      interface Mark { readonly space: Space; readonly key: string; readonly revision: number; }
      interface Snapshot { readonly marks: readonly Mark[]; readonly takenAtMs: number; }
      interface Input {
          readonly backend: Pick<InMemoryAdmissionBackend, 'onChangeDo' | 'workQueue'>;
          readonly nowMs: () => number;
      }
  }
  export class ALCheckpointDirtySet {
      constructor(input: ALCheckpointDirtySet.Input);   // subscribes to the backend and to backend.workQueue
      onMarkedDo(listener: () => void): Unsubscribe;    // after every mark, in the changing turn (Task 3 arms its timer here)
      isClean(): boolean;
      getOldestDirtiedAtMs(): number | undefined;       // Task 3's oldest unsaved age = nowMs - this
      getSnapshot(): ALCheckpointDirtySet.Snapshot;     // admission marks, then queue marks, each in first-dirtied order
      clearSaved(snapshot: ALCheckpointDirtySet.Snapshot): void;
      dispose(): void;                                   // unsubscribes; Task 4 disposes before a purge
  }
  // packages/shared/alm/checkpoint/compute-al-checkpoint-mutations.ts
  export interface ComputeALCheckpointMutationsInput {
      readonly snapshot: ALCheckpointDirtySet.Snapshot;
      readonly peekAdmission: (key: string) => ALAdmissionStoredValue | undefined;
      readonly peekQueueEntry: (key: ResourceEntryKeyString) => ResourceEntry | undefined;
      readonly writeToken: string;
  }
  export interface ALCheckpointMutations {
      readonly mutations: readonly IndexedDbAdmissionMutation[];               // 'set' (row shape, revision 1) | 'remove'
      readonly queueMutations: readonly ComputedIndexedDbQueueMutation[];      // 'put-unconditionally' | 'delete-unconditionally'
  }
  export function computeALCheckpointMutations(input: ComputeALCheckpointMutationsInput): ALCheckpointMutations;
  ```

  How Task 3 uses them, in one synchronous turn: `const snapshot = dirty.getSnapshot();
  const capture = computeALCheckpointMutations({ snapshot, peekAdmission: (k) => backend.peek(k),
  peekQueueEntry: (k) => backend.workQueue.peek(k), writeToken })`, then one
  `writeIndexedDbAdmissionMutations({ db, storeName: 'entries', fence: EMPTY_INDEXED_DB_ADMISSION_FENCE,
  mutations: capture.mutations, queueMutations: capture.queueMutations })` (one readwrite over `entries` +
  `alm-work`, `write-indexed-db-admission-mutations.ts:57-60`), and on success `dirty.clearSaved(snapshot)`.

**Refinements to the decided shapes (reported to the controller).**

1. _A keyed listener, not a revision `ObservableValue`._ The capture needs the changed keys (R-I2b-3); a revision
   counter says only that something changed and would force a scan of the whole map per checkpoint. The
   listener is synchronous, so a mark lands in the turn of the change (the coherence constraint), where an
   `ObservableLatestValue` listener would not be guaranteed to. The subscription returns the cache's
   `Unsubscribe`, and the method is named `onChangeDo` after the cache's observer vocabulary.
2. _`peek(key)` instead of `entries()`._ The capture reads only the dirty keys (R-I2b-3), synchronously and
   without the lazy expiry `getItem` and `read` apply (both mutate and would themselves mark the key dirty).
   An `entries()` export would have no caller in I2b; Task 4's restore writes into the pair, it does not read it.
3. _Unconditional queue mutations, not `computeIndexedDbQueuePut`/`computeIndexedDbQueueDelete`._ Those are
   compare-and-set: a put expects the row `missing` or at the revision the writer read
   (`indexed-db-queue-box-entry.ts:51-60`), and the submitter reads every such row first
   (`write-computed-indexed-db-queue-mutations.ts:72-90`). The capture is synchronous and reads no IndexedDB, so
   it cannot know the revision: the second checkpoint of any work row would conflict and abort the whole
   transaction, and every queue row would cost a get plus a put. The checkpoint is the rows' only writer (D132,
   owner only), so `put-unconditionally` (beside the existing `delete-unconditionally`, which the queue's
   cleanup already uses at `indexed-db-queue-box.ts:733`) writes each row in one request. Admission rows need
   no new kind: `{kind:'set'}` and `{kind:'remove'}` are already unconditional under
   `EMPTY_INDEXED_DB_ADMISSION_FENCE`, as the session cleanup uses them (`browser-al-runtime-cleanup.ts:424-441`).
4. _Row metadata._ A checkpoint row carries one fresh `writeToken` per checkpoint (passed in, as
   `IndexedDbAdmissionBackend` takes `newWriteToken`) and `revision: INDEXED_DB_ADMISSION_FIRST_REVISION`; a work
   row restarts at revision 0. No reader fences on either: the rows are written whole by one writer and read back
   by the restore.
5. _The dirty set subscribes itself._ Its constructor takes the memory backend and follows both its admission
   rows and its `workQueue`, so the two mutation paths (the backend's serialized writes and the work port's
   direct queue calls, facts §2) cannot be wired separately or forgotten; `dispose()` unsubscribes. It holds no
   store id: one instance serves one store, and the writer (Task 3) holds the id.
6. _Oldest unsaved age._ Each dirty key keeps the time it last held saved state. `clearSaved` keeps a key whose
   revision moved since the snapshot and moves its time to the snapshot's `takenAtMs` at the earliest, since its
   newer change came after the capture. A key that changes during every write therefore never reads older than
   one write, so Task 3's `delayed`/`failing` cannot fire on a busy but healthy lane.
7. _Folder._ `packages/shared/alm/checkpoint/` (new, a feature folder like `volatile-budget/`): the tier's dirty set
   and capture here, and Task 3's writer beside them.

**D8 reuse inspection.** The dirty rows are keyed latest state, so they live in two `LatestRepository<string,
{revision, dirtiedAtMs}>` (`packages/shared/cache/LatestRepository.ts`; `peek`, `set`, `delete`, `entriesView`,
`readAllValues`, `size`), not raw Maps (maintainer rule 2026-10-01). The two listener sets are plain `Set`s of
callbacks: they hold no keyed or latest value (the frame's allowance for a set). The subscription type is the
cache's `Unsubscribe`. The capture produces the existing `IndexedDbAdmissionMutation` (`set` carries the existing
`IndexedDbAdmissionStoredRow` shape, `indexed-db-admission-row.ts:12-19`) and `ComputedIndexedDbQueueMutation` with
P1a's `encodeStoredResourceEntry` (`indexed-db-queue-box-entry-codec.ts:94-103`), so the one existing
`writeIndexedDbAdmissionMutations` writes both stores in one readwrite and the durable backend's existing `list`
and its work queue's `getItem` read the rows back (proven below). The only new mutation kind mirrors the existing
`delete-unconditionally`. `WriteBehindObservableLatestRepository` is not reused (R-I2b-12: per-key writes, no
coalescing, no single transaction). No schema change, no new row shape (R-I2b-1).

**Limits.**

- The backend's listeners see only mutations made through that backend instance; in production the volatile
  factory builds one state per backend (`al-runtime-stores.ts:303-310`) and nothing else writes `state.data`.
- A row whose expiry passed but which memory still holds is captured as a put; its later expiry delete marks it
  dirty again and the next checkpoint deletes it. The IndexedDB eviction would remove it anyway.
- A queue mutation is written in the order of first dirtying, not of change; no reader depends on the order inside
  one transaction.
- Restore-time marking: a restore that loads rows through `writeIfAllObserved`/the backend write marks them dirty.
  Task 4 decides whether the restore subscribes the dirty set after loading (the decided shape says "mark nothing
  dirty"); constructing the dirty set after the restore's loads gives that.

- [ ] **Step 1: Write the failing tests.**

  (a) The in-memory QueueBox family gains `packages/tests/shared/in-memory-queuebox-changes.test.ts`:

<!-- dprint-ignore -->
```ts
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    toKeyAsString,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

const NOW = Temporal.Instant.from('2026-10-02T12:00:00Z');

describe('InMemoryQueueBox change notification', () => {
    it('names the key of every write, reservation and release, in the turn it happens', async () => {
        const queue = new InMemoryQueueBox(undefined, () => NOW);
        const changed: string[] = [];
        queue.onChangeDo((key) => changed.push(key));
        const entry = createEntry('first');

        await queue.enqueue(entry);
        queue.writeIfAllObserved([{ expected: undefined, entry: createEntry('second') }]);
        const reserved = await queue.reserveEntries({
            typeIds: new Set([entry.typeId]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1
        });
        await queue.releaseEntries([...reserved.values()].map((current) => ({
            entry: current,
            disposition: { status: EntityStatus.COMPLETED, delayMs: null }
        })));

        expect(changed).toEqual([toKey('first'), toKey('second'), toKey('first'), toKey('first')]);
    });

    it('names the keys an expiry or a cleanup removes, and nothing for a conflicting write', async () => {
        const expired = createEntry('expired', NOW.subtract({ seconds: 1 }));
        const completed = { ...createEntry('completed'), status: EntityStatus.COMPLETED };
        const queue = new InMemoryQueueBox(new Map([[expired.key, expired], [completed.key, completed]]), () => NOW);
        const changed: string[] = [];
        queue.onChangeDo((key) => changed.push(key));

        expect(queue.writeIfAllObserved([{ expected: undefined, entry: completed }])).toBe(false);
        queue.cleanup();

        expect(changed.toSorted()).toEqual([toKey('completed'), toKey('expired')]);
    });

    it('stops naming keys once unsubscribed', async () => {
        const queue = new InMemoryQueueBox(undefined, () => NOW);
        const changed: string[] = [];
        const subscription = queue.onChangeDo((key) => changed.push(key));

        subscription.unsubscribe();
        await queue.enqueue(createEntry('after'));

        expect(changed).toEqual([]);
    });

    it('peeks an entry as held, an expired one included, without removing it', async () => {
        const expired = createEntry('expired', NOW.subtract({ seconds: 1 }));
        const queue = new InMemoryQueueBox(new Map([[expired.key, expired]]), () => NOW);
        const changed: string[] = [];
        queue.onChangeDo((key) => changed.push(key));

        expect(queue.peek(toKey('expired'))).toMatchObject({ key: expired.key, resource: expired.resource });
        expect(queue.peek(toKey('expired'))).not.toBe(queue.peek(toKey('expired')));
        expect(queue.peek(toKey('absent'))).toBeUndefined();
        expect(changed).toEqual([]);
    });
});

function toKey(resourceId: string): string {
    return toKeyAsString({ topicId: 'checkpoint.work', resourceId, contextId: 'ctx' });
}

function createEntry(resourceId: string, expiryTs: Temporal.Instant = NEVER_EXPIRE_TS): ResourceEntry {
    return {
        key: { topicId: 'checkpoint.work', resourceId, contextId: 'ctx' },
        resource: JSON.stringify({ resourceId }),
        typeId: 'checkpoint.work',
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'test',
            createdTs: Temporal.PlainDateTime.from('2026-10-02T12:00:00'),
            expiryTs
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0 },
        db: undefined
    };
}
```

(b) The memory backend (appended after `memory pair eviction`) and the unconditional queue put:

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/alm/al-admission-backend.test.ts b/packages/tests/shared/alm/al-admission-backend.test.ts
index de63d71c8..0f9d85a9d 100644
--- a/packages/tests/shared/alm/al-admission-backend.test.ts
+++ b/packages/tests/shared/alm/al-admission-backend.test.ts
@@ -688,3 +688,59 @@ describe('memory pair eviction (S3a, ruling 5)', () => {
         expect([...state.data.keys()]).toEqual(['live']);
     });
 });
+
+describe('memory pair change notification', () => {
+    it('names every key a write sets or removes, and nothing for a write whose callback throws', async () => {
+        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), () => 1_000);
+        const changed: string[] = [];
+        backend.onChangeDo((key) => changed.push(key));
+
+        await backend.write(async (tx) => {
+            await tx.set('row-a', '1', 5_000);
+            await tx.set('row-b', '2', 5_000);
+        });
+        await backend.write(async (tx) => {
+            await tx.remove('row-a');
+        });
+        await expect(backend.write(async (tx) => {
+            await tx.set('row-c', '3', 5_000);
+            throw new Error('the callback failed');
+        })).rejects.toThrow('the callback failed');
+
+        expect(changed).toEqual(['row-a', 'row-b', 'row-a']);
+        expect(backend.peek('row-b')).toEqual({ key: 'row-b', value: '2', expireAtTimestamp: 5_000 });
+        expect(backend.peek('row-a')).toBeUndefined();
+    });
+
+    it('names the rows a read, a list and an eviction expire; a peek expires nothing', async () => {
+        let nowMs = 1_000;
+        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), () => nowMs);
+        await backend.write(async (tx) => {
+            await tx.set('read:a', '1', 2_000);
+            await tx.set('list:b', '2', 2_000);
+            await tx.set('evict:c', '3', 2_000);
+        });
+        const changed: string[] = [];
+        backend.onChangeDo((key) => changed.push(key));
+        nowMs = 3_000;
+
+        expect(backend.peek('read:a')).toEqual({ key: 'read:a', value: '1', expireAtTimestamp: 2_000 });
+        expect(await backend.read('read:a', decodeVersion)).toBeUndefined();
+        expect(await backend.list('list:', decodeVersion)).toEqual([]);
+        backend.evictExpired();
+
+        expect(changed).toEqual(['read:a', 'list:b', 'evict:c']);
+    });
+
+    it('stops naming keys once unsubscribed', async () => {
+        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), () => 1_000);
+        const changed: string[] = [];
+        backend.onChangeDo((key) => changed.push(key)).unsubscribe();
+
+        await backend.write(async (tx) => {
+            await tx.set('row', '1', 5_000);
+        });
+
+        expect(changed).toEqual([]);
+    });
+});
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/indexeddb-queuebox-computed-write.test.ts b/packages/tests/shared/indexeddb-queuebox-computed-write.test.ts
index 31869a10c..b8df921a1 100644
--- a/packages/tests/shared/indexeddb-queuebox-computed-write.test.ts
+++ b/packages/tests/shared/indexeddb-queuebox-computed-write.test.ts
@@ -14,7 +14,9 @@ import {
     type StoredResourceEntry
 } from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
 import {
-    computeIndexedDbQueuePut
+    computeIndexedDbQueuePut,
+    computeIndexedDbQueueUnconditionalPut,
+    validateComputedIndexedDbQueueMutations
 } from '@shared/queuebox/indexed-db-queue-box-entry.ts';
 import { readStoredQueueEntry } from '@shared/queuebox/indexed-db-queue-box-store.ts';
 import { ResourceInboxLostReservationError } from '@shared/queuebox/queue-box-types.ts';
@@ -147,6 +149,30 @@ describe('IndexedDbQueueBox computed writes', () => {
         expect([first.resource, second.resource]).toContain(stored?.resource);
     });
 
+    it('overwrites a row it never read and inserts a missing one in one transaction', async () => {
+        const storeName = 'entries';
+        const db = await openIndexedDbWithStores(
+            `indexeddb-unconditional-put-${crypto.randomUUID()}`,
+            [{ name: storeName, keyPath: 'keyString' }]
+        );
+        onTestFinished(() => db.close());
+        const initial = computeIndexedDbQueuePut(undefined, createEntry('initial'));
+        await writeComputedIndexedDbQueueMutations({ db, storeName, mutations: [initial] });
+        const inserted = computeIndexedDbQueueUnconditionalPut(createEntry('inserted', 'other-resource'));
+
+        const committed = await writeComputedIndexedDbQueueMutations({
+            db,
+            storeName,
+            mutations: [computeIndexedDbQueueUnconditionalPut(createEntry('replaced')), inserted]
+        });
+
+        expect(committed).toBe(true);
+        expect((await readStoredQueueEntry(db, storeName, initial.keyString))?.resource).toBe('replaced');
+        expect((await readStoredQueueEntry(db, storeName, inserted.keyString))?.resource).toBe('inserted');
+        expect(validateComputedIndexedDbQueueMutations([{ ...inserted, keyString: initial.keyString }]).left?.message)
+            .toContain('mutation key differs');
+    });
+
     it('rolls back every computed mutation when one comparison conflicts', async () => {
         const storeName = 'entries';
         const db = await openIndexedDbWithStores(
```

(c) The dirty set and the capture, with their shared entry builder
`packages/tests/shared/alm/checkpoint/checkpoint-test-entry.ts`:

<!-- dprint-ignore -->
```ts
import { Temporal } from '@js-temporal/polyfill';

import {
    EntityStatus,
    NEVER_EXPIRE_TS,
    toKeyAsString,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

export const CHECKPOINT_TEST_TYPE_ID = 'checkpoint.work';

export function createCheckpointTestEntry(resourceId: string): ResourceEntry {
    return {
        key: { topicId: CHECKPOINT_TEST_TYPE_ID, resourceId, contextId: 'ctx' },
        resource: JSON.stringify({ resourceId }),
        typeId: CHECKPOINT_TEST_TYPE_ID,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'test',
            createdTs: Temporal.PlainDateTime.from('2026-10-02T12:00:00'),
            expiryTs: NEVER_EXPIRE_TS
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0 }
    };
}

export function toCheckpointTestKey(resourceId: string): string {
    return toKeyAsString(createCheckpointTestEntry(resourceId).key);
}
```

`packages/tests/shared/alm/checkpoint/al-checkpoint-dirty-set.test.ts`:

<!-- dprint-ignore -->
```ts
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALCheckpointDirtySet } from '@shared/alm/checkpoint/al-checkpoint-dirty-set.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    CHECKPOINT_TEST_TYPE_ID,
    createCheckpointTestEntry,
    toCheckpointTestKey
} from './checkpoint-test-entry.ts';

interface DirtySetFixture {
    readonly backend: InMemoryAdmissionBackend;
    readonly dirty: ALCheckpointDirtySet;
    readonly clock: { nowMs: number; };
}

function createFixture(): DirtySetFixture {
    const clock = { nowMs: 1_000 };
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(queue), () => clock.nowMs);
    return { backend, dirty: new ALCheckpointDirtySet({ backend, nowMs: () => clock.nowMs }), clock };
}

describe('ALCheckpointDirtySet', () => {
    it('marks each admission row and queue entry once, at the revision of its latest change', async () => {
        const { backend, dirty } = createFixture();

        await backend.write(async (tx) => {
            await tx.set('row-a', '1', 60_000);
            await tx.set('row-b', '2', 60_000);
        });
        await backend.workQueue.enqueue(createCheckpointTestEntry('work'));
        await backend.workQueue.reserveEntries({
            typeIds: new Set([CHECKPOINT_TEST_TYPE_ID]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1
        });

        expect(dirty.getSnapshot()).toEqual({
            marks: [
                { space: 'admission', key: 'row-a', revision: 1 },
                { space: 'admission', key: 'row-b', revision: 2 },
                { space: 'queue', key: toCheckpointTestKey('work'), revision: 4 }
            ],
            takenAtMs: 1_000
        });
    });

    it('clears only the keys whose captured revision is still the latest', async () => {
        const { backend, dirty, clock } = createFixture();
        await backend.write(async (tx) => {
            await tx.set('saved', '1', 60_000);
            await tx.set('changed-during-write', '1', 60_000);
        });
        clock.nowMs = 2_000;
        const snapshot = dirty.getSnapshot();
        clock.nowMs = 2_500;
        await backend.write(async (tx) => {
            await tx.set('changed-during-write', '2', 60_000);
        });

        dirty.clearSaved(snapshot);

        expect(dirty.getSnapshot().marks).toEqual([{ space: 'admission', key: 'changed-during-write', revision: 3 }]);
        // The newer change happened after the capture started, so it is unsaved since then at the latest.
        expect(dirty.getOldestDirtiedAtMs()).toBe(2_000);
    });

    it('reads clean and ageless until a change, and tells its listener of every mark', async () => {
        const { backend, dirty, clock } = createFixture();
        let marked = 0;
        dirty.onMarkedDo(() => {
            marked += 1;
        });

        expect(dirty.isClean()).toBe(true);
        expect(dirty.getOldestDirtiedAtMs()).toBeUndefined();
        clock.nowMs = 1_500;
        await backend.write(async (tx) => {
            await tx.set('row', '1', 60_000);
        });
        clock.nowMs = 1_800;
        await backend.workQueue.enqueue(createCheckpointTestEntry('work'));

        expect(dirty.isClean()).toBe(false);
        expect(dirty.getOldestDirtiedAtMs()).toBe(1_500);
        expect(marked).toBe(2);
    });

    it('marks nothing once disposed', async () => {
        const { backend, dirty } = createFixture();

        dirty.dispose();
        await backend.write(async (tx) => {
            await tx.set('row', '1', 60_000);
        });
        await backend.workQueue.enqueue(createCheckpointTestEntry('work'));

        expect(dirty.isClean()).toBe(true);
    });
});
```

`packages/tests/shared/alm/checkpoint/compute-al-checkpoint-mutations.test.ts` (the third case writes two
checkpoints of the same keys through the one existing `writeIndexedDbAdmissionMutations` into fake-indexeddb and
reads them back with the durable backend's own `list` and its work queue's `getItem`; the second write proves the
overwrite is unconditional):

<!-- dprint-ignore -->
```ts
// @vitest-environment happy-dom

import '../../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALCheckpointDirtySet } from '@shared/alm/checkpoint/al-checkpoint-dirty-set.ts';
import { computeALCheckpointMutations } from '@shared/alm/checkpoint/compute-al-checkpoint-mutations.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { EMPTY_INDEXED_DB_ADMISSION_FENCE } from '@shared/alm/indexed-db-admission-fence.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { writeIndexedDbAdmissionMutations } from '@shared/alm/write-indexed-db-admission-mutations.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { encodeStoredResourceEntry } from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';

import { createCheckpointTestEntry, toCheckpointTestKey } from './checkpoint-test-entry.ts';

interface CaptureFixture {
    readonly backend: InMemoryAdmissionBackend;
    readonly dirty: ALCheckpointDirtySet;
}

function createFixture(): CaptureFixture {
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(1_000));
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(queue), () => 1_000);
    return { backend, dirty: new ALCheckpointDirtySet({ backend, nowMs: () => 1_000 }) };
}

function captureFrom(fixture: CaptureFixture, writeToken: string) {
    return computeALCheckpointMutations({
        snapshot: fixture.dirty.getSnapshot(),
        peekAdmission: (key) => fixture.backend.peek(key),
        peekQueueEntry: (key) => fixture.backend.workQueue.peek(key),
        writeToken
    });
}

describe('computeALCheckpointMutations', () => {
    it('writes the current value of each dirty row once, in the existing row formats', async () => {
        const fixture = createFixture();
        const work = createCheckpointTestEntry('work');
        await fixture.backend.write(async (tx) => {
            await tx.set('row', '1', 60_000);
        });
        await fixture.backend.write(async (tx) => {
            await tx.set('row', '2', 60_000);
        });
        await fixture.backend.workQueue.enqueue(work);

        expect(captureFrom(fixture, 'checkpoint-token')).toEqual({
            mutations: [{
                kind: 'set',
                stored: { key: 'row', value: '2', expireAtTimestamp: 60_000, writeToken: 'checkpoint-token', revision: 1 }
            }],
            queueMutations: [{
                kind: 'put-unconditionally',
                keyString: toCheckpointTestKey('work'),
                value: encodeStoredResourceEntry(work, 0)
            }]
        });
    });

    it('writes a delete for a row removed since it was dirtied', async () => {
        const fixture = createFixture();
        await fixture.backend.write(async (tx) => {
            await tx.set('row', '1', 60_000);
        });
        await fixture.backend.workQueue.enqueue(createCheckpointTestEntry('work'));
        await fixture.backend.write(async (tx) => {
            await tx.remove('row');
        });
        await fixture.backend.workQueue.removeItem(createCheckpointTestEntry('work').key);

        expect(captureFrom(fixture, 'checkpoint-token')).toEqual({
            mutations: [{ kind: 'remove', key: 'row' }],
            queueMutations: [{ kind: 'delete-unconditionally', keyString: toCheckpointTestKey('work') }]
        });
    });

    it('lands, rewritten in place, as rows the durable backend reads as its own', async () => {
        const fixture = createFixture();
        const dbName = `checkpoint-capture-${crypto.randomUUID()}`;
        const db = await openIndexedDbAdmissionDatabase({
            dbName,
            storeName: 'entries',
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });
        onTestFinished(() => db.close());
        const write = async (writeToken: string) => {
            const capture = captureFrom(fixture, writeToken);
            return await writeIndexedDbAdmissionMutations({
                db,
                storeName: 'entries',
                fence: EMPTY_INDEXED_DB_ADMISSION_FENCE,
                mutations: capture.mutations,
                queueMutations: capture.queueMutations
            });
        };
        await fixture.backend.write(async (tx) => {
            await tx.set('checkpoint:row', '1', 60_000);
        });
        await fixture.backend.workQueue.enqueue(createCheckpointTestEntry('work'));
        expect(await write('first')).toBe(true);
        await fixture.backend.write(async (tx) => {
            await tx.set('checkpoint:row', '2', 60_000);
        });
        await fixture.backend.workQueue.enqueue({ ...createCheckpointTestEntry('work'), resource: 'rewritten' });
        expect(await write('second')).toBe(true);
        const durable = new IndexedDbAdmissionBackend({
            dbName,
            storeName: 'entries',
            nowMs: () => 1_000,
            newWriteToken: () => 'unused',
            observer: createPassThroughIndexedDbOperationObserver(),
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {}
        });

        expect(await durable.list('checkpoint:', (value) => value)).toEqual([{ key: 'checkpoint:row', value: '2' }]);
        expect(await durable.workQueue.getItem(createCheckpointTestEntry('work').key))
            .toMatchObject({ key: createCheckpointTestEntry('work').key, resource: 'rewritten' });
    });
});
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared/in-memory-queuebox-changes.test.ts packages/tests/shared/alm/al-admission-backend.test.ts \
  packages/tests/shared/indexeddb-queuebox-computed-write.test.ts packages/tests/shared/alm/checkpoint/al-checkpoint-dirty-set.test.ts \
  packages/tests/shared/alm/checkpoint/compute-al-checkpoint-mutations.test.ts
```

Expected (measured on Task 1's `2348174ec`): `Test Files  5 failed (5)`, `Tests  8 failed | 47 passed (55)`: both
checkpoint files fail to load (`Cannot find package '@shared/alm/checkpoint/al-checkpoint-dirty-set.ts'`); the four
queue cases `TypeError: queue.onChangeDo is not a function`; the three backend cases `TypeError: backend.onChangeDo is
not a function`; the computed-write case `TypeError: computeIndexedDbQueueUnconditionalPut is not a function`.

- [ ] **Step 3: The queue box names its changes and peeks.**

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/queuebox/in-memory-queue-box.ts b/packages/shared/queuebox/in-memory-queue-box.ts
index 72af93eb6..21c89ec7a 100644
--- a/packages/shared/queuebox/in-memory-queue-box.ts
+++ b/packages/shared/queuebox/in-memory-queue-box.ts
@@ -1,6 +1,7 @@
 import { Temporal } from '@js-temporal/polyfill';
 
 import { EnqueuedType } from '../api/api-config.ts';
+import type { Unsubscribe } from '../cache/RepositoryInterfaces.ts';
 import type { PersistenceSetItemOptions } from '../persistence/PersistenceProvider.ts';
 import { Either } from '../resilience/Either.ts';
 import { RateLimiter } from '../resilience/Resilience.ts';
@@ -75,6 +76,7 @@ export class InMemoryQueueBox implements QueueBoxResourceEntryRepository {
     private readonly data: Map<ResourceEntryKeyString, ResourceEntry>;
     private readonly now: () => Temporal.Instant;
     private readonly workIndex = new InMemoryQueueWorkIndex();
+    private readonly changeListeners = new Set<(key: ResourceEntryKeyString) => void>();
     private completedRetention: QueueBoxCompletedRetention = { typeIds: [], topicIds: [] };
 
     private readonly cleanupRateLimiter: RateLimiter = RateLimiter.init(
@@ -106,14 +108,38 @@ export class InMemoryQueueBox implements QueueBoxResourceEntryRepository {
         return await Promise.all(requests.map((request) => this.readWorkPage(request)));
     }
 
+    /** Names, in the turn it happens, every key a write, reservation, release, expiry or cleanup changes. */
+    onChangeDo(listener: (key: ResourceEntryKeyString) => void): Unsubscribe {
+        this.changeListeners.add(listener);
+        return { unsubscribe: () => this.changeListeners.delete(listener) };
+    }
+
+    /** The entry as held now, expired or not; unlike `getItem` it removes nothing. */
+    peek(key: ResourceEntryKeyString): ResourceEntry | undefined {
+        const entry = this.data.get(key);
+        return entry === undefined ? undefined : toResourceEntrySnapshot(entry);
+    }
+
     private storeEntry(key: string, entry: ResourceEntry): void {
         this.workIndex.replace(key, this.data.get(key), entry);
         this.data.set(key, entry);
+        this.notifyChange(key);
     }
 
     private removeEntry(key: string): void {
-        this.workIndex.remove(key, this.data.get(key));
+        const existing = this.data.get(key);
+        if (existing === undefined) {
+            return;
+        }
+        this.workIndex.remove(key, existing);
         this.data.delete(key);
+        this.notifyChange(key);
+    }
+
+    private notifyChange(key: ResourceEntryKeyString): void {
+        for (const listener of this.changeListeners) {
+            listener(key);
+        }
     }
 
     async cleanupAsync(): Promise<boolean> {
```

- [ ] **Step 4: The memory backend names its changes and peeks.**

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/al-admission-backend.ts b/packages/shared/alm/al-admission-backend.ts
index 16237faff..eee1be694 100644
--- a/packages/shared/alm/al-admission-backend.ts
+++ b/packages/shared/alm/al-admission-backend.ts
@@ -1,3 +1,4 @@
+import type { Unsubscribe } from '../cache/RepositoryInterfaces.ts';
 import { requireLivePersistenceWrite } from '../persistence/persistence-write-deadline.ts';
 import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
 import { InMemoryQueueBox } from '../queuebox/in-memory-queue-box.ts';
@@ -64,6 +65,7 @@ export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
     readonly workQueue: InMemoryQueueBox;
     private readonly state: ALAdmissionMemoryState;
     private readonly nowMs: () => number;
+    private readonly changeListeners = new Set<(key: string) => void>();
 
     constructor(
         state: ALAdmissionMemoryState,
@@ -78,12 +80,23 @@ export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
     async ready(): Promise<void> {
     }
 
+    /** Names, in the turn it happens, every admission key a write sets or removes or an expiry removes. */
+    onChangeDo(listener: (key: string) => void): Unsubscribe {
+        this.changeListeners.add(listener);
+        return { unsubscribe: () => this.changeListeners.delete(listener) };
+    }
+
+    /** The row as held now, expired or not; unlike `read` it removes nothing. */
+    peek(key: string): ALAdmissionStoredValue | undefined {
+        return this.state.data.get(key);
+    }
+
     /** The lazy expiry `read` and `list` apply, run over the whole pair; the owning lane calls it. */
     evictExpired(): void {
         const nowMs = this.nowMs();
         for (const [key, stored] of this.state.data) {
             if (stored.expireAtTimestamp <= nowMs) {
-                this.state.data.delete(key);
+                this.deleteStored(key);
             }
         }
         this.workQueue.cleanup();
@@ -110,7 +123,7 @@ export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
         const decoded = decodeALAdmissionValue(stored.value, key, decode);
 
         if (stored.expireAtTimestamp <= this.nowMs()) {
-            this.state.data.delete(key);
+            this.deleteStored(key);
             return undefined;
         }
 
@@ -128,7 +141,7 @@ export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
             const decoded = decodeALAdmissionValue(stored.value, key, decode);
 
             if (stored.expireAtTimestamp <= this.nowMs()) {
-                this.state.data.delete(key);
+                this.deleteStored(key);
                 continue;
             }
 
@@ -163,7 +176,7 @@ export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
                 throw new ALAdmissionBackendConflictError('In-memory AL admission work write conflicted');
             }
             for (const [key, stored] of mutations) {
-                stored === undefined ? this.state.data.delete(key) : this.state.data.set(key, stored);
+                stored === undefined ? this.deleteStored(key) : this.setStored(key, stored);
             }
             return result;
         }
@@ -171,6 +184,23 @@ export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
             release?.();
         }
     }
+
+    private setStored(key: string, stored: ALAdmissionStoredValue): void {
+        this.state.data.set(key, stored);
+        this.notifyChange(key);
+    }
+
+    private deleteStored(key: string): void {
+        if (this.state.data.delete(key)) {
+            this.notifyChange(key);
+        }
+    }
+
+    private notifyChange(key: string): void {
+        for (const listener of this.changeListeners) {
+            listener(key);
+        }
+    }
 }
 
 class ALAdmissionWriteBuffer implements ALAdmissionWriteContext {
```

- [ ] **Step 5: The unconditional queue put.**

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/queuebox/indexed-db-queue-box-entry.ts b/packages/shared/queuebox/indexed-db-queue-box-entry.ts
index 8a69c54f0..957bcd2a3 100644
--- a/packages/shared/queuebox/indexed-db-queue-box-entry.ts
+++ b/packages/shared/queuebox/indexed-db-queue-box-entry.ts
@@ -42,11 +42,18 @@ interface ComputedIndexedDbQueueUnconditionalDelete {
     readonly keyString: ResourceEntryKeyString;
 }
 
+interface ComputedIndexedDbQueueUnconditionalPut {
+    readonly kind: 'put-unconditionally';
+    readonly keyString: ResourceEntryKeyString;
+    readonly value: StoredResourceEntry;
+}
+
 export type ComputedIndexedDbQueueMutation =
     | ComputedIndexedDbQueuePut
     | ComputedIndexedDbQueueGuard
     | ComputedIndexedDbQueueDelete
-    | ComputedIndexedDbQueueUnconditionalDelete;
+    | ComputedIndexedDbQueueUnconditionalDelete
+    | ComputedIndexedDbQueueUnconditionalPut;
 
 export function computeIndexedDbQueuePut(
     stored: StoredResourceEntry | undefined,
@@ -85,6 +92,15 @@ export function computeIndexedDbQueueUnconditionalDelete(
     return { kind: 'delete-unconditionally', keyString };
 }
 
+/** A row written whole by its only writer, which never reads it first: it restarts at revision 0. */
+export function computeIndexedDbQueueUnconditionalPut(entry: ResourceEntry): ComputedIndexedDbQueueUnconditionalPut {
+    return {
+        kind: 'put-unconditionally',
+        keyString: toKeyAsString(entry.key),
+        value: encodeStoredResourceEntry(entry, 0)
+    };
+}
+
 export function validateComputedIndexedDbQueueMutations(
     mutations: readonly ComputedIndexedDbQueueMutation[]
 ): Either<Error, readonly ComputedIndexedDbQueueMutation[]> {
@@ -93,7 +109,7 @@ export function validateComputedIndexedDbQueueMutations(
         for (const mutation of mutations) {
             if (
                 mutation.kind !== 'put' && mutation.kind !== 'delete' && mutation.kind !== 'guard' &&
-                mutation.kind !== 'delete-unconditionally'
+                mutation.kind !== 'delete-unconditionally' && mutation.kind !== 'put-unconditionally'
             ) {
                 return Either.ofLeft(new TypeError('IndexedDB queue mutation kind is unsupported'));
             }
@@ -107,6 +123,13 @@ export function validateComputedIndexedDbQueueMutations(
             if (mutation.kind === 'delete-unconditionally') {
                 continue;
             }
+            if (mutation.kind === 'put-unconditionally') {
+                const issue = validateStoredQueueValue(mutation);
+                if (issue) {
+                    return Either.ofLeft(issue);
+                }
+                continue;
+            }
             if (!isValidIndexedDbQueueExpectedState(mutation.expected)) {
                 return Either.ofLeft(
                     new TypeError('IndexedDB queue expected state must be missing or a non-negative revision')
@@ -121,9 +144,9 @@ export function validateComputedIndexedDbQueueMutations(
                 }
                 continue;
             }
-            decodeStoredResourceEntryValue(mutation.value);
-            if (mutation.value.keyString !== mutation.keyString) {
-                return Either.ofLeft(new TypeError('IndexedDB queue mutation key differs from its stored value'));
+            const issue = validateStoredQueueValue(mutation);
+            if (issue) {
+                return Either.ofLeft(issue);
             }
             const expectedRevision = mutation.expected.kind === 'missing'
                 ? 0
@@ -139,6 +162,15 @@ export function validateComputedIndexedDbQueueMutations(
     }
 }
 
+function validateStoredQueueValue(
+    mutation: ComputedIndexedDbQueuePut | ComputedIndexedDbQueueUnconditionalPut
+): TypeError | undefined {
+    decodeStoredResourceEntryValue(mutation.value);
+    return mutation.value.keyString === mutation.keyString
+        ? undefined
+        : new TypeError('IndexedDB queue mutation key differs from its stored value');
+}
+
 export function computeReservedQueueEntry(
     entry: ResourceEntry,
     now: Temporal.Instant
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts b/packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts
index 57588b1fb..255e81d6b 100644
--- a/packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts
+++ b/packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts
@@ -69,6 +69,10 @@ export function submitComputedIndexedDbQueueMutations(
             eligibility.observe(store.delete(mutation.keyString));
             continue;
         }
+        if (mutation.kind === 'put-unconditionally') {
+            eligibility.observe(store.put(mutation.value));
+            continue;
+        }
         const request = eligibility.observe(store.get(mutation.keyString));
         request.onsuccess = () => {
             if (state.conflict || state.storedValueError || eligibility.expired) {
```

- [ ] **Step 6: The dirty set.** Create `packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts`:

<!-- dprint-ignore -->
```ts
import { LatestRepository } from '../../cache/LatestRepository.ts';
import type { Unsubscribe } from '../../cache/RepositoryInterfaces.ts';
import type { InMemoryAdmissionBackend } from '../al-admission-backend.ts';

export namespace ALCheckpointDirtySet {
    /** The object store a row lands in: an admission row of `entries`, or a queue entry of `alm-work`. */
    export type Space = 'admission' | 'queue';

    export interface Mark {
        readonly space: Space;
        readonly key: string;
        /** The set's change count at the key's latest change; a save clears the key only at this revision. */
        readonly revision: number;
    }

    export interface Snapshot {
        readonly marks: readonly Mark[];
        readonly takenAtMs: number;
    }

    export interface Input {
        /** The memory pair whose admission rows and work queue the set follows. */
        readonly backend: Pick<InMemoryAdmissionBackend, 'onChangeDo' | 'workQueue'>;
        readonly nowMs: () => number;
    }
}

interface ALCheckpointDirtyRow {
    readonly revision: number;
    readonly dirtiedAtMs: number;
}

/**
 * The keys of one memory pair changed since its checkpoint last saved them. A key changed several
 * times is one mark at its latest revision, so a save that captured an older revision leaves it dirty.
 */
export class ALCheckpointDirtySet {
    private readonly nowMs: () => number;
    private readonly admissionRows = new LatestRepository<string, ALCheckpointDirtyRow>();
    private readonly queueRows = new LatestRepository<string, ALCheckpointDirtyRow>();
    private readonly markedListeners = new Set<() => void>();
    private readonly subscriptions: readonly Unsubscribe[];
    private revision = 0;

    constructor(input: ALCheckpointDirtySet.Input) {
        this.nowMs = input.nowMs;
        this.subscriptions = [
            input.backend.onChangeDo((key) => this.mark(this.admissionRows, key)),
            input.backend.workQueue.onChangeDo((key) => this.mark(this.queueRows, key))
        ];
    }

    /** Called after every mark, in the turn of the change that made it. */
    onMarkedDo(listener: () => void): Unsubscribe {
        this.markedListeners.add(listener);
        return { unsubscribe: () => this.markedListeners.delete(listener) };
    }

    isClean(): boolean {
        return this.admissionRows.size() === 0 && this.queueRows.size() === 0;
    }

    /** When the longest-unsaved key last held saved state; undefined while the set is clean. */
    getOldestDirtiedAtMs(): number | undefined {
        return [...this.admissionRows.readAllValues(), ...this.queueRows.readAllValues()].reduce<number | undefined>(
            (oldest, row) => oldest === undefined ? row.dirtiedAtMs : Math.min(oldest, row.dirtiedAtMs),
            undefined
        );
    }

    getSnapshot(): ALCheckpointDirtySet.Snapshot {
        return {
            marks: [...toMarks('admission', this.admissionRows), ...toMarks('queue', this.queueRows)],
            takenAtMs: this.nowMs()
        };
    }

    /**
     * Clears every key a completed save captured at its latest revision. A key changed since stays
     * dirty, and is counted unsaved from the snapshot on: its newer change came after it.
     */
    clearSaved(snapshot: ALCheckpointDirtySet.Snapshot): void {
        for (const mark of snapshot.marks) {
            const rows = mark.space === 'admission' ? this.admissionRows : this.queueRows;
            const row = rows.peek(mark.key);
            if (row?.revision === mark.revision) {
                rows.delete(mark.key);
            }
            else if (row !== undefined) {
                rows.set(mark.key, { ...row, dirtiedAtMs: Math.max(row.dirtiedAtMs, snapshot.takenAtMs) });
            }
        }
    }

    dispose(): void {
        for (const subscription of this.subscriptions) {
            subscription.unsubscribe();
        }
    }

    private mark(rows: LatestRepository<string, ALCheckpointDirtyRow>, key: string): void {
        this.revision += 1;
        const dirtiedAtMs = rows.peek(key)?.dirtiedAtMs ?? this.nowMs();
        rows.set(key, { revision: this.revision, dirtiedAtMs });
        for (const listener of this.markedListeners) {
            listener();
        }
    }
}

function toMarks(
    space: ALCheckpointDirtySet.Space,
    rows: LatestRepository<string, ALCheckpointDirtyRow>
): ALCheckpointDirtySet.Mark[] {
    return [...rows.entriesView()].flatMap(([key, entry]) => {
        const row = entry.peek();
        return row === undefined ? [] : [{ space, key, revision: row.revision }];
    });
}
```

- [ ] **Step 7: The capture.** Create `packages/shared/alm/checkpoint/compute-al-checkpoint-mutations.ts`:

<!-- dprint-ignore -->
```ts
import {
    computeIndexedDbQueueUnconditionalDelete,
    computeIndexedDbQueueUnconditionalPut,
    type ComputedIndexedDbQueueMutation
} from '../../queuebox/indexed-db-queue-box-entry.ts';
import type { ResourceEntry, ResourceEntryKeyString } from '../../queuebox/ResourceEntry.ts';
import type { ALAdmissionStoredValue } from '../al-admission-backend.ts';
import { INDEXED_DB_ADMISSION_FIRST_REVISION } from '../indexed-db-admission-fence.ts';
import type { IndexedDbAdmissionMutation } from '../write-indexed-db-admission-mutations.ts';
import type { ALCheckpointDirtySet } from './al-checkpoint-dirty-set.ts';

export interface ComputeALCheckpointMutationsInput {
    readonly snapshot: ALCheckpointDirtySet.Snapshot;
    readonly peekAdmission: (key: string) => ALAdmissionStoredValue | undefined;
    readonly peekQueueEntry: (key: ResourceEntryKeyString) => ResourceEntry | undefined;
    /** One token for every row this checkpoint writes. */
    readonly writeToken: string;
}

/** The arguments of the one `writeIndexedDbAdmissionMutations` call a checkpoint makes. */
export interface ALCheckpointMutations {
    readonly mutations: readonly IndexedDbAdmissionMutation[];
    readonly queueMutations: readonly ComputedIndexedDbQueueMutation[];
}

/**
 * The checkpoint of one snapshot's dirty keys: each key's value as the memory pair holds it now, written
 * whole, or a delete when the pair holds none. The checkpoint is the rows' only writer and never reads
 * them first, so no mutation is conditional. The caller takes the snapshot and calls this in one turn.
 */
export function computeALCheckpointMutations(input: ComputeALCheckpointMutationsInput): ALCheckpointMutations {
    const mutations: IndexedDbAdmissionMutation[] = [];
    const queueMutations: ComputedIndexedDbQueueMutation[] = [];
    for (const { space, key } of input.snapshot.marks) {
        if (space === 'admission') {
            mutations.push(toAdmissionMutation(key, input.peekAdmission(key), input.writeToken));
        }
        else {
            const entry = input.peekQueueEntry(key);
            queueMutations.push(
                entry === undefined
                    ? computeIndexedDbQueueUnconditionalDelete(key)
                    : computeIndexedDbQueueUnconditionalPut(entry)
            );
        }
    }
    return { mutations, queueMutations };
}

function toAdmissionMutation(
    key: string,
    stored: ALAdmissionStoredValue | undefined,
    writeToken: string
): IndexedDbAdmissionMutation {
    return stored === undefined
        ? { kind: 'remove', key }
        : { kind: 'set', stored: { ...stored, writeToken, revision: INDEXED_DB_ADMISSION_FIRST_REVISION } };
}
```

- [ ] **Step 8: Format the touched files only.**

```sh
npx dprint fmt packages/shared/queuebox/in-memory-queue-box.ts packages/shared/alm/al-admission-backend.ts \
  packages/shared/queuebox/indexed-db-queue-box-entry.ts packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts \
  packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts packages/shared/alm/checkpoint/compute-al-checkpoint-mutations.ts \
  packages/tests/shared/in-memory-queuebox-changes.test.ts packages/tests/shared/alm/al-admission-backend.test.ts \
  packages/tests/shared/indexeddb-queuebox-computed-write.test.ts packages/tests/shared/alm/checkpoint/checkpoint-test-entry.ts \
  packages/tests/shared/alm/checkpoint/al-checkpoint-dirty-set.test.ts packages/tests/shared/alm/checkpoint/compute-al-checkpoint-mutations.test.ts
```

- [ ] **Step 9: Run them green, with the in-memory QueueBox family and the pins.**

```sh
npx vitest run packages/tests/shared/alm/checkpoint packages/tests/shared/in-memory-queuebox-changes.test.ts \
  packages/tests/shared/alm/al-admission-backend.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts \
  packages/tests/shared/in-memory-queuebox.test.ts packages/tests/shared/in-memory-queuebox-dequeue.test.ts \
  packages/tests/shared/in-memory-queuebox-value-ownership.test.ts
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts
npx vitest run --project unit
```

Expected (measured): `Test Files  8 passed (8)`, `Tests  147 passed (147)`; the pins `Test Files  3 passed (3)`,
`Tests  25 passed (25)`, unedited (the D55 zero pin included); the unit project `Test Files  5 failed | 1353 passed |
4 skipped (1362)`, every failure a sandboxed port bind (`live-rtc-control-client`, `api-v1-rtc-rtt-recipe-semantics`,
`api-v1-state-write-convergence-recipe`, `local-websocket-session`, `headless-worker-script`), all passing unsandboxed.

- [ ] **Step 10: Per-task checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
npm --workspace @ar-eye-hunter/shared-test run typecheck
(cd apps/api-v1 && deno task check); rm -rf apps/api-v1/node_modules/.deno; find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete
node scripts/check-tests-typecheck.mjs
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
npm run check:test-reachability
```

Expected (measured): no `tsc` output; the three workspace typechecks and `deno task check` exit 0;
`check-tests-typecheck: 1438 test files enforced, 0 files carrying known debt (0 errors).` `PASS`; `browser/rallar.ts`
234.439 KiB (234.4 in the table, budget 235, `Bundle budget check passed.`); headless 299.448 KiB (budget 300) and both
boundary tests `Tests  6 passed (6)`; `Test reachability: 1740 test files, 1734 reached by CI, 6 manual.` (three test
files added; the entry builder is not a test file). No change under `alm/inbound/**` or `alm/work/**`, so
`npm run test:postgres:integration` is not required; no shared-web public surface changes.

- [ ] **Step 11: Commit, then run the changed-range gates.**

```sh
git add packages/shared/queuebox/in-memory-queue-box.ts packages/shared/alm/al-admission-backend.ts \
  packages/shared/queuebox/indexed-db-queue-box-entry.ts packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts \
  packages/shared/alm/checkpoint packages/tests/shared/in-memory-queuebox-changes.test.ts \
  packages/tests/shared/alm/al-admission-backend.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts \
  packages/tests/shared/alm/checkpoint
git commit -F - <<'EOF'
Track the changed rows of a memory pair and capture them as one checkpoint

InMemoryQueueBox and InMemoryAdmissionBackend name every key they store
or remove, through their existing choke points, in the turn it happens,
and offer a peek that reads without expiring. ALCheckpointDirtySet
follows one memory pair's admission rows and work queue, keeps each
changed key once at the revision of its latest change, and clears after
a save only the keys whose captured revision is still the latest.
computeALCheckpointMutations turns one snapshot of dirty keys into the
current rows in the existing entries and alm-work formats, or deletes,
for one writeIndexedDbAdmissionMutations call. The work rows use a new
unconditional put beside the existing unconditional delete, since the
checkpoint is their only writer and reads nothing first.

browser/rallar.ts measures 234.439 KiB (budget 235); the headless bundle
299.448 KiB (budget 300).

D8 reuse: dirty rows are LatestRepository state from packages/shared/cache and the listener sets are plain Sets (no keyed state); the capture emits the existing IndexedDbAdmissionMutation row shape and P1a's encodeStoredResourceEntry for the one existing writeIndexedDbAdmissionMutations, with put-unconditionally mirroring delete-unconditionally; WriteBehindObservableLatestRepository is not reused (per-key writes, no single transaction).
EOF
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured): `PASS: no new repository style findings (5e06c6ab0… -> HEAD).`; the structure-coupling gate as in
Task 1 (one already-classified touched candidate, three `PASS` lines).

---

### Task 3: The checkpoint writer: interval, single flight, revisions, one readwrite, lag health

Prototyped in scratch as commit `028bac004` on W-A's Task 2 (`97402de59`, from `git am` of `patch-task-1.patch` and
`patch-task-2.patch` on `5e06c6ab0`), red then green; `git am` of patches 1–4 on `5e06c6ab0` reproduces the prototype
tree. Decisions D129 (one readwrite of changed rows, no new row shape), D132 (owner only, held by Task 4's checkpoint), D133 (interval and lag
bound); QoS plan §4 "Capture and write", "Dispatch never waits", "Triggers"; §6 "Recovery-lag bound"; §9.2 rows
"A mutation during a write reaches the next checkpoint, and an older completion never marks newer state saved",
"The interval target holds under continuous change". Fact sheet §3 (`ALStorageHealth`, `ALStorageUnavailableCause`),
§5 (timers). Rulings: R-I2b-3 (current values, not a log), R-I2b-4 (per-key
revisions), R-I2b-5 (`delayed`, `oldestUnsavedAgeMs`, `checkpoint-lag`), R-I2b-7 (flush is best effort), R-I2b-12
(no `WriteBehindObservableLatestRepository`), R-I2b-17 (the `checkpoint/` folder, Task 2's dirty-set API), R-I2b-25 and
R-I2b-36 (the shared mutation writer commits its readwrite once its last request is issued, and its completion is
handled before any request), R-I2b-30 (no lag check while a write is in flight), R-I2b-37 (Task 4 builds the writer
only once its runtime owns the work), R-I2b-44 and R-I2b-46 (so the writer takes no ownership at all), R-I2b-45 (the
inbound diagnostics case waits for the drain event it asserts).

**Assembly.** Commit `34cec086d` on `2ec605ba5` (Task 2) in the composed chain; W-B's prototype `028bac004` plus
R-I2b-25 as R-I2b-36 settles it (Steps 1(c), 6), R-I2b-44 and R-I2b-46 remove the writer's ownership input, its guard
and its ownership test, and R-I2b-45
adds one wait to an inbound diagnostics test (Step 1(d)). Bundle figures are read with a private `TMPDIR` (R-I2b-23): the
bundle script and the headless boundary test write under `os.tmpdir()`, which every worktree of the machine shares.
After every `cd apps/api-v1 && deno task check`, run `rm -rf apps/api-v1/node_modules/.deno` and
`find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete` (a left-behind `.deno` breaks the next check).

**Files**

- Create: `packages/shared/alm/checkpoint/al-checkpoint-writer.ts` (203 lines) —
  `ALCheckpointWriter`: the interval, single flight, revisions through Task 2's `clearSaved`, the lag health. It sits
  in Task 2's `checkpoint/` folder (R-I2b-17): the feature owns its dirty set, capture and writer together; it is not
  a storage-truth primitive of `storage/` (health, readiness, recovery) and not outbound-specific.
- Modify: `packages/shared/alm/storage/al-storage-event.ts` — `ALStorageHealthStatus` gains `'delayed'`;
  `ALStorageHealthState` gains the required `oldestUnsavedAgeMs: number | undefined`, last, so the harness's JSON text
  matches on the existing keys keep their order (`al-storage-health.test.ts:42-48` pins it).
- Modify: `packages/shared/alm/storage/al-storage-health.ts` — `recordLagFailure(failure, oldestUnsavedAgeMs)`,
  `recordDelayed(oldestUnsavedAgeMs, lastFailure)` (only from `healthy`), and `recordRecoveryPoint` ends `delayed`
  as well as `failing`. `equals` still compares the status only, so `delayed` is stated once on entry.
- Modify: `packages/shared/alm/storage/al-storage-unavailable.ts` — the cause `'checkpoint-lag'`.
- Modify: `packages/shared/alm/write-indexed-db-admission-mutations.ts` — R-I2b-36: the context counts the two parts
  that issue requests (the admission store's after its fence re-reads and guarded removals, and the queue's when it has
  mutations); `commitIssuedIndexedDbAdmissionWrite` calls `transaction.commit?.()` when the last part is issued and the
  write carries no deadline; `completed.catch(() => undefined)` before any request is issued (W-B's surprise 2:
  `completed` was created before the submits, so a `put` that throws synchronously left its rejection unhandled).
- Modify: `packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts` — `submitComputedIndexedDbQueueMutations`
  takes one input object, `SubmitComputedIndexedDbQueueMutationsInput { store, mutations, eligibility, onIssued }`
  (a fourth positional parameter would break the three-parameter rule), and calls `onIssued` once its last request is
  issued: at once when every mutation is unconditional, otherwise from the read callback of the last compare-and-set
  mutation. A conflict, a stored-value error or an expiry calls nothing. Its other caller,
  `writeComputedIndexedDbQueueMutations`, passes `onIssued: () => undefined`.
- Sweep of the widened types, by enumeration (`grep -rn "ALStorageHealthState\|ALStorageUnavailableCause\|lastRecoveryPointAtMs"`):
  `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts:48-56` (exhaustive `Record` gains
  `'checkpoint-lag'`), `packages/shared-web/browser/session/delete-ended-session-al-runtime-entries.ts:37-45` (the
  only other health-event builder), and two typed test literals
  (`packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts:398-404`,
  `packages/tests/shared-web/al-runtime/browser-al-storage-recovery.test.ts:143-150`). `rallar.ts:292`/`rallar-core.ts:139`
  re-export the type names unchanged (the public API snapshot lists names and stays green). The control server's
  scripted health payload (`control-generated-alm-reload.test.ts:379-388`) is untyped JSON and is Task 7's.
- Test (create): `packages/tests/shared/alm/checkpoint/al-checkpoint-test-support.ts` (11 lines; the settings and the
  global-timer port; Task 4 adds a takeable ownership to it),
  `packages/tests/shared/alm/checkpoint/al-checkpoint-writer.test.ts` (236 lines, ten cases).
- Test (modify): `packages/tests/shared/alm/inbound-admission-diagnostics.test.ts` — R-I2b-45: "settles the claim as a
  retry when the dispatch it ran asked for one over %s" polls for the batch's drain event before asserting it, as its
  sibling case at `:176` does (the earlier commit can move the event by a turn; no timeout is widened).
- Test (modify): `packages/tests/shared/alm/storage/al-storage-health.test.ts` (two cases);
  `packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts` (three cases: the commit after a compare-and-set
  write, none for a write with a deadline, the refused `put` without an unhandled rejection), observing commits
  through a recording spy that calls the real `commit` (no mock call count, so the changed-range coupling gate reports
  no new candidate).
- Not touched: the durable and volatile lanes, the pins, `docs/rallar-api-reference.md:718` and the harness contract
  doc (`runtime-diagnostic-contract.md:480`), which describe the health event and are Task 5's and Task 7's.

**Interfaces**

- Consumes (Task 2, W-A): `ALCheckpointDirtySet` (`onMarkedDo`, `isClean`, `getOldestDirtiedAtMs`, `getSnapshot →
  {marks, takenAtMs}`, `clearSaved(snapshot)`), `computeALCheckpointMutations({ snapshot, peekAdmission,
  peekQueueEntry, writeToken }) → { mutations, queueMutations }`, `InMemoryAdmissionBackend.peek(key)` and
  `InMemoryQueueBox.peek(key)`.
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // packages/shared/alm/checkpoint/al-checkpoint-writer.ts
  export namespace ALCheckpointWriter {
      export interface Settings { readonly intervalMs: number; readonly lagBoundMs: number; }
      /** `schedule` runs `run` once after `delayMs` and answers its cancel. */
      export interface Timers { readonly schedule: (run: () => void, delayMs: number) => () => void; }
      export interface Input {
          readonly memory: Pick<InMemoryAdmissionBackend, 'peek' | 'workQueue'>;
          readonly dirty: ALCheckpointDirtySet;
          readonly write: (mutations: ALCheckpointMutations) => Promise<void>;   // one readwrite; all or nothing
          readonly health: ALStorageHealth;
          readonly settings: Settings;
          readonly nowMs: () => number;
          readonly timers: Timers;
      }
  }
  export class ALCheckpointWriter {
      constructor(input: ALCheckpointWriter.Input);   // subscribes to dirty.onMarkedDo only; no ownership (R-I2b-46)
      flush(): void;     // starts a checkpoint now, or right after the one in flight; never awaited
      dispose(): void;   // cancels the armed timer and unsubscribes
  }

  // packages/shared/alm/storage/al-storage-event.ts
  export type ALStorageHealthStatus = 'healthy' | 'delayed' | 'failing';
  export interface ALStorageHealthState { /* … */ readonly oldestUnsavedAgeMs: number | undefined; }
  // packages/shared/alm/storage/al-storage-unavailable.ts:  ALStorageUnavailableCause gains 'checkpoint-lag'
  // packages/shared/alm/storage/al-storage-health.ts
  recordLagFailure(failure: ALStorageUnavailable, oldestUnsavedAgeMs: number): void;
  recordDelayed(oldestUnsavedAgeMs: number, lastFailure: ALStorageUnavailable | undefined): void;
  // packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts
  export interface SubmitComputedIndexedDbQueueMutationsInput {
      readonly store: IDBObjectStore;
      readonly mutations: readonly ComputedIndexedDbQueueMutation[];
      readonly eligibility: IndexedDbWriteDeadline;
      readonly onIssued: () => void;   // once the last request is issued; never after a conflict, error or expiry
  }
  export function submitComputedIndexedDbQueueMutations(
      input: SubmitComputedIndexedDbQueueMutationsInput
  ): Readonly<IndexedDbQueueWriteState>;
  ```
- Behaviour: the writer arms one timer at `oldestDirtiedAtMs + intervalMs` (the dirty set keeps each key's first
  unsaved instant, so a later change never postpones it) when the pair is dirty, no write is in flight and no timer
  is armed; nothing is armed while the pair is clean. At fire it states the
  lag, then takes the snapshot and the capture in one turn and calls `write` once. A completed write calls
  `dirty.clearSaved(snapshot)` (a key changed during the write keeps its newer revision and its unsaved-since moves to
  `takenAtMs`), records a recovery point (`delayed`/`failing` → `healthy`) and re-arms for what is left. A failed
  write leaves every captured key unsaved and retries an interval after the failure. The lag: past `intervalMs`
  `recordDelayed(age, lastWriteFailure)`; past `lagBoundMs` `recordLagFailure({ cause: 'checkpoint-lag', detail })`
  once, the detail naming the last failed write; the timer is due at the bound when the bound falls before the next
  attempt, so `failing` is stated at the bound. The writer holds no ownership (R-I2b-46): Task 4's checkpoint builds
  it only in the runtime that owns the work. `flush()` during a write runs the next write right after
  it. Every `writeIndexedDbAdmissionMutations` (the
  checkpoint's, the durable lane's, the purge's) calls `transaction.commit()` once its last request is issued unless it
  carries a deadline, so a checkpoint begun while the page hides can land before the page ends: `commit()` is
  requested once the last request is issued, and never for a write with a deadline (an abort after `commit()` would
  throw; R-I2b-36).

**D8 reuse inspection.** The dirty keys, their revisions and the oldest unsaved instant are Task 2's
`ALCheckpointDirtySet` (a `LatestRepository` per space); the capture is Task 2's `computeALCheckpointMutations`
over the backend's and the queue's `peek`; the health is the existing `ALStorageHealth` (`ObservableLatestValue`,
`equals` by status, so `delayed` is stated once) gaining two recorders, and a failed write is mapped by the existing
`toALStorageUnavailable`. The single-flight flag is one field (a snapshot) and the timer one cancel function, the one
new timer the S3 waiver names (QoS §4 "Waiver"); the engine's `wakeAt` (`InboxOutboxEngine.ts:80-96`) is not used
because the checkpoint must run in a runtime whose engine is idle and its interval is the lane's, not a work row's.
`WriteBehindObservableLatestRepository` (`WriteBehindObservableLatestRepository.ts:51-165`) is not reused
(R-I2b-12): it writes each key immediately on a promise chain, without coalescing, interval or one transaction.
The injected timer is `schedule(run, delayMs) → cancel`, not `setTimeout`/`clearTimeout`: an opaque handle would be an
`unknown` the repo's `boundary.unknown` rule flags three times, and a `ReturnType<typeof setTimeout>` differs between
the DOM build and the Node test build. The tests reuse `vi.useFakeTimers` and the real memory backend, dirty set
and capture; the new support module holds the settings and the global-timer port. The commit edit stays in the one shared writer
(`write-indexed-db-admission-mutations.ts`) rather than a checkpoint-only writer, and the queue submitter's existing
state object and loop carry the count of unissued compare-and-set writes; no second writer, counter class or promise.

**Limits.** No lag is stated while a write is in flight: a write's completion or failure is the next evaluation (an
IndexedDB transaction completes or aborts; R-I2b-30). The writer takes no ownership input and has no owner guard
(R-I2b-44, R-I2b-46): ownership is Task 4's `ALCheckpoint`'s alone, which builds the dirty set and the writer only once
its runtime owns the work, and whose takeover marking arms the writer through `onMarkedDo` (R-I2b-28, R-I2b-37); a
waiting runtime keeps no marks and holds no writer at all. `delayed` is stated on a late timer (a throttled page) or a failed write; a checkpoint that starts on time
and completes reads `healthy` throughout. A write with a persistence deadline keeps the browser's own commit (its
expiry aborts it from a request's success, which `abort()` refuses once `commit()` ran); an unload-time readwrite
landed 2/4–3/4 with `commit()` and 0/4 without it (W-D's probe), so the commit raises the landing rate, not to one.

- [ ] **Step 1: Write the failing tests.** Create `packages/tests/shared/alm/checkpoint/al-checkpoint-test-support.ts`:

<!-- dprint-ignore -->
```ts
import type { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';

export const TEST_CHECKPOINT_SETTINGS: ALCheckpointWriter.Settings = { intervalMs: 1_000, lagBoundMs: 10_000 };

/** The global timers, read at each call, so a test's fake timers drive the writer. */
export const GLOBAL_CHECKPOINT_TIMERS: ALCheckpointWriter.Timers = {
    schedule: (run, delayMs) => {
        const handle = setTimeout(run, delayMs);
        return () => clearTimeout(handle);
    }
};
```

Create `packages/tests/shared/alm/checkpoint/al-checkpoint-writer.test.ts`:

<!-- dprint-ignore -->
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALCheckpointDirtySet } from '@shared/alm/checkpoint/al-checkpoint-dirty-set.ts';
import { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';
import type { ALCheckpointMutations } from '@shared/alm/checkpoint/compute-al-checkpoint-mutations.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    GLOBAL_CHECKPOINT_TIMERS,
    TEST_CHECKPOINT_SETTINGS
} from './al-checkpoint-test-support.ts';

const STORE_ID = 'browser-ws-client-checkpoint:session-1';
const QUOTA = new DOMException('full', 'QuotaExceededError');
const START_MS = 1_800_000_000_000;
const ROW_EXPIRY_MS = START_MS + 3_600_000;

beforeEach(() => {
    vi.useFakeTimers({ now: START_MS });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('ALCheckpointWriter', () => {
    it('arms one checkpoint an interval after the first change, and a later change never postpones it', async () => {
        const fixture = createWriterFixture();

        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(600);
        await fixture.change('b', 'two');
        await vi.advanceTimersByTimeAsync(399);
        expect(fixture.writes).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one', b: 'two' }]);
    });

    it('runs nothing while the pair is clean', async () => {
        const fixture = createWriterFixture();

        await vi.advanceTimersByTimeAsync(60_000);

        expect(fixture.writes).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps one write in flight, and a change made during it reaches the next one', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(1_000);

        await fixture.change('b', 'two');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fixture.writes).toHaveLength(1);
        fixture.writes[0]!.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one' }, { b: 'two' }]);
    });

    it('never marks a change made during a write saved when that write completes', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(1_000);

        await fixture.change('a', 'two');
        fixture.writes[0]!.resolve();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one' }, { a: 'two' }]);
    });

    it('writes a key removed since it changed as a removal', async () => {
        const fixture = createWriterFixture();

        await fixture.change('a', 'one');
        await fixture.change('a', undefined);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(fixture.writes.map((write) => write.mutations.mutations)).toEqual([[{ kind: 'remove', key: 'a' }]]);
    });

    it('keeps the keys of a failed write unsaved and writes them again an interval later', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(1_000);

        fixture.writes[0]!.reject(QUOTA);
        await vi.advanceTimersByTimeAsync(999);
        expect(fixture.writes).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one' }, { a: 'one' }]);
    });

    it('states delayed once, with the oldest unsaved age and the failure that delays it', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');
        await vi.advanceTimersByTimeAsync(1_000);

        await vi.advanceTimersByTimeAsync(200);
        fixture.writes[0]!.reject(QUOTA);
        await vi.advanceTimersByTimeAsync(1_000);
        fixture.writes[1]!.reject(QUOTA);
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.events).toEqual([{
            kind: 'health',
            storeId: STORE_ID,
            status: 'delayed',
            lastFailure: { cause: 'quota', detail: 'QuotaExceededError: full' },
            lastRecoveryPointAtMs: undefined,
            oldestUnsavedAgeMs: 1_200
        }]);
    });

    it('states failing with checkpoint-lag at the bound, naming the last failed write, and healthy when a checkpoint completes', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');

        for (let attempt = 0; attempt < 10; attempt += 1) {
            await vi.advanceTimersByTimeAsync(1_000);
            fixture.writes.at(-1)!.reject(QUOTA);
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(fixture.events.map((event) => event.kind === 'health' && event.status)).toEqual(['delayed']);
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(999);
        fixture.writes.at(-1)!.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.writes).toHaveLength(11);
        expect(fixture.events.slice(1)).toEqual([
            {
                kind: 'health',
                storeId: STORE_ID,
                status: 'failing',
                lastFailure: {
                    cause: 'checkpoint-lag',
                    detail: 'The oldest unsaved change is 10001 ms old, beyond the 10000 ms bound. ' +
                        'The last checkpoint failed: QuotaExceededError: full'
                },
                lastRecoveryPointAtMs: undefined,
                oldestUnsavedAgeMs: 10_001
            },
            {
                kind: 'health',
                storeId: STORE_ID,
                status: 'healthy',
                lastFailure: {
                    cause: 'checkpoint-lag',
                    detail: 'The oldest unsaved change is 10001 ms old, beyond the 10000 ms bound. ' +
                        'The last checkpoint failed: QuotaExceededError: full'
                },
                lastRecoveryPointAtMs: START_MS + 11_000,
                oldestUnsavedAgeMs: undefined
            }
        ]);
    });

    it('flushes now, and a flush during a write runs right after that write', async () => {
        const fixture = createWriterFixture();
        fixture.writer.flush();
        expect(fixture.writes).toHaveLength(0);

        await fixture.change('a', 'one');
        fixture.writer.flush();
        await fixture.change('b', 'two');
        fixture.writer.flush();
        expect(fixture.writes).toHaveLength(1);
        fixture.writes[0]!.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(fixture.writes.map(toWrittenValues)).toEqual([{ a: 'one' }, { b: 'two' }]);
    });

    it('cancels its armed checkpoint when disposed', async () => {
        const fixture = createWriterFixture();
        await fixture.change('a', 'one');

        fixture.writer.dispose();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(fixture.writes).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});

interface HeldWrite {
    readonly mutations: ALCheckpointMutations;
    resolve(): void;
    reject(error: Error): void;
}

function createWriterFixture(): Readonly<{
    writer: ALCheckpointWriter;
    writes: readonly HeldWrite[];
    events: readonly ALStorageEvent[];
    change(key: string, value: string | undefined): Promise<void>;
}> {
    const nowMs = () => Date.now();
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs()));
    const memory = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(queue), nowMs);
    const writes: HeldWrite[] = [];
    const events: ALStorageEvent[] = [];
    const writer = new ALCheckpointWriter({
        memory,
        dirty: new ALCheckpointDirtySet({ backend: memory, nowMs }),
        write: (mutations) => {
            const held = Promise.withResolvers<void>();
            writes.push({ mutations, resolve: () => held.resolve(), reject: (error) => held.reject(error) });
            return held.promise;
        },
        health: new ALStorageHealth({ storeId: STORE_ID, storage: (event) => events.push(event) }),
        settings: TEST_CHECKPOINT_SETTINGS,
        nowMs,
        timers: GLOBAL_CHECKPOINT_TIMERS
    });
    const change = async (key: string, value: string | undefined): Promise<void> => {
        await memory.write(async (tx) => value === undefined ? await tx.remove(key) : await tx.set(key, value, ROW_EXPIRY_MS));
    };
    return { writer, writes, events, change };
}

function toWrittenValues(write: HeldWrite): Readonly<Record<string, string>> {
    return Object.fromEntries(
        write.mutations.mutations.flatMap((mutation) => mutation.kind === 'set' ? [[mutation.stored.key, String(mutation.stored.value)]] : [])
    );
}
```

The fake clock starts at `1_800_000_000_000`, not `0`: `LatestValue` treats a value accepted at `Date.now() === 0` as
never set (`LatestValue.ts:162-164`), so the dirty set's `getOldestDirtiedAtMs` (`readAllValues`) reads nothing at
the epoch.

Add the health cases to `packages/tests/shared/alm/storage/al-storage-health.test.ts`:

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared/alm/storage/al-storage-health.test.ts
+++ b/packages/tests/shared/alm/storage/al-storage-health.test.ts
@@ -6,6 +6,7 @@ import type { ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavai
 
 const QUOTA: ALStorageUnavailable = { cause: 'quota', detail: 'QuotaExceededError: full' };
 const CLOSED: ALStorageUnavailable = { cause: 'closed', detail: 'InvalidStateError: closed' };
+const LAG: ALStorageUnavailable = { cause: 'checkpoint-lag', detail: 'The oldest unsaved change is 10001 ms old.' };
 
 describe('ALStorageHealth', () => {
     it('starts healthy and states nothing until the first failure', async () => {
@@ -86,6 +87,39 @@ describe('ALStorageHealth', () => {
         expect(events).toEqual([]);
     });
 
+    it('states a checkpoint store delayed once, with its oldest unsaved age, and healthy at its next recovery point', async () => {
+        const { health, events } = createHealth();
+
+        health.recordDelayed(1_200, QUOTA);
+        health.recordDelayed(2_400, QUOTA);
+        health.recordRecoveryPoint(3_000);
+
+        await vi.waitFor(() => expect(events).toHaveLength(2));
+        await flushListeners();
+        expect(events.map((event) => JSON.stringify(event))).toEqual([
+            '{"kind":"health","storeId":"browser-ws-client:session-1","status":"delayed","lastFailure":{"cause":"quota","detail":"QuotaExceededError: full"},"oldestUnsavedAgeMs":1200}',
+            '{"kind":"health","storeId":"browser-ws-client:session-1","status":"healthy","lastFailure":{"cause":"quota","detail":"QuotaExceededError: full"},"lastRecoveryPointAtMs":3000}'
+        ]);
+    });
+
+    it('keeps a failing store failing through a later delay', async () => {
+        const { health, events } = createHealth();
+
+        health.recordLagFailure(LAG, 10_001);
+        health.recordDelayed(10_500, undefined);
+
+        await vi.waitFor(() => expect(events).toHaveLength(1));
+        await flushListeners();
+        expect(events).toEqual([{
+            kind: 'health',
+            storeId: 'browser-ws-client:session-1',
+            status: 'failing',
+            lastFailure: LAG,
+            lastRecoveryPointAtMs: undefined,
+            oldestUnsavedAgeMs: 10_001
+        }]);
+    });
+
     it('keeps recording when the storage port throws', async () => {
         const events: ALStorageEvent[] = [];
         const health = new ALStorageHealth({
```

Add the commit cases to `packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts` (`createWrite` there fences
one absent row and puts its queue entry compare-and-set, so both of the write's parts issue their requests from read
callbacks; the third case empties the fence and the queue so the admission `put` runs in the opening turn and throws
there):

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts b/packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts
index c61530360..e6ff1eb7c 100644
--- a/packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts
+++ b/packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts
@@ -239,6 +239,50 @@ describe('atomic admission and QueueBox work', () => {
         expect(await queue.getItem(entry.key)).toBeUndefined();
     });
 
+    it('commits its readwrite once its last request is issued, the compare-and-set put included', async () => {
+        const { db, queue } = await createStorage();
+        const entry = createEntry('committed');
+        const commits = recordTransactionCommits();
+
+        expect(await writeIndexedDbAdmissionMutations(createWrite(db, entry))).toBe(true);
+
+        expect(commits).toEqual(['readwrite']);
+        expect(await readIndexedDbAdmissionSnapshot(db, admissionStore, { kind: 'key', key: 'admitted' })).toHaveLength(1);
+        expect(await queue.getItem(entry.key)).toMatchObject({ resource: 'committed' });
+    });
+
+    it('leaves a write with a deadline to commit on its own, so the deadline can still abort it', async () => {
+        const { db } = await createStorage();
+        const commits = recordTransactionCommits();
+
+        expect(
+            await writeIndexedDbAdmissionMutations({
+                ...createWrite(db, createEntry('deadline')),
+                deadline: { expiresAtMs: Number.MAX_SAFE_INTEGER, nowMs: Date.now }
+            })
+        ).toBe(true);
+
+        expect(commits).toEqual([]);
+    });
+
+    it('rejects with the error of a put its aborted transaction refused, and leaves no rejection unhandled', async () => {
+        const { db } = await createStorage();
+        const refused = new DOMException('The transaction is not active', 'TransactionInactiveError');
+        const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore) {
+            this.transaction.abort();
+            throw refused;
+        });
+        onTestFinished(() => put.mockRestore());
+
+        await expect(writeIndexedDbAdmissionMutations({
+            ...createWrite(db, createEntry('refused')),
+            fence: { rows: new Map(), prefixes: new Map() },
+            queueMutations: []
+        })).rejects.toBe(refused);
+        // One more task, so a rejection the aborted transaction left unhandled fails this test.
+        await new Promise((resolve) => setTimeout(resolve, 0));
+    });
+
     it('rejects two mutations for one queue key before committing admission', async () => {
         const { db, queue } = await createStorage();
         const entry = createEntry('duplicate');
@@ -305,6 +349,18 @@ async function createStorage(): Promise<AdmissionQueueStorage> {
     return { db, queue };
 }
 
+/** The mode of every transaction committed explicitly, in order; each still commits. */
+function recordTransactionCommits(): readonly IDBTransactionMode[] {
+    const commits: IDBTransactionMode[] = [];
+    const commit = IDBTransaction.prototype.commit;
+    const spy = vi.spyOn(IDBTransaction.prototype, 'commit').mockImplementation(function (this: IDBTransaction) {
+        commits.push(this.mode);
+        commit.call(this);
+    });
+    onTestFinished(() => spy.mockRestore());
+    return commits;
+}
+
 function createWrite(db: IDBDatabase, entry: ResourceEntry): WriteIndexedDbAdmissionMutationsInput {
     return {
         db,
```

Make the inbound diagnostics case wait for the event it asserts (R-I2b-45; a test-intent fix: the case read the
batch's drain right after the first claim, and the commit of Step 6 can move that event by a turn):

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/alm/inbound-admission-diagnostics.test.ts b/packages/tests/shared/alm/inbound-admission-diagnostics.test.ts
index e7447993f..8e74c4869 100644
--- a/packages/tests/shared/alm/inbound-admission-diagnostics.test.ts
+++ b/packages/tests/shared/alm/inbound-admission-diagnostics.test.ts
@@ -202,6 +202,8 @@ it.each(['memory', 'indexeddb'] as const)(
         await expect.poll(() => delivered).toEqual(['dispatched']);
         await expect.poll(() => claimsOf(diagnostics).length).toBeGreaterThanOrEqual(1);
 
+        // The batch reports its drain after its last claim; wait for that event.
+        await expect.poll(() => drainsOf(diagnostics).length).toBeGreaterThanOrEqual(1);
         // The row goes back to the queue, so the drain counts it rescheduled and the claim says why.
         expect(claimsOf(diagnostics)[0]?.outcome).toBe('retry');
         expect(drainsOf(diagnostics)[0]).toMatchObject({ claimedCount: 1, completedCount: 0, rescheduledCount: 1 });
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared/alm/checkpoint/al-checkpoint-writer.test.ts packages/tests/shared/alm/storage/al-storage-health.test.ts \
  packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts packages/tests/shared/alm/inbound-admission-diagnostics.test.ts
```

Expected (measured on the Task 2 tree, `2ec605ba5`): `Error: Cannot find package '@shared/alm/checkpoint/al-checkpoint-writer.ts'`,
`TypeError: health.recordDelayed is not a function`, `TypeError: health.recordLagFailure is not a function`,
`AssertionError: expected [] to deeply equal [ 'readwrite' ]`, and under `Unhandled Errors` one
`Unhandled Rejection` (`Error: IndexedDB transaction failed`, the refused `put`'s abort); the diagnostics file passes
(its wait is a test-intent fix, not a red); `Test Files  3 failed | 1 passed (4)`, `Tests  3 failed | 52 passed (55)`,
`Errors  1 error`.

- [ ] **Step 3: The health vocabulary.** `packages/shared/alm/storage/al-storage-event.ts`:

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/storage/al-storage-event.ts
+++ b/packages/shared/alm/storage/al-storage-event.ts
@@ -1,7 +1,8 @@
 import type { ALStorageResetEvent } from '../open-indexed-db-admission-database.ts';
 import type { ALStorageUnavailable } from './al-storage-unavailable.ts';
 
-export type ALStorageHealthStatus = 'healthy' | 'failing';
+/** `delayed` only on a checkpoint store: its oldest unsaved change outlived the interval, within the lag bound. */
+export type ALStorageHealthStatus = 'healthy' | 'delayed' | 'failing';
 
 export interface ALStorageHealthState {
     readonly status: ALStorageHealthStatus;
@@ -12,6 +13,8 @@ export interface ALStorageHealthState {
     readonly lastFailure: ALStorageUnavailable | undefined;
     /** The store's last recovery point; `undefined` before its first one. */
     readonly lastRecoveryPointAtMs: number | undefined;
+    /** How old a checkpoint store's oldest unsaved change was when it went `delayed` or `failing`; else `undefined`. */
+    readonly oldestUnsavedAgeMs: number | undefined;
 }
 
 /** What a durable store found when its lane started: exactly one per store, or per lane of a shared store, per connect. */
```

`packages/shared/alm/storage/al-storage-unavailable.ts`:

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/storage/al-storage-unavailable.ts
+++ b/packages/shared/alm/storage/al-storage-unavailable.ts
@@ -2,7 +2,8 @@
  * Why a browser ALM store cannot persist: IndexedDB is absent (`missing`), its open request failed
  * (`open-failed`), a reset's delete stayed blocked (`reset-blocked`), a write hit the quota (`quota`),
  * a `versionchange` closed the connection (`closed`), the database vanished under the document
- * (`evicted`), or a transaction failed for another reason (`transaction-failed`).
+ * (`evicted`), a transaction failed for another reason (`transaction-failed`), or a checkpoint store's
+ * oldest unsaved change outlived its recovery-lag bound (`checkpoint-lag`).
  */
 export type ALStorageUnavailableCause =
     | 'missing'
@@ -11,7 +12,8 @@ export type ALStorageUnavailableCause =
     | 'quota'
     | 'closed'
     | 'evicted'
-    | 'transaction-failed';
+    | 'transaction-failed'
+    | 'checkpoint-lag';
 
 export interface ALStorageUnavailable {
     readonly cause: ALStorageUnavailableCause;
```

`packages/shared/alm/storage/al-storage-health.ts`:

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/storage/al-storage-health.ts
+++ b/packages/shared/alm/storage/al-storage-health.ts
@@ -12,7 +12,8 @@ export namespace ALStorageHealth {
 /**
  * One durable store's health. It starts `healthy` and states only a change of status: the first
  * failure, and the first recovery point after it. A recovery point is a committed send, an inbound
- * admission that wrote work, or a flushed batch; a committed control or receipt records none.
+ * admission that wrote work, a flushed batch, or a completed checkpoint; a committed control or
+ * receipt records none. Only a checkpoint store reads `delayed`.
  */
 export class ALStorageHealth {
     private readonly state = new ObservableLatestValue<ALStorageHealthState>({
@@ -26,7 +27,8 @@ export class ALStorageHealth {
         this.state.accept({
             status: 'healthy',
             lastFailure: undefined,
-            lastRecoveryPointAtMs: undefined
+            lastRecoveryPointAtMs: undefined,
+            oldestUnsavedAgeMs: undefined
         });
         this.state.onUpdatedDo(({ value }) => {
             if (value !== undefined) {
@@ -39,18 +41,44 @@ export class ALStorageHealth {
         this.state.accept({
             status: 'failing',
             lastFailure: failure,
-            lastRecoveryPointAtMs: this.lastRecoveryPointAtMs
+            lastRecoveryPointAtMs: this.lastRecoveryPointAtMs,
+            oldestUnsavedAgeMs: undefined
+        });
+    }
+
+    /** A checkpoint store's lag beyond its bound: the store fails until a checkpoint completes. */
+    recordLagFailure(failure: ALStorageUnavailable, oldestUnsavedAgeMs: number): void {
+        this.state.accept({
+            status: 'failing',
+            lastFailure: failure,
+            lastRecoveryPointAtMs: this.lastRecoveryPointAtMs,
+            oldestUnsavedAgeMs
+        });
+    }
+
+    /** Stated once, on leaving `healthy`; a failing store stays failing until its next recovery point. */
+    recordDelayed(oldestUnsavedAgeMs: number, lastFailure: ALStorageUnavailable | undefined): void {
+        const state = this.state.peek();
+        if (state?.status !== 'healthy') {
+            return;
+        }
+        this.state.accept({
+            status: 'delayed',
+            lastFailure: lastFailure ?? state.lastFailure,
+            lastRecoveryPointAtMs: this.lastRecoveryPointAtMs,
+            oldestUnsavedAgeMs
         });
     }
 
     recordRecoveryPoint(atMs: number): void {
         this.lastRecoveryPointAtMs = atMs;
         const state = this.state.peek();
-        if (state?.status === 'failing') {
+        if (state !== undefined && state.status !== 'healthy') {
             this.state.accept({
                 status: 'healthy',
                 lastFailure: state.lastFailure,
-                lastRecoveryPointAtMs: atMs
+                lastRecoveryPointAtMs: atMs,
+                oldestUnsavedAgeMs: undefined
             });
         }
     }
```

- [ ] **Step 4: The writer** `packages/shared/alm/checkpoint/al-checkpoint-writer.ts`:

<!-- dprint-ignore -->
```ts
import type { Unsubscribe } from '../../cache/RepositoryInterfaces.ts';
import { toError } from '../../resilience/to-error.ts';
import type { InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import type { ALStorageHealth } from '../storage/al-storage-health.ts';
import { toALStorageUnavailable, type ALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
import type { ALCheckpointDirtySet } from './al-checkpoint-dirty-set.ts';
import { computeALCheckpointMutations, type ALCheckpointMutations } from './compute-al-checkpoint-mutations.ts';

export namespace ALCheckpointWriter {
    export interface Settings {
        /** The target age of the oldest unsaved change: the first change arms one checkpoint this far ahead. */
        readonly intervalMs: number;
        /** Beyond this age the store reads `failing`, and new admissions follow `onStorageUnavailable`. */
        readonly lagBoundMs: number;
    }

    /** The one timer the checkpoint arms: `schedule` runs `run` once after `delayMs` and answers its cancel. */
    export interface Timers {
        readonly schedule: (run: () => void, delayMs: number) => () => void;
    }

    export interface Input {
        /** The memory pair whose dirty keys each checkpoint reads as they are held then. */
        readonly memory: Pick<InMemoryAdmissionBackend, 'peek' | 'workQueue'>;
        readonly dirty: ALCheckpointDirtySet;
        /** One readwrite transaction; it lands every mutation or none. */
        readonly write: (mutations: ALCheckpointMutations) => Promise<void>;
        readonly health: ALStorageHealth;
        readonly settings: Settings;
        readonly nowMs: () => number;
        readonly timers: Timers;
    }
}

/**
 * Saves one memory pair's changed rows to IndexedDB; its checkpoint builds it only in the runtime that
 * owns its session's durable work. The oldest unsaved change arms one checkpoint an interval after it, so no later change
 * postpones it, and nothing runs while the pair is clean. One write is in flight at a time and changes
 * made during it reach the next one; a completed write clears only the keys still at the revision it
 * captured.
 */
export class ALCheckpointWriter {
    private readonly input: ALCheckpointWriter.Input;
    private readonly subscription: Unsubscribe;
    /** Cancels the armed checkpoint; `undefined` while none is armed. */
    private cancelTimer: (() => void) | undefined;
    private inFlight: ALCheckpointDirtySet.Snapshot | undefined;
    private flushRequested = false;
    private retryNotBeforeMs = Number.NEGATIVE_INFINITY;
    private lastWriteFailure: ALStorageUnavailable | undefined;
    /** Past the bound the lag is stated once; a completed write ends it. */
    private lagStated = false;
    private disposed = false;

    constructor(input: ALCheckpointWriter.Input) {
        this.input = input;
        this.subscription = input.dirty.onMarkedDo(() => this.arm());
    }

    /** Starts a checkpoint now, or right after the one in flight; its caller never waits for it. */
    flush(): void {
        if (this.disposed) {
            return;
        }
        if (this.inFlight !== undefined) {
            this.flushRequested = true;
            return;
        }
        this.startWrite();
    }

    dispose(): void {
        this.disposed = true;
        this.disarm();
        this.subscription.unsubscribe();
    }

    private arm(): void {
        if (
            this.disposed || this.inFlight !== undefined || this.cancelTimer !== undefined
        ) {
            return;
        }
        const dueAtMs = this.computeDueAtMs();
        if (dueAtMs !== undefined) {
            this.cancelTimer = this.input.timers.schedule(() => this.fire(), Math.max(0, dueAtMs - this.input.nowMs()));
        }
    }

    private disarm(): void {
        this.cancelTimer?.();
        this.cancelTimer = undefined;
    }

    /**
     * The next checkpoint, an interval after the oldest unsaved change, or after a failed write's retry
     * delay; earlier when the lag bound falls before it, so the lag is stated at the bound.
     */
    private computeDueAtMs(): number | undefined {
        const oldestAtMs = this.input.dirty.getOldestDirtiedAtMs();
        if (oldestAtMs === undefined) {
            return undefined;
        }
        const { intervalMs, lagBoundMs } = this.input.settings;
        const checkpointDueAtMs = Math.max(oldestAtMs + intervalMs, this.retryNotBeforeMs);
        return this.lagStated ? checkpointDueAtMs : Math.min(checkpointDueAtMs, oldestAtMs + lagBoundMs + 1);
    }

    private fire(): void {
        this.cancelTimer = undefined;
        if (this.disposed) {
            return;
        }
        this.recordLag();
        if (this.input.nowMs() >= this.retryNotBeforeMs) {
            this.startWrite();
            return;
        }
        this.arm();
    }

    /** The snapshot and the capture share one turn, so what the write saves is one state the pair was in. */
    private startWrite(): void {
        const { dirty, memory } = this.input;
        if (dirty.isClean()) {
            return;
        }
        const snapshot = dirty.getSnapshot();
        const mutations = computeALCheckpointMutations({
            snapshot,
            peekAdmission: (key) => memory.peek(key),
            peekQueueEntry: (key) => memory.workQueue.peek(key),
            writeToken: crypto.randomUUID()
        });
        this.inFlight = snapshot;
        this.disarm();
        void this.input.write(mutations).then(
            () => this.completeWrite(snapshot),
            (error) => this.failWrite(toError(error))
        );
    }

    private completeWrite(snapshot: ALCheckpointDirtySet.Snapshot): void {
        this.inFlight = undefined;
        this.input.dirty.clearSaved(snapshot);
        this.retryNotBeforeMs = Number.NEGATIVE_INFINITY;
        this.lastWriteFailure = undefined;
        this.lagStated = false;
        this.input.health.recordRecoveryPoint(this.input.nowMs());
        this.continueAfterWrite();
    }

    /** The saved rows stand as the aborted transaction left them; every captured key stays unsaved. */
    private failWrite(error: Error): void {
        this.inFlight = undefined;
        this.retryNotBeforeMs = this.input.nowMs() + this.input.settings.intervalMs;
        this.lastWriteFailure = toALStorageUnavailable(error) ?? { cause: 'transaction-failed', detail: error.message };
        this.continueAfterWrite();
    }

    private continueAfterWrite(): void {
        this.disarm();
        if (this.disposed) {
            return;
        }
        this.recordLag();
        if (this.flushRequested) {
            this.flushRequested = false;
            this.startWrite();
            return;
        }
        this.arm();
    }

    /** `delayed` once past the interval, `failing` once past the bound; a completed write ends either. */
    private recordLag(): void {
        const oldestAtMs = this.input.dirty.getOldestDirtiedAtMs();
        if (oldestAtMs === undefined) {
            return;
        }
        const ageMs = this.input.nowMs() - oldestAtMs;
        const { settings, health } = this.input;
        if (ageMs > settings.lagBoundMs && !this.lagStated) {
            this.lagStated = true;
            health.recordLagFailure(computeALCheckpointLagFailure(ageMs, settings, this.lastWriteFailure), ageMs);
        }
        else if (ageMs > settings.intervalMs) {
            health.recordDelayed(ageMs, this.lastWriteFailure);
        }
    }
}

function computeALCheckpointLagFailure(
    ageMs: number,
    settings: ALCheckpointWriter.Settings,
    lastWriteFailure: ALStorageUnavailable | undefined
): ALStorageUnavailable {
    const lastWrite = lastWriteFailure === undefined ? '' : ` The last checkpoint failed: ${lastWriteFailure.detail}`;
    return {
        cause: 'checkpoint-lag',
        detail: `The oldest unsaved change is ${ageMs} ms old, beyond the ${settings.lagBoundMs} ms bound.${lastWrite}`
    };
}
```

- [ ] **Step 5: Sweep the widened types.** The exhaustive cause record and the other health builder:

<!-- dprint-ignore -->
```diff
--- a/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
+++ b/packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts
@@ -52,7 +52,8 @@ const ALM_STORAGE_UNAVAILABLE_CAUSES: Readonly<Record<ALStorageUnavailableCause,
     quota: true,
     closed: true,
     evicted: true,
-    'transaction-failed': true
+    'transaction-failed': true,
+    'checkpoint-lag': true
 };
 
 const ALM_DURABILITY_ALGOS: Readonly<Record<ALDurabilityAlgo, true>> = {
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared-web/browser/session/delete-ended-session-al-runtime-entries.ts
+++ b/packages/shared-web/browser/session/delete-ended-session-al-runtime-entries.ts
@@ -40,7 +40,8 @@ export async function deleteEndedSessionALRuntimeEntries(
                 storeId,
                 status: 'failing',
                 lastFailure,
-                lastRecoveryPointAtMs: undefined
+                lastRecoveryPointAtMs: undefined,
+                oldestUnsavedAgeMs: undefined
             });
         }
     }
```

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts
@@ -400,7 +400,8 @@ it('records AL storage recovery, health and persist events on the storage topic'
         storeId: 'browser-ws-client:session-1',
         status: 'failing',
         lastFailure: { cause: 'quota', detail: 'QuotaExceededError: full' },
-        lastRecoveryPointAtMs: 1_000
+        lastRecoveryPointAtMs: 1_000,
+        oldestUnsavedAgeMs: undefined
     });
     storage?.({ kind: 'persist', outcome: 'granted' });
 
```

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared-web/al-runtime/browser-al-storage-recovery.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-al-storage-recovery.test.ts
@@ -146,7 +146,8 @@ function toEvictedHealthEvent(storeId: string): ALStorageEvent {
         storeId,
         status: 'failing',
         lastFailure: { cause: 'evicted', detail: expect.any(String) },
-        lastRecoveryPointAtMs: undefined
+        lastRecoveryPointAtMs: undefined,
+        oldestUnsavedAgeMs: undefined
     };
 }
 
```

- [ ] **Step 6: Commit the readwrite once its last request is issued (R-I2b-25, R-I2b-36).** The queue submitter
      names the moment its last compare-and-set write is issued; the admission writer counts its two parts and commits
      when both issued, unless the write carries a deadline; the completion is handled before any request:

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/write-indexed-db-admission-mutations.ts b/packages/shared/alm/write-indexed-db-admission-mutations.ts
index 1151c014d..05f73b4cc 100644
--- a/packages/shared/alm/write-indexed-db-admission-mutations.ts
+++ b/packages/shared/alm/write-indexed-db-admission-mutations.ts
@@ -43,6 +43,8 @@ interface IndexedDbAdmissionWriteContext {
     readonly transaction: IDBTransaction;
     conflict: boolean;
     storedValueError: Error | undefined;
+    /** The admission store's requests and the queue's, each issued once its reads matched. */
+    unissuedParts: number;
 }
 
 export async function writeIndexedDbAdmissionMutations(
@@ -61,24 +63,28 @@ export async function writeIndexedDbAdmissionMutations(
         : [input.storeName, AL_ADMISSION_WORK_STORE_NAME];
     const transaction = input.db.transaction(storeNames, 'readwrite');
     const completed = waitForIndexedDbTransaction(transaction);
-    const store = transaction.objectStore(input.storeName);
+    // A request that throws ends this call before `await completed`; the abort it leaves is still handled.
+    completed.catch(() => undefined);
     const eligibility = new IndexedDbWriteDeadline(transaction, input.deadline);
-    const queueWrite = input.queueMutations.length === 0
-        ? undefined
-        : submitComputedIndexedDbQueueMutations(
-            transaction.objectStore(AL_ADMISSION_WORK_STORE_NAME),
-            input.queueMutations,
-            eligibility
-        );
     const context: IndexedDbAdmissionWriteContext = {
         eligibility,
         guardedRemovals,
         input,
-        store,
+        store: transaction.objectStore(input.storeName),
         transaction,
         conflict: false,
-        storedValueError: undefined
+        storedValueError: undefined,
+        unissuedParts: input.queueMutations.length === 0 ? 1 : 2
     };
+    const queueWrite = input.queueMutations.length === 0
+        ? undefined
+        : submitComputedIndexedDbQueueMutations({
+            store: transaction.objectStore(AL_ADMISSION_WORK_STORE_NAME),
+            mutations: input.queueMutations,
+            eligibility,
+            onIssued: () => commitIssuedIndexedDbAdmissionWrite(context)
+        });
+    const { store } = context;
     readIndexedDbAdmissionWriteFence({
         eligibility,
         fence: input.fence,
@@ -204,4 +210,17 @@ function applyIndexedDbAdmissionMutations(
             ? eligibility.observe(store.put(mutation.stored))
             : eligibility.observe(store.delete(mutation.key));
     }
+    commitIssuedIndexedDbAdmissionWrite(context);
+}
+
+/**
+ * `commit()` is requested once the last request is issued, so a write started while the page is hidden
+ * or unloading can land without waiting for the page's next task, and never for a write with a
+ * deadline: its expiry aborts it from a request's success, and an abort after `commit()` would throw.
+ */
+function commitIssuedIndexedDbAdmissionWrite(context: IndexedDbAdmissionWriteContext): void {
+    context.unissuedParts -= 1;
+    if (context.unissuedParts === 0 && context.input.deadline === undefined) {
+        context.transaction.commit?.();
+    }
 }
diff --git a/packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts b/packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts
index 255e81d6b..d14201223 100644
--- a/packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts
+++ b/packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts
@@ -37,7 +37,12 @@ export async function writeComputedIndexedDbQueueMutations(
     const transaction = db.transaction(storeName, 'readwrite');
     const completed = waitForIndexedDbTransaction(transaction);
     const eligibility = new IndexedDbWriteDeadline(transaction, deadline);
-    const state = submitComputedIndexedDbQueueMutations(transaction.objectStore(storeName), mutations, eligibility);
+    const state = submitComputedIndexedDbQueueMutations({
+        store: transaction.objectStore(storeName),
+        mutations,
+        eligibility,
+        onIssued: () => undefined
+    });
     try {
         await completed;
         return true;
@@ -56,15 +61,25 @@ export async function writeComputedIndexedDbQueueMutations(
     }
 }
 
+export interface SubmitComputedIndexedDbQueueMutationsInput {
+    readonly store: IDBObjectStore;
+    readonly mutations: readonly ComputedIndexedDbQueueMutation[];
+    readonly eligibility: IndexedDbWriteDeadline;
+    /**
+     * Runs once the last request of the mutations is issued: a compare-and-set issues its write from its
+     * read's callback. A conflict, a stored-value error or an expiry ends the write before it runs.
+     */
+    readonly onIssued: () => void;
+}
+
 /** The transaction owner validates the candidate before opening its transaction and observes completion. */
 export function submitComputedIndexedDbQueueMutations(
-    store: IDBObjectStore,
-    mutations: readonly ComputedIndexedDbQueueMutation[],
-    deadline?: IndexedDbWriteDeadline
+    input: SubmitComputedIndexedDbQueueMutationsInput
 ): Readonly<IndexedDbQueueWriteState> {
-    const eligibility = deadline ?? new IndexedDbWriteDeadline(store.transaction, undefined);
+    const { store, eligibility } = input;
     const state: IndexedDbQueueWriteState = { conflict: false, storedValueError: undefined };
-    for (const mutation of mutations) {
+    let unissued = input.mutations.filter((mutation) => !isUnconditionalIndexedDbQueueMutation(mutation)).length;
+    for (const mutation of input.mutations) {
         if (mutation.kind === 'delete-unconditionally') {
             eligibility.observe(store.delete(mutation.keyString));
             continue;
@@ -98,11 +113,22 @@ export function submitComputedIndexedDbQueueMutations(
             else if (mutation.kind === 'delete') {
                 eligibility.observe(store.delete(mutation.keyString));
             }
+            unissued -= 1;
+            if (unissued === 0) {
+                input.onIssued();
+            }
         };
     }
+    if (unissued === 0) {
+        input.onIssued();
+    }
     return state;
 }
 
+function isUnconditionalIndexedDbQueueMutation(mutation: ComputedIndexedDbQueueMutation): boolean {
+    return mutation.kind === 'delete-unconditionally' || mutation.kind === 'put-unconditionally';
+}
+
 function matchesIndexedDbQueueExpectedState(
     current: IDBRequest['result'],
     expected: IndexedDbQueueExpectedState
```

- [ ] **Step 7: Format the touched files only.**

```sh
npx dprint fmt packages/shared/alm/checkpoint/al-checkpoint-writer.ts packages/shared/alm/storage/al-storage-event.ts \
  packages/shared/alm/storage/al-storage-health.ts packages/shared/alm/storage/al-storage-unavailable.ts \
  packages/shared/alm/write-indexed-db-admission-mutations.ts packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts \
  packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts packages/tests/shared/alm/inbound-admission-diagnostics.test.ts \
  packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts \
  packages/shared-web/browser/session/delete-ended-session-al-runtime-entries.ts \
  packages/tests/shared/alm/checkpoint/al-checkpoint-test-support.ts packages/tests/shared/alm/checkpoint/al-checkpoint-writer.test.ts \
  packages/tests/shared/alm/storage/al-storage-health.test.ts packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts \
  packages/tests/shared-web/al-runtime/browser-al-storage-recovery.test.ts
```

- [ ] **Step 8: Focused tests.**

```sh
npx vitest run packages/tests/shared/alm/checkpoint/al-checkpoint-writer.test.ts packages/tests/shared/alm/storage/al-storage-health.test.ts \
  packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts packages/tests/shared/alm/inbound-admission-diagnostics.test.ts
for i in 1 2 3 4 5; do npx vitest run packages/tests/shared/alm/checkpoint/al-checkpoint-writer.test.ts | grep 'Tests '; done
npx vitest run packages/tests/shared/alm packages/tests/shared-web/al-runtime packages/tests/shared-web/session \
  packages/tests/shared-test/alm-delivery-failure-decoding.test.ts packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts \
  packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts
```

Expected (measured at `34cec086d`): `Test Files  4 passed (4)`, `Tests  65 passed (65)`; the writer file
`Tests  10 passed (10)` five times; the wider set `Test Files  132 passed (132)`, `Tests  1503 passed (1503)`. The
shared, shared-web and shared-test trees together pass but for the three loopback files that bind ports sandboxed
(`api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe`, `local-websocket-session`, `listen EPERM`),
which pass with the sandbox disabled.

- [ ] **Step 9: Per-task checks and bundles.** Bundle figures are read with a private `TMPDIR` (R-I2b-23).

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
npm --workspace @ar-eye-hunter/shared-test run typecheck
(cd apps/api-v1 && deno task check); rm -rf apps/api-v1/node_modules/.deno; find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts \
  packages/tests/shared/alm/al-storage-snapshot.test.ts packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts
D="$TMPDIR/task3-bundles"; mkdir -p "$D"
TMPDIR="$D" npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
TMPDIR="$D" npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts \
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Expected (measured at `34cec086d`): no `tsc` output; the three typechecks and `deno task check` exit 0;
`check-tests-typecheck: 1439 test files enforced, 0 files carrying known debt (0 errors).` and
`PASS: no new type errors in the maintained test project`; pins `Test Files  4 passed (4)`, `Tests  26 passed (26)`,
unedited; `| browser/rallar.ts | 1099.1 KiB | 286.4 KiB | 234.7 KiB | < 235.0 KiB | ok |`, `Bundle budget check passed.`;
`Test Files  3 passed (3)`, `Tests  18 passed (18)`. Figures (private `TMPDIR`): `browser/rallar.ts` 234.710 KiB
(235), headless 299.520 KiB (300). The shared writer's commit is reachable from the facade (the durable lane uses it);
the checkpoint writer is not until Task 5.

- [ ] **Step 10: Commit, then run the changed-range gates.**

```sh
git add packages/shared/alm/checkpoint/al-checkpoint-writer.ts packages/shared/alm/storage packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts \
  packages/shared/alm/write-indexed-db-admission-mutations.ts packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts \
  packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts packages/tests/shared/alm/inbound-admission-diagnostics.test.ts \
  packages/shared-web/browser/session/delete-ended-session-al-runtime-entries.ts packages/tests/shared/alm/checkpoint \
  packages/tests/shared/alm/storage/al-storage-health.test.ts packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts \
  packages/tests/shared-web/al-runtime/browser-al-storage-recovery.test.ts
git commit -F - <<'EOF'
Checkpoint a memory pair's changed rows on an interval

ALCheckpointWriter saves one memory pair's dirty rows to IndexedDB. It
holds no ownership: whoever builds it builds it only in the runtime
that owns the session's durable work. The oldest unsaved
change arms one checkpoint an interval after it, so no later change
postpones it, and nothing runs while the pair is clean. Each
checkpoint takes the dirty set's snapshot and captures the dirty keys'
current values in one turn, then writes them in one readwrite
transaction. One write is in flight at a time and changes made during
it reach the next; a completed write clears only the keys still at the
revision it captured. A failed write leaves the keys unsaved and is
retried an interval later. flush() starts a checkpoint now, or right
after the one in flight, and is never awaited. Its one timer is
injected as schedule(run, delayMs) answering its cancel.

The store's health gains delayed (stated once, past the interval, with
the failed write that delays it) and the oldest unsaved age; at the
recovery-lag bound the store reads failing with the new cause
checkpoint-lag, naming the last failed write. A completed checkpoint
is a recovery point and ends either.

writeIndexedDbAdmissionMutations commits its readwrite as soon as its
last request is issued (transaction.commit(), where the browser has
it), so a checkpoint begun while the page hides or unloads can land
before the page ends; the queue submitter names the moment its last
compare-and-set write is issued. A write with a deadline keeps the
browser's own commit, since its expiry aborts it from a request's
success. The completion is handled before any request is issued, so a
put its aborted transaction refuses rejects the write instead of
escaping as an unhandled rejection. The inbound diagnostics case that
settles a claim as a retry over IndexedDB now waits for the drain event
it asserts, which the earlier commit can move by a turn.

D8 reuse: ALStorageHealth (ObservableLatestValue, transitions only) carries delayed and the lag failure, toALStorageUnavailable maps a failed write, Task 2's ALCheckpointDirtySet and computeALCheckpointMutations are the snapshot and the capture, and the one shared writeIndexedDbAdmissionMutations gains the commit for every caller; WriteBehindObservableLatestRepository is not reused (per-key immediate writes, no coalescing, no single transaction).
EOF
npm run check:test-reachability
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured at `34cec086d`): `Test reachability: 1741 test files, 1735 reached by CI, 6 manual.`;
`PASS: no new repository style findings`; `PASS: all 12 current structure-coupling candidates are individually
classified`, `PASS: changed-range structure-coupling review has complete individual classifications`,
`PASS: registry entries are complete and current` (the touched file's existing `:310` candidate stays classified; a
first draft asserting the commit spy with `toHaveBeenCalledOnce`/`not.toHaveBeenCalled` drew two unclassified
candidates, hence the recording spy).

---

### Task 4: The third lane and the restore

Prototyped in scratch as commit `ab4b4a0a9` on Task 3's `028bac004` (red then green); `git am` of `patch-task-1.patch`,
`patch-task-2.patch`, `patch-task-3.patch` and `patch-task-4.patch` on `5e06c6ab0` reproduces the prototype tree.
Decisions D129 (the existing row formats in the session's database, restore is a bootstrap read into memory), D130
(a third `checkpoint` store lane), D132 (owner only; a non-owner's admission reads `durable: false`; takeover
merges if-absent). QoS plan §4 "Recovery unit", "Restore", "One writer"; §9.2 rows "A checkpoint is one coherent
state, and an interrupted write keeps the prior point", "Restore: reserved rows are retryable, expired rows settle
`expired`, and there is no handle", "A purge reaches memory, storage and checkpoint". Fact sheet §2 (the two lanes,
`resolveLaneForPlan`, `toStoreVerdict`, `readLaneForMessage`), §3 (`ALStorageReadiness`, the recovery reporter, the
purge), §4 (ownership, the settlement relay). Rulings: R-I2b-2 (own store ids), R-I2b-6, R-I2b-14 and R-I2b-20
(routing without a checkpoint lane), R-I2b-15 (`loadWithoutMarking`), R-I2b-16 (memory retention, the volatile
factory takes the lane's durability, the four widenings), R-I2b-19 (the lag skip is Task 5's dispatch, not the lane),
R-I2b-21 (Task 4 owns `Resources.checkpointStores`, the default factory pass-through and both shared fixtures),
R-I2b-22 and R-I2b-24 (the pairs and their ports are built per connect under the claim), R-I2b-23 (private `TMPDIR`),
R-I2b-28 and R-I2b-37 (the dirty set and the writer exist only while this runtime owns the work; a takeover marks
every row the pair holds once its restore ran, which alone arms the writer after a takeover: R-I2b-44; the writer is built without ownership, R-I2b-46), R-I2b-39 (the
facade budget is first crossed here).

**Assembly.** Commit `0c67dd005` on `34cec086d` (Task 3) in the composed chain; W-B's prototype `ab4b4a0a9` plus
R-I2b-28 as R-I2b-37 settles it (Steps 1, 5, 6) and the budget raise (Step 13). Bundle figures are read with a private
`TMPDIR` (R-I2b-23). After every `cd apps/api-v1 && deno task check`, run `rm -rf apps/api-v1/node_modules/.deno` and
`find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete` (a left-behind `.deno` breaks the next check).

**Files**

- Create: `packages/shared/alm/checkpoint/al-checkpoint.ts` (188 lines) — `ALCheckpointPort` and `ALCheckpoint`: one
  pair's dirty set and writer, built only while the connect's claim owns the work (R-I2b-37), the owner-only restore,
  the takeover and its marking, the first-batch report.
- Create: `packages/shared/alm/storage/read-al-work-rows-in-ranges.ts` (87 lines) — `toALWorkKeyRanges` and
  `readALWorkRowsInRanges`, moved from `packages/shared-web/browser/al-runtime/browser-al-work-cleanup.ts:23-113`
  (`toBrowserALWorkCleanupRanges`, `readBrowserALWorkCleanupRows`) so the purge and the restore read one range set;
  in `storage/`, not `alm/` (21 direct files would cross the `layout.directory-density` review).
- Create: `packages/shared/alm/outbound/lane/compute-al-outbound-committed-rows.ts` (36 lines) —
  `computeALOutboundCommittedRows` and `hasWrittenWork`, moved unchanged from `al-outbound-store-lane.ts:603-632`:
  the lane's cognitive load is 49 at the base and the checkpoint adds one decision; moving its densest helper (10)
  keeps it at 39, under the warn tier of 50.
- Create: `packages/shared-web/browser/al-runtime/browser-al-checkpoint-store-ids.ts` (18 lines) —
  `toBrowserWsClientALCheckpointRuntimeStoreId`, `toBrowserRtcOverlayALCheckpointRuntimeStoreId` (R-I2b-2); its own
  file because `browser-al-runtime-identity.ts` exports 11 runtime values and two more cross the
  `file.responsibility-count` review of 12.
- Modify: `packages/shared/alm/indexed-db-admission-backend.ts` — `readNamespaceRows(selection)` (one `al-admission`
  `list`: the stored `entries` rows under a prefix, expired ones included, and the work rows in ranges) and
  `writeUnfencedMutations(mutations)` (one `al-admission` `write`: `writeIndexedDbAdmissionMutations` with
  `EMPTY_INDEXED_DB_ADMISSION_FENCE`).
- Modify: `packages/shared/alm/al-admission-backend.ts` — `InMemoryAdmissionBackend.loadIfAbsent(rows, entries)` and
  `peekKeys()` (every key held now, expired or not, removing nothing; beside `peek`).
- Modify: `packages/shared/queuebox/in-memory-queue-box.ts` — `InMemoryQueueBox.peekKeys()` (likewise, beside `peek`).
- Modify: `packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts` — `loadWithoutMarking(load)` (R-I2b-15) and
  `markHeld()` (R-I2b-37: marks every key the pair holds, through `peekKeys()`; `Input.backend` picks `peekKeys` too).
- Modify: `packages/shared-web/bundle-budgets.json` — `browser/rallar.ts` 235 → 236 (235.214 KiB measured, R-I2b-39).
- Modify: `packages/shared/alm/al-runtime-stores.ts` — `createCheckpointALOutboundRuntimeStores(input)` and its input;
  the volatile outbound factory passes `'volatile'`; `isIndexedDbALRuntimeStoreSupported` is removed (a one-line
  wrapper of `IndexedDbStringPersistenceProvider.isSupported()`; its two callers call that directly) so the file stays
  at 11 runtime exports.
- Modify: `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts` —
  `createVolatileALOutboundAdmissionStore(input, durability: Exclude<ALStoreDurability, 'durable'>)` (R-I2b-16).
- Modify, by enumeration (R-I2b-16): `outbound/admission/al-outbound-admission-mutations.ts:325-335`
  (`computeMessageRowExpiryMs`, a `switch`) and `delivery/compute-al-volatile-control-row-expiry-ms.ts:9` (a
  `switch`); `outbound/lane/al-outbound-store-lane.ts:253-257` (`toStoreVerdict`);
  `shared-web/browser/connection/browser-delivery-settlements.ts:49` (the relay).
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` — `ALCheckpointOutboundRuntimeStores`,
  `Resources.checkpointStores`, the third lane, `resolveLaneForPlan` over `plan.lane` (Task 1's interim bridge and
  its class-doc sentence removed, R-I2b-20 stated once), `readLaneForMessage` over both memory lanes, `ready()` over
  three, `dispose()`, `flushCheckpoint()`.
- Modify: `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts` — the `checkpoint` input, the restore in
  `openStores`, the takeover wake, `flushCheckpoint()`, the verdict.
- Modify: `packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts` — the pass-through (R-I2b-21).
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts` (the session's store ids and work
  namespaces gain both checkpoint stores), `browser-al-runtime-cleanup.ts` (the purge's canonical scopes gain the two
  checkpoint namespaces; the moved range reader), `browser-al-work-cleanup.ts` (the moved code removed),
  `browser-al-runtime-stores.ts` (the support check, two lines).
- Docs: `packages/shared/alm/outbound/README.md` (Task 1's routing clause replaced; "The checkpoint lane").
- Test (create): `packages/tests/shared/alm/checkpoint/al-checkpoint.test.ts` (285 lines; five cases, the fifth R-I2b-37's:
  a waiting runtime keeps no unsaved changes, and after the takeover, with no flush, the interval checkpoint saves every
  row it holds: the pin that the takeover's marking arms the writer, R-I2b-44),
  `packages/tests/shared/alm/outbound/al-outbound-checkpoint-lane.test.ts` (239 lines).
- Test (modify): `packages/tests/shared/alm/checkpoint/al-checkpoint-test-support.ts` (`TakeableDurableWorkOwnership`,
  `createTakeableDurableWorkOwnership`, a session ownership a test hands over).
- Test (modify): `packages/tests/shared/alm/outbound-runtime-test-fixture.ts` and
  `packages/tests/shared/alm/session-outbound-test-runtime.ts` (R-I2b-21: the pass-through, and every session runtime
  holds a checkpoint pair whose events and operations are kept apart from the durable store's, so
  `browser-al-durable-work-claim.test.ts`'s exact recovery list is unchanged),
  `packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts` (the moved reader; the purge case),
  `packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts` (the relay case), and three call
  sites of the widened factory and `Resources` (`al-outbound-message-runtime.test.ts:65`,
  `al-outbound-store-lane.test.ts:152-160`, `outbound/al-outbound-volatile-retention.test.ts:163`).
- Not touched: the inbound runtime and `alm/work/**` (no Postgres integration run is owed), the pins, the browser
  composition (Task 5 builds the pairs with `createCheckpointALOutboundRuntimeStores` and calls the ports' `flush()`).

**Interfaces**

- Consumes: Task 1's `ALOutboundDispatchPlan.lane`, `ALStoreDurability` with `'checkpoint'`; Task 2's
  `ALCheckpointDirtySet`, `InMemoryAdmissionBackend.onChangeDo`/`peek`/`setStored`, `InMemoryQueueBox.peek`; Task 3's
  `ALCheckpointWriter` (`Settings`, `Timers.schedule`), `ALStorageHealth`.
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // packages/shared/alm/checkpoint/al-checkpoint.ts
  export interface ALCheckpointStorage {
      readonly memory: InMemoryAdmissionBackend;
      readonly saved: IndexedDbAdmissionBackend;
      readonly selection: IndexedDbAdmissionBackend.NamespaceSelection;
      readonly health: ALStorageHealth;
      readonly settings: ALCheckpointWriter.Settings;
      readonly timers: ALCheckpointWriter.Timers;
  }
  export interface ALCheckpointPort extends ALStorageRecoveryReporter {
      restore(): Promise<void>;   // owner only, once
      flush(): void;              // never awaited
      dispose(): void;
      isOwned(): boolean;
      onTakenOverDo(listener: () => void): Unsubscribe;
  }
  export class ALCheckpoint implements ALCheckpointPort {
      constructor(input: { storage: ALCheckpointStorage; ownership: ALDurableWorkOwnership; nowMs: () => number });
  }

  // packages/shared/alm/al-runtime-stores.ts
  export interface CreateCheckpointALOutboundRuntimeStoresInput<TPrepared>
      extends CreateDefaultALOutboundRuntimeStoresInput<TPrepared>, ALCheckpointWriter.Settings {
      readonly ownership: ALDurableWorkOwnership;   // the connect's claim
      readonly timers: ALCheckpointWriter.Timers;
  }
  export function createCheckpointALOutboundRuntimeStores<TPrepared>(
      input: CreateCheckpointALOutboundRuntimeStoresInput<TPrepared>
  ): ALCheckpointOutboundRuntimeStores<TPrepared>;   // storageHealth absent: a pass-through health

  // packages/shared/alm/outbound/al-outbound-message-runtime.ts
  export interface ALCheckpointOutboundRuntimeStores<TPrepared> extends ALOutboundRuntimeStores<TPrepared> {
      evictExpired(): void;
      readonly checkpoint: ALCheckpointPort;   // also its storageRecovery
  }
  // Resources: readonly checkpointStores: ALCheckpointOutboundRuntimeStores<TPrepared> | undefined;
  // ALOutboundMessageRuntime: flushCheckpoint(): void;

  // packages/shared/alm/indexed-db-admission-backend.ts
  readNamespaceRows(selection: { keyPrefix: string; workRanges: ALWorkKeyRangesInput }):
      Promise<{ rows: readonly IndexedDbAdmissionStoredRow[]; workRows: readonly StoredResourceEntry[] }>;
  writeUnfencedMutations(input: { mutations; queueMutations }): Promise<boolean>;

  // packages/shared/alm/al-admission-backend.ts
  loadIfAbsent(rows: readonly ALAdmissionStoredValue[], entries: readonly ResourceEntry[]): void;
  peekKeys(): readonly string[];
  // packages/shared/queuebox/in-memory-queue-box.ts
  peekKeys(): readonly ResourceEntryKeyString[];
  // packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts
  //   Input.backend: Pick<InMemoryAdmissionBackend, 'onChangeDo' | 'peekKeys' | 'workQueue'>
  loadWithoutMarking(load: () => void): void;
  markHeld(): void;
  // packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
  createVolatileALOutboundAdmissionStore(input, durability: Exclude<ALStoreDurability, 'durable'>);
  // packages/shared-web/browser/al-runtime/browser-al-checkpoint-store-ids.ts
  toBrowserWsClientALCheckpointRuntimeStoreId(sessionId);    // 'browser-ws-client-checkpoint:<sid>'
  toBrowserRtcOverlayALCheckpointRuntimeStoreId(sessionId);  // 'browser-rtc-overlay-checkpoint:<sid>'
  // packages/shared/alm/storage/read-al-work-rows-in-ranges.ts
  toALWorkKeyRanges(input: ALWorkKeyRangesInput): readonly IDBKeyRange[];
  readALWorkRowsInRanges(db: IDBDatabase, input: ALWorkKeyRangesInput): Promise<readonly StoredResourceEntry[]>;
  ```
- Behaviour: the checkpoint pair's namespace is `browser:<checkpoint store id>` in the browser (Task 5 names it),
  and its canonical scope is the namespace, whatever the input says, so two memory pairs never save one row (a hand-over
  admits the message in the other carrier's pair under its own scope). The restore reads the `entries` rows under
  `<namespace>:` and the work rows under the pair's work namespace and canonical scope, and loads, inside
  `loadWithoutMarking`, the admission rows whose `expireAtTimestamp` is ahead and the queue rows not yet expired, each
  only where the pair holds no row of its key. Expired work rows of the `AL_OUTBOUND` topic are counted and reported as
  the outcome's `expired`, as the durable pair's reservation deletes are. A runtime that does not own the work skips
  the restore and builds no dirty set and no writer, so it keeps no unsaved changes (R-I2b-28); when ownership turns
  true the restore runs (loading without marking only where tracking already exists), then the dirty set and the writer
  are built and `markHeld()` marks every row the pair holds, so the first checkpoint saves the live state (R-I2b-37),
  and the lane's work is woken (`AL_WORK_UNDESCRIBED_COMMIT`). A runtime that owns the work from its construction
  tracks from the start and its restore marks nothing. The checkpoint lane runs its work in every runtime (`durableWorkOwnership:
  undefined` for its work handler, R-I2b-6); its admission is durable only where `isOwned()`. A checkpoint plan goes
  to the checkpoint lane, else to the volatile lane, else to the only lane (R-I2b-20). The lane does not refuse while
  the checkpoint lags: Task 5's dispatch skips the lane on `failing`/`checkpoint-lag` (R-I2b-19).

**D8 reuse inspection.** The restore is the lane's existing `ALStorageReadiness.openStores` (fact §3), which every
send awaits once through `runtime.ready()`, so it runs before the bootstrap batch with no new readiness state; its
outcome is the existing `createALStorageRecoveryReporter` (opening + reservation-expired count) fed by the restore's
own opening and expired count; the takeover is `ALDurableWorkOwnership.owned.onChangeDo`, as
`ALWorkEngineMembership` does (`al-work-engine-membership.ts:32-40`). The reads are `readIndexedDbAdmissionSnapshot`'s
prefix selection and the purge's own work-key range reader, moved into `shared` so both read one range set
(`toBrowserALWorkCleanupRanges` and `readBrowserALWorkCleanupRows` had no caller outside the cleanup and its test); the write is `writeIndexedDbAdmissionMutations`
under the empty fence the cleanup already uses (`browser-al-runtime-cleanup.ts:424-441`), behind the backend's
connection, schema check, reset relay and observer, so the fault port and the operation pins see one
`al-admission` `write` per checkpoint and one `list` per restore. The memory pair is the volatile factories' backend
and store (`createVolatileALAdmissionBackend`, `createVolatileALOutboundAdmissionStore` taking the lane's
durability). The load is `InMemoryQueueBox.writeIfAllObserved` with `expected: undefined` (if-absent) and Task 2's
`setStored` choke point; `loadWithoutMarking` is one flag on Task 2's set; the takeover's marking reads the keys
through `peekKeys()` beside Task 2's `peek` and marks them through the set's own `mark`, so the writer arms through its
existing `onMarkedDo` subscription. The relay, the purge's prefix list,
work namespaces and eviction are the existing ones widened (the 60 s eviction already sweeps every `browser:` row and
every expired work row store-wide, `browser-al-runtime-cleanup.ts:103-113`). No new row shape, schema id, codec,
`Map` or timer. `packages/shared/cache` is not needed: the port holds no keyed state.

**Limits.** A non-owner's checkpointed sends run from its memory and die with it until ownership turns to it; it keeps
no unsaved changes while it waits, and once its takeover's restore ran every row its pair holds is saved by the next
checkpoint, the restored rows included (D132, R-I2b-28, R-I2b-37). A restored key the pair already holds keeps the pair's value
(if-absent), so a row two tabs of the session wrote under one key (a per-origin version row) is the live tab's. The
first batch after a takeover may claim live rows too; its claim count is the outcome's `claimed`. A store that
cannot be read is stated on its health (`failing`, with its storage cause, which Task 5's skip ignores) and the lane
runs from memory; its rows stay until the session purge or their expiry. A checkpoint write already started when the
runtime is disposed completes; the writer starts none after disposal, so a purge that follows the disconnect is not
written back over. Restored messages have no handle (D13).

- [ ] **Step 1: Write the failing tests.** First the takeable ownership the checkpoint and lane tests hand over, in
      Task 3's support module (R-I2b-46 leaves the writer without ownership, so this task is its first user):

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/alm/checkpoint/al-checkpoint-test-support.ts b/packages/tests/shared/alm/checkpoint/al-checkpoint-test-support.ts
index ef4d4952e..76fb69e8a 100644
--- a/packages/tests/shared/alm/checkpoint/al-checkpoint-test-support.ts
+++ b/packages/tests/shared/alm/checkpoint/al-checkpoint-test-support.ts
@@ -1,4 +1,6 @@
 import type { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';
+import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
+import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';
 
 export const TEST_CHECKPOINT_SETTINGS: ALCheckpointWriter.Settings = { intervalMs: 1_000, lagBoundMs: 10_000 };
 
@@ -9,3 +11,19 @@ export const GLOBAL_CHECKPOINT_TIMERS: ALCheckpointWriter.Timers = {
         return () => clearTimeout(handle);
     }
 };
+
+export interface TakeableDurableWorkOwnership extends ALDurableWorkOwnership {
+    take(): void;
+}
+
+/** A session ownership a test hands to this runtime when it chooses, as a released owner lock does. */
+export function createTakeableDurableWorkOwnership(owned: boolean): TakeableDurableWorkOwnership {
+    const value = new ObservableLatestValue<boolean>().set(owned);
+    return {
+        owned: value,
+        isOwned: () => value.peek() === true,
+        take: () => value.accept(true),
+        announceCommit: () => undefined,
+        onForeignCommit: () => () => undefined
+    };
+}
```

Create `packages/tests/shared/alm/checkpoint/al-checkpoint.test.ts`:

<!-- dprint-ignore -->
```ts
import '../../../setup-browser-indexeddb.ts';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionStoredValue
} from '@shared/alm/al-admission-backend.ts';
import { ALCheckpoint, type ALCheckpointStorage } from '@shared/alm/checkpoint/al-checkpoint.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { toALOutboundWorkKey, toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type { IndexedDbAdmissionMutation } from '@shared/alm/write-indexed-db-admission-mutations.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toResourceEntryWithKey, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createTakeableDurableWorkOwnership,
    GLOBAL_CHECKPOINT_TIMERS,
    TEST_CHECKPOINT_SETTINGS,
    type TakeableDurableWorkOwnership
} from './al-checkpoint-test-support.ts';

const STORE_ID = 'browser-ws-client-checkpoint:session-1';
const NAMESPACE = `browser:${STORE_ID}`;
const ADMISSION_NAMESPACE = `${NAMESPACE}:outbound:admission`;
const ROW_KEY = `${ADMISSION_NAMESPACE}:row`;
const START_MS = 1_800_000_000_000;

describe('ALCheckpoint', () => {
    it('saves the changed rows in one readwrite, and another document\'s owner restores them without marking them unsaved', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.writeRow('one');
        await saving.memory.workQueue.enqueueIfAbsent(workEntry('effect-1', START_MS + 60_000));
        saving.observer.reset();

        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));
        const restoring = openCheckpoint({ dbName, clock, owned: true });
        await restoring.checkpoint.restore();
        restoring.observer.reset();
        restoring.checkpoint.flush();

        expect(restoring.readRow()).toBe('one');
        expect(await restoring.memory.workQueue.getItem(workKey('effect-1'))).toMatchObject({ resource: '{"effectId":"effect-1"}' });
        expect(saving.observer.getCounts().total).toBe(1);
        expect(restoring.observer.getCounts().total).toBe(0);
    });

    // The readwrite aborts after its work row was put and before its admission row: neither lands.
    it('leaves the saved rows as they were when its readwrite aborts, and saves the same changes on its next attempt', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.writeRow('one');
        await saving.memory.workQueue.enqueueIfAbsent(workEntry('effect-1', START_MS + 60_000));
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));

        await saving.writeRow('two');
        await saving.memory.workQueue.replaceIfObserved(
            (await saving.memory.workQueue.getItem(workKey('effect-1')))!,
            { ...workEntry('effect-1', START_MS + 60_000), resource: '{"effectId":"changed"}' }
        );
        const aborted = abortReadwriteAtAdmissionPut();
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(aborted.count).toBe(1));
        aborted.restore();
        expect(await readSaved(dbName, clock)).toEqual({ row: 'one', work: '{"effectId":"effect-1"}' });

        saving.checkpoint.flush();
        await vi.waitFor(async () => expect(await readSaved(dbName, clock)).toEqual({ row: 'two', work: '{"effectId":"changed"}' }));
    });

    it('loads only live rows, and counts the work rows past their expiry on its first batch', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.memory.workQueue.enqueueIfAbsent(workEntry('effect-1', START_MS + 1_000));
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));
        clock.nowMs = START_MS + 2_000;

        const restoring = openCheckpoint({ dbName, clock, owned: true });
        await restoring.checkpoint.restore();
        restoring.checkpoint.reportFirstBatch(0);

        expect(await restoring.memory.workQueue.getItem(workKey('effect-1'))).toBeUndefined();
        expect(restoring.events).toEqual([
            { kind: 'recovery', storeId: STORE_ID, outcome: { kind: 'expired-at-recovery', expired: 1 } }
        ]);
    });

    it('neither restores nor saves in a runtime that does not own the work, and restores when it takes over, keeping its own rows', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.writeRow('saved');
        await saving.memory.workQueue.enqueueIfAbsent(workEntry('effect-1', START_MS + 60_000));
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));

        const other = openCheckpoint({ dbName, clock, owned: false });
        const takenOver: string[] = [];
        const subscription = other.checkpoint.onTakenOverDo(() => takenOver.push('restored'));
        onTestFinished(() => subscription.unsubscribe());
        await other.checkpoint.restore();
        await other.writeRow('own');
        other.checkpoint.flush();
        expect(other.observer.getCounts().total).toBe(0);
        other.ownership.take();

        await vi.waitFor(() => expect(takenOver).toEqual(['restored']));
        expect(other.readRow()).toBe('own');
        expect(await other.memory.workQueue.getItem(workKey('effect-1'))).toBeDefined();
        expect(other.observer.getCounts().byKind).toEqual({ list: 1 });
    });

    it('keeps no unsaved changes in a runtime that does not own the work, and its first checkpoint after a takeover saves every row it holds', async () => {
        const dbName = newDbName();
        const clock = { nowMs: START_MS };
        const saving = openCheckpoint({ dbName, clock, owned: true });
        await saving.checkpoint.restore();
        await saving.writeRow('saved');
        saving.checkpoint.flush();
        await vi.waitFor(() => expect(saving.observer.getCounts().byKind.write).toBe(1));

        const other = openCheckpoint({ dbName, clock, owned: false });
        const takenOver: string[] = [];
        const subscription = other.checkpoint.onTakenOverDo(() => takenOver.push('restored'));
        onTestFinished(() => subscription.unsubscribe());
        await other.writeRowAt(`${ADMISSION_NAMESPACE}:own`, 'own');
        await other.writeRowAt(`${ADMISSION_NAMESPACE}:gone`, 'gone');
        await other.removeRowAt(`${ADMISSION_NAMESPACE}:gone`);
        other.ownership.take();

        // No flush: the takeover's marking arms the interval checkpoint by itself.
        await vi.waitFor(() => expect(takenOver).toEqual(['restored']));
        expect(other.writes).toEqual([]);
        await vi.waitFor(() => expect(other.writes).toHaveLength(1), { timeout: 3_000 });
        expect(other.writes[0]).toEqual([`set ${ADMISSION_NAMESPACE}:own`, `set ${ROW_KEY}`]);
    });
});

interface OpenedCheckpoint {
    readonly memory: InMemoryAdmissionBackend;
    readonly storage: ALCheckpointStorage;
    readonly checkpoint: ALCheckpoint;
    readonly ownership: TakeableDurableWorkOwnership;
    readonly observer: CountingIndexedDbOperationObserver;
    readonly events: readonly ALStorageEvent[];
    /** Each checkpoint write's admission mutations, as `<kind> <key>` sorted by key. */
    readonly writes: readonly (readonly string[])[];
    writeRow(value: string): Promise<void>;
    writeRowAt(key: string, value: string): Promise<void>;
    removeRowAt(key: string): Promise<void>;
    readRow(): string | undefined;
}

function openCheckpoint(input: { dbName: string; clock: { nowMs: number; }; owned: boolean; }): OpenedCheckpoint {
    const observer = createCountingIndexedDbOperationObserver();
    const events: ALStorageEvent[] = [];
    const nowMs = () => input.clock.nowMs;
    const queue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs()));
    const memory = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(queue), nowMs);
    const saved = new IndexedDbAdmissionBackend({
        dbName: input.dbName,
        storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
        nowMs,
        newWriteToken: () => crypto.randomUUID(),
        observer,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => undefined
    });
    const writes: string[][] = [];
    const writeUnfencedMutations = saved.writeUnfencedMutations.bind(saved);
    saved.writeUnfencedMutations = async (mutations) => {
        writes.push(mutations.mutations.map((mutation) => `${mutation.kind} ${toMutationKey(mutation)}`).sort());
        return await writeUnfencedMutations(mutations);
    };
    const storage: ALCheckpointStorage = {
        memory,
        saved,
        selection: {
            keyPrefix: `${NAMESPACE}:`,
            workRanges: { namespacePrefixes: [ADMISSION_NAMESPACE], canonicalScopes: [NAMESPACE] }
        },
        health: new ALStorageHealth({ storeId: STORE_ID, storage: (event) => events.push(event) }),
        settings: TEST_CHECKPOINT_SETTINGS,
        timers: GLOBAL_CHECKPOINT_TIMERS
    };
    const ownership = createTakeableDurableWorkOwnership(input.owned);
    const checkpoint = new ALCheckpoint({ storage, ownership, nowMs });
    onTestFinished(() => checkpoint.dispose());
    return {
        memory,
        storage,
        checkpoint,
        ownership,
        observer,
        events,
        writes,
        writeRow: async (value) => await memory.write(async (tx) => await tx.set(ROW_KEY, value, START_MS + 60_000)),
        writeRowAt: async (key, value) => await memory.write(async (tx) => await tx.set(key, value, START_MS + 60_000)),
        removeRowAt: async (key) => await memory.write(async (tx) => await tx.remove(key)),
        readRow: () => readStoredString(memory.peek(ROW_KEY))
    };
}

function toMutationKey(mutation: IndexedDbAdmissionMutation): string {
    return mutation.kind === 'set' ? mutation.stored.key : mutation.key;
}

/** What another document of the session would restore: the saved admission row and work row. */
async function readSaved(
    dbName: string,
    clock: { nowMs: number; }
): Promise<Readonly<{ row: string | undefined; work: string | undefined; }>> {
    const reader = openCheckpoint({ dbName, clock, owned: true });
    const read = await reader.storage.saved.readNamespaceRows(reader.storage.selection);
    return {
        row: readStoredString(read.rows.find((row) => row.key === ROW_KEY)),
        work: read.workRows.find((row) => row.key.contextId === 'effect-1')?.resource
    };
}

/** Aborts the next readwrite when it puts an admission row, after its queue puts were issued. */
function abortReadwriteAtAdmissionPut(): Readonly<{ count: number; restore(): void; }> {
    const put = IDBObjectStore.prototype.put;
    const aborted = { count: 0 };
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore['put']>
    ) {
        if (this.name !== 'entries' || this.transaction.mode !== 'readwrite') {
            return put.apply(this, args);
        }
        aborted.count += 1;
        const request = this.get(IDBKeyRange.only(''));
        this.transaction.abort();
        return request;
    });
    return {
        get count() {
            return aborted.count;
        },
        restore: () => spy.mockRestore()
    };
}

function workEntry(effectId: string, expiresAtMs: number): ResourceEntry {
    return toResourceEntryWithKey(
        workKey(effectId),
        toALOutboundWorkType(ADMISSION_NAMESPACE),
        { effectId },
        Temporal.Instant.fromEpochMilliseconds(expiresAtMs)
    );
}

function workKey(effectId: string) {
    return toALOutboundWorkKey(ADMISSION_NAMESPACE, effectId);
}

function readStoredString(stored: Pick<ALAdmissionStoredValue, 'value'> | undefined): string | undefined {
    return typeof stored?.value === 'string' ? stored.value : undefined;
}

function newDbName(): string {
    return `al-checkpoint-${crypto.randomUUID()}`;
}
```

Create `packages/tests/shared/alm/outbound/al-outbound-checkpoint-lane.test.ts`:

<!-- dprint-ignore -->
```ts
import '../../../setup-browser-indexeddb.ts';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createCheckpointALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createTakeableDurableWorkOwnership,
    GLOBAL_CHECKPOINT_TIMERS,
    TEST_CHECKPOINT_SETTINGS
} from '../checkpoint/al-checkpoint-test-support.ts';
import {
    createOutboundMessage,
    createVolatileOutboundTestStores,
    holdOutboundClaims,
    OUTBOUND_LEASE_RECOVERY_BOUND_MS
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';
import { createOutboundTestSession, createSessionOutboundTestRuntime } from '../session-outbound-test-runtime.ts';

const STORE_ID = 'browser-ws-client-checkpoint:session-1';
const QUOTA = new DOMException('full', 'QuotaExceededError');

describe('the checkpoint lane of an outbound runtime', () => {
    it('admits a checkpointed send from memory, durable only in the runtime that owns the work, and stamps its settlements', async () => {
        const owner = createCheckpointTestRuntime({ dbName: newDbName(), owned: true });
        const other = createCheckpointTestRuntime({ dbName: newDbName(), owned: false });

        const owned = await owner.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-owner'));
        const local = await other.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-other'));

        expect(owned.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 1 });
        expect(local.verdict).toEqual({ kind: 'admitted', durable: false, queuedAttempts: 1 });
        await vi.waitFor(() => expect([...owner.sent, ...other.sent]).toEqual(['checkpoint-owner', 'checkpoint-other']));
        expect(new Set(owner.settlements.map((event) => event.lane))).toEqual(new Set(['checkpoint']));
    });

    it('keeps a checkpointed send in memory, never durable, in a runtime that holds no checkpoint lane', async () => {
        const memoryOnly = createCheckpointTestRuntime({ dbName: newDbName(), owned: true, withoutCheckpointLane: true });

        const admitted = await memoryOnly.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-in-memory'));

        expect(admitted.verdict).toEqual({ kind: 'admitted', durable: false, queuedAttempts: 1 });
        await vi.waitFor(() => expect(memoryOnly.sent).toEqual(['checkpoint-in-memory']));
        expect(new Set(memoryOnly.settlements.map((event) => event.lane))).toEqual(new Set(['volatile']));
        expect(memoryOnly.observer.getCounts().total).toBe(0);
    });

    it('restores a reloaded document\'s unsent message before its first batch and sends it once', async () => {
        const dbName = newDbName();
        const reloaded = createCheckpointTestRuntime({ dbName, owned: true });
        await reloaded.runtime.ready();
        const held = holdOutboundClaims(reloaded.checkpointStores);
        await reloaded.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-unsent'));
        reloaded.runtime.flushCheckpoint();
        await vi.waitFor(() => expect(reloaded.observer.getCounts().byKind.write).toBe(1));
        reloaded.runtime.dispose();
        await held.release();

        const restored = createCheckpointTestRuntime({ dbName, owned: true });
        await restored.runtime.ready();

        await vi.waitFor(() => expect(restored.sent).toEqual(['checkpoint-unsent']));
        expect(reloaded.sent).toEqual([]);
        expect(restored.storage.filter((event) => event.kind === 'recovery')).toEqual([
            { kind: 'recovery', storeId: STORE_ID, outcome: { kind: 'restored', claimed: 1, expired: 0 } }
        ]);
    });

    it('restores a closed owner\'s checkpointed message when the next runtime of the session takes over, and sends it once', async () => {
        const session = createOutboundTestSession();
        const closing = createSessionOutboundTestRuntime(session, createTakeableDurableWorkOwnership(true));
        const waiting = createSessionOutboundTestRuntime(session, createTakeableDurableWorkOwnership(false));
        await Promise.all([closing.runtime.ready(), waiting.runtime.ready()]);
        const held = holdOutboundClaims(closing.checkpointStores);
        await closing.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-left'));
        closing.runtime.flushCheckpoint();
        await vi.waitFor(() => expect(session.checkpointObserver.getCounts().byKind.write).toBe(1));
        closing.runtime.dispose();
        await held.release();

        waiting.ownership.take();

        await vi.waitFor(() => expect(waiting.sent).toEqual(['checkpoint-left']));
        expect(closing.sent).toEqual([]);
        await vi.waitFor(() =>
            expect(session.checkpointStorage.filter((event) => event.kind === 'recovery').at(-1)).toEqual({
                kind: 'recovery',
                storeId: 'session-outbound-checkpoint',
                outcome: { kind: 'restored', claimed: 1, expired: 0 }
            })
        );
    });

    it('claims a row a reloaded document left reserved once the row\'s lease ends', async () => {
        const dbName = newDbName();
        const clock = { nowMs: Date.now() };
        const reloaded = createCheckpointTestRuntime({ dbName, owned: true, clock, holdSends: true });
        await reloaded.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-reserved'));
        await vi.waitFor(() => expect(reloaded.attempted).toEqual(['checkpoint-reserved']));
        reloaded.runtime.flushCheckpoint();
        await vi.waitFor(() => expect(reloaded.observer.getCounts().byKind.write).toBe(1));
        reloaded.runtime.dispose();
        clock.nowMs += OUTBOUND_LEASE_RECOVERY_BOUND_MS;

        const restored = createCheckpointTestRuntime({ dbName, owned: true, clock });
        await restored.runtime.ready();

        await vi.waitFor(() => expect(restored.sent).toEqual(['checkpoint-reserved']));
    });

    // Refusing a send while the lag stands is the browser dispatch's: the lane states the lag and keeps sending.
    it('states delayed then failing with checkpoint-lag while its checkpoints fail, and healthy once one completes', async () => {
        const failing = { writes: true };
        const lane = createCheckpointTestRuntime({
            dbName: newDbName(),
            owned: true,
            settings: { intervalMs: 20, lagBoundMs: 100 },
            fault: {
                observe: (operation) => failing.writes && operation.kind === 'write' ? Promise.reject(QUOTA) : undefined
            }
        });

        await lane.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-unsaved'));
        await vi.waitFor(() => expect(lane.readStatuses()).toEqual(['delayed', 'failing']));
        const lagging = await lane.runtime.enqueueIfAbsent(createOutboundMessage('checkpoint-while-lagging'));
        failing.writes = false;

        await vi.waitFor(() => expect(lane.readStatuses()).toEqual(['delayed', 'failing', 'healthy']));
        expect(lagging.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(lane.storage.find((event) => event.kind === 'health' && event.status === 'failing')).toMatchObject({
            lastFailure: {
                cause: 'checkpoint-lag',
                detail: expect.stringMatching(
                    /^The oldest unsaved change is \d+ ms old, beyond the 100 ms bound\. The last checkpoint failed: QuotaExceededError: full$/
                )
            }
        });
        await vi.waitFor(() => expect(lane.sent).toEqual(['checkpoint-unsaved', 'checkpoint-while-lagging']));
    });
});

interface CheckpointTestRuntimeInput {
    readonly dbName: string;
    readonly owned: boolean;
    readonly settings?: ALCheckpointWriter.Settings;
    /** Asked before each storage operation of the checkpoint store, after the counting observer. */
    readonly fault?: IndexedDbOperationObserver;
    readonly clock?: { readonly nowMs: number; };
    /** Every attempt starts and none settles, as a document that reloads mid-send leaves it. */
    readonly holdSends?: boolean;
    /** A runtime built without the checkpoint pair, as the server's and Node's are. */
    readonly withoutCheckpointLane?: boolean;
}

function createCheckpointTestRuntime(input: CheckpointTestRuntimeInput) {
    const storage: ALStorageEvent[] = [];
    const settlements: ALDeliverySettlement[] = [];
    const sent: string[] = [];
    const attempted: string[] = [];
    const nowMs = () => input.clock?.nowMs ?? Date.now();
    const counting = createCountingIndexedDbOperationObserver();
    const observer: CountingIndexedDbOperationObserver = {
        ...counting,
        observe: (operation) => {
            counting.observe(operation);
            return input.fault?.observe(operation);
        }
    };
    const ownership = createTakeableDurableWorkOwnership(input.owned);
    const checkpointStores = createCheckpointALOutboundRuntimeStores<OutboundTestPayload>({
        dbName: input.dbName,
        namespace: `browser:${STORE_ID}`,
        nowMs,
        observer,
        decodePrepared: decodeOutboundTestPayload,
        storageHealth: new ALStorageHealth({ storeId: STORE_ID, storage: (event) => storage.push(event) }),
        ownership,
        ...(input.settings ?? TEST_CHECKPOINT_SETTINGS),
        timers: GLOBAL_CHECKPOINT_TIMERS
    });
    const runtime: ALOutboundMessageRuntime<OutboundTestPayload> = createDefaultALOutboundMessageRuntime({
        decodePreparedMessage: decodeOutboundTestPayload,
        queueEngine: new InboxOutboxEngine(),
        outbox: new InMemoryQueueBox(new Map()),
        volatileStores: createVolatileOutboundTestStores(),
        checkpointStores: input.withoutCheckpointLane === true ? undefined : checkpointStores,
        durableWorkOwnership: ownership,
        nowMs,
        carrier: 'ws',
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'checkpoint',
            preparedMessages: [{ peer: 'receiver' }]
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            attempted.push(lifecycle.canonicalMessage.route.resourceId);
            if (input.holdSends === true) {
                return await new Promise(() => undefined);
            }
            sent.push(lifecycle.canonicalMessage.route.resourceId);
            return { status: 'sent', submissionAttempted: true };
        },
        settlements: (event) => settlements.push(event)
    });
    onTestFinished(() => runtime.dispose());
    return {
        runtime,
        checkpointStores,
        observer,
        storage,
        settlements,
        sent,
        attempted,
        readStatuses: () => storage.flatMap((event) => event.kind === 'health' ? [event.status] : [])
    };
}

function newDbName(): string {
    return `al-checkpoint-lane-${crypto.randomUUID()}`;
}
```

The shared fixtures (R-I2b-21), `packages/tests/shared/alm/session-outbound-test-runtime.ts` and `packages/tests/shared/alm/outbound-runtime-test-fixture.ts`:

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared/alm/session-outbound-test-runtime.ts
+++ b/packages/tests/shared/alm/session-outbound-test-runtime.ts
@@ -3,8 +3,13 @@ import '../../setup-browser-indexeddb.ts';
 import { onTestFinished } from 'vitest';
 
 import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
-import { createDefaultIndexedDbALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
+import {
+    createCheckpointALOutboundRuntimeStores,
+    createDefaultIndexedDbALOutboundRuntimeStores,
+    type ALStoreDurability
+} from '@shared/alm/al-runtime-stores.ts';
 import type {
+    ALCheckpointOutboundRuntimeStores,
     ALOutboundMessageRuntime,
     ALOutboundRuntimeDiagnosticsEvent
 } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
@@ -12,10 +17,15 @@ import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/crea
 import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
 import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
 import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
+import {
+    createCountingIndexedDbOperationObserver,
+    type CountingIndexedDbOperationObserver
+} from '@shared/persistence/indexed-db-operation-observer.ts';
 import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
 import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
 import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
 
+import { GLOBAL_CHECKPOINT_TIMERS, TEST_CHECKPOINT_SETTINGS } from './checkpoint/al-checkpoint-test-support.ts';
 import { createVolatileOutboundTestStores } from './outbound-runtime-test-fixture.ts';
 import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';
 
@@ -25,12 +35,17 @@ export interface OutboundTestSession {
     readonly namespace: string;
     /** The storage events every runtime's store stated, in the order they were stated. */
     readonly storage: ALStorageEvent[];
+    /** The storage events of every runtime's checkpoint store, kept apart from the durable store's. */
+    readonly checkpointStorage: ALStorageEvent[];
+    /** Counts the checkpoint stores' IndexedDB operations, every runtime's together. */
+    readonly checkpointObserver: CountingIndexedDbOperationObserver;
 }
 
 export interface SessionOutboundTestRuntime<TOwnership extends ALDurableWorkOwnership> {
     readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
     readonly engine: InboxOutboxEngine;
     readonly ownership: TOwnership;
+    readonly checkpointStores: ALCheckpointOutboundRuntimeStores<OutboundTestPayload>;
     /** The resource id of every message this runtime's carrier sent, in send order. */
     readonly sent: readonly string[];
     /** The admission namespace whose work type the session's runtimes share. */
@@ -39,12 +54,19 @@ export interface SessionOutboundTestRuntime<TOwnership extends ALDurableWorkOwne
 }
 
 export function createOutboundTestSession(): OutboundTestSession {
-    return { dbName: `session-outbound-${crypto.randomUUID()}`, namespace: 'session-outbound', storage: [] };
+    return {
+        dbName: `session-outbound-${crypto.randomUUID()}`,
+        namespace: 'session-outbound',
+        storage: [],
+        checkpointStorage: [],
+        checkpointObserver: createCountingIndexedDbOperationObserver()
+    };
 }
 
 /**
  * One runtime of the session on an engine of its own: a message whose resource id starts with
- * `durable` goes to the IndexedDB lane, any other to the runtime's memory lane.
+ * `durable` goes to the IndexedDB lane, one starting with `checkpoint` to the checkpoint lane, any
+ * other to the runtime's memory lane.
  */
 export function createSessionOutboundTestRuntime<TOwnership extends ALDurableWorkOwnership>(
     session: OutboundTestSession,
@@ -59,12 +81,14 @@ export function createSessionOutboundTestRuntime<TOwnership extends ALDurableWor
         decodePrepared: decodeOutboundTestPayload,
         storageHealth: new ALStorageHealth({ storeId: session.namespace, storage: (event) => session.storage.push(event) })
     });
+    const checkpointStores = createSessionCheckpointTestStores(session, ownership);
     const runtime = createDefaultALOutboundMessageRuntime<OutboundTestPayload>({
         decodePreparedMessage: decodeOutboundTestPayload,
         queueEngine: engine,
         outbox: new InMemoryQueueBox(new Map()),
         stores,
         volatileStores: createVolatileOutboundTestStores(),
+        checkpointStores,
         durableWorkOwnership: ownership,
         carrier: 'ws',
         toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
@@ -72,7 +96,7 @@ export function createSessionOutboundTestRuntime<TOwnership extends ALDurableWor
         planOutgoingMessage: (msg) => ({
             msg,
             dropReasonCode: undefined,
-            lane: msg.route.resourceId.startsWith('durable') ? 'durable' : 'volatile',
+            lane: toSessionTestLane(msg.route.resourceId),
             preparedMessages: [{ peer: 'receiver' }]
         }),
         sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
@@ -86,8 +110,33 @@ export function createSessionOutboundTestRuntime<TOwnership extends ALDurableWor
         runtime,
         engine,
         ownership,
+        checkpointStores,
         sent,
         namespace: stores.admissionStore.namespace,
         readDurableProbes: () => diagnostics.filter((event) => event.kind === 'readiness-probe' && event.lane === 'durable')
     };
 }
+
+function createSessionCheckpointTestStores(
+    session: OutboundTestSession,
+    ownership: ALDurableWorkOwnership
+): ALCheckpointOutboundRuntimeStores<OutboundTestPayload> {
+    const storeId = `${session.namespace}-checkpoint`;
+    return createCheckpointALOutboundRuntimeStores({
+        dbName: session.dbName,
+        namespace: storeId,
+        decodePrepared: decodeOutboundTestPayload,
+        observer: session.checkpointObserver,
+        storageHealth: new ALStorageHealth({ storeId, storage: (event) => session.checkpointStorage.push(event) }),
+        ownership,
+        ...TEST_CHECKPOINT_SETTINGS,
+        timers: GLOBAL_CHECKPOINT_TIMERS
+    });
+}
+
+function toSessionTestLane(resourceId: string): ALStoreDurability {
+    if (resourceId.startsWith('durable')) {
+        return 'durable';
+    }
+    return resourceId.startsWith('checkpoint') ? 'checkpoint' : 'volatile';
+}
```

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared/alm/outbound-runtime-test-fixture.ts
+++ b/packages/tests/shared/alm/outbound-runtime-test-fixture.ts
@@ -10,6 +10,7 @@ import type { ALDeliveryCarrier, ALDeliverySettlementSink } from '@shared/alm/de
 import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
 import { AL_ADMISSION_SCHEMA_ID, type ALStorageResetListeners } from '@shared/alm/open-indexed-db-admission-database.ts';
 import type {
+    ALCheckpointOutboundRuntimeStores,
     ALOutboundAckTrackingPlan,
     ALOutboundRuntimeDiagnosticsSink,
     ALOutboundRuntimeStores,
@@ -76,6 +77,8 @@ interface OutboundTestRuntimeInput<TPrepared> {
     readonly stores?: ALOutboundRuntimeStores<TPrepared>;
     /** The memory pair a volatile plan is admitted to; absent, every admission uses `stores`. */
     readonly volatileStores?: ALVolatileOutboundRuntimeStores<TPrepared>;
+    /** The memory pair a checkpointed plan is admitted to; absent, such a plan stays in the volatile pair. */
+    readonly checkpointStores?: ALCheckpointOutboundRuntimeStores<TPrepared>;
     readonly dequeue?: ALOutboundMessageRuntime.DequeueSource;
     readonly diagnostics?: ALOutboundRuntimeDiagnosticsSink;
     /** The carrier every settlement this runtime states is stamped with; `ws` unless a test says otherwise. */
@@ -180,6 +183,7 @@ export function createOutboundTestRuntimeFor<TPrepared>(
             outbox: options.outbox ?? new InMemoryQueueBox(new Map()),
             stores: options.stores,
             volatileStores: options.volatileStores,
+            checkpointStores: options.checkpointStores,
             dequeue: options.dequeue,
             diagnostics: options.diagnostics,
             carrier: options.carrier ?? 'ws',
```

The purge case, the moved reader and the relay case:

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts
@@ -12,6 +12,7 @@ import {
 
 import '../../setup-browser-indexeddb.ts';
 
+import { toBrowserWsClientALCheckpointRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-checkpoint-store-ids.ts';
 import {
     deleteBrowserALRuntimeEntriesForSession,
     deleteExpiredBrowserALRuntimeEntries,
@@ -24,19 +25,26 @@ import {
     resolveBrowserSessionALInboundRuntimeStores,
     resolveBrowserWsClientALOutboundRuntimeStores
 } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
-import {
-    readBrowserALWorkCleanupRows,
-    writeBrowserALWorkExpiryCleanup
-} from '@shared-web/browser/al-runtime/browser-al-work-cleanup.ts';
+import { writeBrowserALWorkExpiryCleanup } from '@shared-web/browser/al-runtime/browser-al-work-cleanup.ts';
 import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
+import {
+    createCheckpointALOutboundRuntimeStores,
+    createDefaultInMemoryALOutboundRuntimeStores
+} from '@shared/alm/al-runtime-stores.ts';
 import {
     AL_ADMISSION_SCHEMA_ID,
     AL_ADMISSION_WORK_STORE_NAME,
     openIndexedDbAdmissionDatabase
 } from '@shared/alm/open-indexed-db-admission-database.ts';
 import { decodeALOutboundIdentityFact, toALOutboundIdentityKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
-import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
+import { readIndexedDbAdmissionSnapshot } from '@shared/alm/read-indexed-db-admission-snapshot.ts';
+import { readALWorkRowsInRanges } from '@shared/alm/storage/read-al-work-rows-in-ranges.ts';
+import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
+import {
+    createCountingIndexedDbOperationObserver,
+    createPassThroughIndexedDbOperationObserver
+} from '@shared/persistence/indexed-db-operation-observer.ts';
 import { readIndexedDbRequest, readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
 import { IndexedDbConnection } from '@shared/persistence/open-indexed-db.ts';
 import {
@@ -52,6 +60,7 @@ import {
     it,
     vi
 } from 'vitest';
+import { GLOBAL_CHECKPOINT_TIMERS, TEST_CHECKPOINT_SETTINGS } from '../../shared/alm/checkpoint/al-checkpoint-test-support.ts';
 import { createOutboundMessage, createOutboundTestRuntimeFor } from '../../shared/alm/outbound-runtime-test-fixture.ts';
 
 interface RawWorkRow {
@@ -142,7 +151,7 @@ describe('browser canonical outbound cleanup', () => {
             const ownerKey = await retainPendingUnderNamespace(db, ownerNamespace, 'x');
             const impostorKey = await retainPendingUnderNamespace(db, impostorNamespace, 'y');
 
-            const rows = await readBrowserALWorkCleanupRows(db, {
+            const rows = await readALWorkRowsInRanges(db, {
                 namespacePrefixes: [ownerNamespace],
                 canonicalScopes: []
             });
@@ -215,6 +224,22 @@ describe('browser canonical outbound cleanup', () => {
         expect(remaining.some((row) => row.keyString.includes(unrelated.key.resourceId))).toBe(true);
     });
 
+    it('removes one session\'s checkpoint rows with its durable rows', async () => {
+        const target = await saveCheckpointForSession(`checkpoint-target-${crypto.randomUUID()}`);
+        const other = await saveCheckpointForSession(`checkpoint-other-${crypto.randomUUID()}`);
+
+        await deleteBrowserALRuntimeEntriesForSession(target.sessionId, {
+            currentScope: SCOPE,
+            storage: diagnosticsPorts.storage
+        });
+        const remaining = await readRawWorkRows();
+
+        expect(remaining.filter((row) => target.keys.has(row.keyString))).toEqual([]);
+        expect(remaining.filter((row) => other.keys.has(row.keyString))).toHaveLength(other.keys.size);
+        expect(await target.readAdmissionKeys()).toEqual([]);
+        expect(await other.readAdmissionKeys()).not.toEqual([]);
+    });
+
     it('re-arms the per-run deletion budget until every expired work row is drained', async () => {
         const nowMs = Date.now();
         const expiredCount = INDEXED_DB_QUEUE_CLEANUP_MAX_EXPIRED_TO_DELETE + 40;
@@ -322,6 +347,59 @@ async function admitForSession(sessionId: string, ttlMs: number) {
     return { store, keys };
 }
 
+/** A send on the session's WS checkpoint lane, saved by its owner: its canonical, identity and work rows. */
+async function saveCheckpointForSession(sessionId: string) {
+    const storeId = toBrowserWsClientALCheckpointRuntimeStoreId(sessionId);
+    const observer = createCountingIndexedDbOperationObserver();
+    const stores = createCheckpointALOutboundRuntimeStores({
+        dbName: SCOPE_DB_NAME,
+        namespace: `browser:${storeId}`,
+        observer,
+        decodePrepared: decodeALOutboundTransportMessage,
+        ownership: ALWAYS_OWNED_AL_DURABLE_WORK,
+        ...TEST_CHECKPOINT_SETTINGS,
+        timers: GLOBAL_CHECKPOINT_TIMERS
+    });
+    const before = new Set((await readRawWorkRows()).map((row) => row.keyString));
+    const runtime = createOutboundTestRuntimeFor({
+        queueEngine: new InboxOutboxEngine(),
+        stores: createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage }),
+        checkpointStores: stores,
+        decodePreparedMessage: decodeALOutboundTransportMessage,
+        planOutgoingMessage: (msg) => ({
+            msg,
+            dropReasonCode: undefined,
+            lane: 'checkpoint',
+            preparedMessages: [toALOutboundTransportMessage(msg)]
+        }),
+        sendPreparedMessage: async () => ({ status: 'not-ready', submissionAttempted: false, retryAfterMs: 60_000 })
+    });
+    await runtime.enqueueIfAbsent(createOutboundMessage(sessionId, { ttlMs: 60_000 }));
+    runtime.flushCheckpoint();
+    await vi.waitFor(() => expect(observer.getCounts().byKind.write).toBe(1));
+    runtime.dispose();
+    const keys = new Set((await readRawWorkRows()).map((row) => row.keyString).filter((key) => !before.has(key)));
+    expect(keys.size).toBe(3);
+    const readAdmissionKeys = async () => await readRawAdmissionKeys(`browser:${storeId}:`);
+    return { sessionId, keys, readAdmissionKeys };
+}
+
+async function readRawAdmissionKeys(prefix: string): Promise<readonly string[]> {
+    const db = await openIndexedDbAdmissionDatabase({
+        dbName: SCOPE_DB_NAME,
+        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
+        schemaId: AL_ADMISSION_SCHEMA_ID,
+        onStorageReset: () => {}
+    });
+    try {
+        const rows = await readIndexedDbAdmissionSnapshot(db, BROWSER_AL_RUNTIME_STORE_NAME, { kind: 'prefixes', prefixes: [prefix] });
+        return rows.map((row) => row.key);
+    }
+    finally {
+        db.close();
+    }
+}
+
 async function readRawWorkRows(): Promise<readonly RawWorkRow[]> {
     const db = await openIndexedDbAdmissionDatabase({
         dbName: SCOPE_DB_NAME,
```

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts
+++ b/packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts
@@ -42,6 +42,20 @@ describe('browser delivery settlement relay', () => {
         expect(bystander.registry.getHandle(handle.msgId)).toBeUndefined();
     });
 
+    // A restored checkpoint message has no handle anywhere, so the owner relays its settlements as a durable one's.
+    it('relays a checkpoint lane\'s settlement as it relays a durable lane\'s', async () => {
+        const wire = listenOnSessionChannel('session-1');
+        const sender = createTab('session-1');
+        const owner = createTab('session-1');
+        const handle = sender.registry.open(createMessage('checkpoint-send'), 'ws');
+
+        owner.epoch.settlements.ws({ ...toAttemptStarted(handle.msgId, 'attempt-1'), lane: 'checkpoint' });
+        await flushChannel();
+
+        expect(wire.map((message) => message.kind)).toEqual(['settlement']);
+        expect(handle.lifecycle().evidence.attempts.map((attempt) => attempt.attemptId)).toEqual(['attempt-1']);
+    });
+
     // A volatile message's state lives in the tab that admitted it, and a settlement no lane stated is the
     // recording tab's own; neither reaches another tab.
     it('relays no settlement of a volatile lane and none that no lane stated', async () => {
```

The three call sites of the widened factory and `Resources`:

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared/al-outbound-message-runtime.test.ts
+++ b/packages/tests/shared/al-outbound-message-runtime.test.ts
@@ -63,6 +63,7 @@ describe('ALOutboundMessageRuntime', () => {
             storageHealth: undefined,
             storageRecovery: undefined,
             volatileStores: undefined,
+            checkpointStores: undefined,
             dequeue: { types: new Set<string>(), resilience: createDefaultALOutboundDequeueResilience() },
             effectWorkerId: 'injected-outbound-worker',
             clock: { nowMs: () => nowMs },
```

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared/alm/al-outbound-store-lane.test.ts
+++ b/packages/tests/shared/alm/al-outbound-store-lane.test.ts
@@ -157,7 +157,7 @@ function createObservedVolatileStores() {
             supersedenceTrackTtlMs: 60_000,
             retention: normalizeALRuntimeStoreRetention(),
             decodePrepared: decodeOutboundTestPayload
-        }),
+        }, 'volatile'),
         workQueue: backend.workQueue,
         evictExpired,
         budget: undefined
```

<!-- dprint-ignore -->
```diff
--- a/packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts
+++ b/packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts
@@ -160,7 +160,7 @@ function createObservedOutboundPair(durability: 'durable' | 'volatile'): Observe
         state,
         stores: {
             admissionStore: durability === 'volatile'
-                ? createVolatileALOutboundAdmissionStore(input)
+                ? createVolatileALOutboundAdmissionStore(input, 'volatile')
                 : createALOutboundAdmissionStore(input),
             workQueue: backend.workQueue,
             evictExpired: () => backend.evictExpired(),
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared/alm/checkpoint/al-checkpoint.test.ts packages/tests/shared/alm/outbound/al-outbound-checkpoint-lane.test.ts \
  packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts \
  packages/tests/shared/alm/al-outbound-store-lane.test.ts packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts \
  packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/alm/work/al-durable-work-ownership.test.ts
```

Expected (measured on Task 3's tree): `Error: Cannot find package '@shared/alm/checkpoint/al-checkpoint.ts'`,
`Failed to resolve import "@shared/alm/storage/read-al-work-rows-in-ranges.ts"` (the cleanup test, which also imports
`browser-al-checkpoint-store-ids.ts`), nine
`TypeError: createCheckpointALOutboundRuntimeStores is not a function` (the lane file, and the three session-runtime
cases of `al-durable-work-ownership.test.ts` through the fixture), the relay case `AssertionError: expected [] to
deeply equal [ 'settlement' ]`; `Test Files  5 failed | 3 passed (8)`, `Tests  10 failed | 53 passed (63)`.

- [ ] **Step 3: One work-key range reader for the purge and the restore.** Create
      `packages/shared/alm/storage/read-al-work-rows-in-ranges.ts`:

<!-- dprint-ignore -->
```ts
import { readIndexedDbTransaction } from '../../persistence/indexed-db-request.ts';
import { fnv1a64 } from '../../queuebox/AppQueueIdentity.ts';
import {
    decodeStoredResourceEntryValue,
    type StoredResourceEntry
} from '../../queuebox/indexed-db-queue-box-entry-codec.ts';
import { toALInboundWorkKey } from '../inbound/al-inbound-work-entry.ts';
import { AL_ADMISSION_WORK_STORE_NAME } from '../open-indexed-db-admission-database.ts';
import { toALOutboundWorkKey } from '../outbound/al-outbound-work-entry.ts';

/** High sentinel code point: bounds a string-prefix IndexedDB key range from above. */
const KEY_RANGE_UPPER_SENTINEL = '￿';

export interface ALWorkKeyRangesInput {
    readonly namespacePrefixes: readonly string[];
    readonly canonicalScopes: readonly string[];
}

/**
 * One bounded range per owned AL_INBOUND/AL_OUTBOUND namespace and per owned canonical scope.
 * The namespace's own work-key builders compute each bound: `toAppQueueKey` hash-truncates any
 * part over its length limit, so a long browser namespace is not a literal prefix of its own key.
 * Every stored key is `topicId/resourceId/contextId`; each range ends its resourceId with the `/`
 * delimiter so a resourceId that is itself a string prefix of another owner's resourceId (e.g.
 * `abc` vs `abc123`) can't pull that other owner's rows into this range too.
 */
export function toALWorkKeyRanges(input: ALWorkKeyRangesInput): readonly IDBKeyRange[] {
    const ranges: IDBKeyRange[] = [];
    for (const namespace of input.namespacePrefixes) {
        const inboundResourceId = toALInboundWorkKey(namespace, '').resourceId;
        const outboundResourceId = toALOutboundWorkKey(namespace, '').resourceId;
        ranges.push(toALWorkKeyRange('AL_INBOUND', inboundResourceId));
        ranges.push(toALWorkKeyRange('AL_OUTBOUND', outboundResourceId));
    }
    for (const scope of input.canonicalScopes) {
        const hashed = `scope-${fnv1a64(scope)}`;
        ranges.push(toALWorkKeyRange('AL_OUTBOUND_MESSAGE', hashed));
        ranges.push(toALWorkKeyRange('AL_OUTBOUND_IDENTITY', hashed));
    }
    return ranges;
}

/** Reads retained facts directly: QueueBox read APIs may themselves evict expired rows. */
export async function readALWorkRowsInRanges(
    db: IDBDatabase,
    input: ALWorkKeyRangesInput
): Promise<readonly StoredResourceEntry[]> {
    const ranges = toALWorkKeyRanges(input);
    const tx = db.transaction(AL_ADMISSION_WORK_STORE_NAME, 'readonly');
    return await readIndexedDbTransaction(tx, async () => {
        const store = tx.objectStore(AL_ADMISSION_WORK_STORE_NAME);
        const found: StoredResourceEntry[] = [];
        for (const range of ranges) {
            found.push(...await readALWorkRowsInRange(store, range));
        }
        return found;
    });
}

function toALWorkKeyRange(topicId: string, resourceId: string): IDBKeyRange {
    return IDBKeyRange.bound(`${topicId}/${resourceId}/`, `${topicId}/${resourceId}/${KEY_RANGE_UPPER_SENTINEL}`);
}

function readALWorkRowsInRange(
    store: IDBObjectStore,
    range: IDBKeyRange
): Promise<readonly StoredResourceEntry[]> {
    return new Promise((resolve, reject) => {
        const found: StoredResourceEntry[] = [];
        const request = store.openCursor(range);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            try {
                const cursor = request.result;
                if (!cursor) {
                    resolve(found);
                    return;
                }
                found.push(decodeStoredResourceEntryValue(cursor.value));
                cursor.continue();
            }
            catch (error) {
                reject(error);
            }
        };
    });
}
```

Remove the moved code from `browser-al-work-cleanup.ts` (the purge's switch to the shared reader is in Step 9's `browser-al-runtime-cleanup.ts` diff):

<!-- dprint-ignore -->
```diff
--- a/packages/shared-web/browser/al-runtime/browser-al-work-cleanup.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-work-cleanup.ts
@@ -1,15 +1,10 @@
 import { Temporal } from '@js-temporal/polyfill';
 import { AL_ADMISSION_WORK_COMPLETED_RETENTION } from '@shared/alm/al-admission-work-backend.ts';
-import { toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';
 import { AL_ADMISSION_WORK_STORE_NAME } from '@shared/alm/open-indexed-db-admission-database.ts';
-import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
 import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
-import { readIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
 import { IndexedDbConnection } from '@shared/persistence/open-indexed-db.ts';
-import { fnv1a64 } from '@shared/queuebox/AppQueueIdentity.ts';
 import {
     decodeStoredResourceEntry,
-    decodeStoredResourceEntryValue,
     type StoredResourceEntry
 } from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
 import {
@@ -20,98 +15,6 @@ import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
 
 import type { BrowserALRuntimeDeletionPolicy } from './browser-al-runtime-cleanup.ts';
 
-/** High sentinel code point: bounds a string-prefix IndexedDB key range from above. */
-const KEY_RANGE_UPPER_SENTINEL = '\uffff';
-
-export interface BrowserALWorkCleanupRangesInput {
-    readonly namespacePrefixes: readonly string[];
-    readonly canonicalScopes: readonly string[];
-}
-
-/**
- * One bounded range per owned AL_INBOUND/AL_OUTBOUND namespace and per owned canonical scope.
- * The namespace's own work-key builders compute each bound: `toAppQueueKey` hash-truncates any
- * part over its length limit, so a long browser namespace is not a literal prefix of its own key.
- * Every stored key is `topicId/resourceId/contextId`; each range ends its resourceId with the `/`
- * delimiter so a resourceId that is itself a string prefix of another owner's resourceId (e.g.
- * `abc` vs `abc123`) can't pull that other owner's rows into this range too.
- */
-export function toBrowserALWorkCleanupRanges(
-    input: BrowserALWorkCleanupRangesInput
-): readonly IDBKeyRange[] {
-    const ranges: IDBKeyRange[] = [];
-    for (const namespace of input.namespacePrefixes) {
-        const inboundResourceId = toALInboundWorkKey(namespace, '').resourceId;
-        const outboundResourceId = toALOutboundWorkKey(namespace, '').resourceId;
-        ranges.push(
-            IDBKeyRange.bound(
-                `AL_INBOUND/${inboundResourceId}/`,
-                `AL_INBOUND/${inboundResourceId}/${KEY_RANGE_UPPER_SENTINEL}`
-            )
-        );
-        ranges.push(
-            IDBKeyRange.bound(
-                `AL_OUTBOUND/${outboundResourceId}/`,
-                `AL_OUTBOUND/${outboundResourceId}/${KEY_RANGE_UPPER_SENTINEL}`
-            )
-        );
-    }
-    for (const scope of input.canonicalScopes) {
-        const hashed = `scope-${fnv1a64(scope)}`;
-        ranges.push(IDBKeyRange.bound(
-            `AL_OUTBOUND_MESSAGE/${hashed}/`,
-            `AL_OUTBOUND_MESSAGE/${hashed}/${KEY_RANGE_UPPER_SENTINEL}`
-        ));
-        ranges.push(IDBKeyRange.bound(
-            `AL_OUTBOUND_IDENTITY/${hashed}/`,
-            `AL_OUTBOUND_IDENTITY/${hashed}/${KEY_RANGE_UPPER_SENTINEL}`
-        ));
-    }
-    return ranges;
-}
-
-/** Reads retained facts directly: QueueBox read APIs may themselves evict expired rows. */
-export async function readBrowserALWorkCleanupRows(
-    db: IDBDatabase,
-    input: BrowserALWorkCleanupRangesInput
-): Promise<readonly StoredResourceEntry[]> {
-    const ranges = toBrowserALWorkCleanupRanges(input);
-    const tx = db.transaction(AL_ADMISSION_WORK_STORE_NAME, 'readonly');
-    return await readIndexedDbTransaction(tx, async () => {
-        const store = tx.objectStore(AL_ADMISSION_WORK_STORE_NAME);
-        const found: StoredResourceEntry[] = [];
-        for (const range of ranges) {
-            found.push(...await readBrowserALWorkCleanupRange(store, range));
-        }
-        return found;
-    });
-}
-
-function readBrowserALWorkCleanupRange(
-    store: IDBObjectStore,
-    range: IDBKeyRange
-): Promise<readonly StoredResourceEntry[]> {
-    return new Promise((resolve, reject) => {
-        const found: StoredResourceEntry[] = [];
-        const request = store.openCursor(range);
-        request.onerror = () => reject(request.error);
-        request.onsuccess = () => {
-            try {
-                const cursor = request.result;
-                if (!cursor) {
-                    resolve(found);
-                    return;
-                }
-                found.push(decodeStoredResourceEntryValue(cursor.value));
-                cursor.continue();
-            }
-            catch (error) {
-                reject(error);
-            }
-        };
-    });
-}
-
 /**
  * The passes one cleanup may run. Each pass deletes at most one per-reason budget, so a store that
  * has accumulated more expired rows than that needs several; the bound stops a pass that keeps
```

- [ ] **Step 4: The checkpoint's reads and write on the IndexedDB backend** (`indexed-db-admission-backend.ts`):

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/indexed-db-admission-backend.ts
+++ b/packages/shared/alm/indexed-db-admission-backend.ts
@@ -48,12 +48,30 @@ import {
 } from './open-indexed-db-admission-database.ts';
 import { readIndexedDbAdmissionSnapshot } from './read-indexed-db-admission-snapshot.ts';
 import type { ALStorageConnectStoreOpening } from './storage/al-storage-connect-openings.ts';
+import { readALWorkRowsInRanges, type ALWorkKeyRangesInput } from './storage/read-al-work-rows-in-ranges.ts';
 import {
     writeIndexedDbAdmissionMutations,
     type IndexedDbAdmissionMutation
 } from './write-indexed-db-admission-mutations.ts';
 
 export namespace IndexedDbAdmissionBackend {
+    /** Every row one store namespace owns: its admission rows under one key prefix and its work rows in ranges. */
+    export interface NamespaceSelection {
+        readonly keyPrefix: string;
+        readonly workRanges: ALWorkKeyRangesInput;
+    }
+
+    export interface NamespaceRows {
+        readonly rows: readonly IndexedDbAdmissionStoredRow[];
+        readonly workRows: readonly StoredResourceEntry[];
+    }
+
+    /** Row mutations a sole writer applies over whatever the rows hold: no fence, one readwrite. */
+    export interface UnfencedMutations {
+        readonly mutations: readonly IndexedDbAdmissionMutation[];
+        readonly queueMutations: readonly ComputedIndexedDbQueueMutation[];
+    }
+
     export interface Input {
         readonly dbName: string;
         readonly storeName: string;
@@ -229,6 +247,39 @@ export class IndexedDbAdmissionBackend implements ALAdmissionWorkBackend {
         return fenced.result;
     }
 
+    /** One list operation, read as stored: every row with its expiry, the expired ones too. */
+    async readNamespaceRows(
+        selection: IndexedDbAdmissionBackend.NamespaceSelection
+    ): Promise<IndexedDbAdmissionBackend.NamespaceRows> {
+        const decision = this.#observer.observe({ owner: 'al-admission', kind: 'list' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
+        const db = await this.#connection.open();
+        const rows = await readIndexedDbAdmissionSnapshot(
+            db,
+            this.#storeName,
+            { kind: 'prefixes', prefixes: [selection.keyPrefix] }
+        );
+        return { rows, workRows: await readALWorkRowsInRanges(db, selection.workRanges) };
+    }
+
+    /** One write operation: a single readwrite over both stores, which lands every mutation or none. */
+    async writeUnfencedMutations(input: IndexedDbAdmissionBackend.UnfencedMutations): Promise<boolean> {
+        const decision = this.#observer.observe({ owner: 'al-admission', kind: 'write' });
+        if (decision instanceof Promise) {
+            await decision;
+        }
+        const db = await this.#connection.open();
+        return await writeIndexedDbAdmissionMutations({
+            db,
+            storeName: this.#storeName,
+            fence: EMPTY_INDEXED_DB_ADMISSION_FENCE,
+            mutations: input.mutations,
+            queueMutations: input.queueMutations
+        });
+    }
+
     /**
      * One snapshot serves the whole write phase, which records every key and prefix it observed as
      * it goes. The snapshot is closed before the caller creates its readwrite -- a readwrite queues
```

- [ ] **Step 5: The load without marking, and the takeover's marking.** `al-admission-backend.ts`,
      `queuebox/in-memory-queue-box.ts` and `checkpoint/al-checkpoint-dirty-set.ts`:

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/al-admission-backend.ts b/packages/shared/alm/al-admission-backend.ts
index eee1be694..36356efa0 100644
--- a/packages/shared/alm/al-admission-backend.ts
+++ b/packages/shared/alm/al-admission-backend.ts
@@ -91,6 +91,11 @@ export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
         return this.state.data.get(key);
     }
 
+    /** Every key held now, expired or not; unlike `list` it removes nothing. */
+    peekKeys(): readonly string[] {
+        return [...this.state.data.keys()];
+    }
+
     /** The lazy expiry `read` and `list` apply, run over the whole pair; the owning lane calls it. */
     evictExpired(): void {
         const nowMs = this.nowMs();
@@ -185,6 +190,18 @@ export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
         }
     }
 
+    /** Rows a checkpoint saved: a key the pair already holds keeps its own value. */
+    loadIfAbsent(rows: readonly ALAdmissionStoredValue[], entries: readonly ResourceEntry[]): void {
+        for (const row of rows) {
+            if (!this.state.data.has(row.key)) {
+                this.setStored(row.key, row);
+            }
+        }
+        for (const entry of entries) {
+            this.workQueue.writeIfAllObserved([{ expected: undefined, entry }]);
+        }
+    }
+
     private setStored(key: string, stored: ALAdmissionStoredValue): void {
         this.state.data.set(key, stored);
         this.notifyChange(key);
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/queuebox/in-memory-queue-box.ts b/packages/shared/queuebox/in-memory-queue-box.ts
index 21c89ec7a..592593891 100644
--- a/packages/shared/queuebox/in-memory-queue-box.ts
+++ b/packages/shared/queuebox/in-memory-queue-box.ts
@@ -120,6 +120,11 @@ export class InMemoryQueueBox implements QueueBoxResourceEntryRepository {
         return entry === undefined ? undefined : toResourceEntrySnapshot(entry);
     }
 
+    /** Every key held now, expired or not; unlike `getAllKeys` it removes nothing. */
+    peekKeys(): readonly ResourceEntryKeyString[] {
+        return [...this.data.keys()];
+    }
+
     private storeEntry(key: string, entry: ResourceEntry): void {
         this.workIndex.replace(key, this.data.get(key), entry);
         this.data.set(key, entry);
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts b/packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts
index d664582b2..1bf93c23c 100644
--- a/packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts
+++ b/packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts
@@ -20,7 +20,7 @@ export namespace ALCheckpointDirtySet {
 
     export interface Input {
         /** The memory pair whose admission rows and work queue the set follows. */
-        readonly backend: Pick<InMemoryAdmissionBackend, 'onChangeDo' | 'workQueue'>;
+        readonly backend: Pick<InMemoryAdmissionBackend, 'onChangeDo' | 'peekKeys' | 'workQueue'>;
         readonly nowMs: () => number;
     }
 }
@@ -35,14 +35,17 @@ interface ALCheckpointDirtyRow {
  * times is one mark at its latest revision, so a save that captured an older revision leaves it dirty.
  */
 export class ALCheckpointDirtySet {
+    private readonly backend: ALCheckpointDirtySet.Input['backend'];
     private readonly nowMs: () => number;
     private readonly admissionRows = new LatestRepository<string, ALCheckpointDirtyRow>();
     private readonly queueRows = new LatestRepository<string, ALCheckpointDirtyRow>();
     private readonly markedListeners = new Set<() => void>();
     private readonly subscriptions: readonly Unsubscribe[];
     private revision = 0;
+    private loading = false;
 
     constructor(input: ALCheckpointDirtySet.Input) {
+        this.backend = input.backend;
         this.nowMs = input.nowMs;
         this.subscriptions = [
             input.backend.onChangeDo((key) => this.mark(this.admissionRows, key)),
@@ -92,6 +95,27 @@ export class ALCheckpointDirtySet {
         }
     }
 
+    /** Runs a synchronous load of rows the checkpoint already holds: the changes it makes mark nothing. */
+    loadWithoutMarking(load: () => void): void {
+        this.loading = true;
+        try {
+            load();
+        }
+        finally {
+            this.loading = false;
+        }
+    }
+
+    /** Marks every row the pair holds now, so the next save writes all of them. */
+    markHeld(): void {
+        for (const key of this.backend.peekKeys()) {
+            this.mark(this.admissionRows, key);
+        }
+        for (const key of this.backend.workQueue.peekKeys()) {
+            this.mark(this.queueRows, key);
+        }
+    }
+
     dispose(): void {
         for (const subscription of this.subscriptions) {
             subscription.unsubscribe();
@@ -99,6 +123,9 @@ export class ALCheckpointDirtySet {
     }
 
     private mark(rows: LatestRepository<string, ALCheckpointDirtyRow>, key: string): void {
+        if (this.loading) {
+            return;
+        }
         this.revision += 1;
         const dirtiedAtMs = rows.peek(key)?.dirtiedAtMs ?? this.nowMs();
         rows.set(key, { revision: this.revision, dirtiedAtMs });
```

- [ ] **Step 6: The checkpoint** `packages/shared/alm/checkpoint/al-checkpoint.ts` (the dirty set and the writer are
      `ALCheckpointTracking`, built at construction when the runtime owns the work, else by `trackTakenOver()` once the
      takeover's restore settled, which then marks every held row; a disposed checkpoint builds none):

<!-- dprint-ignore -->
```ts
import { Temporal } from '@js-temporal/polyfill';

import type { Unsubscribe } from '../../cache/RepositoryInterfaces.ts';
import { decodeStoredResourceEntry } from '../../queuebox/indexed-db-queue-box-entry-codec.ts';
import { isStoredQueueEntryExpired } from '../../queuebox/indexed-db-queue-box-entry.ts';
import { toError } from '../../resilience/to-error.ts';
import type { InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type { IndexedDbAdmissionBackend } from '../indexed-db-admission-backend.ts';
import { toALAdmissionStoredValue } from '../indexed-db-admission-row.ts';
import type { ALStorageOpening } from '../open-indexed-db-admission-database.ts';
import type { ALStorageHealth } from '../storage/al-storage-health.ts';
import {
    createALStorageRecoveryReporter,
    type ALStorageRecoveryReporter
} from '../storage/al-storage-recovery-reporter.ts';
import { toALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
import type { ALDurableWorkOwnership } from '../work/al-durable-work-ownership.ts';
import { ALCheckpointDirtySet } from './al-checkpoint-dirty-set.ts';
import { ALCheckpointWriter } from './al-checkpoint-writer.ts';
import type { ALCheckpointMutations } from './compute-al-checkpoint-mutations.ts';

/** A memory pair and the IndexedDB rows its checkpoint saves it to, under the pair's own namespace. */
export interface ALCheckpointStorage {
    readonly memory: InMemoryAdmissionBackend;
    readonly saved: IndexedDbAdmissionBackend;
    readonly selection: IndexedDbAdmissionBackend.NamespaceSelection;
    readonly health: ALStorageHealth;
    readonly settings: ALCheckpointWriter.Settings;
    readonly timers: ALCheckpointWriter.Timers;
}

/**
 * What a checkpoint lane and the page lifecycle hold of a memory pair's checkpoint. `restore` and the
 * first-batch report run once; `flush` starts a checkpoint now and is never awaited.
 */
export interface ALCheckpointPort extends ALStorageRecoveryReporter {
    restore(): Promise<void>;
    flush(): void;
    dispose(): void;
    /** Whether this runtime saves the checkpoint, so its admissions outlive the document. */
    isOwned(): boolean;
    /** Restores when ownership turns to this runtime, then calls the listener. */
    onTakenOverDo(listener: () => void): Unsubscribe;
}

export namespace ALCheckpoint {
    export interface Input {
        readonly storage: ALCheckpointStorage;
        readonly ownership: ALDurableWorkOwnership;
        readonly nowMs: () => number;
    }
}

/** What the restore found: the database's opening, and the work rows past their expiry it left out. */
interface ALCheckpointRestore {
    readonly opening: ALStorageOpening | undefined;
    readonly expiredWorkCount: number;
}

/** The unsaved changes of the pair and the writer that saves them, held only while this runtime owns the work. */
interface ALCheckpointTracking {
    readonly dirty: ALCheckpointDirtySet;
    readonly writer: ALCheckpointWriter;
}

/**
 * One memory pair's checkpoint in one runtime of a session. Only the runtime that owns the session's
 * durable work tracks, saves and restores it: the restore loads the saved rows into the pair, keeping
 * every key the pair already holds, before the lane's first work batch or when ownership is taken over.
 * A runtime that owned the work from construction marks none of the restored rows unsaved; one that
 * took it over keeps no unsaved changes while it waited, and marks every row it holds once its restore
 * ran, so its first checkpoint saves the live state.
 */
export class ALCheckpoint implements ALCheckpointPort {
    private readonly input: ALCheckpoint.Input;
    private readonly recovery: ALStorageRecoveryReporter;
    private tracking: ALCheckpointTracking | undefined;
    private restoring: Promise<void> | undefined;
    private restored: ALCheckpointRestore | undefined;
    private disposed = false;

    constructor(input: ALCheckpoint.Input) {
        this.input = input;
        const { storage } = input;
        this.tracking = input.ownership.isOwned() ? this.createTracking() : undefined;
        this.recovery = createALStorageRecoveryReporter({
            getStorageOpening: () => this.restored?.opening,
            getReservationExpiredDeleteCount: () => this.restored?.expiredWorkCount ?? 0,
            storageHealth: storage.health,
            lane: undefined
        });
    }

    isOwned(): boolean {
        return this.input.ownership.isOwned();
    }

    /** Owner only, once: a runtime that does not own the work restores when it takes ownership over. */
    async restore(): Promise<void> {
        if (!this.isOwned()) {
            return;
        }
        this.restoring ??= this.readAndLoad().finally(() => this.trackTakenOver());
        await this.restoring;
    }

    /** Ownership turned to this runtime after construction: the restore runs, then the lane is told it ran. */
    onTakenOverDo(listener: () => void): Unsubscribe {
        return this.input.ownership.owned.onChangeDo(() => {
            this.restore().then(listener, (error) => console.error('AL checkpoint restore failed', toError(error)));
        });
    }

    reportFirstBatch(claimedCount: number): void {
        this.recovery.reportFirstBatch(claimedCount);
    }

    flush(): void {
        this.tracking?.writer.flush();
    }

    dispose(): void {
        this.disposed = true;
        this.tracking?.writer.dispose();
        this.tracking?.dirty.dispose();
    }

    private createTracking(): ALCheckpointTracking {
        const { storage, nowMs } = this.input;
        const dirty = new ALCheckpointDirtySet({ backend: storage.memory, nowMs });
        const writer = new ALCheckpointWriter({
            memory: storage.memory,
            dirty,
            write: (mutations) => this.write(mutations),
            health: storage.health,
            settings: storage.settings,
            nowMs,
            timers: storage.timers
        });
        return { dirty, writer };
    }

    private trackTakenOver(): void {
        if (this.tracking !== undefined || this.disposed) {
            return;
        }
        this.tracking = this.createTracking();
        this.tracking.dirty.markHeld();
    }

    /** A store that cannot be read is stated on its health; the lane runs from what memory holds. */
    private async readAndLoad(): Promise<void> {
        const { saved, selection, health } = this.input.storage;
        try {
            const read = await saved.readNamespaceRows(selection);
            this.restored = { opening: saved.getStorageOpening(), expiredWorkCount: this.load(read) };
        }
        catch (error) {
            const unavailable = toALStorageUnavailable(toError(error));
            if (unavailable === undefined) {
                throw error;
            }
            health.recordFailure(unavailable);
        }
    }

    /** One synchronous turn: the live rows load beside what the pair holds, and the expired work rows are counted. */
    private load(read: IndexedDbAdmissionBackend.NamespaceRows): number {
        const nowMs = this.input.nowMs();
        const now = Temporal.Instant.fromEpochMilliseconds(nowMs);
        const live = read.workRows.filter((row) => !isStoredQueueEntryExpired(row, now));
        const loadLive = () =>
            this.input.storage.memory.loadIfAbsent(
                read.rows.filter((row) => row.expireAtTimestamp > nowMs).map(toALAdmissionStoredValue),
                live.map((row) => decodeStoredResourceEntry(row))
            );
        this.tracking === undefined ? loadLive() : this.tracking.dirty.loadWithoutMarking(loadLive);
        return read.workRows.filter((row) => row.key.topicId === 'AL_OUTBOUND' && !live.includes(row)).length;
    }

    private async write(mutations: ALCheckpointMutations): Promise<void> {
        if (!await this.input.storage.saved.writeUnfencedMutations(mutations)) {
            throw new ALAdmissionBackendConflictError('An AL checkpoint write conflicted');
        }
    }
}
```

- [ ] **Step 7: The checkpoint pair's factory, the memory store's durability and the memory retention rule.**

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/al-runtime-stores.ts
+++ b/packages/shared/alm/al-runtime-stores.ts
@@ -29,6 +29,8 @@ import {
     type ALStorageResetEvent
 } from './open-indexed-db-admission-database.ts';
 
+import type { ALCheckpointWriter } from './checkpoint/al-checkpoint-writer.ts';
+import { ALCheckpoint, type ALCheckpointStorage } from './checkpoint/al-checkpoint.ts';
 import {
     createALOutboundAdmissionStore,
     createVolatileALOutboundAdmissionStore,
@@ -36,17 +38,20 @@ import {
     type CreateALOutboundAdmissionStoreInput
 } from './outbound/admission/al-outbound-admission-store.ts';
 import type {
+    ALCheckpointOutboundRuntimeStores,
     ALOutboundRuntimeStores,
     ALVolatileOutboundRuntimeStores
 } from './outbound/al-outbound-message-runtime.ts';
 import type { ALStorageConnectOpenings } from './storage/al-storage-connect-openings.ts';
-import type { ALStorageHealth } from './storage/al-storage-health.ts';
+import { createPassThroughALStorageEventSink } from './storage/al-storage-event.ts';
+import { ALStorageHealth } from './storage/al-storage-health.ts';
 import {
     createALStorageRecoveryReporter,
     type ALStorageRecoveryLane,
     type ALStorageRecoveryReporter
 } from './storage/al-storage-recovery-reporter.ts';
 import type { ALVolatileSessionBudget } from './volatile-budget/al-volatile-session-budget.ts';
+import type { ALDurableWorkOwnership } from './work/al-durable-work-ownership.ts';
 
 /**
  * Which store pair of a runtime a lane runs over: the IndexedDB pair (`durable`), the session's memory
@@ -279,13 +284,73 @@ export function createVolatileALOutboundRuntimeStores<TPrepared>(
     const input = { ...toDefaultInMemoryInput(options), decodePrepared: options.decodePrepared };
     const backend = createVolatileALAdmissionBackend(input.nowMs);
     return {
-        admissionStore: createVolatileALOutboundAdmissionStore(toInMemoryALOutboundAdmissionStoreInput(input, backend)),
+        admissionStore: createVolatileALOutboundAdmissionStore(
+            toInMemoryALOutboundAdmissionStoreInput(input, backend),
+            'volatile'
+        ),
         workQueue: backend.workQueue,
         evictExpired: () => backend.evictExpired(),
         budget
     };
 }
 
+export interface CreateCheckpointALOutboundRuntimeStoresInput<TPrepared>
+    extends CreateDefaultALOutboundRuntimeStoresInput<TPrepared>, ALCheckpointWriter.Settings {
+    /** The connect's claim: only the runtime that owns the session's durable work saves and restores. */
+    readonly ownership: ALDurableWorkOwnership;
+    readonly timers: ALCheckpointWriter.Timers;
+}
+
+/**
+ * The memory pair a browser carrier routes checkpointed admissions to, and its checkpoint: the rows a
+ * durable pair writes, saved under this pair's own namespace, which is also its canonical scope (two
+ * memory pairs never save one row), in the session's database. Built once per connect, under its claim.
+ */
+export function createCheckpointALOutboundRuntimeStores<TPrepared>(
+    options: CreateCheckpointALOutboundRuntimeStoresInput<TPrepared>
+): ALCheckpointOutboundRuntimeStores<TPrepared> {
+    const defaults = toDefaultInMemoryInput(options);
+    const input = { ...defaults, canonicalScope: defaults.namespace, decodePrepared: options.decodePrepared };
+    const memory = createVolatileALAdmissionBackend(input.nowMs);
+    const admissionStore = createVolatileALOutboundAdmissionStore(
+        toInMemoryALOutboundAdmissionStoreInput(input, memory),
+        'checkpoint'
+    );
+    const checkpoint = new ALCheckpoint({
+        storage: toALCheckpointStorage(options, memory, admissionStore.namespace),
+        ownership: options.ownership,
+        nowMs: input.nowMs
+    });
+    return {
+        admissionStore,
+        workQueue: memory.workQueue,
+        storageRecovery: checkpoint,
+        evictExpired: () => memory.evictExpired(),
+        checkpoint
+    };
+}
+
+function toALCheckpointStorage<TPrepared>(
+    options: CreateCheckpointALOutboundRuntimeStoresInput<TPrepared>,
+    memory: InMemoryAdmissionBackend,
+    workNamespace: string
+): ALCheckpointStorage {
+    const indexedDb = toDefaultIndexedDbInput(options);
+    const { namespace } = indexedDb;
+    return {
+        memory,
+        saved: createIndexedDbAdmissionBackend(indexedDb, `${namespace}:checkpoint`, indexedDb.onStorageReset),
+        selection: {
+            keyPrefix: `${namespace}:`,
+            workRanges: { namespacePrefixes: [workNamespace], canonicalScopes: [namespace] }
+        },
+        health: options.storageHealth ??
+            new ALStorageHealth({ storeId: namespace, storage: createPassThroughALStorageEventSink() }),
+        settings: { intervalMs: options.intervalMs, lagBoundMs: options.lagBoundMs },
+        timers: options.timers
+    };
+}
+
 /** The session's inbound memory pair, shared by both carriers' volatile lanes; it persists nothing. */
 export function createVolatileALInboundRuntimeStores(
     options: CreateDefaultALRuntimeStoresInput,
@@ -354,10 +419,6 @@ export function createDefaultIndexedDbALOutboundRuntimeStores<TPrepared>(
     });
 }
 
-export function isIndexedDbALRuntimeStoreSupported(): boolean {
-    return IndexedDbStringPersistenceProvider.isSupported();
-}
-
 function toDefaultInMemoryInput(
     options: CreateDefaultALRuntimeStoresInput
 ): CreateInMemoryALRuntimeStoresInput {
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
+++ b/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
@@ -368,10 +368,12 @@ export function createALOutboundAdmissionStore<TPrepared>(
     return new ProviderBackedALOutboundAdmissionStore({ ...input, durability: 'durable' });
 }
 
+/** A memory pair's store: the volatile lane's, or the checkpoint lane's, whose rows a checkpoint saves. */
 export function createVolatileALOutboundAdmissionStore<TPrepared>(
-    input: CreateALOutboundAdmissionStoreInput<TPrepared>
+    input: CreateALOutboundAdmissionStoreInput<TPrepared>,
+    durability: Exclude<ALStoreDurability, 'durable'>
 ): ALOutboundAdmissionStore<TPrepared> {
-    return new ProviderBackedALOutboundAdmissionStore({ ...input, durability: 'volatile' });
+    return new ProviderBackedALOutboundAdmissionStore({ ...input, durability });
 }
 
 interface ALOutboundPairAdmissionStoreInput<TPrepared> extends CreateALOutboundAdmissionStoreInput<TPrepared> {
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/outbound/admission/al-outbound-admission-mutations.ts
+++ b/packages/shared/alm/outbound/admission/al-outbound-admission-mutations.ts
@@ -323,15 +323,18 @@ export class ALOutboundAdmissionMutations {
     }
 
     /**
-     * A durable pair answers a late control for the row's TTL past the send; the volatile pair only until the message
-     * deadline plus the receipt grace (D74). An admission always names the deadline, so only a bare store write
-     * reaches the volatile branch without one, and keeps just the grace.
+     * A durable pair answers a late control for the row's TTL past the send; a memory pair, volatile or
+     * checkpointed, only until the message deadline plus the receipt grace (D74). An admission always names
+     * the deadline, so only a bare store write reaches the memory branch without one, and keeps just the grace.
      */
     private computeMessageRowExpiryMs(deadlineAtMs: number | undefined, nowMs: number, rowTtlMs: number): number {
-        if (this.durability === 'volatile') {
-            return computeALReceiptRetentionExpiryMs(deadlineAtMs ?? nowMs);
+        switch (this.durability) {
+            case 'volatile':
+            case 'checkpoint':
+                return computeALReceiptRetentionExpiryMs(deadlineAtMs ?? nowMs);
+            case 'durable':
+                return Math.max(deadlineAtMs ?? 0, nowMs + rowTtlMs, nowMs + this.retention.controlHistoryTtlMs);
         }
-        return Math.max(deadlineAtMs ?? 0, nowMs + rowTtlMs, nowMs + this.retention.controlHistoryTtlMs);
     }
 
     private computeSupersedenceWrite(
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/delivery/compute-al-volatile-control-row-expiry-ms.ts
+++ b/packages/shared/alm/delivery/compute-al-volatile-control-row-expiry-ms.ts
@@ -1,13 +1,19 @@
 import type { ALStoreDurability } from '../al-runtime-stores.ts';
 import { computeALReceiptRetentionExpiryMs } from './compute-al-receipt-retention-expiry-ms.ts';
 
+/** A memory pair's control rows, volatile or checkpointed, stop at the message deadline plus the receipt grace. */
 export function computeALVolatileControlRowExpiryMs(
     expireAtTimestamp: number,
     durability: ALStoreDurability,
     deadlineAtMs: number | undefined
 ): number {
-    if (durability !== 'volatile' || deadlineAtMs === undefined) {
-        return expireAtTimestamp;
+    switch (durability) {
+        case 'volatile':
+        case 'checkpoint':
+            return deadlineAtMs === undefined
+                ? expireAtTimestamp
+                : Math.min(expireAtTimestamp, computeALReceiptRetentionExpiryMs(deadlineAtMs));
+        case 'durable':
+            return expireAtTimestamp;
     }
-    return Math.min(expireAtTimestamp, computeALReceiptRetentionExpiryMs(deadlineAtMs));
 }
```

- [ ] **Step 8: The third lane.** `al-outbound-message-runtime.ts`, the default resource factory, and the lane:

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/outbound/al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
@@ -12,6 +12,7 @@ import type { ResourceInboxResilience } from '../../queuebox/resource-inbox/reso
 import type { Key, ResourceEntry } from '../../queuebox/ResourceEntry.ts';
 import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
 import type { ALStoreDurability } from '../al-runtime-stores.ts';
+import type { ALCheckpointPort } from '../checkpoint/al-checkpoint.ts';
 import type {
     ALDeliveryAdmissionVerdict,
     ALDeliveryCarrier,
@@ -195,6 +196,12 @@ export interface ALVolatileOutboundRuntimeStores<TPrepared> extends ALOutboundRu
     readonly budget: ALVolatileSessionBudget | undefined;
 }
 
+/** The memory pair a checkpointed admission goes to: its lane sweeps it, and its checkpoint saves it. */
+export interface ALCheckpointOutboundRuntimeStores<TPrepared> extends ALOutboundRuntimeStores<TPrepared> {
+    evictExpired(): void;
+    readonly checkpoint: ALCheckpointPort;
+}
+
 /** The call path that asked for a commit, so its wait and its hold are charged to the work behind it. */
 export type ALOutboundCommitOrigin = 'send' | 'drain' | 'repair';
 
@@ -345,13 +352,15 @@ export namespace ALOutboundMessageRuntime {
         readonly storageRecovery: ALStorageRecoveryReporter | undefined;
         /** The memory pair a volatile admission goes to; `undefined` keeps one backend for every admission. */
         readonly volatileStores: ALVolatileOutboundRuntimeStores<TPrepared> | undefined;
+        /** The memory pair a checkpointed admission goes to; `undefined` sends it to the volatile pair. */
+        readonly checkpointStores: ALCheckpointOutboundRuntimeStores<TPrepared> | undefined;
         readonly effectWorkerId: string;
         readonly clock: Clock;
         readonly random: () => number;
         readonly queueEngine: InboxOutboxEngine;
         readonly ownsQueueEngine: boolean;
         readonly browserLocks: ALBrowserLocks | undefined;
-        /** Which runtime of the session drains the durable pair; only the durable lane takes it. */
+        /** Which runtime of the session drains the durable pair; only the durable lane's work follows it. */
         readonly durableWorkOwnership: ALDurableWorkOwnership;
     }
 
@@ -401,18 +410,22 @@ export namespace ALOutboundMessageRuntime {
  *
  * - An admission (`enqueueIfAbsent`, each member of `enqueueAllIfAbsent`) goes to the lane its plan's
  *   `lane` names: the durability decision (`resolveALOutboundStoreDurability`) on every browser planner.
- *   Until the runtime holds a checkpoint lane, a `checkpoint` plan goes to the durable lane. The plan
- *   is computed once and handed to that lane's admission of the same message, so the admission never
- *   plans the message twice. The lane over the memory pair states no admission durable.
+ *   A runtime without a checkpoint pair sends a `checkpoint` plan to its volatile lane, and one without
+ *   either to its only lane, the durable one (the server's planner never names `checkpoint`). The plan is
+ *   computed once and handed to that lane's admission of the same message, so the admission never plans
+ *   the message twice. The volatile lane states no admission durable; the
+ *   checkpoint lane states one durable only in the runtime that owns the session's work, which saves it.
  * - Members with different durability plans stay in one logical enqueue group but route to separate store lanes.
  *   Each lane may commit its members together or individually; there is no cross-store atomicity.
- * - A control, a receipt and a retransmission go to the volatile lane when it owns the target
- *   message (a memory read), else to the durable lane.
+ * - A control, a receipt and a retransmission go to the memory lane that owns the target message (a
+ *   memory read), else to the durable lane.
  * - `cancel(msgId)` and `handOver(msgId)` are runtime-wide: one set of send controls serves both lanes.
  * - Only the durable lane admits foreign dequeue rows. The volatile lane names none and takes no
  *   browser lock, since Web Locks guard cross-tab IndexedDB commits and memory is per tab.
- * - The volatile lane's worker id is `${effectWorkerId}/volatile`. It sweeps its expired rows from its
- *   own work round, at most once per `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS` of its clock.
+ * - The volatile lane's worker id is `${effectWorkerId}/volatile`, the checkpoint lane's
+ *   `${effectWorkerId}/checkpoint`. Each sweeps its expired rows from its own work round, at most once per
+ *   `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS` of its clock. Every runtime of the session runs its
+ *   checkpoint lane's work from its own memory.
  * - An ordering or supersedence track whose messages declare different durabilities is split between
  *   the lanes; no caller declares one that way.
  * - Duplicate detection is per lane: a msgId the memory lane admitted is invisible to the IndexedDB lane,
@@ -426,6 +439,7 @@ export class ALOutboundMessageRuntime<TPrepared> {
     private readonly sendControls = new ALOutboundSendControls();
     private readonly durable: ALOutboundStoreLane<TPrepared>;
     private readonly volatile: ALOutboundStoreLane<TPrepared> | undefined;
+    private readonly checkpoint: ALOutboundStoreLane<TPrepared> | undefined;
     private disposed = false;
     private readonly dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>;
 
@@ -439,6 +453,7 @@ export class ALOutboundMessageRuntime<TPrepared> {
             browserLocks: dependencies.browserLocks,
             durableWorkOwnership: dependencies.durableWorkOwnership,
             evictExpired: undefined,
+            checkpoint: undefined,
             canonicalHandoff: new ALOutboundCanonicalHandoff({
                 namespace: dependencies.admissionStore.namespace,
                 limit: AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT
@@ -455,16 +470,23 @@ export class ALOutboundMessageRuntime<TPrepared> {
             browserLocks: undefined,
             durableWorkOwnership: undefined,
             evictExpired: dependencies.volatileStores.evictExpired,
+            checkpoint: undefined,
             canonicalHandoff: undefined,
             runtime: dependencies,
             sendControls: this.sendControls,
             settlements: (fact) => this.emitSettlement(fact, 'volatile')
         });
+        this.checkpoint = dependencies.checkpointStores === undefined
+            ? undefined
+            : this.createCheckpointLane(dependencies.checkpointStores);
     }
 
-    /** What the storage of the durable lane answered; the memory pair of the volatile lane is always ready. */
+    /**
+     * What the storage of the durable lane answered. The memory pairs are always ready; the checkpoint
+     * lane's readiness is its restore, which states a failure of its own on the checkpoint store's health.
+     */
     async ready(): Promise<ALStorageReadiness.Outcome> {
-        const [durable] = await Promise.all([this.durable.ready(), this.volatile?.ready()]);
+        const [durable] = await Promise.all([this.durable.ready(), this.volatile?.ready(), this.checkpoint?.ready()]);
         return durable;
     }
 
@@ -472,9 +494,15 @@ export class ALOutboundMessageRuntime<TPrepared> {
         this.disposed = true;
         this.durable.dispose();
         this.volatile?.dispose();
+        this.checkpoint?.dispose();
         this.sendControls.dispose();
     }
 
+    /** Starts the checkpoint now, as a hidden or frozen page may run nothing later; never awaited. */
+    flushCheckpoint(): void {
+        this.checkpoint?.flushCheckpoint();
+    }
+
     get sendSignal(): AbortSignal {
         return this.sendControls.signal;
     }
@@ -624,14 +652,48 @@ export class ALOutboundMessageRuntime<TPrepared> {
         return { lane, planner: toPlannedOnce(msg, bounded, planOutgoingMessage) };
     }
 
-    /** The memory lane for a volatile plan; every other plan, and every plan of a one-backend runtime, is durable. */
+    /**
+     * The lane a plan names. A checkpointed plan without a checkpoint pair stays in memory; a runtime with
+     * one backend sends every plan to it.
+     */
     private resolveLaneForPlan(plan: ALOutboundDispatchPlan<TPrepared>): ALOutboundStoreLane<TPrepared> {
-        return plan.lane === 'volatile' && this.volatile !== undefined ? this.volatile : this.durable;
+        switch (plan.lane) {
+            case 'volatile':
+                return this.volatile ?? this.durable;
+            case 'checkpoint':
+                return this.checkpoint ?? this.volatile ?? this.durable;
+            case 'durable':
+                return this.durable;
+        }
     }
 
-    /** A memory read, so a control about a volatile message never reaches IndexedDB. */
+    /** Memory reads, so a control about a message in memory never reaches IndexedDB. */
     private async readLaneForMessage(msgId: string): Promise<ALOutboundStoreLane<TPrepared>> {
-        return this.volatile !== undefined && await this.volatile.ownsMessage(msgId) ? this.volatile : this.durable;
+        for (const lane of [this.volatile, this.checkpoint]) {
+            if (lane !== undefined && await lane.ownsMessage(msgId)) {
+                return lane;
+            }
+        }
+        return this.durable;
+    }
+
+    /** Admits from memory in every runtime of the session; the pair's checkpoint was built under the connect's claim. */
+    private createCheckpointLane(stores: ALCheckpointOutboundRuntimeStores<TPrepared>): ALOutboundStoreLane<TPrepared> {
+        const { dependencies } = this;
+        return new ALOutboundStoreLane({
+            lane: 'checkpoint',
+            stores,
+            workerId: `${dependencies.effectWorkerId}/checkpoint`,
+            dequeueTypes: new Set<string>(),
+            browserLocks: undefined,
+            durableWorkOwnership: undefined,
+            evictExpired: stores.evictExpired,
+            checkpoint: stores.checkpoint,
+            canonicalHandoff: undefined,
+            runtime: dependencies,
+            sendControls: this.sendControls,
+            settlements: (fact) => this.emitSettlement(fact, 'checkpoint')
+        });
     }
 
     /** An undecodable control goes to the durable lane, which answers it `not-handled`. */
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
@@ -11,6 +11,7 @@ import { ALWAYS_OWNED_AL_DURABLE_WORK, type ALDurableWorkOwnership } from '../wo
 import type { ALOutboundPreparedMessageDecoder } from './admission/al-outbound-admission-store.ts';
 import {
     ALOutboundMessageRuntime,
+    type ALCheckpointOutboundRuntimeStores,
     type ALOutboundRuntimeStores,
     type ALVolatileOutboundRuntimeStores
 } from './al-outbound-message-runtime.ts';
@@ -40,6 +41,8 @@ export interface DefaultALOutboundRuntimeResourceInput<TPrepared> {
     readonly stores?: ALOutboundRuntimeStores<TPrepared>;
     /** The memory pair a browser carrier routes volatile admissions to; a server keeps one backend. */
     readonly volatileStores?: ALVolatileOutboundRuntimeStores<TPrepared>;
+    /** The memory pair a browser carrier routes checkpointed admissions to; absent, they go to `stores`. */
+    readonly checkpointStores?: ALCheckpointOutboundRuntimeStores<TPrepared>;
     readonly canonicalQueue?: QueueBoxResourceEntryRepository;
     readonly nowMs?: () => number;
     readonly random?: () => number;
@@ -120,6 +123,7 @@ export function createDefaultALOutboundRuntimeResources<TPrepared>(
         storageHealth: stores.storageHealth,
         storageRecovery: stores.storageRecovery,
         volatileStores: input.volatileStores,
+        checkpointStores: input.checkpointStores,
         effectWorkerId: `al-outbound:${crypto.randomUUID()}`,
         clock: { nowMs },
         random: input.random ?? Math.random,
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
+++ b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
@@ -1,9 +1,11 @@
 import type { ALMessage } from '../../../al-contracts/al-contract.ts';
+import type { Unsubscribe } from '../../../cache/RepositoryInterfaces.ts';
 import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
 import { isNotReadyException } from '../../../queuebox/resource-inbox/not-ready-exception.ts';
-import { toKeyAsString, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
+import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
 import type { ALStoreDurability } from '../../al-runtime-stores.ts';
 import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '../../ALStoreRetention.ts';
+import type { ALCheckpointPort } from '../../checkpoint/al-checkpoint.ts';
 import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
 import type { ALBrowserLocks } from '../../storage/al-browser-locks.ts';
 import { ALStorageReadiness } from '../../storage/al-storage-readiness.ts';
@@ -44,7 +46,6 @@ import {
     AL_OUTBOUND_WORK_PAGE_SIZE,
     readALOutboundWorkReadyAt,
     toALOutboundDequeueWork,
-    toALOutboundWorkKey,
     toALOutboundWorkType,
     type ALOutboundDequeueDeferral,
     type ALOutboundWorkDeferral
@@ -55,6 +56,7 @@ import type { ALOutboundControlAdmissionResult } from '../control/al-outbound-co
 import { ALOutboundReceiptAdmission } from '../control/al-outbound-receipt-admission.ts';
 import type { ALOutboundCanonicalHandoff } from './al-outbound-canonical-handoff.ts';
 import type { ALOutboundSendControls } from './al-outbound-send-controls.ts';
+import { computeALOutboundCommittedRows, hasWrittenWork } from './compute-al-outbound-committed-rows.ts';
 
 export namespace ALOutboundStoreLane {
     export interface Input<TPrepared> {
@@ -69,6 +71,8 @@ export namespace ALOutboundStoreLane {
         readonly durableWorkOwnership: ALDurableWorkOwnership | undefined;
         /** The memory pair's sweep; undefined for a lane over a durable pair. */
         readonly evictExpired: (() => void) | undefined;
+        /** What saves and restores the checkpoint lane's memory pair; undefined for every other lane. */
+        readonly checkpoint: ALCheckpointPort | undefined;
         /** What this lane's commits hand its own claims; the memory pair's lane reads memory and has none. */
         readonly canonicalHandoff: ALOutboundCanonicalHandoff | undefined;
         readonly runtime: ALOutboundMessageRuntime.Dependencies<TPrepared>;
@@ -79,8 +83,9 @@ export namespace ALOutboundStoreLane {
 
 /**
  * One store pair of an outbound owner and the work that runs over it: admission, controls, receipts and
- * the owner's engine task. A lane over the memory pair persists nothing, so no admission it states is
- * durable, and it sweeps its own expired rows on its work round.
+ * the owner's engine task. A lane over a memory pair sweeps its own expired rows on its work round. The
+ * volatile lane persists nothing, so no admission it states is durable; the checkpoint lane's admission
+ * is durable only in the runtime that saves its checkpoint.
  */
 export class ALOutboundStoreLane<TPrepared> {
     private readonly input: ALOutboundStoreLane.Input<TPrepared>;
@@ -95,6 +100,7 @@ export class ALOutboundStoreLane<TPrepared> {
     private readonly effects: ALOutboundMessageEffects<TPrepared>;
     private readonly removeStorageResetListener: (() => void) | undefined;
     private readonly removeForeignCommitListener: (() => void) | undefined;
+    private readonly takeOverSubscription: Unsubscribe | undefined;
     private nextEvictionAtMs = Number.NEGATIVE_INFINITY;
     private disposed = false;
 
@@ -116,10 +122,13 @@ export class ALOutboundStoreLane<TPrepared> {
             (rows) => this.applyForeignCommit(rows)
         );
         this.readiness = new ALStorageReadiness({
-            openStores: () => stores.admissionStore.ready(),
+            openStores: () => this.openStores(),
             startWork: () => this.work.ready(),
             storageHealth: stores.storageHealth
         });
+        this.takeOverSubscription = input.checkpoint?.onTakenOverDo(
+            () => this.work.committed(AL_WORK_UNDESCRIBED_COMMIT)
+        );
         this.effects = new ALOutboundMessageEffects({
             runtime,
             admissionStore: stores.admissionStore,
@@ -144,9 +153,21 @@ export class ALOutboundStoreLane<TPrepared> {
         this.dispatchAdmission.dispose();
         this.removeStorageResetListener?.();
         this.removeForeignCommitListener?.();
+        this.takeOverSubscription?.unsubscribe();
+        this.input.checkpoint?.dispose();
         this.input.canonicalHandoff?.clear();
     }
 
+    flushCheckpoint(): void {
+        this.input.checkpoint?.flush();
+    }
+
+    /** The checkpoint's restore runs before the lane's first work batch, which then claims what it loaded. */
+    private async openStores(): Promise<void> {
+        await this.input.stores.admissionStore.ready();
+        await this.input.checkpoint?.restore();
+    }
+
     /** Rows another runtime of the session committed to this lane's work type, for this owner to run. */
     applyForeignCommit(rows: ALWorkCommittedRows): void {
         this.work.committed(rows);
@@ -250,10 +271,10 @@ export class ALOutboundStoreLane<TPrepared> {
         return fact.kind === 'admission' ? { ...fact, verdict: this.toStoreVerdict(fact.verdict) } : fact;
     }
 
+    /** Only the durable lane's admission, and the checkpoint lane's where this runtime saves it, is durable. */
     private toStoreVerdict(verdict: ALDeliveryAdmissionVerdict): ALDeliveryAdmissionVerdict {
-        return verdict.kind === 'admitted' && this.input.lane === 'volatile'
-            ? { ...verdict, durable: false }
-            : verdict;
+        const durable = this.input.checkpoint?.isOwned() ?? this.input.lane === 'durable';
+        return verdict.kind === 'admitted' && !durable ? { ...verdict, durable: false } : verdict;
     }
 
     /** The outbound owner reserves straight from the queue, so it reads no page and observes no row's wait. */
@@ -600,37 +621,6 @@ function createALOutboundLaneRepairAdmission<TPrepared>(
     });
 }
 
-function hasWrittenWork<TPrepared>(result: ALOutboundDispatchAdmission.Result<TPrepared>): boolean {
-    return result.committed || result.computed.verdict.kind === 'pending';
-}
-
-/**
- * The work rows these commits wrote, as their batch must account for them, or an undescribed commit
- * when one of them wrote work its result does not describe. A receipted send's acknowledgement
- * timeout is due after its send, so the batch that sends it cannot have claimed it.
- */
-function computeALOutboundCommittedRows<TPrepared>(
-    namespace: string,
-    results: readonly ALOutboundDispatchAdmission.Result<TPrepared>[]
-): ALWorkCommittedRows {
-    let dueByMs = 0;
-    const writtenKeys: string[] = [];
-    for (const result of results.filter(hasWrittenWork)) {
-        const effects = result.committed ? result.computed.bundle?.durableEffects : undefined;
-        if (effects === undefined) {
-            return AL_WORK_UNDESCRIBED_COMMIT;
-        }
-        for (const { effectId, retryAtMs } of effects) {
-            if (retryAtMs === undefined) {
-                return AL_WORK_UNDESCRIBED_COMMIT;
-            }
-            dueByMs = Math.max(dueByMs, retryAtMs);
-            writtenKeys.push(toKeyAsString(toALOutboundWorkKey(namespace, effectId)));
-        }
-    }
-    return { dueByMs, writtenKeys };
-}
-
 /**
  * The effect kinds whose claim may commit work rows without the lane's own commit, which announces
  * what it writes: a timeout attempt writes the next timeout and a repair hint, a repair or retry
```

Create `packages/shared/alm/outbound/lane/compute-al-outbound-committed-rows.ts` (moved from the lane unchanged, exported):

<!-- dprint-ignore -->
```ts
import { toKeyAsString } from '../../../queuebox/ResourceEntry.ts';
import { AL_WORK_UNDESCRIBED_COMMIT, type ALWorkCommittedRows } from '../../work/al-work-readiness-memory.ts';
import type { ALOutboundDispatchAdmission } from '../al-outbound-dispatch-admission.ts';
import { toALOutboundWorkKey } from '../al-outbound-work-entry.ts';

/** A commit that landed, or a pending admission that wrote its replay work, wrote rows its owner must run. */
export function hasWrittenWork<TPrepared>(result: ALOutboundDispatchAdmission.Result<TPrepared>): boolean {
    return result.committed || result.computed.verdict.kind === 'pending';
}

/**
 * The work rows these commits wrote, as their batch must account for them, or an undescribed commit
 * when one of them wrote work its result does not describe. A receipted send's acknowledgement
 * timeout is due after its send, so the batch that sends it cannot have claimed it.
 */
export function computeALOutboundCommittedRows<TPrepared>(
    namespace: string,
    results: readonly ALOutboundDispatchAdmission.Result<TPrepared>[]
): ALWorkCommittedRows {
    let dueByMs = 0;
    const writtenKeys: string[] = [];
    for (const result of results.filter(hasWrittenWork)) {
        const effects = result.committed ? result.computed.bundle?.durableEffects : undefined;
        if (effects === undefined) {
            return AL_WORK_UNDESCRIBED_COMMIT;
        }
        for (const { effectId, retryAtMs } of effects) {
            if (retryAtMs === undefined) {
                return AL_WORK_UNDESCRIBED_COMMIT;
            }
            dueByMs = Math.max(dueByMs, retryAtMs);
            writtenKeys.push(toKeyAsString(toALOutboundWorkKey(namespace, effectId)));
        }
    }
    return { dueByMs, writtenKeys };
}
```

- [ ] **Step 9: The browser's checkpoint store ids, the purge and the relay.** Create
      `packages/shared-web/browser/al-runtime/browser-al-checkpoint-store-ids.ts`:

<!-- dprint-ignore -->
```ts
import { toALRuntimeStoreId, type ALRuntimeStoreId } from '@shared/alm/ALRuntimeStoreRegistry.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';

/**
 * The checkpoint lanes' own store ids: their rows never share a key prefix, a work namespace or a canonical
 * scope with the durable lanes', so the durable lane's bootstrap, recovery and waits never read them.
 */
export function toBrowserWsClientALCheckpointRuntimeStoreId(
    sessionId: string
): ALRuntimeStoreId<ALOutboundTransportMessage> {
    return toALRuntimeStoreId(`browser-ws-client-checkpoint:${sessionId}`);
}

export function toBrowserRtcOverlayALCheckpointRuntimeStoreId(
    sessionId: string
): ALRuntimeStoreId<ALOutboundTransportMessage> {
    return toALRuntimeStoreId(`browser-rtc-overlay-checkpoint:${sessionId}`);
}
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts
@@ -6,6 +6,11 @@ import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outboun
 import type { StateScope } from '@shared/api/state-types.ts';
 import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
 
+import {
+    toBrowserRtcOverlayALCheckpointRuntimeStoreId,
+    toBrowserWsClientALCheckpointRuntimeStoreId
+} from './browser-al-checkpoint-store-ids.ts';
+
 export const BROWSER_AL_RUNTIME_DB_NAME_PREFIX = 'rallar-al-runtime:';
 export const BROWSER_AL_RUNTIME_STORE_NAME = IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
 export const BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX = 'browser:';
@@ -43,11 +48,7 @@ export function toBrowserALRuntimeEntryKeyPrefix(name: string): string {
 export function toBrowserSessionALRuntimeStoreIds(
     sessionId: string
 ): readonly ALRuntimeStoreId<ALOutboundTransportMessage>[] {
-    return [
-        toBrowserSessionALInboundRuntimeStoreId(sessionId),
-        toBrowserWsClientALRuntimeStoreId(sessionId),
-        toBrowserRtcOverlayALRuntimeStoreId(sessionId)
-    ];
+    return [toBrowserSessionALInboundRuntimeStoreId(sessionId), ...toBrowserSessionALOutboundStoreIds(sessionId)];
 }
 
 export function toBrowserSessionALRuntimeEntryKeyPrefixes(
@@ -61,13 +62,26 @@ function toBrowserALRuntimeNamespace(name: string): string {
     return `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${name}`;
 }
 
-/** Every AL_INBOUND/AL_OUTBOUND work namespace one browser session owns: one inbound, two outbound. */
+/** Every AL_INBOUND/AL_OUTBOUND work namespace one browser session owns: one inbound, four outbound. */
 export function toBrowserSessionALRuntimeWorkNamespaces(
     sessionId: string
 ): readonly string[] {
     return [
         `${toBrowserALRuntimeNamespace(toBrowserSessionALInboundRuntimeStoreId(sessionId))}:inbound:admission`,
-        `${toBrowserALRuntimeNamespace(toBrowserWsClientALRuntimeStoreId(sessionId))}:outbound:admission`,
-        `${toBrowserALRuntimeNamespace(toBrowserRtcOverlayALRuntimeStoreId(sessionId))}:outbound:admission`
+        ...toBrowserSessionALOutboundStoreIds(sessionId).map((storeId) =>
+            `${toBrowserALRuntimeNamespace(storeId)}:outbound:admission`
+        )
+    ];
+}
+
+/** Both carriers' durable and checkpoint stores. */
+function toBrowserSessionALOutboundStoreIds(
+    sessionId: string
+): readonly ALRuntimeStoreId<ALOutboundTransportMessage>[] {
+    return [
+        toBrowserWsClientALRuntimeStoreId(sessionId),
+        toBrowserRtcOverlayALRuntimeStoreId(sessionId),
+        toBrowserWsClientALCheckpointRuntimeStoreId(sessionId),
+        toBrowserRtcOverlayALCheckpointRuntimeStoreId(sessionId)
     ];
 }
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts
@@ -1,4 +1,3 @@
-import { isIndexedDbALRuntimeStoreSupported } from '@shared/alm/al-runtime-stores.ts';
 import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
 import { EMPTY_INDEXED_DB_ADMISSION_FENCE } from '@shared/alm/indexed-db-admission-fence.ts';
 import {
@@ -7,11 +6,13 @@ import {
 } from '@shared/alm/open-indexed-db-admission-database.ts';
 import { readIndexedDbAdmissionSnapshot } from '@shared/alm/read-indexed-db-admission-snapshot.ts';
 import { toALStorageResetSink, type ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
+import { readALWorkRowsInRanges } from '@shared/alm/storage/read-al-work-rows-in-ranges.ts';
 import {
     writeIndexedDbAdmissionMutations,
     type IndexedDbAdmissionMutation
 } from '@shared/alm/write-indexed-db-admission-mutations.ts';
 import type { StateScope } from '@shared/api/state-types.ts';
+import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
 import type { StoredResourceEntry } from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
 import type { ComputedIndexedDbQueueMutation } from '@shared/queuebox/indexed-db-queue-box-entry.ts';
 import { jsonEquals } from '@shared/repository/state-utils.ts';
@@ -19,10 +20,13 @@ import { toError } from '@shared/resilience/to-error.ts';
 import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
 import {
     computeBrowserALWorkCleanupMutations,
-    readBrowserALWorkCleanupRows,
     writeBrowserALWorkExpiryCleanup
 } from './browser-al-work-cleanup.ts';
 
+import {
+    toBrowserRtcOverlayALCheckpointRuntimeStoreId,
+    toBrowserWsClientALCheckpointRuntimeStoreId
+} from './browser-al-checkpoint-store-ids.ts';
 import {
     BROWSER_AL_RUNTIME_DB_NAME_PREFIX,
     BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX,
@@ -135,12 +139,24 @@ export async function deleteBrowserALRuntimeEntriesForSession(
     return await deleteBrowserALRuntimeEntriesInEveryDatabase(options.currentScope, {
         keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId),
         workNamespaces: toBrowserSessionALRuntimeWorkNamespaces(sessionId),
-        canonicalScopes: [`browser-session:${sessionId}`],
+        canonicalScopes: toBrowserSessionALCanonicalScopes(sessionId),
         deletionPolicy: { kind: 'all' },
         storage: options.storage
     });
 }
 
+/**
+ * The durable pairs share the session's canonical scope; each checkpoint pair keeps its namespace as its
+ * own, as two memory pairs never save one row.
+ */
+function toBrowserSessionALCanonicalScopes(sessionId: string): readonly string[] {
+    return [
+        `browser-session:${sessionId}`,
+        `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${toBrowserWsClientALCheckpointRuntimeStoreId(sessionId)}`,
+        `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${toBrowserRtcOverlayALCheckpointRuntimeStoreId(sessionId)}`
+    ];
+}
+
 export async function evictExpiredBrowserALRuntimeEntries(
     options: DeleteExpiredBrowserALRuntimeEntriesOptions
 ): Promise<BrowserALRuntimeCleanupResult> {
@@ -232,7 +248,7 @@ async function deleteBrowserALRuntimeEntriesInEveryDatabase(
     deletion: BrowserALRuntimeEntriesDeletion
 ): Promise<BrowserALRuntimeCleanupResult> {
     const keyPrefixes = [...new Set(deletion.keyPrefixes)].filter((prefix) => prefix.length > 0);
-    if (keyPrefixes.length === 0 || !isIndexedDbALRuntimeStoreSupported()) {
+    if (keyPrefixes.length === 0 || !IndexedDbStringPersistenceProvider.isSupported()) {
         return toBrowserALRuntimeCleanupResult([], keyPrefixes, []);
     }
     const dbNames = await readBrowserALRuntimeDbNames(currentScope);
@@ -302,7 +318,7 @@ async function readBrowserALRuntimeCleanup(
     return {
         // The 'expired' policy hands AL work rows to writeBrowserALWorkExpiryCleanup instead.
         workRows: policy.kind === 'all'
-            ? await readBrowserALWorkCleanupRows(db, { namespacePrefixes: workNamespaces, canonicalScopes })
+            ? await readALWorkRowsInRanges(db, { namespacePrefixes: workNamespaces, canonicalScopes })
             : [],
         rows: rows
             .filter((stored) => matchesAnyBrowserALRuntimePrefix(stored.key, keyPrefixes))
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
@@ -4,8 +4,7 @@ import {
     createDefaultIndexedDbALInboundRuntimeStores,
     createDefaultIndexedDbALOutboundRuntimeStores,
     createVolatileALInboundRuntimeStores,
-    createVolatileALOutboundRuntimeStores,
-    isIndexedDbALRuntimeStoreSupported
+    createVolatileALOutboundRuntimeStores
 } from '@shared/alm/al-runtime-stores.ts';
 import {
     configureALRuntimeStoreScopes,
@@ -31,6 +30,7 @@ import { toALStorageResetSink, type ALStorageEventSink } from '@shared/alm/stora
 import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
 import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
 import type { StateScope } from '@shared/api/state-types.ts';
+import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
 
 import {
     toBrowserALRuntimeDbName,
@@ -180,7 +180,7 @@ export function configureBrowserALRuntimeStores(
     };
     configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped, diagnosticsPorts.storage));
     return new BrowserALStorageAvailability({
-        initial: toInitialALStorageAvailability(isIndexedDbALRuntimeStoreSupported()),
+        initial: toInitialALStorageAvailability(IndexedDbStringPersistenceProvider.isSupported()),
         requestPersist: toBrowserStoragePersistRequest(globalThis.navigator?.storage),
         storage: diagnosticsPorts.storage
     });
```

<!-- dprint-ignore -->
```diff
--- a/packages/shared-web/browser/connection/browser-delivery-settlements.ts
+++ b/packages/shared-web/browser/connection/browser-delivery-settlements.ts
@@ -31,9 +31,9 @@ export class BrowserDeliverySettlements {
     /**
      * Another tab of the session may hold the handle of a durable message this tab's carriers settle: the
      * owner tab dispatches every tab's durable sends, and any tab may admit the control that acknowledges
-     * one. A durable lane's settlement this tab holds no handle for is relayed once; the receiving tab
-     * records it through its own observers, never through an epoch, so it is not relayed again. A volatile
-     * lane's settlement stays in the tab that admitted the message, so none is relayed.
+     * one. A durable or checkpoint lane's settlement this tab holds no handle for is relayed once; the
+     * receiving tab records it through its own observers, never through an epoch, so it is not relayed
+     * again. A volatile lane's settlement stays in the tab that admitted the message, so none is relayed.
      */
     open(
         observers: BrowserDeliverySettlements.Observers,
@@ -46,7 +46,7 @@ export class BrowserDeliverySettlements {
                 return;
             }
             observers[event.carrier](event);
-            if (event.lane === 'durable' && !observers.holds(event.msgId)) {
+            if ((event.lane === 'durable' || event.lane === 'checkpoint') && !observers.holds(event.msgId)) {
                 relay.relaySettlement(event);
             }
         };
```

- [ ] **Step 10: The outbound README** (Task 1's interim clause replaced; the lane's navigation map):

<!-- dprint-ignore -->
```diff
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -43,8 +43,9 @@ engine remains available to its other tasks; a runtime-owned engine stops. An
 interrupted durable claim remains recoverable after its lease expires.
 
 **One durable owner per session.** The resources carry `durableWorkOwnership`
-([`ALDurableWorkOwnership`](../work/al-durable-work-ownership.ts)), and only the durable lane takes
-it; the memory lane always owns its pair. The default, `ALWAYS_OWNED_AL_DURABLE_WORK`, is the
+([`ALDurableWorkOwnership`](../work/al-durable-work-ownership.ts)). The durable lane's work follows
+it; the memory lanes always run their own pairs, and the checkpoint of the checkpoint lane follows it
+(see "The checkpoint lane"). The default, `ALWAYS_OWNED_AL_DURABLE_WORK`, is the
 server's, Node's and every runtime's whose durable store no other runtime drains, and keeps the
 handler's construction-time registration. While another runtime of the session owns the work, the
 durable lane's [`ALWorkHandler`](../work/al-work-handler.ts) joins no engine round, its `ready()`
@@ -92,7 +93,8 @@ every server message keeps its one backend.
   browser planner states `lane` as `resolveALOutboundStoreDurability(effective.durability.algo)`: the
   message's effective durability alone. `local-outbox` and `local-inbox` name `durable` and go to
   IndexedDB; `volatile`, the default for every send that names none, goes to memory; `local-checkpoint`
-  names `checkpoint`, which goes to the durable lane while the runtime holds no checkpoint lane. A
+  names `checkpoint` and goes to the checkpoint lane, or to the volatile lane, `durable: false`, in a
+  runtime that holds no checkpoint lane; never to the durable lane. A
   dropping plan names `volatile`. A captured policy row keeps only whether its copy outlives memory
   (`persist`), so a re-plan under it keeps its own lane when the two agree and reads `durable` or
   `volatile` when they do not. Reliability no longer implies durability: a default
@@ -106,8 +108,8 @@ every server message keeps its one backend.
   unsent copy was never seen outside the runtime, so both pass.
 - **Grouped sends.** A group whose members differ in durability commits as one group per lane: there
   is no cross-store atomicity. No caller mixes today; an ACK batch is all volatile.
-- **Controls, receipts and retransmission** go to the volatile lane when it owns the target message
-  (one memory read), else to the durable lane.
+- **Controls, receipts and retransmission** go to the memory lane, volatile or checkpoint, that owns
+  the target message (a memory read each), else to the durable lane.
 - **One cancel.** `cancel(msgId)` is runtime-wide: one set of send controls serves both lanes.
 - **Only the durable lane admits foreign dequeue rows.** The volatile lane names no dequeue type and
   takes no browser lock: Web Locks guard cross-tab IndexedDB commits, and memory is per tab. A
@@ -138,7 +140,47 @@ every server message keeps its one backend.
   task turn until it ends (R-S3a-7). A burst loop should yield or batch; fairness is V1's.
 - **Every lane-emitted diagnostic names its lane.** `commit-phases`, `effect-drain` and
   `readiness-probe` carry a required `lane` (`ALStoreDurability`: `durable`, `checkpoint` or
-  `volatile`) (R-S3a-15), so a reader of the runner's storage speed can leave the memory lane out.
+  `volatile`) (R-S3a-15), so a reader of the runner's storage speed can leave the memory lanes out.
+
+### The checkpoint lane
+
+A carrier runtime given `checkpointStores` holds a third pair: a memory pair built as the volatile one
+is, without the budget and with the memory retention rule, whose rows a checkpoint saves to IndexedDB
+([`createCheckpointALOutboundRuntimeStores`](../al-runtime-stores.ts), built once per connect under the
+connect's claim, which the pair's `checkpoint` port, an [`ALCheckpoint`](../checkpoint/al-checkpoint.ts),
+holds). A `checkpoint` plan
+(`local-checkpoint`) is admitted, dispatched, receipted and cleaned up from memory by the lane
+`${effectWorkerId}/checkpoint`, in every runtime of the session.
+
+- **Saved rows.** The checkpoint owns the pair's
+  [`ALCheckpointDirtySet`](../checkpoint/al-checkpoint-dirty-set.ts) and its
+  [`ALCheckpointWriter`](../checkpoint/al-checkpoint-writer.ts), which saves the dirty keys in one
+  readwrite over `entries` and `alm-work`
+  ([`IndexedDbAdmissionBackend.writeUnfencedMutations`](../indexed-db-admission-backend.ts), one
+  `al-admission` `write`): the row shapes the durable pair writes, under the pair's own namespace
+  (`browser:<checkpoint store id>`), which is also its canonical scope, so two memory pairs never save
+  one row. The oldest unsaved change arms one checkpoint an interval after it; nothing runs while the
+  pair is clean; one write is in flight; a completed write clears only the keys still at the revision it
+  captured.
+- **Owner only.** Only the runtime that owns the session's durable work (`durableWorkOwnership`) saves
+  and restores the checkpoint. Another runtime's checkpointed sends run from its memory and its
+  `admitted` verdicts read `durable: false`; what it changed is saved once ownership turns to it. A
+  checkpoint lane's settlement is relayed to the session's other tabs as a durable lane's is.
+- **Restore.** The lane's readiness restores before its first work batch: one `al-admission` `list`
+  ([`IndexedDbAdmissionBackend.readNamespaceRows`](../indexed-db-admission-backend.ts) over
+  [`readALWorkRowsInRanges`](../storage/read-al-work-rows-in-ranges.ts)) reads the pair's rows, and the
+  live ones load into the memory pair without marking, keeping every key the pair already holds. A
+  reserved row is claimed once its lease ends; a work row past its expiry is not loaded and is counted
+  as expired. The first batch after the restore reports `restored` (or `expired-at-recovery`) under the
+  checkpoint store's id. On takeover the restore runs when ownership turns true and wakes the lane. A
+  store that cannot be read is stated on the checkpoint store's health, and the lane runs from memory.
+- **Lag.** The checkpoint store's health reads `delayed` past the interval (a failed write is retried an
+  interval later and is named on it) and `failing` with cause `checkpoint-lag` past the recovery-lag
+  bound; a completed checkpoint ends either. The lane keeps admitting from memory: the browser dispatch,
+  which reads the store's health, refuses or downgrades a new checkpointed send while it reads `failing`
+  with `checkpoint-lag`, as the channel's `onStorageUnavailable` says.
+- **Flush.** `flushCheckpoint()` starts a checkpoint now, or right after the one in flight, and is never
+  awaited: a write the page does not finish leaves the saved rows as they were.
 
 The storage cost is pinned in
 [`al-indexeddb-operation-counts.test.ts`](../../../tests/shared/alm/al-indexeddb-operation-counts.test.ts):
```

- [ ] **Step 11: Format the touched files only.**

```sh
npx dprint fmt packages/shared-web/browser/al-runtime/browser-al-checkpoint-store-ids.ts \
  packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts \
  packages/shared-web/browser/al-runtime/browser-al-runtime-identity.ts \
  packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts \
  packages/shared-web/browser/al-runtime/browser-al-work-cleanup.ts \
  packages/shared-web/browser/connection/browser-delivery-settlements.ts \
  packages/shared/alm/al-admission-backend.ts \
  packages/shared/alm/al-runtime-stores.ts \
  packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts \
  packages/shared/alm/checkpoint/al-checkpoint.ts \
  packages/shared/alm/delivery/compute-al-volatile-control-row-expiry-ms.ts \
  packages/shared/alm/indexed-db-admission-backend.ts \
  packages/shared/alm/outbound/README.md \
  packages/shared/alm/outbound/admission/al-outbound-admission-mutations.ts \
  packages/shared/alm/outbound/admission/al-outbound-admission-store.ts \
  packages/shared/alm/outbound/al-outbound-message-runtime.ts \
  packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts \
  packages/shared/alm/outbound/lane/al-outbound-store-lane.ts \
  packages/shared/alm/outbound/lane/compute-al-outbound-committed-rows.ts \
  packages/shared/alm/storage/read-al-work-rows-in-ranges.ts \
  packages/shared/queuebox/in-memory-queue-box.ts \
  packages/tests/shared/alm/checkpoint/al-checkpoint-test-support.ts \
  packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts \
  packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/alm/al-outbound-store-lane.test.ts \
  packages/tests/shared/alm/checkpoint/al-checkpoint.test.ts \
  packages/tests/shared/alm/outbound-runtime-test-fixture.ts \
  packages/tests/shared/alm/outbound/al-outbound-checkpoint-lane.test.ts \
  packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts \
  packages/tests/shared/alm/session-outbound-test-runtime.ts
```

- [ ] **Step 12: Focused tests.**

```sh
npx vitest run packages/tests/shared/alm/checkpoint/al-checkpoint.test.ts packages/tests/shared/alm/outbound/al-outbound-checkpoint-lane.test.ts \
  packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts \
  packages/tests/shared/alm/al-outbound-store-lane.test.ts packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts \
  packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/alm/work/al-durable-work-ownership.test.ts
for i in 1 2 3 4 5; do npx vitest run packages/tests/shared/alm/checkpoint/al-checkpoint.test.ts packages/tests/shared/alm/outbound/al-outbound-checkpoint-lane.test.ts | grep 'Tests '; done
npx vitest run packages/tests/shared packages/tests/shared-web packages/tests/shared-test
```

Expected (measured at `0c67dd005`): `Test Files  8 passed (8)`, `Tests  78 passed (78)`; `Tests  11 passed (11)` five
times; the three trees `Test Files  3 failed | 1082 passed | 4 skipped (1089)`,
`Tests  10 failed | 10112 passed | 12 skipped (10134)` sandboxed, where the ten are the loopback-binding files
`api-v1-rtc-rtt-recipe-semantics.test.ts`, `api-v1-state-write-convergence-recipe.test.ts` and
`local-websocket-session.test.ts` (`listen EPERM`); those three files with the sandbox disabled pass.

- [ ] **Step 13: Per-task checks and bundles; raise the crossed facade budget** (private `TMPDIR`, R-I2b-23,
      R-I2b-39). The lane, the writer's commit and the takeover's tracking reach the facade's bundle through the shared
      store factories: `browser/rallar.ts` measures 235.214 KiB on this tree (W-B's prototype, before R-I2b-36 and
      R-I2b-37, read 234.943), so the budget rises to the next whole KiB:

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/bundle-budgets.json b/packages/shared-web/bundle-budgets.json
index bbe7d0e68..9c2c35eb3 100644
--- a/packages/shared-web/bundle-budgets.json
+++ b/packages/shared-web/bundle-budgets.json
@@ -1,5 +1,5 @@
 {
-  "browser/rallar.ts": 235,
+  "browser/rallar.ts": 236,
   "browser/rallar-core.ts": 100,
   "browser/rallar-realtime.ts": 100,
   "browser/rallar-data.ts": 20,
```

Then:

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
npm --workspace @ar-eye-hunter/shared-test run typecheck
(cd apps/api-v1 && deno task check); rm -rf apps/api-v1/node_modules/.deno; find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts \
  packages/tests/shared/alm/al-storage-snapshot.test.ts packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts
D="$TMPDIR/task4-bundles"; mkdir -p "$D"
TMPDIR="$D" npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
TMPDIR="$D" npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts \
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Expected (measured at `0c67dd005`): no `tsc` output; typechecks and `deno task check` exit 0;
`check-tests-typecheck: 1441 test files enforced, 0 files carrying known debt (0 errors).` and
`PASS: no new type errors in the maintained test project`; the pins `Test Files  4 passed (4)`,
`Tests  26 passed (26)`, unedited; `| browser/rallar.ts | 1101.1 KiB | 286.7 KiB | 235.2 KiB | < 236.0 KiB | ok |`,
`Bundle budget check passed.` (before the raise: `over`, `Bundle budget check failed for browser/rallar.ts.`);
`Test Files  3 passed (3)`, `Tests  18 passed (18)`. Figures (private `TMPDIR`): `browser/rallar.ts` 235.214 KiB (236),
headless 299.780 KiB (300). Task 5, which composes the pairs in the browser, raises both again.

- [ ] **Step 14: Commit, then run the changed-range gates.**

```sh
git add packages/shared packages/shared-web packages/tests
git commit -F - <<'EOF'
Give the outbound runtime a checkpoint lane that restores before its first batch

A carrier runtime given checkpointStores holds a third store lane,
${effectWorkerId}/checkpoint, over a memory pair built as the volatile
one is (no budget, the memory retention rule, ALStoreDurability
'checkpoint'). createCheckpointALOutboundRuntimeStores builds the pair
and its ALCheckpoint under the connect's claim: the dirty set, the
writer, and an IndexedDB backend over the session database whose rows
sit under the pair's own namespace, which is also its canonical scope.
The checkpoint saves through writeUnfencedMutations (one al-admission
write, one readwrite) and restores through readNamespaceRows (one
al-admission list over the entries prefix and the work-key ranges the
purge already reads, now readALWorkRowsInRanges in shared).

The restore runs in the lane's readiness, owner only, before the first
work batch: live rows load into the pair without marking and keep every
key the pair holds; a reserved row is claimed once its lease ends; a
work row past its expiry is counted, not loaded; the first batch after
it reports restored or expired-at-recovery under the checkpoint store
id. On takeover the restore runs when ownership turns true and wakes
the lane. A store that cannot be read is stated on its health. The
dirty set and the writer exist only while this runtime owns the work:
a waiting runtime keeps no unsaved changes, and a runtime that took
the work over marks every row its pair holds once its restore ran, so
its first checkpoint saves the live state.

Routing reads plan.lane for all three lanes: a checkpoint plan goes to
the checkpoint lane, else the volatile lane, else the only lane.
ready() awaits the three lanes, controls find the owning memory lane,
settlements carry lane 'checkpoint', an admission is durable on the
durable lane and on the checkpoint lane where this runtime owns the
work, and flushCheckpoint() starts a checkpoint. The memory retention
branches and the volatile admission-store factory take 'checkpoint' by
enumeration. The browser's checkpoint store ids are
browser-ws-client-checkpoint:<sid> and browser-rtc-overlay-checkpoint:<sid>;
the session purge and its eviction cover their rows, and the settlement
relay relays the checkpoint lane as it does the durable one.

browser/rallar.ts measures 235.214 KiB (budget raised 235 -> 236); the
headless agent measures 299.780 KiB (budget 300).

D8 reuse: ALStorageReadiness.openStores carries the restore, ALStorageRecoveryReporter its outcome, IndexedDbAdmissionBackend and writeIndexedDbAdmissionMutations its reads and its one write, the purge's work-key range reader moved into shared serves the restore, Task 2's dirty set and capture serve the writer, and peekKeys beside the existing peek lists the rows a takeover marks; no new row shape, schema id or codec.
EOF
npm run check:test-reachability
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured at `0c67dd005`): `Test reachability: 1743 test files, 1737 reached by CI, 6 manual.`;
`PASS: no new repository style findings`; `PASS: all 12 current structure-coupling candidates are individually
classified` and the two other `PASS` lines (the new case records each checkpoint's mutations through a wrapper over
`writeUnfencedMutations`, not a mock's calls; the fixture's existing
`holdOutboundClaims` candidate `test-structure-coupling-11102ca02776726f` is listed as touched and stays classified).

---

### Task 5: Browser composition: the checkpoint pairs, the settings, the page-lifecycle flush and the lag skip

Prototyped in scratch as commit `5798b224e` (red then green) on W-A's Tasks 1–2 and a throwaway scaffold of Tasks 3–4;
reconciled at assembly to the real Tasks 3–4 (R-I2b-33) and to R-I2b-22 (no flush on the public middleware type).
Decisions D129 (the checkpoint rows are the existing row formats, so a checkpoint pair opens the scope's database like
any store), D130 (the third lane: this task hands each carrier its checkpoint pair), D132 (owner-only: only a connect
that owns the session's work writes, and only it listens to the page), D133 (the two settings, 1,000 and 10,000 ms),
D135 (the lifecycle flush), D86 (session-store settings at the composition root); rulings R-I2b-2 (the checkpoint
store ids are their own ids, each with its own health), R-I2b-5 (`failing` with `checkpoint-lag` routes new
admissions through the existing availability path), R-I2b-7 (the flush is best effort), R-I2b-14 and R-I2b-20 (a
runtime without a checkpoint lane sends the tier to its volatile lane with `durable: false`: this task's two carrier
tests are the guard that the browser composition hands both runtimes their pair, since a missed wire would degrade the
tier silently), R-I2b-17 (the checkpoint code lives in `packages/shared/alm/checkpoint/`), R-I2b-19 (`missing` refuses
the tier; only `failing` with `checkpoint-lag` and the existing causes skip it, `delayed` never), R-I2b-22 and
R-I2b-43 (`initialiseMiddleware` returns `{ middleware, checkpoints }`, and the adapter receives the two checkpoint
ports; this replaces R-I2b-38's shape),
R-I2b-24 (the settings on `ConfigureBrowserALRuntimeStoresInput`), R-I2b-31 (`isIndexedDbALRuntimeStoreSupported` is
gone), R-I2b-33 (Task 4's shapes), R-I2b-39 (the budgets), R-I2b-40 (the lag tests drive a real lag; the interval test
fakes the clock).

**Assembly.** Commit `5824c4d73` on `0c67dd005` (Task 4) in the composed chain. W-C's prototype was rewritten where it
assumed Tasks 3–4 differently: the timer is `ALCheckpointWriter.Timers { schedule }`; `ALCheckpointOutboundRuntimeStores`
is imported from `al-outbound-message-runtime.ts`; the store ids from `browser-al-checkpoint-store-ids.ts`; the support
check is `IndexedDbStringPersistenceProvider.isSupported()` (the one textual conflict, in
`browser-al-runtime-stores.ts`); the pair exposes no `storageHealth`, so two tests drive a real lag; and R-I2b-22
replaces W-C's `RallarBrowserMiddleware.flushCheckpoints()` and `flushBrowserALCheckpoints` with
the `checkpoints` beside the middleware in `initialiseMiddleware`'s two-field result (R-I2b-43). File:line anchors are at `5e06c6ab0` unless a step names Task 4's tree.
Bundle figures are read with a private `TMPDIR` (R-I2b-23). After every `cd apps/api-v1 && deno task check`, run
`rm -rf apps/api-v1/node_modules/.deno` and `find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete`.

**Files**

- Create: `packages/shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts` (87 lines) — the settings
  (`BrowserALCheckpointSettingsInput`, `BrowserALCheckpointSettings`, `resolveBrowserALCheckpointSettings`, defaults
  1,000 and 10,000 ms), `BrowserALCheckpointStores` (one pair per outbound carrier),
  `createBrowserALCheckpointOutboundRuntimeStores` and `resolveBrowserALCheckpointStores(sessionId, ownership)`. Its own
  file because `browser-al-runtime-stores.ts` already carries eight runtime value exports and four more would reach the
  twelve-export split review.
- Create: `packages/shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts` (77 lines) — the one named
  page-lifecycle adapter `BrowserPageLifecycleFlush` (its input carries the connect's checkpoint ports) and
  `readBrowserPageLifecycle()`.
- Modify: `packages/shared/alm/ALRuntimeStoreRegistry.ts` — `ALRuntimeStoreFactories.createCheckpointStores` (after
  `:24`) and `resolveALCheckpointRuntimeStores(id, ownership, manager?)` (before `:83`).
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts` — the settings on
  `ConfigureBrowserALRuntimeStoresInput` (`:51-56`); the scopes builder (`:58-111`) registers each outbound scope's
  checkpoint factory beside its durable one, under the checkpoint store id with its own health;
  `configureBrowserALRuntimeStores` (`:169-187`) builds the availability first and tees the checkpoint stores' storage
  events into it.
- Modify: `packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts` — `getCheckpointLaneSkip()` and
  `recordCheckpointHealth(event)` (after `:43`), the lag kept per store id in a `LatestRepository`.
- Modify: `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts` — `writeStorageAdmission`
  (`:233-247`) reads the skip of the requested tier; `recordStorageVerdict` (`:249-257`) leaves the availability alone
  for a checkpoint admission and asks for persistence on the first one.
- Modify: `packages/shared/services/ws-queue-box-client-service.ts` — `Input.outboundCheckpointStores?` (after `:133`),
  passed to the outbound resources (`:620`) as Task 4's `checkpointStores`.
- Modify: `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts` — a required
  `checkpointStores` input (after `:47`), passed as `outboundCheckpointStores` (after `:102`).
- Modify: `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts` — a required `checkpointStores` input
  (after `:55`), passed to the outbound resources (`:83`).
- Modify: `packages/shared-web/browser/connection/initialise-browser-middleware.ts` —
  `InitialiseBrowserTransportInput.checkpointStores` (`:190`), built once in `createBrowserTransportInput` (`:276`),
  handed to the WS client (`:324`) and the RTC overlay (`:424`); `BrowserConnectedMiddleware` (internal: exactly
  `{ middleware: RallarBrowserMiddleware; checkpoints: readonly ALCheckpointPort[] }`), which `initialiseMiddleware` now
  returns (`:250`), the middleware unchanged and both carriers' checkpoint ports beside it (R-I2b-43).
- Modify: `packages/shared-web/browser/connection/browser-transport-runtime.ts` — the connect's
  `BrowserPageLifecycleFlush` over the returned `checkpoints`, created once the middleware is active (`:111-113`) and
  released first in `shutdown()` (`:130-145`); the private `createMiddleware` returns the facade's middleware and the
  checkpoints.
- Modify: `packages/shared-web/browser/rallar.ts` (`:292`), `packages/shared-web/browser/rallar-core.ts` (`:139`) —
  export `ALStorageHealthStatus`.
- Modify: `packages/shared-web/bundle-budgets.json` (`browser/rallar.ts` 236 → 238) and
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (300 → 303), measured in Step 13.
- Modify (docs): `docs/rallar-api-reference.md` (`:619-622`, after `:676`, `:695-697`, `:717-720`),
  `packages/shared-web/browser/README.md` (`:181-184`), `packages/shared/alm/inbound/README.md` (`:72-74`).
- Test (create): `packages/tests/shared-web/al-runtime/browser-page-lifecycle-flush.test.ts` (5 tests),
  `packages/tests/shared-web/al-runtime/fake-page-lifecycle.ts` (the per-test fake page, modelled on
  `installFakeBroadcastChannelPerTest`), `packages/tests/shared-web/connection/browser-transport-page-lifecycle.test.ts`
  (4 tests), `packages/tests/shared-web/al-runtime/browser-al-checkpoint-stores.test.ts` (6 tests).
- Test (modify): `browser-al-storage-availability.test.ts` (6 tests), `browser-message-storage-unavailable.test.ts`
  (7 tests), `initialise-browser-middleware.test.ts` (1 test), `create-browser-web-socket-queue-box.test.ts` (1 test),
  `initialise-browser-rtc-runtime.test.ts` (1 test), `shared-web-public-api-snapshots.test.ts` (two lists); mechanical:
  `acknowledgement-under-hold-fixture.ts`, `ws-retained-work-fault.test.ts`, `ws-durable-owner-recovery.test.ts` and the
  existing sites of the two carrier test files (the `checkpointStores` input, Step 11); and the twenty-five test files
  whose `initialiseMiddleware` mock answers a middleware, which now answer `{ middleware, checkpoints: [] }` (Step 11's
  second table; the test double itself is unchanged).
- Not touched: the lanes, the writer, the restore and the store ids (Tasks 3–4); the inbound runtime; the volatile
  lane and its budget; the D55 pins (Task 6); `rallar-connection-facade.ts` and the public middleware type (R-I2b-22);
  no server or Deno source; the harness (Task 7).

**Interfaces**

- Consumes (the assembled Tasks 1–4):
  - Task 1: `ALDurabilityAlgo` includes `'local-checkpoint'`, accepted by the typed-channel validator through
    `AL_DURABILITY_ALGOS`; the browser planners set `lane: resolveALOutboundStoreDurability(…)` on
    `ALOutboundDispatchPlan.lane: ALStoreDurability`; `ALStoreDurability = 'volatile' | 'checkpoint' | 'durable'`.
  - Tasks 2–3 (through Task 4's pair only): the dirty set and capture; `ALStorageHealthStatus = 'healthy' | 'delayed' |
    'failing'`; `ALStorageHealthState.oldestUnsavedAgeMs: number | undefined`; the cause `'checkpoint-lag'`;
    `ALStorageHealth.recordFailure` and `recordRecoveryPoint` (the latter ends `delayed` and `failing`);
    `ALCheckpointWriter.Timers { schedule(run, delayMs): () => void }` in `checkpoint/al-checkpoint-writer.ts`; one
    checkpoint is one observed `{ owner: 'al-admission', kind: 'write' }`.
  - Task 4: `createCheckpointALOutboundRuntimeStores(input: CreateCheckpointALOutboundRuntimeStoresInput<TPrepared>)`
    in `al-runtime-stores.ts` (input: `CreateDefaultALOutboundRuntimeStoresInput<TPrepared>` plus
    `ALCheckpointWriter.Settings`, `ownership` and `timers`; the canonical scope forced to the pair's namespace; the
    pair's checkpoint reports through the `storageHealth` of its input, which the pair itself does not expose);
    `ALCheckpointOutboundRuntimeStores<TPrepared>` (`evictExpired()`, `checkpoint: ALCheckpointPort`) and
    `Resources.checkpointStores` in `al-outbound-message-runtime.ts`; `DefaultALOutboundRuntimeResourceInput.checkpointStores?`;
    `ALCheckpointPort` (`restore`, `flush`, `dispose`, `isOwned`, `onTakenOverDo`, `reportFirstBatch`) in
    `checkpoint/al-checkpoint.ts`; `toBrowserWsClientALCheckpointRuntimeStoreId` and
    `toBrowserRtcOverlayALCheckpointRuntimeStoreId` in `browser-al-checkpoint-store-ids.ts`; the runtime's `dispose()`
    disposes the pair's checkpoint port; an owner's checkpoint admission reads `durable: true`, a waiting connect's
    `durable: false`.
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // packages/shared/alm/ALRuntimeStoreRegistry.ts
  ALRuntimeStoreFactories.createCheckpointStores?: (ownership: ALDurableWorkOwnership) => ALCheckpointOutboundRuntimeStores<TPrepared>;
  export function resolveALCheckpointRuntimeStores<TPrepared>(id: ALRuntimeStoreId<TPrepared>, ownership: ALDurableWorkOwnership, manager?: RepositoryManager): ALCheckpointOutboundRuntimeStores<TPrepared>;
  // browser-al-checkpoint-stores.ts
  export interface BrowserALCheckpointSettingsInput { readonly checkpointIntervalMs?: number; readonly checkpointLagBoundMs?: number; }
  export interface BrowserALCheckpointSettings { readonly intervalMs: number; readonly lagBoundMs: number; }
  export interface BrowserALCheckpointStores { readonly wsClient: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>; readonly rtcOverlay: …; }
  export function resolveBrowserALCheckpointSettings(input: BrowserALCheckpointSettingsInput): BrowserALCheckpointSettings;
  export function createBrowserALCheckpointOutboundRuntimeStores(name: string, input: CreateBrowserALCheckpointStoresInput): ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
  export function resolveBrowserALCheckpointStores(sessionId: string, ownership: ALDurableWorkOwnership): BrowserALCheckpointStores;
  // browser-al-runtime-stores.ts
  export interface ConfigureBrowserALRuntimeStoresInput extends Omit<…>, BrowserALCheckpointSettingsInput { scope; diagnosticsPorts; }
  // browser-al-storage-availability.ts
  BrowserALStorageAvailability.getCheckpointLaneSkip(): ALStorageUnavailable | undefined;
  BrowserALStorageAvailability.recordCheckpointHealth(event: ALStorageEvent): void;
  // browser-page-lifecycle-flush.ts
  export namespace BrowserPageLifecycleFlush {
      interface Page { document; window; }
      interface Input { page: Page; ownership: ALDurableWorkOwnership; checkpoints: readonly Pick<ALCheckpointPort, 'flush'>[]; }
  }
  export class BrowserPageLifecycleFlush { constructor(input: BrowserPageLifecycleFlush.Input); release(): void; }
  export function readBrowserPageLifecycle(): BrowserPageLifecycleFlush.Page;
  // initialise-browser-middleware.ts (internal; not on rallar.ts)
  export interface BrowserConnectedMiddleware { readonly middleware: RallarBrowserMiddleware; readonly checkpoints: readonly ALCheckpointPort[]; }
  export async function initialiseMiddleware(session, rtcSignalingTopicId, options: BrowserConnectOptions): Promise<BrowserConnectedMiddleware>;
  // carriers
  CreateBrowserWebSocketQueueBox.Input.checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
  InitialiseRtcOverlayMulticastManagerInput.checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
  WsQueueBoxClientService.Input.outboundCheckpointStores?: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
  InitialiseBrowserTransportInput.checkpointStores: BrowserALCheckpointStores;
  // public types (rallar.ts, rallar-core.ts)
  export type { ALStorageHealthStatus } from '@shared/alm/storage/al-storage-event.ts';
  ```

  Behaviour. `configureBrowserALRuntimeStores` registers, beside each outbound scope's durable pair, a checkpoint
  factory that builds the pair under the checkpoint store id with that id's own `ALStorageHealth` and reset sink
  (R-I2b-2), over the scope's database and the connect's openings; the settings default to 1,000 and 10,000 ms
  (D133). `createBrowserTransportInput` builds both pairs once per connect under its claim
  (`resolveBrowserALCheckpointStores(sessionId, options.durableWorkOwnership)`), and the WS client and the RTC overlay
  each take their own (D130). The checkpoint stores' storage events reach the availability before the public port; a
  store whose health reads `failing` with `checkpoint-lag` skips the checkpoint lane until that store reads `healthy`
  or `delayed`, and `missing` skips it as it skips the durable lane, so a new `local-checkpoint` send follows
  `onStorageUnavailable` through the existing `writeChannelAdmission` (R-I2b-5, R-I2b-19). A `failing` of another cause
  does not skip it: a failed checkpoint write is retried by the next checkpoint and stated `delayed`, and only the age
  beyond the bound breaks the tier's promise. A checkpoint admission writes memory only, so it never re-decides the
  availability, and the first one asks for persistent storage whether or not it reads durable (a waiting tab's reads
  `durable: false`, D132). `initialiseMiddleware` returns the middleware with the two pairs' checkpoint ports; once the
  middleware is active, `BrowserTransportRuntime` creates the connect's `BrowserPageLifecycleFlush` over them; it
  listens for `visibilitychange` to hidden, `pagehide` and `freeze` only while the connect owns the session's work (at
  once, or at the takeover), each calling `flush()` on both ports, which starts both carriers' checkpoints and awaits
  none (R-I2b-7); `shutdown()` releases it before it stops the runtimes, and a connect the disconnect cancelled never
  creates one. The public `RallarBrowserMiddleware` type and the middleware object are unchanged (R-I2b-22,
  R-I2b-43).

**D8 reuse inspection.** The checkpoint pair is registered and resolved through the existing runtime-store registry
(`ALRuntimeStoreRegistry.ts:22-81`): a third factory beside `createInboundStores`/`createOutboundStores`, resolved like
`resolveBrowserWsClientALOutboundRuntimeStores` (`browser-al-runtime-stores.ts:195-205`), so no second registry and no
per-session map. Its options are `createBrowserStoreOptions` (`:114-124`, one health and reset sink per store id), and
the pair itself is Task 4's shared factory over the volatile factories. The lag skip extends
`BrowserALStorageAvailability` (`browser-al-storage-availability.ts:28-55`) and the dispatch's existing
`writeChannelAdmission`/`writeStorageAdmission` (`browser-rallar-message-dispatch.ts:211-247`), so `refuse` and
`volatile` and the `durabilityDowngrade` evidence are the existing ones; the per-store lag is keyed latest state in
`packages/shared/cache`'s `LatestRepository` (no raw `Map`). The lifecycle adapter follows `ALWorkEngineMembership`'s
takeover subscription (`al-work-engine-membership.ts:32-40`, `owned.onChangeDo` only while not owned) and the claim's
`AbortController` lifetime (`browser-al-durable-work-claim.ts:35`, `:62-65`) for removing every listener at once;
`readALBrowserLocks`-style global reading (`al-browser-locks.ts:18-20`) for the page, so the transport runtime gains no
injected input (Node has no `document`, so no unit test registers a real listener). The ports reach the transport
runtime on the value `initialiseMiddleware` already returns, beside the middleware in a two-field result, so
no new connect option, callback or registry carries them. The test fake follows `installFakeBroadcastChannelPerTest`
(`rallar-data-test-runtime.ts:58-66`). `WriteBehindObservableLatestRepository` and the engine's `wakeAt` were checked
and do not apply: the flush is an event, not a schedule. Task 5 adds no timer.

**The S3 rule.** The rule "no new timer, queue or registry beyond what the outcome needs" (S3 design :256-258) is kept:
this task adds no timer and no registry (the interval timer is Task 3's recorded waiver, QoS §4). The three lifecycle
listeners are side effects in one named adapter, `BrowserPageLifecycleFlush`, owned by the connect lifetime: created
once per connect after its middleware is active, listening only while the connect owns the session's work, removed by
`release()` at the connect's end. This is the waiver's side-effect statement for D135.

**Limits.**

- The flush is best effort (R-I2b-7): it starts the readwrite and returns; a page closed before the transaction
  commits keeps the previous checkpoint (D129 atomicity). H5 stays unmeasured; the lane's `flush-on-hide` cell (Task 7)
  is the proof.
- A waiting tab registers no listener and checkpoints nothing (D132); its `local-checkpoint` sends die with it.
- The ports never reach the public middleware object (R-I2b-43); the public API snapshot lists names only and does not
  move except for `ALStorageHealthStatus`.
- The settings are composition-root settings on `ConfigureBrowserALRuntimeStoresInput`; `initialiseMiddleware` states
  none, so production runs the defaults. They are optional with defaults, as every other knob of that input
  (`CreateDefaultALRuntimeStoresInput`) is (R-I2b-24).
- A checkpoint store's `failing` for a cause other than `checkpoint-lag` (an unreadable store at restore) does not
  refuse new admissions; the writer reports the lag when the bound passes.
- The two lag tests of `browser-al-checkpoint-stores.test.ts` run on real timers with 20 / 100 ms settings
  (R-I2b-40).
- [ ] **Step 1: Write the failing tests.** (a) Create `packages/tests/shared-web/al-runtime/fake-page-lifecycle.ts`, the
      page fake every lifecycle test drives (Node has no `document` or `window`; a test file that connects through the
      transport installs it per test, as `installFakeBroadcastChannelPerTest` installs its channel):

<!-- dprint-ignore -->
```ts
import { afterEach, beforeEach, vi } from 'vitest';

import type { BrowserPageLifecycleFlush } from '@shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts';

class FakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = 'visible';
}

/** A page's lifecycle events as a browser fires them: `visibilitychange` and `freeze` on the document, `pagehide` on the window. */
export class FakePageLifecycle implements BrowserPageLifecycleFlush.Page {
    readonly document = new FakeDocument();
    readonly window = new EventTarget();

    hide(): void {
        this.document.visibilityState = 'hidden';
        this.document.dispatchEvent(new Event('visibilitychange'));
    }

    show(): void {
        this.document.visibilityState = 'visible';
        this.document.dispatchEvent(new Event('visibilitychange'));
    }

    pagehide(): void {
        this.window.dispatchEvent(new Event('pagehide'));
    }

    freeze(): void {
        this.document.dispatchEvent(new Event('freeze'));
    }
}

/**
 * Node has no `document` or `window`, so a connect there registers no lifecycle listener: a file whose tests
 * drive the page installs a fake for each test, as the browser's globals.
 */
export function installFakePageLifecyclePerTest(): () => FakePageLifecycle {
    let page = new FakePageLifecycle();
    beforeEach(() => {
        page = new FakePageLifecycle();
        vi.stubGlobal('document', page.document);
        vi.stubGlobal('window', page.window);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });
    return () => page;
}
```

(b) Create `packages/tests/shared-web/al-runtime/browser-page-lifecycle-flush.test.ts`:

<!-- dprint-ignore -->
```ts
import { describe, expect, it } from 'vitest';

import { BrowserPageLifecycleFlush } from '@shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK, type ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';

import { FakePageLifecycle } from './fake-page-lifecycle.ts';

describe('the page lifecycle flush of a connect', () => {
    it('flushes the checkpoints when the page hides, is hidden away or freezes', () => {
        const page = new FakePageLifecycle();
        const flushes = openFlush(page, ALWAYS_OWNED_AL_DURABLE_WORK);

        page.hide();
        page.pagehide();
        page.freeze();

        expect(flushes()).toBe(3);
    });

    it('does not flush when the page becomes visible', () => {
        const page = new FakePageLifecycle();
        const flushes = openFlush(page, ALWAYS_OWNED_AL_DURABLE_WORK);

        page.show();

        expect(flushes()).toBe(0);
    });

    // A waiting tab's checkpoint lanes write nothing, so its page events have nothing to flush until it owns the work.
    it('listens only once the connect owns the session\'s work', async () => {
        const page = new FakePageLifecycle();
        const ownership = createWaitingOwnership();
        const flushes = openFlush(page, ownership);

        page.hide();
        await ownership.takeOver();
        page.pagehide();

        expect(flushes()).toBe(1);
    });

    it('removes its listeners at release, also from a takeover that comes after it', async () => {
        const page = new FakePageLifecycle();
        const owned = openFlushHandle(page, ALWAYS_OWNED_AL_DURABLE_WORK);
        const ownership = createWaitingOwnership();
        const waiting = openFlushHandle(page, ownership);

        owned.flush.release();
        waiting.flush.release();
        await ownership.takeOver();
        page.hide();
        page.pagehide();
        page.freeze();

        expect([owned.count(), waiting.count()]).toEqual([0, 0]);
    });

    it('registers nothing where there is no document or window', () => {
        const handle = openFlushHandle({ document: undefined, window: undefined }, ALWAYS_OWNED_AL_DURABLE_WORK);

        handle.flush.release();

        expect(handle.count()).toBe(0);
    });
});

interface FlushHandle {
    readonly flush: BrowserPageLifecycleFlush;
    count(): number;
}

function openFlushHandle(page: BrowserPageLifecycleFlush.Page, ownership: ALDurableWorkOwnership): FlushHandle {
    let count = 0;
    const flush = new BrowserPageLifecycleFlush({ page, ownership, checkpoints: [{ flush: () => count += 1 }] });
    return { flush, count: () => count };
}

function openFlush(page: BrowserPageLifecycleFlush.Page, ownership: ALDurableWorkOwnership): () => number {
    return openFlushHandle(page, ownership).count;
}

interface WaitingOwnership extends ALDurableWorkOwnership {
    /** Settles once every listener of the ownership heard it. */
    takeOver(): Promise<void>;
}

/** A connect whose owner-lock request another tab holds, until the test hands it the work. */
function createWaitingOwnership(): WaitingOwnership {
    const owned = new ObservableLatestValue<boolean>().set(false);
    return {
        owned,
        isOwned: () => owned.peek() === true,
        announceCommit: () => undefined,
        onForeignCommit: () => () => undefined,
        takeOver: async () => {
            owned.accept(true);
            await owned.whenIdle();
        }
    };
}
```

(c) Create `packages/tests/shared-web/connection/browser-transport-page-lifecycle.test.ts`. It mocks
`initialiseMiddleware` as `browser-transport-cleanup.test.ts` does and observes the flushes through two recording
checkpoint ports (`ws`, `rtc`, full `ALCheckpointPort` fakes that log each `flush`) that the mocked
`initialiseMiddleware` returns beside the middleware (R-I2b-43); the last
three tests guard the release, the waiting connect and the cancelled connect and pass before the implementation exists
(regression guards, not red):

<!-- dprint-ignore -->
```ts
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    BrowserTransportRuntime,
    type BrowserTransportInitOptions
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import type { ALCheckpointPort } from '@shared/alm/checkpoint/al-checkpoint.ts';
import type { ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';

import { installFakePageLifecyclePerTest } from '../al-runtime/fake-page-lifecycle.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');

const mocks = vi.hoisted(() => ({
    initialiseMiddleware: vi.fn<MiddlewareModule['initialiseMiddleware']>(),
    readSession: vi.fn<AuthModule['readSession']>()
}));

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    async (importOriginal): Promise<Partial<MiddlewareModule>> => ({
        ...await importOriginal(),
        initialiseMiddleware: mocks.initialiseMiddleware
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    readSession: mocks.readSession
}));

const readPage = installFakePageLifecyclePerTest();

describe('the page lifecycle of a connected browser transport', () => {
    it('flushes the connect\'s checkpoints when its page hides, is hidden away or freezes', async () => {
        const middleware = await connectTransport();

        readPage().hide();
        readPage().pagehide();
        readPage().freeze();

        expect(middleware.flushes).toEqual(['ws', 'rtc', 'ws', 'rtc', 'ws', 'rtc']);
    });

    it('stops flushing once the connect ends', async () => {
        const middleware = await connectTransport();

        middleware.transport.shutdown();
        readPage().hide();
        readPage().pagehide();
        readPage().freeze();

        expect(middleware.flushes).toEqual([]);
    });

    // Another tab holds the session's owner lock for the whole test.
    it('flushes nothing for a connect that waits for the session\'s work', async () => {
        const middleware = await connectTransport({ request: async () => await new Promise<never>(() => {}) });

        readPage().hide();
        readPage().pagehide();
        readPage().freeze();

        expect(middleware.flushes).toEqual([]);
    });

    it('registers nothing for a connect the disconnect cancelled before its transport was up', async () => {
        vi.stubGlobal('navigator', {});
        const middleware = createDefaultApiMiddlewareTestDouble();
        const flushes: string[] = [];
        const transportUp = Promise.withResolvers<BrowserConnectedMiddleware>();
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockReturnValue(transportUp.promise);
        const transport = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });

        const pending = transport.init(toInitOptions());
        transport.shutdown();
        transportUp.resolve({ middleware: middleware.middleware, checkpoints: [recordFlushes('flush', flushes)] });
        await expect(pending).rejects.toThrow('Rallar connection was cancelled because auth ended.');
        readPage().hide();

        expect(flushes).toEqual([]);
    });
});

interface ConnectedTransport {
    readonly transport: BrowserTransportRuntime;
    /** One entry per flush the connect asked of each carrier's checkpoint, named by the carrier. */
    readonly flushes: readonly string[];
}

/** Without a Locks API the connect owns its session's work at once. */
async function connectTransport(locks: ALBrowserLocks | undefined = undefined): Promise<ConnectedTransport> {
    vi.stubGlobal('navigator', { locks });
    const middleware = createDefaultApiMiddlewareTestDouble();
    const flushes: string[] = [];
    mocks.readSession.mockReturnValue(middleware.session);
    mocks.initialiseMiddleware.mockResolvedValue({
        middleware: middleware.middleware,
        checkpoints: [recordFlushes('ws', flushes), recordFlushes('rtc', flushes)]
    });
    const transport = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
    onTestFinished(() => transport.shutdown());
    await transport.init(toInitOptions());
    return { transport, flushes };
}

/** A carrier's checkpoint that logs each flush under the carrier's name and does nothing else. */
function recordFlushes(carrier: string, flushes: string[]): ALCheckpointPort {
    return {
        restore: async () => undefined,
        flush: () => {
            flushes.push(carrier);
        },
        dispose: () => undefined,
        isOwned: () => true,
        onTakenOverDo: () => ({ unsubscribe: () => undefined }),
        reportFirstBatch: () => undefined
    };
}

function toInitOptions(): BrowserTransportInitOptions {
    return {
        qosProvider: undefined,
        readVolatileSessionLimits: undefined,
        deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false },
        diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
    };
}
```

(d) Create `packages/tests/shared-web/al-runtime/browser-al-checkpoint-stores.test.ts`. The pair exposes no
`storageHealth` (Task 4), so the two health cases drive a real lag: an IndexedDB operation observer refuses every
`write` with `QuotaExceededError` while a flag holds, under the settings 20 / 100 ms, until the checkpoint store reads
`failing` with `checkpoint-lag`; the interval case fakes `Date` with the timers, since a real clock can move the change's
age by a millisecond between the change and the arm (R-I2b-40):

<!-- dprint-ignore -->
```ts
import '../../setup-browser-indexeddb.ts';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    toBrowserRtcOverlayALCheckpointRuntimeStoreId,
    toBrowserWsClientALCheckpointRuntimeStoreId
} from '@shared-web/browser/al-runtime/browser-al-checkpoint-store-ids.ts';
import {
    resolveBrowserALCheckpointSettings,
    resolveBrowserALCheckpointStores
} from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
import {
    configureBrowserALRuntimeStores,
    resolveBrowserWsClientALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

const SCOPE = defaultStateScope();
const QUOTA = new DOMException('full', 'QuotaExceededError');

describe('the browser checkpoint settings', () => {
    it('defaults to a 1 s interval target and a 10 s recovery-lag bound', () => {
        expect(resolveBrowserALCheckpointSettings({})).toEqual({ intervalMs: 1_000, lagBoundMs: 10_000 });
    });

    it('takes the settings the composition states', () => {
        expect(resolveBrowserALCheckpointSettings({ checkpointIntervalMs: 250, checkpointLagBoundMs: 2_000 }))
            .toEqual({ intervalMs: 250, lagBoundMs: 2_000 });
    });
});

describe('the checkpoint stores of a browser connect', () => {
    it('gives each outbound carrier its own memory pair under its checkpoint store id', () => {
        const sessionId = `checkpoint-pairs-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, { scope: SCOPE, diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });

        const stores = resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK);
        onTestFinished(() => disposeCheckpoints(stores));

        expect(stores.wsClient.workQueue).toBeInstanceOf(InMemoryQueueBox);
        expect(stores.rtcOverlay.workQueue).toBeInstanceOf(InMemoryQueueBox);
        expect(stores.wsClient.workQueue).not.toBe(stores.rtcOverlay.workQueue);
        expect(stores.wsClient.admissionStore.namespace).toBe(
            `browser:${toBrowserWsClientALCheckpointRuntimeStoreId(sessionId)}:outbound:admission`
        );
        expect(stores.rtcOverlay.admissionStore.namespace).toBe(
            `browser:${toBrowserRtcOverlayALCheckpointRuntimeStoreId(sessionId)}:outbound:admission`
        );
    });

    it('states each checkpoint store\'s lag under its own id, apart from the durable store of its carrier', async () => {
        const events: ALStorageEvent[] = [];
        const sessionId = `checkpoint-health-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, {
            scope: SCOPE,
            diagnosticsPorts: toRallarDiagnosticsPorts({
                storage: (event) => events.push(event),
                indexedDbOperationObserver: refuseWritesWhile({ refusing: true })
            }),
            ...FAST_CHECKPOINTS
        });
        const stores = resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK);
        onTestFinished(() => disposeCheckpoints(stores));

        await stores.wsClient.workQueue.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(createMessage(), 'outbox'));

        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ status: 'failing' })));
        expect(events).toEqual([
            expect.objectContaining({
                kind: 'health',
                storeId: toBrowserWsClientALCheckpointRuntimeStoreId(sessionId),
                status: 'delayed'
            }),
            expect.objectContaining({
                kind: 'health',
                storeId: toBrowserWsClientALCheckpointRuntimeStoreId(sessionId),
                status: 'failing',
                lastFailure: expect.objectContaining({ cause: 'checkpoint-lag' })
            })
        ]);
    });

    // A store's health reaches its sinks on the next turn, so each step waits for the event it states.
    it('skips the connect\'s checkpoint lane while one of its checkpoint stores lags, until it is healthy again', async () => {
        const events: ALStorageEvent[] = [];
        const writes = { refusing: false };
        const sessionId = `checkpoint-lag-${crypto.randomUUID()}`;
        const storage = configureBrowserALRuntimeStores(sessionId, {
            scope: SCOPE,
            diagnosticsPorts: toRallarDiagnosticsPorts({
                storage: (event) => events.push(event),
                indexedDbOperationObserver: refuseWritesWhile(writes)
            }),
            ...FAST_CHECKPOINTS
        });
        const stores = resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK);
        onTestFinished(() => disposeCheckpoints(stores));

        resolveBrowserWsClientALOutboundRuntimeStores(sessionId).storageHealth?.recordFailure({
            cause: 'quota',
            detail: 'QuotaExceededError'
        });
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(storage.getCheckpointLaneSkip()).toBeUndefined();

        writes.refusing = true;
        await stores.rtcOverlay.workQueue.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(createMessage(), 'outbox'));
        await vi.waitFor(() => expect(storage.getCheckpointLaneSkip()).toMatchObject({ cause: 'checkpoint-lag' }));

        writes.refusing = false;
        await vi.waitFor(() => expect(storage.getCheckpointLaneSkip()).toBeUndefined());
    });

    // The clock is fake too: the timer is armed for the change's age, which a real clock can move by a millisecond.
    it('writes a checkpoint at the interval the composition states, in one IndexedDB write', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const observer = createCountingIndexedDbOperationObserver();
        const sessionId = `checkpoint-interval-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, {
            scope: SCOPE,
            diagnosticsPorts: toRallarDiagnosticsPorts({ indexedDbOperationObserver: observer }),
            checkpointIntervalMs: 250
        });
        const stores = resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK);
        onTestFinished(() => disposeCheckpoints(stores));

        await stores.wsClient.workQueue.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(createMessage(), 'outbox'));
        vi.advanceTimersByTime(249);
        const beforeInterval = observer.getCounts().total;
        vi.advanceTimersByTime(1);
        vi.useRealTimers();

        expect(beforeInterval).toBe(0);
        await vi.waitFor(() => expect(observer.getCounts().byKind.write).toBe(1));
        expect(observer.getCounts().total).toBe(1);
    });
});

/** Settings short enough that a refused checkpoint passes its lag bound within a wait. */
const FAST_CHECKPOINTS = { checkpointIntervalMs: 20, checkpointLagBoundMs: 100 } as const;

/** Fails every IndexedDB write as a full quota would, while `refusing` holds. */
function refuseWritesWhile(writes: { readonly refusing: boolean; }): IndexedDbOperationObserver {
    return {
        observe: (operation) => writes.refusing && operation.kind === 'write' ? Promise.reject(QUOTA) : undefined
    };
}

function disposeCheckpoints(stores: ReturnType<typeof resolveBrowserALCheckpointStores>): void {
    stores.wsClient.checkpoint.dispose();
    stores.rtcOverlay.checkpoint.dispose();
}

function createMessage() {
    return newALUnicastMessage(
        'session-1',
        { topicId: 'chat', resourceId: 'checkpoint', contextId: 'conversation' },
        'peer',
        'chat.message.v1',
        { text: 'checkpoint' },
        { ttlMs: 30_000 }
    );
}
```

(e) Extend `packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts` (the lag skip, unit):

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts b/packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts
index 95347ba06..f78aab7ae 100644
--- a/packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts
@@ -16,8 +16,8 @@ import {
 import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
-import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
-import { toALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
+import type { ALStorageEvent, ALStorageHealthStatus } from '@shared/alm/storage/al-storage-event.ts';
+import { toALStorageUnavailable, type ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
 import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
 
 const AVAILABLE: ALStorageAvailability = { kind: 'available' };
@@ -226,6 +226,81 @@ describe('the request for persistent storage', () => {
     });
 });
 
+describe('the checkpoint lane a connect may skip', () => {
+    it('skips nothing while storage is available and every checkpoint store keeps up', () => {
+        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});
+
+        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'delayed', undefined));
+
+        expect(storage.getCheckpointLaneSkip()).toBeUndefined();
+    });
+
+    it('skips it while storage is missing, as it skips the durable lane', () => {
+        const storage = createStorageAvailability(MISSING, undefined, () => {});
+
+        expect(storage.getCheckpointLaneSkip()).toEqual({ cause: 'missing', detail: 'No IndexedDB.' });
+    });
+
+    it('skips it while a checkpoint store lags beyond its bound, until that store is healthy again', () => {
+        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});
+
+        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', CHECKPOINT_LAG));
+        const lagging = storage.getCheckpointLaneSkip();
+        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'healthy', CHECKPOINT_LAG));
+
+        expect(lagging).toEqual(CHECKPOINT_LAG);
+        expect(storage.getCheckpointLaneSkip()).toBeUndefined();
+    });
+
+    // Each carrier has its own checkpoint store: one catching up leaves the other's lag standing.
+    it('keeps one store\'s lag while another store recovers', () => {
+        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});
+
+        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', CHECKPOINT_LAG));
+        storage.recordCheckpointHealth(toCheckpointHealth(RTC_CHECKPOINT, 'healthy', undefined));
+
+        expect(storage.getCheckpointLaneSkip()).toEqual(CHECKPOINT_LAG);
+    });
+
+    // A failed checkpoint write is retried by the next one; only the lag beyond the bound refuses new admissions.
+    it('skips nothing for a checkpoint store failing for another cause, or for an event that is no health', () => {
+        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});
+
+        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', { cause: 'quota', detail: 'QuotaExceededError' }));
+        storage.recordCheckpointHealth({ kind: 'persist', outcome: 'granted' });
+
+        expect(storage.getCheckpointLaneSkip()).toBeUndefined();
+    });
+
+    it('leaves the durable lane to its own availability', () => {
+        const storage = createStorageAvailability(AVAILABLE, undefined, () => {});
+
+        storage.recordCheckpointHealth(toCheckpointHealth(WS_CHECKPOINT, 'failing', CHECKPOINT_LAG));
+
+        expect(storage.getDurableLaneSkip()).toBeUndefined();
+        expect(storage.availability.get()).toEqual(AVAILABLE);
+    });
+});
+
+const WS_CHECKPOINT = 'browser-ws-client-checkpoint:session-1';
+const RTC_CHECKPOINT = 'browser-rtc-overlay-checkpoint:session-1';
+const CHECKPOINT_LAG = { cause: 'checkpoint-lag', detail: 'unsaved for 12000 ms' } as const;
+
+function toCheckpointHealth(
+    storeId: string,
+    status: ALStorageHealthStatus,
+    lastFailure: ALStorageUnavailable | undefined
+): ALStorageEvent {
+    return {
+        kind: 'health',
+        storeId,
+        status,
+        lastFailure,
+        lastRecoveryPointAtMs: undefined,
+        oldestUnsavedAgeMs: status === 'healthy' ? undefined : 12_000
+    };
+}
+
 function createStorageAvailability(
     initial: ALStorageAvailability,
     requestPersist: BrowserStoragePersistRequest,
```

(f) Extend `packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts` (the dispatch: refuse,
downgrade, `delayed` admits, `missing` refuses, a durable send ignores the lag, persistence asked once, availability
untouched). The admissions are observed through a recording port fake (`recordWsAdmissions`), not a mock's call count,
so the changed-range coupling check reports no new candidate:

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts b/packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts
index eb1228caf..6ea9a791f 100644
--- a/packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts
+++ b/packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts
@@ -234,6 +234,134 @@ describe('a downgraded send whose storage stays unavailable', () => {
     });
 });
 
+describe('a local-checkpoint send and its checkpoint storage', () => {
+    it('fails without reaching the carrier while a checkpoint store lags beyond its bound, on a channel that refuses', async () => {
+        const fixture = createStorageFixture(AVAILABLE);
+        fixture.middleware.middleware.storageAvailability.recordCheckpointHealth(CHECKPOINT_LAGGING);
+        const admitted = recordWsAdmissions(fixture, toLaneAdmission);
+
+        const handle = await fixture.sender.sendWs(COMMAND, toCheckpointChannel('refuse'));
+
+        await expect.poll(() => handle.lifecycle().state).toBe('failed');
+        expect(handle.lifecycle().evidence.failure).toEqual({ kind: 'storage-unavailable', cause: 'checkpoint-lag' });
+        expect(admitted).toEqual([]);
+    });
+
+    it('sends it once without storage on a channel that chose volatile, naming the lag as the downgrade', async () => {
+        const fixture = createStorageFixture(AVAILABLE);
+        fixture.middleware.middleware.storageAvailability.recordCheckpointHealth(CHECKPOINT_LAGGING);
+        const admitted = recordWsAdmissions(fixture, toVolatileAdmission);
+
+        const handle = await fixture.sender.sendWs(COMMAND, toCheckpointChannel('volatile'));
+
+        await expect.poll(() => handle.lifecycle().state).toBe('queued');
+        expect(admitted.map((message) => message.qos?.durability)).toEqual([{ algo: 'volatile' }]);
+        expect(handle.lifecycle().evidence.durabilityDowngrade).toEqual({
+            requested: 'local-checkpoint',
+            cause: 'checkpoint-lag'
+        });
+    });
+
+    it('admits it while a checkpoint store is only delayed', async () => {
+        const fixture = createStorageFixture(AVAILABLE);
+        fixture.middleware.middleware.storageAvailability.recordCheckpointHealth({
+            ...CHECKPOINT_LAGGING,
+            status: 'delayed',
+            lastFailure: undefined,
+            oldestUnsavedAgeMs: 1_500
+        });
+        const admitted = recordWsAdmissions(fixture, toLaneAdmission);
+
+        const handle = await fixture.sender.sendWs(COMMAND, toCheckpointChannel('refuse'));
+
+        await expect.poll(() => handle.lifecycle().state).toBe('queued');
+        expect(admitted.map((message) => message.qos?.durability)).toEqual([{ algo: 'local-checkpoint' }]);
+    });
+
+    it('fails a local-checkpoint send typed while storage is missing for the document', async () => {
+        const fixture = createStorageFixture(MISSING);
+        const admitted = recordWsAdmissions(fixture, toLaneAdmission);
+
+        const handle = await fixture.sender.sendWs(COMMAND, toCheckpointChannel('refuse'));
+
+        await expect.poll(() => handle.lifecycle().state).toBe('failed');
+        expect(handle.lifecycle().evidence.failure).toEqual({ kind: 'storage-unavailable', cause: 'missing' });
+        expect(admitted).toEqual([]);
+    });
+
+    it('leaves a local-outbox send to the durable lane whatever the checkpoint lag', async () => {
+        const fixture = createStorageFixture(AVAILABLE);
+        fixture.middleware.middleware.storageAvailability.recordCheckpointHealth(CHECKPOINT_LAGGING);
+        const admitted = recordWsAdmissions(fixture, toLaneAdmission);
+
+        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));
+
+        await expect.poll(() => handle.lifecycle().state).toBe('queued');
+        expect(admitted.map((message) => message.qos?.durability)).toEqual([{ algo: 'local-outbox' }]);
+    });
+
+    // A tab that waits for the session's work admits to memory only, so its verdict is not durable; the origin's
+    // persistence still serves the owner's checkpoint. The request never settles, as a browser prompting its user.
+    it('asks for persistent storage on the first checkpoint admission, also one that is not durable', async () => {
+        const asked: string[] = [];
+        const fixture = createStorageFixture(AVAILABLE, () => {
+            asked.push('persist');
+            return new Promise<boolean>(() => {});
+        });
+        recordWsAdmissions(fixture, toVolatileAdmission);
+
+        const first = await fixture.sender.sendWs(COMMAND, toCheckpointChannel('refuse'));
+        const second = await fixture.sender.sendWs(COMMAND, toCheckpointChannel('refuse'));
+        await expect.poll(() => [first.lifecycle().state, second.lifecycle().state]).toEqual(['queued', 'queued']);
+
+        expect(asked).toEqual(['persist']);
+    });
+
+    // A checkpoint admission writes memory only, so it says nothing about IndexedDB.
+    it('leaves the connect\'s availability as a storage failure left it', async () => {
+        const fixture = createStorageFixture(QUOTA);
+        recordWsAdmissions(fixture, toLaneAdmission);
+
+        const handle = await fixture.sender.sendWs(COMMAND, toCheckpointChannel('refuse'));
+
+        await expect.poll(() => handle.lifecycle().state).toBe('queued');
+        expect(fixture.middleware.middleware.storageAvailability.availability.get()).toEqual(QUOTA);
+    });
+});
+
+const CHECKPOINT_LAGGING: Extract<ALStorageEvent, { kind: 'health'; }> = {
+    kind: 'health',
+    storeId: 'browser-ws-client-checkpoint:session-1',
+    status: 'failing',
+    lastFailure: { cause: 'checkpoint-lag', detail: 'unsaved for 12000 ms' },
+    lastRecoveryPointAtMs: undefined,
+    oldestUnsavedAgeMs: 12_000
+};
+const QUOTA: ALStorageAvailability = {
+    kind: 'unavailable',
+    reason: { cause: 'quota', detail: 'QuotaExceededError' }
+};
+
+/** Every envelope the WS carrier's admission port received, each answered as `answer` states. */
+function recordWsAdmissions(
+    fixture: ReturnType<typeof createBrowserMessageSenderFixture>,
+    answer: (message: ALMessage) => ALOutboundEnqueueResult
+): readonly ALMessage[] {
+    const admitted: ALMessage[] = [];
+    vi.mocked(fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
+        .mockImplementation(async (message) => {
+            admitted.push(message);
+            return answer(message);
+        });
+    return admitted;
+}
+
+function toCheckpointChannel(
+    onStorageUnavailable: BrowserTypedChannelPolicy['onStorageUnavailable']
+): BrowserTypedChannelPolicy {
+    return { purpose: 'command', durability: 'local-checkpoint', onStorageUnavailable };
+}
+
 const AVAILABLE: ALStorageAvailability = { kind: 'available' };
 const MISSING: ALStorageAvailability = {
     kind: 'unavailable',
```

(g) Extend `packages/tests/shared-web/connection/initialise-browser-middleware.test.ts` (each carrier takes its own pair):

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts b/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
index a447c4343..f7df22e88 100644
--- a/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
+++ b/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
@@ -107,6 +107,38 @@ describe('the durable work claim a connect hands its carriers', () => {
     });
 });
 
+describe('the checkpoint stores a connect hands its carriers', () => {
+    it('gives the WS client and the RTC overlay each the checkpoint pair of its own store', () => {
+        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
+        const qboxEngine = new InboxOutboxEngine();
+        onTestFinished(() => qboxEngine.stop());
+        const input = createBrowserTransportInput(SESSION, OPTIONS);
+        onTestFinished(() => {
+            input.checkpointStores.wsClient.checkpoint.dispose();
+            input.checkpointStores.rtcOverlay.checkpoint.dispose();
+        });
+
+        const ws = toBrowserWebSocketQueueBoxInput(input, {
+            qboxEngine,
+            socket: new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort()),
+            serverPeerId: 'server'
+        });
+        const rtc = toRtcOverlayMulticastManagerInput(input, {
+            qboxEngine,
+            webRtcConnectionService: createConnectionService()
+        });
+
+        expect(ws.checkpointStores).toBe(input.checkpointStores.wsClient);
+        expect(rtc.checkpointStores).toBe(input.checkpointStores.rtcOverlay);
+        expect(ws.checkpointStores.admissionStore.namespace).toBe(
+            'browser:browser-ws-client-checkpoint:session-1:outbound:admission'
+        );
+        expect(rtc.checkpointStores.admissionStore.namespace).toBe(
+            'browser:browser-rtc-overlay-checkpoint:session-1:outbound:admission'
+        );
+    });
+});
+
 function createConnectionService(): WebRtcConnectionService {
     return new WebRtcConnectionService({
         send: async () => undefined,
```

(h) Extend `packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts` and
`packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts`: a `local-checkpoint` send reaches the pair the
carrier is handed, reads `durable: true` for an owning connect and spends nothing of the volatile budget. These two are
R-I2b-14's guard: a runtime without the pair would admit the send to its volatile lane, `durable: false`, and both
fail. The diffs include Step 11's mechanical `checkpointStores` lines at the existing sites:

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts b/packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts
index dec27da80..5b01dbe2e 100644
--- a/packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts
+++ b/packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts
@@ -7,6 +7,7 @@ import {
     vi
 } from 'vitest';
 
+import { resolveBrowserALCheckpointStores } from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
 import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
 import {
     configureBrowserALRuntimeStores,
@@ -17,6 +18,8 @@ import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { createBrowserWebSocketQueueBox } from '@shared-web/browser/websocket/create-browser-web-socket-queue-box.ts';
 import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
+import type { ALCheckpointOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
+import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
 import {
     AL_VOLATILE_SESSION_MAX_ADMISSIONS,
     AL_VOLATILE_SESSION_MAX_BYTES,
@@ -26,6 +29,7 @@ import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-o
 import type { ClientInfo } from '@shared/api/api-config.ts';
 import { CommandTimedOutError } from '@shared/cache/Command.ts';
 import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
+import type WsQueueBoxClientService from '@shared/services/ws-queue-box-client-service.ts';
 import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
 import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
 
@@ -77,6 +81,7 @@ describe('createBrowserWebSocketQueueBox', () => {
                 createDefaultVolatileSessionBudget()
             ),
             volatileBudget: createDefaultVolatileSessionBudget(),
+            checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
             connectTimeoutMs: 25,
             signal: controller.signal
         });
@@ -133,6 +138,7 @@ describe('createBrowserWebSocketQueueBox', () => {
                 createDefaultVolatileSessionBudget()
             ),
             volatileBudget: createDefaultVolatileSessionBudget(),
+            checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
             connectTimeoutMs,
             signal: controller.signal
         });
@@ -177,6 +183,7 @@ describe('createBrowserWebSocketQueueBox', () => {
                 createDefaultVolatileSessionBudget()
             ),
             volatileBudget: createDefaultVolatileSessionBudget(),
+            checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
             connectTimeoutMs: 0,
             signal: controller.signal
         });
@@ -235,6 +242,7 @@ describe('createBrowserWebSocketQueueBox', () => {
                 createDefaultVolatileSessionBudget()
             ),
             volatileBudget: createDefaultVolatileSessionBudget(),
+            checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
             connectTimeoutMs,
             signal: controller.signal
         });
@@ -294,6 +302,7 @@ describe('the session volatile bound on the WS client (C3)', () => {
                 budget
             ),
             volatileBudget: budget,
+            checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
             connectTimeoutMs: 0
         });
         await vi.advanceTimersByTimeAsync(0);
@@ -332,6 +341,75 @@ describe('the session volatile bound on the WS client (C3)', () => {
     });
 });
 
+describe('the checkpoint lane on the WS client', () => {
+    beforeEach(() => {
+        vi.useFakeTimers();
+        vi.stubGlobal('WebSocket', TestWebSocket);
+        onTestFinished(() => {
+            vi.clearAllTimers();
+            vi.useRealTimers();
+            vi.unstubAllGlobals();
+            TestWebSocket.instances.length = 0;
+        });
+        configureBrowserALRuntimeStores(clientData.sessionId, { scope: defaultStateScope(), diagnosticsPorts });
+    });
+
+    it('admits a local-checkpoint send to the checkpoint pair it is handed, outside the volatile budget', async () => {
+        const budget = createDefaultVolatileSessionBudget();
+        const checkpointStores = resolveBrowserALCheckpointStores(clientData.sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient;
+        const service = await openWsClient({ budget, checkpointStores });
+
+        const sent = await service.enqueueOutboxIfAbsent(newALUnicastMessage(
+            'session-1',
+            { topicId: 'chat', resourceId: 'checkpointed', contextId: 'conversation' },
+            'peer',
+            'chat.message.v1',
+            { text: 'checkpointed' },
+            { ttlMs: 30_000, qos: { durability: { algo: 'local-checkpoint' } } }
+        ));
+
+        expect(sent.verdict).toMatchObject({ kind: 'admitted', durable: true });
+        expect(await checkpointStores.admissionStore.hasSentMessageAdmission(sent.message.id.msgId)).toBe(true);
+        expect(budget.readUsage(Date.now()).admissions).toBe(0);
+    });
+});
+
+interface OpenWsClientInput {
+    readonly budget: ALVolatileSessionBudget;
+    readonly checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
+}
+
+async function openWsClient(input: OpenWsClientInput): Promise<WsQueueBoxClientService> {
+    const socket = new JsonWebSocketClient('ws://test', createPassThroughTransportFaultPort());
+    onTestFinished(() => socket.close(1000, 'test-finished'));
+    const qboxEngine = new InboxOutboxEngine();
+    onTestFinished(() => qboxEngine.stop());
+    const initialized = createBrowserWebSocketQueueBox({
+        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
+        qosProvider: undefined,
+        submissionReadinessFaultPort: diagnosticsPorts.submissionReadinessFaultPort,
+        outboundSettlements: () => {},
+        newConnectionRequestId: undefined,
+        qboxEngine,
+        socket,
+        clientData,
+        serverPeerId: 'server',
+        inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
+        inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
+            toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
+            input.budget
+        ),
+        volatileBudget: input.budget,
+        checkpointStores: input.checkpointStores,
+        connectTimeoutMs: 0
+    });
+    await vi.advanceTimersByTimeAsync(0);
+    readCreatedSocket().open();
+    const service = await initialized;
+    onTestFinished(() => service.close(1000, 'test-finished'));
+    return service;
+}
+
 function readCreatedSocket(): TestWebSocket {
     const socket = TestWebSocket.instances.at(-1);
     if (!socket) {
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts b/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts
index 6378f59ab..de1f761a9 100644
--- a/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts
+++ b/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts
@@ -14,6 +14,7 @@ import '../../setup-browser-indexeddb.ts';
 
 import { captureOutboundWorkRunnable } from '../../shared/alm/outbound-runtime-test-fixture.ts';
 
+import { resolveBrowserALCheckpointStores } from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
 import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
 import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { configureBrowserRtcPeerCreationPolicies } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
@@ -192,6 +193,7 @@ describe('browser RTC runtime composition', () => {
             durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
             qosProvider: { defaultsForMessage: computeAlmConformanceQosDefaults },
             volatileBudget: createDefaultVolatileSessionBudget(),
+            checkpointStores: resolveBrowserALCheckpointStores('self', ALWAYS_OWNED_AL_DURABLE_WORK).rtcOverlay,
             outboundSettlements: (event) => registry.record(event),
             webRtcConnectionService: fixture.service,
             qboxEngine
@@ -270,6 +272,7 @@ describe('browser RTC runtime composition', () => {
             durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
             qosProvider: undefined,
             volatileBudget: createDefaultVolatileSessionBudget(),
+            checkpointStores: resolveBrowserALCheckpointStores('self', ALWAYS_OWNED_AL_DURABLE_WORK).rtcOverlay,
             outboundSettlements: () => {},
             webRtcConnectionService: fixture.service,
             qboxEngine
@@ -350,6 +353,7 @@ describe('browser RTC runtime composition', () => {
             durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
             qosProvider: undefined,
             volatileBudget: budget,
+            checkpointStores: resolveBrowserALCheckpointStores('self', ALWAYS_OWNED_AL_DURABLE_WORK).rtcOverlay,
             outboundSettlements: () => {},
             webRtcConnectionService: fixture.service,
             qboxEngine: new InboxOutboxEngine()
@@ -370,8 +374,76 @@ describe('browser RTC runtime composition', () => {
         expect(result.verdict).toMatchObject({ kind: 'admitted', durable: false });
         expect(budget.readUsage(Date.now()).admissions).toBe(1);
     });
+
+    it('admits a local-checkpoint send to the checkpoint pair it is handed, outside the volatile budget', async () => {
+        const group = createAcceptedGroupSnapshotFixture(['self', 'accepted-peer']);
+        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
+        overlaysRepository.setAcceptedOverlayById(
+            toScopedOverlayId(group.group),
+            createAcceptedOverlayFixture(group, 1, ['accepted-peer'])
+        );
+        const fixture = openConnectedPeer('accepted-peer');
+        const budget = createDefaultVolatileSessionBudget();
+        const checkpointStores = resolveBrowserALCheckpointStores('self', ALWAYS_OWNED_AL_DURABLE_WORK).rtcOverlay;
+        const manager = initialiseRtcOverlayMulticastManager({
+            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
+            qosProvider: undefined,
+            volatileBudget: budget,
+            checkpointStores,
+            outboundSettlements: () => {},
+            webRtcConnectionService: fixture.service,
+            qboxEngine: new InboxOutboxEngine()
+        });
+        onTestFinished(() => manager.dispose());
+
+        const result = await manager.enqueueIfAbsent(
+            newALMulticastMessage(
+                'self',
+                { topicId: 'chat', resourceId: 'checkpointed', contextId: group.group.groupId },
+                group.group,
+                'chat.message.v1',
+                { text: 'checkpointed' },
+                { ttlMs: 30_000, qos: { durability: { algo: 'local-checkpoint' } } }
+            )
+        );
+
+        expect(result.verdict).toMatchObject({ kind: 'admitted', durable: true });
+        expect(await checkpointStores.admissionStore.hasSentMessageAdmission(result.message.id.msgId)).toBe(true);
+        expect(budget.readUsage(Date.now()).admissions).toBe(0);
+    });
 });
 
+/** A native peer connection to `peerId` whose channels are open, torn down with the test. */
+function openConnectedPeer(peerId: string): ReturnType<typeof createNativeRtcConnectionFixture> {
+    const nativeRuntime = installNativeRtcRuntime();
+    const fixture = createNativeRtcConnectionFixture(
+        {
+            sessionId: 'self',
+            token: 'fixture-token',
+            iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
+            dataChannelName: 'test',
+            rtcSignalingTopicId: 'rtc'
+        },
+        nativeRuntime,
+        createPassThroughTransportFaultPort()
+    );
+    onTestFinished(() => {
+        try {
+            fixture.dispose();
+        }
+        finally {
+            nativeRuntime.dispose();
+        }
+    });
+    fixture.service.ensurePeerConnectionStarted(peerId, true);
+    const nativePeer = fixture.nativePeer(peerId);
+    nativePeer.setConnected();
+    for (const channel of nativePeer.channels) {
+        channel.open();
+    }
+    return fixture;
+}
+
 async function receiveOffer(queueBox: WsQueueBoxClientService, peerId: string): Promise<void> {
     const signal: QRtcSignalingMessage = {
         channel: 'RtcSignal',
```

(i) The public type in both snapshot lists:

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/shared-web-public-api-snapshots.test.ts b/packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
index 8217e6b70..a7de41cad 100644
--- a/packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
+++ b/packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
@@ -47,6 +47,7 @@ const PUBLIC_SURFACES: readonly PublicSurfaceSnapshot[] = [
                 'ALReceiptMode',
                 'ALStorageEvent',
                 'ALStorageHealthState',
+                'ALStorageHealthStatus',
                 'ALStoragePersistOutcome',
                 'ALStorageRecoveryOutcome',
                 'ALStorageResetEvent',
@@ -310,6 +311,7 @@ const PUBLIC_SURFACES: readonly PublicSurfaceSnapshot[] = [
                 'ALReceiptMode',
                 'ALStorageEvent',
                 'ALStorageHealthState',
+                'ALStorageHealthStatus',
                 'ALStoragePersistOutcome',
                 'ALStorageRecoveryOutcome',
                 'ALStorageResetEvent',
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared-web/al-runtime/browser-page-lifecycle-flush.test.ts \
  packages/tests/shared-web/connection/browser-transport-page-lifecycle.test.ts \
  packages/tests/shared-web/al-runtime/browser-al-checkpoint-stores.test.ts \
  packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts \
  packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts \
  packages/tests/shared-web/connection/initialise-browser-middleware.test.ts \
  packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts \
  packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts \
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
```

Expected (measured with the final tests on Task 4's tree, `0c67dd005`): `Test Files  9 failed (9)`,
`Tests  16 failed | 43 passed (59)`. Four files fail at import (`browser-al-checkpoint-stores.ts` and
`browser-page-lifecycle-flush.ts` do not exist yet); `storage.recordCheckpointHealth is not a function`; the transport's
first test reads `expected [] to deeply equal [ Array(6) ]`; `Cannot read properties of undefined (reading 'wsClient')`
in the middleware case; persistence is asked 0 times (`expected [] to deeply equal [ 'persist' ]`); both snapshots miss
`ALStorageHealthStatus`. The `missing` refusal of a `local-checkpoint` send already passes (today every
non-volatile send skips on `missing`) and stays as the pin of that behaviour.

- [ ] **Step 3: The registry's checkpoint factory.** In `packages/shared/alm/ALRuntimeStoreRegistry.ts`:

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/ALRuntimeStoreRegistry.ts b/packages/shared/alm/ALRuntimeStoreRegistry.ts
index 3fa185332..9c2a99b3f 100644
--- a/packages/shared/alm/ALRuntimeStoreRegistry.ts
+++ b/packages/shared/alm/ALRuntimeStoreRegistry.ts
@@ -2,7 +2,11 @@ import { defaultRepositoryManager } from '../cache/defaultRepositoryManager.ts';
 import { RepositoryManager } from '../cache/RepositoryManager.ts';
 import { RepositoryToken } from '../cache/RepositoryToken.ts';
 import type { ALInboundRuntimeStores } from './inbound/al-inbound-message-runtime.ts';
-import type { ALOutboundRuntimeStores } from './outbound/al-outbound-message-runtime.ts';
+import type {
+    ALCheckpointOutboundRuntimeStores,
+    ALOutboundRuntimeStores
+} from './outbound/al-outbound-message-runtime.ts';
+import type { ALDurableWorkOwnership } from './work/al-durable-work-ownership.ts';
 
 declare const alRuntimeStorePrepared: unique symbol;
 
@@ -22,6 +26,8 @@ export function toALRuntimeStoreId<TPrepared>(id: string): ALRuntimeStoreId<TPre
 export type ALRuntimeStoreFactories<TPrepared> = Readonly<{
     createInboundStores?: () => ALInboundRuntimeStores;
     createOutboundStores?: () => ALOutboundRuntimeStores<TPrepared>;
+    /** One connect's checkpoint pair: its writer runs under the connect's claim on the session's work. */
+    createCheckpointStores?: (ownership: ALDurableWorkOwnership) => ALCheckpointOutboundRuntimeStores<TPrepared>;
 }>;
 
 export type ALRuntimeStoreScope<TPrepared> = Readonly<{
@@ -80,6 +86,20 @@ export function resolveALOutboundRuntimeStores<TPrepared>(
     return factories.createOutboundStores();
 }
 
+export function resolveALCheckpointRuntimeStores<TPrepared>(
+    id: ALRuntimeStoreId<TPrepared>,
+    ownership: ALDurableWorkOwnership,
+    manager: RepositoryManager = defaultRepositoryManager
+): ALCheckpointOutboundRuntimeStores<TPrepared> {
+    const factories = resolveALRuntimeStoreFactories<TPrepared>(id, manager);
+
+    if (!factories.createCheckpointStores) {
+        throw new Error(`AL checkpoint runtime stores are not configured: ${id}`);
+    }
+
+    return factories.createCheckpointStores(ownership);
+}
+
 function toALRuntimeStoreFactoryToken<TPrepared>(
     id: ALRuntimeStoreId<TPrepared>
 ): RepositoryToken<ALRuntimeStoreFactories<TPrepared>> {
```

- [ ] **Step 4: The connect's checkpoint pairs and settings.** Create
      `packages/shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts` (the timers read the global per call, so a
      test's fake timers reach the writer):

<!-- dprint-ignore -->
```ts
import {
    createCheckpointALOutboundRuntimeStores,
    type CreateDefaultALRuntimeStoresInput
} from '@shared/alm/al-runtime-stores.ts';
import { resolveALCheckpointRuntimeStores } from '@shared/alm/ALRuntimeStoreRegistry.ts';
import type { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';
import type { ALCheckpointOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';

import {
    toBrowserRtcOverlayALRuntimeStoreId,
    toBrowserWsClientALRuntimeStoreId
} from './browser-al-runtime-identity.ts';

const BROWSER_AL_CHECKPOINT_INTERVAL_MS = 1_000;
const BROWSER_AL_CHECKPOINT_LAG_BOUND_MS = 10_000;

/** The session store's checkpoint settings, which the browser composition states once per connect. */
export interface BrowserALCheckpointSettingsInput {
    readonly checkpointIntervalMs?: number;
    /** Beyond it the checkpoint store reads `failing` and new checkpoint admissions follow `onStorageUnavailable`. */
    readonly checkpointLagBoundMs?: number;
}

export interface BrowserALCheckpointSettings {
    readonly intervalMs: number;
    readonly lagBoundMs: number;
}

/** One connect's checkpoint pairs, one per outbound carrier. */
export interface BrowserALCheckpointStores {
    readonly wsClient: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly rtcOverlay: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
}

export interface CreateBrowserALCheckpointStoresInput {
    readonly options: Omit<CreateDefaultALRuntimeStoresInput, 'namespace'>;
    readonly settings: BrowserALCheckpointSettings;
    readonly ownership: ALDurableWorkOwnership;
}

const BROWSER_AL_CHECKPOINT_TIMERS: ALCheckpointWriter.Timers = {
    schedule: (run, delayMs) => {
        const handle = globalThis.setTimeout(run, delayMs);
        return () => globalThis.clearTimeout(handle);
    }
};

export function resolveBrowserALCheckpointSettings(
    input: BrowserALCheckpointSettingsInput
): BrowserALCheckpointSettings {
    return {
        intervalMs: input.checkpointIntervalMs ?? BROWSER_AL_CHECKPOINT_INTERVAL_MS,
        lagBoundMs: input.checkpointLagBoundMs ?? BROWSER_AL_CHECKPOINT_LAG_BOUND_MS
    };
}

/** Admits and dispatches from memory; the connect that owns the session's work checkpoints it to IndexedDB. */
export function createBrowserALCheckpointOutboundRuntimeStores(
    name: string,
    input: CreateBrowserALCheckpointStoresInput
): ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage> {
    return createCheckpointALOutboundRuntimeStores({
        ...input.options,
        namespace: `browser:${name}`,
        decodePrepared: decodeALOutboundTransportMessage,
        ownership: input.ownership,
        intervalMs: input.settings.intervalMs,
        lagBoundMs: input.settings.lagBoundMs,
        timers: BROWSER_AL_CHECKPOINT_TIMERS
    });
}

/** Built once per connect, under the connect's claim on the session's work; the stores must be configured first. */
export function resolveBrowserALCheckpointStores(
    sessionId: string,
    ownership: ALDurableWorkOwnership
): BrowserALCheckpointStores {
    return {
        wsClient: resolveALCheckpointRuntimeStores(toBrowserWsClientALRuntimeStoreId(sessionId), ownership),
        rtcOverlay: resolveALCheckpointRuntimeStores(toBrowserRtcOverlayALRuntimeStoreId(sessionId), ownership)
    };
}
```

- [ ] **Step 5: Register the pairs beside each outbound scope, and tee their events into the availability.** In
      `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts` (the one-use `createBrowserRuntimeStoreFactories`
      goes: the inbound scope's one factory is inline and the two outbound scopes share `toBrowserOutboundStoreScope`):

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts b/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
index 4308d3a0b..9bad5faf7 100644
--- a/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts
@@ -10,7 +10,7 @@ import {
     configureALRuntimeStoreScopes,
     resolveALInboundRuntimeStores,
     resolveALOutboundRuntimeStores,
-    type ALRuntimeStoreFactories,
+    type ALRuntimeStoreId,
     type ALRuntimeStoreScope
 } from '@shared/alm/ALRuntimeStoreRegistry.ts';
 import type {
@@ -32,6 +32,16 @@ import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-vol
 import type { StateScope } from '@shared/api/state-types.ts';
 import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
 
+import {
+    toBrowserRtcOverlayALCheckpointRuntimeStoreId,
+    toBrowserWsClientALCheckpointRuntimeStoreId
+} from './browser-al-checkpoint-store-ids.ts';
+import {
+    createBrowserALCheckpointOutboundRuntimeStores,
+    resolveBrowserALCheckpointSettings,
+    type BrowserALCheckpointSettings,
+    type BrowserALCheckpointSettingsInput
+} from './browser-al-checkpoint-stores.ts';
 import {
     toBrowserALRuntimeDbName,
     toBrowserRtcOverlayALRuntimeStoreId,
@@ -50,66 +60,81 @@ interface BrowserALRuntimeOptions extends Omit<CreateDefaultALRuntimeStoresInput
 
 export interface ConfigureBrowserALRuntimeStoresInput
     extends
-        Omit<BrowserALRuntimeOptions, 'dbName' | 'observer' | 'onStorageReset' | 'storageHealth' | 'connectOpenings'> {
+        Omit<BrowserALRuntimeOptions, 'dbName' | 'observer' | 'onStorageReset' | 'storageHealth' | 'connectOpenings'>,
+        BrowserALCheckpointSettingsInput {
     readonly scope: StateScope;
     readonly diagnosticsPorts: RallarDiagnosticsPorts;
 }
 
-function createBrowserRuntimeStoreFactories(
-    name: string,
-    directions: Readonly<{
-        inbound?: boolean;
-        outbound?: boolean;
-    }>,
-    options: BrowserALRuntimeOptions
-): ALRuntimeStoreFactories<ALOutboundTransportMessage> {
-    return {
-        createInboundStores: directions.inbound
-            ? () => createBrowserALInboundRuntimeStores(name, options)
-            : undefined,
-        createOutboundStores: directions.outbound
-            ? () => createBrowserALOutboundRuntimeStores(name, options)
-            : undefined
-    };
+/** Where one connect's stores report, and how its checkpoint lanes run. */
+interface BrowserRuntimeStoreReporting {
+    readonly storage: ALStorageEventSink;
+    /** A checkpoint store's events also reach the connect's availability, which skips its lane on a lag. */
+    readonly checkpointStorage: ALStorageEventSink;
+    readonly checkpoint: BrowserALCheckpointSettings;
 }
 
 function toBrowserRuntimeStoreScopes(
     sessionId: string,
     options: BrowserALRuntimeOptions,
-    storage: ALStorageEventSink
+    reporting: BrowserRuntimeStoreReporting
 ): readonly ALRuntimeStoreScope<ALOutboundTransportMessage>[] {
     const sessionInboundId = toBrowserSessionALInboundRuntimeStoreId(sessionId);
-    const wsClientId = toBrowserWsClientALRuntimeStoreId(sessionId);
-    const rtcOverlayId = toBrowserRtcOverlayALRuntimeStoreId(sessionId);
+    const inboundOptions = createBrowserStoreOptions(sessionInboundId, options, reporting.storage);
 
     return [
         {
             id: sessionInboundId,
-            factories: createBrowserRuntimeStoreFactories(
-                sessionInboundId,
-                { inbound: true },
-                createBrowserStoreOptions(sessionInboundId, options, storage)
-            )
+            factories: {
+                createInboundStores: () => createBrowserALInboundRuntimeStores(sessionInboundId, inboundOptions)
+            }
         },
-        {
-            id: wsClientId,
-            factories: createBrowserRuntimeStoreFactories(
-                wsClientId,
-                { outbound: true },
-                createBrowserStoreOptions(wsClientId, options, storage)
-            )
-        },
-        {
-            id: rtcOverlayId,
-            factories: createBrowserRuntimeStoreFactories(
-                rtcOverlayId,
-                { outbound: true },
-                createBrowserStoreOptions(rtcOverlayId, options, storage)
-            )
-        }
+        toBrowserOutboundStoreScope(
+            {
+                id: toBrowserWsClientALRuntimeStoreId(sessionId),
+                checkpointId: toBrowserWsClientALCheckpointRuntimeStoreId(sessionId)
+            },
+            options,
+            reporting
+        ),
+        toBrowserOutboundStoreScope(
+            {
+                id: toBrowserRtcOverlayALRuntimeStoreId(sessionId),
+                checkpointId: toBrowserRtcOverlayALCheckpointRuntimeStoreId(sessionId)
+            },
+            options,
+            reporting
+        )
     ];
 }
 
+interface BrowserOutboundStoreIds {
+    readonly id: ALRuntimeStoreId<ALOutboundTransportMessage>;
+    readonly checkpointId: ALRuntimeStoreId<ALOutboundTransportMessage>;
+}
+
+/** An outbound carrier's durable pair and its checkpoint pair, each under its own store id and health. */
+function toBrowserOutboundStoreScope(
+    ids: BrowserOutboundStoreIds,
+    options: BrowserALRuntimeOptions,
+    reporting: BrowserRuntimeStoreReporting
+): ALRuntimeStoreScope<ALOutboundTransportMessage> {
+    const outboundOptions = createBrowserStoreOptions(ids.id, options, reporting.storage);
+    const checkpointOptions = createBrowserStoreOptions(ids.checkpointId, options, reporting.checkpointStorage);
+    return {
+        id: ids.id,
+        factories: {
+            createOutboundStores: () => createBrowserALOutboundRuntimeStores(ids.id, outboundOptions),
+            createCheckpointStores: (ownership) =>
+                createBrowserALCheckpointOutboundRuntimeStores(ids.checkpointId, {
+                    options: checkpointOptions,
+                    settings: reporting.checkpoint,
+                    ownership
+                })
+        }
+    };
+}
+
 /** One health per store and connect, shared by every resolve of it; its events and resets name the store. */
 function createBrowserStoreOptions(
     storeId: string,
@@ -170,7 +195,7 @@ export function configureBrowserALRuntimeStores(
     sessionId: string,
     input: ConfigureBrowserALRuntimeStoresInput
 ): BrowserALStorageAvailability {
-    const { diagnosticsPorts, scope, ...options } = input;
+    const { diagnosticsPorts, scope, checkpointIntervalMs, checkpointLagBoundMs, ...options } = input;
     const scoped: BrowserALRuntimeOptions = {
         ...options,
         dbName: toBrowserALRuntimeDbName(scope),
@@ -178,12 +203,21 @@ export function configureBrowserALRuntimeStores(
         canonicalScope: `browser-session:${sessionId}`,
         connectOpenings: new ALStorageConnectOpenings()
     };
-    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped, diagnosticsPorts.storage));
-    return new BrowserALStorageAvailability({
+    const { storage } = diagnosticsPorts;
+    const availability = new BrowserALStorageAvailability({
         initial: toInitialALStorageAvailability(IndexedDbStringPersistenceProvider.isSupported()),
         requestPersist: toBrowserStoragePersistRequest(globalThis.navigator?.storage),
-        storage: diagnosticsPorts.storage
+        storage
     });
+    configureALRuntimeStoreScopes(toBrowserRuntimeStoreScopes(sessionId, scoped, {
+        storage,
+        checkpointStorage: (event) => {
+            availability.recordCheckpointHealth(event);
+            storage(event);
+        },
+        checkpoint: resolveBrowserALCheckpointSettings({ checkpointIntervalMs, checkpointLagBoundMs })
+    }));
+    return availability;
 }
 
 export function resolveBrowserSessionALInboundRuntimeStores(
```

- [ ] **Step 6: The lag skip.** In `packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts`:

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts b/packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts
index 2d6b9991b..b85d53183 100644
--- a/packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts
@@ -4,6 +4,7 @@ import type {
     ALStoragePersistOutcome
 } from '@shared/alm/storage/al-storage-event.ts';
 import type { ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
+import { LatestRepository } from '@shared/cache/LatestRepository.ts';
 import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';
 import { toError } from '@shared/resilience/to-error.ts';
 
@@ -23,11 +24,13 @@ export namespace BrowserALStorageAvailability {
 
 /**
  * Storage missing for the document holds until the next connect; any other cause is tried again by
- * the next durable admission, whose verdict re-decides it.
+ * the next durable admission, whose verdict re-decides it. A checkpoint store that lags beyond its
+ * bound skips the checkpoint lane until that store reads healthy or delayed again.
  */
 export class BrowserALStorageAvailability {
     readonly availability = new ObservableLatestValue<ALStorageAvailability>();
     private readonly input: BrowserALStorageAvailability.Input;
+    private readonly checkpointLags = new LatestRepository<string, ALStorageUnavailable>();
     private persistRequested = false;
 
     constructor(input: BrowserALStorageAvailability.Input) {
@@ -42,6 +45,23 @@ export class BrowserALStorageAvailability {
             : undefined;
     }
 
+    getCheckpointLaneSkip(): ALStorageUnavailable | undefined {
+        const [lag] = this.checkpointLags.values();
+        return this.getDurableLaneSkip() ?? lag?.peek();
+    }
+
+    /** Only a lag beyond the bound skips the lane: a failed checkpoint write is retried by the next one. */
+    recordCheckpointHealth(event: ALStorageEvent): void {
+        if (event.kind !== 'health') {
+            return;
+        }
+        if (event.status === 'failing' && event.lastFailure?.cause === 'checkpoint-lag') {
+            this.checkpointLags.accept(event.storeId, event.lastFailure);
+            return;
+        }
+        this.checkpointLags.delete(event.storeId);
+    }
+
     /** Never awaited: a browser may answer `persist()` only after prompting the user. */
     requestPersistentStorage(): void {
         if (this.persistRequested) {
```

- [ ] **Step 7: The dispatch reads the skip of the requested tier.** In
      `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts` (the switch is exhaustive over
      `ALDurabilityAlgo`, so a fifth tier fails the typecheck here):

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts b/packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts
index ff8f0ad69..58632438c 100644
--- a/packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts
+++ b/packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts
@@ -17,6 +17,7 @@ import {
     isALDeliveryFallbackPastDeadline
 } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
 import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
+import type { ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
 import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
 import { toError } from '@shared/resilience/to-error.ts';
 
@@ -227,31 +228,50 @@ async function writeChannelAdmission(
 }
 
 /**
- * A durable message skips the carrier while storage is missing for the document; any admission that
+ * A durable or checkpoint message skips the carrier while storage is missing for the document, and a
+ * checkpoint message also while a checkpoint store lags beyond its bound; any durable admission that
  * reaches the carrier re-decides the connect's availability.
  */
 async function writeStorageAdmission(
     delivery: BrowserRallarMessageDispatch.Delivery
 ): Promise<ALOutboundEnqueueResult> {
     const storage = delivery.context.middleware.storageAvailability;
-    const skipped = toRequestedDurability(delivery.message) === 'volatile'
-        ? undefined
-        : storage.getDurableLaneSkip();
+    const durability = toRequestedDurability(delivery.message);
+    const skipped = readStorageLaneSkip(storage, durability);
     if (skipped !== undefined) {
         const verdict: ALDeliveryAdmissionVerdict = { kind: 'storage-unavailable', ...skipped };
         return { verdict, message: delivery.message, entries: [], trackedReceiptAlgo: 'none' };
     }
     const admitted = await writeCarrierOutboxAdmission(delivery.context, delivery, delivery.message);
-    recordStorageVerdict(storage, admitted.verdict);
+    recordStorageVerdict(storage, admitted.verdict, durability);
     return admitted;
 }
 
+function readStorageLaneSkip(
+    storage: BrowserALStorageAvailability,
+    durability: ALDurabilityAlgo
+): ALStorageUnavailable | undefined {
+    switch (durability) {
+        case 'volatile':
+            return undefined;
+        case 'local-checkpoint':
+            return storage.getCheckpointLaneSkip();
+        case 'local-outbox':
+        case 'local-inbox':
+            return storage.getDurableLaneSkip();
+    }
+}
+
+/** A checkpoint admission writes memory only, so it says nothing of IndexedDB; the owner's checkpoint still wants persistence. */
 function recordStorageVerdict(
     storage: BrowserALStorageAvailability,
-    verdict: ALDeliveryAdmissionVerdict
+    verdict: ALDeliveryAdmissionVerdict,
+    durability: ALDurabilityAlgo
 ): void {
-    storage.availability.accept(computeALStorageAvailability(storage.availability.get(), verdict));
-    if (verdict.kind === 'admitted' && verdict.durable) {
+    if (durability !== 'local-checkpoint') {
+        storage.availability.accept(computeALStorageAvailability(storage.availability.get(), verdict));
+    }
+    if (verdict.kind === 'admitted' && (verdict.durable || durability === 'local-checkpoint')) {
         storage.requestPersistentStorage();
     }
 }
```

- [ ] **Step 8: Hand each carrier its pair.** The WS client service (Task 4 owns the resource factory's
      `checkpointStores` pass-through; the service gains the optional input the server and Node never state), the WS
      composition, the RTC overlay, and the middleware, which returns the two pairs' checkpoint ports with the middleware as
      `BrowserConnectedMiddleware { middleware, checkpoints }` (R-I2b-22, R-I2b-43; `rallar-connection-facade.ts` is not
      touched):

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/services/ws-queue-box-client-service.ts b/packages/shared/services/ws-queue-box-client-service.ts
index 97cfba6e0..1654d5733 100644
--- a/packages/shared/services/ws-queue-box-client-service.ts
+++ b/packages/shared/services/ws-queue-box-client-service.ts
@@ -26,6 +26,7 @@ import type { ALInboundRuntimeDiagnosticsSink } from '../alm/inbound/al-inbound-
 import { createDefaultALInboundRuntimeResources } from '../alm/inbound/create-default-al-inbound-message-runtime.ts';
 import type { ALOutboundCancelOutcome } from '../alm/outbound/al-outbound-message-runtime.ts';
 import type {
+    ALCheckpointOutboundRuntimeStores,
     ALOutboundRuntimeDiagnosticsSink,
     ALOutboundRuntimeStores,
     ALVolatileOutboundRuntimeStores
@@ -131,6 +132,8 @@ export namespace WsQueueBoxClientService {
         readonly inboundVolatileStores?: ALVolatileInboundRuntimeStores;
         readonly outboundStores?: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
         readonly outboundVolatileStores?: ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage>;
+        /** The memory pair a `local-checkpoint` admission goes to; absent, this client has no checkpoint lane. */
+        readonly outboundCheckpointStores?: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
         readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
         readonly outboundSettlements?: ALDeliverySettlementSink;
         readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
@@ -618,6 +621,7 @@ export function createDefaultWsQueueBoxClientService(input: WsQueueBoxClientServ
             canonicalQueue: input.outbox,
             stores: input.outboundStores,
             volatileStores: input.outboundVolatileStores,
+            checkpointStores: input.outboundCheckpointStores,
             queueEngine: input.queueEngine,
             durableWorkOwnership: input.durableWorkOwnership
         }),
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts b/packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts
index f51b4cba0..6087eb43f 100644
--- a/packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts
+++ b/packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts
@@ -11,7 +11,11 @@ import type {
     ALVolatileInboundRuntimeStores
 } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
 import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
-import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
+import type {
+    ALCheckpointOutboundRuntimeStores,
+    ALOutboundRuntimeDiagnosticsSink
+} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
+import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
 import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
 import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
 import type { ClientInfo } from '@shared/api/api-config.ts';
@@ -45,6 +49,8 @@ export namespace CreateBrowserWebSocketQueueBox {
         /** The session's inbound memory pair, the same one the RTC receiver holds. */
         readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;
         readonly volatileBudget: ALVolatileSessionBudget;
+        /** The connect's checkpoint pair of the WS client, which its `local-checkpoint` admissions go to. */
+        readonly checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
         /** The connect's claim on its session's durable work, which only the durable lanes take. */
         readonly durableWorkOwnership: ALDurableWorkOwnership;
         readonly signal?: AbortSignal;
@@ -100,6 +106,7 @@ function createBrowserWebSocketQueueBoxService(
             toBrowserWsClientALRuntimeStoreId(clientData.sessionId),
             input.volatileBudget
         ),
+        outboundCheckpointStores: input.checkpointStores,
         outboundDiagnostics: input.outboundDiagnostics,
         outboundSettlements: input.outboundSettlements,
         inboundDiagnostics: input.inboundDiagnostics,
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts b/packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts
index 82302ae09..0ca90e7d8 100644
--- a/packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts
+++ b/packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts
@@ -14,8 +14,14 @@ import type {
     ALVolatileInboundRuntimeStores
 } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
 import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
-import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
-import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
+import type {
+    ALCheckpointOutboundRuntimeStores,
+    ALOutboundRuntimeDiagnosticsSink
+} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
+import {
+    decodeALOutboundTransportMessage,
+    type ALOutboundTransportMessage
+} from '@shared/alm/outbound/al-outbound-transport-message.ts';
 import {
     createDefaultALOutboundDequeueResilience,
     createDefaultALOutboundRuntimeResources
@@ -53,6 +59,8 @@ import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signal
 export interface InitialiseRtcOverlayMulticastManagerInput {
     readonly qosProvider: ALQosInputProvider | undefined;
     readonly volatileBudget: ALVolatileSessionBudget;
+    /** The connect's checkpoint pair of the RTC overlay, which its `local-checkpoint` admissions go to. */
+    readonly checkpointStores: ALCheckpointOutboundRuntimeStores<ALOutboundTransportMessage>;
     readonly outboundSettlements: ALDeliverySettlementSink;
     readonly webRtcConnectionService: WebRtcConnectionService;
     readonly qboxEngine: InboxOutboxEngine;
@@ -80,6 +88,7 @@ export function initialiseRtcOverlayMulticastManager(
                 toBrowserRtcOverlayALRuntimeStoreId(webRtcConnectionService.input.sessionId),
                 input.volatileBudget
             ),
+            checkpointStores: input.checkpointStores,
             durableWorkOwnership: input.durableWorkOwnership
         }),
         dequeueResilience: createDefaultALOutboundDequeueResilience(),
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/connection/initialise-browser-middleware.ts b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
index 91b050462..b11194f1f 100644
--- a/packages/shared-web/browser/connection/initialise-browser-middleware.ts
+++ b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
@@ -1,5 +1,6 @@
 import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
 import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
+import type { ALCheckpointPort } from '@shared/alm/checkpoint/al-checkpoint.ts';
 import type {
     ALInboundRuntimeStores,
     ALVolatileInboundRuntimeStores
@@ -53,6 +54,10 @@ import { readStateGroupSnapshot } from '@shared-web/browser/state-read/point-rea
 import { refreshStateSnapshots, type StateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
 import { listStateGroups } from '@shared-web/browser/state-read/state-snapshot-http-api.ts';
 
+import {
+    resolveBrowserALCheckpointStores,
+    type BrowserALCheckpointStores
+} from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
 import { initBrowserALRuntimeExpiryEviction } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
 import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
 import {
@@ -99,6 +104,12 @@ export interface BrowserConnectOptions extends MiddlewareInitOptions {
     readonly durableWorkOwnership: ALDurableWorkOwnership;
 }
 
+/** One connect's middleware, and the checkpoints of its two carriers, which the connect's page lifecycle flushes. */
+export interface BrowserConnectedMiddleware {
+    readonly middleware: RallarBrowserMiddleware;
+    readonly checkpoints: readonly ALCheckpointPort[];
+}
+
 export interface ToCreateWsUrlInput {
     readonly apiConfig: ApiConfig;
     readonly session: AuthSession;
@@ -194,6 +205,8 @@ export interface InitialiseBrowserTransportInput {
     readonly inboundStores: ALInboundRuntimeStores;
     readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;
     readonly volatileBound: BrowserSessionVolatileBound;
+    /** Built once per connect, under its claim; the WS client and the RTC overlay each take their own. */
+    readonly checkpointStores: BrowserALCheckpointStores;
     readonly options: BrowserConnectOptions;
 }
 
@@ -212,7 +225,7 @@ export async function initialiseMiddleware(
     session: AuthSession,
     rtcSignalingTopicId: string,
     options: BrowserConnectOptions
-): Promise<RallarBrowserMiddleware> {
+): Promise<BrowserConnectedMiddleware> {
     const storageAvailability = initialiseBrowserRuntimeStores(
         session.sessionId,
         options.scope ?? defaultStateScope(),
@@ -243,11 +256,10 @@ export async function initialiseMiddleware(
             : undefined
     });
 
+    const { checkpointStores } = transportInput;
     return {
-        ...webSocketTransport,
-        ...rtcTransport,
-        heartbeat: heartbeatHandle,
-        storageAvailability
+        middleware: { ...webSocketTransport, ...rtcTransport, heartbeat: heartbeatHandle, storageAvailability },
+        checkpoints: [checkpointStores.wsClient.checkpoint, checkpointStores.rtcOverlay.checkpoint]
     };
 }
 
@@ -274,6 +286,7 @@ export function createBrowserTransportInput(
             volatileBound.budget
         ),
         volatileBound,
+        checkpointStores: resolveBrowserALCheckpointStores(clientData.sessionId, options.durableWorkOwnership),
         options,
         creation: {
             createMessage: newALUntargetedMessage,
@@ -322,6 +335,7 @@ export function toBrowserWebSocketQueueBoxInput(
         ...carrier,
         qosProvider: input.volatileBound.qosProvider,
         volatileBudget: input.volatileBound.budget,
+        checkpointStores: input.checkpointStores.wsClient,
         submissionReadinessFaultPort: input.options.diagnosticsPorts.submissionReadinessFaultPort,
         clientData: input.clientData,
         inboundStores: input.inboundStores,
@@ -422,6 +436,7 @@ export function toRtcOverlayMulticastManagerInput(
         ...carrier,
         qosProvider: input.volatileBound.qosProvider,
         volatileBudget: input.volatileBound.budget,
+        checkpointStores: input.checkpointStores.rtcOverlay,
         durableWorkOwnership: input.options.durableWorkOwnership,
         outboundDiagnostics: input.options.diagnosticsPorts.outboundDiagnostics,
         outboundSettlements: input.options.deliverySettlements.rtc
```

- [ ] **Step 9: The page-lifecycle adapter and its connect.** Create
      `packages/shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts`:

<!-- dprint-ignore -->
```ts
import type { ALCheckpointPort } from '@shared/alm/checkpoint/al-checkpoint.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { Unsubscribe } from '@shared/cache/RepositoryInterfaces.ts';

export interface BrowserPageLifecycleTarget {
    addEventListener(type: string, listener: () => void, options: AddEventListenerOptions): void;
}

export namespace BrowserPageLifecycleFlush {
    export interface Page {
        /** `visibilitychange` and `freeze` fire here; `undefined` outside a document. */
        readonly document:
            | (BrowserPageLifecycleTarget & Readonly<{ visibilityState: DocumentVisibilityState; }>)
            | undefined;
        /** `pagehide` fires here. */
        readonly window: BrowserPageLifecycleTarget | undefined;
    }

    export interface Input {
        readonly page: Page;
        readonly ownership: ALDurableWorkOwnership;
        /** The connect's checkpoints, one per outbound carrier, as the composition that built them hands them over. */
        readonly checkpoints: readonly Pick<ALCheckpointPort, 'flush'>[];
    }
}

/**
 * One connect's page-lifecycle listeners: a hidden, hidden-away or frozen page flushes the connect's
 * checkpoints, since a hidden page's timers are throttled and a frozen one runs none. They listen only
 * while the connect owns the session's work, the only connect whose checkpoints write, and `release()`
 * removes them. The flush is best effort: it starts the writes and awaits none.
 */
export class BrowserPageLifecycleFlush {
    private readonly input: BrowserPageLifecycleFlush.Input;
    private readonly lifetime = new AbortController();
    private readonly ownershipListener: Unsubscribe | undefined;
    private listening = false;

    constructor(input: BrowserPageLifecycleFlush.Input) {
        this.input = input;
        if (input.ownership.isOwned()) {
            this.listen();
        }
        else {
            this.ownershipListener = input.ownership.owned.onChangeDo(() => this.takeOver());
        }
    }

    release(): void {
        this.ownershipListener?.unsubscribe();
        this.lifetime.abort();
    }

    private takeOver(): void {
        if (!this.listening && !this.lifetime.signal.aborted && this.input.ownership.isOwned()) {
            this.listen();
        }
    }

    private listen(): void {
        this.listening = true;
        const { document, window } = this.input.page;
        const flush = () => this.input.checkpoints.forEach((checkpoint) => checkpoint.flush());
        const options: AddEventListenerOptions = { signal: this.lifetime.signal };
        document?.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                flush();
            }
        }, options);
        document?.addEventListener('freeze', flush, options);
        window?.addEventListener('pagehide', flush, options);
    }
}

export function readBrowserPageLifecycle(): BrowserPageLifecycleFlush.Page {
    return { document: globalThis.document, window: globalThis.window };
}
```

In `packages/shared-web/browser/connection/browser-transport-runtime.ts`:

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/connection/browser-transport-runtime.ts b/packages/shared-web/browser/connection/browser-transport-runtime.ts
index fef42fc4e..400824236 100644
--- a/packages/shared-web/browser/connection/browser-transport-runtime.ts
+++ b/packages/shared-web/browser/connection/browser-transport-runtime.ts
@@ -3,10 +3,15 @@ import {
     BrowserALSessionChannel,
     openBrowserALSessionChannelPort
 } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
+import {
+    BrowserPageLifecycleFlush,
+    readBrowserPageLifecycle
+} from '@shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts';
 import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
 import {
     initialiseMiddleware,
+    type BrowserConnectedMiddleware,
     type BrowserConnectOptions,
     type MiddlewareInitOptions
 } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
@@ -33,6 +38,12 @@ export interface BrowserTransportRuntimePort {
     shutdown(reason?: string): void;
 }
 
+/** One connect's middleware as the facade holds it, and the checkpoints its page lifecycle flushes. */
+interface BrowserTransportConnect {
+    readonly middleware: ApiMiddleware;
+    readonly checkpoints: BrowserConnectedMiddleware['checkpoints'];
+}
+
 export namespace BrowserTransportRuntime {
     export interface Input {
         /** Opens each connect's session channel to the session's other tabs. */
@@ -45,6 +56,7 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
     private readonly input: BrowserTransportRuntime.Input;
     private activeMiddleware: ApiMiddleware | undefined;
     private activeDurableWork: BrowserALDurableWorkClaim | undefined;
+    private activePageLifecycle: BrowserPageLifecycleFlush | undefined;
     private pendingMiddleware: Promise<ApiMiddleware> | undefined;
     private generation = 0;
 
@@ -97,7 +109,7 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
             deliverySettlements: epoch.settlements,
             durableWorkOwnership: durableWork
         })
-            .then((middleware) => {
+            .then(({ middleware, checkpoints }) => {
                 const currentSession = readSession();
                 if (
                     generation !== this.generation ||
@@ -110,6 +122,11 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
 
                 this.activeMiddleware = middleware;
                 this.activeDurableWork = durableWork;
+                this.activePageLifecycle = new BrowserPageLifecycleFlush({
+                    page: readBrowserPageLifecycle(),
+                    ownership: durableWork,
+                    checkpoints
+                });
                 return middleware;
             })
             .catch((error) => {
@@ -133,8 +150,10 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
         this.pendingMiddleware = undefined;
         const middleware = this.activeMiddleware;
         const durableWork = this.activeDurableWork;
+        this.activePageLifecycle?.release();
         this.activeMiddleware = undefined;
         this.activeDurableWork = undefined;
+        this.activePageLifecycle = undefined;
 
         if (middleware) {
             this.shutdownMiddleware(middleware.middleware, reason);
@@ -177,16 +196,16 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
     private async createMiddleware(
         session: AuthSession,
         options: BrowserConnectOptions
-    ): Promise<ApiMiddleware> {
+    ): Promise<BrowserTransportConnect> {
         const authFetch: ApiMiddleware['authFetch'] = (input, init) => {
             const headers = new Headers(init?.headers);
             headers.set('authorization', `Bearer ${session.accessToken}`);
             headers.set('x-client-id', session.clientId);
             return fetch(input, { ...init, headers });
         };
-        const middleware = await initialiseMiddleware(session, AppTopics.rtcSignaling, options);
+        const { middleware, checkpoints } = await initialiseMiddleware(session, AppTopics.rtcSignaling, options);
 
-        return { session, authFetch, middleware };
+        return { middleware: { session, authFetch, middleware }, checkpoints };
     }
 
     private shutdownMiddleware(
```

- [ ] **Step 10: The public type.**

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/rallar-core.ts b/packages/shared-web/browser/rallar-core.ts
index 2fcf6555e..d67c119db 100644
--- a/packages/shared-web/browser/rallar-core.ts
+++ b/packages/shared-web/browser/rallar-core.ts
@@ -137,6 +137,7 @@ export type { ALStorageResetEvent } from '@shared/alm/open-indexed-db-admission-
 export type {
     ALStorageEvent,
     ALStorageHealthState,
+    ALStorageHealthStatus,
     ALStoragePersistOutcome,
     ALStorageRecoveryOutcome
 } from '@shared/alm/storage/al-storage-event.ts';
diff --git a/packages/shared-web/browser/rallar.ts b/packages/shared-web/browser/rallar.ts
index b378c70bb..195a18131 100644
--- a/packages/shared-web/browser/rallar.ts
+++ b/packages/shared-web/browser/rallar.ts
@@ -290,6 +290,7 @@ export type { ALStorageResetEvent } from '@shared/alm/open-indexed-db-admission-
 export type {
     ALStorageEvent,
     ALStorageHealthState,
+    ALStorageHealthStatus,
     ALStoragePersistOutcome,
     ALStorageRecoveryOutcome
 } from '@shared/alm/storage/al-storage-event.ts';
```

- [ ] **Step 11: The mechanical test edits.** The required carrier input reaches every direct construction: one line
      after each `volatileBudget:` of a `createBrowserWebSocketQueueBox` (`.wsClient`) or
      `initialiseRtcOverlayMulticastManager` (`.rtcOverlay`) call, with the file's session id and
      `ALWAYS_OWNED_AL_DURABLE_WORK`, and the import of `resolveBrowserALCheckpointStores` from
      `@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts`:

| File                                                                              | Sites       | Session id             |
| --------------------------------------------------------------------------------- | ----------- | ---------------------- |
| `packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts` | 5 (WS)      | `clientData.sessionId` |
| `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts`            | 3 (RTC)     | `'self'`               |
| `packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts`        | 1 RTC, 1 WS | `'self'`, `sessionId`  |
| `packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts`              | 2 (WS)      | `sessionId`            |
| `packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts`           | 3 (WS)      | `sessionId`            |

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts b/packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts
index 858117f28..83fc137c3 100644
--- a/packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts
+++ b/packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts
@@ -1,5 +1,6 @@
 import { expect, onTestFinished, vi, type MockInstance, type MockSettledResult } from 'vitest';
 
+import { resolveBrowserALCheckpointStores } from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
 import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
 import {
     configureBrowserALRuntimeStores,
@@ -277,6 +278,7 @@ function openRtcSenderOwners(runtime: HoldSenderRuntime, service: WebRtcConnecti
         durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
         qosProvider: undefined,
         volatileBudget: createDefaultVolatileSessionBudget(),
+        checkpointStores: resolveBrowserALCheckpointStores('self', ALWAYS_OWNED_AL_DURABLE_WORK).rtcOverlay,
         outboundSettlements: (event) => runtime.registry.record(event),
         webRtcConnectionService: service,
         qboxEngine: runtime.engine
@@ -369,6 +371,7 @@ async function connectWsQueueBox(runtime: HoldSenderRuntime, sessionId: string)
             createDefaultVolatileSessionBudget()
         ),
         volatileBudget: createDefaultVolatileSessionBudget(),
+        checkpointStores: resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
         connectTimeoutMs: 0
     });
     await vi.advanceTimersByTimeAsync(0);
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts b/packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts
index c99e9ec80..9e82c16a6 100644
--- a/packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts
+++ b/packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts
@@ -9,6 +9,7 @@ import {
 } from 'vitest';
 
 import { computeAlmConformanceQosDefaults } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/compute-alm-conformance-qos-defaults.ts';
+import { resolveBrowserALCheckpointStores } from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
 import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
 import {
     configureBrowserALRuntimeStores,
@@ -83,6 +84,7 @@ describe('WS retained-work faults', () => {
                 createDefaultVolatileSessionBudget()
             ),
             volatileBudget: createDefaultVolatileSessionBudget(),
+            checkpointStores: resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
             connectTimeoutMs: 0
         });
         await vi.advanceTimersByTimeAsync(0);
@@ -166,6 +168,7 @@ describe('WS retained-work faults', () => {
                 createDefaultVolatileSessionBudget()
             ),
             volatileBudget: createDefaultVolatileSessionBudget(),
+            checkpointStores: resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
             connectTimeoutMs: 0
         });
         await vi.advanceTimersByTimeAsync(0);
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts b/packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts
index 220df4413..c24f10253 100644
--- a/packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts
+++ b/packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts
@@ -11,6 +11,7 @@ import {
 
 import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/group-state/presence/group-presence-summary-worker.ts';
 import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
+import { resolveBrowserALCheckpointStores } from '@shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts';
 import { toBrowserSessionALInboundRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
 import {
     configureBrowserALRuntimeStores,
@@ -99,6 +100,7 @@ it('a fresh WS owner recovers the same pending IndexedDB original with a fresh f
             createDefaultVolatileSessionBudget()
         ),
         volatileBudget: createDefaultVolatileSessionBudget(),
+        checkpointStores: resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
         connectTimeoutMs: 0
     });
     await vi.advanceTimersByTimeAsync(0);
@@ -148,6 +150,7 @@ it('a fresh WS owner recovers the same pending IndexedDB original with a fresh f
             createDefaultVolatileSessionBudget()
         ),
         volatileBudget: createDefaultVolatileSessionBudget(),
+        checkpointStores: resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
         connectTimeoutMs: 0
     });
     await vi.advanceTimersByTimeAsync(100);
@@ -475,6 +478,7 @@ async function openRecoveryOwner(
             createDefaultVolatileSessionBudget()
         ),
         volatileBudget: createDefaultVolatileSessionBudget(),
+        checkpointStores: resolveBrowserALCheckpointStores(sessionId, ALWAYS_OWNED_AL_DURABLE_WORK).wsClient,
         connectTimeoutMs: 0
     });
     await vi.advanceTimersByTimeAsync(0);
```

Then the middleware's two-field result (R-I2b-43) reaches every test whose `initialiseMiddleware` mock answers a
middleware, twenty-five test files in all (R-I2b-43 estimated thirteen): each answers `{ middleware: <the same middleware>, checkpoints: [] }` instead, so the facade still holds the
very object the test passed (the identity pins of `browser-facade-behavior.test.ts` and `rallar-startup-lifecycle.test.ts`
hold), and deferred middlewares are typed `BrowserConnectedMiddleware`. The test double is unchanged.
`check-tests-typecheck` names each site until it is done; nothing else in these files changes:

| Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | What changes                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `calls/rallar-calls.test.ts`, `director/browser-director-relay-runtime.test.ts`, `media/browser-media-sources.test.ts`, `messages/browser-rallar-message-sender.test.ts`, `messages/browser-typed-message-channels.test.ts`, `realtime/browser-realtime-json-lane.test.ts`, `realtime/browser-realtime-send-receive.test.ts`, `realtime/browser-room-realtime-runtime.test.ts`, `realtime/browser-targeted-realtime-runtime.test.ts`, `rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts`, `rtc/browser-rtc-recovery-runtime.test.ts`, `rtc/browser-rtc-wait-test-runtime.ts`, `websocket/browser-rallar-ws-controller.test.ts` | the `vi.mock` factory's `initialiseMiddleware` answers `{ middleware: …, checkpoints: [] }`                       |
| `people/people-event-test-runtime.ts`, `rooms/room-event-test-runtime.ts`, `rooms/room-workflow-test-runtime.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | the same, typed `Promise<BrowserConnectedMiddleware>`                                                             |
| `composition/browser-facade-behavior.test.ts`, `composition/browser-runtime-construction.test.ts`, `rallar-facade-defaults.test.ts`, `rallar-startup-lifecycle.test.ts`, `session/browser-auth-session-contract-fixture.ts`, `session/browser-auth-session-contract.test.ts`, `state-read/rtc-authority-recovery.test.ts`                                                                                                                                                                                                                                                                                                             | `mockResolvedValue`/`Promise.resolve`/`return` of `{ middleware: …, checkpoints: [] }`                            |
| `connection/browser-transport-cleanup.test.ts`, `session/browser-auth-session-cleanup.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the deferred middleware typed `BrowserConnectedMiddleware` and resolved with `{ middleware: …, checkpoints: [] }` |

(All under `packages/tests/shared-web/`.)

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared-web/calls/rallar-calls.test.ts b/packages/tests/shared-web/calls/rallar-calls.test.ts
index 004d70e7c..2df12cf34 100644
--- a/packages/tests/shared-web/calls/rallar-calls.test.ts
+++ b/packages/tests/shared-web/calls/rallar-calls.test.ts
@@ -41,7 +41,7 @@ const mocks = await vi.hoisted(async () => {
 vi.mock(
     import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
     (): Partial<MiddlewareModule> => ({
-        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
+        initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
     })
 );
 
diff --git a/packages/tests/shared-web/composition/browser-facade-behavior.test.ts b/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
index eecc93b8e..9c8a6721a 100644
--- a/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
+++ b/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
@@ -94,7 +94,7 @@ installFakeBroadcastChannelPerTest();
 beforeEach(() => {
     browserTransportRuntime.shutdown('test-reset');
     vi.clearAllMocks();
-    runtime.initialiseMiddleware.mockResolvedValue(runtime.middleware.middleware);
+    runtime.initialiseMiddleware.mockResolvedValue({ middleware: runtime.middleware.middleware, checkpoints: [] });
     runtime.readSession.mockReturnValue(runtime.middleware.session);
     runtime.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
     runtime.hydrateStateCache.mockResolvedValue(undefined);
diff --git a/packages/tests/shared-web/composition/browser-runtime-construction.test.ts b/packages/tests/shared-web/composition/browser-runtime-construction.test.ts
index 3b7abae4c..56b5933c6 100644
--- a/packages/tests/shared-web/composition/browser-runtime-construction.test.ts
+++ b/packages/tests/shared-web/composition/browser-runtime-construction.test.ts
@@ -60,7 +60,7 @@ describe('browser runtime construction', () => {
     beforeEach(() => {
         vi.clearAllMocks();
         configureTestCacheRepositories();
-        runtime.initialiseMiddleware.mockResolvedValue(runtime.middleware.middleware);
+        runtime.initialiseMiddleware.mockResolvedValue({ middleware: runtime.middleware.middleware, checkpoints: [] });
         runtime.readSession.mockReturnValue(runtime.middleware.session);
     });
 
@@ -96,7 +96,7 @@ describe('browser runtime construction', () => {
                 normalizeALQosPolicy(message, resolveALQosNormalizationInput(message, { direction: 'outbound' }, options.qosProvider)).effective.supersedence
                     .algo
             );
-            return runtime.middleware.middleware;
+            return { middleware: runtime.middleware.middleware, checkpoints: [] };
         });
         const blackBox = createBlackBoxBrowserRallarRuntimeDependency({
             readVolatileSessionLimits: new BlackBoxRallarVolatileLimits().get
@@ -120,7 +120,7 @@ describe('browser runtime construction', () => {
         const read: (ALVolatileSessionLimits | undefined)[] = [];
         runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
             read.push(options.readVolatileSessionLimits?.());
-            return runtime.middleware.middleware;
+            return { middleware: runtime.middleware.middleware, checkpoints: [] };
         });
         const blackBox = createBlackBoxBrowserRallarRuntimeDependency({
             readVolatileSessionLimits: volatileLimits.get
@@ -151,7 +151,7 @@ describe('browser runtime construction', () => {
         const sinks: ALDeliverySettlementSink[] = [];
         runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
             sinks.push(options.deliverySettlements.ws);
-            return runtime.middleware.middleware;
+            return { middleware: runtime.middleware.middleware, checkpoints: [] };
         });
         const first = createRallarFacade();
         const second = createRallarFacade();
@@ -217,7 +217,7 @@ describe('browser runtime construction', () => {
                 unconfirmedRecipientPeerIds: [],
                 complete: true
             });
-            return runtime.middleware.middleware;
+            return { middleware: runtime.middleware.middleware, checkpoints: [] };
         });
         await second.connect();
         expect(handle.lifecycle().state).toBe('acknowledged');
@@ -264,7 +264,7 @@ describe('browser runtime construction', () => {
         let oldSink: ALDeliverySettlementSink | undefined;
         runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
             oldSink = options.deliverySettlements.ws;
-            return runtime.middleware.middleware;
+            return { middleware: runtime.middleware.middleware, checkpoints: [] };
         });
         const handle = await facade.messages.ws.send({ scope: 'all', typeId: 'app.ready', payload: true, ack: 'receiver' });
         await handle.wait({ until: ['queued'] });
@@ -298,7 +298,7 @@ describe('browser runtime construction', () => {
                 complete: true
             });
             expect(handle.lifecycle().state).toBe('acknowledged');
-            return runtime.middleware.middleware;
+            return { middleware: runtime.middleware.middleware, checkpoints: [] };
         });
         await facade.connect();
         expect(handle.lifecycle().evidence.confirmedHopPeerIds).toEqual(['current']);
@@ -346,7 +346,7 @@ describe('browser runtime construction', () => {
                 unconfirmedRecipientPeerIds: [],
                 complete: true
             });
-            return runtime.middleware.middleware;
+            return { middleware: runtime.middleware.middleware, checkpoints: [] };
         });
         await first.connect();
         expect(handle.lifecycle().state).toBe('acknowledged');
@@ -394,7 +394,7 @@ describe('browser runtime construction', () => {
                 unconfirmedRecipientPeerIds: [],
                 complete: true
             });
-            return runtime.middleware.middleware;
+            return { middleware: runtime.middleware.middleware, checkpoints: [] };
         });
         await facade.connect();
         expect(handle.lifecycle().evidence.confirmedHopPeerIds).toEqual(['retry']);
@@ -446,7 +446,7 @@ describe('browser runtime construction', () => {
             if (!facadeConstructionCompleted) {
                 throw new Error('Transport dependency was used before facade construction completed.');
             }
-            return runtime.middleware.middleware;
+            return { middleware: runtime.middleware.middleware, checkpoints: [] };
         });
         const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
         const facade = createRallarFacade();
diff --git a/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts b/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts
index 71853266e..0836e12ea 100644
--- a/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts
+++ b/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts
@@ -4,10 +4,10 @@ import {
     BrowserTransportRuntime,
     type BrowserTransportInitOptions
 } from '@shared-web/browser/connection/browser-transport-runtime.ts';
+import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
 import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
-import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import { createRallarLifecycleCoordinator } from '@shared-web/browser/session/rallar-lifecycle-coordinator.ts';
 import { createRallarSessionController } from '@shared-web/browser/session/rallar-session-controller.ts';
 import { BrowserSessionConnectionLifecycle, type RallarSessionConnectionInput } from '@shared-web/browser/session/session-connection-lifecycle.ts';
@@ -44,7 +44,7 @@ describe('Browser transport cleanup', () => {
             effects.push('transport-closed');
         });
         mocks.readSession.mockReturnValue(middleware.session);
-        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: middleware.middleware, checkpoints: [] });
         const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
@@ -94,7 +94,7 @@ describe('Browser transport cleanup', () => {
             effects.push('transport-closed');
         });
         mocks.readSession.mockReturnValue(middleware.session);
-        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: middleware.middleware, checkpoints: [] });
         const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
@@ -147,7 +147,7 @@ describe('Browser transport cleanup', () => {
             effects.push('transport-closed');
         });
         mocks.readSession.mockReturnValue(middleware.session);
-        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: middleware.middleware, checkpoints: [] });
         const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
@@ -197,8 +197,8 @@ describe('Browser transport cleanup', () => {
             session: { sessionId: 'session-new', accessToken: 'token-new' }
         });
         const initializationSessions: string[] = [];
-        let resolveFirst: ((middleware: RallarBrowserMiddleware) => void) | undefined;
-        let resolveSecond: ((middleware: RallarBrowserMiddleware) => void) | undefined;
+        let resolveFirst: ((middleware: BrowserConnectedMiddleware) => void) | undefined;
+        let resolveSecond: ((middleware: BrowserConnectedMiddleware) => void) | undefined;
         mocks.initialiseMiddleware.mockImplementation((session) => {
             initializationSessions.push(session.sessionId);
             return new Promise((resolve) => {
@@ -239,12 +239,12 @@ describe('Browser transport cleanup', () => {
         await vi.waitFor(() => {
             expect(initializationSessions).toEqual(['session-old', 'session-new']);
         });
-        resolveSecond?.(second.middleware);
+        resolveSecond?.({ middleware: second.middleware, checkpoints: [] });
         await expect(secondConnection).resolves.toMatchObject({
             session: { sessionId: 'session-new' }
         });
 
-        resolveFirst?.(first.middleware);
+        resolveFirst?.({ middleware: first.middleware, checkpoints: [] });
         await expect(firstConnection).rejects.toThrow(
             'Rallar connection was cancelled because auth ended.'
         );
@@ -260,7 +260,7 @@ describe('Browser transport cleanup', () => {
         vi.mocked(middleware.middleware.webSocketQueueBox.close).mockImplementation(() => {
             cleanupEffects.push('websocket-closed');
         });
-        let resolveMiddleware: ((middleware: RallarBrowserMiddleware) => void) | undefined;
+        let resolveMiddleware: ((middleware: BrowserConnectedMiddleware) => void) | undefined;
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockReturnValue(
             new Promise((resolve) => {
@@ -277,7 +277,7 @@ describe('Browser transport cleanup', () => {
             deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false }
         });
         transportRuntime.shutdown();
-        resolveMiddleware?.(middleware.middleware);
+        resolveMiddleware?.({ middleware: middleware.middleware, checkpoints: [] });
 
         await expect(pending).rejects.toThrow(
             'Rallar connection was cancelled because auth ended.'
@@ -329,7 +329,7 @@ describe('Browser transport cleanup', () => {
         });
 
         mocks.readSession.mockReturnValue(middleware.session);
-        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: middleware.middleware, checkpoints: [] });
         const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
@@ -386,7 +386,7 @@ describe('Browser transport cleanup', () => {
         vi.mocked(middleware.middleware.webSocketQueueBox.close).mockImplementation(() => {
             cleanupEffects.push('websocket-closed');
         });
-        let resolveMiddleware: ((value: RallarBrowserMiddleware) => void) | undefined;
+        let resolveMiddleware: ((value: BrowserConnectedMiddleware) => void) | undefined;
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockReturnValue(
             new Promise((resolve) => {
@@ -429,7 +429,7 @@ describe('Browser transport cleanup', () => {
         const firstDisconnect = sessionController.connectionOperations.disconnect();
         const secondDisconnect = sessionController.connectionOperations.disconnect();
         expect(secondDisconnect).toBe(firstDisconnect);
-        resolveMiddleware?.(middleware.middleware);
+        resolveMiddleware?.({ middleware: middleware.middleware, checkpoints: [] });
 
         await Promise.all([firstDisconnect, secondDisconnect]);
         await expect(pendingConnect).rejects.toThrow(
@@ -451,7 +451,7 @@ describe('the session volatile limits seam', () => {
     it('hands the composition\'s limit reader to the session\'s middleware initialisation', async () => {
         const middleware = createDefaultApiMiddlewareTestDouble();
         mocks.readSession.mockReturnValue(middleware.session);
-        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: middleware.middleware, checkpoints: [] });
         const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const readVolatileSessionLimits = () => ({ maxAdmissions: 3, maxBytes: 4_096 });
@@ -477,7 +477,7 @@ describe('the session\'s durable work claim', () => {
         const browser = stubGrantedWebLocks();
         const middleware = createDefaultApiMiddlewareTestDouble();
         mocks.readSession.mockReturnValue(middleware.session);
-        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: middleware.middleware, checkpoints: [] });
         const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
 
@@ -501,7 +501,7 @@ describe('the session\'s durable work claim', () => {
             effects.push('transport-closed');
         });
         mocks.readSession.mockReturnValue(middleware.session);
-        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: middleware.middleware, checkpoints: [] });
         const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
 
@@ -520,7 +520,7 @@ describe('the session\'s durable work claim', () => {
         vi.mocked(middleware.middleware.webSocketQueueBox.close).mockImplementation(() => {
             effects.push('transport-closed');
         });
-        let resolveMiddleware: ((middleware: RallarBrowserMiddleware) => void) | undefined;
+        let resolveMiddleware: ((middleware: BrowserConnectedMiddleware) => void) | undefined;
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockReturnValue(
             new Promise((resolve) => {
@@ -534,7 +534,7 @@ describe('the session\'s durable work claim', () => {
         await vi.waitFor(() => expect(browser.heldCount()).toBe(1));
         transportRuntime.shutdown();
         expect(effects).toEqual([]);
-        resolveMiddleware?.(middleware.middleware);
+        resolveMiddleware?.({ middleware: middleware.middleware, checkpoints: [] });
 
         await expect(pending).rejects.toThrow('Rallar connection was cancelled because auth ended.');
         expect(effects).toEqual(['transport-closed', 'lock-released']);
@@ -562,7 +562,7 @@ describe('the session\'s durable work claim', () => {
         });
         const middleware = createDefaultApiMiddlewareTestDouble();
         mocks.readSession.mockReturnValue(middleware.session);
-        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: middleware.middleware, checkpoints: [] });
         const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
 
diff --git a/packages/tests/shared-web/director/browser-director-relay-runtime.test.ts b/packages/tests/shared-web/director/browser-director-relay-runtime.test.ts
index 2ded93697..239993f3d 100644
--- a/packages/tests/shared-web/director/browser-director-relay-runtime.test.ts
+++ b/packages/tests/shared-web/director/browser-director-relay-runtime.test.ts
@@ -49,7 +49,7 @@ const mocks = await vi.hoisted(async () => {
 vi.mock(
     import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
     (): Partial<MiddlewareModule> => ({
-        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
+        initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
     })
 );
 
diff --git a/packages/tests/shared-web/media/browser-media-sources.test.ts b/packages/tests/shared-web/media/browser-media-sources.test.ts
index 7b3a0c4df..6a959e48c 100644
--- a/packages/tests/shared-web/media/browser-media-sources.test.ts
+++ b/packages/tests/shared-web/media/browser-media-sources.test.ts
@@ -26,7 +26,7 @@ const mocks = await vi.hoisted(async () => {
 });
 
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), (): Partial<MiddlewareModule> => ({
-    initialiseMiddleware: async () => (await mocks.initialiseApiMiddleware()).middleware
+    initialiseMiddleware: async () => ({ middleware: (await mocks.initialiseApiMiddleware()).middleware, checkpoints: [] })
 }));
 
 vi.mock(
diff --git a/packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts b/packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts
index a09404ae1..98c34eabf 100644
--- a/packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts
+++ b/packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts
@@ -29,7 +29,7 @@ const mocks = await vi.hoisted(async () => {
 });
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), async (original): Promise<typeof MiddlewareModule> => ({
     ...await original(),
-    initialiseMiddleware: async () => mocks.ctx.middleware
+    initialiseMiddleware: async () => ({ middleware: mocks.ctx.middleware, checkpoints: [] })
 }));
 vi.mock(import('@shared/api/auth.ts'), async (original): Promise<typeof AuthModule> => ({
     ...await original(),
diff --git a/packages/tests/shared-web/messages/browser-typed-message-channels.test.ts b/packages/tests/shared-web/messages/browser-typed-message-channels.test.ts
index 76401926f..f08f68016 100644
--- a/packages/tests/shared-web/messages/browser-typed-message-channels.test.ts
+++ b/packages/tests/shared-web/messages/browser-typed-message-channels.test.ts
@@ -44,7 +44,7 @@ const mocks = await vi.hoisted(async () => {
 });
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), async (original): Promise<typeof MiddlewareModule> => ({
     ...await original(),
-    initialiseMiddleware: async () => mocks.apiMiddleware.middleware
+    initialiseMiddleware: async () => ({ middleware: mocks.apiMiddleware.middleware, checkpoints: [] })
 }));
 vi.mock(import('@shared/api/auth.ts'), async (original): Promise<typeof AuthModule> => ({
     ...await original(),
diff --git a/packages/tests/shared-web/people/people-event-test-runtime.ts b/packages/tests/shared-web/people/people-event-test-runtime.ts
index 77f5d7b80..ade1c7900 100644
--- a/packages/tests/shared-web/people/people-event-test-runtime.ts
+++ b/packages/tests/shared-web/people/people-event-test-runtime.ts
@@ -3,8 +3,8 @@ import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
 import type { OnInboxMessageCallback } from '@shared/services/queue-message-callbacks.ts';
 import { vi } from 'vitest';
 
+import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
-import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type { StateSnapshots } from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
 import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
 import { AppTopics } from '@shared/api/api-config.ts';
@@ -58,7 +58,7 @@ const peopleEventMocks = await vi.hoisted(async () => {
 });
 
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), () => ({
-    initialiseMiddleware: async (): Promise<RallarBrowserMiddleware> => peopleEventMocks.context.middleware
+    initialiseMiddleware: async (): Promise<BrowserConnectedMiddleware> => ({ middleware: peopleEventMocks.context.middleware, checkpoints: [] })
 }));
 
 vi.mock(import('@shared-web/browser/state-read/state-event-http-api.ts'), () => ({
diff --git a/packages/tests/shared-web/rallar-facade-defaults.test.ts b/packages/tests/shared-web/rallar-facade-defaults.test.ts
index d51de0df8..27896253d 100644
--- a/packages/tests/shared-web/rallar-facade-defaults.test.ts
+++ b/packages/tests/shared-web/rallar-facade-defaults.test.ts
@@ -29,7 +29,7 @@ const mocks = await vi.hoisted(async () => {
     return {
         context,
         hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(() => Promise.resolve()),
-        initialiseMiddleware: vi.fn<typeof MiddlewareModule.initialiseMiddleware>(() => Promise.resolve(context.middleware)),
+        initialiseMiddleware: vi.fn<typeof MiddlewareModule.initialiseMiddleware>(() => Promise.resolve({ middleware: context.middleware, checkpoints: [] })),
         onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
         readSession: vi.fn<typeof AuthModule.readSession>(() => context.session),
         refreshStateSnapshots: vi.fn<typeof RefreshStateSnapshotsModule.refreshStateSnapshots>(
@@ -115,7 +115,7 @@ describe('Rallar facade default scope behavior', () => {
         mocks.getAllGroupStateSnapshots.mockReturnValue([]);
         mocks.findAcceptedOverlayById.mockReturnValue(undefined);
         mocks.hydrateStateCache.mockResolvedValue(undefined);
-        mocks.initialiseMiddleware.mockResolvedValue(mocks.context.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: mocks.context.middleware, checkpoints: [] });
         mocks.readSession.mockReturnValue(mocks.context.session);
         mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
         connection.ensurePeerLaneOpen.mockReset().mockImplementation(async (peerId, laneId = 'reliable') => ({
diff --git a/packages/tests/shared-web/rallar-startup-lifecycle.test.ts b/packages/tests/shared-web/rallar-startup-lifecycle.test.ts
index 2fe0160fc..d475d3e08 100644
--- a/packages/tests/shared-web/rallar-startup-lifecycle.test.ts
+++ b/packages/tests/shared-web/rallar-startup-lifecycle.test.ts
@@ -32,7 +32,9 @@ const mocks = await vi.hoisted(async () => {
     return {
         apiMiddleware,
         hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(() => Promise.resolve()),
-        initialiseMiddleware: vi.fn<typeof MiddlewareModule.initialiseMiddleware>(() => Promise.resolve(apiMiddleware.middleware)),
+        initialiseMiddleware: vi.fn<typeof MiddlewareModule.initialiseMiddleware>(() =>
+            Promise.resolve({ middleware: apiMiddleware.middleware, checkpoints: [] })
+        ),
         onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
         refreshStateSnapshots: vi.fn<typeof RefreshStateSnapshotsModule.refreshStateSnapshots>(() => Promise.resolve({ clients: [], groups: [] })),
         findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(() => undefined),
@@ -99,7 +101,7 @@ describe('Rallar startup lifecycle behavior', () => {
         mocks.getAllClientStateSnapshots.mockReturnValue([]);
         mockGroupSnapshots([]);
         mocks.hydrateStateCache.mockResolvedValue(undefined);
-        mocks.initialiseMiddleware.mockResolvedValue(mocks.apiMiddleware.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: mocks.apiMiddleware.middleware, checkpoints: [] });
         const storage = new Map<string, string>();
         vi.stubGlobal('localStorage', {
             getItem: (key: string) => storage.get(key) ?? null,
diff --git a/packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts b/packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts
index 01a4567c1..a9f4b6ed9 100644
--- a/packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts
+++ b/packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts
@@ -34,7 +34,7 @@ const mocks = await vi.hoisted(async () => {
 const connection = vi.mocked(mocks.ctx.middleware.webRtcConnectionService);
 
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), (): Partial<typeof MiddlewareModule> => ({
-    initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
+    initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
 }));
 vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), (): Partial<typeof StateCacheLifecycleModule> => ({
     browserStateCacheLifecycle: {
diff --git a/packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts b/packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts
index 3198bdec5..1853bd191 100644
--- a/packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts
+++ b/packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts
@@ -44,7 +44,7 @@ const mocks = await vi.hoisted(async () => {
 const connection = vi.mocked(mocks.context.middleware.webRtcConnectionService);
 
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), (): Partial<typeof MiddlewareModule> => ({
-    initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
+    initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
 }));
 vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), (): Partial<typeof StateCacheLifecycleModule> => ({
     browserStateCacheLifecycle: {
diff --git a/packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts b/packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts
index 111249e00..d8fb2960f 100644
--- a/packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts
+++ b/packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts
@@ -43,7 +43,7 @@ const mocks = await vi.hoisted(async () => {
 const connection = vi.mocked(mocks.context.middleware.webRtcConnectionService);
 
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), (): Partial<typeof MiddlewareModule> => ({
-    initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
+    initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
 }));
 vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), (): Partial<typeof StateCacheLifecycleModule> => ({
     browserStateCacheLifecycle: {
diff --git a/packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts b/packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts
index 97f05cf31..c51353134 100644
--- a/packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts
+++ b/packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts
@@ -43,7 +43,7 @@ const mocks = await vi.hoisted(async () => {
 const connection = vi.mocked(mocks.context.middleware.webRtcConnectionService);
 
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), (): Partial<typeof MiddlewareModule> => ({
-    initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
+    initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
 }));
 vi.mock(import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'), (): Partial<typeof StateCacheLifecycleModule> => ({
     browserStateCacheLifecycle: {
diff --git a/packages/tests/shared-web/rooms/room-event-test-runtime.ts b/packages/tests/shared-web/rooms/room-event-test-runtime.ts
index 76cd3761c..d991164db 100644
--- a/packages/tests/shared-web/rooms/room-event-test-runtime.ts
+++ b/packages/tests/shared-web/rooms/room-event-test-runtime.ts
@@ -3,8 +3,8 @@ import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
 import type { OnInboxMessageCallback } from '@shared/services/queue-message-callbacks.ts';
 import { vi } from 'vitest';
 
+import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
-import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
 import { AppTopics } from '@shared/api/api-config.ts';
 import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
@@ -53,7 +53,7 @@ const roomEventMocks = await vi.hoisted(async () => {
 });
 
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), () => ({
-    initialiseMiddleware: async (): Promise<RallarBrowserMiddleware> => roomEventMocks.ctx.middleware
+    initialiseMiddleware: async (): Promise<BrowserConnectedMiddleware> => ({ middleware: roomEventMocks.ctx.middleware, checkpoints: [] })
 }));
 
 vi.mock(import('@shared-web/browser/state-read/state-event-http-api.ts'), (): Partial<StateEventHttpApiModule> => ({
diff --git a/packages/tests/shared-web/rooms/room-workflow-test-runtime.ts b/packages/tests/shared-web/rooms/room-workflow-test-runtime.ts
index 18856a64e..3bed75de4 100644
--- a/packages/tests/shared-web/rooms/room-workflow-test-runtime.ts
+++ b/packages/tests/shared-web/rooms/room-workflow-test-runtime.ts
@@ -1,6 +1,7 @@
 import { vi } from 'vitest';
 
-import type { ApiMiddleware, RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
+import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
+import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type { StateCacheChangeListener } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
 import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
 import type { GroupSnapshot } from '@shared/api/group-types.ts';
@@ -58,7 +59,7 @@ const roomWorkflowMocks = await vi.hoisted(async () => {
 });
 
 vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), () => ({
-    initialiseMiddleware: async (): Promise<RallarBrowserMiddleware> => roomWorkflowMocks.ctx.middleware
+    initialiseMiddleware: async (): Promise<BrowserConnectedMiddleware> => ({ middleware: roomWorkflowMocks.ctx.middleware, checkpoints: [] })
 }));
 
 vi.mock(import('@shared-web/browser/rooms/room-group-state-workflows.ts'), () => ({
diff --git a/packages/tests/shared-web/rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts b/packages/tests/shared-web/rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts
index c53d00a16..02338ab6d 100644
--- a/packages/tests/shared-web/rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts
+++ b/packages/tests/shared-web/rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts
@@ -45,7 +45,7 @@ const mocks = await vi.hoisted(async () => {
 vi.mock(
     import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
     (): Partial<MiddlewareModule> => ({
-        initialiseMiddleware: async () => (await mocks.initialiseApiMiddleware()).middleware
+        initialiseMiddleware: async () => ({ middleware: (await mocks.initialiseApiMiddleware()).middleware, checkpoints: [] })
     })
 );
 
diff --git a/packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts b/packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts
index ca476d483..9396da9de 100644
--- a/packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts
+++ b/packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts
@@ -94,7 +94,7 @@ const mocks = await vi.hoisted(async () => {
 vi.mock(
     import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
     (): Partial<typeof MiddlewareModule> => ({
-        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
+        initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
     })
 );
 
diff --git a/packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts b/packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts
index ed4398a37..7b6a737c7 100644
--- a/packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts
+++ b/packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts
@@ -106,7 +106,7 @@ vi.mock(
     import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
     async (importOriginal) => ({
         ...await importOriginal(),
-        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
+        initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
     })
 );
 
diff --git a/packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts b/packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts
index 802f48bf9..78f273cdc 100644
--- a/packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts
+++ b/packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts
@@ -1,5 +1,5 @@
 import { toBrowserSessionALRuntimeStoreIds } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
-import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
+import type { BrowserConnectedMiddleware } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import type { RallarWsLifecycleEvent } from '@shared-web/browser/rallar-realtime-facade.ts';
 import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
 import {
@@ -212,7 +212,7 @@ describe('Rallar auth logout and transport cleanup contract', () => {
         });
         mocks.initialiseMiddleware.mockImplementation(async (session) => {
             initializedSessionIds.push(session.sessionId);
-            return mocks.ctx.middleware;
+            return { middleware: mocks.ctx.middleware, checkpoints: [] };
         });
         const facade = createRallarFacade();
 
@@ -235,7 +235,7 @@ describe('Rallar auth logout and transport cleanup contract', () => {
 
     it('shuts down middleware that resolves after logout during connect', async () => {
         const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
-        const deferred = createDeferred<RallarBrowserMiddleware>();
+        const deferred = createDeferred<BrowserConnectedMiddleware>();
         const cleanupState = {
             heartbeatStopped: false,
             rtcReceiverDisposed: false,
@@ -274,7 +274,7 @@ describe('Rallar auth logout and transport cleanup contract', () => {
             'Rallar connection was cancelled because auth ended.'
         );
 
-        deferred.resolve(mocks.ctx.middleware);
+        deferred.resolve({ middleware: mocks.ctx.middleware, checkpoints: [] });
         await expectation;
 
         expect(facade.status()).toBe('idle');
@@ -290,7 +290,7 @@ describe('Rallar auth logout and transport cleanup contract', () => {
 
     it('cancels a pending connection before replacing credentials and reconnects with the replacement', async () => {
         const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
-        const pendingMiddleware = createDeferred<RallarBrowserMiddleware>();
+        const pendingMiddleware = createDeferred<BrowserConnectedMiddleware>();
         const replacementSession = {
             ...mocks.ctx.session,
             sessionId: 'session-2',
@@ -311,7 +311,7 @@ describe('Rallar auth logout and transport cleanup contract', () => {
             })
             .mockImplementationOnce(async (session) => {
                 initializedSessionIds.push(session.sessionId);
-                return mocks.ctx.middleware;
+                return { middleware: mocks.ctx.middleware, checkpoints: [] };
             });
         mocks.loginToApi.mockResolvedValue(replacementSession);
         const facade = createRallarFacade();
@@ -329,7 +329,7 @@ describe('Rallar auth logout and transport cleanup contract', () => {
         expect(facade.status()).toBe('idle');
         expect(facade.isConnected()).toBe(false);
 
-        pendingMiddleware.resolve(mocks.ctx.middleware);
+        pendingMiddleware.resolve({ middleware: mocks.ctx.middleware, checkpoints: [] });
         await expect(pendingConnect).rejects.toThrow(
             'Rallar connection was cancelled because auth ended.'
         );
diff --git a/packages/tests/shared-web/session/browser-auth-session-contract-fixture.ts b/packages/tests/shared-web/session/browser-auth-session-contract-fixture.ts
index cd89c0060..330108d2f 100644
--- a/packages/tests/shared-web/session/browser-auth-session-contract-fixture.ts
+++ b/packages/tests/shared-web/session/browser-auth-session-contract-fixture.ts
@@ -18,7 +18,9 @@ const mocks = await vi.hoisted(async () => {
         webRtcConnectionService: vi.mocked(ctx.middleware.webRtcConnectionService),
         webSocketQueueBox: vi.mocked(ctx.middleware.webSocketQueueBox),
         webSocket: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
-        initialiseMiddleware: vi.fn<ContractModules.BrowserMiddlewareModule['initialiseMiddleware']>(() => Promise.resolve(ctx.middleware)),
+        initialiseMiddleware: vi.fn<ContractModules.BrowserMiddlewareModule['initialiseMiddleware']>(() =>
+            Promise.resolve({ middleware: ctx.middleware, checkpoints: [] })
+        ),
         clearSession: vi.fn<ContractModules.Auth['clearSession']>(),
         readSession: vi.fn<ContractModules.Auth['readSession']>(() => session),
         writeSession: vi.fn<ContractModules.Auth['writeSession']>(),
@@ -180,7 +182,7 @@ function resetSessionAndRoomMocks(): void {
     mocks.getAllClientStateSnapshots.mockReturnValue([]);
     installGroupSnapshotRepositoryMocks(mocks, []);
     mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
-    mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
+    mocks.initialiseMiddleware.mockResolvedValue({ middleware: mocks.ctx.middleware, checkpoints: [] });
     mocks.clearSession.mockImplementation(() => undefined);
     mocks.readSession.mockReturnValue(mocks.ctx.session);
     mocks.logoutFromApi.mockResolvedValue({ loggedOut: true });
diff --git a/packages/tests/shared-web/session/browser-auth-session-contract.test.ts b/packages/tests/shared-web/session/browser-auth-session-contract.test.ts
index 6c60d511c..1f57c873b 100644
--- a/packages/tests/shared-web/session/browser-auth-session-contract.test.ts
+++ b/packages/tests/shared-web/session/browser-auth-session-contract.test.ts
@@ -99,7 +99,7 @@ describe('Rallar auth login, expiry, and registration contract', () => {
             ...mocks.ctx.session,
             expiresAtEpochMs: 1_500
         };
-        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: mocks.ctx.middleware, checkpoints: [] });
         mocks.readSession.mockImplementation(() =>
             Date.now() >= expiringSession.expiresAtEpochMs
                 ? undefined
@@ -205,7 +205,7 @@ describe('Rallar auth login, expiry, and registration contract', () => {
         };
         let currentSession: typeof oldSession | undefined = oldSession;
         let transportClosed = false;
-        mocks.initialiseMiddleware.mockResolvedValue(mocks.ctx.middleware);
+        mocks.initialiseMiddleware.mockResolvedValue({ middleware: mocks.ctx.middleware, checkpoints: [] });
         mocks.readSession.mockImplementation(() => currentSession);
         mocks.clearSession.mockImplementation(() => {
             currentSession = undefined;
diff --git a/packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts b/packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts
index f1133cb26..70cf5b015 100644
--- a/packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts
+++ b/packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts
@@ -595,7 +595,7 @@ function createGeneratedSendLedger(sender: NativeAuthorityEndpoint): BlackBoxRal
     };
     vi.spyOn(auth, 'readSession').mockReturnValue(context.session);
     vi.spyOn(auth, 'isLoggedIn').mockReturnValue(true);
-    vi.spyOn(browserMiddleware, 'initialiseMiddleware').mockResolvedValue(context.middleware);
+    vi.spyOn(browserMiddleware, 'initialiseMiddleware').mockResolvedValue({ middleware: context.middleware, checkpoints: [] });
     const facade = createRallarFacade();
     const resources = createBlackBoxRallarMessagingResourceController({ generation: () => 1, isCurrent: (generation) => generation === 1 });
     onTestFinished(() => {
@@ -861,7 +861,7 @@ async function refreshNormalRoom(): Promise<void> {
     });
     vi.spyOn(auth, 'readSession').mockReturnValue(context.session);
     vi.spyOn(auth, 'isLoggedIn').mockReturnValue(true);
-    vi.spyOn(browserMiddleware, 'initialiseMiddleware').mockResolvedValue(context.middleware);
+    vi.spyOn(browserMiddleware, 'initialiseMiddleware').mockResolvedValue({ middleware: context.middleware, checkpoints: [] });
     const facade = createRallarFacade();
     await facade.rooms.session(room).refresh();
 }
diff --git a/packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts b/packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts
index 351dcb3b0..d90cf089f 100644
--- a/packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts
+++ b/packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts
@@ -105,7 +105,7 @@ const webSocketClient = vi.mocked(mocks.ctx.middleware.webSocketQueueBox.socket)
 vi.mock(
     import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
     (): Partial<typeof MiddlewareModule> => ({
-        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
+        initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
     })
 );
 
```

- [ ] **Step 12: Run the focused tests green.** The Step 2 command.

Expected (measured on `5824c4d73`): `Test Files  9 passed (9)`, `Tests  83 passed (83)`; six further runs
`Tests  83 passed (83)`, and the checkpoint stores file alone eight times `Tests  6 passed (6)`.

- [ ] **Step 13: Measure the bundles; raise a crossed budget to the next whole KiB.** The measuring script and the
      headless test write their bundles under `os.tmpdir()`, which every worktree of the machine shares: measure with a
      private `TMPDIR`, or a concurrent run elsewhere overwrites the bundle between the build and the read.

```sh
TMPDIR="$TMPDIR/i2b-bundles" npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
TMPDIR="$TMPDIR/i2b-bundles" npx vitest run packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless
```

Measured on `5824c4d73` (brotli KiB, three decimals from the built bundle): `browser/rallar.ts` 237.287 (235.214 on
Task 4's tree; 234.710 after Task 3; 234.439 after Task 2; 234.340 at `5e06c6ab0`); the headless agent 302.151
(299.780 on Task 4's tree; 299.520 after Task 3; 299.448 after Task 2, budget 300 since Task 1). This task's share is
+2.073 KiB of the facade and +2.371 of the headless agent: it makes Tasks 2–4's dirty set, capture, writer, restore
and lane reachable from the facade. Raise `packages/shared-web/bundle-budgets.json` `browser/rallar.ts` 236 → 238 and
`packages/tests/rallar-black-box-headless/headless-bundle-budget.json` `brotliBudgetKiB` 300 → 303, the next whole KiB
above each figure, with the figures in the commit message (the maintainer's ruling: budgets are adjustable; R-I2b-39).
W-C's prototype read 236.151 / 300.935 over a smaller scaffold of Tasks 3–4. Before the raise the check prints
`over` for `browser/rallar.ts` and the headless boundary test fails.

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/bundle-budgets.json b/packages/shared-web/bundle-budgets.json
index 9c2c35eb3..1997ab677 100644
--- a/packages/shared-web/bundle-budgets.json
+++ b/packages/shared-web/bundle-budgets.json
@@ -1,5 +1,5 @@
 {
-  "browser/rallar.ts": 236,
+  "browser/rallar.ts": 238,
   "browser/rallar-core.ts": 100,
   "browser/rallar-realtime.ts": 100,
   "browser/rallar-data.ts": 20,
diff --git a/packages/tests/rallar-black-box-headless/headless-bundle-budget.json b/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
index e9c1310eb..36bb40491 100644
--- a/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
+++ b/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
@@ -1,3 +1,3 @@
 {
-  "brotliBudgetKiB": 300
+  "brotliBudgetKiB": 303
 }
```

- [ ] **Step 14: Docs.** The API reference states the tier, the settings, the loss window, the two-tab limit (D132),
      the `seq` refusal (D131), the lag rule and the `delayed` health; the browser README names the two new files; the
      inbound README's durability routing names the tier (receivers keep it in memory, as `local-outbox`).

<!-- dprint-ignore -->
```diff
diff --git a/docs/rallar-api-reference.md b/docs/rallar-api-reference.md
index 5a2bd8c17..3232162c8 100644
--- a/docs/rallar-api-reference.md
+++ b/docs/rallar-api-reference.md
@@ -619,7 +619,8 @@ Both lanes expose:
 volatile with a 30 s deadline: kept in the memory pair only, no IndexedDB. They
 track no receipt unless the send states `ack` (or `qos.ack`); without one,
 `transport-accepted` is terminal. Opt in to browser storage with
-`qos: { durability: { algo: 'local-outbox' } }`.
+`qos: { durability: { algo: 'local-outbox' } }`, or to a checkpointed memory
+send with `qos: { durability: { algo: 'local-checkpoint' } }`.
 
 `messages.room<T>(definition)` creates a room channel directly;
 `roomSession.message(...)` delegates to it. A typed channel exposes `send`,
@@ -674,6 +675,41 @@ message. A lane send names no channel, so it always refuses. A WS send with
 scope `world` or `all`, and a `best-effort` send, ask for no receipt unless
 the send states `ack`.
 
+`durability: 'local-checkpoint'` sits between `volatile` and `local-outbox`. The
+send is admitted and dispatched from memory and spends no storage operation on
+its way to the carrier; the tab that owns the session's work checkpoints what
+changed into the browser database, in one IndexedDB transaction, at most once
+per interval target (1 s) and when the page hides (`visibilitychange` to
+hidden, `pagehide` or `freeze`), and writes nothing while nothing changed. The
+next connect that owns the session's work, after a reload or in another tab,
+restores the checkpoint before its first work batch: a message it reserved
+retries under the lease rule, one whose deadline passed settles `expired`, and
+a restored message has no handle. Receivers keep it in memory, as they keep
+`local-outbox`. The limits are stated:
+
+- **The loss window.** What was admitted after the last completed checkpoint is
+  lost with the page: up to one interval target, and more when the page closes
+  before its hide flush completes, since the flush is started and not awaited.
+  An interrupted checkpoint leaves the previous one intact.
+- **One tab checkpoints.** Only the tab that owns the session's work writes and
+  restores the checkpoint. A waiting tab's `local-checkpoint` sends dispatch from
+  that tab's memory, are lost with it, and read `admittedDurable: false`.
+- **No positions.** A send that states a `seq` is refused `unsupported`, since a
+  restored copy could reuse a position the receiver already saw; the ordering
+  key alone and latest-wins sends are admitted.
+- **Lag follows `onStorageUnavailable`.** While a checkpoint store's oldest
+  unsaved change is older than the interval target its `health` reads
+  `delayed`; beyond the recovery-lag bound (10 s) it reads `failing` with cause
+  `checkpoint-lag`, and new `local-checkpoint` sends follow the channel's
+  `onStorageUnavailable` (`failed` with `storage-unavailable`, or one volatile
+  send with a `durabilityDowngrade`) until a checkpoint completes. A browser
+  without IndexedDB refuses them with cause `missing`, as it refuses durable
+  sends.
+
+The interval target and the recovery-lag bound are settings of the browser
+composition (`checkpointIntervalMs`, `checkpointLagBoundMs` on the store
+factory's input), 1,000 ms and 10,000 ms by default.
+
 Two tabs of one session share its durable stores, and one of them drains them:
 where the browser has the Locks API, the tab holding the session's
 durable-owner lock sends every tab's durable messages, and when it disconnects
@@ -693,8 +729,8 @@ own, as before.
 A browser without IndexedDB has no durable storage and no memory stand-in:
 each connect decides that once, and its durable sends follow the same rule
 without reaching the carrier. Any other storage failure is tried again by the
-next durable send. The first durable admission of a connect asks for
-persistent storage: it reads `navigator.storage.persisted()` and, unless the
+next durable send. The first durable or `local-checkpoint` admission of a
+connect asks for persistent storage: it reads `navigator.storage.persisted()` and, unless the
 origin already persists, calls `navigator.storage.persist()`; the send awaits
 neither, and the outcome arrives as a `persist` event on the storage
 diagnostics port. A denial is asked again by the next connect.
@@ -715,10 +751,15 @@ every `ALStorageEvent`:
   by the WS and RTC lanes and reports once per lane, as `<store id>/ws` and
   `<store id>/rtc`. A creation or reset of the database is reported by each
   store of the connect that found it; a later connect reads the database as it is;
-- `health`: a store's `ALStorageHealthState` on each change of status only,
-  `failing` at the first storage failure and `healthy` at the first commit
-  after it, with the failure as `lastFailure`; a database evicted under the
-  document reads `failing` with cause `evicted`;
+- `health`: a store's `ALStorageHealthState` on each change of status
+  (`ALStorageHealthStatus`) only, `failing` at the first storage failure and
+  `healthy` at the first commit after it, with the failure as `lastFailure`; a
+  database evicted under the document reads `failing` with cause `evicted`. A
+  checkpoint store (`browser-ws-client-checkpoint:<sessionId>`,
+  `browser-rtc-overlay-checkpoint:<sessionId>`) also reads `delayed` while its
+  oldest unsaved change is older than the interval target, with that age as
+  `oldestUnsavedAgeMs`, and `failing` with cause `checkpoint-lag` beyond the
+  recovery-lag bound;
 - `persist`: the outcome of the connect's one persistence request
   (`ALStoragePersistOutcome`).
 
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-web/browser/README.md b/packages/shared-web/browser/README.md
index 1a9ae58f5..6b3981288 100644
--- a/packages/shared-web/browser/README.md
+++ b/packages/shared-web/browser/README.md
@@ -181,8 +181,30 @@ The browser transport storage and WebSocket owners are feature-colocated:
   the connect resolved, whose durable pairs are always IndexedDB;
   [browser-al-storage-availability.ts](./al-runtime/browser-al-storage-availability.ts)
   owns the connect's storage availability (`missing` without IndexedDB, any
-  other cause re-decided by the next durable admission) and its one request
-  for persistent storage;
+  other cause re-decided by the next durable admission), the checkpoint lane's
+  skip (`missing`, or a checkpoint store whose health reads `failing` with cause
+  `checkpoint-lag`, until that store reads `healthy` or `delayed` again) and its
+  one request for persistent storage, asked by the first durable or
+  `local-checkpoint` admission;
+  [browser-al-checkpoint-stores.ts](./al-runtime/browser-al-checkpoint-stores.ts)
+  owns the connect's two checkpoint pairs, one per outbound carrier under the
+  store ids `browser-ws-client-checkpoint:<sessionId>` and
+  `browser-rtc-overlay-checkpoint:<sessionId>`: a memory pair a
+  `local-checkpoint` admission goes to, whose writer checkpoints it into the
+  scope's database while the connect owns the session's work. The settings
+  `checkpointIntervalMs` (1,000 ms) and `checkpointLagBoundMs` (10,000 ms) sit on
+  the store factory input and default there. The pairs are built once per connect
+  under its claim, after `configureBrowserALRuntimeStores` registered their
+  factories beside each outbound scope's durable pair, and the WS client and the
+  RTC overlay each take their own;
+  [browser-page-lifecycle-flush.ts](./al-runtime/browser-page-lifecycle-flush.ts)
+  is the one adapter of the page lifecycle: per connect, and only once the
+  connect owns the session's work,
+  [BrowserTransportRuntime.init](./connection/browser-transport-runtime.ts)
+  listens for `visibilitychange` to hidden, `pagehide` and `freeze`, each of which
+  starts both checkpoints without awaiting them, and removes the listeners when
+  the connect ends. It flushes the two checkpoint ports `initialiseMiddleware`
+  returns beside the middleware, which never carries them;
   [browser-al-runtime-cleanup.ts](./al-runtime/browser-al-runtime-cleanup.ts)
   owns IndexedDB scanning, expiry scheduling, and session cleanup over every
   scope's database that `indexedDB.databases()` lists, or the current scope's
```

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/inbound/README.md b/packages/shared/alm/inbound/README.md
index 4ece4640d..2b65d67fb 100644
--- a/packages/shared/alm/inbound/README.md
+++ b/packages/shared/alm/inbound/README.md
@@ -70,8 +70,9 @@ WS server and Node keep the always-owned default.
 - **The durability is the sender's, carried on the envelope.** A data message goes to
   the lane [`resolveALInboundStoreDurability`](./lane/resolve-al-inbound-store-durability.ts)
   names from the envelope's normalized `qos.durability`: the IndexedDB lane exactly when
-  it is `local-inbox`. `local-outbox` keeps the sender's copy only, so it does not make
-  the receiver durable; `volatile` and the default do not either. No receiver-side
+  it is `local-inbox`. `local-checkpoint` and `local-outbox` keep the sender's copy
+  only, so they do not make the receiver durable; `volatile` and the default do not
+  either. No receiver-side
   policy moves the decision, and every copy and retry of one message resolves to the
   same lane.
 - **The origin's own ACK short-circuits.** An acknowledgement of a message this peer
```

- [ ] **Step 15: Format the touched files only, then the checks.**

```sh
npx dprint fmt docs/rallar-api-reference.md \
  packages/shared-web/browser/README.md \
  packages/shared-web/browser/al-runtime/browser-al-checkpoint-stores.ts \
  packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts \
  packages/shared-web/browser/al-runtime/browser-al-storage-availability.ts \
  packages/shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts \
  packages/shared-web/browser/connection/browser-transport-runtime.ts \
  packages/shared-web/browser/connection/initialise-browser-middleware.ts \
  packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts \
  packages/shared-web/browser/rallar-core.ts \
  packages/shared-web/browser/rallar.ts \
  packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts \
  packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts \
  packages/shared-web/bundle-budgets.json \
  packages/shared/alm/ALRuntimeStoreRegistry.ts \
  packages/shared/alm/inbound/README.md \
  packages/shared/services/ws-queue-box-client-service.ts \
  packages/tests/rallar-black-box-headless/headless-bundle-budget.json \
  packages/tests/shared-web/al-runtime/browser-al-checkpoint-stores.test.ts \
  packages/tests/shared-web/al-runtime/browser-al-storage-availability.test.ts \
  packages/tests/shared-web/al-runtime/browser-page-lifecycle-flush.test.ts \
  packages/tests/shared-web/al-runtime/fake-page-lifecycle.ts \
  packages/tests/shared-web/connection/browser-transport-page-lifecycle.test.ts \
  packages/tests/shared-web/connection/initialise-browser-middleware.test.ts \
  packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts \
  packages/tests/shared-web/messages/browser-message-storage-unavailable.test.ts \
  packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts \
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
  packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts \
  packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts \
  packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts \
  packages/tests/shared-web/calls/rallar-calls.test.ts packages/tests/shared-web/composition/browser-facade-behavior.test.ts \
  packages/tests/shared-web/composition/browser-runtime-construction.test.ts packages/tests/shared-web/connection/browser-transport-cleanup.test.ts \
  packages/tests/shared-web/director/browser-director-relay-runtime.test.ts packages/tests/shared-web/media/browser-media-sources.test.ts \
  packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts packages/tests/shared-web/messages/browser-typed-message-channels.test.ts \
  packages/tests/shared-web/people/people-event-test-runtime.ts packages/tests/shared-web/rallar-facade-defaults.test.ts \
  packages/tests/shared-web/rallar-startup-lifecycle.test.ts packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts \
  packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts \
  packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts packages/tests/shared-web/rooms/room-event-test-runtime.ts \
  packages/tests/shared-web/rooms/room-workflow-test-runtime.ts packages/tests/shared-web/rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts \
  packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts \
  packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts packages/tests/shared-web/session/browser-auth-session-contract-fixture.ts \
  packages/tests/shared-web/session/browser-auth-session-contract.test.ts packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts \
  packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
npm --workspace @ar-eye-hunter/shared-test run typecheck
(cd apps/api-v1 && deno task check)
rm -rf apps/api-v1/node_modules/.deno && find apps/api-v1/node_modules -maxdepth 2 -type l ! -exec test -e {} \; -delete
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared-web packages/tests/shared/alm packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/services packages/tests/shared/multicast packages/tests/shared-test/rallar-browser-runtime packages/tests/rallar-black-box-headless   # sandbox disabled
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts
npm run check:test-reachability
```

Expected (measured on `5824c4d73`): every typecheck clean; `deno task check` exit 0; tests typecheck
`check-tests-typecheck: 1444 test files enforced, 0 files carrying known debt (0 errors).` and `PASS: no new type errors
in the maintained test project`; the broad run `Test Files  347 passed (347)`, `Tests  3468 passed (3468)`; the pins
unedited and green (`Tests  26 passed (26)` over the four pin files); the snapshots green;
`| browser/rallar.ts | 1110.8 KiB | 289.5 KiB | 237.3 KiB | < 238.0 KiB | ok |`; reachability
`Test reachability: 1746 test files, 1740 reached by CI, 6 manual.` (three new test files). No code under
`alm/inbound/**` or `alm/work/**` changes (the inbound README only), so the Postgres integration run is not owed.

- [ ] **Step 16: Commit, then the changed-range gates.**

```sh
git add docs packages
git commit -F - <<'MSG'
Compose the local-checkpoint lane in the browser and flush it on hide

The browser store factory registers, beside each outbound scope's durable pair, a
checkpoint pair under its own store id (browser-ws-client-checkpoint:<sid>,
browser-rtc-overlay-checkpoint:<sid>) with its own health. Its input takes
checkpointIntervalMs and checkpointLagBoundMs, 1,000 and 10,000 ms by default. The
connect builds both pairs once under its claim on the session's work and hands
each carrier its own; initialiseMiddleware returns the two pairs' checkpoint ports
beside the middleware, which never carries them.

BrowserPageLifecycleFlush is the one page-lifecycle adapter: per connect, and only
once the connect owns the session's work, visibilitychange to hidden, pagehide and
freeze call flush() on both checkpoint ports without awaiting them; the listeners
go when the connect ends.

A checkpoint store whose health reads failing with checkpoint-lag skips the
checkpoint lane, so new local-checkpoint sends follow onStorageUnavailable until
that store is healthy or delayed again; missing IndexedDB skips it as it skips the
durable lane. A checkpoint admission leaves the connect's availability alone and
asks for persistent storage on the first one, durable or not. ALStorageHealthStatus
is public on rallar.ts and rallar-core.ts.

The checkpoint writer, its restore and the lane become reachable from the facade
here: browser/rallar.ts measures 237.287 KiB (235.214 before), so its budget rises
236 -> 238 KiB; the headless agent measures 302.151 KiB (299.780 before), so its
budget rises 300 -> 303 KiB.

D8 reuse: the runtime-store registry (a checkpoint factory beside the outbound one, resolved like the durable pair), the volatile memory-pair factory and createBrowserStoreOptions' per-store health and reset sink, BrowserALStorageAvailability's skip path and onStorageUnavailable dispatch, ALDurableWorkOwnership.owned with the work-membership's takeover subscription, an AbortController for the listeners, LatestRepository for the per-store lag; no new timer, the lag set is keyed latest state.
MSG
```

```sh
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured over `5e06c6ab0..5824c4d73`): `PASS: no new repository style findings`;
`PASS: all 32 current structure-coupling candidates are individually classified`,
`PASS: changed-range structure-coupling review has complete individual classifications`,
`PASS: registry entries are complete and current`. The touched-but-classified candidates include the file's existing
`browser-message-storage-unavailable.test.ts:54` and `:78` entries and the retyped mock files' existing entries; the new
tests observe a recording port fake and a flush log, never a mock's call count (a first draft with
`toHaveBeenCalledTimes` drew ten unclassified candidates).

---

### Task 6: Pins: the send path's zero extended to the tier, one write per checkpoint, nothing while clean; bundle figures

Prototyped in scratch as commit `ee43c264a` on Task 5's prototype `5798b224e`, over W-A's Tasks 1–2 and W-C's
scaffold of Tasks 3–4; reconciled at assembly to the real Tasks 3–4 (R-I2b-33: the writer's timer is
`Timers { schedule }`; Task 4 owns the fixture's `checkpointStores` pass-through, R-I2b-21). Decisions D55 (the zero pin: zero `al-admission` and zero non-probe `al-work`
operations, the idle owners' probes reported beside it), D87 (budgets per tier: `local-checkpoint` spends no storage
operation on the send path, a checkpoint at most one readwrite and none while clean; storage and bundle figures in the
PR body), D129 (the checkpoint's cost pin is one readwrite with as many requests as dirty rows); QoS plan §7.2 and the
§9.2 rows "No storage work on the `local-checkpoint` send path" and "Checkpoint cost stays within budget, and nothing
runs while clean"; rulings R-I2b-10 (the outbound README's stale pin text), R-I2b-21 (the fixture is Task 4's),
R-I2b-39 (the budgets Task 5 set: `browser/rallar.ts` 238, headless 303), R-I2b-41 (the red is a mutation check).

**Assembly.** Commit `05a543f37` on `5824c4d73` (Task 5) in the composed chain. Bundle figures are read with a private
`TMPDIR` (R-I2b-23). After every `cd apps/api-v1 && deno task check`, run `rm -rf apps/api-v1/node_modules/.deno` and
`find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete`. File:line anchors are at `5e06c6ab0`; Task 1 rewrote the file's `persist:` plan literals to
`lane:` (W-A's `task-1.md` Step 7), which moves no anchor below.

**Files**

- Test (modify): `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` — one `describe` after the D55
  volatile zero case (after `:295`, before the comment at `:297`), two constants beside `NO_DEFERRAL` (`:75`), the
  manual checkpoint timers helper beside `createDefaultSessionBudget` (before `:699`), three imports.
- Modify (docs): `packages/shared/alm/outbound/README.md` — the storage-pin paragraph (`:136`): the durable send's
  stale "10 `al-admission` and 11 `al-work`" becomes the test's 10 and 9 (R-I2b-10), and the paragraph states the
  checkpoint pin.
- Not touched: the warm ledger (`al-indexeddb-transaction-ledger.test.ts`, chain 6 / total 8 / 37 requests / 10 + 5),
  the cold pin (10 + 9), the inbound pins (9/11, 11/13, 5/7), the D55 volatile case itself, the empty-audience pin and
  the storage snapshot (`al-storage-snapshot.test.ts`): every figure unedited. No source file.

**Interfaces**

- Consumes: Task 4's `createCheckpointALOutboundRuntimeStores(input)` in `packages/shared/alm/al-runtime-stores.ts`
  (`decodePrepared`, `namespace`, `dbName`, `observer`, `ownership`, `intervalMs`, `lagBoundMs`, `timers`) and its
  `ALCheckpointOutboundRuntimeStores.workQueue`; Task 3's `ALCheckpointWriter.Timers` in
  `packages/shared/alm/checkpoint/al-checkpoint-writer.ts` (`schedule(run, delayMs)` answering its cancel), whose writer
  arms one timer at the first change,
  never re-arms an armed timer, and at fire writes once through the backend's observed write
  (`{ owner: 'al-admission', kind: 'write' }`, the kind `IndexedDbAdmissionBackend.write` reports, `:202`) and one
  `writeIndexedDbAdmissionMutations`; Task 4's runtime routes `lane: 'checkpoint'` to the checkpoint lane and an
  owner's admission reads `durable: true`; Task 4's `OutboundTestRuntimeInput.checkpointStores?` in
  `outbound-runtime-test-fixture.ts`; Task 1's `ALOutboundDispatchPlan.lane`.
- Produces: no production interface; the pin.

**D8 reuse inspection.** The case reuses the file's own instruments: `createCountingIndexedDbOperationObserver`
(`indexed-db-operation-observer.ts:55-64`) with `reset()` between the three windows, `computeNonProbeWorkOperations`
(`:708`, so the idle durable owner's probes stay reported beside the zero exactly as the volatile case reads them),
`readSettledInboundWork` (`:693`, despite its name a generic "every queue row completed" read, already used on a
volatile work queue at `:724`), `createIndexedDbOutboundTestStores`, `createDefaultOutboundTestRuntime` and
`createOutboundMessage`. The checkpoint is counted through the same observer the pair is built with, not a second
counter; its timer is the writer's injected `Timers` port (`schedule`) held by a small manual holder, so the test fires the one
interval the sends armed instead of sleeping a second (no fake-timer install, which would stall the engine and
fake-indexeddb). `al-indexeddb-transaction-ledger.test.ts`'s ledger was considered for the write and not used: the pin
D87 names is the operation count, and the ledger's request and phase figures belong to the durable chain.

**The storage snapshot stays unedited.** Its standard workload is the durable superseding workload and its volatile
replay (`al-storage-snapshot.test.ts:122-164`); the tier is not part of it, and its row counts would not be a fixed pin
for the tier: what a `local-checkpoint` workload leaves in IndexedDB is the same `entries`/`alm-work` rows (D129) at the
moment of the last completed checkpoint, a function of the interval timing. The tier's storage cost is pinned here as
operations (one write per checkpoint, none while clean); its footprint is reported in the PR body beside the bundle
figures (D87), not pinned.

**Limits.** The pin counts operations, not IndexedDB requests: the checkpoint's one readwrite carries as many requests
as dirty rows (D129), which the observer does not see. The idle window is the writer's own: the durable owner's probes
on its cadence are covered by the existing idle-owner cases (`:299-372`), not repeated here.

- [ ] **Step 1: Write the pin.**

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts b/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
index 0e3352ad4..5cf86aac8 100644
--- a/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
+++ b/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
@@ -6,9 +6,11 @@ import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
 import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
 import { decodeALAdmissionString } from '@shared/alm/al-admission-value-validation.ts';
 import {
+    createCheckpointALOutboundRuntimeStores,
     createVolatileALInboundRuntimeStores,
     createVolatileALOutboundRuntimeStores
 } from '@shared/alm/al-runtime-stores.ts';
+import type { ALCheckpointWriter } from '@shared/alm/checkpoint/al-checkpoint-writer.ts';
 import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
 import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
 import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
@@ -24,6 +26,7 @@ import {
     AL_VOLATILE_SESSION_MAX_BYTES,
     ALVolatileSessionBudget
 } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
+import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
 import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
 import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';
 import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
@@ -72,6 +75,8 @@ const INBOUND_IDLE_ROUNDS_PROBED_AT_LEAST = INBOUND_IDLE_ROUNDS / 2;
 const WORK_TYPES = ['AL_OUTBOUND:counts', 'WS_OUTBOX'] as const;
 /** The resource inbox's timeout-claim and fairness rate-limit window, so the pin crosses at least one of each. */
 const IDLE_OWNER_RATE_WINDOW_MS = 60_000;
+const CHECKPOINT_INTERVAL_MS = 1_000;
+const CHECKPOINT_LAG_BOUND_MS = 10_000;
 const NO_DEFERRAL: ALOutboundWorkDeferral = {
     dequeue: { types: new Set<string>(), readyAtMs: undefined },
     leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true }
@@ -294,6 +299,63 @@ describe('outbound volatile send IndexedDB volume', () => {
     });
 });
 
+describe('outbound local-checkpoint send IndexedDB volume', () => {
+    // The send path is the volatile zero; the checkpoint is counted on its own, one write per interval and none while clean.
+    it('sends local-checkpoint messages beside a durable pair in 0 al-admission and 0 non-probe al-work operations, and checkpoints them in one write', async () => {
+        const observer = createCountingIndexedDbOperationObserver();
+        const timers = createManualCheckpointTimers();
+        const sent: string[] = [];
+        const checkpointStores = createCheckpointALOutboundRuntimeStores({
+            decodePrepared: decodeOutboundTestPayload,
+            namespace: 'outbound-checkpoint-send',
+            dbName: `outbound-checkpoint-send-${crypto.randomUUID()}`,
+            observer,
+            ownership: ALWAYS_OWNED_AL_DURABLE_WORK,
+            intervalMs: CHECKPOINT_INTERVAL_MS,
+            lagBoundMs: CHECKPOINT_LAG_BOUND_MS,
+            timers
+        });
+        const runtime = createDefaultOutboundTestRuntime({
+            stores: createIndexedDbOutboundTestStores({ observer, namespace: 'outbound-checkpoint-durable' }),
+            checkpointStores,
+            planOutgoingMessage: (msg) => ({
+                msg,
+                dropReasonCode: undefined,
+                lane: 'checkpoint',
+                preparedMessages: [{ kind: 'send' }]
+            }),
+            sendPreparedMessage: async () => {
+                sent.push('send');
+                return { status: 'sent' as const, submissionAttempted: true };
+            }
+        });
+        await runtime.ready();
+        observer.reset();
+
+        for (const msgId of ['msg-checkpoint-1', 'msg-checkpoint-2', 'msg-checkpoint-3']) {
+            const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage(msgId));
+            expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: true });
+        }
+        await vi.waitFor(() => expect(sent).toEqual(['send', 'send', 'send']));
+        await vi.waitFor(async () => expect(await readSettledInboundWork(checkpointStores.workQueue)).toBe(true));
+        const sends = observer.getCounts();
+        const armedBySends = timers.armed();
+        observer.reset();
+        timers.fire();
+        await vi.waitFor(() => expect(observer.getCounts().byKind.write).toBe(1));
+        const checkpoint = observer.getCounts();
+        observer.reset();
+
+        expect(sends.byOwner['al-admission'], 'a local-checkpoint send commits nothing to IndexedDB').toBe(0);
+        expect(computeNonProbeWorkOperations(sends), 'no non-probe al-work operation').toBe(0);
+        expect(armedBySends, 'the first change arms the one interval timer and later ones never postpone it').toBe(1);
+        expect(checkpoint.total, 'one checkpoint is one IndexedDB write, whatever the sends changed').toBe(1);
+        expect(timers.armed(), 'nothing is armed while the lane is clean').toBe(0);
+        expect(observer.getCounts().total, 'nothing runs while the lane is clean').toBe(0);
+        runtime.dispose();
+    });
+});
+
 // The first use runs the durable owner's lazy bootstrap batch (`enqueueIfAbsent` awaits
 // `ready()`); empty finalize, claim, and timeout-claim reads are probes.
 describe('an idle durable outbound owner beside a volatile send', () => {
@@ -696,6 +758,23 @@ async function readSettledInboundWork(workQueue: QueueBoxResourceEntryRepository
     return rows.length > 0 && rows.every((row) => row?.status === EntityStatus.COMPLETED);
 }
 
+/** Holds the checkpoint writer's interval timers, so the test fires the one it armed instead of waiting a second. */
+function createManualCheckpointTimers(): ALCheckpointWriter.Timers & { armed(): number; fire(): void; } {
+    const pending = new Set<() => void>();
+    return {
+        schedule: (run) => {
+            pending.add(run);
+            return () => pending.delete(run);
+        },
+        armed: () => pending.size,
+        fire: () => {
+            const due = [...pending];
+            pending.clear();
+            due.forEach((callback) => callback());
+        }
+    };
+}
+
 /** The production bound over one session's memory pairs (D74). */
 function createDefaultSessionBudget(): ALVolatileSessionBudget {
     return new ALVolatileSessionBudget({
```

- [ ] **Step 2: Run it, then show that it bites (R-I2b-41).** Tasks 3–5 built the behaviour and Task 4's fixture passes
      the pair through, so the pin passes at its first run. Change the pin's plan to `lane: 'durable'` (the sends then
      commit to the durable pair and never reach the checkpoint pair), run it, and restore `lane: 'checkpoint'`:

```sh
npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
```

Expected (measured on `05a543f37`): first `Test Files  1 passed (1)`, `Tests  21 passed (21)`; with `lane: 'durable'`
`Test Files  1 failed (1)`, `Tests  1 failed | 20 passed (21)`, `AssertionError: expected false to be true` at the
settled read of the checkpoint pair's queue.

- [ ] **Step 3: Run it green, three times.**

```sh
npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
for i in 1 2 3; do npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts -t 'local-checkpoint'; done
```

Expected (measured on `05a543f37`): `Test Files  1 passed (1)`, `Tests  21 passed (21)`; three times
`Tests  1 passed | 20 skipped (21)`.

- [ ] **Step 4: The outbound README's pin paragraph (R-I2b-10).**

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared/alm/outbound/README.md b/packages/shared/alm/outbound/README.md
index cef543682..b3cf56aa5 100644
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -184,8 +184,10 @@ holds). A `checkpoint` plan
 
 The storage cost is pinned in
 [`al-indexeddb-operation-counts.test.ts`](../../../tests/shared/alm/al-indexeddb-operation-counts.test.ts):
-one durable send spends 10 `al-admission` and 11 `al-work` IndexedDB operations; one
-volatile send beside a durable pair spends 0 `al-admission` and 0 non-probe `al-work` operations. The
+one durable send spends 10 `al-admission` and 9 `al-work` IndexedDB operations; one
+volatile send beside a durable pair spends 0 `al-admission` and 0 non-probe `al-work` operations, and
+so do `local-checkpoint` sends on the checkpoint lane, whose checkpoint is counted on its own: one
+IndexedDB `write` per interval, whatever the sends changed, and none while the lane is clean. The
 idle durable owner's probes (`work-page`, `work-probe`) are reported beside that zero, never inside it
 (D55): a cold runtime's first volatile send runs the durable owner's one-time bootstrap batch over an
 empty queue, which spends only probes, and its second send spends nothing. A queue read that reserves,
```

- [ ] **Step 5: Measure and record the bundle figures.** This task changes no source, so its figures are Task 5's;
      measure them on the assembled tree anyway, with a private `TMPDIR` (the bundles land under `os.tmpdir()`, which every
      worktree shares):

```sh
TMPDIR="$TMPDIR/i2b-bundles" npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
TMPDIR="$TMPDIR/i2b-bundles" npx vitest run packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless
```

Expected (measured on `05a543f37`): `| browser/rallar.ts | 1110.8 KiB | 289.5 KiB | 237.3 KiB | < 238.0 KiB | ok |`
(237.287 KiB from the built bundle) and the headless agent 302.151 KiB against 303; `Test Files  3 passed (3)`. The
figures go in the PR body beside the storage figures (D87).

- [ ] **Step 6: The checks.**

```sh
npx dprint fmt packages/shared/alm/outbound/README.md packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts
npx vitest run packages/tests/shared/alm packages/tests/shared/al-outbound-message-runtime.test.ts
npm run check:test-reachability
```

Expected (measured on `05a543f37`): `check-tests-typecheck: 1444 test files enforced, 0 files carrying known debt (0
errors).`, `PASS`; the four pin files `Test Files  4 passed (4)`, `Tests  27 passed (27)` with every earlier figure
unedited; the alm run `Test Files  112 passed (112)`, `Tests  1351 passed (1351)`; reachability
`Test reachability: 1746 test files, 1740 reached by CI, 6 manual.` (no file added). Nothing
under `alm/inbound/**` or `alm/work/**` changes, so the Postgres integration run is not owed.

- [ ] **Step 7: Commit, then the changed-range gates.**

```sh
git add packages/shared/alm/outbound/README.md packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
git commit -F - <<'MSG'
Pin the local-checkpoint send at zero storage and its checkpoint at one write

The operation-counts test's zero case gains the checkpoint lane: three
local-checkpoint sends beside a durable pair spend 0 al-admission and 0 non-probe
al-work operations; the first change arms the one interval timer; firing it spends
exactly one IndexedDB write, counted on its own; and a clean lane arms nothing and
spends nothing. The storage snapshot's standard workload stays the durable
superseding workload and its volatile replay, unedited. The outbound README's pin
text reads the test's 10 and 9 for the durable send and states the checkpoint pin.

browser/rallar.ts measures 237.287 KiB against 238; the headless agent measures
302.151 KiB against 303. The warm ledger, cold, inbound and snapshot pins are
unedited.

D8 reuse: the counting IndexedDB operation observer, computeNonProbeWorkOperations and the settled-work reader of the same test file, the outbound fixture and createIndexedDbOutboundTestStores, the shared checkpoint store factory and its injected schedule timer; no new counter.
MSG
```

```sh
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured over `5e06c6ab0..05a543f37`): `PASS: no new repository style findings`;
`PASS: all 32 current structure-coupling candidates are individually classified` (the manual timers are a port fake,
not a mock),
`PASS: changed-range structure-coupling review has complete individual classifications`,
`PASS: registry entries are complete and current`.

---

### Task 7: The lane scenarios `checkpoint-recovery`, `checkpoint-lag` and `flush-on-hide`

Prototyped in scratch as commit `8e24272bc` on W-A's Task 2 (`34546680a`, after `git am patch-task-1.patch
patch-task-2.patch` on `5e06c6ab0`); red then green, each red recorded below. It consumes the decided shapes of Tasks 3–5
through the browser only (no import of their code): the tier value, the checkpoint store ids, the `delayed`/`failing`
health statuses with cause `checkpoint-lag`, the 1,000 ms interval and 10,000 ms bound, the checkpoint store's
`recovery` event. D129, D132, D133, D134, D135; R-I2b-2, R-I2b-5, R-I2b-7, R-I2b-8, R-I2b-9, R-I2b-14.

**Assembly.** Commit `a56823ca7` on `05a543f37` (Task 6) in the composed chain: W-D's patch applied unchanged (Task 3
already adds `'checkpoint-lag'` to `decode-alm-delivery-failure.ts`'s record, R-I2b-35). The red below was re-measured
with this task's tests on Task 6's tree and matches the prototype's; the Deno fixture's red (Step 7) is the
prototype's (the fixture models the writer and imports none of Tasks 3–6). Bundle figures are read with a private `TMPDIR` (R-I2b-23): the bundle script and the headless boundary test write
under `os.tmpdir()`, which every worktree of the machine shares. After every `cd apps/api-v1 && deno task check`, run
`rm -rf apps/api-v1/node_modules/.deno` and `find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete` (a
left-behind `.deno` breaks the next check). R-I2b-26, R-I2b-29, R-I2b-34 and
R-I2b-35 settle this task's open shapes; the D135 amendment is the `flush-on-hide` mechanism.

**What the three cells prove, and how.**

- `checkpoint-recovery` (every carrier, `two-agent`, a paired reload like `delivery-reload`): the sender holds its
  carrier with the native hold, resets the storage counters, sends one `local-checkpoint` original (`ack: 'receiver'`,
  `ttlMs` 77 000 like the takeover's), proves it admitted, enqueued, retained and unsubmitted, waits out the interval
  (an absent wait on a topic nothing emits, 1 000 + 1 000 ms), reads the counters and asserts `byKind.write > 0`, then
  `agent.reload`. The reloaded page waits out one lease (`toOwnerLeaseLapseWait`, 11 s), reconnects with the restored
  session, reads the old handle `unobservable`, waits for the checkpoint store's `recovery` reading `restored`
  (`toStoreRecoveryWait`, prefix `browser-rtc-overlay-checkpoint` over `rtc`, `browser-ws-client-checkpoint`
  otherwise) and asserts `claimed > 0`. The receiver proves the original absent before the reload, receives it once
  after, and proves no second copy.
- `checkpoint-lag` (every carrier, `two-agent`): the quota storage fault on both owners
  (`toStorageQuotaFaultCommands`); send 1 on the refusing default channel is admitted (the send path stores nothing);
  waits read the checkpoint store's `health` `delayed`, then `failing` with `lastFailure.cause: 'checkpoint-lag'`;
  send 2 fails `storage-unavailable`/`checkpoint-lag`/unsubmitted (storage-unavailable's refused-send helper, now taking
  the durability and the cause); the fault is released; a wait reads the store `healthy`; send 3 is admitted. The
  receiver gets sends 1 and 3, never 2.
- `flush-on-hide` (`ws` and `rtc`, `same-context`): the owner page holds its carrier, sends one `local-checkpoint`
  original and ends its recipe at once, inside the interval (no wait); the lane fires the page's `freeze` event, waits
  250 ms, crashes the renderer over CDP (`Page.crash`) and closes it; the successor page (same context and session)
  waits out one lease, connects restored, reads the checkpoint store `restored` with `claimed > 0`; the receiver gets
  the original once.

**Decisions (writer's, each with its reason).**

1. _The interval witness is the storage counters, not a `health` signal._ `ALStorageHealth` emits on status
   transitions only (`al-storage-health.ts:17-36`, `equals` on `status`), so a checkpoint store that writes in time
   emits nothing; a `delayed` on a healthy run would depend on how late the timer fires. The counters read the one
   operation the storage fault port also matches, so `checkpoint-recovery` and `checkpoint-lag` rest on one consumed
   contract: **the checkpoint's readwrite is observed as `{ owner: 'al-admission', kind: 'write' }`** (Tasks 3/5). The
   reset sits before the send and the send path writes nothing (the D55 extension, Task 6), so `byKind.write > 0` after
   the interval is the checkpoint. It asserts `> 0`, not `= 1`: under the RTC `drop` hold each attempt resubmits every
   50 ms (`alm-conformance-fault-commands.ts:43-46`), so a 2 s window can hold two checkpoints; the exact one-readwrite
   cost is Task 6's pin.
2. _Both restoring cells wait out one lease._ Under the hold the row is reserved (`read-al-outbound-dequeue-wait.ts`,
   the I2a-ii Task 6 finding) and the capture writes the current memory value (R-I2b-3), so the checkpoint holds it
   leased; a first batch before the lease ends claims nothing. The reloaded page (`checkpoint-recovery`) and the
   successor (`flush-on-hide`, through the successor prologue) wait 11 s before their connect. If Task 4's restore
   frees a dead document's reservations instead, the wait is harmless.
3. _`checkpoint-recovery` reads the interval write before it reloads._ Measured in Chromium 1228 headless (the lane's
   Playwright 1.61.1 browser, scratch probe): a readwrite of 20 × 2 KB rows started in a `pagehide` listener never
   landed on `page.reload()` or `page.close()` without `transaction.commit()` (0 of 4 each), and landed 2 of 4
   (reload) and 3 of 4 (close) with it. The reload's own flush is best effort (R-I2b-7), so the cell's restore must
   rest on the interval checkpoint, proven before the page ends. (`writeIndexedDbAdmissionMutations` calls no
   `commit()`, `write-indexed-db-admission-mutations.ts:47-80`; reported to the controller for Tasks 3/5.)
4. _`flush-on-hide` fires `freeze` and crashes the page instead of `Page.setWebLifecycleState`._ Measured in the same
   browser, headless shell and `channel: 'chromium'`, with and without Playwright's backgrounding flags, with a
   minimized window and with a second page in front: `Page.setWebLifecycleState({ state: 'frozen' })` returns ok on a
   visible page and does nothing (no `freeze` event, a 100 ms interval ticked 10 times in the "frozen" second); a
   headless page is never hidden. A synthetic `freeze` dispatched on `document` runs the listener D135 registers, and
   a write it starts lands before an immediate `Page.crash` (1 of 1); a crash alone saves nothing (0 of 1); a crashed
   page does not crash another page of its context, and its Web Lock is released at once (3 of 3). The crash excludes
   the `pagehide` flush and every later timer, so the successor restores only what the page saved before the crash.
   D135's wording "driven through CDP `Page.setWebLifecycleState`" needs the controller's amendment (open question 1).
5. _`flush-on-hide` joins the `same-context` family; no new `lifecycle` family._ It is two pages of one context like
   `durable-takeover` (owner, successor, receiver); only the owner page's end differs, so the cell, its observation
   files, the hosted exclusion (`HOSTED_ALM_LANE_FAMILIES`, `hetzner-alm-manifest-entries.ts:143-150`) and the
   successor's lease prologue are reused. A new family would add a fourth cell per carrier, widen
   `AlmConformanceLaneFamily` with its consumers and write observation files of its own for one scenario. The runner
   gains `SameContextPages.ownerEnd: 'close' | 'flush-and-crash'`; the spec picks it by scenario id, as it picks the
   reload navigation check today.
6. _`flush-on-hide` runs over `ws` and `rtc` only._ Over the fallback carrier a held original moves to the WS lane at a
   moment the lane cannot see, so which checkpoint store holds it when the page ends is open; the takeover's hand-over
   poll would push the flush past the interval.
7. _Layout._ `conformance/alm/scenarios/` holds 20 files, the `layout.directory-density` review threshold (the I2a-ii
   Task 6 finding), so the three scenarios live in the feature folder `scenarios/local-checkpoint/`. The interval and
   the lag bound are owned by the scenario that uses them (`CHECKPOINT_INTERVAL_MS` in `checkpoint-recovery.ts`,
   `CHECKPOINT_LAG_BOUND_MS` in `checkpoint-lag.ts`): `alm-conformance-budgets.ts` would reach 13 runtime exports
   (`file.responsibility-count`, found by the changed-style gate). The Deno-loaded catalog cannot import Task 5's
   defaults (`alm-conformance-session-commands.ts` states why for the store ids).
8. _The reload sync points become a scenario field._ `AlmConformanceScenarioDefinition.toReloadCheckpoint?` replaces
   the `'delivery-reload'` id test in `create-alm-conformance-recipes.ts:173-175`; the spec's navigation check reads
   the authored `almReloadCheckpoints` instead of the scenario id. The hosted combined recipe still collects reload
   checkpoints from `delivery-reload` only (`hetzner-alm-manifest-entries.ts:185-189`), which holds while the two
   checkpoint cells are withheld (Limits).
9. _Hosted manifests (R-I2b-8)._ `checkpoint-recovery` and `checkpoint-lag` are `two-agent` cells, so they join
   `HETZNER_WITHHELD_ALM_SCENARIOS` on every carrier; `flush-on-hide` is `same-context`, which no hosted entry carries.
   Manifests 18 and 22 regenerate byte-identical.
10. _Harness vocabulary is Task 1's._ W-A's Task 1 already widened `rallar-black-box-test-contracts.ts:330`,
    `alm-conformance-message-commands.ts:32`, `decode-alm-delivery-failure.ts`'s record, the send-input decoder's
    text, the capability text, the schema doc's list and `decodeLane`; this task adds none of them. The cause
    `checkpoint-lag` must join `decode-alm-delivery-failure.ts`'s exhaustive `ALStorageUnavailableCause` record in the
    task that adds the cause (Task 3), or `checkpoint-lag`'s refused send cannot be decoded.

**Files**

- Create: `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/local-checkpoint/checkpoint-recovery.ts`
  (195 lines), `…/checkpoint-lag.ts` (118), `…/flush-on-hide.ts` (93).
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts` — the three ids
  join `AlmConformanceScenarioId`; `toReloadCheckpoint?` joins the definition.
- Modify: `…/conformance/alm/create-alm-conformance-recipes.ts` — the imports, the catalog (`checkpointRecovery`,
  `checkpointLag` after `storageUnavailable`; `flushOnHide` after `durableTakeover`), the reload metadata from the
  definition (`:173-175`).
- Modify: `…/conformance/alm/scenarios/delivery-reload.ts` — `toReloadCheckpoint` becomes its definition's field.
- Modify: `…/conformance/alm/alm-conformance-session-commands.ts` — `RECOVERED_STORE_PREFIXES` gains `wsCheckpoint`
  and `rtcCheckpoint` (R-I2b-2's ids); new `toCheckpointStorePrefix(carrier)`.
- Modify: `…/conformance/alm/scenarios/storage-unavailable.ts` — `toStorageRefusedSendCommands(send, refusal)` and
  `toStorageScenarioPayload(step)` exported; its own recipe output is unchanged.
- Modify: `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts` (`:57-61`) — two withheld entries.
- Modify: `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts` (`:104-106` the carrier ceiling 480 →
  540 s, `:233` the reload check, `:314-318` the owner end), `tests/playwright/rallar-black-box/full-stack-same-context-run.ts`
  (`:18-22`, `:76`) — the owner end.
- Modify: `apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts` — the checkpoint model and
  ten Deno tests.
- Modify: `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (storage diagnostics: the
  checkpoint store ids, `delayed`, `oldestUnsavedAgeMs`, `checkpoint-lag`, the checkpoint stores' `recovery`; the
  R-I2b-9 distinction stated once), `schema-and-capabilities.md` (the same-context family's flush-and-crash end; the
  three cells), `alm-observation-artifact.md` (a `checkpoint` lane is left out of the regime with `volatile`).
- Test (create): `packages/tests/shared-test/alm-conformance-local-checkpoint.test.ts` (396 lines).
- Test (modify): `packages/tests/shared-test/alm-conformance-recipes.test.ts`, `alm-conformance-recipe-validation.test.ts`,
  `packages/tests/rallar-black-box/full-stack-same-context-run.test.ts`, `hetzner-alm-manifest-entries.test.ts`.
- Not touched: the identity assessments (`assess-alm-*`; like `durable-takeover`, the cells pin no message identity
  after the run), `hasIdentityEvidence`, the observation decoder (Task 1), `tests/manual-suites.json`, the manifests.

**Interfaces**

- Consumes (through the browser, Tasks 3–5): the `local-checkpoint` admission from memory with `enqueued: true` on the
  owner; the checkpoint readwrite observed as one `{ owner: 'al-admission', kind: 'write' }` operation (so the storage
  counters count it and the quota fault fails it); the health event `{ kind: 'health', storeId, status, lastFailure,
  lastRecoveryPointAtMs, oldestUnsavedAgeMs }` in that key order with `status` `'delayed'` and
  `lastFailure.cause: 'checkpoint-lag'`; a failed checkpoint write leaves its rows dirty and the timer retries, so the
  store reads `healthy` once the fault is released; the restore's first batch reporting `recovery`
  `restored { claimed }` under `browser-ws-client-checkpoint:<sid>` / `browser-rtc-overlay-checkpoint:<sid>`; the
  lifecycle adapter listening for `freeze` on `document`.
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // scenarios/local-checkpoint/*.ts
  export const checkpointRecovery: AlmConformanceScenarioDefinition; // two-agent, every carrier, FULL_TAGS, reload pair
  export const CHECKPOINT_INTERVAL_MS = 1_000;
  export const checkpointLag: AlmConformanceScenarioDefinition;      // two-agent, every carrier, FULL_TAGS
  export const CHECKPOINT_LAG_BOUND_MS = 10_000;
  export const flushOnHide: AlmConformanceScenarioDefinition;        // same-context, ['ws', 'rtc'], FULL_TAGS
  // alm-conformance-scenario-definition.ts
  readonly toReloadCheckpoint?: (step: AlmConformanceStepInput) => AlmReloadCheckpoint;
  // alm-conformance-session-commands.ts
  RECOVERED_STORE_PREFIXES.wsCheckpoint = 'browser-ws-client-checkpoint';
  RECOVERED_STORE_PREFIXES.rtcCheckpoint = 'browser-rtc-overlay-checkpoint';
  export function toCheckpointStorePrefix(carrier: AlmConformanceCarrier): string; // rtc → overlay, else ws client
  // scenarios/storage-unavailable.ts
  export interface AlmConformanceStorageRefusal { durability: 'local-checkpoint' | 'local-outbox'; cause: 'checkpoint-lag' | 'quota' }
  export function toStorageRefusedSendCommands(send, refusal: AlmConformanceStorageRefusal): readonly RallarBlackBoxTestCommand[];
  export function toStorageScenarioPayload(step: AlmConformanceMessageStepInput): Readonly<Record<string, string>>;
  // tests/playwright/rallar-black-box/full-stack-same-context-run.ts
  export type SameContextOwnerEnd = 'close' | 'flush-and-crash';
  SameContextPages.ownerEnd: SameContextOwnerEnd;
  ```

**D8 reuse inspection.** Reused as they are: the reload pair and its control-server segmentation (`alm-reload-pair.ts`,
`control-recipe-reload-commands.ts`), `toStoreRecoveryWait`, `toOwnerLeaseLapseWait`, `RESTORED_SESSION_RALLAR`,
`toHeldFaultCommands`, `toStorageQuotaFaultCommands`, `toSendCommand`, `toRetainedEvidenceCommands`,
`toAdmissionCommands`, `toObserveCommand`, `toResultAssertion`, `toStorageCountersCommand`, `toPayloadWait`,
`toReceivedCommand`, capacity's absent-wait delay, the same-context runner and `openSuccessorPage`, the fixture's
`GeneratedAlmPorts`. Generalised, not copied: storage-unavailable's refused send takes the durability and the cause;
the reload sync points move from an id test to a definition field. Not added: a command kind (no page-lifecycle
command; the lane drives the page), a lane family, an identity assessment, a fixture file, a harness durability list
(Task 1 owns them).

**Limits (state these in the PR body and the plan's Limits).**

- The lane never freezes a page: a headless page is never hidden and `Page.setWebLifecycleState` is a no-op on a visible
  one (measured). `flush-on-hide` fires the `freeze` event the listener hears and crashes the page; the frozen task
  queue and the `visibilitychange`/`pagehide` arms stay unit-proven (Task 5's adapter test). H5 stays unmeasured.
- That the restored row is the flush's and not the interval's rests on the lane ending the page inside the interval:
  the owner's recipe ends right after the admission evidence, the spec reads its result on the 250 ms control poll and
  settles 250 ms. On a loaded runner that can pass 1 s, and the cell then proves only the restore.
- `checkpoint-recovery`'s reload `pagehide` flush is best effort and not asserted (measured 0/4 without `commit()`).
- `checkpoint-lag`'s waits match the checkpoint store of the admitting lane (`browser-ws-client-checkpoint` over `ws`,
  `browser-rtc-overlay-checkpoint` otherwise: without a hold the fallback carrier keeps its sends in the overlay); the
  page-wide fault also fails the durable stores, which the cell does not read.
- The two `two-agent` cells are withheld from hosted manifest 18; the hosted full read runs all three as Playwright
  cells. The combined hosted recipe collects reload sync points from `delivery-reload` only.
- The Deno fixture states the lag at once (a positive `wait` runs on the real clock, so its fake clock cannot age a
  row): a `local-checkpoint` row admitted under the held quota reads `delayed`, then `failing`; the release writes the
  rows and reads `healthy`. It proves composition, not timing.

- [ ] **Step 1: Write the failing tests.** Create `packages/tests/shared-test/alm-conformance-local-checkpoint.test.ts`:

<!-- dprint-ignore -->
```ts
import { describe, expect, it } from 'vitest';

import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';

import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    RECOVERED_STORE_PREFIXES,
    toCheckpointStorePrefix
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts';
import { bindAlmReloadPair, toAlmReloadCheckpoints } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { CHECKPOINT_LAG_BOUND_MS } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/local-checkpoint/checkpoint-lag.ts';
import { CHECKPOINT_INTERVAL_MS } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/local-checkpoint/checkpoint-recovery.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';
const CHECKPOINT_SCENARIO_IDS = ['checkpoint-recovery', 'checkpoint-lag', 'flush-on-hide'] as const;

type Carrier = (typeof ALM_CONFORMANCE_CARRIERS)[number];
type CheckpointScenarioId = (typeof CHECKPOINT_SCENARIO_IDS)[number];

function findScenario(carrier: Carrier, scenarioId: CheckpointScenarioId): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === scenarioId);
    if (scenario === undefined) {
        throw new Error(`Missing ${scenarioId} over ${carrier}.`);
    }
    return scenario;
}

function toRecipes(scenario: AlmConformanceScenario): readonly RallarBlackBoxTestRecipe[] {
    return [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor]
        .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined);
}

function toCommandNames(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    const prefix = `${recipe.recipeId}-`;
    return recipe.commands.map((command) => (command.commandId ?? '').replace(prefix, ''));
}

function findCommand(recipe: RallarBlackBoxTestRecipe, name: string): RallarBlackBoxTestCommand {
    const command = recipe.commands.find((candidate) => candidate.commandId === `${recipe.recipeId}-${name}`);
    if (command === undefined) {
        throw new Error(`${recipe.recipeId} has no ${name}.`);
    }
    return command;
}

/** Every identity a scenario mints that a run shares with the other scenarios of its `{runId}`. */
function toMintedIdentities(scenario: AlmConformanceScenario): readonly string[] {
    return toRecipes(scenario).flatMap((recipe) =>
        recipe.commands.flatMap((command) => [
            `command:${command.commandId}`,
            ...(command.kind === 'fault.inject' ? [`fault:${command.faultId}`] : []),
            ...(command.kind === 'messages.send' && !('replayOnCarrier' in command) ? [`handle:${command.handleId}`] : []),
            ...(command.kind === 'http.request' ? [`request:${command.request.path}`] : [])
        ])
    );
}

function toRecoveryMatch(recipe: RallarBlackBoxTestRecipe, storeIdPrefix: string, connectName: string): string {
    return `"kind":"recovery","storeId":"${storeIdPrefix}:{resultCache.${recipe.recipeId}-${connectName}.value.sessionId}",` +
        '"outcome":{"kind":"restored"';
}

describe('local-checkpoint conformance scenarios', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('catalogs the checkpoint scenarios over %s in the full tag only', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier))
            .filter((scenario) => (CHECKPOINT_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId));

        expect(scenarios.map(({ scenarioId, laneFamily, roles, tags }) => ({ scenarioId, laneFamily, roles, tags })))
            .toEqual([
                { scenarioId: 'checkpoint-recovery', laneFamily: 'two-agent', roles: ['sender', 'receiver'], tags: ['full'] },
                { scenarioId: 'checkpoint-lag', laneFamily: 'two-agent', roles: ['sender', 'receiver'], tags: ['full'] },
                ...(carrier === 'rtc-with-ws-fallback' ? [] : [{
                    scenarioId: 'flush-on-hide',
                    laneFamily: 'same-context',
                    roles: ['sender', 'receiver', 'successor'],
                    tags: ['full']
                }])
            ]);
    });

    it('names the checkpoint stores by the browser\'s checkpoint store ids, the held original\'s by its carrier', () => {
        expect(RECOVERED_STORE_PREFIXES).toMatchObject({
            wsCheckpoint: 'browser-ws-client-checkpoint',
            rtcCheckpoint: 'browser-rtc-overlay-checkpoint'
        });
        expect(ALM_CONFORMANCE_CARRIERS.map(toCheckpointStorePrefix)).toEqual([
            'browser-ws-client-checkpoint',
            'browser-rtc-overlay-checkpoint',
            'browser-ws-client-checkpoint'
        ]);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s checkpoint scenario identities no other scenario of the run shares', (carrier) => {
        const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
        const isCheckpoint = (scenario: AlmConformanceScenario) => (CHECKPOINT_SCENARIO_IDS as readonly string[]).includes(scenario.scenarioId);
        const others = new Set(scenarios.filter((scenario) => !isCheckpoint(scenario)).flatMap(toMintedIdentities));
        const own = scenarios.filter(isCheckpoint).flatMap(toMintedIdentities);

        expect(own.filter((identity) => others.has(identity))).toEqual([]);
        for (const command of scenarios.filter(isCheckpoint).flatMap(toRecipes).flatMap((recipe) => recipe.commands)) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});

describe('checkpoint-recovery', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('proves one %s checkpoint before the reload, then the restored row once', (carrier) => {
        const { sender, receiver } = findScenario(carrier, 'checkpoint-recovery');
        const holds = carrier === 'rtc-with-ws-fallback' ? ['checkpoint-hold-rtc', 'checkpoint-hold-ws'] : [`checkpoint-hold-${carrier}`];

        expect(toCommandNames(sender)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'storage-counters-connected',
            'health-before',
            ...holds,
            'storage-counters-before-send',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'assert-enqueued-1',
            'assert-retained-1',
            'assert-unsubmitted-1',
            'checkpoint-interval-elapses',
            'storage-counters-checkpointed',
            'assert-checkpoint-write',
            'reload',
            'owner-lease-lapses',
            'reconnect',
            'observe-unobservable-1',
            'assert-old-handle-unobservable',
            'recovered-checkpoint-store',
            'assert-recovered-claimed',
            'stats'
        ]);
        expect(toCommandNames(receiver)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'health-before',
            'absent-before-reload',
            'receive-original',
            'health-after',
            'received-1',
            'stats'
        ]);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('sends the %s original local-checkpoint with a lifetime past the reload and one lease', (carrier) => {
        const { sender } = findScenario(carrier, 'checkpoint-recovery');

        expect(findCommand(sender, 'send-1')).toMatchObject({
            kind: 'messages.send',
            durability: 'local-checkpoint',
            ack: 'receiver',
            ttlMs: 77_000,
            payload: { marker: 'checkpoint-recovery', carrier }
        });
        expect(findCommand(sender, 'storage-counters-before-send')).toMatchObject({ kind: 'storage.counters', reset: true });
    });

    // The send path writes nothing, so the first admission write after the reset is the interval's one readwrite.
    it('waits out the interval and reads the checkpoint\'s admission write before the page reloads', () => {
        const { sender } = findScenario('ws', 'checkpoint-recovery');
        const interval = findCommand(sender, 'checkpoint-interval-elapses');

        expect(interval.kind === 'wait' && interval.absent).toBe(true);
        expect(interval.timeoutMs).toBeGreaterThan(CHECKPOINT_INTERVAL_MS);
        expect(findCommand(sender, 'storage-counters-checkpointed')).toMatchObject({ kind: 'storage.counters', reset: false });
        expect(findCommand(sender, 'assert-checkpoint-write')).toMatchObject({
            kind: 'assert',
            source: 'resultCache.alm-ws-checkpoint-recovery-sender-storage-counters-checkpointed.value.byKind.write',
            operator: 'gt',
            expected: 0
        });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('authors the %s reload pair around the checkpoint and binds it', (carrier) => {
        const { sender, receiver } = findScenario(carrier, 'checkpoint-recovery');
        const checkpoints = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints);
        const prefix = `alm-${carrier}-checkpoint-recovery`;

        expect(checkpoints).toEqual([{
            key: prefix,
            senderPrefixEnd: `${prefix}-sender-assert-checkpoint-write`,
            senderReload: `${prefix}-sender-reload`,
            senderSuffixEnd: `${prefix}-sender-assert-recovered-claimed`,
            receiverReadyEnd: `${prefix}-receiver-health-before`,
            receiverAbsenceEnd: `${prefix}-receiver-absent-before-reload`,
            receiverRecoveryEnd: `${prefix}-receiver-health-after`
        }]);
        expect(receiver.metadata?.almReloadCheckpoints).toEqual(checkpoints);
        const toRoot = (recipe: RallarBlackBoxTestRecipe, agentId: string) => ({
            kind: 'command' as const,
            protocolVersion: 1 as const,
            runId: 'run',
            agentId,
            commandId: `${agentId}-root`,
            command: { kind: 'recipe.run' as const, recipe, timeoutMs: 240_000 }
        });
        expect(bindAlmReloadPair({ sender: toRoot(sender, 'sender'), receiver: toRoot(receiver, 'receiver') }).left)
            .toBeUndefined();
    });

    // A held row is checkpointed reserved, so the reloaded owner reconnects once its lease has lapsed.
    it.each(ALM_CONFORMANCE_CARRIERS)('reconnects the %s page past the lease and reads its checkpoint store restored with a claim', (carrier) => {
        const { sender } = findScenario(carrier, 'checkpoint-recovery');
        const lapse = findCommand(sender, 'owner-lease-lapses');
        const recovery = findCommand(sender, 'recovered-checkpoint-store');

        expect(lapse.kind === 'wait' && lapse.absent).toBe(true);
        expect(lapse.timeoutMs).toBeGreaterThan(AL_OUTBOUND_WORK_LEASE_MS);
        expect(findCommand(sender, 'reconnect')).toMatchObject({
            kind: 'rtc.connect',
            rallar: { username: '', password: '', restoreSession: true }
        });
        expect(recovery.kind === 'wait' ? recovery.match : undefined).toEqual({
            kind: 'diagnostic',
            topic: STORAGE_TOPIC,
            payloadPath: 'data',
            contains: toRecoveryMatch(sender, toCheckpointStorePrefix(carrier), 'reconnect')
        });
        expect(findCommand(sender, 'assert-recovered-claimed')).toMatchObject({
            kind: 'assert',
            source: `resultCache.${sender.recipeId}-recovered-checkpoint-store.value.event.payload.data.outcome.claimed`,
            operator: 'gt',
            expected: 0
        });
    });
});

describe('checkpoint-lag', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('lags the %s checkpoint under the quota fault, refuses, then recovers', (carrier) => {
        const { sender, receiver } = findScenario(carrier, 'checkpoint-lag');

        expect(toCommandNames(sender)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'storage-counters-connected',
            'quota-admission-hold',
            'quota-work-hold',
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'health-delayed',
            'health-failing',
            'send-2',
            'observe-failed-2',
            'assert-refused-failure-kind-2',
            'assert-refused-failure-cause-2',
            'assert-refused-submitted-2',
            'quota-admission-release',
            'quota-work-release',
            'health-healthy',
            'send-3',
            'observe-admitted-3',
            'assert-admitted-3',
            'stats'
        ]);
        expect(toCommandNames(receiver)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'receive-1',
            'receive-3',
            'absent-2',
            'stats'
        ]);
    });

    it('admits every send local-checkpoint on the refusing channel and refuses the second with the lag cause', () => {
        const { sender } = findScenario('rtc', 'checkpoint-lag');

        for (const index of [1, 2, 3]) {
            const send = findCommand(sender, `send-${index}`);
            expect(send).toMatchObject({ kind: 'messages.send', durability: 'local-checkpoint' });
            expect(send.kind === 'messages.send' && 'onStorageUnavailable' in send).toBe(false);
        }
        expect(findCommand(sender, 'assert-refused-failure-cause-2')).toMatchObject({ operator: 'equals', expected: 'checkpoint-lag' });
        expect(findCommand(sender, 'assert-refused-failure-kind-2')).toMatchObject({ operator: 'equals', expected: 'storage-unavailable' });
    });

    it.each(
        [
            ['ws', 'browser-ws-client-checkpoint'],
            ['rtc', 'browser-rtc-overlay-checkpoint'],
            ['rtc-with-ws-fallback', 'browser-rtc-overlay-checkpoint']
        ] as const
    )('waits for the %s checkpoint store %s to read delayed, failing with the lag, then healthy', (carrier, store) => {
        const { sender } = findScenario(carrier, 'checkpoint-lag');
        const storeId = `${store}:{resultCache.${sender.recipeId}-connect.value.sessionId}`;
        const toContains = (name: string) => {
            const wait = findCommand(sender, name);
            return wait.kind === 'wait' ? { topic: wait.match.topic, contains: wait.match.contains } : undefined;
        };

        expect(toContains('health-delayed')).toEqual({
            topic: STORAGE_TOPIC,
            contains: `"kind":"health","storeId":"${storeId}","status":"delayed"`
        });
        expect(toContains('health-failing')).toEqual({
            topic: STORAGE_TOPIC,
            contains: `"kind":"health","storeId":"${storeId}","status":"failing","lastFailure":{"cause":"checkpoint-lag"`
        });
        expect(toContains('health-healthy')).toEqual({
            topic: STORAGE_TOPIC,
            contains: `"kind":"health","storeId":"${storeId}","status":"healthy"`
        });
        expect(findCommand(sender, 'health-failing').timeoutMs).toBeGreaterThan(CHECKPOINT_LAG_BOUND_MS + CHECKPOINT_INTERVAL_MS);
    });

    it('matches the health events in the order the store emits their keys', () => {
        const { sender } = findScenario('ws', 'checkpoint-lag');
        const event = {
            kind: 'health',
            storeId: 'browser-ws-client-checkpoint:s',
            status: 'failing',
            lastFailure: { cause: 'checkpoint-lag', detail: 'The oldest unsaved change is 10001 ms old.' },
            lastRecoveryPointAtMs: undefined
        };
        const wait = findCommand(sender, 'health-failing');
        const contains = wait.kind === 'wait' ? wait.match.contains ?? '' : '';

        expect(JSON.stringify(event)).toContain(contains.replace('{resultCache.alm-ws-checkpoint-lag-sender-connect.value.sessionId}', 's'));
    });
});

describe('flush-on-hide', () => {
    it.each(['ws', 'rtc'] as const)('has the %s owner admit one held send and end its recipe inside the interval', (carrier) => {
        const { sender } = findScenario(carrier, 'flush-on-hide');

        expect(toCommandNames(sender)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'storage-counters-connected',
            `flush-hold-${carrier}`,
            'send-1',
            'observe-admitted-1',
            'assert-admitted-1',
            'assert-enqueued-1',
            'assert-retained-1',
            'assert-unsubmitted-1',
            'stats'
        ]);
        expect(findCommand(sender, 'send-1')).toMatchObject({
            durability: 'local-checkpoint',
            ack: 'receiver',
            ttlMs: 77_000,
            payload: { marker: 'flush-on-hide', carrier }
        });
        expect(sender.commands.some((command) => command.kind === 'wait')).toBe(false);
    });

    it.each(['ws', 'rtc'] as const)('has the %s successor restore the checkpoint store with a claim once the lease lapsed', (carrier) => {
        const { successor, receiver } = findScenario(carrier, 'flush-on-hide');
        if (successor === undefined) {
            throw new Error('flush-on-hide declares no successor.');
        }

        expect(toCommandNames(successor)).toEqual([
            'ensure-group',
            'ensure-member',
            'owner-lease-lapses',
            'connect',
            'recovered-checkpoint-store',
            'assert-recovered-claimed',
            'stats'
        ]);
        const recovery = findCommand(successor, 'recovered-checkpoint-store');
        expect(recovery.kind === 'wait' ? recovery.match.contains : undefined)
            .toBe(toRecoveryMatch(successor, toCheckpointStorePrefix(carrier), 'connect'));
        expect(toCommandNames(receiver)).toEqual([
            'ensure-group',
            'ensure-member',
            'connect',
            'receive-original',
            'received-1',
            'stats'
        ]);
    });
});
```

The catalog pins (`alm-conformance-recipes.test.ts`, `alm-conformance-recipe-validation.test.ts`), the same-context
runner's selection and owner-end order (`full-stack-same-context-run.test.ts`) and the hosted withheld cells
(`hetzner-alm-manifest-entries.test.ts`):

<!-- dprint-ignore -->
```diff
diff --git a/packages/tests/rallar-black-box/full-stack-same-context-run.test.ts b/packages/tests/rallar-black-box/full-stack-same-context-run.test.ts
index 947c42c19..c0a8de493 100644
--- a/packages/tests/rallar-black-box/full-stack-same-context-run.test.ts
+++ b/packages/tests/rallar-black-box/full-stack-same-context-run.test.ts
@@ -50,8 +50,31 @@ function toParticipant(agentId: string, page: Playwright.Page | undefined): TwoA
     };
 }
 
+/** The owner page's ending as the runner drives it: a lifecycle event in the page, the CDP crash, the close. */
+function toOwnerPage(order: string[]): Playwright.Page {
+    let crash: (() => void) | undefined;
+    const cdp = {
+        send: async (method: string) => {
+            order.push(method);
+            crash?.();
+            return new Promise(() => {});
+        }
+    };
+    const page = {
+        evaluate: async (_dispatch: unknown, eventType: string) => void order.push(`dispatch:${eventType}`),
+        waitForTimeout: async () => void order.push('settle'),
+        context: () => ({ newCDPSession: async () => cdp }),
+        waitForEvent: async (event: string) => {
+            await new Promise<void>((resolve) => crash = resolve);
+            order.push(event === 'crash' ? 'crashed' : event);
+        },
+        close: async () => void order.push('close-owner')
+    };
+    return page as unknown as Playwright.Page;
+}
+
 describe('same-context ALM run', () => {
-    it('selects exactly durable-takeover for the same-context family on every carrier', () => {
+    it('selects durable-takeover on every carrier and flush-on-hide over ws and rtc for the same-context family', () => {
         for (const carrier of ALM_CONFORMANCE_CARRIERS) {
             const sameContext = createAlmConformanceRecipes({
                 group,
@@ -62,13 +85,19 @@ describe('same-context ALM run', () => {
                 deadlineMs: 18_000
             }).filter((scenario) => scenario.laneFamily === 'same-context');
 
-            expect(sameContext.map((scenario) => scenario.scenarioKey), carrier).toEqual(['durable-takeover']);
+            expect(sameContext.map((scenario) => scenario.scenarioKey), carrier)
+                .toEqual(carrier === 'rtc-with-ws-fallback' ? ['durable-takeover'] : ['durable-takeover', 'flush-on-hide']);
             expect(sameContext.every((scenario) => scenario.successor !== undefined), carrier).toBe(true);
         }
     });
 
     // One auth session keeps one server socket: the successor connects only once the owner page is gone.
-    it('runs the owner\'s recipe, closes the owner page, then runs the successor, the receiver started first', async () => {
+    it.each(
+        [
+            ['close', ['close-owner']],
+            ['flush-and-crash', ['dispatch:freeze', 'settle', 'Page.crash', 'crashed', 'close-owner']]
+        ] as const
+    )('runs the owner\'s recipe, ends the owner page by %s, then runs the successor, the receiver started first', async (ownerEnd, ending) => {
         const baseline = createAlmConformanceRecipes({
             group,
             carrier: 'ws',
@@ -79,7 +108,6 @@ describe('same-context ALM run', () => {
         }).find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
         const successor = { ...baseline.sender, recipeId: `${baseline.sender.recipeId}-successor` };
         const order: string[] = [];
-        const ownerPage = { close: async () => void order.push('close-owner') } as Partial<Playwright.Page> as Playwright.Page;
         const request = await Playwright.request.newContext();
         vi.spyOn(request, 'post').mockImplementation(async (url, options) => {
             const data = options?.data;
@@ -93,7 +121,7 @@ describe('same-context ALM run', () => {
             request,
             runId: 'same-context-run',
             group,
-            sender: toParticipant('owner-agent', ownerPage),
+            sender: toParticipant('owner-agent', toOwnerPage(order)),
             receiver: toParticipant('receiver-agent', undefined),
             readSnapshot: async () => ({ results: order.map((commandId) => ({ commandId, ok: true })) }),
             close: async () => {
@@ -103,14 +131,14 @@ describe('same-context ALM run', () => {
         try {
             const outcome = await runRecipeTrioOnSameContext(
                 run,
-                { owner: run.sender, successor: toParticipant('successor-agent', undefined) },
+                { owner: run.sender, successor: toParticipant('successor-agent', undefined), ownerEnd },
                 { sender: baseline.sender, receiver: baseline.receiver, successor }
             );
 
             expect(order).toEqual([
                 `${baseline.receiver.recipeId}-run`,
                 `${baseline.sender.recipeId}-run`,
-                'close-owner',
+                ...ending,
                 `${successor.recipeId}-run`
             ]);
             expect(outcome).toEqual({
diff --git a/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts b/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
index 229841973..b63af4c34 100644
--- a/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
+++ b/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
@@ -144,13 +144,14 @@ function toStartedCells(entry: ReturnType<typeof createAlmConformance2AgentEntry
 }
 
 describe('ALM conformance hosted lane families', () => {
-    it('withholds exactly the named cells: the refresh variant over rtc and rtc-with-ws-fallback', () => {
+    it('withholds exactly the named cells: the refresh variant over the RTC carriers and both checkpoint cells everywhere', () => {
         const defined = toFamilyCells(['two-agent', 'addressed']);
         // Removing a withheld cell from hosted manifest 18 is a deliberate act: no plain-member write advances the
-        // snapshot version for the refresh variant.
+        // snapshot version for the refresh variant, and the checkpoint cells keep manifest 18 as recorded.
         const withheld = [
             'alm-rtc-not-yet-in-sync-delivered-after-refresh',
-            'alm-rtc-with-ws-fallback-not-yet-in-sync-delivered-after-refresh'
+            'alm-rtc-with-ws-fallback-not-yet-in-sync-delivered-after-refresh',
+            ...ALM_CONFORMANCE_CARRIERS.flatMap((carrier) => ['checkpoint-recovery', 'checkpoint-lag'].map((key) => `alm-${carrier}-${key}`))
         ];
         const cells = toStartedCells(createAlmConformance2AgentEntry());
 
diff --git a/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts b/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
index 1ebe43a8c..cac6fd702 100644
--- a/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
+++ b/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
@@ -36,12 +36,15 @@ const CARRIER_SCENARIO_IDS = {
         'durable-opt-in',
         'delivery-reload',
         'storage-unavailable',
+        'checkpoint-recovery',
+        'checkpoint-lag',
         'ordering-resync',
         'ws-unicast-receipt',
         'server-command',
         'capacity',
         ...Array.from({ length: 3 }, () => 'receipted-audience' as const),
-        'durable-takeover'
+        'durable-takeover',
+        'flush-on-hide'
     ],
     rtc: [
         'volatile-default',
@@ -52,13 +55,16 @@ const CARRIER_SCENARIO_IDS = {
         'durable-opt-in',
         'delivery-reload',
         'storage-unavailable',
+        'checkpoint-recovery',
+        'checkpoint-lag',
         'ordering-resync',
         'not-yet-in-sync',
         'not-yet-in-sync',
         'ws-unicast-receipt',
         'capacity',
         ...Array.from({ length: 4 }, () => 'receipted-audience' as const),
-        'durable-takeover'
+        'durable-takeover',
+        'flush-on-hide'
     ],
     'rtc-with-ws-fallback': [
         'volatile-default',
@@ -69,6 +75,8 @@ const CARRIER_SCENARIO_IDS = {
         'durable-opt-in',
         'delivery-reload',
         'storage-unavailable',
+        'checkpoint-recovery',
+        'checkpoint-lag',
         'ordering-resync',
         'cross-carrier-duplicate',
         'cross-carrier-duplicate',
@@ -110,9 +118,13 @@ const ALM_CONFORMANCE_SCOPES: readonly AlmConformanceTag[] = ['smoke', 'full'];
 /**
  * Recipe ids whose hold stays until the page ends. Recipient-b of the frozen audience withholds its ACK,
  * leaves and rejoins past the expiry; the hold matches only that scenario's type id, so no later block sees it.
- * The takeover's sender holds its carrier until the lane closes its page, which no later block shares.
+ * The takeover's and the flush's senders hold their carrier until the lane ends their page, which no later block shares.
  */
-const HELD_UNTIL_PAGE_ENDS_RECIPE_SUFFIXES = ['-frozen-audience-membership-recipient-b', '-durable-takeover-sender'];
+const HELD_UNTIL_PAGE_ENDS_RECIPE_SUFFIXES = [
+    '-frozen-audience-membership-recipient-b',
+    '-durable-takeover-sender',
+    '-flush-on-hide-sender'
+];
 
 /**
  * A counted fault runs out after a number of frames, not after a time: a quick retry loop spends it before
diff --git a/packages/tests/shared-test/alm-conformance-recipes.test.ts b/packages/tests/shared-test/alm-conformance-recipes.test.ts
index 615fe95a2..15604c0fd 100644
--- a/packages/tests/shared-test/alm-conformance-recipes.test.ts
+++ b/packages/tests/shared-test/alm-conformance-recipes.test.ts
@@ -124,6 +124,8 @@ const SCENARIO_KEYS_BY_CARRIER = {
         'durable-opt-in',
         'delivery-reload',
         'storage-unavailable',
+        'checkpoint-recovery',
+        'checkpoint-lag',
         'ordering-resync',
         'ws-unicast-receipt',
         'server-command',
@@ -138,6 +140,8 @@ const SCENARIO_KEYS_BY_CARRIER = {
         'durable-opt-in',
         'delivery-reload',
         'storage-unavailable',
+        'checkpoint-recovery',
+        'checkpoint-lag',
         'ordering-resync',
         'not-yet-in-sync-delivered-after-refresh',
         'not-yet-in-sync-expires',
@@ -153,6 +157,8 @@ const SCENARIO_KEYS_BY_CARRIER = {
         'durable-opt-in',
         'delivery-reload',
         'storage-unavailable',
+        'checkpoint-recovery',
+        'checkpoint-lag',
         'ordering-resync',
         'cross-carrier-duplicate-rtc-then-ws',
         'cross-carrier-duplicate-ws-then-rtc',
@@ -202,16 +208,19 @@ describe('alm-conformance recipe family', () => {
                     ...RECEIPTED_AUDIENCE_KEYS_BY_CARRIER[carrier].flatMap((key) =>
                         ['sender', 'receiver', 'recipient-b'].map((role) => `alm-${carrier}-${key}-${role}`)
                     ),
-                    ...['sender', 'receiver', 'successor'].map((role) => `alm-${carrier}-durable-takeover-${role}`)
+                    ...['sender', 'receiver', 'successor'].map((role) => `alm-${carrier}-durable-takeover-${role}`),
+                    ...(carrier === 'rtc-with-ws-fallback'
+                        ? []
+                        : ['sender', 'receiver', 'successor'].map((role) => `alm-${carrier}-flush-on-hide-${role}`))
                 ]);
         }
     });
 
-    it('declares recipient-b on the receipted-audience scenarios and successor on durable-takeover only; every other scenario keeps one sender and one receiver', () => {
+    it('declares recipient-b on the receipted-audience scenarios and successor on durable-takeover and flush-on-hide only; every other scenario keeps one sender and one receiver', () => {
         for (const carrier of ALM_CONFORMANCE_CARRIERS) {
             for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                 const threeRoles = scenario.scenarioId === 'receipted-audience';
-                const twoPages = scenario.scenarioId === 'durable-takeover';
+                const twoPages = scenario.scenarioId === 'durable-takeover' || scenario.scenarioId === 'flush-on-hide';
                 expect(scenario.roles, scenario.scenarioKey).toEqual(
                     threeRoles
                         ? ['sender', 'receiver', 'recipient-b']
@@ -400,7 +409,7 @@ describe('alm-conformance recipe family', () => {
         }
     });
 
-    it('keeps reload, storage-unavailable, ordering-resync and the takeover full-only while preserving the smoke scenarios', () => {
+    it('keeps reload, storage-unavailable, the checkpoint scenarios, ordering-resync and the takeover full-only while preserving the smoke scenarios', () => {
         expect(
             createAlmConformanceRecipes(toConformanceInput('ws'))
                 .filter((scenario) => scenario.tags.includes('smoke'))
@@ -420,6 +429,8 @@ describe('alm-conformance recipe family', () => {
         ).toEqual([
             'delivery-reload',
             'storage-unavailable',
+            'checkpoint-recovery',
+            'checkpoint-lag',
             'ordering-resync',
             'cross-carrier-duplicate',
             'cross-carrier-duplicate',
@@ -456,6 +467,9 @@ describe('alm-conformance recipe family', () => {
             ['full'],
             ['full'],
             ['full'],
+            ['full'],
+            ['full'],
+            ['full'],
             ['full']
         ]);
     });
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared-test/alm-conformance-local-checkpoint.test.ts \
  packages/tests/shared-test/alm-conformance-recipes.test.ts \
  packages/tests/shared-test/alm-conformance-recipe-validation.test.ts \
  packages/tests/rallar-black-box/full-stack-same-context-run.test.ts \
  packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
# FAIL alm-conformance-local-checkpoint.test.ts: Error: Cannot find package
#   '@shared-test/rallar-bb-test/conformance/alm/scenarios/local-checkpoint/checkpoint-lag.ts'
# × generates the pinned recipe list for every carrier, in scenario order   (ws: expected [ …(36) ] to deeply equal [ …(43) ])
# × keeps reload, storage-unavailable, the checkpoint scenarios, ordering-resync and the takeover full-only …
# × produces carrier-scoped scenarios with distinct command ids and valid schemas
# × withholds exactly the named cells: the refresh variant over the RTC carriers and both checkpoint cells everywhere
# × selects durable-takeover on every carrier and flush-on-hide over ws and rtc for the same-context family
# × runs the owner's recipe, ends the owner page by flush-and-crash, then runs the successor, the receiver started first
#  Test Files  5 failed (5)
#       Tests  6 failed | 52 passed (58)
```

- [ ] **Step 3: The catalog plumbing.** The ids, the reload sync points as a definition field, the checkpoint store
      prefixes, storage-unavailable's refused send generalised (its own recipes are unchanged):

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
index 1bae63f75..2c15f63e4 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
@@ -4,6 +4,7 @@ import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-cont
 import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';
 import type { AlmConformanceReceiptRoles } from './alm-conformance-receipt-commands.ts';
 import type { AlmConformanceRole } from './alm-conformance-roles.ts';
+import type { AlmReloadCheckpoint } from './alm-reload-pair.ts';
 
 export interface CreateAlmConformanceRecipesInput {
     readonly group: RallarBlackBoxDistributedGroupRef;
@@ -18,6 +19,8 @@ export interface CreateAlmConformanceRecipesInput {
 export type AlmConformanceScenarioId =
     | 'bounded-rejection'
     | 'capacity'
+    | 'checkpoint-lag'
+    | 'checkpoint-recovery'
     | 'cross-carrier-duplicate'
     | 'deadline-expiry'
     | 'delivery-baseline'
@@ -26,6 +29,7 @@ export type AlmConformanceScenarioId =
     | 'durable-opt-in'
     | 'durable-takeover'
     | 'fallback-within-deadline'
+    | 'flush-on-hide'
     | 'no-fallback-after-deadline'
     | 'not-yet-in-sync'
     | 'ordering-resync'
@@ -82,6 +86,8 @@ export interface AlmConformanceScenarioDefinition {
      * confirms and leaves unconfirmed, which the identity assessment joins to their sessions after the run.
      */
     readonly toReceiptRoles?: (carrier: AlmConformanceCarrier) => AlmConformanceReceiptRoles;
+    /** Absent when the sender keeps its page. Otherwise the sync points both roles carry around its one reload. */
+    readonly toReloadCheckpoint?: (step: AlmConformanceStepInput) => AlmReloadCheckpoint;
 }
 
 export const SMOKE_TAGS: readonly AlmConformanceTag[] = ['smoke', 'full'];
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts
index 5fddf94b1..3980a7fec 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts
@@ -166,7 +166,9 @@ const RECOVERY_MARGIN_MS = 60_000;
 export const RECOVERED_STORE_PREFIXES = {
     sessionInbound: 'browser-session-inbound',
     ws: 'browser-ws-client',
-    rtc: 'browser-rtc-overlay'
+    rtc: 'browser-rtc-overlay',
+    wsCheckpoint: 'browser-ws-client-checkpoint',
+    rtcCheckpoint: 'browser-rtc-overlay-checkpoint'
 } as const;
 
 const STORAGE_TOPIC = 'rallar.browser.alm.storage';
@@ -190,6 +192,11 @@ export function toOriginalStorePrefix(carrier: AlmConformanceCarrier): string {
     return carrier === 'rtc' ? RECOVERED_STORE_PREFIXES.rtc : RECOVERED_STORE_PREFIXES.ws;
 }
 
+/** The checkpoint store of the lane that holds a held original at the end of its page, as {@link toOriginalStorePrefix}. */
+export function toCheckpointStorePrefix(carrier: AlmConformanceCarrier): string {
+    return carrier === 'rtc' ? RECOVERED_STORE_PREFIXES.rtcCheckpoint : RECOVERED_STORE_PREFIXES.wsCheckpoint;
+}
+
 /**
  * The one `recovery` a durable store, or one lane of a shared store, reports after its first work batch, matched in
  * its emitted key order (`kind`, `storeId`, `outcome`). The store id embeds the session the named connect restored,
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts b/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
index 2459b6db9..51a51b3ac 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
@@ -29,16 +29,20 @@ import {
     toStatsCommand
 } from './alm-conformance-session-commands.ts';
 import { toRoomRef, toSendHandleId } from './alm-conformance-step-identities.ts';
+import type { AlmReloadCheckpoint } from './alm-reload-pair.ts';
 import { boundedRejection } from './scenarios/bounded-rejection.ts';
 import { capacity } from './scenarios/capacity.ts';
 import { crossCarrierDuplicate } from './scenarios/cross-carrier-duplicate.ts';
 import { deadlineExpiry } from './scenarios/deadline-expiry.ts';
 import { deliveryBaseline } from './scenarios/delivery-baseline.ts';
 import { deliveryLifecycle } from './scenarios/delivery-lifecycle.ts';
-import { deliveryReload, toReloadCheckpoint } from './scenarios/delivery-reload.ts';
+import { deliveryReload } from './scenarios/delivery-reload.ts';
 import { durableOptIn } from './scenarios/durable-opt-in.ts';
 import { durableTakeover } from './scenarios/durable-takeover.ts';
 import { fallbackWithinDeadline } from './scenarios/fallback-within-deadline.ts';
+import { checkpointLag } from './scenarios/local-checkpoint/checkpoint-lag.ts';
+import { checkpointRecovery } from './scenarios/local-checkpoint/checkpoint-recovery.ts';
+import { flushOnHide } from './scenarios/local-checkpoint/flush-on-hide.ts';
 import { noFallbackAfterDeadline } from './scenarios/no-fallback-after-deadline.ts';
 import { notYetInSync } from './scenarios/not-yet-in-sync.ts';
 import { orderingResync } from './scenarios/ordering-resync.ts';
@@ -69,6 +73,8 @@ interface AlmConformanceRecipeInput extends AlmConformanceStepInput {
     readonly commands: readonly RallarBlackBoxTestCommand[];
     /** Set only on the sender of a scenario that pins its receipt identity. */
     readonly receiptRoles: AlmConformanceReceiptRoles | undefined;
+    /** Set on both roles of a scenario whose sender reloads its page. */
+    readonly reloadCheckpoint: AlmReloadCheckpoint | undefined;
 }
 
 /** RTC-with-WS-fallback injects one fault per carrier before starting the expiring send. */
@@ -92,6 +98,8 @@ const ALM_CONFORMANCE_SCENARIOS: readonly AlmConformanceScenarioDefinition[] = [
     durableOptIn,
     deliveryReload,
     storageUnavailable,
+    checkpointRecovery,
+    checkpointLag,
     orderingResync,
     ...crossCarrierDuplicate,
     ...notYetInSync,
@@ -103,7 +111,8 @@ const ALM_CONFORMANCE_SCENARIOS: readonly AlmConformanceScenarioDefinition[] = [
     serverCommand,
     capacity,
     ...receiptedAudience,
-    durableTakeover
+    durableTakeover,
+    flushOnHide
 ];
 
 export function createAlmConformanceRecipes(
@@ -143,7 +152,8 @@ function toAlmConformanceScenario(
             ? definition.toSenderCommands(step)
             : definition.toRecipientCommands(step);
         const receiptRoles = role === 'sender' ? definition.toReceiptRoles?.(input.carrier) : undefined;
-        return toAlmConformanceRecipe({ ...step, commands, receiptRoles });
+        const reloadCheckpoint = definition.toReloadCheckpoint?.(step);
+        return toAlmConformanceRecipe({ ...step, commands, receiptRoles, reloadCheckpoint });
     };
     return {
         scenarioId: definition.scenarioId,
@@ -170,9 +180,9 @@ function toAlmConformanceRecipe(recipe: AlmConformanceRecipeInput): RallarBlackB
             carrier,
             scenarioId: recipe.scenarioId,
             group: toRoomRef(recipe.input.group),
-            ...(recipe.scenarioId === 'delivery-reload'
-                ? { almReloadCheckpoints: [{ ...toReloadCheckpoint(recipe) }] }
-                : {}),
+            ...(recipe.reloadCheckpoint === undefined
+                ? {}
+                : { almReloadCheckpoints: [{ ...recipe.reloadCheckpoint }] }),
             ...(recipe.receiptRoles === undefined
                 ? {}
                 : { almReceiptRoles: [toReceiptRolesMetadata(recipe, recipe.receiptRoles)] })
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
index e6ca8fe12..832de75f2 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
@@ -40,10 +40,11 @@ export const deliveryReload: AlmConformanceScenarioDefinition = {
     roles: ['sender', 'receiver'],
     laneFamily: 'two-agent',
     toSenderCommands: toDeliveryReloadSenderCommands,
-    toRecipientCommands: toDeliveryReloadReceiverCommands
+    toRecipientCommands: toDeliveryReloadReceiverCommands,
+    toReloadCheckpoint
 };
 
-export function toReloadCheckpoint(step: AlmConformanceStepInput): AlmReloadCheckpoint {
+function toReloadCheckpoint(step: AlmConformanceStepInput): AlmReloadCheckpoint {
     const sender = { ...step, role: 'sender' as const };
     const receiver = { ...step, role: 'receiver' as const };
     return {
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/storage-unavailable.ts b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/storage-unavailable.ts
index 0c8d8243e..f572564df 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/storage-unavailable.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/storage-unavailable.ts
@@ -42,7 +42,7 @@ export const storageUnavailable: AlmConformanceScenarioDefinition = {
 function toStorageUnavailableSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
     return [
         ...toStorageQuotaFaultCommands(sender, 'hold'),
-        ...toRefusedSendCommands({ ...sender, index: 1 }),
+        ...toStorageRefusedSendCommands({ ...sender, index: 1 }, { durability: 'local-outbox', cause: 'quota' }),
         toQuotaHealthWait(sender, 'health-failing', 'failing'),
         ...toDowngradedSendCommands({ ...sender, index: 2 }),
         ...toStorageQuotaFaultCommands(sender, 'release'),
@@ -51,21 +51,34 @@ function toStorageUnavailableSenderCommands(sender: AlmConformanceStepInput): re
     ];
 }
 
+export interface AlmConformanceStorageRefusal {
+    readonly durability: 'local-checkpoint' | 'local-outbox';
+    readonly cause: 'checkpoint-lag' | 'quota';
+}
+
 /** The default channel refuses: the handle fails with the storage cause and nothing is sent. */
-function toRefusedSendCommands(send: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
+export function toStorageRefusedSendCommands(
+    send: AlmConformanceMessageStepInput,
+    refusal: AlmConformanceStorageRefusal
+): readonly RallarBlackBoxTestCommand[] {
     return [
-        toSendCommand({ ...send, payload: toPayload(send), delivery: { durability: 'local-outbox' } }),
+        toSendCommand({
+            ...send,
+            payload: toStorageScenarioPayload(send),
+            delivery: { durability: refusal.durability }
+        }),
         toObserveCommand({ ...send, state: 'failed' }),
-        ...([['failure.kind', 'storage-unavailable'], ['failure.cause', 'quota'], ['submitted', false]] as const).map((
-            [field, expected]
-        ) => toResultAssertion({
-            step: send,
-            name: `assert-refused-${field.replace('.', '-')}-${send.index}`,
-            resultName: `observe-failed-${send.index}`,
-            field,
-            operator: 'equals',
-            expected
-        }))
+        ...([['failure.kind', 'storage-unavailable'], ['failure.cause', refusal.cause], ['submitted', false]] as const)
+            .map((
+                [field, expected]
+            ) => toResultAssertion({
+                step: send,
+                name: `assert-refused-${field.replace('.', '-')}-${send.index}`,
+                resultName: `observe-failed-${send.index}`,
+                field,
+                operator: 'equals',
+                expected
+            }))
     ];
 }
 
@@ -79,7 +92,7 @@ function toDowngradedSendCommands(send: AlmConformanceMessageStepInput): readonl
     return [
         toSendCommand({
             ...send,
-            payload: toPayload(send),
+            payload: toStorageScenarioPayload(send),
             delivery: { durability: 'local-outbox', onStorageUnavailable: 'volatile' }
         }),
         ...toAdmissionCommands(send),
@@ -98,7 +111,7 @@ function toDowngradedSendCommands(send: AlmConformanceMessageStepInput): readonl
 
 function toDurableSendCommands(send: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
     return [
-        toSendCommand({ ...send, payload: toPayload(send), delivery: { durability: 'local-outbox' } }),
+        toSendCommand({ ...send, payload: toStorageScenarioPayload(send), delivery: { durability: 'local-outbox' } }),
         ...toAdmissionCommands(send),
         toResultAssertion({
             step: send,
@@ -117,24 +130,29 @@ function toStorageUnavailableReceiverCommands(receiver: AlmConformanceStepInput)
         toPayloadWait({
             step: receiver,
             name: 'receive-2',
-            payload: toPayload({ ...receiver, index: 2 }),
+            payload: toStorageScenarioPayload({ ...receiver, index: 2 }),
             absent: false
         }),
         {
             ...toPayloadWait({
                 step: receiver,
                 name: 'receive-3',
-                payload: toPayload({ ...receiver, index: 3 }),
+                payload: toStorageScenarioPayload({ ...receiver, index: 3 }),
                 absent: false
             }),
             timeoutMs: receiver.input.deadlineMs + 2 * NON_EXPIRING_SEND_TIMEOUT_MS
         },
-        toPayloadWait({ step: receiver, name: 'absent-1', payload: toPayload({ ...receiver, index: 1 }), absent: true })
+        toPayloadWait({
+            step: receiver,
+            name: 'absent-1',
+            payload: toStorageScenarioPayload({ ...receiver, index: 1 }),
+            absent: true
+        })
     ];
 }
 
 /** One receiver page hears every carrier's cell, so the payload names the carrier. */
-function toPayload(step: AlmConformanceMessageStepInput): Readonly<Record<string, string>> {
+export function toStorageScenarioPayload(step: AlmConformanceMessageStepInput): Readonly<Record<string, string>> {
     return { marker: step.scenarioId, carrier: step.input.carrier, send: String(step.index) };
 }
 
```

- [ ] **Step 4: The three scenarios.** Create `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/local-checkpoint/checkpoint-recovery.ts`:

<!-- dprint-ignore -->
```ts
import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    CONNECT_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    RESPONSE_MARGIN_MS,
    STATS_TIMEOUT_MS
} from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toHeldFaultCommands } from '../../alm-conformance-fault-commands.ts';
import {
    toObserveCommand,
    toResultAssertion,
    toRetainedEvidenceCommands,
    toSendCommand,
    toStorageCountersCommand
} from '../../alm-conformance-message-commands.ts';
import { toPayloadWait, toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    RESTORED_SESSION_RALLAR,
    toCheckpointStorePrefix,
    toConnectCommand,
    toOwnerLeaseLapseWait,
    toRecoveryTtlMs,
    toStoreRecoveryWait
} from '../../alm-conformance-session-commands.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import type { AlmReloadCheckpoint } from '../../alm-reload-pair.ts';

const CHECKPOINT_INTERVAL_TOPIC = 'rallar.black-box.alm.checkpoint-interval-elapsed';

/**
 * The browser store factory's default interval, which this Deno-loaded catalog cannot import: the first unsaved change
 * arms one checkpoint write this long after it.
 */
export const CHECKPOINT_INTERVAL_MS = 1_000;

/**
 * A `local-checkpoint` send survives its page through the interval checkpoint: the page holds its carrier, admits one
 * original from memory, reads the one checkpoint write the interval made, and reloads. A reload's own `pagehide` flush
 * is best effort and is not what this scenario proves, so the write is read before the page ends. The reloaded page
 * restores the row from the checkpoint store and delivers it once.
 */
export const checkpointRecovery: AlmConformanceScenarioDefinition = {
    scenarioId: 'checkpoint-recovery',
    scenarioKey: 'checkpoint-recovery',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toCheckpointRecoverySenderCommands,
    toRecipientCommands: toCheckpointRecoveryReceiverCommands,
    toReloadCheckpoint
};

function toReloadCheckpoint(step: AlmConformanceStepInput): AlmReloadCheckpoint {
    const sender = { ...step, role: 'sender' as const };
    const receiver = { ...step, role: 'receiver' as const };
    return {
        key: `alm-${step.input.carrier}-${step.scenarioKey}`,
        senderPrefixEnd: toCommandId(sender, 'assert-checkpoint-write'),
        senderReload: toCommandId(sender, 'reload'),
        senderSuffixEnd: toCommandId(sender, 'assert-recovered-claimed'),
        receiverReadyEnd: toCommandId(receiver, 'health-before'),
        receiverAbsenceEnd: toCommandId(receiver, 'absent-before-reload'),
        receiverRecoveryEnd: toCommandId(receiver, 'health-after')
    };
}

function toCheckpointRecoverySenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toHealthCommand(sender, 'health-before'),
        ...toHeldFaultCommands(sender, 'checkpoint-hold', 'until-cleared'),
        toStorageCountersCommand(sender, 'storage-counters-before-send', true),
        toOriginalSend(sender),
        ...toRetainedEvidenceCommands({ ...sender, index: 1 }, true),
        ...toCheckpointWriteCommands(sender),
        {
            kind: 'agent.reload',
            commandId: toCommandId(sender, 'reload'),
            readyTimeoutMs: CONNECT_READINESS_TIMEOUT_MS,
            timeoutMs: CONNECT_TIMEOUT_MS
        },
        ...toRestoredCommands(sender)
    ];
}

/**
 * The send path writes nothing, so after the reset before the send, the first admission write is the interval's one
 * checkpoint readwrite. Nothing emits the topic, so the wait only lets the interval run out.
 */
function toCheckpointWriteCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        {
            kind: 'wait',
            commandId: toCommandId(sender, 'checkpoint-interval-elapses'),
            match: { kind: 'diagnostic', topic: CHECKPOINT_INTERVAL_TOPIC },
            absent: true,
            timeoutMs: CHECKPOINT_INTERVAL_MS + RESPONSE_MARGIN_MS
        },
        toStorageCountersCommand(sender, 'storage-counters-checkpointed', false),
        toResultAssertion({
            step: sender,
            name: 'assert-checkpoint-write',
            resultName: 'storage-counters-checkpointed',
            field: 'byKind.write',
            operator: 'gt',
            expected: 0
        })
    ];
}

/**
 * The checkpoint holds the row as the hold left it, reserved under a lease, so the reloaded page reconnects once that
 * lease has lapsed and its first batch claims the row.
 */
function toRestoredCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const reconnect = toConnectCommand(sender);
    return [
        toOwnerLeaseLapseWait(sender),
        {
            ...reconnect,
            commandId: toCommandId(sender, 'reconnect'),
            rallar: { ...reconnect.rallar, ...RESTORED_SESSION_RALLAR }
        },
        toObserveCommand({ ...sender, index: 1, state: 'unobservable' }),
        toResultAssertion({
            step: sender,
            name: 'assert-old-handle-unobservable',
            resultName: 'observe-unobservable-1',
            field: 'state',
            operator: 'equals',
            expected: 'unobservable'
        }),
        toStoreRecoveryWait(sender, {
            name: 'recovered-checkpoint-store',
            storeIdPrefix: toCheckpointStorePrefix(sender.input.carrier),
            lane: '',
            connectName: 'reconnect',
            timeoutMs: toRecoveryTtlMs(sender.input.deadlineMs)
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-recovered-claimed',
            resultName: 'recovered-checkpoint-store',
            field: 'event.payload.data.outcome.claimed',
            operator: 'gt',
            expected: 0
        })
    ];
}

function toOriginalSend(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index: 1,
        payload: toPayload(sender),
        delivery: {
            ack: 'receiver',
            durability: 'local-checkpoint',
            ttlMs: toRecoveryTtlMs(sender.input.deadlineMs),
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
}

/** The recovery wait starts beside the sender's reload, so it covers the lease lapse, the reconnect and the drain. */
function toCheckpointRecoveryReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const payload = toPayload(receiver);
    return [
        toHealthCommand(receiver, 'health-before'),
        toPayloadWait({ step: receiver, name: 'absent-before-reload', payload, absent: true }),
        {
            ...toPayloadWait({ step: receiver, name: 'receive-original', payload, absent: false }),
            timeoutMs: toRecoveryTtlMs(receiver.input.deadlineMs)
        },
        toHealthCommand(receiver, 'health-after'),
        toReceivedCommand({ ...receiver, index: 1, count: 2, absent: true })
    ];
}

function toHealthCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
    return { kind: 'health', commandId: toCommandId(step, name), timeoutMs: STATS_TIMEOUT_MS };
}

/** The payload names its carrier, so a wait never matches another carrier's cell. */
function toPayload(step: AlmConformanceStepInput): Readonly<Record<string, string>> {
    return { marker: step.scenarioId, carrier: step.input.carrier };
}
```

Create `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/local-checkpoint/checkpoint-lag.ts`:

<!-- dprint-ignore -->
```ts
import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, toBudgetMs } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toStorageQuotaFaultCommands } from '../../alm-conformance-fault-commands.ts';
import { toAdmissionCommands, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toPayloadWait } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceMessageStepInput,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { RECOVERED_STORE_PREFIXES } from '../../alm-conformance-session-commands.ts';
import { toCommandId } from '../../alm-conformance-step-identities.ts';
import { toStorageRefusedSendCommands, toStorageScenarioPayload } from '../storage-unavailable.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';

/**
 * The browser store factory's default recovery-lag bound, which this Deno-loaded catalog cannot import: a checkpoint
 * store whose oldest unsaved change is older fails with `checkpoint-lag`.
 */
export const CHECKPOINT_LAG_BOUND_MS = 10_000;

type CheckpointHealthStatus = 'delayed' | 'failing' | 'healthy';

/**
 * A full disk under a `local-checkpoint` channel: the send path stores nothing, so the first send is admitted while
 * every admission and work-queue write fails; its checkpoint cannot be written, so the lane's store reads `delayed`,
 * then `failing` with `checkpoint-lag`, and the refusing channel fails the next send typed. Once the quota frees, the
 * next checkpoint writes, the store reads `healthy` again and a send is admitted.
 */
export const checkpointLag: AlmConformanceScenarioDefinition = {
    scenarioId: 'checkpoint-lag',
    scenarioKey: 'checkpoint-lag',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'two-agent',
    toSenderCommands: toCheckpointLagSenderCommands,
    toRecipientCommands: toCheckpointLagReceiverCommands
};

function toCheckpointLagSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toStorageQuotaFaultCommands(sender, 'hold'),
        ...toAdmittedSendCommands({ ...sender, index: 1 }),
        toCheckpointHealthWait(sender, 'delayed'),
        toCheckpointHealthWait(sender, 'failing'),
        ...toStorageRefusedSendCommands({ ...sender, index: 2 }, {
            durability: 'local-checkpoint',
            cause: 'checkpoint-lag'
        }),
        ...toStorageQuotaFaultCommands(sender, 'release'),
        toCheckpointHealthWait(sender, 'healthy'),
        ...toAdmittedSendCommands({ ...sender, index: 3 })
    ];
}

function toAdmittedSendCommands(send: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...send,
            payload: toStorageScenarioPayload(send),
            delivery: { durability: 'local-checkpoint' }
        }),
        ...toAdmissionCommands(send)
    ];
}

/**
 * The checkpoint store of the lane that admitted the sends, matched in its emitted key order (`kind`, `storeId`, then
 * the state's `status` and `lastFailure`). Without a hold the fallback carrier keeps its sends in the overlay. The
 * store id embeds the session of the cell's own connect, so no other cell's store can match.
 */
function toCheckpointHealthWait(
    step: AlmConformanceStepInput,
    status: CheckpointHealthStatus
): RallarBlackBoxTestCommand {
    const prefix = step.input.carrier === 'ws'
        ? RECOVERED_STORE_PREFIXES.wsCheckpoint
        : RECOVERED_STORE_PREFIXES.rtcCheckpoint;
    const storeId = `${prefix}:{resultCache.${toCommandId(step, 'connect')}.value.sessionId}`;
    const failure = status === 'failing' ? ',"lastFailure":{"cause":"checkpoint-lag"' : '';
    return {
        kind: 'wait',
        commandId: toCommandId(step, `health-${status}`),
        match: {
            kind: 'diagnostic',
            topic: STORAGE_TOPIC,
            payloadPath: 'data',
            contains: `"kind":"health","storeId":"${storeId}","status":"${status}"${failure}`
        },
        timeoutMs: status === 'failing'
            ? CHECKPOINT_LAG_BOUND_MS + NON_EXPIRING_SEND_TIMEOUT_MS
            : toBudgetMs(NON_EXPIRING_SEND_TIMEOUT_MS, step.input.deadlineMs)
    };
}

/** The admitted sends arrive and the refused one never does; the third waits out the lag and its recovery. */
function toCheckpointLagReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const toWait = (index: number, absent: boolean) =>
        toPayloadWait({
            step: receiver,
            name: absent ? `absent-${index}` : `receive-${index}`,
            payload: toStorageScenarioPayload({ ...receiver, index }),
            absent
        });
    return [
        toWait(1, false),
        {
            ...toWait(3, false),
            timeoutMs: receiver.input.deadlineMs + CHECKPOINT_LAG_BOUND_MS + 2 * NON_EXPIRING_SEND_TIMEOUT_MS
        },
        toWait(2, true)
    ];
}
```

Create `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/local-checkpoint/flush-on-hide.ts`:

<!-- dprint-ignore -->
```ts
import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { CONNECT_TIMEOUT_MS, NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import { toHeldFaultCommands } from '../../alm-conformance-fault-commands.ts';
import {
    toResultAssertion,
    toRetainedEvidenceCommands,
    toSendCommand
} from '../../alm-conformance-message-commands.ts';
import { toPayloadWait, toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import {
    toCheckpointStorePrefix,
    toRecoveryTtlMs,
    toStoreRecoveryWait
} from '../../alm-conformance-session-commands.ts';

/**
 * The page's lifecycle flush saves what the interval has not: the owner page holds its carrier, admits one original
 * from memory and ends its recipe at once, inside the interval; the lane then fires the page's `freeze` event and
 * crashes it, so no `pagehide` flush and no interval write follows. The successor, a second page of the same context
 * and session, restores the row from the checkpoint store and delivers it once. Over the fallback carrier a held
 * original moves to the WS lane at a moment the lane cannot see, so which store holds it when the page ends is open:
 * the scenario runs over `ws` and `rtc`.
 */
export const flushOnHide: AlmConformanceScenarioDefinition = {
    scenarioId: 'flush-on-hide',
    scenarioKey: 'flush-on-hide',
    tags: FULL_TAGS,
    carriers: ['ws', 'rtc'],
    roles: ['sender', 'receiver', 'successor'],
    laneFamily: 'same-context',
    toSenderCommands: (page) => page.role === 'successor' ? toSuccessorCommands(page) : toOwnerCommands(page),
    toRecipientCommands: toFlushOnHideReceiverCommands
};

function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldFaultCommands(owner, 'flush-hold', 'until-cleared'),
        toSendCommand({
            ...owner,
            index: 1,
            payload: toPayload(owner),
            delivery: {
                ack: 'receiver',
                durability: 'local-checkpoint',
                ttlMs: toRecoveryTtlMs(owner.input.deadlineMs),
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toRetainedEvidenceCommands({ ...owner, index: 1 }, true)
    ];
}

/** The flushed row is held reserved under a lease, so the successor's prologue waits that lease out before it connects. */
function toSuccessorCommands(successor: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toStoreRecoveryWait(successor, {
            name: 'recovered-checkpoint-store',
            storeIdPrefix: toCheckpointStorePrefix(successor.input.carrier),
            lane: '',
            connectName: 'connect',
            timeoutMs: toRecoveryTtlMs(successor.input.deadlineMs)
        }),
        toResultAssertion({
            step: successor,
            name: 'assert-recovered-claimed',
            resultName: 'recovered-checkpoint-store',
            field: 'event.payload.data.outcome.claimed',
            operator: 'gt',
            expected: 0
        })
    ];
}

function toFlushOnHideReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        {
            ...toPayloadWait({ step: receiver, name: 'receive-original', payload: toPayload(receiver), absent: false }),
            timeoutMs: CONNECT_TIMEOUT_MS + toRecoveryTtlMs(receiver.input.deadlineMs)
        },
        toReceivedCommand({ ...receiver, index: 1, count: 2, absent: true })
    ];
}

/** The payload names its carrier, so a wait never matches another carrier's cell. */
function toPayload(step: AlmConformanceStepInput): Readonly<Record<string, string>> {
    return { marker: step.scenarioId, carrier: step.input.carrier };
}
```

- [ ] **Step 5: Withhold the two-agent cells from the hosted manifests, and regenerate (R-I2b-8).**

<!-- dprint-ignore -->
```diff
diff --git a/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts b/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts
index 834f5adc3..936c03812 100644
--- a/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts
+++ b/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts
@@ -57,7 +57,10 @@ interface HetznerWithheldAlmScenario {
 const HETZNER_WITHHELD_ALM_SCENARIOS: readonly HetznerWithheldAlmScenario[] = [
     // Reads red by a recorded gap: no plain-member write advances the snapshot version, so a floor one past it is
     // never reached.
-    { scenarioKey: 'not-yet-in-sync-delivered-after-refresh', carriers: ALM_CONFORMANCE_CARRIERS }
+    { scenarioKey: 'not-yet-in-sync-delivered-after-refresh', carriers: ALM_CONFORMANCE_CARRIERS },
+    // The checkpoint tier's lane evidence is local and the hosted full read's; manifest 18 keeps its recorded cells.
+    { scenarioKey: 'checkpoint-recovery', carriers: ALM_CONFORMANCE_CARRIERS },
+    { scenarioKey: 'checkpoint-lag', carriers: ALM_CONFORMANCE_CARRIERS }
 ];
 
 export function createAlmConformance2AgentEntry(): HetznerDistributedManifestEntry {
```

```sh
node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
# checked 67 Hetzner distributed manifest(s)
node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts && git diff --quiet -- apps/rallar-black-box/manifests
# exit 0: manifests 18 and 22 byte-identical
```

(`npx tsx` fails under the sandbox with `listen EPERM` on its IPC pipe; `node --import tsx`, or the sandbox off.)

- [ ] **Step 6: The lane: the reload check reads the authored sync points, and the same-context runner ends the owner
      page by its scenario's end.**

<!-- dprint-ignore -->
```diff
diff --git a/tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts b/tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts
index b4675ba04..74da6b348 100644
--- a/tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts
+++ b/tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts
@@ -21,6 +21,7 @@ import {
     type ALMObservationPageDiagnosticsFile
 } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-page-diagnostics.ts';
 import { decodeALMObservationSnapshot } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts';
+import { toAlmReloadCheckpoints } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
 import { assessAlmConformanceIdentity } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-conformance-identity.ts';
 import { readAlmReceiptRolesEntries } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
 import {
@@ -101,8 +102,9 @@ const skippedScenarioIds = (process.env.RALLAR_BLACK_BOX_ALM_SKIP ?? '')
 const CONFORMANCE_TYPE_ID = 'alm.conformance';
 const CONFORMANCE_DEADLINE_MS = 18_000;
 // Finite carrier ceiling covers the conformance recipes and connection readiness: the next whole minute above the
-// widest cell, rtc-with-ws-fallback in the full scope, measured at 7.0, 7.0 and 7.1 minutes with the fallback family.
-const CARRIER_TEST_TIMEOUT_MS = 480_000;
+// widest cell, rtc-with-ws-fallback in the full scope, measured at 7.0, 7.0 and 7.1 minutes with the fallback family,
+// to which checkpoint-recovery and checkpoint-lag add about 90 s (an estimate until the cell is measured again).
+const CARRIER_TEST_TIMEOUT_MS = 540_000;
 
 /**
  * Playwright clears the output root once at the start of a run and deletes each passing test's own
@@ -245,7 +247,7 @@ async function runAlmConformanceScenarios(
                 receiverNavigations += 1;
             }
         };
-        const reload = scenario.scenarioId === 'delivery-reload';
+        const reload = toAlmReloadCheckpoints(scenario.sender.metadata?.almReloadCheckpoints) !== undefined;
         if (reload) {
             run.sender.page.on('framenavigated', onSenderNavigation);
             run.receiver.page.on('framenavigated', onReceiverNavigation);
@@ -307,7 +309,10 @@ interface SameContextCell {
     readonly participants: TwoAgentRunParticipant[];
 }
 
-/** Each scenario closes the page that owns the sender's session, so its successor owns the session for the next one. */
+/**
+ * Each scenario ends the page that owns the sender's session, so its successor owns the session for the next one.
+ * `flush-on-hide` ends it through its lifecycle flush and a crash; every other scenario closes it.
+ */
 async function runSameContextScenarios(cell: SameContextCell): Promise<void> {
     const { run, carrier, testInfo, participants } = cell;
     let owner = run.sender;
@@ -317,7 +322,8 @@ async function runSameContextScenarios(cell: SameContextCell): Promise<void> {
         }
         const successor = await openSuccessorPage({ testInfo, run, owner });
         participants.push(successor);
-        const outcome = await runRecipeTrioOnSameContext(run, { owner, successor }, {
+        const ownerEnd = scenario.scenarioId === 'flush-on-hide' ? 'flush-and-crash' : 'close';
+        const outcome = await runRecipeTrioOnSameContext(run, { owner, successor, ownerEnd }, {
             ...scenario,
             successor: scenario.successor
         });
diff --git a/tests/playwright/rallar-black-box/full-stack-same-context-run.ts b/tests/playwright/rallar-black-box/full-stack-same-context-run.ts
index 15c9805f3..d7a105bce 100644
--- a/tests/playwright/rallar-black-box/full-stack-same-context-run.ts
+++ b/tests/playwright/rallar-black-box/full-stack-same-context-run.ts
@@ -1,4 +1,4 @@
-import type { TestInfo } from '@playwright/test';
+import type { Page, TestInfo } from '@playwright/test';
 
 import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
 import {
@@ -15,10 +15,20 @@ import {
     type TwoAgentRunParticipant
 } from './full-stack-helpers.ts';
 
+/**
+ * How the owner's page ends: closed, or through a lifecycle flush and a renderer crash, which runs no `pagehide`
+ * listener and no later timer, so the successor restores only what the page saved before the crash.
+ */
+export type SameContextOwnerEnd = 'close' | 'flush-and-crash';
+
+/** Well under the checkpoint interval: the flush's one readwrite commits in milliseconds on an idle page. */
+const FLUSH_COMMIT_SETTLE_MS = 250;
+
 /** The page that owns the sender's session for one scenario, and the page of the same context that follows it. */
 export interface SameContextPages {
     readonly owner: TwoAgentRunParticipant;
     readonly successor: TwoAgentRunParticipant;
+    readonly ownerEnd: SameContextOwnerEnd;
 }
 
 export interface SameContextRecipes extends RecipePair {
@@ -73,10 +83,26 @@ export async function runRecipeTrioOnSameContext(
 ): Promise<SameContextOutcome> {
     const receiverRun = await startRecipientRecipeRun(run, run.receiver, recipes.receiver);
     const sender = await runRecipeOnAgent(run, pages.owner, recipes.sender);
-    await pages.owner.page.close();
+    await endOwnerPage(pages.owner.page, pages.ownerEnd);
     const [successor, receiver] = await Promise.all([
         runRecipeOnAgent(run, pages.successor, recipes.successor),
         receiverRun.outcome
     ]);
     return { sender, receiver, successor };
 }
+
+/**
+ * A headless page is never hidden, and `Page.setWebLifecycleState` freezes no visible page, so the lane fires the
+ * page's own `freeze` event, gives the readwrite it starts time to commit, and crashes the renderer.
+ */
+async function endOwnerPage(page: Page, end: SameContextOwnerEnd): Promise<void> {
+    if (end === 'flush-and-crash') {
+        await page.evaluate((eventType) => document.dispatchEvent(new Event(eventType)), 'freeze');
+        await page.waitForTimeout(FLUSH_COMMIT_SETTLE_MS);
+        const cdp = await page.context().newCDPSession(page);
+        const crashed = page.waitForEvent('crash');
+        void cdp.send('Page.crash').catch(() => undefined);
+        await crashed;
+    }
+    await page.close();
+}
```

- [ ] **Step 7: The Deno control fixture models the checkpoint store, the lag, the flush and the loss (red first).**
      Add the ten Deno tests and the `PortMessage`/`checkpointHealth` fields with an empty `flushCheckpoints()` first;
      then the model:

<!-- dprint-ignore -->
```diff
diff --git a/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts b/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
index 2ad0f9224..588f1d0dc 100644
--- a/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
+++ b/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
@@ -1,9 +1,17 @@
 import { assert, assertEquals } from '@std/assert';
 
 import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
-import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
-import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
-import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
+import {
+    ALM_CONFORMANCE_CARRIERS,
+    type AlmConformanceCarrier
+} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
+import { toAlmReloadCheckpoints, toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
+import {
+    createAlmConformanceRecipes,
+    type AlmConformanceScenario
+} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
+import { CHECKPOINT_LAG_BOUND_MS } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/local-checkpoint/checkpoint-lag.ts';
+import { CHECKPOINT_INTERVAL_MS } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/local-checkpoint/checkpoint-recovery.ts';
 import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
 import type {
     RallarBlackBoxTestCommand,
@@ -32,9 +40,17 @@ type MessagesPortKind = 'messages.send' | 'messages.observe' | 'messages.cancel'
 
 type PortCommand<TKind extends RallarBlackBoxTestCommand['kind']> = Extract<RallarBlackBoxTestCommand, Readonly<{ kind: TKind; }>>;
 
+/** A `local-checkpoint` row: in memory until a checkpoint saves it, lost if its page ends first. */
+type PortCheckpoint = 'unsaved' | 'saved' | 'lost';
+
+type PortCheckpointHealth = 'healthy' | 'delayed' | 'failing';
+
 interface PortMessage {
     readonly command: RallarBlackBoxTestMessagesSendCommand;
     readonly msgId: string;
+    readonly admittedAtMs: number;
+    /** Undefined for every send that is not an admitted `local-checkpoint` one. */
+    checkpoint: PortCheckpoint | undefined;
     state: string;
     submitted: boolean;
     attemptCarriers: readonly ('rtc' | 'ws')[];
@@ -42,11 +58,11 @@ interface PortMessage {
     /** The volatile bound's refusal or a refused durable send under a storage quota; undefined for every send admitted. */
     readonly failure:
         | Readonly<{ kind: 'refused'; reason: 'capacity'; }>
-        | Readonly<{ kind: 'storage-unavailable'; cause: 'quota'; }>
+        | Readonly<{ kind: 'storage-unavailable'; cause: 'quota' | 'checkpoint-lag'; }>
         | undefined;
     carrierFallback: ALDeliveryCarrierFallback | undefined;
     /** A durable send a volatile channel admitted volatile while its storage was full. */
-    readonly durabilityDowngrade: Readonly<{ requested: string; cause: 'quota'; }> | undefined;
+    readonly durabilityDowngrade: Readonly<{ requested: string; cause: 'quota' | 'checkpoint-lag'; }> | undefined;
 }
 
 interface HandedOverOutcome {
@@ -96,6 +112,8 @@ class GeneratedAlmPorts {
     /** A held admission quota fault fails every durable admission of the sender's page; its id names the failure. */
     storageQuotaFaultId: string | undefined = undefined;
     storageFailing = false;
+    /** The page's checkpoint store health, stated on its transitions only. */
+    checkpointHealth: PortCheckpointHealth = 'healthy';
     /** Whether a held fallback send's RTC leg hands it to WS at all. */
     handsOverHeldFallback = true;
     lastQuotaFaultId = '';
@@ -126,6 +144,11 @@ class GeneratedAlmPorts {
         this.absence = undefined;
     }
 
+    /** The page's lifecycle flush: every unsaved checkpoint row is written at once, unless the quota fault fails it. */
+    flushCheckpoints(): void {
+        this.writeCheckpoints(this.messages.filter(isUnsavedCheckpoint));
+    }
+
     replaceSenderDocument(): void {
         if (this.replacesDocument) {
             this.senderDocument += 100;
@@ -133,6 +156,10 @@ class GeneratedAlmPorts {
         this.handles.clear();
         this.holds.clear();
         this.writes.sender = 1;
+        for (const message of this.messages.filter(isUnsavedCheckpoint)) {
+            message.checkpoint = 'lost';
+        }
+        this.checkpointHealth = 'healthy';
         this.sender = this.createRuntime('sender');
     }
 
@@ -142,6 +169,7 @@ class GeneratedAlmPorts {
             sleep: async (duration) => {
                 if (!this.holdNextSleep) {
                     this.now += duration;
+                    this.settleCheckpoints();
                     return;
                 }
                 this.holdNextSleep = false;
@@ -155,6 +183,7 @@ class GeneratedAlmPorts {
     }
 
     private executePort(role: 'sender' | 'receiver', command: RallarBlackBoxTestCommand): RallarBlackBoxTestCommandOutcome | undefined {
+        this.settleCheckpoints();
         const document = { origin: 'https://fixture.test', timeOrigin: role === 'sender' ? this.senderDocument : 50 };
         const session = { clientId: role, sessionId: `${role}-stored-session` };
         switch (command.kind) {
@@ -348,11 +377,16 @@ class GeneratedAlmPorts {
             return;
         }
         const held = this.messages.filter(isHeldOriginal);
+        const durable = held.filter((message) => message.checkpoint === undefined);
+        const checkpointed = held.filter((message) => message.checkpoint === 'saved');
+        const overRtc = (message: PortMessage) => message.command.carrier === 'rtc';
         const stores = [
             { storeId: `browser-session-inbound:${sessionId}/ws`, claimed: 0 },
             { storeId: `browser-session-inbound:${sessionId}/rtc`, claimed: 0 },
-            { storeId: `browser-ws-client:${sessionId}`, claimed: held.filter((message) => message.command.carrier !== 'rtc').length },
-            { storeId: `browser-rtc-overlay:${sessionId}`, claimed: held.filter((message) => message.command.carrier === 'rtc').length }
+            { storeId: `browser-ws-client:${sessionId}`, claimed: durable.filter((message) => !overRtc(message)).length },
+            { storeId: `browser-rtc-overlay:${sessionId}`, claimed: durable.filter(overRtc).length },
+            { storeId: `browser-ws-client-checkpoint:${sessionId}`, claimed: checkpointed.filter((message) => !overRtc(message)).length },
+            { storeId: `browser-rtc-overlay-checkpoint:${sessionId}`, claimed: checkpointed.filter(overRtc).length }
         ];
         for (const { storeId, claimed } of stores) {
             this.sender.recordEvent({
@@ -369,6 +403,57 @@ class GeneratedAlmPorts {
         }
     }
 
+    /** The checkpoint timer, run on every fixture step and sleep: a row unsaved for one interval is written. */
+    private settleCheckpoints(): void {
+        this.writeCheckpoints(this.messages.filter((message) => isUnsavedCheckpoint(message) && this.now - message.admittedAtMs >= CHECKPOINT_INTERVAL_MS));
+    }
+
+    /**
+     * A positive wait runs on the real clock, so the fixture states the lag at once: a row admitted while the quota
+     * fault fails every write reads its store `delayed`, then `failing` past the bound.
+     */
+    private reportCheckpointLag(row: PortMessage): void {
+        this.reportCheckpointHealth(row, 'delayed');
+        this.reportCheckpointHealth(row, 'failing');
+    }
+
+    /** One readwrite saves every row it captured, counted as one admission write of the page. */
+    private writeCheckpoints(rows: readonly PortMessage[]): void {
+        if (rows.length === 0 || this.storageQuotaFaultId !== undefined) {
+            return;
+        }
+        for (const message of rows) {
+            message.checkpoint = 'saved';
+        }
+        this.writes.sender += 1;
+        this.reportCheckpointHealth(rows[0], 'healthy');
+    }
+
+    /** The checkpoint store of the lane holding the row: a held fallback send has moved to WS, an unheld one has not. */
+    private reportCheckpointHealth(row: PortMessage, status: PortCheckpointHealth): void {
+        if (status === this.checkpointHealth) {
+            return;
+        }
+        this.checkpointHealth = status;
+        const overRtc = row.command.carrier === 'rtc' ||
+            (row.command.carrier === 'rtc-with-ws-fallback' && !this.isHeld(row.command.typeId));
+        this.sender.recordEvent({
+            kind: 'diagnostic',
+            topic: 'rallar.browser.alm.storage',
+            payload: {
+                data: {
+                    kind: 'health',
+                    storeId: `${overRtc ? 'browser-rtc-overlay-checkpoint' : 'browser-ws-client-checkpoint'}:sender-stored-session`,
+                    status,
+                    lastFailure: status === 'delayed'
+                        ? undefined
+                        : { cause: 'checkpoint-lag', detail: `The oldest unsaved change passed ${CHECKPOINT_LAG_BOUND_MS} ms.` },
+                    lastRecoveryPointAtMs: undefined
+                }
+            }
+        });
+    }
+
     /** A store's health, stated on its transitions only. */
     private reportStoreHealth(status: 'failing' | 'healthy'): void {
         this.storageFailing = status === 'failing';
@@ -395,6 +480,7 @@ class GeneratedAlmPorts {
             if (command.match.owner === 'al-admission') {
                 this.storageQuotaFaultId = command.remaining === 0 ? undefined : command.faultId;
                 this.lastQuotaFaultId = command.faultId;
+                this.writeCheckpoints(this.messages.filter(isUnsavedCheckpoint));
             }
             return { status: 'ok', value: { faultId: command.faultId } };
         }
@@ -417,13 +503,19 @@ class GeneratedAlmPorts {
         // The lowered volatile bound refuses the third capacity send at admission (D78): no attempt, nothing delivered.
         const capacityRefused = command.payload.marker === 'capacity' && command.payload.index === 3;
         const durable = (command.durability ?? 'volatile') !== 'volatile';
+        const checkpointed = command.durability === 'local-checkpoint';
         const quotaHeld = this.storageQuotaFaultId !== undefined;
-        const storageRefused = durable && quotaHeld && command.onStorageUnavailable !== 'volatile';
-        const downgraded = durable && quotaHeld && command.onStorageUnavailable === 'volatile';
+        // The checkpoint tier's send path stores nothing: only a checkpoint lag past its bound makes it unavailable.
+        const unavailable = checkpointed ? this.checkpointHealth === 'failing' : quotaHeld;
+        const storageRefused = durable && unavailable && command.onStorageUnavailable !== 'volatile';
+        const downgraded = durable && unavailable && command.onStorageUnavailable === 'volatile';
+        const cause = checkpointed ? 'checkpoint-lag' : 'quota';
         const rejected = command.payload.marker === 'bounded-rejection' || capacityRefused || storageRefused;
         const message: PortMessage = {
             command,
             msgId: `port-message-${this.messages.length + 1}`,
+            admittedAtMs: this.now,
+            checkpoint: checkpointed && !storageRefused && !downgraded ? 'unsaved' : undefined,
             state: storageRefused ? 'failed' : rejected ? 'rejected' : command.payload.seq === 300 ? 'queued' : 'accepted',
             submitted: false,
             attemptCarriers: [],
@@ -431,23 +523,26 @@ class GeneratedAlmPorts {
             failure: capacityRefused
                 ? { kind: 'refused', reason: 'capacity' }
                 : storageRefused
-                ? { kind: 'storage-unavailable', cause: 'quota' }
+                ? { kind: 'storage-unavailable', cause }
                 : undefined,
             carrierFallback: undefined,
-            durabilityDowngrade: downgraded ? { requested: String(command.durability), cause: 'quota' } : undefined
+            durabilityDowngrade: downgraded ? { requested: String(command.durability), cause } : undefined
         };
-        if (storageRefused && !this.storageFailing) {
+        if (!checkpointed && storageRefused && !this.storageFailing) {
             this.reportStoreHealth('failing');
         }
-        if (durable && !quotaHeld && this.storageFailing) {
+        if (durable && !checkpointed && !quotaHeld && this.storageFailing) {
             this.reportStoreHealth('healthy');
         }
         this.messages.push(message);
         assert(command.handleId);
         this.handles.set(command.handleId, message);
-        if (durable && !quotaHeld) {
+        if (durable && !checkpointed && !quotaHeld) {
             this.writes.sender += 1;
         }
+        if (message.checkpoint === 'unsaved' && quotaHeld) {
+            this.reportCheckpointLag(message);
+        }
         if (command.payload.revision === 'replacement') {
             for (const prior of this.messages) {
                 if (prior.command.typeId === command.typeId && isJsonRecordValue(prior.command.payload) && prior.command.payload.revision === 'old') {
@@ -805,10 +900,16 @@ for (const replacesDocument of [true, false]) {
     });
 }
 
-/** A durable original a page held when it ended: a reloaded document's or a closed owner page's. */
+const HELD_ORIGINAL_MARKERS = ['delivery-reload', 'durable-takeover', 'checkpoint-recovery', 'flush-on-hide'];
+
+/** A durable original a page held when it ended, a reloaded document's or an ended owner page's, that its page saved. */
 function isHeldOriginal(message: PortMessage): boolean {
     const marker = isJsonRecordValue(message.command.payload) ? message.command.payload.marker : undefined;
-    return (marker === 'delivery-reload' || marker === 'durable-takeover') && !message.submitted;
+    return HELD_ORIGINAL_MARKERS.includes(String(marker)) && !message.submitted && message.checkpoint !== 'lost';
+}
+
+function isUnsavedCheckpoint(message: PortMessage): boolean {
+    return message.checkpoint === 'unsaved';
 }
 
 for (const carrier of ALM_CONFORMANCE_CARRIERS) {
@@ -861,6 +962,103 @@ Deno.test('the rtc-with-ws-fallback owner fails while its held RTC leg never han
     assertEquals(owner.ok, false, JSON.stringify(owner));
 });
 
+function findCatalogScenario(carrier: AlmConformanceCarrier, scenarioId: string): AlmConformanceScenario {
+    const scenario = createAlmConformanceRecipes({
+        group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
+        carrier,
+        typeId: 'alm.conformance',
+        senderConnection: 'almConformanceSender',
+        receiverConnection: 'almConformanceReceiver',
+        deadlineMs: 18_000
+    }).find((candidate) => candidate.scenarioId === scenarioId);
+    assert(scenario, `${scenarioId} over ${carrier}`);
+    return scenario;
+}
+
+/** The recipe's commands from the one after `after` up to and including `through`; undefined ends at the last. */
+function toSegment(recipe: RallarBlackBoxTestRecipe, after: string | undefined, through: string | undefined): RallarBlackBoxTestRecipe {
+    const ids = recipe.commands.map((command) => command.commandId);
+    const start = after === undefined ? 0 : ids.indexOf(after) + 1;
+    const end = through === undefined ? ids.length : ids.indexOf(through) + 1;
+    return { ...recipe, recipeId: `${recipe.recipeId}:${start}`, commands: recipe.commands.slice(start, end) };
+}
+
+function findMarked(ports: GeneratedAlmPorts, marker: string): readonly PortMessage[] {
+    return ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.marker === marker);
+}
+
+for (const carrier of ALM_CONFORMANCE_CARRIERS) {
+    Deno.test(`the ${carrier} checkpoint-recovery pair restores the interval's checkpoint across the reload`, async () => {
+        const { sender, receiver } = findCatalogScenario(carrier, 'checkpoint-recovery');
+        const [checkpoint] = toAlmReloadCheckpoints(sender.metadata?.almReloadCheckpoints) ?? [];
+        assert(checkpoint);
+        const ports = new GeneratedAlmPorts(true);
+
+        const results = [
+            await ports.receiver.execute(toRecipeRun(toSegment(receiver, undefined, checkpoint.receiverReadyEnd))),
+            await ports.sender.execute(toRecipeRun(toSegment(sender, undefined, checkpoint.senderPrefixEnd))),
+            await ports.receiver.execute(toRecipeRun(toSegment(receiver, checkpoint.receiverReadyEnd, checkpoint.receiverAbsenceEnd)))
+        ];
+        ports.replaceSenderDocument();
+        results.push(
+            await ports.sender.execute(toRecipeRun(toSegment(sender, checkpoint.senderReload, undefined))),
+            await ports.receiver.execute(toRecipeRun(toSegment(receiver, checkpoint.receiverAbsenceEnd, undefined)))
+        );
+
+        for (const result of results) {
+            assertEquals(result.ok, true, JSON.stringify(result));
+        }
+        assertEquals(findMarked(ports, 'checkpoint-recovery').map((message) => message.submitted), [true], 'the restored original is sent once');
+    });
+
+    Deno.test(`the ${carrier} checkpoint-lag recipes lag, refuse, recover and deliver the admitted sends`, async () => {
+        const { sender, receiver } = findCatalogScenario(carrier, 'checkpoint-lag');
+        const ports = new GeneratedAlmPorts(true);
+
+        const owner = await ports.sender.execute(toRecipeRun(sender));
+        const received = await ports.receiver.execute(toRecipeRun(receiver));
+
+        assertEquals(owner.ok, true, JSON.stringify(owner));
+        assertEquals(received.ok, true, JSON.stringify(received));
+        assertEquals(
+            findMarked(ports, 'checkpoint-lag').map((message) => [message.state, message.failure]),
+            [['acknowledged', undefined], ['failed', { kind: 'storage-unavailable', cause: 'checkpoint-lag' }], ['acknowledged', undefined]]
+        );
+    });
+}
+
+for (const carrier of ['ws', 'rtc'] as const) {
+    Deno.test(`the ${carrier} flush-on-hide successor restores what the owner's lifecycle flush saved`, async () => {
+        const { sender, receiver, successor } = findCatalogScenario(carrier, 'flush-on-hide');
+        assert(successor);
+        const ports = new GeneratedAlmPorts(true);
+
+        const owner = await ports.sender.execute(toRecipeRun(sender));
+        ports.flushCheckpoints();
+        ports.replaceSenderDocument();
+        const restored = await ports.sender.execute(toRecipeRun(successor));
+        const received = await ports.receiver.execute(toRecipeRun(receiver));
+
+        for (const [role, result] of [['owner', owner], ['successor', restored], ['receiver', received]] as const) {
+            assertEquals(result.ok, true, `${role}: ${JSON.stringify(result)}`);
+        }
+        assertEquals(findMarked(ports, 'flush-on-hide').map((message) => message.submitted), [true]);
+    });
+
+    Deno.test(`the ${carrier} flush-on-hide successor restores nothing when the owner's page ends unflushed inside the interval`, async () => {
+        const { sender, successor } = findCatalogScenario(carrier, 'flush-on-hide');
+        assert(successor);
+        const ports = new GeneratedAlmPorts(true);
+
+        await ports.sender.execute(toRecipeRun(sender));
+        ports.replaceSenderDocument();
+        const restored = await ports.sender.execute(toRecipeRun(successor));
+
+        assertEquals(restored.ok, false, JSON.stringify(restored));
+        assertEquals(findMarked(ports, 'flush-on-hide').map((message) => message.submitted), [false], 'the unsaved admission is lost with its page');
+    });
+}
+
 function toRecipeRun(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestCommand {
     return { kind: 'recipe.run', commandId: `${recipe.recipeId}-run`, recipe };
 }
```

Red, recorded (the tests and an empty `flushCheckpoints()`, on the scaffold base; 18 min 15 s, since a positive `wait`
times out on the real clock): `FAILED | 8 passed | 8 failed`. Each `checkpoint-recovery` test fails at
`alm-<carrier>-checkpoint-recovery-sender-recovered-checkpoint-store` (`RALLAR_BLACK_BOX_WAIT_TIMEOUT`: no checkpoint
store reports); each `checkpoint-lag` test at `…-sender-assert-admitted-1` (`RALLAR_BLACK_BOX_ASSERT_FAILED`: the old
model refused a durable send under the quota); each `flush-on-hide` restore at
`…-successor-recovered-checkpoint-store`. The two loss tests (an unflushed owner page restores nothing) pass in red and
green: they guard the model. Green:

```sh
(cd apps/rallar-black-box-control-server && deno test --allow-run --allow-net --allow-env --allow-read --allow-write test/control-generated-alm-reload.test.ts)
# ok | 16 passed | 0 failed (410ms)
```

- [ ] **Step 8: The navigation docs.**

<!-- dprint-ignore -->
```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md b/packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md
index 58d97d41b..60b2788e9 100644
--- a/packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md
+++ b/packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md
@@ -78,7 +78,8 @@ records what the runner was doing while the cell ran:
   [outbound admission diagnostics](./runtime-diagnostic-contract.md). It is `too-few-samples` below
   `ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT` samples. Only `send`-origin commits count, because a
   drain's commit measures a different read chain than a caller's own admission.
-  - Only commits whose `lane` is `durable` count (R-S3a-15). The 30 / 35 ms thresholds were
+  - Only commits whose `lane` is `durable` count (R-S3a-15); a `checkpoint` lane commits to its memory
+    pair, as `volatile` does, and is left out with it. The 30 / 35 ms thresholds were
     calibrated on IndexedDB read chains; a memory lane's commit reads no IndexedDB, and its cost is
     the page's event-loop contention instead: 0–5 ms per operation for a send and up to 39 ms for a
     repair on a local run, figures that say nothing about the runner's storage. An event recorded
diff --git a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
index 7bffd09c3..e78510e48 100644
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -471,14 +471,20 @@ current shape.
 `rallar.browser.alm.storage` carries every `ALStorageEvent` but a reset; the
 event's `data` is the event itself, with `kind` and, except for `persist`, the
 `storeId` of the store it describes (`browser-session-inbound:<sessionId>`,
-`browser-ws-client:<sessionId>` or `browser-rtc-overlay:<sessionId>`). The
+`browser-ws-client:<sessionId>` or `browser-rtc-overlay:<sessionId>`, and the
+`local-checkpoint` lanes' checkpoint stores `browser-ws-client-checkpoint:<sessionId>`
+and `browser-rtc-overlay-checkpoint:<sessionId>`). The
 session inbound store is shared by the WS and RTC lanes, so its `recovery`
 names the lane after the store id (`browser-session-inbound:<sessionId>/ws`,
-`browser-session-inbound:<sessionId>/rtc`).
-
-- `health`: `status` (`healthy` or `failing`), `lastFailure` (an
-  `ALStorageUnavailable`: `cause` and `detail`) and `lastRecoveryPointAtMs`
-  (the store's last recovery point, or `undefined` before its first). A store
+`browser-session-inbound:<sessionId>/rtc`). A checkpoint store is the tier's
+saved copy of a memory lane; it is unrelated to the harness's reload
+checkpoints (`AlmReloadCheckpoint`, the `almReloadCheckpoints` metadata), which
+are the sync points of a paired `agent.reload`.
+
+- `health`: `status` (`healthy`, `delayed` or `failing`), `lastFailure` (an
+  `ALStorageUnavailable`: `cause` and `detail`), `lastRecoveryPointAtMs`
+  (the store's last recovery point, or `undefined` before its first) and
+  `oldestUnsavedAgeMs` (a checkpoint store's oldest unsaved change). A store
   starts `healthy` without an event and states only a change of status, never
   one event per send: `failing` at its first storage failure, `healthy` at the
   first recovery point after it. Every emitted event carries the failure that
@@ -500,6 +506,17 @@ names the lane after the store id (`browser-session-inbound:<sessionId>/ws`,
   `lastFailure` is absent when the purge failed for a reason other than
   storage; the browser logs that error instead.
 
+  A checkpoint store states `delayed` once its oldest unsaved change is older
+  than the checkpoint interval (1 s by default) and `failing` with
+  `lastFailure.cause: 'checkpoint-lag'` once it is older than the recovery-lag
+  bound (10 s by default); a completed checkpoint reads `healthy` again. While
+  it is `failing`, a new `local-checkpoint` admission follows its channel's
+  `onStorageUnavailable`. `checkpoint-lag` holds the `quota` storage fault on
+  the sender's page, admits one send from memory, waits for its checkpoint
+  store's `delayed` and then `failing` with that cause, proves the next send
+  refused `storage-unavailable` with cause `checkpoint-lag`, releases the fault,
+  and waits for the store's `healthy`.
+
 - `persist`: `outcome` (`granted`, `denied` or `unsupported`), once per connect
   after its first durable admission: `granted` when the origin already
   persisted or the browser granted the request, `denied` when it refused or the
@@ -557,6 +574,15 @@ names the lane after the store id (`browser-session-inbound:<sessionId>/ws`,
   hand-over is recorded before the WS row commits, and a WS attempt exists only
   once it has, so the held row is in the WS client store the successor reads.
 
+  A checkpoint store reports `restored` when its lane's first batch runs over
+  the rows the owner's restore loaded from the last checkpoint; a non-owner tab
+  restores nothing. `checkpoint-recovery` reads one checkpoint write after the
+  interval, reloads, waits out one lease and reads the held original's
+  checkpoint store (`browser-rtc-overlay-checkpoint` over `rtc`,
+  `browser-ws-client-checkpoint` otherwise) `restored` with `claimed` above 0;
+  `flush-on-hide` reads the same on the successor page after the lane fired the
+  owner page's `freeze` event and crashed it.
+
 ## Compatibility
 
 Adding optional fields to diagnostic payloads is compatible.
diff --git a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
index 0ad29110a..ed2a69b94 100644
--- a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
+++ b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
@@ -387,7 +387,9 @@ peer, as the sender's and the receiver's do, since both pages are one session an
 server keeps one WebSocket per auth session and a second upgrade closes the first with `connection-replaced`, after
 which the first page reconnects and replaces the second. The lane therefore starts the receiver, runs the sender's
 recipe, closes the sender's page from Playwright, and only then runs the successor's recipe, whose prologue waits out
-the owner page's last work lease before its connect; no control command closes a page. No `reset` runs on a successor
+the owner page's last work lease before its connect; no control command closes a page. For `flush-on-hide` the lane
+ends the sender's page instead by firing its `freeze` event, waiting 250 ms and crashing it over CDP (`Page.crash`), so
+no `pagehide` listener and no later timer of that page runs. No `reset` runs on a successor
 page, since it would clear the storage both pages share. Each scenario opens its own successor, which owns the session
 for the next one. The Hetzner entries select their scenarios by lane family (`two-agent` and `addressed` for manifest
 18, `three-agent` for manifest 22), so neither carries this family: a hosted agent has no second page in its context.
@@ -548,6 +550,23 @@ stands, recovered by a later batch at the lease end plus at most 19.1 s, is not
 batch that reports nothing, and the server keeps one socket per auth session, so the successor cannot connect before
 the owner's page is gone.
 
+`checkpoint-recovery` runs over every carrier as a paired reload, like `delivery-reload`. The sender holds its carrier,
+resets the storage counters, sends one `local-checkpoint` original with `ack: 'receiver'` and the same lifetime as the
+takeover's, proves it admitted, enqueued, retained and unsubmitted, waits out the checkpoint interval (1 s) and a
+margin, and asserts the counters' `byKind.write` above 0: the send path writes nothing, so that write is the
+interval's checkpoint. It then reloads; the reload's own `pagehide` flush is best effort and not what the cell proves.
+The reloaded page waits out one lease (the checkpoint holds the row reserved), reconnects with the restored session,
+reads the old handle `unobservable` and the checkpoint store of the held original `restored` with `claimed` above 0.
+The receiver proves the original absent before the reload, receives it once after, and proves no second copy.
+`checkpoint-lag` is described with the storage diagnostics. `flush-on-hide` runs over `ws` and `rtc` in the
+same-context family: the owner page holds its carrier, sends one `local-checkpoint` original and ends its recipe at
+once, inside the interval; the lane fires the page's `freeze` event and crashes it, and the successor restores the
+checkpoint store with `claimed` above 0. A headless page is never hidden and CDP `Page.setWebLifecycleState` freezes no
+visible page, so the cell drives the event the flush listens for, not a frozen page; that the write is the flush's and
+not the interval's rests on the lane ending the page inside the interval. Over `rtc-with-ws-fallback` a held original
+moves to the WS lane at no known moment, so the cell does not run there. All three are `full` only and withheld from
+the hosted manifests, so manifests 18 and 22 are unchanged.
+
 `agent.reload` asks the control agent to reload its page and resume the run. The
 agent records the run id, its agent id and the command ids it already completed
 in `localStorage` under `rallar-bb-agent-resume`, replays that record on
```

- [ ] **Step 9: Format the touched files only; run the focused tests green.**

```sh
npx dprint fmt $(git diff --name-only; git ls-files --others --exclude-standard)
npx vitest run packages/tests/shared-test/alm-conformance-local-checkpoint.test.ts \
  packages/tests/shared-test/alm-conformance-recipes.test.ts \
  packages/tests/shared-test/alm-conformance-recipe-validation.test.ts \
  packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts \
  packages/tests/shared-test/alm-reload-recipes.test.ts \
  packages/tests/rallar-black-box/full-stack-same-context-run.test.ts \
  packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts \
  packages/tests/rallar-black-box/alm-reload-manifest.test.ts
#  Test Files  8 passed (8)
#       Tests  116 passed (116)
```

- [ ] **Step 10: The task's checks.** Measured on `8e24272bc` (sandbox off for the port-binding suites, tsx and Deno):

```sh
npx vitest run packages/tests/shared-test packages/tests/rallar-black-box packages/tests/rallar-black-box-headless
#  Test Files  373 passed (373)   Tests  4050 passed (4050)   (sandbox disabled; sandboxed, the five port-bind files fail:
#  Test Files  5 failed | 368 passed (373), all `listen EPERM`)
npx tsc -p packages/shared-test/tsconfig.json --noEmit                 # exit 0
(cd apps/rallar-black-box && npx tsc --noEmit)                         # exit 0
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1445 test files enforced, 0 files carrying known debt (0 errors).  PASS
WT=$PWD; cat > $TMPDIR/tsconfig.playwright.json <<JSON
{ "extends": "$WT/packages/tests/tsconfig.json",
  "compilerOptions": { "noEmit": true, "typeRoots": ["$WT/node_modules/@types"], "types": ["node"] },
  "include": ["$WT/tests/playwright/rallar-black-box/**/*.ts", "$WT/tests/playwright/relic-hunters/**/*.ts"] }
JSON
npx tsc -p $TMPDIR/tsconfig.playwright.json
# 28 errors, the same as before the task, none in a touched file (none under tests/playwright/relic-hunters)
(cd apps/rallar-black-box-control-server && deno task check && deno task test)
# check exit 0; ok | 206 passed | 0 failed with the sandbox disabled (sandboxed: 199 passed | 7 failed, the port-bind
# cases of control-dispatch-triggers.test.ts and control-reload-socket.test.ts; the 16 fixture cases pass)
node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
# checked 67 Hetzner distributed manifest(s); regenerated byte-identical
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS ×3
npm run check:test-reachability
# Test reachability: 1747 test files, 1741 reached by CI, 6 manual.
```

Bundles: the catalog is in neither bundle (no `conformance/alm/scenarios` module in the headless metafile); headless
302.151 KiB before and after (budget 303 since Task 5), `browser/rallar.ts` 237.287 KiB untouched (238). The lane is not run here (ports off limits);
Task 9 runs `baseline family over <carrier>` and `same-context family over <carrier>` in the full scope. Estimated cost
per carrier: `checkpoint-recovery` about 55 s (the 17 s absence window, the reload, the 11 s lease, the reconnect, the
17 s single-copy window), `checkpoint-lag` about 30–35 s, `flush-on-hide` about 35 s. The baseline cell of the fallback
carrier measured 7.1 min of the 8-min `CARRIER_TEST_TIMEOUT_MS` before this task and gains about 90 s, so the spec
raises the ceiling to the next whole minute above the estimate, 540 s, stated as an estimate in its comment; Task 9
re-measures it and sets the next whole minute above the measured widest cell.

- [ ] **Step 11: Commit.**

```sh
git add -A apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts packages/shared-test/rallar-bb-test packages/tests/shared-test/alm-conformance-local-checkpoint.test.ts packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/rallar-black-box/full-stack-same-context-run.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts tests/playwright/rallar-black-box/full-stack-same-context-run.ts
git commit -F - <<'MSG'
The checkpoint tier's lane scenarios: checkpoint-recovery, checkpoint-lag and flush-on-hide

checkpoint-recovery is a paired reload over every carrier: the sender holds its carrier,
admits one local-checkpoint original from memory, reads the interval's checkpoint write in
the storage counters, reloads, waits out one lease, reconnects with the restored session and
reads the old handle unobservable and the checkpoint store restored with a claim; the
receiver gets the original once. checkpoint-lag holds the quota storage fault: the first send
is admitted, the checkpoint store reads delayed, then failing with checkpoint-lag, the next
send is refused storage-unavailable, and after the release the store reads healthy and a
send is admitted. flush-on-hide runs over ws and rtc in the same-context family: the lane
fires the owner page's freeze event and crashes it inside the interval, and the successor
restores the checkpoint store with a claim. The reload sync points become a scenario field,
the hosted manifests withhold the two two-agent cells and regenerate byte-identical, and the
control-server fixture models the checkpoint store, the lag, the flush and the loss of an
unsaved row with its page.

D8 reuse: the reload pair, toStoreRecoveryWait, toOwnerLeaseLapseWait, the native hold, the quota fault commands, storage-unavailable's refused send (now taking the durability and cause), the retained-evidence and admission commands, the same-context runner and its successor page, and the fixture's ports are reused; the three scenarios live in one feature folder so the scenarios directory stays at 20 files; no new command kind, family or identity assessment.
MSG
```

---

### Task 8: Relic Hunters' commands move to `local-checkpoint`; the reload-mid-command case

Prototyped in scratch as commit `49cfba7bb` (on Task 7's `8e24272bc`; it touches none of Task 7's files and applies on
Task 2 alone). Red then green. D115, D126, D134; R-I2b-7, R-I2b-11. It needs no code of Tasks 3–7: the channel's
`durability` field takes any `ALDurabilityAlgo` (Task 1), and the browser behaviour is consumed only through the page.

**Assembly.** Commit `15a86229f` on `a56823ca7` (Task 7) in the composed chain: W-D's patch applied unchanged; the red
was re-measured on Task 7's tree and matches. No bundle figure moves (`browser/rallar.ts` 237.287, headless 302.151).
Bundle figures are read with a private `TMPDIR` (R-I2b-23): the bundle script and the headless boundary test write
under `os.tmpdir()`, which every worktree of the machine shares. After every `cd apps/api-v1 && deno task check`, run
`rm -rf apps/api-v1/node_modules/.deno` and `find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete` (a
left-behind `.deno` breaks the next check).

**The hold: Playwright WebSocket routing on the admin's context.** The black-box fault port is not in the Relic app.
Three ways were weighed:

- a server-side delay the spec controls: a test hook in `relic-game-service.ts` or `apply-relic-ws-command.ts`, server
  code changed for a test, and the server would still receive the frame (the resume would never be exercised);
- waiting out the interval and reloading at once: the command's frame leaves before the reload, the server applies it,
  and the resumed copy is only a duplicate; nothing proves the resume;
- `browserContext.routeWebSocket` (Playwright 1.61.1): the route connects each page socket to the server and forwards
  every frame except, while held, the page's frames that carry `RELIC_TYPES.command` (`relic.command.v1`; the WS
  client sends JSON text, `ws-queue-box-client-service.ts:406`, `sendAsJsonString`). The page sees a socket that took
  the frame, as the harness's native hold does; the server sees nothing. The route is on the context, so the reloaded
  page's new socket goes through it unheld. Chosen: no product or server change, deterministic, and the resume is the
  only way the command can reach the server.

**The witness: `start-expedition`.** `applyRelicCommand` appends a "started the expedition" event on every application
and leaves the phase alone on a repeat (`packages/relic-hunters/src/rules.ts:203-224`), so the snapshot's
`eventCount` shows a double application; `submit-action` overwrites the pending action and would hide one
(`:289-310`). The case reads `eventCount` before the click and requires exactly one more on both pages after the
reload, then again after a 3 s repeat window. While the frame is held, page B still reads `lobby`: the hold is real.

**The interval.** The case waits 2 s (one 1 s interval, the browser default, and a margin) between the held click and
the reload: an admission inside the last interval is lost with its page (D134), and a `pagehide` flush is best effort
(R-I2b-7; measured in Chromium 1228 headless, a readwrite started in `pagehide` landed on 0 of 4 reloads without
`commit()`). The reload is inside the command's 30 s deadline. After it the case waits for page A's runtime `phase`
`ready` (the client's post-reload phase; the restored command has no handle and changes no UI state).

**D126's question.** "I2b's Relic Playwright proof decides whether AppInbox request-id idempotency joins": this case is
that proof. Within the 30 s deadline the resumed command keeps its msgId and the server's ALM dedup (D125, retention
max(window, deadline + grace)) is the only repeat guard the case needs. Recommendation: no request-id idempotency, if
Task 9's run of the manual suite (R-I2b-11) is green; a red `eventCount` (two start events) reopens it.

**Files**

- Modify: `apps/relic-hunters-v1/src/game/send-relic-ws-command.ts` (`:33`) — `durability: 'local-checkpoint'`;
  `onStorageUnavailable: 'refuse'` stays.
- Modify: `apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts` (`:55`) — the definition pin.
- Modify: `tests/playwright/relic-hunters/full-stack-propagation.spec.ts` — the lobby setup extracted into
  `enterLobbyWithTwoHunters` (the existing case calls it, unchanged in behaviour); the new case; the command hold.
- Modify: `apps/relic-hunters-v1/docs/runtime-data-flow.md` (Command Path, `:51-55`) — the tier, the interval, the
  last-interval loss window, the lag refusal, the proof.
- Not touched: `tests/manual-suites.json` (it already owns the spec, `:11-17`, R-I2b-11), the Relic runtime
  (`toRelicCommandPhase` already reads a `failed`/`storage-unavailable` outcome, and a `checkpoint-lag` cause reads
  the same), the server, the Relic model (no command id), `apps/relic-hunters-v1/playwright.full-stack.config.ts`.

**Interfaces**

- Consumes: `RallarTypedMessageChannelDefinition.durability: ALDurabilityAlgo` (Task 1); through the page, Tasks 3–5's
  checkpoint (an owner page's checkpoint saves an admitted command within the interval and restores it on reload).
- Produces: the channel `{ topicId, typeId, purpose: 'command', roomId, durability: 'local-checkpoint',
  onStorageUnavailable: 'refuse' }`; in the spec, `routeRelicCommandHold(context): Promise<RelicCommandHold>`
  (`hold`, `release`, `heldCount`) and `enterLobbyWithTwoHunters(pageA, pageB, suffix)`.

**D8 reuse inspection.** Reused: the channel definition's `durability`/`onStorageUnavailable` fields; the spec's
`registerHunter`, `waitForRoomId`, `expectConverged` (its `minEventCount`), `waitForRuntime`, `readRuntime` and the
`__relicHuntersRuntime` hook (`App.tsx:1618-1645`: `eventCount`, `diagnostics.phase`); the lobby setup moved into one
helper both cases call; Playwright's `routeWebSocket` as the hold; ALM msgId dedup as the repeat guard. Not added: an
idempotency key, a server hook, a new spec file (so no `manual-suites.json` entry), a REST fallback.

**Limits (state these in the PR body and the plan's Limits).**

- A command admitted inside the last interval before the page ends is lost with the page (D134); the UI shows nothing
  for it after the reload. The case waits the interval out on purpose; the loss itself is proven by Task 7's Deno
  fixture loss tests and Task 3's unit tests, not by a Relic case.
- The case runs only in the manual full-stack suite (`npm run test:playwright:relic:full-stack`); it is run once at the
  close (R-I2b-11). Not run here (ports off limits); `--list` shows both cases.
- A checkpoint lagging past its bound makes the next command `failed` with `storage-unavailable`/`checkpoint-lag`; the
  UI shows the existing "did not confirm" text, and the command is not retried over REST (as under `local-outbox`).
- The WS route matches the Rallar socket by path (`/api/ws/`, `api-v1` `endpoints.createWs`); a renamed endpoint would
  hold nothing and the case fails at `heldCount() > 0`, not silently.

- [ ] **Step 1: Update the pin (red).**

<!-- dprint-ignore -->
```diff
diff --git a/apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts b/apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts
index 66887dde5..1fe71b41a 100644
--- a/apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts
+++ b/apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts
@@ -52,7 +52,7 @@ describe('a Relic command to the server (D57 as applied, D72)', () => {
             typeId: RELIC_TYPES.command,
             purpose: 'command',
             roomId: 'room-42',
-            durability: 'local-outbox',
+            durability: 'local-checkpoint',
             onStorageUnavailable: 'refuse'
         }]);
         expect(sendWs).toHaveBeenCalledWith(COMMAND, { peerId: 'default-qbox-server' });
```

- [ ] **Step 2: Run it and see it fail.**

```sh
npx vitest run apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts
# -     "durability": "local-checkpoint",
# +     "durability": "local-outbox",
#  Test Files  1 failed (1)
#       Tests  1 failed | 1 passed (2)
```

- [ ] **Step 3: Move the channel.**

<!-- dprint-ignore -->
```diff
diff --git a/apps/relic-hunters-v1/src/game/send-relic-ws-command.ts b/apps/relic-hunters-v1/src/game/send-relic-ws-command.ts
index 9ed94fa5f..83f37b0c7 100644
--- a/apps/relic-hunters-v1/src/game/send-relic-ws-command.ts
+++ b/apps/relic-hunters-v1/src/game/send-relic-ws-command.ts
@@ -30,7 +30,7 @@ export async function sendRelicWsCommand(
             typeId: RELIC_TYPES.command,
             purpose: 'command',
             roomId,
-            durability: 'local-outbox',
+            durability: 'local-checkpoint',
             onStorageUnavailable: 'refuse'
         })
         .sendWs(command, { peerId: serverPeerId });
```

- [ ] **Step 4: Run it green, then the Relic roots and the workspace typecheck.**

```sh
npx vitest run apps/relic-hunters-v1/tests packages/tests/relic-hunters
#  Test Files  31 passed (31)
#       Tests  187 passed (187)
npm --workspace relic-hunters-v1 run typecheck     # tsc --noEmit, exit 0
```

- [ ] **Step 5: The reload-mid-command case.** The lobby setup moves into `enterLobbyWithTwoHunters`; the new case and
      the hold follow the first case:

<!-- dprint-ignore -->
```diff
diff --git a/tests/playwright/relic-hunters/full-stack-propagation.spec.ts b/tests/playwright/relic-hunters/full-stack-propagation.spec.ts
index 425ebcc44..578178355 100644
--- a/tests/playwright/relic-hunters/full-stack-propagation.spec.ts
+++ b/tests/playwright/relic-hunters/full-stack-propagation.spec.ts
@@ -1,4 +1,6 @@
-import { expect, test, type Page } from '@playwright/test';
+import { expect, test, type BrowserContext, type Page } from '@playwright/test';
+
+import { RELIC_TYPES } from '../../../packages/relic-hunters/src/protocol.ts';
 
 const fullStackEnabled = process.env.RELIC_HUNTERS_FULL_STACK === '1' ||
     process.env.RELIC_HUNTERS_FULL_STACK === 'true';
@@ -65,42 +67,7 @@ test.describe('full-stack Relic Hunters two-client propagation', () => {
         const pageB = await contextB.newPage();
 
         try {
-            await registerHunter(pageA, {
-                username: `alice-${suffix}`,
-                displayName: 'Alice',
-                password: `alice-pass-${suffix}`
-            });
-            await registerHunter(pageB, {
-                username: `bob-${suffix}`,
-                displayName: 'Bob',
-                password: `bob-pass-${suffix}`
-            });
-
-            await pageA.getByRole('button', { name: 'New Room' }).click();
-            await expect(pageA.getByRole('button', { name: /Join as/ })).toBeVisible();
-            const roomId = await waitForRoomId(pageA);
-
-            await pageB.getByRole('button', { name: 'Refresh' }).click();
-            const roomButtonB = pageB.locator(`button.room-row[data-room-id="${roomId}"]`);
-            await expect(roomButtonB).toBeVisible();
-            await roomButtonB.click();
-            await waitForRuntime(pageB, (runtime) => runtime.roomId === roomId);
-
-            await pageA.getByRole('button', { name: /Join as/ }).click();
-            await expectConverged(pageA, pageB, {
-                phase: 'lobby',
-                round: 1,
-                playerCount: 1,
-                submittedCount: 0
-            });
-
-            await pageB.getByRole('button', { name: /Join as/ }).click();
-            await expectConverged(pageA, pageB, {
-                phase: 'lobby',
-                round: 1,
-                playerCount: 2,
-                submittedCount: 0
-            });
+            await enterLobbyWithTwoHunters(pageA, pageB, suffix);
 
             await expect(pageA.locator('.lobby-begin-btn')).toBeEnabled();
             await pageA.locator('.lobby-begin-btn').click();
@@ -171,8 +138,133 @@ test.describe('full-stack Relic Hunters two-client propagation', () => {
             ]);
         }
     });
+
+    // The command's WS frame never reaches the server, so only the page's checkpoint carries it across the reload.
+    test('a start command held on its WS leg survives a reload inside its deadline and is applied once', async ({ browser }) => {
+        test.setTimeout(180_000);
+
+        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
+        const contextA = await browser.newContext();
+        const contextB = await browser.newContext();
+        const commandHold = await routeRelicCommandHold(contextA);
+        const pageA = await contextA.newPage();
+        const pageB = await contextB.newPage();
+
+        try {
+            await enterLobbyWithTwoHunters(pageA, pageB, suffix);
+            const eventCount = (await readRuntime(pageA))?.snapshot?.eventCount ?? 0;
+
+            commandHold.hold();
+            await pageA.locator('.lobby-begin-btn').click();
+            await expect.poll(() => commandHold.heldCount()).toBeGreaterThan(0);
+            // An admission inside the last checkpoint interval is lost with its page, so the reload waits one out.
+            await pageA.waitForTimeout(CHECKPOINT_SETTLE_MS);
+            expect((await readRuntime(pageB))?.snapshot?.phase).toBe('lobby');
+            commandHold.release();
+            await pageA.reload();
+
+            await expectConverged(pageA, pageB, {
+                phase: 'planning',
+                round: 1,
+                playerCount: 2,
+                submittedCount: 0,
+                minEventCount: eventCount + 1
+            });
+            await waitForRuntime(pageA, (runtime) => runtime.diagnostics.phase === 'ready');
+            // A second application would append a second start event; give a repeat time to land before counting.
+            await pageA.waitForTimeout(REPEAT_WINDOW_MS);
+            const [runtimeA, runtimeB] = await Promise.all([readRuntime(pageA), readRuntime(pageB)]);
+            expect(runtimeA?.snapshot?.eventCount).toBe(eventCount + 1);
+            expect(runtimeB?.snapshot?.eventCount).toBe(eventCount + 1);
+        }
+        finally {
+            await Promise.all([
+                contextA.close(),
+                contextB.close()
+            ]);
+        }
+    });
 });
 
+/** One checkpoint interval (1 s, the browser default) and a margin. */
+const CHECKPOINT_SETTLE_MS = 2_000;
+const REPEAT_WINDOW_MS = 3_000;
+const RALLAR_WS_PATH = /\/api\/ws\//;
+
+interface RelicCommandHold {
+    hold(): void;
+    release(): void;
+    heldCount(): number;
+}
+
+/**
+ * Withholds the page's Relic command frames from the server while held, as a carrier that accepted them and never
+ * delivered. Every other frame, and every frame of a socket opened after the release, goes through.
+ */
+async function routeRelicCommandHold(context: BrowserContext): Promise<RelicCommandHold> {
+    let holding = false;
+    let held = 0;
+    await context.routeWebSocket(RALLAR_WS_PATH, (socket) => {
+        const server = socket.connectToServer();
+        socket.onMessage((message) => {
+            if (holding && String(message).includes(RELIC_TYPES.command)) {
+                held += 1;
+                return;
+            }
+            server.send(message);
+        });
+    });
+    return {
+        hold: () => {
+            holding = true;
+        },
+        release: () => {
+            holding = false;
+        },
+        heldCount: () => held
+    };
+}
+
+/** Two hunters register, Alice opens a room, both join it, and both pages agree on the lobby. */
+async function enterLobbyWithTwoHunters(pageA: Page, pageB: Page, suffix: string): Promise<void> {
+    await registerHunter(pageA, {
+        username: `alice-${suffix}`,
+        displayName: 'Alice',
+        password: `alice-pass-${suffix}`
+    });
+    await registerHunter(pageB, {
+        username: `bob-${suffix}`,
+        displayName: 'Bob',
+        password: `bob-pass-${suffix}`
+    });
+
+    await pageA.getByRole('button', { name: 'New Room' }).click();
+    await expect(pageA.getByRole('button', { name: /Join as/ })).toBeVisible();
+    const roomId = await waitForRoomId(pageA);
+
+    await pageB.getByRole('button', { name: 'Refresh' }).click();
+    const roomButtonB = pageB.locator(`button.room-row[data-room-id="${roomId}"]`);
+    await expect(roomButtonB).toBeVisible();
+    await roomButtonB.click();
+    await waitForRuntime(pageB, (runtime) => runtime.roomId === roomId);
+
+    await pageA.getByRole('button', { name: /Join as/ }).click();
+    await expectConverged(pageA, pageB, {
+        phase: 'lobby',
+        round: 1,
+        playerCount: 1,
+        submittedCount: 0
+    });
+
+    await pageB.getByRole('button', { name: /Join as/ }).click();
+    await expectConverged(pageA, pageB, {
+        phase: 'lobby',
+        round: 1,
+        playerCount: 2,
+        submittedCount: 0
+    });
+}
+
 async function registerHunter(
     page: Page,
     input: Readonly<{
```

```sh
npx playwright test --config apps/relic-hunters-v1/playwright.full-stack.config.ts --list
#   [chromium] › full-stack-propagation.spec.ts:57:5 › … › two browsers converge through join, start, submit, reset, and reload recovery
#   [chromium] › full-stack-propagation.spec.ts:143:5 › … › a start command held on its WS leg survives a reload inside its deadline and is applied once
# Total: 2 tests in 1 file
npx tsc -p $TMPDIR/tsconfig.playwright.json      # Task 7's scratch tsconfig (rallar-black-box and relic-hunters)
# 28 errors, the same as before, none under tests/playwright/relic-hunters
```

- [ ] **Step 6: The docs paragraph.**

<!-- dprint-ignore -->
````diff
diff --git a/apps/relic-hunters-v1/docs/runtime-data-flow.md b/apps/relic-hunters-v1/docs/runtime-data-flow.md
index ccbb9923b..0ef08defa 100644
--- a/apps/relic-hunters-v1/docs/runtime-data-flow.md
+++ b/apps/relic-hunters-v1/docs/runtime-data-flow.md
@@ -48,11 +48,16 @@ unicast to the WS server's peer id from `/api/config`, D57 as applied). The serv
 the server admitted it. The server applies it under the sender's session username and publishes the new snapshot
 through the outbox with receipts.
 
-The command channel is `local-outbox` with `onStorageUnavailable: 'refuse'`: the command is stored before it leaves, so
-a reload resumes it under the same message id and deadline (30 s), and a browser whose storage is unavailable reports
-the command failed instead of sending it unstored. There is no command id in the model, so only the ALM message-id dedup
-within the deadline plus grace stops a repeat: the server re-acknowledges a resumed command it already admitted without
-applying it again, and drops one past its deadline as expired.
+The command channel is `local-checkpoint` with `onStorageUnavailable: 'refuse'`: the command is admitted and sent from
+memory, with no storage work on the send, and the session's checkpoint saves it within one interval (1 s by default); a
+page that is hidden or frozen starts a checkpoint at once, and one started as the page unloads is best effort. A reload
+after the save resumes the command under the same message id and deadline (30 s). A command admitted inside the last
+interval before the page ends is lost with the page, and its handle reads `unobservable`. A checkpoint that lags past
+its bound (10 s by default) makes the next command fail with `storage-unavailable` instead of being sent. There is no
+command id in the model, so only the ALM message-id dedup within the deadline plus grace stops a repeat: the server
+re-acknowledges a resumed command it already admitted without applying it again, and drops one past its deadline as
+expired. The full-stack spec holds a start command's WS frame, reloads the page past one interval and proves the
+expedition started once.
 
 ```text
 command -> WS unicast to the server -> server ACK (receipt) -> applyCommand -> persisted state -> outbox snapshot (receiver) -> WS snapshot subscription
````

- [ ] **Step 7: Format and check.**

```sh
npx dprint fmt apps/relic-hunters-v1/src/game/send-relic-ws-command.ts apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts apps/relic-hunters-v1/docs/runtime-data-flow.md tests/playwright/relic-hunters/full-stack-propagation.spec.ts
npx dprint check apps/relic-hunters-v1/src/game/send-relic-ws-command.ts apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts apps/relic-hunters-v1/docs/runtime-data-flow.md tests/playwright/relic-hunters/full-stack-propagation.spec.ts   # exit 0
node scripts/check-tests-typecheck.mjs
# PASS: no new type errors in the maintained test project
```

- [ ] **Step 8: Commit.**

```sh
git add apps/relic-hunters-v1/src/game/send-relic-ws-command.ts apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts apps/relic-hunters-v1/docs/runtime-data-flow.md tests/playwright/relic-hunters/full-stack-propagation.spec.ts
git commit -F - <<'MSG'
Send Relic commands at the local-checkpoint tier and prove a reload mid-command

The command channel moves from local-outbox to local-checkpoint and keeps refusing when
storage is unavailable: a command is admitted and sent from memory, and the session's
checkpoint saves it within one interval. The full-stack propagation spec gains a case that
withholds a start command's WS frame through Playwright's WebSocket routing, waits out one
checkpoint interval, reloads the admin's page, and proves both pages reach planning with
exactly one start event. The data-flow doc states the tier and the loss of a command
admitted inside the last interval.

D8 reuse: the channel definition's durability and onStorageUnavailable fields, the spec's registration, convergence and runtime-hook helpers (the lobby setup extracted once for both cases), Playwright's context WebSocket routing as the hold, and the ALM message-id dedup as the repeat guard; no idempotency key, no server hook, no new spec file.
MSG
```

- [ ] **Step 9: Changed-range gates (need the commit).**

```sh
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS ×3
```

No bundle measurement (nothing under `packages/shared` or `packages/shared-web`); no reachability run (no test file
added or deleted); no black-box recipe (no REST or server change). The full-stack case runs at the close (Task 9) with
`npm run test:playwright:relic:full-stack`; its summary line goes into the PR body.

---

### Task 9: Close: pins, the merge bar, the Relic suite, the hosted proofs, the PR body and the plan file

Runs after Tasks 1–8 are committed, reviewed and pushed. It confirms the pins did not move, runs the local merge bar
(with the three new cells in the full ALM lane), runs the Relic manual full-stack suite once (R-I2b-11, R-I2b-27),
re-measures the longest lane cell against the 540 s ceiling (R-I2b-34), runs one final whole-branch review with one
fix wave, takes the branch through the Branch Release Gate, hosted manifests 18 and 22 (byte-identical, so regression
reads: R-I2b-8, R-I2b-35) and the ALM observation, publishes the PR title and body, and deletes this plan file in its
last commit. It never merges and never takes the PR out of draft on its own.

**Files**

- Modify: `playground/alm/alm-qos-product-plan.md` §10.1 (the "**I2b, checkpointed durability:**" bullet reading
  "Delivered (I2b, <H1>)", R-I2b-42); `packages/shared-web/bundle-budgets.json` and
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` only if a budget is crossed;
  `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`'s `CARRIER_TEST_TIMEOUT_MS` only if Step 7's
  measurement says so.
- Modify (fix wave only): the files the final review's Critical and Important findings name.
- Delete (last commit): `plans/active/alm-i2b-local-checkpoint-implementation-plan.md`.
- Create (never committed): `tmp/i2b-task9/**` (logs, artifacts, `pr-body.md`, `hosted.md`, `figures.md`).
- Test: the local merge bar (Steps 3–7); no new test file.

**Interfaces**

- Consumes: Tasks 1–8 pushed; the ledger and cold pins at their I2a-ii figures (chain 6, total 8, 37 requests,
  `al-admission` 10, `al-work` 5; cold 10 + 9; inbound 9/11, 11/13, 5/7); the D55 zero pin and Task 6's
  `local-checkpoint` pin (0 `al-admission`, 0 non-probe `al-work`, one write per checkpoint, none while clean);
  `checkpoint-recovery` and `checkpoint-lag` (the `two-agent` family, every carrier, `full` tag) and `flush-on-hide`
  (the `same-context` family, `ws` and `rtc`, `full` tag); Relic's reload-mid-command case in
  `tests/playwright/relic-hunters/full-stack-propagation.spec.ts`.
- Produces: code head `H1` (reviewed and gated), final head `H2` (H1 plus the last commit), the PR title and body.

Throughout: `WT=/Users/knuthelge/ProjectLocker/github/ar-eye-hunter/.claude/worktrees/alm-i2b`,
`R=intact-software-systems/ar-eye-hunter`, `B=claude/alm-i2b-local-checkpoint`, `T=$WT/tmp/i2b-task9`. Every `gh`,
`git fetch`, `git push`, `docker` command, every lane, Playwright run and black-box runner, and `npm run test:unit`
need the sandbox disabled. Use `gh run list`, `gh run view` and
`gh api repos/$R/actions/runs?head_sha=<full sha>`, never `gh pr checks`. Any red is diagnosed from its downloaded
artifacts, copied to `$T` BEFORE any rerun, never from a theory; a product fix needs a counter-case test. Bundle
figures are read with a private `TMPDIR` (R-I2b-23). After every `deno task check` in `apps/api-v1`, remove
`apps/api-v1/node_modules/.deno` and its dangling links.

**Lane rule.** One lane at a time on this machine: the ALM lane, `test:e2e`, `test:full-stack:memory`, the Relic
full-stack suite and the black-box runners share ports 18080–18082, 5177, 5178 and 5180, and Playwright attaches to
whatever already listens there. Before every lane:

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
gh pr view <PR> -R $R --json mergeable,mergeStateStatus --jq '[.mergeable, .mergeStateStatus] | @tsv'
```

Expected: no status output; the two hashes equal; `0` variables; `MERGEABLE`. If main moved (the `wc -l` is not
`0`) or the PR reads `CONFLICTING`, merge main first: `git -C $WT merge --no-ff origin/main -m "Merge origin/main
into $B"`, resolve keeping both sides' behaviour and tests, `npm ci` if `package-lock.json` changed, then
`npm run typecheck 2>&1 | tail -3` and `node scripts/check-test-reachability.mjs` before Step 2.

- [ ] **Step 2: Pins and bundle figures**

```sh
cd $WT && npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts 2>&1 | grep -E "✓|✗|Tests  "
D="$TMPDIR/i2b-task9-bundles"; rm -rf "$D"; mkdir -p "$D"
TMPDIR="$D" npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles | grep -E "browser/rallar(-core|-realtime|-data|-crdt)?\.ts "
TMPDIR="$D" npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts 2>&1 | grep -E "KiB|Tests  "
```

Expected: the four pin files pass (`Tests  27 passed (27)`) with the I2a-ii figures (chain `6`, total `8`,
`al-admission` `10`, `al-work` `5`; cold `10` + `9`; inbound unchanged) and Task 6's `local-checkpoint` case: I2b adds
no IndexedDB operation to a durable or volatile send, and a `local-checkpoint` send spends none (its checkpoint is one
write, none while clean). Bundles as measured on the assembled tree: `browser/rallar.ts` 237.287 KiB against 238
(raised 235 → 236 in Task 4 at 235.214 and 236 → 238 in Task 5 at 237.287, R-I2b-39) and the headless agent 302.151 KiB
against 303 (raised 299 → 300 in Task 1 at 299.144 and 300 → 303 in Task 5 at 302.151, R-I2b-18, R-I2b-39); per task
234.341 / 299.144 (Task 1), 234.439 / 299.448 (Task 2), 234.710 / 299.520 (Task 3), 235.214 / 299.780 (Task 4),
237.287 / 302.151 (Tasks 5–8). Record the bundle lines and the headless figure in `$T/figures.md`. If `browser/rallar.ts`
or the headless bundle exceeds its budget, set the budget to the next whole KiB above the measured figure in the data
file (never higher), and commit `Raise the <entry> bundle budget to <N> KiB (measured <x.xxx> KiB at <sha>)`; the figure
and the reason go into the PR body.

- [ ] **Step 3: Local merge bar, static checks**

```sh
cd $WT
npm run typecheck 2>&1 | tail -3
npm run build 2>&1 | tail -15
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
npm run check:test-reachability
(cd apps/api-v1 && deno task check) && (cd apps/rallar-black-box-control-server && deno task check) && (cd apps/relic-hunter-server-v1 && deno task check)
rm -rf apps/api-v1/node_modules/.deno; find apps/api-v1/node_modules -type l ! -exec test -e {} \; -delete
npx dprint check $(git diff --name-only origin/main HEAD | tr '\n' ' ')
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts 2>&1 | grep -E "Tests  "
node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
```

Expected: `check-tests-typecheck: N test files enforced, 0 files carrying known debt (0 errors)`; build exits 0 with
no `error` line; `PASS: no new repository style findings`; the coupling check prints `PASS:` three times;
`check:test-reachability` exits 0 (`1747 test files, 1741 reached by CI, 6 manual` at the assembled head); the three
Deno checks exit 0; dprint check exits 0; the two public-surface tests pass with the snapshot's only change
`ALStorageHealthStatus` (R-I2b-22, R-I2b-43: `BrowserConnectedMiddleware`, `BrowserPageLifecycleFlush`, the checkpoint
pairs and ports stay internal); `checked 67 Hetzner distributed manifest(s)`.

- [ ] **Step 4: Local merge bar, `test:ci`**

Sandbox disabled, lane rule applies:

```sh
cd $WT && npm run test:ci 2>&1 | tee $T/test-ci.log | grep -E "Test Files|Tests  |ok \||passed|failed|flaky"
```

Expected, in order: Vitest `Test Files  N passed | K skipped (N)` and `Tests  N passed | K skipped (N)` with 0
failed (the assembled head read `Test Files  1365 passed | 4 skipped (1369)`, `Tests  12759 passed | 12 skipped (12771)`
for the `unit` project alone); four Deno blocks each `ok | N passed | 0 failed`; Playwright `test:rallar` and the recipe
console `N passed`; the in-memory full stack `N passed`. Known intermittent reds that pass alone:
`repo-style-changed-check.test.ts` and `state-write-malformed-evidence.test.ts` (timeouts under load), the
memory-QueueBox work-page test, `headless-worker-script.test.ts` and `full-stack-quick-test-ws`. Rerun such a file
alone, record both results, then rerun `npm run test:ci`; a red that repeats alone is a defect.

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
run (standard and cluster) included. No task changed source under `alm/inbound/**` or `alm/work/**`, so the per-task
Postgres runs were not owed; this one is the merge bar's. Task 1 changes server-shared ALM code (the vocabulary,
`resolveALOutboundStoreDurability` in the WS server's planning, `plan.lane`) and Task 3 the shared IndexedDB writer the
browser durable lane uses, so the cluster profile and the medium-scale gate ARE required; the medium-scale gate's
constants, operation matrix and assertions are unchanged.

- [ ] **Step 6: Local merge bar, the full ALM lane**

```sh
cd $WT && rm -rf apps/rallar-black-box/test-results
RALLAR_BLACK_BOX_ALM_SCOPE=full npm run -s test:rallar:full-stack:memory:alm 2>&1 | tee $T/alm-full.log | grep -E "family over|passed|failed|flaky|skipped"
for F in apps/rallar-black-box/test-results/alm-observation/*-full*.json; do case $F in *-snapshot.json|*-page-diagnostics.json) ;; *) printf '%s ' $F; jq -r '.cellOutcome + " " + .regime' $F;; esac; done
grep -h -o '"recipeId":"alm-[a-z-]*\(checkpoint-recovery\|checkpoint-lag\|flush-on-hide\)[a-z-]*"[^}]*"outcome":"[a-z-]*"' apps/rallar-black-box/test-results/alm-observation/*-full*.json | sort | uniq -c
```

Expected: every `baseline`, `addressed`, `three-agent` and `same-context` family over `ws`, `rtc` and
`rtc-with-ws-fallback` in `(full)` passes, with:

- `checkpoint-recovery` completed over `ws`, `rtc` and `rtc-with-ws-fallback`: the interval's checkpoint write read in
  the storage counters (`byKind.write > 0`), the reload, one lease (11 s), the old handle `unobservable`, the checkpoint
  store's `recovery` `restored` with `claimed > 0`, and one receiver copy;
- `checkpoint-lag` completed over the three carriers: `health` `delayed`, then `failing` with cause `checkpoint-lag`,
  the second send refused `storage-unavailable`, `healthy` after the release, the third send admitted;
- `flush-on-hide` completed over `ws` and `rtc` in the `same-context` family: the synthetic `freeze`, 250 ms, the CDP
  crash, the successor's `restored` with `claimed > 0`;
- `delivery-reload`, `durable-takeover` and `storage-unavailable` as at I2a-ii.

The summary shows `N passed` and no `failed` or `flaky`; every cell file reads `passed`. The known pre-existing reds,
named and classified if they appear (never accepted for a new cell): the baseline `rtc` and `rtc-with-ws-fallback`
cells failing only at `not-yet-in-sync-delivered-after-refresh` `received-1`; the addressed cell's RTC peer-recovery
reconnect race. Any other red is a defect, diagnosed from the cell's artifacts before a rerun.

- [ ] **Step 7: The longest cell against the 540 s ceiling (R-I2b-34)**

```sh
cd $WT && grep -E "family over .* \(full\)" $T/alm-full.log
```

The list reporter ends each cell's line with its duration (`(7.1m)`). Record each family cell's duration and the
longest in `$T/figures.md`. Expected: every cell under 540 s
(`CARRIER_TEST_TIMEOUT_MS`), with the fallback baseline cell the longest (about 8.6 min estimated: 7.1 min before I2b
plus about 90 s for the two new `two-agent` scenarios). If the longest cell leaves less than 30 s of margin, raise
`CARRIER_TEST_TIMEOUT_MS` to the next whole minute above the measured cell plus 30 s, with the figure in the commit
message (`Raise the ALM carrier-test ceiling to <N> s (longest cell <x> s at <sha>)`); if it leaves more than 90 s,
leave it and state the margin. The PR body states the measured margin either way.

- [ ] **Step 8: The Relic manual full-stack suite, once (R-I2b-11, R-I2b-27)**

Sandbox disabled, lane rule applies:

```sh
cd $WT && npm run test:playwright:relic:full-stack 2>&1 | tee $T/relic-full-stack.log | grep -E "passed|failed|flaky|✓|✘"
```

Expected: `2 passed` — the existing convergence case and "a start command held on its WS leg survives a reload inside
its deadline and is applied once" (both pages reach `planning` with exactly one more event; page B still reads `lobby`
while the frame is held). The summary line goes into the PR body. A red is diagnosed from its trace before any change;
D126 stands (no request-id idempotency key) unless the diagnosis shows the msgId dedup missing a repeat.

- [ ] **Step 9: Final whole-branch review, three seats, and one fix wave**

Per the subagent-driven-development skill's final review (run by the controller): dispatch the reviewer on the most
capable model with the whole-branch diff (`git diff origin/main...HEAD`, packaged to a file), the spec
(`playground/alm/alm-i2b-design-proposal.md`, QoS §4–§6, §9.2's I2b rows, D129–D135), this plan's Rulings,
Corrections and Limits, and the Global Constraints, in three seats:

- product: no guarantee weakens (the volatile lane's budget, retention and zero pin; the durable lane's pins and the
  I2a-ii ownership); the tier's send path performs no storage operation; at most one readwrite per checkpoint and none
  while clean; an interrupted write keeps the prior rows; an older completion never marks newer state saved; only the
  owner tracks, writes and restores (D132, R-I2b-28); the restore precedes the first batch and merges if-absent; the
  `seq` refusal; the lag skip follows `onStorageUnavailable`; the shared writer's commit never changes a deadline-bound
  or compare-and-set write's outcome (R-I2b-36);
- harness: the three cells prove what their names say (the interval write read before the reload; the synthetic
  freeze then the crash inside the interval; the lag's two health states and the refused send); manifests 18 and 22
  byte-identical; the Deno fixture models what the lane does; the Relic case holds the frame, not the server;
- code quality: repo style, sizes, names, READMEs and the API reference true, the public snapshot changed only by
  `ALStorageHealthStatus`, no plan or ruling id in code or tests.

ONE fix dispatch for every Critical and Important finding, one scoped re-review, residual minors adjudicated in the
ledger. Each fix is a TDD commit. Then repeat Steps 2, 3 and the focused tests the fixes touched; Steps 4–8 are
repeated only if a fix touched product code.

- [ ] **Step 10: Push the code head and read the gate**

```sh
cd $WT && git push origin HEAD:$B && git rev-parse HEAD > $T/H1
gh api "repos/$R/actions/runs?head_sha=$(cat $T/H1)&per_page=20" --jq '.workflow_runs[] | "\(.id) \(.name) \(.status) \(.conclusion)"'
```

Poll `gh run view <RUN> -R $R --json status,conclusion` every few minutes (foreground `gh`, sandbox disabled).
Expected: `Branch Release Gate`, `API v1 Formation Gate` and `API v1 Medium-Scale Gate` `success` on H1. Read every
failed job from its log and artifacts (`gh run view <RUN> --log-failed`, `gh run download`), copied to `$T` before
any rerun; known intermittent recipes (`api-v1-debounced-replanning`, `api-v1-group-presence-lease-lifecycle`,
`api-v1-websocket-addressed-sends`' 2 s deadline race, `assertPrimaryExactRevisions`) rerun with
`gh run rerun <RUN> --failed` after the copy; any other red is a fix as a TDD commit with a counter-case, pushed, and
the gate is read again on the new head.

- [ ] **Step 11: Hosted manifests 18 and 22 from the branch (regression reads)**

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
counting it). The manifests are byte-identical to main's (R-I2b-8: `checkpoint-recovery` and `checkpoint-lag` are
withheld, `flush-on-hide` is `same-context`), so these are regression reads of the hosted cells through the I2b
runtime. A red is diagnosed from `failures.json` and `fleet-report-summary.md`, fixed on the branch with a TDD
commit, and re-dispatched from the branch; main is never the test bed. The 04/05a asymmetric-RTC peer-readiness reds
rerun green: rerun `--failed` before diagnosing.

- [ ] **Step 12: ALM observation, smoke on three consecutive runs and at most two full reads**

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
each full read (the second only if the first ran fewer cells than the lane has, or a fix went in after it), the
controller sets the variable and deletes it:

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
I2a-ii's accepted read:

- every `ws` cell passed, `checkpoint-recovery`, `checkpoint-lag` and (same-context) `flush-on-hide` included;
- `addressed` and `three-agent` over `rtc` passed; `baseline` over `rtc` passed or failed only at
  `not-yet-in-sync-delivered-after-refresh` `received-1`, and its `checkpoint-recovery` and `checkpoint-lag` steps, when
  the cell reached them, completed; `same-context` over `rtc` passed with `durable-takeover` and `flush-on-hide`
  completed;
- `rtc-with-ws-fallback` cells any outcome, recorded (the 30-minute job timeout cuts them); the three new scenarios'
  outcomes there are recorded whatever they are;
- a read that ends with the API's "stopping API process" line (the RTC topology lease-lost self-stop, pre-existing
  since #566) is classified so from the job log, with the cells that have no hosted read named.

Any WS red, an RTC red at another step, or a red of a new cell over `ws` or `rtc` is not accepted: download the
artifact and diagnose before a second read.

- [ ] **Step 13: The last commit: the delivered line and the plan file**

In `playground/alm/alm-qos-product-plan.md` §10.1, the "**I2b, checkpointed durability:**" bullet gains "Delivered
(I2b, <H1>)." (R-I2b-42). Then delete this plan file:

```sh
cd $WT && git rm plans/active/alm-i2b-local-checkpoint-implementation-plan.md
npx dprint fmt playground/alm/alm-qos-product-plan.md
git add playground/alm/alm-qos-product-plan.md
git commit -m "Record I2b as delivered and close its plan"
git push origin HEAD:$B && git rev-parse HEAD > $T/H2
```

Expected: the commit contains only the two paths; the Branch Release Gate runs again on H2 and is read as in Step 10
(docs-only, so the earlier hosted and observation reads on H1 stand; the PR body names both heads).

- [ ] **Step 14: The PR title and body**

Title: `ALM Release 4, I2b: checkpointed durability (D129–D135)`. Body sections in this order:

- Goal.
- Changes (one bullet per task, Tasks 1–8).
- Public surface: `'local-checkpoint'` in `ALDurabilityAlgo` and `AL_DURABILITY_ALGOS` (typed channels and sends accept
  it; an older peer refuses it as malformed, D3); `ALStoreDurability 'checkpoint'`; `resolveALOutboundStoreDurability`
  (`shouldPersistOutbox` removed); `ALOutboundDispatchPlan.lane` (was `persist`); the `refused`/`unsupported` verdict
  of a tier send with a `seq`; `ALStorageHealthStatus` (public on `rallar.ts` and `rallar-core.ts`) with `'delayed'`,
  `ALStorageHealthState.oldestUnsavedAgeMs`, the cause `'checkpoint-lag'`; the browser store factory's
  `checkpointIntervalMs` and `checkpointLagBoundMs` (1,000 / 10,000 ms); the checkpoint store ids
  `browser-ws-client-checkpoint:<sid>` and `browser-rtc-overlay-checkpoint:<sid>` on the `storage` port; the shared
  IndexedDB writer's `commit()`; Relic's command channel at `local-checkpoint` with `onStorageUnavailable: 'refuse'`;
  the harness's three scenarios, `toReloadCheckpoint?`, `SameContextPages.ownerEnd`; the public API snapshot changed
  only by `ALStorageHealthStatus` (`RallarBrowserMiddleware` unchanged, R-I2b-22).
- Acceptance: the pins unchanged, with their figures, and Task 6's tier pin; the bundle figures per task and the three
  budget raises (headless 299 → 300 at 299.144 KiB in Task 1, `browser/rallar.ts` 235 → 236 at 235.214 KiB in Task 4,
  `browser/rallar.ts` 236 → 238 at 237.287 KiB and headless 300 → 303 at 302.151 KiB in Task 5, and Step 2's final
  reading); the storage footprint of the tier (D87: one write per checkpoint, the rows the session's `entries` and
  `alm-work` stores hold under the two checkpoint store ids); the local full lane cell by cell, the three new cells per
  carrier, the longest cell against 540 s (Step 7); the Relic suite's summary line (Step 8); the observation's smoke and
  full reads cell by cell; manifests 18 and 22, with run ids, as regression reads.
- Validation: Steps 2–8 and 10–12, with counts and run ids, measured on H1; the H2 gate; every red named with its
  classification and evidence, never softened.
- Rulings: every `R-I2b-N` of this plan (R-I2b-1..42) and every `Ruling:` line from the SDD ledger, each with what it
  costs if wrong.
- Corrections: this plan's list, which records what the proposal, the QoS plan and the roadmap say differently.
- Limits: this plan's list, which says what the evidence cannot show: the non-owner's rows (D132), the one-interval
  loss window and the unload landing rate with and without `commit()`, the real freeze and H5, `flush-on-hide`'s
  timing attribution (R-I2b-26), the cross-carrier restore (R-I2b-29), no lag check in flight (R-I2b-30), the server
  treating the tier as routed, the inbound memory lane not checkpointed, the 540 s estimate's measured margin, and the
  hosted checkpoint cells withheld or Playwright-only.
- Risk and rollback: revert the merge commit. No schema id change and no data migration; the checkpoint rows sit under
  their own store ids in the existing stores, and the session purge and the 60 s eviction remove them. After a revert,
  an older build refuses a `local-checkpoint` envelope as malformed (no producer remains but Relic, which the revert
  returns to `local-outbox`).
- Follow-ups: cross-tab checkpoint coverage (D132); H5 on phones; a bounded FIFO per key on receive (D118's third
  demand); the frozen-owner case; and, carried, the API's
  lease-lost self-stop, the `tests/playwright` typecheck coverage and the parked minors.
- The attribution line:

  🤖 Generated with [Claude Code](https://claude.com/claude-code)

Publish with `gh pr edit <PR> -R $R --title "..." --body-file $T/pr-body.md`. Leave the PR in draft; the maintainer
reviews and merges. Then write `Task 9: complete` and `PLAN COMPLETE <date>: PR #<PR> at <H2>` in the ledger.

- [ ] **Step 15: After the maintainer merges**

Watch main's `Push on main`, `Deploy Web + API` and `Run Hetzner Supported Distributed Manifests` on the merge commit
(`gh api repos/$R/actions/runs?head_sha=<merge sha>`), report them, and record I2b as delivered in memory. Release 4 is
then complete (P1a, P1b, I2a-i, I2a-ii, I2b); the next slice is planned from main.

---

## Self-review

**Composition evidence.** The eight task patches were applied in plan order with `git am -3` to a scratch tree from
`5e06c6ab0`. Tasks 1, 2, 7 and 8 applied unchanged. Task 3 gained R-I2b-25 as R-I2b-36, red first, and, after the
controller's review, R-I2b-44 and R-I2b-46 (the writer's ownership input, guard, subscription and guard test removed) and R-I2b-45 (the diagnostics wait); Task 4
gained R-I2b-28 as R-I2b-37, red first, the takeover-arm assertion R-I2b-44 asks for, and the facade budget raise
R-I2b-39 calls for; Task 5 stopped on the one textual conflict (`browser-al-runtime-stores.ts`, resolved to Task 4's
`IndexedDbStringPersistenceProvider.isSupported()`, R-I2b-31) and was reconciled to Task 4's shapes (R-I2b-33) and to
R-I2b-22 (R-I2b-43's two-field result, R-I2b-40); Task 6 stopped on one
conflict in `outbound-runtime-test-fixture.ts` (resolved to Task 4's pass-through, R-I2b-21) and its timers moved to
`schedule`. Each amendment was squashed into its task commit, so the branch is exactly eight commits, each with its
writer's message (updated where the content changed), one `D8 reuse:` line and no attribution. The scratch commits are
evidence only:

| Task | Commit      | Parent      |
| ---- | ----------- | ----------- |
| 1    | `13125ae0d` | `5e06c6ab0` |
| 2    | `2ec605ba5` | `13125ae0d` |
| 3    | `34cec086d` | `2ec605ba5` |
| 4    | `0c67dd005` | `34cec086d` |
| 5    | `5824c4d73` | `0c67dd005` |
| 6    | `05a543f37` | `5824c4d73` |
| 7    | `a56823ca7` | `05a543f37` |
| 8    | `15a86229f` | `a56823ca7` |

At every commit these pass (summary lines as printed; the focused set is the test files the commit touches, plus the
Relic roots for Task 8 and the three related harness files for Task 7):

| Task | Focused Vitest                        | `check-tests-typecheck` | Pins (4 files) | Coupling candidates | Reachability |
| ---- | ------------------------------------- | ----------------------- | -------------- | ------------------- | ------------ |
| 1    | `61 passed (61)` / `793 passed (793)` | 1435, 0 errors          | `26 passed`    | 11, PASS ×3         | 1737/1731/6  |
| 2    | `5 passed (5)` / `62 passed (62)`     | 1438, 0 errors          | `26 passed`    | 11, PASS ×3         | 1740/1734/6  |
| 3    | `6 passed (6)` / `84 passed (84)`     | 1439, 0 errors          | `26 passed`    | 12, PASS ×3         | 1741/1735/6  |
| 4    | `7 passed (7)` / `70 passed (70)`     | 1441, 0 errors          | `26 passed`    | 12, PASS ×3         | 1743/1737/6  |
| 5    | `31 passed (31)` / `311 passed (311)` | 1444, 0 errors          | `26 passed`    | 32, PASS ×3         | 1746/1740/6  |
| 6    | `1 passed (1)` / `21 passed (21)`     | 1444, 0 errors          | `27 passed`    | 32, PASS ×3         | 1746/1740/6  |
| 7    | `8 passed (8)` / `116 passed (116)`   | 1445, 0 errors          | `27 passed`    | 32, PASS ×3         | 1747/1741/6  |
| 8    | `31 passed (31)` / `187 passed (187)` | 1445, 0 errors          | `27 passed`    | 32, PASS ×3         | 1747/1741/6  |

and at every commit: `npx tsc -p packages/shared/tsconfig.json --noEmit` with no output; the shared-web, shared-server
and shared-test typechecks exit 0; `cd apps/api-v1 && deno task check` exit 0 (then `.deno` and the dangling links
removed); `PASS: no new repository style findings (5e06c6ab0… -> HEAD)`; `Bundle budget check passed.`; the headless
boundary, public API snapshot and bundle-boundary tests `Test Files  3 passed (3)`, `Tests  18 passed (18)`. The pin
count moves from 26 to 27 only by Task 6's new case; every earlier figure is unedited. Task 7 also: the control server's
`deno task check` exit 0 and `deno task test` `199 passed | 7 failed` sandboxed (the seven port-bind cases of
`control-dispatch-triggers.test.ts` and `control-reload-socket.test.ts`; W-D's unsandboxed run of the same patch read
`206 passed | 0 failed`), `apps/rallar-black-box` `tsc --noEmit` exit 0, `checked 67 Hetzner distributed manifest(s)`
and a regenerate with no diff, and the scratch Playwright typecheck's 28 pre-existing errors, none in a touched file.
Task 8 also: `npm --workspace relic-hunters-v1 run typecheck` exit 0, `dprint check` exit 0 on its four files, the
scratch Playwright typecheck unchanged (no error under `tests/playwright/relic-hunters`), and `playwright --list` naming
both full-stack cases.

The red of every task was replayed on its parent with the task's test files overlaid: Task 3
`3 failed | 1 passed (4)`, `3 failed | 52 passed (55)`, `1 error`; Task 4 `5 failed | 3 passed (8)`, `10 failed | 53 passed (63)`; Task 5
`9 failed (9)`, `16 failed | 43 passed (59)`; Task 6 (the mutation) `1 failed | 20 passed (21)`; Task 7 `5 failed (5)`,
`6 failed | 52 passed (58)`; Task 8 `1 failed | 1 passed (2)`. Tasks 1–2 are W-A's, on the same trees.

`npm run test:unit:main` at the eighth commit `15a86229f`, sandbox disabled: `Test Files  1365 passed | 4 skipped
(1369)`, `Tests  12759 passed | 12 skipped (12771)` (one test fewer: R-I2b-46 removed the writer's ownership case). An earlier run of the assembled chain (before R-I2b-43..45) had
shown one intermittent, `inbound-admission-diagnostics.test.ts` "settles the claim as a retry … over indexeddb", which
read the batch's drain event without waiting for it; R-I2b-45 makes it wait, in Task 3. Sandboxed, the same run fails only the
five port-bind files (`listen EPERM`: `headless-worker-script`, `live-rtc-control-client`,
`api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe`, `local-websocket-session`), which pass
unsandboxed. `npm run test:postgres:integration` was not run: no commit touches source under `alm/inbound/**` or
`alm/work/**` (only `alm/inbound/README.md` and a test under `packages/tests/shared/alm/work/`); Task 9 runs it as part
of the merge bar.

Per-task bundles (brotli q11, private `TMPDIR`), as `browser/rallar.ts` / headless:

| After     | `browser/rallar.ts`    | Headless               |
| --------- | ---------------------- | ---------------------- |
| Base      | 234.340 (budget 235)   | 298.848 (budget 299)   |
| Task 1    | 234.341                | 299.144 (budget → 300) |
| Task 2    | 234.439                | 299.448                |
| Task 3    | 234.710                | 299.520                |
| Task 4    | 235.214 (budget → 236) | 299.780                |
| Tasks 5–8 | 237.287 (budget → 238) | 302.151 (budget → 303) |

**(a) Spec coverage** (QoS §9.2's I2b rows and §9.3):

- "A checkpoint is one coherent state, and an interrupted write keeps the prior point": Task 2 (the synchronous capture
  from one snapshot), Task 4 (`al-checkpoint.test.ts`, the readwrite aborted after its queue puts: neither row lands,
  the next attempt saves the same changes), Task 3 (the shared writer's commit leaves a failing write to the browser).
- "A mutation during a write reaches the next checkpoint, and an older completion never marks newer state saved":
  Task 2 (per-key revisions, `clearSaved`), Task 3 (the held-write cases).
- "No storage work on the `local-checkpoint` send path": Task 6 (the D55 zero extended to the tier), Task 4 (the lane
  test's admission from memory).
- "Checkpoint cost stays within budget, and nothing runs while clean": Task 6 (one write per checkpoint, nothing armed
  and nothing spent while clean), Task 3 (nothing armed while clean).
- "The interval target holds under continuous change, and the page flushes on hide": Task 3 (the fake-clock cases: one
  timer, never postponed), Task 5 (the lifecycle adapter and the transport's connect), Task 7 (`flush-on-hide`).
- "Restore: reserved rows are retryable, expired rows settle `expired`, and there is no handle": Task 4 (the lease
  claim, `expired-at-recovery`, the takeover restore), Task 7 (`checkpoint-recovery`: the old handle `unobservable`,
  `restored {claimed > 0}`).
- "Ordered and latest-wins sends are refused typed on `local-checkpoint`": Task 1, narrowed by D131 to `seq` (latest-wins
  and an ordering key alone pass, pinned in the same test).
- "Lag beyond the bound follows `onStorageUnavailable`": Task 3 (`delayed`, `failing` with `checkpoint-lag`), Task 5
  (the skip, refuse and downgrade, `missing`), Task 7 (`checkpoint-lag`).
- "A Relic command survives a reload mid-command": Task 8, run by Task 9 Step 8.
- "A purge reaches memory, storage and checkpoint" (I2a's row, the checkpoint's part): Task 4 (the purge case of
  `browser-outbound-cleanup.test.ts`; the writer disposed with the runtime before a purge).
- §9.3: Task 7's three scenarios; Task 9 Step 6 runs them in the local full lane and Step 12 in the hosted full read.
- D129 → Tasks 2–4; D130 → Tasks 1, 4; D131 → Task 1; D132 → Tasks 3–5; D133 → Tasks 3, 5; D134 → Task 8;
  D135 (amended) → Tasks 3 (`commit()`), 5, 7.
- Gaps, each a stated limit: the non-owner's rows (D132); H5 and the real freeze; the unload landing rate; the inbound
  memory lane; hosted checkpoint cells.

**(b) Placeholder scan.** No `TBD`, `TODO`, "implement later" or "similar to Task N" remains. The angle-bracket tokens
that remain are deliberate:

- `<PR>` in Task 9: the controller fills it after the draft PR opens.
- Values read while running Task 9: `<H1>`, `<H2>`, `<RUN>`, `<GATE_RUN>`, `<OBS_JOB>`, `<k>`, `<date>`, `<entry>`,
  `<N>`, `<x.xxx>`, `<x>`, `<sha>`, `<merge sha>`, `<id>` and `<alm-conformance-lane artifact>`.
- Name patterns in prose, commit messages and store ids: `<sid>`, `<sessionId>`, `<carrier>`, `<namespace>`,
  `<checkpoint store id>`, `<name>`, `<prefix>`, `<p>`.

**(c) Type consistency** (each cross-task name, its defining task and its consumers; the assembled tree typechecks at
every task commit):

- `ALDurabilityAlgo` with `'local-checkpoint'`, `AL_DURABILITY_ALGOS`, `ALStoreDurability` with `'checkpoint'`,
  `resolveALOutboundStoreDurability`, `ALOutboundDispatchPlan.lane`, `computeALOutboundOrderingRefusal` (Task 1) →
  Task 4 (`resolveLaneForPlan` over `plan.lane`, the memory retention branches), Task 5 (the dispatch's exhaustive
  switch), Task 6 (`lane: 'checkpoint'`), Task 7 (the harness lists), Task 8 (the channel's `durability`).
- `InMemoryQueueBox.onChangeDo/peek`, `InMemoryAdmissionBackend.onChangeDo/peek`, `ALCheckpointDirtySet`
  (`onMarkedDo`, `isClean`, `getOldestDirtiedAtMs`, `getSnapshot`, `clearSaved`, `dispose`), `computeALCheckpointMutations`,
  `put-unconditionally` (Task 2) → Task 3 (the writer), Task 4 (`loadWithoutMarking`, `markHeld`, `peekKeys`,
  `loadIfAbsent`).
- `ALCheckpointWriter` with `Settings`, `Timers { schedule }`, `Input` (Task 3) → Task 4 (`ALCheckpoint`'s tracking,
  `CreateCheckpointALOutboundRuntimeStoresInput extends … ALCheckpointWriter.Settings`), Task 5
  (`BROWSER_AL_CHECKPOINT_TIMERS`), Task 6 (`createManualCheckpointTimers`).
- `ALStorageHealthStatus 'delayed'`, `ALStorageHealthState.oldestUnsavedAgeMs`, `'checkpoint-lag'`,
  `recordDelayed(oldestUnsavedAgeMs, lastFailure)`, `recordLagFailure(failure, oldestUnsavedAgeMs)` (Task 3) → Task 5
  (`recordCheckpointHealth`, `getCheckpointLaneSkip`, the public `ALStorageHealthStatus`), Task 7 (the health waits).
- `SubmitComputedIndexedDbQueueMutationsInput` (Task 3), used by `writeIndexedDbAdmissionMutations` and
  `writeComputedIndexedDbQueueMutations` only.
- `ALCheckpointPort` (`restore`, `flush`, `dispose`, `isOwned`, `onTakenOverDo`, `reportFirstBatch`) and `ALCheckpoint`
  in `checkpoint/al-checkpoint.ts`, `ALCheckpointOutboundRuntimeStores` and `Resources.checkpointStores` in
  `al-outbound-message-runtime.ts`, `createCheckpointALOutboundRuntimeStores` in `al-runtime-stores.ts`,
  `toBrowserWsClientALCheckpointRuntimeStoreId` and `toBrowserRtcOverlayALCheckpointRuntimeStoreId` in
  `browser-al-checkpoint-store-ids.ts` (Task 4) → Task 5 (`resolveALCheckpointRuntimeStores`,
  `createBrowserALCheckpointOutboundRuntimeStores`, the carriers' `checkpointStores`, `BrowserConnectedMiddleware.checkpoints`
  as `readonly ALCheckpointPort[]`, `BrowserPageLifecycleFlush.Input.checkpoints` as `Pick<ALCheckpointPort, 'flush'>[]`), Task 6 (the pin's pair),
  Task 7 (the store ids as `RECOVERED_STORE_PREFIXES.wsCheckpoint`/`rtcCheckpoint`, through the browser only).
- `OutboundTestRuntimeInput.checkpointStores?`, the session fixture's `<namespace>-checkpoint` pairs (Task 4) → Task 6.
- `BrowserALCheckpointSettingsInput`, `resolveBrowserALCheckpointStores`, `BrowserConnectedMiddleware`,
  `BrowserPageLifecycleFlush`, `FakePageLifecycle`/`installFakePageLifecyclePerTest`
  (Task 5); none is consumed by a later task's code.
- `AlmConformanceScenarioDefinition.toReloadCheckpoint?`, `SameContextPages.ownerEnd`, `toCheckpointStorePrefix`,
  `CHECKPOINT_INTERVAL_MS`/`CHECKPOINT_LAG_BOUND_MS` in the scenario modules (Task 7); `AlmReloadCheckpoint` keeps its
  name (R-I2b-9).

**(d) Files touched by two or more tasks** (their edits land in this order):

| File                                                                                             | Tasks     |
| ------------------------------------------------------------------------------------------------ | --------- |
| `packages/shared/alm/outbound/README.md`                                                         | 1 → 4 → 6 |
| `packages/shared/alm/al-runtime-stores.ts`                                                       | 1 → 4     |
| `packages/shared/alm/outbound/al-outbound-message-runtime.ts`                                    | 1 → 4     |
| `packages/shared/alm/al-admission-backend.ts`, `packages/shared/queuebox/in-memory-queue-box.ts` | 2 → 4     |
| `packages/shared/alm/checkpoint/al-checkpoint-dirty-set.ts`                                      | 2 → 4     |
| `packages/shared/queuebox/write-computed-indexed-db-queue-mutations.ts`                          | 2 → 3     |
| `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`                         | 1 → 3     |
| `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts`                            | 4 → 5     |
| `packages/shared-web/bundle-budgets.json`                                                        | 4 → 5     |
| `packages/tests/rallar-black-box-headless/headless-bundle-budget.json`                           | 1 → 5     |
| `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`                            | 1 → 7     |
| `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`                                | 1 → 6     |
| `packages/tests/shared/alm/outbound-runtime-test-fixture.ts`, `session-outbound-test-runtime.ts` | 1 → 4     |

Each later task's anchors are of its predecessor's head where the step says so.

**(e) Corrections the plan implies** are listed in full under "Corrections to the proposal and the roadmap"; Task 9's
PR body carries them.
