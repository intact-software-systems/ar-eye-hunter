# ALM P1a: the codec and the send chain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lower the storage cost of a durable ALM send in the browser without changing any guarantee: the IndexedDB entry codec parses each Temporal field once, and a warm durable send runs at most 8 IndexedDB transactions between `enqueueIfAbsent` and the carrier send (11 today) and at most 18 operations (22 today), pinned by a ledger test and measured by a plain-page harness.

**Architecture:** Three zero-semantics changes on the durable outbound lane (`packages/shared/alm/outbound/**`): the single-send commit reads its effect slot inside the decision read and hands its canonical pair to `commitBundles`, so the commit's observation session is not opened; the committed canonical message is handed to the claiming batch in memory, bounded, with the IndexedDB read as the fallback on a miss; the claim's three guard reads run in one readonly session. One codec change in `packages/shared/queuebox/`: the IndexedDB entry codec parses once, validates on the parsed values and the stored epoch-ms mirrors, never re-parses its own output, and `isStoredQueueEntryExpired` compares `expiryEpochMs`. Two evidence layers: a transaction ledger test (fake-indexeddb, counts) and a Playwright manual suite on a persistent profile (send-to-dispatch latency and CPU profile).

**Tech Stack:** TypeScript, Vitest with fake-indexeddb, Playwright (Chromium, `launchPersistentContext`, CDP throttling and profiler), esbuild for the harness page, dprint.

**Spec:** `playground/alm/alm-p1-design-proposal.md` (§2.1 P1a; §4 decisions; §5 evidence), decisions D108–D111 in `playground/alm/alm-improvement-plan.md`, QoS plan §7.3 in `playground/alm/alm-qos-product-plan.md`. The code survey the spec rests on cites `main` at `c85d99cdd`; its transaction table is reproduced in the spec's §1.1.

## Global Constraints

- **No guarantee changes.** Every existing semantic test holds unchanged: supersedence, settlement, expiry, canonical storage restart and cleanup, the D17 per-row fence, the group commit path (`commitAll` with two or more members), the volatile lane (D55 pin 0/0).
- **No schema bump, no migration.** `AL_ADMISSION_SCHEMA_ID`, `StoredResourceEntry` (the stored row shape), `ResourceEntry` and the server PostgreSQL codec are unchanged (D110). No reset follows this PR.
- **No new dependency, no worker** (D8). The polyfill stays in the bundle (D110); only the storage hot path stops re-parsing.
- **Pins only fall** (D87, D109). A pin is lowered in the same commit as the production change that lowers it, with the reason in the assertion message. The P1a targets: warm durable send chain transactions ≤ 8, total ≤ 11, operations ≤ 18 (`al-admission` 10, `al-work` 8); the cold pin `al-indexeddb-operation-counts.test.ts` (10 + 15) falls by the measured amount; the warm inbound pin (transactions ≤ 13, `al-work` ≤ 7, `al-admission` 8) holds.
- **Bundle budgets.** `packages/shared-web/bundle-budgets.json` (rallar.ts 229 KiB; 228.2 measured on `c85d99cdd`) and `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (292 KiB; ≈291.6). A crossed budget is raised to the next whole KiB with the measured figure recorded in the PR body (standing ruling); a budget is never raised further than that.
- **Code standard.** `.agents/skills/rallar-code-writing/references/repo-code-style.md`: canonical verbs, functions ≤ 40 lines, at most three positional parameters, required fields by default, expected failure as `Either`, kebab-case files named after the primary export, no role folders, no `helper`/`util`/`data` names. No comments in source except an essential invariant; test-intent comments are fine. Never name a plan, decision, task or PR id in code or tests.
- **Formatting.** dprint only on touched files: `npx dprint fmt <file> <file>` (never a glob).
- **Per-task checks.** Focused tests for the touched package, then `npx tsc -p packages/shared/tsconfig.json --noEmit`, `node scripts/check-tests-typecheck.mjs`, `npm run check:repo-style:changed -- origin/main HEAD` (zero new findings on touched files), and `npm run check:test-reachability` when a test file is added. A task touching `packages/shared/queuebox/**` also runs `cd apps/api-v1 && deno task check` and `npx vitest run packages/tests/shared/queuebox`.
- **Navigation maps.** `packages/shared/alm/outbound/README.md` (and `inbound/README.md` if touched) are updated in the task that changes what they describe and never claim behaviour the code does not have.
- **Git.** One commit per task, committed by the implementer; the controller pushes after the task's review. Never `git stash`, never push, never merge, never `pr:delivery ready`, never `db:down`. The shared Postgres container `ar-eye-hunter-postgres` is never stopped or recreated from this worktree.
- **Hosted proofs** come from the PR branch (`gh workflow run hetzner-distributed-recipe.yml --ref claude/alm-p1-durable-path-cost`), never from `main`. At most two hosted ALM full reads per PR, each with the repository variable `RALLAR_BLACK_BOX_ALM_SCOPE=full` set before and deleted after (verify `gh variable list` shows none).

## File structure

| Area               | Files                                                                                                                                                                                                                                                                    | Responsibility                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger pin         | `packages/tests/shared/alm/record-indexed-db-transaction-ledger.ts` (new), `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts` (new)                                                                                                                     | Records every IndexedDB transaction and request of one warm durable send and one warm inbound admit-and-deliver, joined with the owning logical operation; pins the chain, total, request and per-owner counts                                              |
| Harness            | `tests/playwright/alm/**` (new), `tests/manual-suites.json`, root `package.json` script                                                                                                                                                                                  | The spike's plain page rebuilt: persistent profile, 4× CPU, a 10-in-16 ms frame load, the real durable outbound path with a recording carrier; send-to-dispatch p50/p95 and the CPU-profile share of the polyfill and the codec; a manual suite, not a gate |
| Codec              | `packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts`, `indexed-db-queue-box-entry.ts` (+ any split file beside them), tests in `packages/tests/shared/queuebox/`                                                                                               | One parse per field on encode and decode; validation on parsed values and epoch-ms mirrors; no second decode of a computed put; expiry on `expiryEpochMs`                                                                                                   |
| Single-send commit | `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts`, `al-outbound-admission-reads.ts`, `al-outbound-admission-effect-store.ts`, `al-outbound-dispatch-admission.ts`; `packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts` | The effect slot read inside the decision read; the canonical pair and effect observation handed to `commitBundles`; the group path unchanged                                                                                                                |
| Hand-off           | `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`, `admission/al-outbound-admission-effect-store.ts`, `al-outbound-message-runtime.ts`                                                                                                                       | The committed canonical message handed to the claim in memory, bounded, dropped on dispose and on storage reset, read on a miss                                                                                                                             |
| Guard session      | `packages/shared/alm/outbound/al-outbound-message-effects.ts`, `admission/al-outbound-admission-store.ts`                                                                                                                                                                | The claim's supersedence, receipt-state and (on a miss) canonical reads in one readonly session                                                                                                                                                             |
| Docs               | `packages/shared/alm/outbound/README.md`, `playground/alm/alm-qos-product-plan.md` §7.1, the PR body                                                                                                                                                                     | Navigation map and figures                                                                                                                                                                                                                                  |

## Task order

1 (ledger at today's figures) → 2 (harness and the before-figures, at a commit with no product change) → 3 (codec encode) → 4 (codec decode, expiry) → 5 (merged decision read) → 6 (hand-off) → 7 (guard session) → 8 (close). Tasks 3–4 and 5–7 are independent of each other but share the ledger pins, so they run serially in this order.

---

## Rulings made while writing the plan

Each is a choice the spec does not settle, taken by the plan's author from the writers' prototypes. The
maintainer can undo any of them; the cost column says what a wrong ruling costs.

| Id       | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                            | Cost if wrong                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-P1a-1  | `commitBundle(bundle, observation?)` takes an optional observation instead of a new commit method; without one it opens the observation read as before.                                                                                                                                                                                                                                                                                              | About 40 tests inject conflicts into single sends by spying on `commitBundle`; a new method would bypass them, and a spy that forwards only the bundle still commits correctly. Absence has a distinct meaning: no observation was read yet.                                                                                   | A second commit entry point later, and the spies rewritten then.                                                                                                                                                           |
| R-P1a-2  | The canonical pair reaches the commit through a decision read session that remembers the work rows it read (`ALOutboundDecisionReadSession`), not through a field on the read DTO.                                                                                                                                                                                                                                                                   | When the dequeue path supplies `observedCanonicalEntry`, the decision read never read that row, so a DTO field would hand over a value that is not an observation; the fence must only trust rows the session observed.                                                                                                        | One more session class beside the read session; if the fence design changes in the fold candidate, it moves with it.                                                                                                       |
| R-P1a-3  | A single send's `commit-phases` `readDurationMs` now covers the decision read, the effect-row read and compute; `commitDurationMs` starts at the fence snapshot. The diagnostic contract doc says so.                                                                                                                                                                                                                                                | The observation read no longer exists as a phase; compute is microseconds.                                                                                                                                                                                                                                                     | Lane regime figures for `perOperation` shift by a few microseconds per send; a reader comparing with S3-era artifacts must know it.                                                                                        |
| R-P1a-4  | Every pin that falls with a task falls in that task's commit, including ones the plan's table did not list: Task 5 also lowers the cold `al-work` pin 15 → 13 and the ledger's requests 46 → 44.                                                                                                                                                                                                                                                     | D87: a pin may only fall, in the same commit as the production change.                                                                                                                                                                                                                                                         | None; a pin left high hides a later regression.                                                                                                                                                                            |
| R-P1a-5  | The ledger's `after-send` phase ends when the owner is idle again (the release and this batch's own readiness probe), not when the release commits.                                                                                                                                                                                                                                                                                                  | It is the only window under which the measured total of 14 transactions, 46 requests and 12 `al-work` holds; the survey's transaction #2 is that probe seen from the next send.                                                                                                                                                | None for the pins; a reader must know the window to compare with the survey's table.                                                                                                                                       |
| R-P1a-6  | The inbound admit-and-deliver is pinned at two exact shapes (message 4 after `ready()`: 9 chain / 11 total / 34 requests / 8 / 5; message 2: 11 / 13 / 36 / 8 / 7), not at an upper bound.                                                                                                                                                                                                                                                           | The shape is a fixed period-3 cycle in the message count, not a timing effect, so both are deterministic (10 of 10 runs); an upper bound would miss a regression that adds two transactions to the 11 shape.                                                                                                                   | A change to the inbound rotation cadence (P1b) moves both pins, with a stated reason.                                                                                                                                      |
| R-P1a-7  | Task 1 moves `createIndexedDbOutboundCountStores` out of `al-indexeddb-operation-counts.test.ts` into the shared `outbound-runtime-test-fixture.ts` and both tests import it, instead of the ledger test carrying a 25-line copy.                                                                                                                                                                                                                    | Verbatim duplication of a fixture is a defect the review rubric flags; the move is an import change in the older test.                                                                                                                                                                                                         | Task 1 touches one more test file; none otherwise.                                                                                                                                                                         |
| R-P1a-8  | The codec deep-freezes each row it encodes or decodes and keeps the row's parsed Temporal values in a private `WeakMap`; a computed put made of such a row skips the timestamp re-parse, every other value (including every row read from IndexedDB) is checked field by field with the same `TypeError` messages in the same order.                                                                                                                 | It is what lets `validateComputedIndexedDbQueueMutations` keep its guarantee without a second decode; nothing in product or tests mutates a row, and a copied row falls back to full checking.                                                                                                                                 | The memo is invisible state beside the codec; if the final review prefers the parsed values carried explicitly on a decoded-entry type, the change is local to the codec and its two callers.                              |
| R-P1a-9  | The expiry and retry checks compare the stored epoch-ms mirrors and parse the stored instant only when "now" falls in the same millisecond as the mirror.                                                                                                                                                                                                                                                                                            | Keeps today's exact result for sub-millisecond instants from native Temporal clocks, so "no guarantee changes" stays literally true at the cost of a rare cheap parse.                                                                                                                                                         | If the maintainer prefers the mirror alone, one branch is deleted and one test changes.                                                                                                                                    |
| R-P1a-10 | `browser-al-work-cleanup.ts` (decodes a row to compare expiry) and the ALM read session and backend (build an `Instant` from a millisecond clock for the expiry check) are left as they are.                                                                                                                                                                                                                                                         | After Task 4 the cleanup decode costs no parse, and the ALM sites are two cheap constructions per send; folding them widens the task for no measured gain.                                                                                                                                                                     | A few polyfill calls per send remain outside the codec (112 total after Task 4).                                                                                                                                           |
| R-P1a-11 | The structural decode stays in `indexed-db-queue-box-entry-codec.ts`; no split file.                                                                                                                                                                                                                                                                                                                                                                 | A split would make `packages/shared/queuebox` hold 21 files and trip `layout.directory-density` (limit 20); the codec file itself has no style finding.                                                                                                                                                                        | If the file's cognitive-load score later crosses a tier, the split needs a sub-directory (as #566 did for the WS server's scope files).                                                                                    |
| R-P1a-12 | The harness's own runs at the Task 2 commit are P1a's before-figures; the gap to the spike is recorded, not chased. The spike's 4× and frame-load figures (17.4; 16.8/30.3; 78.8/93.7 ms) do not reproduce (11.7; 13.1/14.3; 31–32/44–52 ms on the same machine and Chromium) because the spike's frame-load code went with its deleted branch, while idle (3.4 vs 4.1 ms) and the CPU shares (35 vs 32 %; 74 vs 72 % under the codec) match.        | Proposal §5 asks the before run to reproduce the spike within noise; that is impossible for a load whose code no longer exists, and the comparison P1a needs is before-and-after on the same harness.                                                                                                                          | D89's later reading is against these lower figures: the pre-P1 p95 under the frame load at 4× is already about 44–52 ms, under the 100 ms bar, so P1b's reading will very likely withdraw I2b. The maintainer is told now. |
| R-P1a-13 | The frame load is a `requestAnimationFrame` loop paced by the harness's own 16 ms frame clock (measured 0.62–0.63 busy against the 0.625 target), each send issued at the end of a frame's work.                                                                                                                                                                                                                                                     | Headless Chromium runs animation frames back to back, so an unpaced busy loop is 86–88 % busy, not 10-in-16.                                                                                                                                                                                                                   | If a headed run is wanted later, the pacing is one function.                                                                                                                                                               |
| R-P1a-14 | Four configurations: idle, 4× CPU, 1× with the frame load, 4× with the frame load. Task 8 reads all four.                                                                                                                                                                                                                                                                                                                                            | The 1× frame-load point is the spike's second reference (16.8/30.3 ms) and costs about 8 s.                                                                                                                                                                                                                                    | None.                                                                                                                                                                                                                      |
| R-P1a-15 | The harness planner is the ledger's minimal durable plan (no ack, retry or supersedence tracking), not the WS client's full plan with a hop receipt.                                                                                                                                                                                                                                                                                                 | The harness and the ledger then describe the same 11-transaction chain; the receipted plan adds carrier-side work the levers do not touch.                                                                                                                                                                                     | A receipted send's latency is not measured; add a configuration later if wanted.                                                                                                                                           |
| R-P1a-16 | No gate typechecks `tests/playwright/**`; the plan uses a throwaway tsconfig for the harness files and the gap is a follow-up outside P1a.                                                                                                                                                                                                                                                                                                           | Pre-existing for every Playwright suite in `tests/playwright`.                                                                                                                                                                                                                                                                 | A type error in the harness surfaces only when it runs.                                                                                                                                                                    |
| R-P1a-17 | Task 8's "within noise" rule uses before-runs from the same quiet session: whenever the load average differs, the three before-runs are re-run at the Task 2 commit back to back with the after-runs (load average below about 5).                                                                                                                                                                                                                   | The same commit's 4× frame-load p50 wandered 35–61 ms under a loaded machine and settled at 31–32 ms quiet.                                                                                                                                                                                                                    | An extra 2–3 minutes of harness runs in Task 8.                                                                                                                                                                            |
| R-P1a-18 | On a hand-off miss the claim keeps two read sessions (the canonical read, then the guard session); only a hit is one session. Folding the canonical read into the guard session is not done in P1a.                                                                                                                                                                                                                                                  | Folding it moves either the canonical read after `attempt-started` (a missing row or a crossed deadline would then emit a failed `attempt-settled` instead of nothing) or the guard reads before it (a failing guard read would no longer end the attempt it stated); neither is zero-semantics. The warm pins are unaffected. | Misses (another tab, a reload, a replay) cost one more session until I2a, when misses become the common case and a variant with early guard reads and deferred failures is worth its semantics.                            |
| R-P1a-19 | The hand-off applies to every durable lane, including the server's PostgreSQL lane and in-memory durable lanes; the volatile lane gets none.                                                                                                                                                                                                                                                                                                         | The immutability of a committed canonical row does not depend on the backend; limiting it would need a branch on the backend kind.                                                                                                                                                                                             | A server claim on another process misses and falls back to the read, as designed.                                                                                                                                          |
| R-P1a-20 | `ALOutboundRuntimeStores.storageResets?` is optional (absence: no reset reaches that pair, memory or PostgreSQL); the runtime's `Resources.storageResets` is required as `\| undefined`. Entries are keyed by the effect's work-slot key (one-to-one with the effect id in a namespace), bounded at 64 (4 × `AL_OUTBOUND_WORK_PAGE_SIZE`), oldest dropped first, a claim consumes its entry, a hit is used only while the row's `expiresAtMs > now`. | Absence has a distinct meaning; a required field would rewrite about 40 test literals; the lane has the slot key without decoding the row; the bound is four claim pages.                                                                                                                                                      | If the bound is too small under a burst, misses fall back to the read; no correctness cost.                                                                                                                                |
| R-P1a-21 | Two existing tests that inject events inside the pre-transport read now spy on `readSendGuards` instead of `readReceiptState`; assertions unchanged.                                                                                                                                                                                                                                                                                                 | The seam moved with the read; the tests still assert the same settlements.                                                                                                                                                                                                                                                     | None.                                                                                                                                                                                                                      |
| R-P1a-22 | Task 6 applies after Task 5 (its hunks in the effect store and admission store are anchored on Task 5's context), and `readWorkSnapshot` takes a required second parameter that ten test call sites and the control admission pass as `undefined`.                                                                                                                                                                                                   | The plan order already runs 5 before 6; the repo pattern for a value that may be absent is a required `\| undefined` parameter.                                                                                                                                                                                                | None.                                                                                                                                                                                                                      |

---

### Task 1: The transaction ledger pin at today's figures (outbound warm send, inbound warm admit-and-deliver)

**Files**

- Create: `packages/tests/shared/alm/record-indexed-db-transaction-ledger.ts` (lines 1-255): the recorder.
- Create: `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts` (lines 1-235): the pins.
- Modify: none. Production code is untouched.
- Test: `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts`

**Interfaces**

- Consumes (unchanged):
  - `IndexedDbOperation`, `IndexedDbOperationObserver`, `IndexedDbOperationOwner`, `IndexedDbOperationKind` from `@shared/persistence/indexed-db-operation-observer.ts`.
  - `createDefaultOutboundTestRuntime`, `createOutboundMessage` from `packages/tests/shared/alm/outbound-runtime-test-fixture.ts`.
  - `createInboundTestRuntime`, `createInboundTestStores`, `createInboundTestMessage`, `INBOUND_TEST_SOURCE`, `InboundTestRuntime` (its `gateDispatch` hook) from `packages/tests/shared/alm/inbound-runtime-test-fixture.ts`.
  - The outbound stores are built exactly as `createIndexedDbOutboundCountStores` builds them in `al-indexeddb-operation-counts.test.ts:358-383` (that function is private to that test file, so the ledger test carries its own copy, `createIndexedDbOutboundLedgerStores`).
- Produces (`record-indexed-db-transaction-ledger.ts`):
  ```ts
  export type IndexedDbLedgerPhase = 'before' | 'chain' | 'after-send';
  export interface IndexedDbLedgerTransaction {
      readonly order: number;
      readonly mode: IDBTransactionMode;
      readonly stores: readonly string[];
      readonly requests: readonly string[]; // '<store>.<method>(<key>)' or '<store>.<index>.<method>(<range>)'
      readonly phase: IndexedDbLedgerPhase;
      readonly operations: readonly string[]; // '<owner>/<kind>' joined to this transaction (labels only)
  }
  export interface IndexedDbLedgerOperation extends IndexedDbOperation {
      readonly phase: IndexedDbLedgerPhase;
  }
  export interface IndexedDbTransactionLedger {
      readonly transactions: readonly IndexedDbLedgerTransaction[];
      readonly operations: readonly IndexedDbLedgerOperation[];
  }
  export interface IndexedDbLedgerTotals {
      readonly transactions: number;
      readonly requests: number;
      readonly byOwner: Readonly<Record<IndexedDbOperationOwner, number>>;
  }
  export interface RecordedIndexedDbTransactionLedger {
      readonly observer: IndexedDbOperationObserver;
      setPhase(phase: IndexedDbLedgerPhase): void;
      liveCount(): number;
      getLedger(): IndexedDbTransactionLedger;
  }
  export function recordIndexedDbTransactionLedger(): RecordedIndexedDbTransactionLedger;
  export function computeIndexedDbLedgerTotals(
      ledger: IndexedDbTransactionLedger,
      phases: readonly IndexedDbLedgerPhase[]
  ): IndexedDbLedgerTotals;
  export function toIndexedDbLedgerTable(ledger: IndexedDbTransactionLedger): string;
  ```
- Produces (the pins Tasks 5-7 lower, each in the same commit as its production change, with the reason in the assertion message):

  | Pin (test `al-indexeddb-transaction-ledger.test.ts`)                                                           | Figure at 52cc85b32 |
  | -------------------------------------------------------------------------------------------------------------- | ------------------: |
  | outbound warm send, `chain` transactions (enqueue call to the carrier's `sendPreparedMessage`)                 |                  11 |
  | outbound warm send, `chain` + `after-send` transactions                                                        |                  14 |
  | outbound warm send, `chain` + `after-send` requests                                                            |                  46 |
  | outbound warm send, `al-admission` operations                                                                  |                  10 |
  | outbound warm send, `al-work` operations                                                                       |                  12 |
  | inbound 4th message (plain head read): transactions / requests / `al-admission` / `al-work`                    |     11 / 34 / 8 / 5 |
  | inbound 2nd message (head read waits one rotation batch): transactions / requests / `al-admission` / `al-work` |     13 / 36 / 8 / 7 |

**Window definitions (what the phases mean, measured, not assumed)**

- `before`: everything the test did first: database open, bootstrap batch, warm-up message(s), and the
  warm-up's own trailing work.
- `chain`: opened after `enqueueIfAbsent` / `admitIncomingMessage` was called and before the carrier's
  `sendPreparedMessage` (outbound) or the fixture's dispatch (inbound, via `gateDispatch`) ran.
- `after-send`: from that send until the owner is idle again. Outbound: the release read, the release
  write, and the readiness probe the batch's end owes (`al-work-handler.ts` `wakeAfterProgress` wakes the
  engine, whose `isWork` probes storage once because the batch forgot the remembered answer). The
  readiness probe is this batch's own, so the survey's transaction #2 (the _previous_ batch's probe,
  overlapping #1) moves from the window's start to its end; the totals 14/46/12 are unchanged by that.
  Inbound: the release read and write (the fixture's engine never runs on its own).
- Outbound wait mechanism: `sendUntilOwnerIdle` waits (via `vi.waitFor`) until a `work-page` operation
  has been observed after the last `work-release` and no transaction is live. The warm-up send ends
  the same way, so the warm-up's readiness probe lands in `before`, not in `chain`.
- Inbound determinism: only the commits' own batches move the rotation (no engine round, no clock
  comparison), so the phase is a function of the message count. Measured from `ready()`: messages
  1, 2, 3, 4, 5, 6 cost 11, 13, 13, 11, 13, 13 transactions. The test pins message 4 (three warm-ups,
  the 11 shape) and message 2 (one warm-up, the 13 shape) exactly, instead of an upper bound.
  An engine round (`queueEngine.executeOnce()`) was tried first and rejected: whether its round runs a
  batch depends on a millisecond boundary (`readALInboundNextReadyAtMs` returns a later `nowMs()` than
  `hasReadyWork` compares it with), which made the 11-shape run flaky (3 of 10 runs).

**Measured ledger, outbound pinned send (warm, 2nd send), 52cc85b32**

| #  | Phase      | Mode      | Stores           | Requests | Ops joined                    |
| -- | ---------- | --------- | ---------------- | -------: | ----------------------------- |
| 23 | chain      | readonly  | entries,alm-work |        9 | 7 read, 2 work-read           |
| 24 | chain      | readonly  | entries,alm-work |        3 | 3 work-read                   |
| 25 | chain      | readonly  | entries,alm-work |        6 | write                         |
| 26 | chain      | readwrite | entries,alm-work |       12 | (continues write)             |
| 27 | chain      | readonly  | alm-work         |        1 | work-probe (exhaustion sweep) |
| 28 | chain      | readonly  | alm-work         |        2 | work-reserve                  |
| 29 | chain      | readwrite | alm-work         |        2 | (continues reserve)           |
| 30 | chain      | readonly  | alm-work         |        1 | work-probe (lease recovery)   |
| 31 | chain      | readonly  | entries,alm-work |        2 | 2 work-read (canonical)       |
| 32 | chain      | readonly  | entries,alm-work |        1 | read (supersedence)           |
| 33 | chain      | readonly  | entries,alm-work |        1 | read (receipt)                |
| 34 | after-send | readonly  | alm-work         |        1 | work-release                  |
| 35 | after-send | readwrite | alm-work         |        2 | (continues release)           |
| 36 | after-send | readonly  | alm-work         |        3 | work-page (readiness probe)   |

Chain: 11 transactions, 40 requests, 10 `al-admission`, 10 `al-work`. Total: 14, 46, 10, 12.

**Measured ledger, inbound pinned message**

- 11 shape (message 4): decision read (5), fence snapshot (7), commit rw (11), exhaustion sweep (1),
  head page read NEW (1), readiness read (2), claim read (1), claim rw (2), lease-recovery read (1),
  then after the dispatch the release read (1) and release rw (2). Chain 9 / 31 requests.
- 13 shape (message 2): the same plus, between the commit and the head page read, one rotation batch:
  its exhaustion sweep (1) and its RETRY page read (1). Chain 11 / 33 requests.

**Survey reconciliation (`p1-code-survey.md` §A.2 and §B)**

- Outbound §A.2 rows #1, #3-#14 match the ledger row for row (mode, stores, request count, owning op).
  One difference: §A.2 #2 (the previous batch's readiness probe, 3 `getAll`, `work-page`) is not in
  this window's chain; the pinned window instead ends with this batch's own probe (#36 above), the same
  cost, so the totals (14 / 46 / 10 + 12) agree. The survey's "11 sequential transactions" critical
  path is confirmed as the `chain` phase.
- Inbound §B: the 11-transaction table matches row for row; the 13 shape's extra two transactions are
  the rotation batch's exhaustion sweep and RETRY page read (the survey's #4-#7 in its 13 runs). The
  survey attributed the 11-vs-13 variance to batch phase; measured here it is a fixed period-3 cycle
  in the message count from `ready()` (11, 13, 13).

- [ ] **Step 1: Write the failing test.** Create `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts` with exactly this content:

```ts
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type {
    IndexedDbOperationKind,
    IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from './inbound-runtime-test-fixture.ts';
import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';
import {
    computeIndexedDbLedgerTotals,
    recordIndexedDbTransactionLedger,
    toIndexedDbLedgerTable,
    type IndexedDbLedgerPhase,
    type IndexedDbTransactionLedger,
    type RecordedIndexedDbTransactionLedger
} from './record-indexed-db-transaction-ledger.ts';

const OUTBOUND_NAMESPACE = 'outbound-ledger';
const INBOUND_NAMESPACE = 'al-inbound-ledger';
const INBOUND_WORKER_ID = 'al-inbound:ledger';

// Each run warms its owner first and lets the warm-up's work finish, so the pinned message's window
// holds its own transactions only. Every message carries the ledger table, so a failed pin shows
// which transaction appeared or went away.
describe('outbound warm send IndexedDB transaction ledger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reaches the carrier in 11 transactions and the idle owner in 14', async () => {
        const ledger = await readWarmOutboundSendLedger();
        const chain = computeIndexedDbLedgerTotals(ledger, ['chain']);
        const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            chain.transactions,
            'enqueue to carrier: the decision read, the commit observation read, the fence snapshot and ' +
                'the commit; then the batch\'s exhaustion sweep, claim read, claim write, lease-recovery ' +
                'read, canonical read, supersedence read and receipt read' + table
        ).toBe(11);
        expect(
            total.transactions,
            'the chain, then the release read, the release write and the readiness probe the batch\'s ' +
                'end owes' + table
        ).toBe(14);
        expect(total.requests, 'every get, getAll and put those 14 transactions issue' + table)
            .toBe(46);
        expect(
            total.byOwner['al-admission'],
            '7 decision reads, the supersedence read, the receipt read and the commit' + table
        ).toBe(10);
        expect(
            total.byOwner['al-work'],
            '7 work reads (2 decision, 3 commit observation, 2 canonical), 2 empty probes, the ' +
                'reservation, the release and the readiness page' + table
        ).toBe(12);
    });
});

describe('inbound warm admit-and-deliver IndexedDB transaction ledger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('admits and delivers the fourth message, whose commit takes a plain head read, in 11 transactions', async () => {
        const ledger = await readWarmInboundDeliveryLedger(3);
        const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            total.transactions,
            'the decision read, the fence snapshot and the commit; the commit\'s batch: exhaustion sweep, ' +
                'head page read, readiness read, claim read, claim write and lease-recovery read; then ' +
                'the release read and write' + table
        ).toBe(11);
        expect(total.requests, 'every get, getAll and put those 11 transactions issue' + table)
            .toBe(34);
        expect(
            total.byOwner['al-admission'],
            '5 decision reads, the commit and the 2 readiness reads the dispatch reuses' + table
        ).toBe(8);
        expect(
            total.byOwner['al-work'],
            '2 empty probes, the page read, the reservation and the release' + table
        ).toBe(5);
    });

    it('admits and delivers the second message, whose head read waits one rotation batch, in 13 transactions', async () => {
        const ledger = await readWarmInboundDeliveryLedger(1);
        const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            total.transactions,
            'a head read ran since the last rotation read, so the commit\'s head read waits one ' +
                'batch: the 11, plus that rotation batch\'s exhaustion sweep and page read' + table
        ).toBe(13);
        expect(total.requests, 'the 34, plus the rotation batch\'s 2 getAll' + table).toBe(36);
        expect(
            total.byOwner['al-admission'],
            'the rotation batch reads no admission row: 8, as after a rotation read' + table
        ).toBe(8);
        expect(
            total.byOwner['al-work'],
            'the 5, plus the rotation batch\'s empty probe and page read' + table
        ).toBe(7);
    });
});

async function readWarmOutboundSendLedger(): Promise<IndexedDbTransactionLedger> {
    const recorded = recordIndexedDbTransactionLedger();
    let phaseAtSend: IndexedDbLedgerPhase = 'before';
    const runtime = createDefaultOutboundTestRuntime({
        stores: createIndexedDbOutboundLedgerStores(recorded.observer, OUTBOUND_NAMESPACE),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [{ kind: 'send' }]
        }),
        sendPreparedMessage: async () => {
            recorded.setPhase(phaseAtSend);
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    await sendUntilOwnerIdle(runtime, recorded, 'msg-ledger-warm-up');
    recorded.setPhase('chain');
    phaseAtSend = 'after-send';
    await sendUntilOwnerIdle(runtime, recorded, 'msg-ledger-pinned');
    return recorded.getLedger();
}

/**
 * The commit's own batch sends the message; the owner is idle once the readiness probe the batch's
 * end schedules has read storage after the release. Waiting for that probe keeps it out of the next
 * send's chain.
 */
async function sendUntilOwnerIdle(
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>,
    recorded: RecordedIndexedDbTransactionLedger,
    resourceId: string
): Promise<void> {
    const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage(resourceId));
    expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: true });
    await vi.waitFor(() => {
        expect(isProbedAfterRelease(recorded.getLedger())).toBe(true);
        expect(recorded.liveCount()).toBe(0);
    });
}

function isProbedAfterRelease(ledger: IndexedDbTransactionLedger): boolean {
    const kinds = ledger.operations.map((operation) => operation.kind);
    const release = kinds.lastIndexOf('work-release');
    return release >= 0 && kinds.lastIndexOf('work-page') > release;
}

/**
 * Only the commits' own batches move the rotation here, so its phase is a function of the message
 * count. From `ready()`, the first message's commit takes a head read. The second finds a head read
 * already taken since the last rotation read and waits one rotation batch for its own. The third's
 * rotation batch wraps the scan to the head of NEW, so its own read there is a rotation read, and the
 * fourth takes a head read again without waiting.
 */
async function readWarmInboundDeliveryLedger(
    warmUpMessages: number
): Promise<IndexedDbTransactionLedger> {
    const recorded = recordIndexedDbTransactionLedger();
    let phaseAtDispatch: IndexedDbLedgerPhase = 'before';
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: INBOUND_NAMESPACE,
            storage: 'indexeddb',
            observer: recorded.observer
        }),
        effectWorkerId: INBOUND_WORKER_ID,
        gateDispatch: async () => {
            recorded.setPhase(phaseAtDispatch);
        }
    });
    await fixture.runtime.ready();
    for (let message = 1; message <= warmUpMessages; message += 1) {
        await admitUntilReleased(fixture, recorded, `ledger-warm-up-${message}`);
    }
    recorded.setPhase('chain');
    phaseAtDispatch = 'after-send';
    await admitUntilReleased(fixture, recorded, 'ledger-pinned');
    return recorded.getLedger();
}

/** The fixture's engine never runs on its own: the commit's batches deliver, and the release ends them. */
async function admitUntilReleased(
    fixture: InboundTestRuntime,
    recorded: RecordedIndexedDbTransactionLedger,
    msgId: string
): Promise<void> {
    const delivered = fixture.delivered.length + 1;
    const admitted = await fixture.runtime.admitIncomingMessage(
        createInboundTestMessage({ msgId }),
        INBOUND_TEST_SOURCE
    );
    expect(admitted.right).toEqual({ kind: 'admitted' });
    await vi.waitFor(() => {
        expect(fixture.delivered).toHaveLength(delivered);
        expect(countOperations(recorded.getLedger(), 'work-release')).toBe(delivered);
        expect(recorded.liveCount()).toBe(0);
    });
}

function countOperations(ledger: IndexedDbTransactionLedger, kind: IndexedDbOperationKind): number {
    return ledger.operations.filter((operation) => operation.kind === kind).length;
}

function createIndexedDbOutboundLedgerStores(
    observer: IndexedDbOperationObserver,
    name: string
): ALOutboundRuntimeStores<OutboundTestPayload> {
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `${name}-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer
    });
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: name,
            decodePrepared: decodeOutboundTestPayload,
            namespace: name,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue
    };
}
```

- [ ] **Step 2: Run it and watch it fail.**

```sh
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
```

Expected (the recorder does not exist yet):

```text
 FAIL  |unit| packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts [ packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts ]
Error: Cannot find module './record-indexed-db-transaction-ledger.ts' imported from .../packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 3: Write the recorder.** Create `packages/tests/shared/alm/record-indexed-db-transaction-ledger.ts` with exactly this content:

```ts
import { vi } from 'vitest';

import type {
    IndexedDbOperation,
    IndexedDbOperationObserver,
    IndexedDbOperationOwner
} from '@shared/persistence/indexed-db-operation-observer.ts';

/**
 * `chain` runs from the call that admits the message to the carrier's send, `after-send` from that
 * send until the owner is idle again, and `before` is everything the test did first.
 */
export type IndexedDbLedgerPhase = 'before' | 'chain' | 'after-send';

export interface IndexedDbLedgerTransaction {
    /** 1-based, in the order the transactions were opened. */
    readonly order: number;
    readonly mode: IDBTransactionMode;
    readonly stores: readonly string[];
    /** `<store>.<method>(<key>)` or `<store>.<index>.<method>(<range>)`, in the order they were issued. */
    readonly requests: readonly string[];
    readonly phase: IndexedDbLedgerPhase;
    /** `<owner>/<kind>` of every logical operation that joined this transaction. */
    readonly operations: readonly string[];
}

export interface IndexedDbLedgerOperation extends IndexedDbOperation {
    readonly phase: IndexedDbLedgerPhase;
}

export interface IndexedDbTransactionLedger {
    readonly transactions: readonly IndexedDbLedgerTransaction[];
    readonly operations: readonly IndexedDbLedgerOperation[];
}

export interface IndexedDbLedgerTotals {
    readonly transactions: number;
    readonly requests: number;
    readonly byOwner: Readonly<Record<IndexedDbOperationOwner, number>>;
}

export interface RecordedIndexedDbTransactionLedger {
    /** The observer the stores under test report their logical operations to. */
    readonly observer: IndexedDbOperationObserver;
    /** Every transaction opened and operation observed from now on belongs to this phase. */
    setPhase(phase: IndexedDbLedgerPhase): void;
    /** Transactions that have not completed, aborted or failed yet. */
    liveCount(): number;
    getLedger(): IndexedDbTransactionLedger;
}

interface LedgerTransactionState {
    readonly entry: IndexedDbLedgerTransaction & { requests: string[]; operations: string[]; };
    live: boolean;
}

interface LedgerState {
    phase: IndexedDbLedgerPhase;
    readonly transactions: LedgerTransactionState[];
    readonly byTransaction: Map<IDBTransaction, LedgerTransactionState>;
    readonly operations: IndexedDbLedgerOperation[];
    /** Operations observed before any request of theirs: the next request's transaction takes them. */
    pendingOperations: string[];
}

type RequestSource = 'store' | 'index';

/** A key, a key range, or the value a put or add stores. */
type RequestKey = IDBValidKey | IDBKeyRange | object | null | undefined;

/** The first argument is a key, a key range or a stored value; the second is a count or an out-of-line key. */
type RequestArguments = [first?: RequestKey, second?: IDBValidKey];

const STORE_REQUEST_METHODS = [
    'get',
    'getAll',
    'getAllKeys',
    'getKey',
    'count',
    'openCursor',
    'openKeyCursor',
    'put',
    'add',
    'delete'
] as const;
const INDEX_REQUEST_METHODS = [
    'get',
    'getAll',
    'getAllKeys',
    'getKey',
    'count',
    'openCursor',
    'openKeyCursor'
] as const;

/**
 * Patches `IDBDatabase.prototype.transaction` and the object-store and index request methods for the
 * rest of the test: every suite using this needs `vi.restoreAllMocks()` in an `afterEach`.
 *
 * An operation reports itself either before its first request (a read, a write, a page read) or
 * after the read that decided it (a reservation, or a probe that computed no write). So an operation
 * joins the newest transaction when that one is a readonly read no operation has joined yet, and
 * otherwise the transaction its next request is issued on. The join holds for a run with one chain of
 * work in flight; it only labels the table, and no count depends on it.
 */
export function recordIndexedDbTransactionLedger(): RecordedIndexedDbTransactionLedger {
    const state: LedgerState = {
        phase: 'before',
        transactions: [],
        byTransaction: new Map(),
        operations: [],
        pendingOperations: []
    };
    recordOpenedTransactions(state);
    recordIssuedRequests(state, IDBObjectStore.prototype, 'store');
    recordIssuedRequests(state, IDBIndex.prototype, 'index');
    return {
        observer: { observe: (operation) => recordOperation(state, operation) },
        setPhase: (phase) => {
            state.phase = phase;
        },
        liveCount: () => state.transactions.filter((recorded) => recorded.live).length,
        getLedger: () => ({
            transactions: state.transactions.map(({ entry }) => ({
                ...entry,
                requests: [...entry.requests],
                operations: [...entry.operations]
            })),
            operations: [...state.operations]
        })
    };
}

export function computeIndexedDbLedgerTotals(
    ledger: IndexedDbTransactionLedger,
    phases: readonly IndexedDbLedgerPhase[]
): IndexedDbLedgerTotals {
    const transactions = ledger.transactions.filter((transaction) =>
        phases.includes(transaction.phase)
    );
    const operations = ledger.operations.filter((operation) => phases.includes(operation.phase));
    return {
        transactions: transactions.length,
        requests: transactions.reduce(
            (count, transaction) => count + transaction.requests.length,
            0
        ),
        byOwner: {
            'al-admission':
                operations.filter((operation) => operation.owner === 'al-admission').length,
            'al-work': operations.filter((operation) => operation.owner === 'al-work').length
        }
    };
}

/** One line per transaction, so a failed pin shows which transaction appeared or went away. */
export function toIndexedDbLedgerTable(ledger: IndexedDbTransactionLedger): string {
    return ledger.transactions.map((transaction) =>
        [
            `#${transaction.order}`,
            transaction.phase,
            transaction.mode,
            `[${transaction.stores.join(',')}]`,
            `ops=${transaction.operations.join(',') || '-'}`,
            `requests=${transaction.requests.length}: ${transaction.requests.join(' ')}`
        ].join(' ')
    ).join('\n');
}

function recordOpenedTransactions(state: LedgerState): void {
    const openTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
    ) {
        const transaction = openTransaction.call(this, storeNames, mode, options);
        const recorded: LedgerTransactionState = {
            live: true,
            entry: {
                order: state.transactions.length + 1,
                mode: mode ?? 'readonly',
                stores: typeof storeNames === 'string' ? [storeNames] : [...storeNames],
                requests: [],
                phase: state.phase,
                operations: []
            }
        };
        state.transactions.push(recorded);
        state.byTransaction.set(transaction, recorded);
        for (const ended of ['complete', 'abort', 'error']) {
            transaction.addEventListener(ended, () => {
                recorded.live = false;
            });
        }
        return transaction;
    });
}

function recordIssuedRequests(
    state: LedgerState,
    prototype: IDBObjectStore | IDBIndex,
    source: RequestSource
): void {
    const methods = source === 'store' ? STORE_REQUEST_METHODS : INDEX_REQUEST_METHODS;
    for (const method of methods) {
        const issue = Reflect.get(prototype, method) as (...args: RequestArguments) => IDBRequest;
        vi.spyOn(prototype as IDBObjectStore, method).mockImplementation(function (
            this: IDBObjectStore | IDBIndex,
            ...args: RequestArguments
        ) {
            recordRequest(state, this, `${method}(${toRequestKeyText(this, method, args)})`);
            return issue.apply(this, args);
        } as never);
    }
}

function recordRequest(state: LedgerState, source: IDBObjectStore | IDBIndex, call: string): void {
    const store = source instanceof IDBIndex ? source.objectStore : source;
    const recorded = state.byTransaction.get(store.transaction);
    if (recorded === undefined) {
        return;
    }
    const name = source instanceof IDBIndex ? `${store.name}.${source.name}` : store.name;
    recorded.entry.requests.push(`${name}.${call}`);
    recorded.entry.operations.push(...state.pendingOperations);
    state.pendingOperations = [];
}

function recordOperation(state: LedgerState, operation: IndexedDbOperation): void {
    state.operations.push({ ...operation, phase: state.phase });
    const name = `${operation.owner}/${operation.kind}`;
    const newest = state.transactions.at(-1)?.entry;
    const decidedByItsRead = newest !== undefined && newest.mode === 'readonly' &&
        newest.requests.length > 0 &&
        newest.operations.length === 0;
    if (decidedByItsRead) {
        newest.operations.push(name);
        return;
    }
    state.pendingOperations.push(name);
}

function toRequestKeyText(
    source: IDBObjectStore | IDBIndex,
    method: string,
    args: RequestArguments
): string {
    const [first, second] = args;
    if (method !== 'put' && method !== 'add') {
        return toKeyText(first);
    }
    if (second !== undefined) {
        return toKeyText(second);
    }
    const keyPath = source.keyPath;
    return typeof keyPath === 'string' && typeof first === 'object' && first !== null
        ? toKeyText(Reflect.get(first, keyPath))
        : '';
}

function toKeyText(key: RequestKey): string {
    if (key === undefined) {
        return '';
    }
    if (typeof key === 'string') {
        return key;
    }
    if (key instanceof IDBKeyRange) {
        return `${toKeyText(key.lower)}..${toKeyText(key.upper)}`;
    }
    return JSON.stringify(key);
}
```

Why it does not reuse `record-indexed-db-transactions.ts`: that helper installs its own
`vi.spyOn(IDBDatabase.prototype, 'transaction')` and exposes only modes and live counts, not the
transaction objects its requests have to be joined to. Two spies on the same method replace each
other's implementation, so the ledger records transactions itself with the same teardown contract
(`vi.restoreAllMocks()` in `afterEach`). The `unknown`-free argument types (`RequestKey`,
`RequestArguments`) are what keeps `boundary.unknown` findings out of the changed-style gate.

- [ ] **Step 4: Run the pins and watch them pass.**

```sh
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
```

Expected:

```text
Test Files  1 passed (1)
     Tests  3 passed (3)
```

Then check the pins are deterministic:

```sh
for i in $(seq 1 10); do npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts 2>&1 | grep -E 'Tests '; done | sort | uniq -c
```

Expected: `10       Tests  3 passed (3)`.

What a failed pin prints (checked by temporarily setting the outbound chain pin to 10): the reason,
then one line per transaction of the whole run, e.g.

```text
AssertionError: enqueue to carrier: the decision read, the commit observation read, the fence snapshot and the commit; then the batch's exhaustion sweep, ...
#1 before versionchange [] ops=- requests=1: entries.put(__rallar_al_schema__)
...
#23 chain readonly [entries,alm-work] ops=al-admission/read,...,al-work/work-read,al-work/work-read requests=9: entries.get(outbound-ledger:version:self) ...
#24 chain readonly [entries,alm-work] ops=al-work/work-read,al-work/work-read,al-work/work-read requests=3: alm-work.get(AL_OUTBOUND/outbound-ledger/send-...) ...
...
#36 after-send readonly [alm-work] ops=al-work/work-page requests=3: alm-work.by-type-status-key.getAll(["AL_OUTBOUND:...","NEW"]..["AL_OUTBOUND:...","NEW",[]]) ...
```

- [ ] **Step 5: Run the whole ALM test folder.**

```sh
npx vitest run packages/tests/shared/alm
```

Expected:

```text
Test Files  88 passed (88)
     Tests  1114 passed (1114)
```

- [ ] **Step 6: Constraint checks.**

```sh
npx dprint fmt packages/tests/shared/alm/record-indexed-db-transaction-ledger.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
node scripts/check-tests-typecheck.mjs
```

Expected: dprint changes nothing; `tsc` exits 0 with no output; `check-tests-typecheck` reports
`1399 test files enforced, 0 files carrying known debt (0 errors).` and PASS. (In a worktree whose
`apps/rallar-black-box/node_modules` was never installed it additionally reports
`FAIL: new type errors in an enforced file: apps/rallar-black-box/vite.config.ts (1)`
— `Cannot find module '@vitejs/plugin-react'`; that is the missing nested install, not this task:
`npx tsc -p packages/tests/tsconfig.json --noEmit 2>&1 | grep transaction-ledger` prints nothing.)

- [ ] **Step 6b: Share the outbound store fixture instead of copying it.** The ledger test's
      `createIndexedDbOutboundLedgerStores` is a copy of the private `createIndexedDbOutboundCountStores` in
      `al-indexeddb-operation-counts.test.ts:358-383`. Move that function, verbatim, into
      `packages/tests/shared/alm/outbound-runtime-test-fixture.ts` as an export, and make both tests import it:

```ts
// appended to packages/tests/shared/alm/outbound-runtime-test-fixture.ts (add the imports it needs beside the
// existing ones: IndexedDbAdmissionBackend from '@shared/alm/indexed-db-admission-backend.ts',
// AL_ADMISSION_SCHEMA_ID from '@shared/alm/open-indexed-db-admission-database.ts',
// createALOutboundAdmissionStore from '@shared/alm/outbound/admission/al-outbound-admission-store.ts',
// type ALOutboundRuntimeStores from '@shared/alm/outbound/al-outbound-message-runtime.ts',
// type IndexedDbOperationObserver from '@shared/persistence/indexed-db-operation-observer.ts',
// decodeOutboundTestPayload and type OutboundTestPayload from './outbound-test-payload.ts';
// normalizeALRuntimeStoreRetention is already imported there)
export function createIndexedDbOutboundCountStores(
    observer: IndexedDbOperationObserver,
    name: string
): ALOutboundRuntimeStores<OutboundTestPayload> {
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `${name}-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer
    });
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: name,
            decodePrepared: decodeOutboundTestPayload,
            namespace: name,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue
    };
}
```

Then: delete the function from `al-indexeddb-operation-counts.test.ts` and add
`createIndexedDbOutboundCountStores` to its import from `./outbound-runtime-test-fixture.ts` (drop any import
that only the moved function used); in `al-indexeddb-transaction-ledger.test.ts` delete
`createIndexedDbOutboundLedgerStores` and its now-unused imports, import `createIndexedDbOutboundCountStores`
from `./outbound-runtime-test-fixture.ts`, and replace the one call site. Re-run
`npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
(expected: both files pass with the same counts) and `npx dprint fmt` on the three files.

- [ ] **Step 7: Commit.**

```sh
git add packages/tests/shared/alm/record-indexed-db-transaction-ledger.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/outbound-runtime-test-fixture.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
git commit -m "Pin the durable send and admit-and-deliver IndexedDB transaction ledgers at today's figures"
```

- [ ] **Step 8: Changed-range style and coupling gates.**

```sh
npm run check:repo-style:changed -- <base> HEAD
node scripts/check-test-structure-coupling.mjs --changed <base> HEAD
```

Expected (`<base>` = the commit before this task; 52cc85b32 in the prototype):

```text
PASS: no new repository style findings (...)
PASS: no current structure-coupled test candidates
PASS: changed-range structure-coupling review has complete individual classifications
PASS: registry entries are complete and current
```

**Guidance for Tasks 5-7 (consumers).** Lower a pin in the same commit as the production change that
removes the transaction, and rewrite that assertion's reason to name what is gone. The chain and total
pins move together (a removed chain transaction lowers both); `after-send` does not move in Tasks 5-7.
Compute the new request figure from the printed table rather than by subtraction. The inbound pins do
not move in Tasks 5-7 (they touch outbound code only); a change to them means an inbound regression.

---

### Task 2: The plain-page manual harness and the before-figures

The spike's deleted plain page (QoS plan §7.4–§7.5) rebuilt as a Playwright manual suite (D111): a persistent
Chromium profile so IndexedDB is on disk, the browser WS client's real durable outbound owner over the browser's
IndexedDB store pair, a carrier that records when it is called, send-to-dispatch p50 and p95 per configuration, and a
CDP CPU profile whose samples are attributed to the Temporal polyfill, JSBI and the QueueBox IndexedDB entry codec.
No product code changes: this task lands the instrument and reads the before-figures that Task 8 compares against.

**Files**

- Create: `tests/playwright/alm/playwright.config.ts` (lines 1-12): the suite's own config (one worker, 20 min).
- Create: `tests/playwright/alm/durable-send-plain-page.spec.ts` (lines 1-95): the manual suite.
- Create: `tests/playwright/alm/harness/durable-send-harness-contract.ts` (lines 1-32): the page/spec contract.
- Create: `tests/playwright/alm/harness/paced-frame-load.ts` (lines 1-71): the 10-in-16 ms frame load.
- Create: `tests/playwright/alm/harness/create-durable-send-harness.ts` (lines 1-169): the runtime composition and the measured send loop (page side).
- Create: `tests/playwright/alm/harness/durable-send-harness-page.ts` (lines 1-4): the page entry.
- Create: `tests/playwright/alm/bundle-durable-send-harness.ts` (lines 1-52): esbuild bundle plus its module line table.
- Create: `tests/playwright/alm/compute-send-to-dispatch-percentiles.ts` (lines 1-20): nearest-rank percentiles.
- Create: `tests/playwright/alm/compute-cpu-profile-shares.ts` (lines 1-140): profile attribution.
- Create: `tests/playwright/alm/drive-durable-send-harness.ts` (lines 1-105): route, pages, CDP throttle and profiler.
- Create: `tests/playwright/alm/durable-send-report.ts` (lines 1-90): figures, the JSON artifact and the console table.
- Modify: `package.json` (line 35, inserted before `perf:api-v1:state-write`): the `perf:alm:durable-send` script.
- Modify: `tests/manual-suites.json` (lines 27-35, a fourth entry appended): the suite's owner entry.
- Modify: `tests/playwright/README.md` (lines 3-5 and the new row at line 15): the suite map.
- Test: `tests/playwright/alm/durable-send-plain-page.spec.ts` via `npm run perf:alm:durable-send`.

**Interfaces**

- Consumes (unchanged product code, imported by the page bundle):
  - `createBrowserALOutboundRuntimeStores(name: string, options?: BrowserALRuntimeOptions): ALOutboundRuntimeStores<ALOutboundTransportMessage>` from `@shared-web/browser/al-runtime/browser-al-runtime-stores.ts`, with `toBrowserWsClientALRuntimeStoreId(sessionId)` from `browser-al-runtime-identity.ts` and `canonicalScope: 'browser-session:<sessionId>'`, exactly as `configureBrowserALRuntimeStores` scopes the WS client's pair (IndexedDB database `ar-eye-hunter-al-runtime`).
  - `createDefaultALOutboundMessageRuntime<TPrepared>(dependencies: CreateDefaultALOutboundMessageRuntimeDependencies<TPrepared>): ALOutboundMessageRuntime<TPrepared>` from `@shared/alm/outbound/create-default-al-outbound-message-runtime.ts`; `navigator.locks` exists on the page, so the commit takes the real Web Lock.
  - `decodeALOutboundTransportMessage`, `toALOutboundTransportMessage` (`al-outbound-transport-message.ts`), `newALUnicastMessage` (`al-contract.ts`), `decodePersistedALMessage`, `QueueBoxUtilities.toResourceEntryFromMsg`, `EnqueuedType.WS_OUTBOX`.
  - The runtime's `diagnostics` sink: the durable lane's `readiness-probe` event marks the owner idle again after a send's batch (the window Task 1's ledger calls `after-send`, ruling R-P1a-5).
  - The plan is the ledger's shape: `{ msg, dropReasonCode: undefined, persist: true, preparedMessages: [toALOutboundTransportMessage(msg)] }` (no ack, retry, repair or supersedence tracking), so the harness times the same 11-transaction chain Task 1 pins.
- Produces:
  - `npm run perf:alm:durable-send` (Task 8 step 3 runs it three times and greps `p50|p95|polyfill|codec|artifact`).
  - Console lines, one per configuration, each naming its figures:
    `<configuration> p50 <ms> ms  p95 <ms> ms  runs p50/p95: <p50>/<p95>[ (busy <share>)] ...`, then
    `idle CPU profile over 300 sends: busy <ms> ms; polyfill <x> % + JSBI <y> % = <x+y> %; codec self <c> %, inclusive <i> %; polyfill + JSBI under the codec <u> %`, then `artifact: <path>`.
  - The JSON artifact `tmp/perf/alm-durable-send/<ISO timestamp with - for : and .>.json` (`tmp/` is gitignored), shape `DurableSendReport`:
    ```ts
    interface DurableSendReport {
        readonly createdAt: string;
        readonly commit: string; // git rev-parse HEAD
        readonly browser: string; // CDP Browser.getVersion product, e.g. HeadlessChrome/149.0.7827.55
        readonly host: string; // e.g. darwin arm64 Apple M2 Max
        readonly method: { warmupCount: 10; measuredCount: 90; runCount: 3; profiledCount: 300; };
        readonly configurations: readonly {
            name: 'idle' | 'cpu-4x' | 'frame-load' | 'cpu-4x-frame-load';
            cpuThrottlingRate: 1 | 4;
            frameLoad: { busyMsPerFrame: 10; frameIntervalMs: 16; } | undefined;
            runs: readonly {
                p50Ms: number;
                p95Ms: number;
                unsettledCount: number;
                frameLoadBusyShare: number | null;
                sendToDispatchMs: readonly number[];
            }[];
            medianP50Ms: number; // median of the runs' p50s: the configuration's figure
            medianP95Ms: number;
        }[];
        readonly profile: {
            busyMs: number;
            temporalPolyfillPercent: number;
            jsbiPercent: number;
            temporalPercent: number;
            codecSelfPercent: number;
            codecInclusivePercent: number;
            temporalUnderCodecPercent: number;
        };
    }
    ```
  - `.superpowers/sdd/alm-p1a-codec-and-send-chain-implementation-plan/evidence/harness-before.md` (gitignored; Task 8 step 1 checks it exists and step 3 reads it).

**Method (what the figures mean)**

- _Send-to-dispatch_: `performance.now()` just before `runtime.enqueueIfAbsent(msg)` to the first line of the carrier's `sendPreparedMessage` for that message. The batch that dispatches is the one `ALWorkHandler.committed()` starts at once, not an engine tick, so engine scheduling is excluded, as in the spike.
- Each send waits for its batch's durable `readiness-probe` before the next starts (a 2 s bound counts a missing probe as `unsettledCount`; the spec requires 0), so every send starts on an idle owner.
- Every run is a freshly loaded page in the same persistent profile: `ready()`, CPU throttle via `Emulation.setCPUThrottlingRate`, the frame load if any, 10 warm-up sends, 90 measured sends. Three runs per configuration; the configuration's figure is the median of the three runs' p50s and p95s.
- _Frame load_: a `requestAnimationFrame` loop that busy-waits 10 ms once per 16 ms of a frame clock. Headless Chromium runs animation frames back to back rather than on vsync (measured here: 76–89 callbacks/s with 10 ms of work each, 86–88 % busy), so an unpaced loop would not be 10-in-16; the paced loop measures 0.62–0.64 busy (10/16 = 0.625), and each run records its measured share. Under the load each send starts at the end of a frame's work, where a game's frame loop would issue it.
- _Configurations_: `idle` (1×), `cpu-4x`, `frame-load` (1× with the load: the spike's 16.8/30.3 reference) and `cpu-4x-frame-load` (D89's figure).
- _CPU profile_: one extra idle page, 10 warm-up sends, then `Profiler.start` (100 µs sampling) over 300 sends. The bundle is one unminified ES module with `keepNames`; esbuild opens each bundled module with a `// <path>` line, so a sample's bundle line is attributed to its source module (`@js-temporal/polyfill/`, `/jsbi/`, `queuebox/indexed-db-queue-box-entry-codec.ts`). Shares are of busy time (every sample except `(idle)`). "Polyfill + JSBI under the codec" is the part of the polyfill and JSBI self time with a codec frame on its stack (the spike's "72 % of the polyfill time is the codec's date conversions").
- The page is served by `context.route` on `http://localhost/alm-durable-send/` (a secure context, so Web Locks and `crypto.randomUUID` exist); nothing listens on a port, so the suite does not collide with the lanes' ports.

- [ ] **Step 1: Write the suite's config, npm script and spec (the failing test)**

Create `tests/playwright/alm/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

/** A manual measurement suite: one worker, so no other page competes for the CPU it measures. */
export default defineConfig({
    testDir: '.',
    testMatch: /durable-send-plain-page\.spec\.ts/,
    timeout: 20 * 60_000,
    workers: 1,
    fullyParallel: false,
    retries: 0,
    reporter: [['list']]
});
```

In `package.json`, insert this line directly above `"perf:api-v1:state-write": ...` (it becomes line 35):

```json
"perf:alm:durable-send": "playwright test --config tests/playwright/alm/playwright.config.ts",
```

Create `tests/playwright/alm/durable-send-plain-page.spec.ts`:

```ts
import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    bundleDurableSendHarness,
    type DurableSendHarnessBundle
} from './bundle-durable-send-harness.ts';
import { computeCpuProfileShares, type CpuProfileShares } from './compute-cpu-profile-shares.ts';
import {
    DURABLE_SEND_HARNESS_SCRIPT_URL,
    profileDurableSends,
    readBrowserVersion,
    routeDurableSendHarness,
    runDurableSendConfiguration,
    type DurableSendConfiguration
} from './drive-durable-send-harness.ts';
import {
    toConfigurationFigures,
    toDurableSendTable,
    writeDurableSendReport,
    type DurableSendConfigurationFigures,
    type DurableSendMethod
} from './durable-send-report.ts';

const METHOD: DurableSendMethod = {
    warmupCount: 10,
    measuredCount: 90,
    runCount: 3,
    profiledCount: 300
};

const CONFIGURATIONS: readonly DurableSendConfiguration[] = [
    { name: 'idle', cpuThrottlingRate: 1, frameLoad: undefined },
    { name: 'cpu-4x', cpuThrottlingRate: 4, frameLoad: undefined },
    {
        name: 'frame-load',
        cpuThrottlingRate: 1,
        frameLoad: { busyMsPerFrame: 10, frameIntervalMs: 16 }
    },
    {
        name: 'cpu-4x-frame-load',
        cpuThrottlingRate: 4,
        frameLoad: { busyMsPerFrame: 10, frameIntervalMs: 16 }
    }
];

async function measureConfiguration(
    context: BrowserContext,
    configuration: DurableSendConfiguration
): Promise<DurableSendConfigurationFigures> {
    const runs = [];
    for (let run = 0; run < METHOD.runCount; run += 1) {
        runs.push(
            await runDurableSendConfiguration(context, configuration, {
                runId: `${configuration.name}-${run}`,
                warmupCount: METHOD.warmupCount,
                measuredCount: METHOD.measuredCount
            })
        );
    }
    return toConfigurationFigures(configuration, runs);
}

async function measureProfileShares(
    context: BrowserContext,
    bundle: DurableSendHarnessBundle
): Promise<CpuProfileShares> {
    const profile = await profileDurableSends(context, {
        runId: 'profile',
        warmupCount: METHOD.warmupCount,
        measuredCount: METHOD.profiledCount
    });
    return computeCpuProfileShares({
        profile,
        bundleUrl: DURABLE_SEND_HARNESS_SCRIPT_URL,
        modules: bundle.modules
    });
}

test('a durable send on a plain page with an on-disk profile reports send-to-dispatch and CPU shares', async () => {
    const bundle = await bundleDurableSendHarness();
    const profileDirectory = await mkdtemp(join(tmpdir(), 'alm-durable-send-'));
    const context = await chromium.launchPersistentContext(profileDirectory, { headless: true });
    try {
        await routeDurableSendHarness(context, bundle.script);
        const configurations = [];
        for (const configuration of CONFIGURATIONS) {
            configurations.push(await measureConfiguration(context, configuration));
        }
        const report = {
            createdAt: new Date().toISOString(),
            commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            browser: await readBrowserVersion(context),
            host: `${platform()} ${arch()} ${cpus()[0]?.model ?? 'unknown cpu'}`,
            method: METHOD,
            configurations,
            profile: await measureProfileShares(context, bundle)
        };
        console.log(
            `${toDurableSendTable(report)}\nartifact: ${await writeDurableSendReport(report)}`
        );
        // Evidence, not a gate: the suite fails only when a run lost figures or a send started before
        // the previous send's batch was idle again, never on a latency value.
        for (const configuration of configurations) {
            expect(
                configuration.runs.map((run) => [run.sendToDispatchMs.length, run.unsettledCount])
            )
                .toEqual(Array(METHOD.runCount).fill([METHOD.measuredCount, 0]));
        }
        expect(report.profile.busyMs).toBeGreaterThan(0);
    }
    finally {
        await context.close();
        await rm(profileDirectory, { recursive: true, force: true });
    }
});
```

- [ ] **Step 2: Run it and see it fail**

Sandbox disabled (Playwright launches Chromium):

```sh
npm run perf:alm:durable-send 2>&1 | tail -4
```

Expected (paths shortened to `<WT>`):

```text
Error: Cannot find module '<WT>/tests/playwright/alm/bundle-durable-send-harness.ts' imported from <WT>/tests/playwright/alm/durable-send-plain-page.spec.ts
    at eval (<anonymous>:1:1)
Error: No tests found
```

- [ ] **Step 3: Write the page side**

Create `tests/playwright/alm/harness/durable-send-harness-contract.ts`:

```ts
export interface DurableSendRunInput {
    readonly runId: string;
    readonly warmupCount: number;
    readonly measuredCount: number;
    /** The main-thread load the sends run under, or none for an idle page. */
    readonly frameLoad: FrameLoadInput | undefined;
}

export interface FrameLoadInput {
    readonly busyMsPerFrame: number;
    readonly frameIntervalMs: number;
}

export interface FrameLoadObservation {
    readonly frameCount: number;
    /** The share of the run's wall time the load kept the main thread busy. */
    readonly busyShare: number;
}

export interface DurableSendRun {
    /** One entry per measured send: `enqueueIfAbsent` call to the carrier's `sendPreparedMessage`, in ms. */
    readonly sendToDispatchMs: readonly number[];
    /** Sends whose batch emitted no readiness probe within the settle bound, so the next send did not wait for it. */
    readonly unsettledCount: number;
    readonly frameLoad: FrameLoadObservation | undefined;
}

export interface DurableSendHarness {
    runSends(input: DurableSendRunInput): Promise<DurableSendRun>;
}

export const DURABLE_SEND_HARNESS_GLOBAL = 'almDurableSendHarness';
```

Create `tests/playwright/alm/harness/paced-frame-load.ts`:

```ts
import type { FrameLoadInput, FrameLoadObservation } from './durable-send-harness-contract.ts';

/**
 * Busy main-thread work paced by a fixed frame clock inside a `requestAnimationFrame` loop. Headless
 * Chromium runs animation frames back to back instead of on a display's vsync, so the clock, not
 * the callback rate, holds the load at `busyMsPerFrame` of every `frameIntervalMs`.
 *
 * A caller that waits for a frame's end starts its work where a game's frame loop would: right
 * after the frame's own work, in the same task. Starting at that fixed phase keeps the round trips'
 * alignment with later frames, and so the figures, the same from run to run.
 */
export class PacedFrameLoad {
    private handle: number | undefined;
    private nextFrameAtMs = 0;
    private startedAtMs = 0;
    private busyMs = 0;
    private frameCount = 0;
    private frameEndWaiters: (() => void)[] = [];

    start(input: FrameLoadInput): void {
        this.startedAtMs = performance.now();
        this.nextFrameAtMs = this.startedAtMs;
        this.busyMs = 0;
        this.frameCount = 0;
        const runFrame = () => {
            this.runFrame(input);
            this.handle = requestAnimationFrame(runFrame);
        };
        this.handle = requestAnimationFrame(runFrame);
    }

    /** Resolves right after the next frame's work; at once when no load runs. */
    waitForFrameEnd(): Promise<void> {
        if (this.handle === undefined) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.frameEndWaiters.push(resolve));
    }

    stop(): FrameLoadObservation | undefined {
        if (this.handle === undefined) {
            return undefined;
        }
        cancelAnimationFrame(this.handle);
        this.handle = undefined;
        this.releaseFrameEndWaiters();
        const elapsedMs = performance.now() - this.startedAtMs;
        return {
            frameCount: this.frameCount,
            busyShare: Math.round((this.busyMs / elapsedMs) * 1000) / 1000
        };
    }

    private runFrame(input: FrameLoadInput): void {
        const frameStartMs = performance.now();
        if (frameStartMs < this.nextFrameAtMs) {
            return;
        }
        const busyUntilMs = frameStartMs + input.busyMsPerFrame;
        while (performance.now() < busyUntilMs) {
            // Busy-wait: the frame's main-thread work every durable round trip queues behind.
        }
        this.busyMs += performance.now() - frameStartMs;
        this.frameCount += 1;
        this.nextFrameAtMs = Math.max(this.nextFrameAtMs + input.frameIntervalMs, frameStartMs);
        this.releaseFrameEndWaiters();
    }

    private releaseFrameEndWaiters(): void {
        const waiters = this.frameEndWaiters;
        this.frameEndWaiters = [];
        waiters.forEach((resolve) => resolve());
    }
}
```

Create `tests/playwright/alm/harness/create-durable-send-harness.ts`:

```ts
import { toBrowserWsClientALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import { createBrowserALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import type {
    DurableSendHarness,
    DurableSendRun,
    DurableSendRunInput
} from './durable-send-harness-contract.ts';
import { PacedFrameLoad } from './paced-frame-load.ts';

/** Far above any batch this page runs, so a missing probe shows up as a count instead of a hang. */
const SETTLE_BOUND_MS = 2_000;

interface DurableSendSample {
    readonly sendToDispatchMs: number;
    readonly settled: boolean;
}

/** The carrier's send calls and the durable lane's readiness probes, as the page observes them. */
class DurableSendObservation {
    private readonly dispatchWaiters = new Map<string, (atMs: number) => void>();
    private probeWaiters: (() => void)[] = [];

    observeDispatch(msgId: string): void {
        const atMs = performance.now();
        this.dispatchWaiters.get(msgId)?.(atMs);
        this.dispatchWaiters.delete(msgId);
    }

    observeDiagnostics(event: ALOutboundRuntimeDiagnosticsEvent): void {
        if (event.kind !== 'readiness-probe' || event.lane !== 'durable') {
            return;
        }
        const waiters = this.probeWaiters;
        this.probeWaiters = [];
        waiters.forEach((resolve) => resolve());
    }

    waitForDispatch(msgId: string): Promise<number> {
        return new Promise((resolve) => this.dispatchWaiters.set(msgId, resolve));
    }

    waitForProbe(boundMs: number): Promise<boolean> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), boundMs);
            this.probeWaiters.push(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }
}

class PlainPageDurableSendHarness implements DurableSendHarness {
    private readonly sessionId: string;
    private readonly runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    private readonly observation: DurableSendObservation;

    constructor(
        sessionId: string,
        runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>,
        observation: DurableSendObservation
    ) {
        this.sessionId = sessionId;
        this.runtime = runtime;
        this.observation = observation;
    }

    async runSends(input: DurableSendRunInput): Promise<DurableSendRun> {
        const frameLoad = new PacedFrameLoad();
        if (input.frameLoad !== undefined) {
            frameLoad.start(input.frameLoad);
        }
        try {
            const samples = await this.sendAll(input, frameLoad);
            return { ...samples, frameLoad: frameLoad.stop() };
        }
        finally {
            frameLoad.stop();
        }
    }

    private async sendAll(
        input: DurableSendRunInput,
        frameLoad: PacedFrameLoad
    ): Promise<Omit<DurableSendRun, 'frameLoad'>> {
        const sendToDispatchMs: number[] = [];
        let unsettledCount = 0;
        for (let index = 0; index < input.warmupCount + input.measuredCount; index += 1) {
            await frameLoad.waitForFrameEnd();
            const sample = await this.sendOnce(
                toHarnessMessage(this.sessionId, `${input.runId}-${index}`)
            );
            if (index >= input.warmupCount) {
                sendToDispatchMs.push(sample.sendToDispatchMs);
                unsettledCount += sample.settled ? 0 : 1;
            }
        }
        return { sendToDispatchMs, unsettledCount };
    }

    /** One durable send, then the wait for its batch's readiness probe so the next send starts idle. */
    private async sendOnce(msg: ALMessage): Promise<DurableSendSample> {
        const dispatched = this.observation.waitForDispatch(msg.id.msgId);
        const startedAtMs = performance.now();
        assertDurableAdmission(await this.runtime.enqueueIfAbsent(msg));
        const dispatchedAtMs = await dispatched;
        const settled = await this.observation.waitForProbe(SETTLE_BOUND_MS);
        return { sendToDispatchMs: dispatchedAtMs - startedAtMs, settled };
    }
}

function assertDurableAdmission(result: ALOutboundEnqueueResult): void {
    if (result.verdict.kind !== 'admitted' || !result.verdict.durable) {
        throw new Error(`Expected a durable admission, received ${JSON.stringify(result.verdict)}`);
    }
}

function toHarnessMessage(sessionId: string, resourceId: string): ALMessage {
    return newALUnicastMessage(
        sessionId,
        { topicId: 'alm-harness', resourceId, contextId: 'durable-send' },
        'harness-peer',
        'alm-harness.durable-send.v1',
        { resourceId },
        { ttlMs: 60_000 }
    );
}

function toDurablePlan(msg: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    return {
        msg,
        dropReasonCode: undefined,
        persist: true,
        preparedMessages: [toALOutboundTransportMessage(msg)]
    };
}

/**
 * The browser WS client's durable outbound owner over the browser's IndexedDB store pair, with a
 * carrier that records when it is called and reports every attempt sent.
 */
export async function createDurableSendHarness(sessionId: string): Promise<DurableSendHarness> {
    const observation = new DurableSendObservation();
    const stores = createBrowserALOutboundRuntimeStores(
        toBrowserWsClientALRuntimeStoreId(sessionId),
        {
            canonicalScope: `browser-session:${sessionId}`
        }
    );
    const runtime = createDefaultALOutboundMessageRuntime<ALOutboundTransportMessage>({
        stores,
        outbox: stores.workQueue,
        carrier: 'ws',
        decodePreparedMessage: decodeALOutboundTransportMessage,
        toOutboxEntry: (msg) =>
            QueueBoxUtilities.toResourceEntryFromMsg(msg, EnqueuedType.WS_OUTBOX),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: toDurablePlan,
        diagnostics: (event) => observation.observeDiagnostics(event),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            observation.observeDispatch(lifecycle.canonicalMessage.id.msgId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    await runtime.ready();
    return new PlainPageDurableSendHarness(sessionId, runtime, observation);
}
```

Create `tests/playwright/alm/harness/durable-send-harness-page.ts`:

```ts
import { createDurableSendHarness } from './create-durable-send-harness.ts';
import { DURABLE_SEND_HARNESS_GLOBAL } from './durable-send-harness-contract.ts';

Reflect.set(
    globalThis,
    DURABLE_SEND_HARNESS_GLOBAL,
    await createDurableSendHarness(crypto.randomUUID())
);
```

- [ ] **Step 4: Write the Node side**

Create `tests/playwright/alm/bundle-durable-send-harness.ts`:

```ts
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HARNESS_ENTRY = 'tests/playwright/alm/harness/durable-send-harness-page.ts';
/** esbuild opens every module of an unminified bundle with a `// <path>` line naming its source. */
const MODULE_MARKER = /^\/\/ (\S+\.[cm]?[jt]sx?)$/;

/** Where one bundled module's code starts, so a profile's bundle line can be traced to its source file. */
export interface BundledModule {
    readonly startLine: number;
    readonly source: string;
}

export interface DurableSendHarnessBundle {
    readonly script: string;
    readonly modules: readonly BundledModule[];
}

/**
 * The harness page as one unminified ES module with its function names kept, so a CPU profile names
 * the functions and every bundle line maps to the module it came from.
 */
export async function bundleDurableSendHarness(): Promise<DurableSendHarnessBundle> {
    const result = await build({
        absWorkingDir: REPOSITORY_ROOT,
        entryPoints: [HARNESS_ENTRY],
        tsconfig: join(REPOSITORY_ROOT, 'tsconfig.json'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        minify: false,
        keepNames: true,
        write: false,
        logLevel: 'silent'
    });
    const script = result.outputFiles[0]!.text;
    return { script, modules: toBundledModules(script) };
}

function toBundledModules(script: string): readonly BundledModule[] {
    const modules: BundledModule[] = [];
    script.split('\n').forEach((line, index) => {
        const source = MODULE_MARKER.exec(line)?.[1];
        if (source !== undefined) {
            modules.push({ startLine: index, source });
        }
    });
    return modules;
}
```

Create `tests/playwright/alm/compute-send-to-dispatch-percentiles.ts`:

```ts
export interface SendToDispatchPercentiles {
    readonly p50Ms: number;
    readonly p95Ms: number;
}

/** Nearest-rank percentiles, rounded to 0.1 ms, of one run's measured sends. */
export function computeSendToDispatchPercentiles(
    samplesMs: readonly number[]
): SendToDispatchPercentiles {
    const sorted = [...samplesMs].sort((left, right) => left - right);
    return { p50Ms: computeNearestRank(sorted, 0.5), p95Ms: computeNearestRank(sorted, 0.95) };
}

/** The middle of the runs' values: the figure a configuration reports across its runs. */
export function computeMedian(values: readonly number[]): number {
    return computeNearestRank([...values].sort((left, right) => left - right), 0.5);
}

function computeNearestRank(sorted: readonly number[], fraction: number): number {
    const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
    return Math.round((sorted[index] ?? Number.NaN) * 10) / 10;
}
```

Create `tests/playwright/alm/compute-cpu-profile-shares.ts`:

```ts
import type { BundledModule } from './bundle-durable-send-harness.ts';

/** The fields of a CDP `Profiler.Profile` the shares read. */
export interface CpuProfile {
    readonly nodes: readonly CpuProfileNode[];
    readonly samples?: readonly number[];
    readonly timeDeltas?: readonly number[];
}

export interface CpuProfileNode {
    readonly id: number;
    readonly callFrame: {
        readonly functionName: string;
        readonly url: string;
        readonly lineNumber: number;
    };
    readonly children?: readonly number[];
}

export interface CpuProfileSharesInput {
    readonly profile: CpuProfile;
    readonly bundleUrl: string;
    readonly modules: readonly BundledModule[];
}

/** Self-time shares of busy CPU (every sample but `(idle)`), each rounded to 0.1 %. */
export interface CpuProfileShares {
    readonly busyMs: number;
    readonly temporalPolyfillPercent: number;
    readonly jsbiPercent: number;
    /** The polyfill and JSBI together: the spike's 32 %. */
    readonly temporalPercent: number;
    readonly codecSelfPercent: number;
    /** Samples with the codec anywhere on the stack. */
    readonly codecInclusivePercent: number;
    /** Of the polyfill and JSBI time, the part the codec called: the spike's 72 %. */
    readonly temporalUnderCodecPercent: number;
}

type FrameOwner = 'temporal-polyfill' | 'jsbi' | 'codec' | 'other' | 'idle';

interface SampleTotals {
    busyUs: number;
    readonly selfUs: Record<FrameOwner, number>;
    codecOnStackUs: number;
    temporalUnderCodecUs: number;
}

export function computeCpuProfileShares(input: CpuProfileSharesInput): CpuProfileShares {
    const totals = computeSampleTotals(input);
    const temporalUs = totals.selfUs['temporal-polyfill'] + totals.selfUs.jsbi;
    return {
        busyMs: Math.round(totals.busyUs / 100) / 10,
        temporalPolyfillPercent: toPercent(totals.selfUs['temporal-polyfill'], totals.busyUs),
        jsbiPercent: toPercent(totals.selfUs.jsbi, totals.busyUs),
        temporalPercent: toPercent(temporalUs, totals.busyUs),
        codecSelfPercent: toPercent(totals.selfUs.codec, totals.busyUs),
        codecInclusivePercent: toPercent(totals.codecOnStackUs, totals.busyUs),
        temporalUnderCodecPercent: toPercent(totals.temporalUnderCodecUs, temporalUs)
    };
}

function computeSampleTotals(input: CpuProfileSharesInput): SampleTotals {
    const attributions = toNodeAttributions(input);
    const totals: SampleTotals = {
        busyUs: 0,
        selfUs: { 'temporal-polyfill': 0, jsbi: 0, codec: 0, other: 0, idle: 0 },
        codecOnStackUs: 0,
        temporalUnderCodecUs: 0
    };
    const deltas = input.profile.timeDeltas ?? [];
    (input.profile.samples ?? []).forEach((nodeId, index) => {
        const { owner, codecOnStack } = attributions.get(nodeId) ??
            { owner: 'other', codecOnStack: false };
        const durationUs = deltas[index + 1] ?? 0;
        totals.selfUs[owner] += durationUs;
        if (owner === 'idle') {
            return;
        }
        totals.busyUs += durationUs;
        totals.codecOnStackUs += codecOnStack ? durationUs : 0;
        const temporal = owner === 'temporal-polyfill' || owner === 'jsbi';
        totals.temporalUnderCodecUs += temporal && codecOnStack ? durationUs : 0;
    });
    return totals;
}

interface NodeAttribution {
    readonly owner: FrameOwner;
    readonly codecOnStack: boolean;
}

/** Every node's own frame owner and whether a codec frame is at or above it, walked once from the root. */
function toNodeAttributions(input: CpuProfileSharesInput): ReadonlyMap<number, NodeAttribution> {
    const nodes = new Map(input.profile.nodes.map((node) => [node.id, node]));
    const attributions = new Map<number, NodeAttribution>();
    const root = input.profile.nodes[0];
    const pending: [CpuProfileNode, boolean][] = root === undefined ? [] : [[root, false]];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        const [node, codecAbove] = next;
        const owner = resolveFrameOwner(node, input);
        const codecOnStack = codecAbove || owner === 'codec';
        attributions.set(node.id, { owner, codecOnStack });
        for (const child of node.children ?? []) {
            const childNode = nodes.get(child);
            if (childNode !== undefined) {
                pending.push([childNode, codecOnStack]);
            }
        }
    }
    return attributions;
}

function resolveFrameOwner(node: CpuProfileNode, input: CpuProfileSharesInput): FrameOwner {
    if (node.callFrame.functionName === '(idle)') {
        return 'idle';
    }
    if (node.callFrame.url !== input.bundleUrl) {
        return 'other';
    }
    const source = resolveBundledSource(input.modules, node.callFrame.lineNumber);
    if (source.includes('@js-temporal/polyfill/')) {
        return 'temporal-polyfill';
    }
    if (source.includes('/jsbi/')) {
        return 'jsbi';
    }
    return source.endsWith('queuebox/indexed-db-queue-box-entry-codec.ts') ? 'codec' : 'other';
}

/** The module whose section holds this zero-based bundle line; sections are in line order. */
function resolveBundledSource(modules: readonly BundledModule[], lineNumber: number): string {
    let source = '';
    for (const module of modules) {
        if (module.startLine > lineNumber) {
            break;
        }
        source = module.source;
    }
    return source;
}

function toPercent(partUs: number, wholeUs: number): number {
    return wholeUs === 0 ? 0 : Math.round((partUs / wholeUs) * 1000) / 10;
}
```

Create `tests/playwright/alm/drive-durable-send-harness.ts`:

```ts
import type { BrowserContext, CDPSession, Page } from '@playwright/test';

import type { CpuProfile } from './compute-cpu-profile-shares.ts';
import {
    DURABLE_SEND_HARNESS_GLOBAL,
    type DurableSendHarness,
    type DurableSendRun,
    type DurableSendRunInput,
    type FrameLoadInput
} from './harness/durable-send-harness-contract.ts';

/** A secure-context origin, so Web Locks and `crypto.randomUUID` exist; the route serves it, nothing listens. */
const HARNESS_PAGE_URL = 'http://localhost/alm-durable-send/';
export const DURABLE_SEND_HARNESS_SCRIPT_URL = `${HARNESS_PAGE_URL}durable-send-harness.js`;
const HARNESS_PAGE_HTML = '<!doctype html><meta charset="utf-8"><title>ALM durable send</title>' +
    `<script type="module" src="${DURABLE_SEND_HARNESS_SCRIPT_URL}"></script>`;
const PROFILER_SAMPLING_INTERVAL_US = 100;

export interface DurableSendConfiguration {
    readonly name: string;
    readonly cpuThrottlingRate: number;
    readonly frameLoad: FrameLoadInput | undefined;
}

interface HarnessPage {
    readonly page: Page;
    readonly cdp: CDPSession;
}

export async function routeDurableSendHarness(
    context: BrowserContext,
    script: string
): Promise<void> {
    await context.route(`${HARNESS_PAGE_URL}**`, async (route) => {
        const isScript = route.request().url() === DURABLE_SEND_HARNESS_SCRIPT_URL;
        await route.fulfill(
            isScript
                ? { contentType: 'text/javascript', body: script }
                : { contentType: 'text/html', body: HARNESS_PAGE_HTML }
        );
    });
}

export async function readBrowserVersion(context: BrowserContext): Promise<string> {
    const { page, cdp } = await openHarnessPage(context);
    try {
        return (await cdp.send('Browser.getVersion')).product;
    }
    finally {
        await closeHarnessPage({ page, cdp });
    }
}

/** One run on a freshly loaded page: throttle, optional frame load, warm-up, then the measured sends. */
export async function runDurableSendConfiguration(
    context: BrowserContext,
    configuration: DurableSendConfiguration,
    input: Omit<DurableSendRunInput, 'frameLoad'>
): Promise<DurableSendRun> {
    const harnessPage = await openHarnessPage(context);
    try {
        await harnessPage.cdp.send('Emulation.setCPUThrottlingRate', {
            rate: configuration.cpuThrottlingRate
        });
        return await runSendsInPage(harnessPage.page, {
            ...input,
            frameLoad: configuration.frameLoad
        });
    }
    finally {
        await closeHarnessPage(harnessPage);
    }
}

/** A CPU profile over the measured sends of an idle page, taken after its warm-up. */
export async function profileDurableSends(
    context: BrowserContext,
    input: Omit<DurableSendRunInput, 'frameLoad'>
): Promise<CpuProfile> {
    const harnessPage = await openHarnessPage(context);
    const idle = { ...input, frameLoad: undefined };
    try {
        await runSendsInPage(harnessPage.page, { ...idle, measuredCount: 0 });
        await harnessPage.cdp.send('Profiler.enable');
        await harnessPage.cdp.send('Profiler.setSamplingInterval', {
            interval: PROFILER_SAMPLING_INTERVAL_US
        });
        await harnessPage.cdp.send('Profiler.start');
        await runSendsInPage(harnessPage.page, {
            ...idle,
            runId: `${input.runId}-profiled`,
            warmupCount: 0
        });
        return (await harnessPage.cdp.send('Profiler.stop')).profile;
    }
    finally {
        await closeHarnessPage(harnessPage);
    }
}

async function openHarnessPage(context: BrowserContext): Promise<HarnessPage> {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.goto(HARNESS_PAGE_URL);
    await page.waitForFunction(
        (name) => Reflect.has(globalThis, name),
        DURABLE_SEND_HARNESS_GLOBAL
    );
    return { page, cdp };
}

async function closeHarnessPage(harnessPage: HarnessPage): Promise<void> {
    await harnessPage.cdp.detach();
    await harnessPage.page.close();
}

async function runSendsInPage(page: Page, input: DurableSendRunInput): Promise<DurableSendRun> {
    return await page.evaluate(async ({ name, runInput }) => {
        const harness = Reflect.get(globalThis, name) as DurableSendHarness;
        return await harness.runSends(runInput);
    }, { name: DURABLE_SEND_HARNESS_GLOBAL, runInput: input });
}
```

Create `tests/playwright/alm/durable-send-report.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CpuProfileShares } from './compute-cpu-profile-shares.ts';
import {
    computeMedian,
    computeSendToDispatchPercentiles
} from './compute-send-to-dispatch-percentiles.ts';
import type { DurableSendConfiguration } from './drive-durable-send-harness.ts';
import type { DurableSendRun } from './harness/durable-send-harness-contract.ts';

const REPORT_DIRECTORY = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../tmp/perf/alm-durable-send'
);

export interface DurableSendRunFigures {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly unsettledCount: number;
    /** The share of the run the frame load kept the main thread busy; null on an idle page. */
    readonly frameLoadBusyShare: number | null;
    readonly sendToDispatchMs: readonly number[];
}

export interface DurableSendConfigurationFigures extends DurableSendConfiguration {
    readonly runs: readonly DurableSendRunFigures[];
    /** The median of the runs' p50s and of their p95s. */
    readonly medianP50Ms: number;
    readonly medianP95Ms: number;
}

export interface DurableSendReport {
    readonly createdAt: string;
    readonly commit: string;
    readonly browser: string;
    readonly host: string;
    readonly method: DurableSendMethod;
    readonly configurations: readonly DurableSendConfigurationFigures[];
    readonly profile: CpuProfileShares;
}

export interface DurableSendMethod {
    readonly warmupCount: number;
    readonly measuredCount: number;
    readonly runCount: number;
    readonly profiledCount: number;
}

export function toConfigurationFigures(
    configuration: DurableSendConfiguration,
    runs: readonly DurableSendRun[]
): DurableSendConfigurationFigures {
    const figures = runs.map((run) => ({
        ...computeSendToDispatchPercentiles(run.sendToDispatchMs),
        unsettledCount: run.unsettledCount,
        frameLoadBusyShare: run.frameLoad?.busyShare ?? null,
        sendToDispatchMs: run.sendToDispatchMs.map((value) => Math.round(value * 100) / 100)
    }));
    return {
        ...configuration,
        runs: figures,
        medianP50Ms: computeMedian(figures.map((run) => run.p50Ms)),
        medianP95Ms: computeMedian(figures.map((run) => run.p95Ms))
    };
}

/** Writes the report under `tmp/perf/alm-durable-send/` and returns the file's path. */
export async function writeDurableSendReport(report: DurableSendReport): Promise<string> {
    await mkdir(REPORT_DIRECTORY, { recursive: true });
    const path = join(REPORT_DIRECTORY, `${report.createdAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    return path;
}

/** One line per configuration, each naming its figures, so a `grep p50` of the log keeps every row. */
export function toDurableSendTable(report: DurableSendReport): string {
    const rows = report.configurations.map((configuration) => {
        const runs = configuration.runs.map((run) =>
            `${run.p50Ms}/${run.p95Ms}${
                run.frameLoadBusyShare === null ? '' : ` (busy ${run.frameLoadBusyShare})`
            }`
        ).join('  ');
        return `${configuration.name.padEnd(18)} p50 ${
            String(configuration.medianP50Ms).padStart(5)
        } ms  ` +
            `p95 ${String(configuration.medianP95Ms).padStart(5)} ms  runs p50/p95: ${runs}`;
    });
    const { profile } = report;
    return [
        `send-to-dispatch, median of ${report.method.runCount} runs of ${report.method.measuredCount} sends, ` +
        `${report.browser}, ${report.commit.slice(0, 9)}`,
        ...rows,
        `idle CPU profile over ${report.method.profiledCount} sends: busy ${profile.busyMs} ms; ` +
        `polyfill ${profile.temporalPolyfillPercent} % + JSBI ${profile.jsbiPercent} % = ${profile.temporalPercent} %; ` +
        `codec self ${profile.codecSelfPercent} %, inclusive ${profile.codecInclusivePercent} %; ` +
        `polyfill + JSBI under the codec ${profile.temporalUnderCodecPercent} %`
    ].join('\n');
}
```

- [ ] **Step 5: Typecheck the suite**

No gate typechecks `tests/playwright/**` (`check-tests-typecheck.mjs` covers `packages/tests` and `tests/unit`;
the root `tsconfig.json` has no `include`), so check it with a throwaway config under the gitignored `tmp/`:

```sh
mkdir -p tmp && cat > tmp/tsconfig.alm-harness.json <<'EOF'
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "types": ["node"], "lib": ["ES2023", "DOM"], "noEmit": true, "module": "ESNext", "target": "ES2023" },
  "include": ["../tests/playwright/alm/**/*.ts"]
}
EOF
npx tsc -p tmp/tsconfig.alm-harness.json && echo TSC-OK
```

Expected: `TSC-OK` and no diagnostics.

- [ ] **Step 6: Run the suite and see it pass**

Sandbox disabled, no lane or other Playwright run on the machine (`uptime` load average below about 5; see the
noise note in step 12):

```sh
npm run perf:alm:durable-send 2>&1 | grep -E "p50|p95|polyfill|codec|artifact|passed|failed"
```

Expected: `1 passed` in 35–45 s, four configuration lines, the profile line and the artifact path. The shape of a
green run on this machine (measured at the task commit, figures vary run to run):

```text
idle               p50   3.4 ms  p95   3.8 ms  runs p50/p95: 3.2/3.6  3.5/3.9  3.4/3.8
cpu-4x             p50  11.7 ms  p95  13.3 ms  runs p50/p95: 11.7/13.9  11.4/13.3  11.7/12.9
frame-load         p50  13.1 ms  p95  14.5 ms  runs p50/p95: 12.9/13.9 (busy 0.62)  13.1/23.1 (busy 0.621)  13.2/14.5 (busy 0.622)
cpu-4x-frame-load  p50  31.2 ms  p95  52.4 ms  runs p50/p95: 31.1/52.6 (busy 0.633)  31.2/52.4 (busy 0.632)  31.9/51.8 (busy 0.632)
idle CPU profile over 300 sends: busy 653 ms; polyfill 22.6 % + JSBI 12.3 % = 34.9 %; codec self 2.6 %, inclusive 29.1 %; polyfill + JSBI under the codec 75.9 %
artifact: <WT>/tmp/perf/alm-durable-send/2026-09-30T21-51-50-890Z.json
  1 passed (34.5s)
```

- [ ] **Step 7: Stage the suite and see the reachability check fail**

```sh
git add package.json tests/playwright/alm
npm run -s check:test-reachability; echo "exit=$?"
```

Expected:

```text
Test reachability: 1700 test files, 1694 reached by CI, 6 manual.
tests/playwright/alm/durable-send-plain-page.spec.ts: no CI workflow runs this test and tests/manual-suites.json does not own it
exit=1
```

(The counts are those of `52cc85b32` plus this spec; a later base moves them, the finding line is what matters.)

- [ ] **Step 8: Own the suite in `tests/manual-suites.json` and see the check pass**

Append this entry as the array's last element (after the `test:playwright:ar-eye` entry, whose closing `}` gains a
`,`):

```json
{
  "paths": [
    "tests/playwright/alm/durable-send-plain-page.spec.ts"
  ],
  "owner": "Knut-Helge Vik",
  "command": "npm run perf:alm:durable-send",
  "reason": "Latency evidence, not a gate: send-to-dispatch p50/p95 and the Temporal polyfill and codec CPU shares of a durable ALM send in Chromium with an on-disk profile. Run locally before and after each durable-path lever and compare against a baseline from the same machine; hosted-runner timings are not comparable, and a lane that fails on a latency figure would be noise."
}
```

```sh
npm run -s check:test-reachability; echo "exit=$?"
```

Expected: `Test reachability: 1700 test files, 1694 reached by CI, 6 manual.` and `exit=0`.

- [ ] **Step 9: Add the suite to the Playwright suite map**

In `tests/playwright/README.md`, replace lines 3-4 with lines 3-5 below and append the last row to the table
(after the AR Eye Hunter row):

```markdown
Playwright configs are app-owned. Run suites through the app config so the
right tests, dev server, ports, and browser options are selected. The ALM
durable-send harness serves no app, so its config sits beside its suite.
```

```markdown
| ALM durable-send harness | `tests/playwright/alm` | `tests/playwright/alm/playwright.config.ts` | `npm run perf:alm:durable-send` | none: the page is served by a route |
```

- [ ] **Step 10: Format and run the constraint checks**

```sh
npx dprint fmt package.json tests/manual-suites.json tests/playwright/README.md tests/playwright/alm/playwright.config.ts tests/playwright/alm/durable-send-plain-page.spec.ts tests/playwright/alm/bundle-durable-send-harness.ts tests/playwright/alm/compute-send-to-dispatch-percentiles.ts tests/playwright/alm/compute-cpu-profile-shares.ts tests/playwright/alm/drive-durable-send-harness.ts tests/playwright/alm/durable-send-report.ts tests/playwright/alm/harness/durable-send-harness-contract.ts tests/playwright/alm/harness/paced-frame-load.ts tests/playwright/alm/harness/create-durable-send-harness.ts tests/playwright/alm/harness/durable-send-harness-page.ts
npx tsc -p tmp/tsconfig.alm-harness.json && echo TSC-OK
npx tsc -p packages/shared/tsconfig.json --noEmit && echo SHARED-OK
node scripts/check-tests-typecheck.mjs 2>&1 | tail -1
npx vitest run packages/tests/repo/repository-governance.test.ts packages/tests/repo/repo-structure-check packages/tests/repo/release-gate-lanes.test.ts packages/tests/repo/typescript-7-boundaries.test.ts 2>&1 | grep -E "Test Files|Tests  "
```

Expected: dprint changes nothing (the code above is already in its format; written by hand, dprint sorts the
`@shared-web` imports above the `@shared` ones); `TSC-OK`; `SHARED-OK`;
`PASS: no new type errors in the maintained test project`; `Test Files  7 passed (7)` and `Tests  30 passed (30)`.

- [ ] **Step 11: Commit, then the changed-range checks**

```sh
git add package.json tests/manual-suites.json tests/playwright/README.md tests/playwright/alm
git commit -m "Measure a durable ALM send's send-to-dispatch on a plain page with an on-disk profile

A Playwright manual suite (npm run perf:alm:durable-send) composes the browser WS client's
durable outbound owner over IndexedDB in a persistent Chromium profile, with a carrier that
records when it is called. It reports send-to-dispatch p50 and p95 for an idle page, 4x CPU,
a paced 10-in-16 ms frame load and both together, plus the Temporal polyfill, JSBI and codec
shares of an idle CPU profile, and writes them to tmp/perf/alm-durable-send/."
npm run check:repo-style:changed -- origin/main HEAD 2>&1 | tail -1
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD 2>&1 | tail -3
git status --short
```

Expected: `PASS: no new repository style findings (...)`; the three coupling `PASS` lines
(`no current structure-coupled test candidates`, `changed-range structure-coupling review has complete individual
classifications`, `registry entries are complete and current`); no status output (`tmp/` is ignored).

- [ ] **Step 12: The before-figures**

At the task commit (no product change since `main`), sandbox disabled, nothing else running (no lane, no other
Playwright or Vitest run; `uptime` load average below about 5 — under concurrent sessions at load 9–17 the
4×-CPU-with-frame-load figure wandered between 35 and 61 ms p50 across invocations of the same commit, at load 4–7 it
held at 31–32 ms):

```sh
E=.superpowers/sdd/alm-p1a-codec-and-send-chain-implementation-plan/evidence
mkdir -p $E tmp/p1a-task2
for k in 1 2 3; do uptime; npm run -s perf:alm:durable-send 2>&1 | tee tmp/p1a-task2/harness-before-$k.log | grep -E "p50|p95|polyfill|codec|artifact|passed|failed"; done
ls -t tmp/perf/alm-durable-send/*.json | head -3
```

Expected: three `1 passed`, three artifacts. Write `$E/harness-before.md` with: the commit (`git rev-parse HEAD`),
the host and Chromium version from the artifact, the load average before each invocation, a table of the three
invocations × four configurations (median p50 and p95, and the nine run-level p50/p95 pairs for
`cpu-4x-frame-load`), the three profile lines, the artifact paths, and the comparison with the spike's baseline
below, stating per figure whether it lands within the spread of the three invocations. Figures measured while
writing this plan (Apple M2 Max, HeadlessChrome/149.0.7827.55, commit `f84411c40 (scratch)` = `52cc85b32` plus this task, load
average 4.4–6.7):

| Invocation (load avg) | `idle` p50 / p95 | `cpu-4x`    | `frame-load` | `cpu-4x-frame-load` | `cpu-4x-frame-load` runs (p50/p95) |
| --------------------- | ---------------- | ----------- | ------------ | ------------------- | ---------------------------------- |
| 1 (6.66)              | 3.4 / 3.8        | 11.7 / 13.3 | 13.1 / 14.5  | 31.2 / 52.4         | 31.1/52.6, 31.2/52.4, 31.9/51.8    |
| 2 (5.15)              | 3.4 / 3.9        | 11.6 / 13.4 | 13.1 / 14.1  | 32.2 / 48.0         | 32.2/47.5, 31.2/51.9, 33.9/48.0    |
| 3 (4.36)              | 3.5 / 4.0        | 11.8 / 13.3 | 13.2 / 14.2  | 31.8 / 44.2         | 31.8/43.8, 31.8/45.8, 31.7/44.2    |

| Invocation | busy (ms, 300 sends) | polyfill |   JSBI | polyfill + JSBI | codec self | codec inclusive | polyfill + JSBI under the codec |
| ---------- | -------------------: | -------: | -----: | --------------: | ---------: | --------------: | ------------------------------: |
| 1          |                653.0 |   22.6 % | 12.3 % |          34.9 % |      2.6 % |          29.1 % |                          75.9 % |
| 2          |                652.0 |   22.9 % | 12.7 % |          35.7 % |      2.8 % |          29.1 % |                          73.7 % |
| 3          |                667.5 |   23.6 % | 12.9 % |          36.5 % |      2.7 % |          29.5 % |                          73.5 % |

The frame load measured 0.618–0.625 busy at 1× and 0.632–0.636 at 4× in every run; `unsettledCount` was 0 in every
run. At 1× under the load a single run sometimes lands in a faster mode (p50 3.8–5.5 ms: the whole chain fits in a
frame's 6 ms gap); the median of three runs absorbs it.

Against the spike on `bdb3ecd8b` (same machine, same Chromium): the idle figure (3.4–3.5 vs 4.1 ms p50) and the CPU
shares reproduce (polyfill + JSBI 34.9–36.5 % vs 32 %; 73.5–75.9 % of it under the codec vs 72 %). The throttled and
loaded figures read lower: 4× CPU 11.6–11.8 vs 17.4 ms p50; the 1× frame load 13.1–13.2 / 14.1–14.5 vs 16.8 / 30.3;
the 4× frame load 31.2–32.2 / 44.2–52.4 vs 78.8 / 93.7. The spike's frame-load loop was deleted with its branch and
is not recoverable; an unpaced `requestAnimationFrame` busy loop (86–88 % busy at 1×) gives 13.3 / 133–192 ms at 1×
and 43.5–71.3 / 106.7–134.7 ms at 4×, so it does not reproduce the spike either. These harness figures, not the
spike's, are P1a's before-figures; record the gap in the evidence file and in the PR body.

---

### Task 3: Codec encode: one parse per field, no re-parse of its own output, no second decode of a computed put

Decision D110 (proposal §2.1 "The codec fix", §1.3; survey §C). Prototyped in the scratch tree as
commit `33d644e90` on `52cc85b32`, red then green; the figures below were measured there.

**What changes and why.** At `52cc85b32`:

- `encodeStoredResourceEntry` (`packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts:55-87`)
  runs `Temporal.*.from` on every timestamp the entry already holds and formats it. Then
  `validateStoredResourceEntry` (`:187-207`) parses every string it just produced.
- `computeIndexedDbQueuePut` (`indexed-db-queue-box-entry.ts:51-63`) encodes, and
  `validateComputedIndexedDbQueueMutations` (`:88-124`) decodes that value again.
- `toIndexedDbQueueExpectedState` (`:209-217`) decodes the previous row again, only to read its revision.

A spy on the three polyfill parsers measures:

- one encode of an entry with six timestamps: 12 parses (`Instant.from` 8, `PlainTime.from` 2,
  `PlainDateTime.from` 2);
- one put over a row that was just encoded, plus its validation: 24 parses (16 / 4 / 4).

After this task:

- **The encoder uses the values it holds.** It takes a Temporal value as is. A string is parsed once;
  any other value still throws the existing `TypeError`. It formats the strings and derives the epoch-ms
  mirrors from those values, and it does not validate its own output again.
- **The encoder freezes its rows.** It deep-freezes the row and records the row's Temporal values in a
  module-private `WeakMap` (`verifiedTimestamps`). A frozen row cannot drift from the values it was
  built from.
- **The value decoder skips only the Temporal part for such a row.** `decodeStoredResourceEntryValue`
  always runs the plain-field checks: record shape, strings, status, attempts, revision and key string.
  So a computed put with an invalid status is still
  `Left(TypeError('IndexedDB queue status is invalid'))` from `validateComputedIndexedDbQueueMutations`,
  as today.
- **Any other value is verified field by field, as today.** That covers a fabricated put, a copied
  put and every row read from IndexedDB. The `TypeError` messages and their order are unchanged.
- **The value decoder is split in two:**
  - `decodeStoredResourceEntryFields` is the plain-field decode, with the same checks and messages. It
    is split into `toStoredAudit` and `toStoredDequeueAudit` so that every function stays at or under
    40 lines.
  - `decodeStoredResourceEntryTimestamps` parses each timestamp once, runs the three mirror checks, and
    returns the parsed values that Task 4 uses.
- **`indexed-db-queue-box-entry.ts` is not edited.** Its put, guard and expected-state paths keep calling
  `decodeStoredResourceEntryValue`, which now parses nothing for a row the encoder produced.
- **The structural decode stays in the codec file.** A first cut put it in a new
  `decode-stored-resource-entry-fields.ts`. `check:repo-style:changed` then failed on
  `layout.directory-density`: 21 production files in `packages/shared/queuebox` against a threshold of
  20, plus two prefix-cluster findings. Kept in one file, the codec has no style finding (cognitive load
  under 50).

Unchanged: `ResourceEntry`, `StoredResourceEntry`, `AL_ADMISSION_SCHEMA_ID`, the server PostgreSQL codec
and every public signature. One new runtime property: a row returned by `encodeStoredResourceEntry` is
frozen. Its type was already `Readonly`, and no test or product code mutates one (checked by running
`packages/tests/shared/` and `packages/tests/shared-web/` in full).

**Files**

- Modify: `packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts`, the whole file. At `52cc85b32`:
  encode `:55-87`, decode `:89-112`, value decode `:114-185`, `validateStoredResourceEntry` `:187-207`,
  `toPlainTime`/`toPlainDateTime`/`toInstant` `:225-244`. The result is 378 lines.
- Create: `packages/tests/shared/queuebox/record-temporal-parses.ts` (test helper, 29 lines).
- Test: Create `packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts` (173 lines).
- Relied on, not edited: `packages/shared/queuebox/indexed-db-queue-box-entry.ts:51-63`, `:88-140`, `:209-217`.

**Interfaces**

- Consumes:
  - `ResourceEntry` (`packages/shared/queuebox/ResourceEntry.ts:60-68`), `toKeyAsString`,
    `COMPLETED_STATUSES`, `EntityStatus`.
  - Unchanged:
    `computeIndexedDbQueuePut(stored: StoredResourceEntry | undefined, entry: ResourceEntry): ComputedIndexedDbQueuePut`
    and
    `validateComputedIndexedDbQueueMutations(mutations: readonly ComputedIndexedDbQueueMutation[]): Either<Error, readonly ComputedIndexedDbQueueMutation[]>`.
- Produces (public signatures unchanged):
  - `export function encodeStoredResourceEntry(entry: ResourceEntry, revision: number): StoredResourceEntry`.
    The row it returns is now deep-frozen.
  - `export function decodeStoredResourceEntry(stored: StoredResourceEntry): ResourceEntry`
  - `export function decodeStoredResourceEntryValue<Value>(value: Value): StoredResourceEntry`
  - `export type StoredResourceEntry` (shape unchanged)
- Private to the codec, used by Task 4:
  - `interface StoredResourceEntryTimestamps` with `date: Temporal.PlainTime`,
    `createdTs: Temporal.PlainDateTime`, `expiryTs: Temporal.Instant`, and
    `startTs` / `endTs` / `nextTs: Temporal.Instant | undefined`
  - `decodeStoredResourceEntryTimestamps(stored: StoredResourceEntry): StoredResourceEntryTimestamps`
  - `freezeVerifiedStoredResourceEntry(stored: StoredResourceEntry, timestamps: StoredResourceEntryTimestamps): StoredResourceEntry`
  - `getVerifiedTimestamps<Value>(value: Value): StoredResourceEntryTimestamps | undefined`
  - `decodeStoredResourceEntryFields<Value>(value: Value): StoredResourceEntry`
- Test helper (Task 4 reuses it):
  - `export interface TemporalParseCounts` with `instant`, `plainTime` and `plainDateTime`
  - `export const NO_TEMPORAL_PARSES`
  - `export function recordTemporalParses(run: () => void): TemporalParseCounts`

- [ ] **Step 1: Write the test helper that counts polyfill parses.** Create
      `packages/tests/shared/queuebox/record-temporal-parses.ts`:

```ts
import { Temporal } from '@js-temporal/polyfill';
import { vi } from 'vitest';

export interface TemporalParseCounts {
    readonly instant: number;
    readonly plainTime: number;
    readonly plainDateTime: number;
}

export const NO_TEMPORAL_PARSES: TemporalParseCounts = {
    instant: 0,
    plainTime: 0,
    plainDateTime: 0
};

export function recordTemporalParses(run: () => void): TemporalParseCounts {
    const instant = vi.spyOn(Temporal.Instant, 'from');
    const plainTime = vi.spyOn(Temporal.PlainTime, 'from');
    const plainDateTime = vi.spyOn(Temporal.PlainDateTime, 'from');
    try {
        run();
        return {
            instant: instant.mock.calls.length,
            plainTime: plainTime.mock.calls.length,
            plainDateTime: plainDateTime.mock.calls.length
        };
    }
    finally {
        instant.mockRestore();
        plainTime.mockRestore();
        plainDateTime.mockRestore();
    }
}
```

- [ ] **Step 2: Write the failing codec test.** Create
      `packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts`.
  - The first ten tests pin today's outcomes. They pass before and after this task:
    - the row's shape;
    - that string input encodes to the same row;
    - the non-Temporal `TypeError`;
    - the four mirror and key-string rejections, with their exact `TypeError` messages;
    - the `RangeError` of a string that does not parse;
    - a fabricated put and an invalid status, both returned as `Left` values.
  - The last four pin the change: encode parses nothing, a put parses nothing, a copied value is still
    verified (6 parses), and an encoded row is frozen.

```ts
import { Temporal } from '@js-temporal/polyfill';
import {
    decodeStoredResourceEntryValue,
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueuePut,
    validateComputedIndexedDbQueueMutations
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { NO_TEMPORAL_PARSES, recordTemporalParses } from './record-temporal-parses.ts';

describe('IndexedDB queue entry codec', () => {
    it('stores each timestamp as a canonical string beside its epoch-ms mirror', () => {
        expect(encodeStoredResourceEntry(createRetryEntry(), 3)).toEqual({
            keyString: 'topic/resource/context',
            revision: 3,
            fairnessDueEpochMs: Date.parse('2026-09-30T12:00:03.000Z'),
            key: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
            resource: '{"value":1}',
            typeId: 'WS_OUTBOX',
            audit: {
                date: '12:00:00.123',
                createdBy: 'codec-test',
                createdTs: '2026-09-30T12:00:00.123',
                expiryTs: '2026-09-30T12:05:00.123Z'
            },
            expiryEpochMs: Date.parse('2026-09-30T12:05:00.123Z'),
            status: EntityStatus.RETRY,
            dequeueAudit: {
                startTs: '2026-09-30T12:00:01Z',
                endTs: '2026-09-30T12:00:02Z',
                nextTs: '2026-09-30T12:00:03.000000001Z',
                attempts: 1
            },
            endEpochMs: Date.parse('2026-09-30T12:00:02.000Z')
        });
    });

    it('encodes timestamps given as strings to the same row', () => {
        const entry = createRetryEntry();
        const legacy = {
            ...entry,
            audit: { ...entry.audit, expiryTs: entry.audit.expiryTs.toString() as never }
        };

        expect(encodeStoredResourceEntry(legacy, 3)).toEqual(encodeStoredResourceEntry(entry, 3));
    });

    it('rejects an entry whose timestamp is not a Temporal value', () => {
        const entry = createRetryEntry();

        expect(() =>
            encodeStoredResourceEntry({
                ...entry,
                audit: { ...entry.audit, expiryTs: 42 as never }
            }, 0)
        )
            .toThrow(new TypeError('IndexedDB queue timestamp must be an instant'));
    });

    it.each([
        {
            field: 'expiry mirror',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                expiryEpochMs: stored.expiryEpochMs + 1
            }),
            message: 'IndexedDB queue expiry timestamp (ms) differs from its expiry instant'
        },
        {
            field: 'end mirror',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                endEpochMs: (stored.endEpochMs ?? 0) + 1
            }),
            message: 'IndexedDB queue end timestamp (ms) differs from its dequeue audit'
        },
        {
            field: 'fairness mirror',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                fairnessDueEpochMs: (stored.fairnessDueEpochMs ?? 0) + 1
            }),
            message: 'IndexedDB queue fairness timestamp differs from its next timestamp'
        },
        {
            field: 'key string',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                keyString: 'topic/resource/other'
            }),
            message: 'IndexedDB queue row key differs from its canonical key'
        }
    ])('rejects a row whose $field disagrees with its canonical value', ({ change, message }) => {
        const stored = change(encodeStoredResourceEntry(createRetryEntry(), 0));

        expect(() => decodeStoredResourceEntryValue(stored)).toThrow(new TypeError(message));
    });

    it('rejects a row whose timestamp string does not parse', () => {
        const stored = encodeStoredResourceEntry(createRetryEntry(), 0);

        expect(() =>
            decodeStoredResourceEntryValue({ ...stored, audit: { ...stored.audit, date: 'noon' } })
        )
            .toThrow(RangeError);
    });

    it('rejects a fabricated put whose value disagrees with its own mirror', () => {
        const put = computeIndexedDbQueuePut(undefined, createRetryEntry());
        const fabricated = {
            ...put,
            value: { ...put.value, expiryEpochMs: put.value.expiryEpochMs + 1 }
        };

        expect(validateComputedIndexedDbQueueMutations([fabricated]).left).toEqual(
            new TypeError('IndexedDB queue expiry timestamp (ms) differs from its expiry instant')
        );
    });

    it('rejects a computed put whose status is not a queue status', () => {
        const put = computeIndexedDbQueuePut(undefined, {
            ...createRetryEntry(),
            status: 'LOST' as never
        });

        expect(validateComputedIndexedDbQueueMutations([put]).left).toEqual(
            new TypeError('IndexedDB queue status is invalid')
        );
    });

    it('encodes an entry without parsing a timestamp it already holds', () => {
        const entry = createRetryEntry();

        expect(
            recordTemporalParses(() => encodeStoredResourceEntry(entry, 0)),
            'an entry already holds Temporal values, so encoding only formats them'
        ).toEqual(NO_TEMPORAL_PARSES);
    });

    it('computes and validates a put without decoding its own output', () => {
        const entry = createRetryEntry();
        const previous = encodeStoredResourceEntry(entry, 0);

        expect(
            recordTemporalParses(() =>
                validateComputedIndexedDbQueueMutations([computeIndexedDbQueuePut(previous, entry)])
            ),
            'the encoder formatted every timestamp it holds, so validating its put parses nothing'
        ).toEqual(NO_TEMPORAL_PARSES);
    });

    it('verifies every timestamp of a put value the encoder did not produce', () => {
        const put = computeIndexedDbQueuePut(undefined, createRetryEntry());
        const copied = { ...put, value: structuredClone(put.value) };

        expect(
            recordTemporalParses(() => validateComputedIndexedDbQueueMutations([copied])),
            'a copied value is untrusted, so each of its six timestamps is parsed once'
        ).toEqual({ instant: 4, plainTime: 1, plainDateTime: 1 });
    });

    it('keeps an encoded row immutable so its verified timestamps cannot drift', () => {
        const stored = encodeStoredResourceEntry(createRetryEntry(), 0);

        expect([stored, stored.key, stored.audit, stored.dequeueAudit].map(Object.isFrozen))
            .toEqual([
                true,
                true,
                true,
                true
            ]);
    });
});

function createRetryEntry(): ResourceEntry {
    return {
        key: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
        resource: '{"value":1}',
        typeId: 'WS_OUTBOX',
        audit: {
            date: Temporal.PlainTime.from('12:00:00.123'),
            createdBy: 'codec-test',
            createdTs: Temporal.PlainDateTime.from('2026-09-30T12:00:00.123'),
            expiryTs: Temporal.Instant.from('2026-09-30T12:05:00.123Z')
        },
        status: EntityStatus.RETRY,
        dequeueAudit: {
            startTs: Temporal.Instant.from('2026-09-30T12:00:01Z'),
            endTs: Temporal.Instant.from('2026-09-30T12:00:02Z'),
            nextTs: Temporal.Instant.from('2026-09-30T12:00:03.000000001Z'),
            attempts: 1
        }
    };
}
```

- [ ] **Step 3: Run the test and watch the pins fail.**

```sh
npx vitest run packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts
```

Expected (measured with the codec as it is at `52cc85b32`):

```text
     × encodes an entry without parsing a timestamp it already holds
     × computes and validates a put without decoding its own output
     × keeps an encoded row immutable so its verified timestamps cannot drift
AssertionError: an entry already holds Temporal values, so encoding only formats them: expected { instant: 8, plainTime: 2, …(1) } to deeply equal { instant: +0, plainTime: +0, …(1) }
AssertionError: the encoder formatted every timestamp it holds, so validating its put parses nothing: expected { instant: 16, plainTime: 4, …(1) } to deeply equal { instant: +0, plainTime: +0, …(1) }
AssertionError: expected [ false, false, false, false ] to deeply equal [ true, true, true, true ]
      Tests  3 failed | 11 passed (14)
```

- [ ] **Step 4: Rewrite the codec.** Replace the whole of
      `packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts` with:

```ts
import { Temporal } from '@js-temporal/polyfill';

import {
    COMPLETED_STATUSES,
    EntityStatus,
    toKeyAsString,
    type Key,
    type ResourceEntry,
    type ResourceEntryKeyString
} from './ResourceEntry.ts';

export type StoredResourceEntry = Readonly<{
    keyString: ResourceEntryKeyString;
    revision: number;
    fairnessDueEpochMs?: number;
    key: Key;
    resource: string;
    typeId: string;
    audit: Readonly<{
        date: string;
        createdBy: string;
        createdTs: string;
        expiryTs: string;
    }>;
    expiryEpochMs: number;
    status: EntityStatus;
    dequeueAudit: Readonly<{
        startTs?: string;
        endTs?: string;
        nextTs?: string;
        attempts: number;
    }>;
    /** Null only while unreleased; a completed row with no recorded release defaults to 0 so retention cleanup can still index it. */
    endEpochMs: number | null;
}>;

type IndexedDbQueueDataValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | IndexedDbQueueDataRecord
    | readonly IndexedDbQueueDataValue[];

interface IndexedDbQueueDataRecord {
    readonly [key: string]: IndexedDbQueueDataValue;
}

interface DataRecordFields {
    readonly required: readonly string[];
    readonly optional?: readonly string[];
}

const ROW_FIELDS: DataRecordFields = {
    required: [
        'keyString',
        'revision',
        'key',
        'resource',
        'typeId',
        'audit',
        'expiryEpochMs',
        'status',
        'dequeueAudit',
        'endEpochMs'
    ],
    optional: ['fairnessDueEpochMs']
};
const KEY_FIELDS: DataRecordFields = { required: ['topicId', 'resourceId', 'contextId'] };
const AUDIT_FIELDS: DataRecordFields = { required: ['date', 'createdBy', 'createdTs', 'expiryTs'] };
const DEQUEUE_AUDIT_FIELDS: DataRecordFields = {
    required: ['attempts'],
    optional: ['startTs', 'endTs', 'nextTs']
};

interface StoredResourceEntryTimestamps {
    readonly date: Temporal.PlainTime;
    readonly createdTs: Temporal.PlainDateTime;
    readonly expiryTs: Temporal.Instant;
    readonly startTs: Temporal.Instant | undefined;
    readonly endTs: Temporal.Instant | undefined;
    readonly nextTs: Temporal.Instant | undefined;
}

/** Frozen rows whose timestamp strings and epoch-ms mirrors were produced from, or checked against, these values. */
const verifiedTimestamps = new WeakMap<object, StoredResourceEntryTimestamps>();

export function encodeStoredResourceEntry(
    entry: ResourceEntry,
    revision: number
): StoredResourceEntry {
    const timestamps = toStoredResourceEntryTimestamps(entry);
    return freezeVerifiedStoredResourceEntry(
        toStoredResourceEntry(entry, revision, timestamps),
        timestamps
    );
}

export function decodeStoredResourceEntry(stored: StoredResourceEntry): ResourceEntry {
    const canonical = decodeStoredResourceEntryValue(stored);
    return {
        key: canonical.key,
        resource: canonical.resource,
        typeId: canonical.typeId,
        audit: {
            date: toPlainTime(canonical.audit.date),
            createdBy: canonical.audit.createdBy,
            createdTs: toPlainDateTime(canonical.audit.createdTs),
            expiryTs: toInstant(canonical.audit.expiryTs)
        },
        status: canonical.status,
        dequeueAudit: {
            startTs: toOptionalInstant(canonical.dequeueAudit.startTs),
            endTs: toOptionalInstant(canonical.dequeueAudit.endTs),
            nextTs: toOptionalInstant(canonical.dequeueAudit.nextTs),
            attempts: canonical.dequeueAudit.attempts
        },
        db: {
            id: canonical.keyString
        }
    };
}

export function decodeStoredResourceEntryValue<Value>(value: Value): StoredResourceEntry {
    const canonical = decodeStoredResourceEntryFields(value);
    if (getVerifiedTimestamps(value) === undefined) {
        decodeStoredResourceEntryTimestamps(canonical);
    }
    return canonical;
}

function toStoredResourceEntryTimestamps(entry: ResourceEntry): StoredResourceEntryTimestamps {
    const expiryTs = toInstant(entry.audit.expiryTs);
    const endTs = toOptionalInstant(entry.dequeueAudit.endTs);
    const nextTs = toOptionalInstant(entry.dequeueAudit.nextTs);
    return {
        date: toPlainTime(entry.audit.date),
        createdTs: toPlainDateTime(entry.audit.createdTs),
        expiryTs,
        startTs: toOptionalInstant(entry.dequeueAudit.startTs),
        endTs,
        nextTs
    };
}

function toStoredResourceEntry(
    entry: ResourceEntry,
    revision: number,
    timestamps: StoredResourceEntryTimestamps
): StoredResourceEntry {
    const { expiryTs, endTs, nextTs } = timestamps;
    return {
        keyString: toKeyAsString(entry.key),
        revision,
        fairnessDueEpochMs: toOptionalEpochMs(nextTs),
        key: { ...entry.key },
        resource: entry.resource,
        typeId: entry.typeId,
        audit: {
            date: timestamps.date.toString(),
            createdBy: entry.audit.createdBy,
            createdTs: timestamps.createdTs.toString(),
            expiryTs: expiryTs.toString()
        },
        expiryEpochMs: Number(expiryTs.epochMilliseconds),
        status: entry.status,
        dequeueAudit: {
            startTs: timestamps.startTs?.toString(),
            endTs: endTs?.toString(),
            nextTs: nextTs?.toString({ fractionalSecondDigits: 9 }),
            attempts: entry.dequeueAudit.attempts
        },
        endEpochMs: toExpectedEndEpochMs(entry.status, endTs)
    };
}

function decodeStoredResourceEntryTimestamps(
    stored: StoredResourceEntry
): StoredResourceEntryTimestamps {
    const date = toPlainTime(stored.audit.date);
    const createdTs = toPlainDateTime(stored.audit.createdTs);
    const expiryTs = toInstant(stored.audit.expiryTs);
    if (stored.expiryEpochMs !== Number(expiryTs.epochMilliseconds)) {
        throw new TypeError(
            'IndexedDB queue expiry timestamp (ms) differs from its expiry instant'
        );
    }
    const startTs = toOptionalInstant(stored.dequeueAudit.startTs);
    const endTs = toOptionalInstant(stored.dequeueAudit.endTs);
    if (stored.endEpochMs !== toExpectedEndEpochMs(stored.status, endTs)) {
        throw new TypeError('IndexedDB queue end timestamp (ms) differs from its dequeue audit');
    }
    const nextTs = toOptionalInstant(stored.dequeueAudit.nextTs);
    if (stored.fairnessDueEpochMs !== toOptionalEpochMs(nextTs)) {
        throw new TypeError('IndexedDB queue fairness timestamp differs from its next timestamp');
    }
    return { date, createdTs, expiryTs, startTs, endTs, nextTs };
}

function freezeVerifiedStoredResourceEntry(
    stored: StoredResourceEntry,
    timestamps: StoredResourceEntryTimestamps
): StoredResourceEntry {
    Object.freeze(stored.key);
    Object.freeze(stored.audit);
    Object.freeze(stored.dequeueAudit);
    verifiedTimestamps.set(Object.freeze(stored), timestamps);
    return stored;
}

function getVerifiedTimestamps<Value>(value: Value): StoredResourceEntryTimestamps | undefined {
    return typeof value === 'object' && value !== null ? verifiedTimestamps.get(value) : undefined;
}

/**
 * A completed row that never passed through release (e.g. a canonical entry admitted
 * already-COMPLETED) has no dequeueAudit.endTs. Defaulting it to 0 instead of null keeps the
 * row indexable by `by-status-end`: IndexedDB drops a compound-index record when any key
 * component is null, which would hide such rows from retention cleanup forever.
 */
function toExpectedEndEpochMs(
    status: EntityStatus,
    endTs: Temporal.Instant | undefined
): number | null {
    if (endTs !== undefined) {
        return Number(endTs.epochMilliseconds);
    }
    return COMPLETED_STATUSES.has(status) ? 0 : null;
}

function toOptionalEpochMs(instant: Temporal.Instant | undefined): number | undefined {
    return instant === undefined ? undefined : Number(instant.epochMilliseconds);
}

function toPlainTime(value: string | Temporal.PlainTime): Temporal.PlainTime {
    if (value instanceof Temporal.PlainTime) {
        return value;
    }
    if (typeof value !== 'string') {
        throw new TypeError('IndexedDB queue audit date must be a plain time');
    }
    return Temporal.PlainTime.from(value);
}

function toPlainDateTime(value: string | Temporal.PlainDateTime): Temporal.PlainDateTime {
    if (value instanceof Temporal.PlainDateTime) {
        return value;
    }
    if (typeof value !== 'string') {
        throw new TypeError('IndexedDB queue creation timestamp must be a plain date-time');
    }
    return Temporal.PlainDateTime.from(value);
}

function toInstant(value: string | Temporal.Instant): Temporal.Instant {
    if (value instanceof Temporal.Instant) {
        return value;
    }
    if (typeof value !== 'string') {
        throw new TypeError('IndexedDB queue timestamp must be an instant');
    }
    return Temporal.Instant.from(value);
}

function toOptionalInstant(
    value: string | Temporal.Instant | undefined
): Temporal.Instant | undefined {
    return value === undefined ? undefined : toInstant(value);
}

function decodeStoredResourceEntryFields<Value>(value: Value): StoredResourceEntry {
    const stored = requireDataRecord(value, 'IndexedDB queue row', ROW_FIELDS);
    const key = requireDataRecord(stored.key, 'IndexedDB queue key', KEY_FIELDS);
    const audit = requireDataRecord(stored.audit, 'IndexedDB queue audit', AUDIT_FIELDS);
    const dequeueAudit = requireDataRecord(
        stored.dequeueAudit,
        'IndexedDB queue dequeue audit',
        DEQUEUE_AUDIT_FIELDS
    );
    const canonical = {
        keyString: requireString(stored.keyString, 'IndexedDB queue key string'),
        revision: requireNonNegativeInteger(stored.revision, 'IndexedDB queue revision'),
        ...(stored.fairnessDueEpochMs === undefined
            ? {}
            : {
                fairnessDueEpochMs: requireSafeInteger(
                    stored.fairnessDueEpochMs,
                    'IndexedDB queue fairness timestamp'
                )
            }),
        key: {
            topicId: requireString(key.topicId, 'IndexedDB queue topic id'),
            resourceId: requireString(key.resourceId, 'IndexedDB queue resource id'),
            contextId: requireString(key.contextId, 'IndexedDB queue context id')
        },
        resource: requireString(stored.resource, 'IndexedDB queue resource'),
        typeId: requireString(stored.typeId, 'IndexedDB queue type id'),
        audit: toStoredAudit(audit),
        expiryEpochMs: requireSafeInteger(
            stored.expiryEpochMs,
            'IndexedDB queue expiry timestamp (ms)'
        ),
        status: requireEntityStatus(stored.status),
        dequeueAudit: toStoredDequeueAudit(dequeueAudit),
        endEpochMs: requireSafeIntegerOrNull(
            stored.endEpochMs,
            'IndexedDB queue end timestamp (ms)'
        )
    } satisfies StoredResourceEntry;
    if (canonical.keyString !== toKeyAsString(canonical.key)) {
        throw new TypeError('IndexedDB queue row key differs from its canonical key');
    }
    return canonical;
}

function toStoredAudit(audit: IndexedDbQueueDataRecord): StoredResourceEntry['audit'] {
    return {
        date: requireString(audit.date, 'IndexedDB queue audit date'),
        createdBy: requireString(audit.createdBy, 'IndexedDB queue creator'),
        createdTs: requireString(audit.createdTs, 'IndexedDB queue creation timestamp'),
        expiryTs: requireString(audit.expiryTs, 'IndexedDB queue expiry timestamp')
    };
}

function toStoredDequeueAudit(
    dequeueAudit: IndexedDbQueueDataRecord
): StoredResourceEntry['dequeueAudit'] {
    return {
        ...(dequeueAudit.startTs === undefined
            ? {}
            : { startTs: requireString(dequeueAudit.startTs, 'IndexedDB queue start timestamp') }),
        ...(dequeueAudit.endTs === undefined
            ? {}
            : { endTs: requireString(dequeueAudit.endTs, 'IndexedDB queue end timestamp') }),
        ...(dequeueAudit.nextTs === undefined
            ? {}
            : { nextTs: requireString(dequeueAudit.nextTs, 'IndexedDB queue next timestamp') }),
        attempts: requireNonNegativeInteger(dequeueAudit.attempts, 'IndexedDB queue attempt count')
    };
}

function requireDataRecord<Value>(
    value: Value,
    label: string,
    fields: DataRecordFields
): IndexedDbQueueDataRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be a record`);
    }
    const record = value as IndexedDbQueueDataRecord;
    const permitted = new Set([...fields.required, ...(fields.optional ?? [])]);
    const keys = Object.keys(record);
    if (
        fields.required.some((key) => !Object.hasOwn(record, key)) ||
        keys.some((key) => !permitted.has(key)) ||
        Reflect.ownKeys(record).length !== keys.length
    ) {
        throw new TypeError(`${label} fields are invalid`);
    }
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} must contain only data fields`);
        }
    }
    return record;
}

function requireString(value: IndexedDbQueueDataValue, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function requireSafeInteger(value: IndexedDbQueueDataValue, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError(`${label} must be a safe integer`);
    }
    return value;
}

function requireSafeIntegerOrNull(value: IndexedDbQueueDataValue, label: string): number | null {
    return value === null ? null : requireSafeInteger(value, label);
}

function requireNonNegativeInteger(value: IndexedDbQueueDataValue, label: string): number {
    const integer = requireSafeInteger(value, label);
    if (integer < 0 || Object.is(integer, -0)) {
        throw new TypeError(`${label} must be non-negative`);
    }
    return integer;
}

function requireEntityStatus(value: IndexedDbQueueDataValue): EntityStatus {
    for (const status of Object.values(EntityStatus)) {
        if (value === status) {
            return status;
        }
    }
    throw new TypeError('IndexedDB queue status is invalid');
}
```

- [ ] **Step 5: Run the codec test again; it now passes.**

```sh
npx vitest run packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts
```

Expected: `Tests  14 passed (14)`.

- [ ] **Step 6: Run the queue and ALM suites.**

```sh
npx vitest run packages/tests/shared/queuebox packages/tests/shared/alm
npx vitest run packages/tests/shared/queuebox packages/tests/shared/alm packages/tests/shared/indexeddb-queuebox.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts packages/tests/shared-web/al-runtime
```

Expected in the scratch tree:

- first command: `Test Files  94 passed (94)` and `Tests  1208 passed (1208)`;
- second command: `Test Files  102 passed (102)` and `Tests  1305 passed (1305)`.

The totals include whatever Tasks 1–2 add, so check that nothing failed rather than matching the totals.

- [ ] **Step 7: Format the touched files and run the type gates.**

```sh
npx dprint fmt packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts packages/tests/shared/queuebox/record-temporal-parses.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
node scripts/check-tests-typecheck.mjs
```

Expected:

- `npx dprint check` on the three files exits 0.
- `tsc` exits 0.
- `deno task check` exits 0.
- `check-tests-typecheck: 1399 test files enforced, 0 files carrying known debt (0 errors).`

In the scratch worktree the script then also printed
`FAIL: new type errors in an enforced file: apps/rallar-black-box/vite.config.ts (1)`. It prints the same
line at `52cc85b32` in that worktree, because `apps/rallar-black-box/node_modules` (an app-local install)
is absent there. The failure is environmental and does not appear after `npm ci`.

- [ ] **Step 8: Commit.**

```sh
git add packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts packages/tests/shared/queuebox/record-temporal-parses.ts
git commit -m "Encode an IndexedDB queue row from the timestamps it holds, and trust the rows it froze

The codec parsed every timestamp of an entry, formatted it, and then parsed its own output
again to validate it; a computed put was decoded once more before the write. The encoder now
formats the Temporal values it already holds, derives the epoch-ms mirrors from them, and
freezes the row with those values recorded, so validating that row checks only its plain
fields. A value the encoder did not produce is still verified field by field."
```

- [ ] **Step 9: Run the changed-range gates on the commit.**

```sh
npm run check:repo-style:changed -- <branch base> HEAD
node scripts/check-test-structure-coupling.mjs --changed <branch base> HEAD
```

Expected:

- `PASS: no new repository style findings`
- `PASS: no current structure-coupled test candidates`
- `PASS: changed-range structure-coupling review has complete individual classifications`
- `PASS: registry entries are complete and current`

If `layout.directory-density` appears, a new production file was added to `packages/shared/queuebox`.
Keep the structural decode inside the codec file.

**Figures measured in the scratch tree at `33d644e90`**

Parse pins:

| Operation                                    |        Before |         After |
| -------------------------------------------- | ------------: | ------------: |
| Encode of a six-timestamp entry              |            12 |             0 |
| Put over an encoded row, plus its validation |            24 |             0 |
| A copied (untrusted) put value               | 6 (4 / 1 / 1) | 6 (unchanged) |

Survey probe (`<scratchpad>/p1-survey/probe/`, copied with its paths pointed at the tree, plus a counter
of the calls whose immediate caller is the codec file):

| Path                      | Codec calls  | All polyfill calls |
| ------------------------- | ------------ | ------------------ |
| Warm durable send         | **165 → 94** | **233 → 162**      |
| Cold send                 | 165 → 94     | 238 → 167          |
| Inbound admit and deliver | 148 → 99     | 201/204 → 152/155  |

Transaction and operation counts are unchanged; no IndexedDB access changed.

Bundles, brotli:

| Bundle         |        Before |         After |              Change | Against budget                   |
| -------------- | ------------: | ------------: | ------------------: | -------------------------------- |
| `rallar.ts`    | 233,724 bytes | 233,808 bytes | +84 (minified +604) | 228.3 of 229 KiB, 688 bytes left |
| Headless agent | 298,532 bytes | 298,926 bytes |                +394 | 291.920 of 292 KiB               |

---

### Task 4: Codec decode: one parse per field; `isStoredQueueEntryExpired` on `expiryEpochMs`; comparisons on the epoch-ms mirrors

Decision D110 (proposal §2.1 "The codec fix"; survey §C). Depends on Task 3. Prototyped in the scratch
tree as commit `bd27d5472` on Task 3's `33d644e90`, red then green; the figures below were measured there.

**What changes and why.**

- **Decode parses every timestamp twice.** `decodeStoredResourceEntry` validates the row through
  `decodeStoredResourceEntryValue`, which parses every timestamp once, then parses each one again to
  build the entry.
- **A row already read is parsed again at every later use.** A row that
  `decodeStoredResourceEntryValue` returned from a read is decoded again by each later
  `decodeStoredResourceEntry`, by `computeIndexedDbQueuePut`'s expected-state read and by the put's
  validation.
- **The time checks parse an ISO string although a mirror is stored.**
  - `isStoredQueueEntryExpired` (`indexed-db-queue-box-entry.ts:158-163`) parses `audit.expiryTs`
    although `expiryEpochMs` is stored.
  - `isStoredQueueEntryReservable` (`:184-185`) parses `dequeueAudit.nextTs` although
    `fairnessDueEpochMs` is stored.
- **The fairness reservation parses `nextTs` separately.**
  `computeIndexedDbFairnessReservation` (`compute-indexed-db-fairness-reservation.ts:51-52`) parses
  `nextTs` a second time beside its decode.

Measured with Task 3 in place:

| Operation                                    |                                                    Parses |
| -------------------------------------------- | --------------------------------------------------------: |
| Decode of a read row (six timestamps)        |                                                        12 |
| A later decode and put of that row           |                                                        18 |
| One expiry check plus one next-attempt check | 3 (the timeout check adds `startTs`, which has no mirror) |
| One fairness reservation of a read row       |                                                        14 |

After this task:

- **One parse per timestamp.** `decodeStoredResourceEntryParts` decodes the plain fields and takes the
  Temporal values either from the registry (a row the codec produced) or from
  `decodeStoredResourceEntryTimestamps`, which parses each timestamp once.
- **Decoded rows join the registry.** It freezes the canonical copy and records its values, so a row read
  once is never parsed again by a later decode, put or validation.
- **The entry is built from the parsed values.** `decodeStoredResourceEntry` builds the entry from those
  values. Each entry gets its own copy of the key, as before, because the canonical row is now frozen.
  The Temporal values themselves are immutable and may be shared.
- **Expiry and the next attempt compare the mirrors.** `isStoredQueueEntryExpired` compares
  `expiryEpochMs`, and the next-attempt check compares `fairnessDueEpochMs`, through
  `isAtOrAfterStoredInstant`.
  - The mirror is `floor(epochNanoseconds / 1e6)`: polyfill 0.5.1, `epochNsToMs(value, 'floor')`, and the
    decoder checks that the mirror equals `epochMilliseconds`.
  - So a now in another millisecond decides the comparison exactly, without a parse.
  - When now falls in the mirror's own millisecond, the check parses the stored instant, so an instant
    finer than a millisecond keeps today's exact outcome. Such an instant can arrive from a native
    Temporal clock.
  - The characterization tests pin both cases and pass before and after.
- **The fairness reservation takes its due time from the decoded entry.** Its candidates come from the
  `by-fairness` index, which holds only rows with `fairnessDueEpochMs`. The decoder ties that mirror to
  `nextTs`, so `nextTs` is always present, and the existing `!` stands.
- **Checked and left alone:**
  - `compute-indexed-db-queue-release.ts` only calls `isStoredQueueEntryExpired`, so it inherits the
    change.
  - `indexed-db-queue-box.ts:757-768` and `isStoredQueueEntryTimedOut` compare `startTs`, which has no
    mirror. They keep parsing it.
  - Every other decode in `indexed-db-queue-box.ts` now hits the registry.

Unchanged: `ResourceEntry`, `StoredResourceEntry`, the schema id, the server codec, every public signature
and every rejection message. One new runtime property: rows returned by `decodeStoredResourceEntryValue`
are frozen, as encoder rows are after Task 3.

**Files**

- Modify: `packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts`, at Task 3's lines:
  - add `interface DecodedStoredResourceEntry` after `:81`;
  - replace `decodeStoredResourceEntry` `:94-117` and `decodeStoredResourceEntryValue` `:119-125`, and add
    `decodeStoredResourceEntryParts`.
- Modify: `packages/shared/queuebox/indexed-db-queue-box-entry.ts`:
  - `:162` (the expiry check);
  - `:184-185` (the next-attempt check);
  - new `isAtOrAfterStoredInstant` before `toIndexedDbQueueExpectedState` at `:209`.
- Modify: `packages/shared/queuebox/compute-indexed-db-fairness-reservation.ts`: `:1` (type-only import)
  and `:51-52`.
- Test: Modify `packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts` (whole file
  below, 234 lines).
- Test: Create `packages/tests/shared/queuebox/indexed-db-queue-box-entry.test.ts` (95 lines).
- Test: Modify `packages/tests/shared/indexeddb-queuebox-computed-write.test.ts`:
  - imports at `:10-14` and `:34`;
  - a new test after the fairness-ordering test that ends at `:335`.

**Interfaces**

- Consumes (from Task 3, private to the codec):
  - `decodeStoredResourceEntryFields`
  - `decodeStoredResourceEntryTimestamps`
  - `freezeVerifiedStoredResourceEntry`
  - `getVerifiedTimestamps`
  - `StoredResourceEntryTimestamps`
  - the test helper `recordTemporalParses` / `NO_TEMPORAL_PARSES` in
    `packages/tests/shared/queuebox/record-temporal-parses.ts`
- Produces (public signatures unchanged):
  - `decodeStoredResourceEntry(stored: StoredResourceEntry): ResourceEntry`
  - `decodeStoredResourceEntryValue<Value>(value: Value): StoredResourceEntry`, which now returns a frozen
    row
  - `isStoredQueueEntryExpired(stored: StoredResourceEntry, now: Temporal.Instant): boolean`
  - `isStoredQueueEntryReservable(input: StoredQueueEntryReservationInput): boolean`
  - `computeIndexedDbFairnessReservation(input)`
- Private additions:
  - `interface DecodedStoredResourceEntry` with `canonical: StoredResourceEntry` and
    `timestamps: StoredResourceEntryTimestamps`
  - `decodeStoredResourceEntryParts<Value>(value: Value): DecodedStoredResourceEntry`
  - `isAtOrAfterStoredInstant(now: Temporal.Instant, epochMs: number | undefined, instant: string): boolean`

- [ ] **Step 1: Extend the codec test.** Replace
      `packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts` with the version below.
  - The import adds `decodeStoredResourceEntry`.
  - Five tests follow the frozen-row test. Three pin outcomes that hold before and after: the round
    trip, a mirror rejection on the entry decode, and a fresh key per entry. Two pin the change.
  - The `toTimestampStrings` helper is new, at the end of the file.

```ts
import { Temporal } from '@js-temporal/polyfill';
import {
    decodeStoredResourceEntry,
    decodeStoredResourceEntryValue,
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueuePut,
    validateComputedIndexedDbQueueMutations
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { NO_TEMPORAL_PARSES, recordTemporalParses } from './record-temporal-parses.ts';

describe('IndexedDB queue entry codec', () => {
    it('stores each timestamp as a canonical string beside its epoch-ms mirror', () => {
        expect(encodeStoredResourceEntry(createRetryEntry(), 3)).toEqual({
            keyString: 'topic/resource/context',
            revision: 3,
            fairnessDueEpochMs: Date.parse('2026-09-30T12:00:03.000Z'),
            key: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
            resource: '{"value":1}',
            typeId: 'WS_OUTBOX',
            audit: {
                date: '12:00:00.123',
                createdBy: 'codec-test',
                createdTs: '2026-09-30T12:00:00.123',
                expiryTs: '2026-09-30T12:05:00.123Z'
            },
            expiryEpochMs: Date.parse('2026-09-30T12:05:00.123Z'),
            status: EntityStatus.RETRY,
            dequeueAudit: {
                startTs: '2026-09-30T12:00:01Z',
                endTs: '2026-09-30T12:00:02Z',
                nextTs: '2026-09-30T12:00:03.000000001Z',
                attempts: 1
            },
            endEpochMs: Date.parse('2026-09-30T12:00:02.000Z')
        });
    });

    it('encodes timestamps given as strings to the same row', () => {
        const entry = createRetryEntry();
        const legacy = {
            ...entry,
            audit: { ...entry.audit, expiryTs: entry.audit.expiryTs.toString() as never }
        };

        expect(encodeStoredResourceEntry(legacy, 3)).toEqual(encodeStoredResourceEntry(entry, 3));
    });

    it('rejects an entry whose timestamp is not a Temporal value', () => {
        const entry = createRetryEntry();

        expect(() =>
            encodeStoredResourceEntry({
                ...entry,
                audit: { ...entry.audit, expiryTs: 42 as never }
            }, 0)
        )
            .toThrow(new TypeError('IndexedDB queue timestamp must be an instant'));
    });

    it.each([
        {
            field: 'expiry mirror',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                expiryEpochMs: stored.expiryEpochMs + 1
            }),
            message: 'IndexedDB queue expiry timestamp (ms) differs from its expiry instant'
        },
        {
            field: 'end mirror',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                endEpochMs: (stored.endEpochMs ?? 0) + 1
            }),
            message: 'IndexedDB queue end timestamp (ms) differs from its dequeue audit'
        },
        {
            field: 'fairness mirror',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                fairnessDueEpochMs: (stored.fairnessDueEpochMs ?? 0) + 1
            }),
            message: 'IndexedDB queue fairness timestamp differs from its next timestamp'
        },
        {
            field: 'key string',
            change: (stored: StoredResourceEntry) => ({
                ...stored,
                keyString: 'topic/resource/other'
            }),
            message: 'IndexedDB queue row key differs from its canonical key'
        }
    ])('rejects a row whose $field disagrees with its canonical value', ({ change, message }) => {
        const stored = change(encodeStoredResourceEntry(createRetryEntry(), 0));

        expect(() => decodeStoredResourceEntryValue(stored)).toThrow(new TypeError(message));
    });

    it('rejects a row whose timestamp string does not parse', () => {
        const stored = encodeStoredResourceEntry(createRetryEntry(), 0);

        expect(() =>
            decodeStoredResourceEntryValue({ ...stored, audit: { ...stored.audit, date: 'noon' } })
        )
            .toThrow(RangeError);
    });

    it('rejects a fabricated put whose value disagrees with its own mirror', () => {
        const put = computeIndexedDbQueuePut(undefined, createRetryEntry());
        const fabricated = {
            ...put,
            value: { ...put.value, expiryEpochMs: put.value.expiryEpochMs + 1 }
        };

        expect(validateComputedIndexedDbQueueMutations([fabricated]).left).toEqual(
            new TypeError('IndexedDB queue expiry timestamp (ms) differs from its expiry instant')
        );
    });

    it('rejects a computed put whose status is not a queue status', () => {
        const put = computeIndexedDbQueuePut(undefined, {
            ...createRetryEntry(),
            status: 'LOST' as never
        });

        expect(validateComputedIndexedDbQueueMutations([put]).left).toEqual(
            new TypeError('IndexedDB queue status is invalid')
        );
    });

    it('encodes an entry without parsing a timestamp it already holds', () => {
        const entry = createRetryEntry();

        expect(
            recordTemporalParses(() => encodeStoredResourceEntry(entry, 0)),
            'an entry already holds Temporal values, so encoding only formats them'
        ).toEqual(NO_TEMPORAL_PARSES);
    });

    it('computes and validates a put without decoding its own output', () => {
        const entry = createRetryEntry();
        const previous = encodeStoredResourceEntry(entry, 0);

        expect(
            recordTemporalParses(() =>
                validateComputedIndexedDbQueueMutations([computeIndexedDbQueuePut(previous, entry)])
            ),
            'the encoder formatted every timestamp it holds, so validating its put parses nothing'
        ).toEqual(NO_TEMPORAL_PARSES);
    });

    it('verifies every timestamp of a put value the encoder did not produce', () => {
        const put = computeIndexedDbQueuePut(undefined, createRetryEntry());
        const copied = { ...put, value: structuredClone(put.value) };

        expect(
            recordTemporalParses(() => validateComputedIndexedDbQueueMutations([copied])),
            'a copied value is untrusted, so each of its six timestamps is parsed once'
        ).toEqual({ instant: 4, plainTime: 1, plainDateTime: 1 });
    });

    it('keeps an encoded row immutable so its verified timestamps cannot drift', () => {
        const stored = encodeStoredResourceEntry(createRetryEntry(), 0);

        expect([stored, stored.key, stored.audit, stored.dequeueAudit].map(Object.isFrozen))
            .toEqual([
                true,
                true,
                true,
                true
            ]);
    });

    it('decodes a row back to the timestamps it was encoded from', () => {
        const entry = createRetryEntry();
        const decoded = decodeStoredResourceEntry(
            structuredClone(encodeStoredResourceEntry(entry, 0))
        );

        expect(toTimestampStrings(decoded)).toEqual(toTimestampStrings(entry));
        expect(decoded.db).toEqual({ id: 'topic/resource/context' });
    });

    it('rejects a read row whose mirror disagrees when it is decoded to an entry', () => {
        const stored = structuredClone(encodeStoredResourceEntry(createRetryEntry(), 0));

        expect(() =>
            decodeStoredResourceEntry({ ...stored, expiryEpochMs: stored.expiryEpochMs + 1 })
        )
            .toThrow(
                new TypeError(
                    'IndexedDB queue expiry timestamp (ms) differs from its expiry instant'
                )
            );
    });

    it('hands each decoded entry a key of its own', () => {
        const canonical = decodeStoredResourceEntryValue(
            structuredClone(encodeStoredResourceEntry(createRetryEntry(), 0))
        );
        const first = decodeStoredResourceEntry(canonical);
        const second = decodeStoredResourceEntry(canonical);

        expect(first.key).toEqual(second.key);
        expect(first.key).not.toBe(second.key);
        expect(Object.isFrozen(first.key)).toBe(false);
    });

    it('decodes a read row to an entry with one parse per timestamp', () => {
        const read = structuredClone(encodeStoredResourceEntry(createRetryEntry(), 0));

        expect(
            recordTemporalParses(() => decodeStoredResourceEntry(read)),
            'validating a read row builds the Temporal values the entry is made of, so each is parsed once'
        ).toEqual({ instant: 4, plainTime: 1, plainDateTime: 1 });
    });

    it('decodes and replaces a row it already read without parsing it again', () => {
        const entry = createRetryEntry();
        const canonical = decodeStoredResourceEntryValue(
            structuredClone(encodeStoredResourceEntry(entry, 0))
        );

        expect(
            recordTemporalParses(() => {
                decodeStoredResourceEntry(canonical);
                validateComputedIndexedDbQueueMutations([
                    computeIndexedDbQueuePut(canonical, entry)
                ]);
            }),
            'the read already parsed and checked every timestamp of this row'
        ).toEqual(NO_TEMPORAL_PARSES);
    });
});

function createRetryEntry(): ResourceEntry {
    return {
        key: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
        resource: '{"value":1}',
        typeId: 'WS_OUTBOX',
        audit: {
            date: Temporal.PlainTime.from('12:00:00.123'),
            createdBy: 'codec-test',
            createdTs: Temporal.PlainDateTime.from('2026-09-30T12:00:00.123'),
            expiryTs: Temporal.Instant.from('2026-09-30T12:05:00.123Z')
        },
        status: EntityStatus.RETRY,
        dequeueAudit: {
            startTs: Temporal.Instant.from('2026-09-30T12:00:01Z'),
            endTs: Temporal.Instant.from('2026-09-30T12:00:02Z'),
            nextTs: Temporal.Instant.from('2026-09-30T12:00:03.000000001Z'),
            attempts: 1
        }
    };
}

function toTimestampStrings(entry: ResourceEntry): readonly (string | undefined)[] {
    return [
        entry.audit.date.toString(),
        entry.audit.createdTs.toString(),
        entry.audit.expiryTs.toString(),
        entry.dequeueAudit.startTs?.toString(),
        entry.dequeueAudit.endTs?.toString(),
        entry.dequeueAudit.nextTs?.toString()
    ];
}
```

- [ ] **Step 2: Write the time-check test.** Create
      `packages/tests/shared/queuebox/indexed-db-queue-box-entry.test.ts`.
  - Three tables pin today's exact outcomes. They pass before and after:
    - a millisecond-precise expiry;
    - an expiry finer than its millisecond mirror;
    - a next attempt at nanosecond `…03.000000001Z`, which is not reservable at `…03Z`.
  - The last test pins the change.

```ts
import { Temporal } from '@js-temporal/polyfill';
import {
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    isStoredQueueEntryExpired,
    isStoredQueueEntryReservable
} from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { NO_TEMPORAL_PARSES, recordTemporalParses } from './record-temporal-parses.ts';

describe('IndexedDB queue entry time checks', () => {
    it.each([
        { now: '2026-09-30T12:05:00.122Z', expired: false },
        { now: '2026-09-30T12:05:00.122999999Z', expired: false },
        { now: '2026-09-30T12:05:00.123Z', expired: true },
        { now: '2026-09-30T12:05:00.124Z', expired: true }
    ])('expires a millisecond-precise row at $now: $expired', ({ now, expired }) => {
        const stored = createStoredRow({ expiryTs: '2026-09-30T12:05:00.123Z' });

        expect(isStoredQueueEntryExpired(stored, Temporal.Instant.from(now))).toBe(expired);
    });

    it.each([
        { now: '2026-09-30T12:05:00.123Z', expired: false },
        { now: '2026-09-30T12:05:00.1232Z', expired: false },
        { now: '2026-09-30T12:05:00.1235Z', expired: true },
        { now: '2026-09-30T12:05:00.1237Z', expired: true },
        { now: '2026-09-30T12:05:00.124Z', expired: true }
    ])(
        'expires a row whose instant is finer than its millisecond mirror at $now: $expired',
        ({ now, expired }) => {
            const stored = createStoredRow({ expiryTs: '2026-09-30T12:05:00.1235Z' });

            expect(isStoredQueueEntryExpired(stored, Temporal.Instant.from(now))).toBe(expired);
        }
    );

    it.each([
        { now: '2026-09-30T12:00:02.999Z', reservable: false },
        { now: '2026-09-30T12:00:03Z', reservable: false },
        { now: '2026-09-30T12:00:03.000000001Z', reservable: true },
        { now: '2026-09-30T12:00:03.001Z', reservable: true }
    ])('holds a retry row until its next attempt at $now: $reservable', ({ now, reservable }) => {
        const stored = createStoredRow({ nextTs: '2026-09-30T12:00:03.000000001Z' });

        expect(isStoredQueueEntryReservable({
            stored,
            typeIds: new Set(['WS_OUTBOX']),
            statusIds: new Set([EntityStatus.RETRY]),
            now: Temporal.Instant.from(now),
            maxAttempts: 3
        })).toBe(reservable);
    });

    it('compares expiry and the next attempt on the epoch-ms mirrors', () => {
        const stored = createStoredRow({ nextTs: '2026-09-30T12:00:03.000000001Z' });
        const now = Temporal.Instant.from('2026-09-30T12:00:04Z');

        expect(
            recordTemporalParses(() => {
                isStoredQueueEntryExpired(stored, now);
                isStoredQueueEntryReservable({
                    stored,
                    typeIds: new Set(['WS_OUTBOX']),
                    statusIds: new Set([EntityStatus.RETRY]),
                    now,
                    maxAttempts: 3
                });
            }),
            'a mirror in another millisecond than now decides the comparison without parsing the instant'
        ).toEqual(NO_TEMPORAL_PARSES);
    });
});

interface StoredRowTimestamps {
    readonly expiryTs?: string;
    readonly nextTs?: string;
}

function createStoredRow(timestamps: StoredRowTimestamps): StoredResourceEntry {
    const entry: ResourceEntry = {
        key: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
        resource: '{}',
        typeId: 'WS_OUTBOX',
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'entry-test',
            createdTs: Temporal.PlainDateTime.from('2026-09-30T12:00:00'),
            expiryTs: Temporal.Instant.from(timestamps.expiryTs ?? '2026-09-30T13:00:00Z')
        },
        status: EntityStatus.RETRY,
        dequeueAudit: {
            nextTs: timestamps.nextTs === undefined
                ? undefined
                : Temporal.Instant.from(timestamps.nextTs),
            attempts: 1
        }
    };
    return encodeStoredResourceEntry(entry, 0);
}
```

- [ ] **Step 3: Add the fairness pin.** In `packages/tests/shared/indexeddb-queuebox-computed-write.test.ts`:
  - add `decodeStoredResourceEntryValue,` to the codec import (between `decodeStoredResourceEntry,` and
    `encodeStoredResourceEntry,`);
  - add `import { NO_TEMPORAL_PARSES, recordTemporalParses } from './queuebox/record-temporal-parses.ts';`
    after the `vitest` import;
  - insert this test after `it('computes fairness ordering without reading the IndexedDB global', …)`,
    before the closing `});` of the `describe`:

```ts
it('reserves a fairness row it read without parsing its timestamps again', () => {
    const dueAt = Temporal.Instant.from('2026-01-01T12:00:00Z');
    const read = decodeStoredResourceEntryValue(structuredClone(encodeStoredResourceEntry({
        ...createEntry('fair', 'fair'),
        status: EntityStatus.RETRY,
        dequeueAudit: { attempts: 1, nextTs: dueAt }
    }, 0)));
    const now = dueAt.add({ seconds: 1 });

    const parses = recordTemporalParses(() => {
        const computed = computeIndexedDbFairnessReservation({
            entriesByType: new Map([['computed-write', [read]]]),
            maxAttempts: 3,
            maxToReserve: 1,
            maxToScan: 1,
            now,
            requestedTypes: ['computed-write']
        });
        expect([...computed.result.values()][0]?.selectedDueTs.equals(dueAt)).toBe(true);
    });

    expect(parses, 'the read verified the row, and its due time is the decoded next timestamp')
        .toEqual(
            NO_TEMPORAL_PARSES
        );
});
```

- [ ] **Step 4: Run the tests and watch the pins fail.**

```sh
npx vitest run packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts packages/tests/shared/queuebox/indexed-db-queue-box-entry.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts
```

Expected (measured with Task 3's sources):

```text
     × compares expiry and the next attempt on the epoch-ms mirrors
     × decodes a read row to an entry with one parse per timestamp
     × decodes and replaces a row it already read without parsing it again
     × reserves a fairness row it read without parsing its timestamps again
AssertionError: the read verified the row, and its due time is the decoded next timestamp: expected { instant: 8, plainTime: 3, …(1) } to deeply equal { instant: +0, plainTime: +0, …(1) }
AssertionError: validating a read row builds the Temporal values the entry is made of, so each is parsed once: expected { instant: 8, plainTime: 2, …(1) } to deeply equal { instant: 4, plainTime: 1, …(1) }
AssertionError: the read already parsed and checked every timestamp of this row: expected { instant: 12, plainTime: 3, …(1) } to deeply equal { instant: +0, plainTime: +0, …(1) }
AssertionError: a mirror in another millisecond than now decides the comparison without parsing the instant: expected { instant: 3, plainTime: +0, …(1) } to deeply equal { instant: +0, plainTime: +0, …(1) }
      Tests  4 failed | 46 passed (50)
```

- [ ] **Step 5: Decode with one parse per field.** In
      `packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts`:
  - add this interface directly after `interface StoredResourceEntryTimestamps { … }`:

```ts
interface DecodedStoredResourceEntry {
    readonly canonical: StoredResourceEntry;
    readonly timestamps: StoredResourceEntryTimestamps;
}
```

- replace `decodeStoredResourceEntry` and `decodeStoredResourceEntryValue` with:

```ts
export function decodeStoredResourceEntry(stored: StoredResourceEntry): ResourceEntry {
    const { canonical, timestamps } = decodeStoredResourceEntryParts(stored);
    return {
        key: { ...canonical.key },
        resource: canonical.resource,
        typeId: canonical.typeId,
        audit: {
            date: timestamps.date,
            createdBy: canonical.audit.createdBy,
            createdTs: timestamps.createdTs,
            expiryTs: timestamps.expiryTs
        },
        status: canonical.status,
        dequeueAudit: {
            startTs: timestamps.startTs,
            endTs: timestamps.endTs,
            nextTs: timestamps.nextTs,
            attempts: canonical.dequeueAudit.attempts
        },
        db: {
            id: canonical.keyString
        }
    };
}

export function decodeStoredResourceEntryValue<Value>(value: Value): StoredResourceEntry {
    return decodeStoredResourceEntryParts(value).canonical;
}

function decodeStoredResourceEntryParts<Value>(value: Value): DecodedStoredResourceEntry {
    const canonical = decodeStoredResourceEntryFields(value);
    const timestamps = getVerifiedTimestamps(value) ??
        decodeStoredResourceEntryTimestamps(canonical);
    return { canonical: freezeVerifiedStoredResourceEntry(canonical, timestamps), timestamps };
}
```

The whole codec file as committed:

```ts
import { Temporal } from '@js-temporal/polyfill';

import {
    COMPLETED_STATUSES,
    EntityStatus,
    toKeyAsString,
    type Key,
    type ResourceEntry,
    type ResourceEntryKeyString
} from './ResourceEntry.ts';

export type StoredResourceEntry = Readonly<{
    keyString: ResourceEntryKeyString;
    revision: number;
    fairnessDueEpochMs?: number;
    key: Key;
    resource: string;
    typeId: string;
    audit: Readonly<{
        date: string;
        createdBy: string;
        createdTs: string;
        expiryTs: string;
    }>;
    expiryEpochMs: number;
    status: EntityStatus;
    dequeueAudit: Readonly<{
        startTs?: string;
        endTs?: string;
        nextTs?: string;
        attempts: number;
    }>;
    /** Null only while unreleased; a completed row with no recorded release defaults to 0 so retention cleanup can still index it. */
    endEpochMs: number | null;
}>;

type IndexedDbQueueDataValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | IndexedDbQueueDataRecord
    | readonly IndexedDbQueueDataValue[];

interface IndexedDbQueueDataRecord {
    readonly [key: string]: IndexedDbQueueDataValue;
}

interface DataRecordFields {
    readonly required: readonly string[];
    readonly optional?: readonly string[];
}

const ROW_FIELDS: DataRecordFields = {
    required: [
        'keyString',
        'revision',
        'key',
        'resource',
        'typeId',
        'audit',
        'expiryEpochMs',
        'status',
        'dequeueAudit',
        'endEpochMs'
    ],
    optional: ['fairnessDueEpochMs']
};
const KEY_FIELDS: DataRecordFields = { required: ['topicId', 'resourceId', 'contextId'] };
const AUDIT_FIELDS: DataRecordFields = { required: ['date', 'createdBy', 'createdTs', 'expiryTs'] };
const DEQUEUE_AUDIT_FIELDS: DataRecordFields = {
    required: ['attempts'],
    optional: ['startTs', 'endTs', 'nextTs']
};

interface StoredResourceEntryTimestamps {
    readonly date: Temporal.PlainTime;
    readonly createdTs: Temporal.PlainDateTime;
    readonly expiryTs: Temporal.Instant;
    readonly startTs: Temporal.Instant | undefined;
    readonly endTs: Temporal.Instant | undefined;
    readonly nextTs: Temporal.Instant | undefined;
}

interface DecodedStoredResourceEntry {
    readonly canonical: StoredResourceEntry;
    readonly timestamps: StoredResourceEntryTimestamps;
}

/** Frozen rows whose timestamp strings and epoch-ms mirrors were produced from, or checked against, these values. */
const verifiedTimestamps = new WeakMap<object, StoredResourceEntryTimestamps>();

export function encodeStoredResourceEntry(
    entry: ResourceEntry,
    revision: number
): StoredResourceEntry {
    const timestamps = toStoredResourceEntryTimestamps(entry);
    return freezeVerifiedStoredResourceEntry(
        toStoredResourceEntry(entry, revision, timestamps),
        timestamps
    );
}

export function decodeStoredResourceEntry(stored: StoredResourceEntry): ResourceEntry {
    const { canonical, timestamps } = decodeStoredResourceEntryParts(stored);
    return {
        key: { ...canonical.key },
        resource: canonical.resource,
        typeId: canonical.typeId,
        audit: {
            date: timestamps.date,
            createdBy: canonical.audit.createdBy,
            createdTs: timestamps.createdTs,
            expiryTs: timestamps.expiryTs
        },
        status: canonical.status,
        dequeueAudit: {
            startTs: timestamps.startTs,
            endTs: timestamps.endTs,
            nextTs: timestamps.nextTs,
            attempts: canonical.dequeueAudit.attempts
        },
        db: {
            id: canonical.keyString
        }
    };
}

export function decodeStoredResourceEntryValue<Value>(value: Value): StoredResourceEntry {
    return decodeStoredResourceEntryParts(value).canonical;
}

function decodeStoredResourceEntryParts<Value>(value: Value): DecodedStoredResourceEntry {
    const canonical = decodeStoredResourceEntryFields(value);
    const timestamps = getVerifiedTimestamps(value) ??
        decodeStoredResourceEntryTimestamps(canonical);
    return { canonical: freezeVerifiedStoredResourceEntry(canonical, timestamps), timestamps };
}

function toStoredResourceEntryTimestamps(entry: ResourceEntry): StoredResourceEntryTimestamps {
    const expiryTs = toInstant(entry.audit.expiryTs);
    const endTs = toOptionalInstant(entry.dequeueAudit.endTs);
    const nextTs = toOptionalInstant(entry.dequeueAudit.nextTs);
    return {
        date: toPlainTime(entry.audit.date),
        createdTs: toPlainDateTime(entry.audit.createdTs),
        expiryTs,
        startTs: toOptionalInstant(entry.dequeueAudit.startTs),
        endTs,
        nextTs
    };
}

function toStoredResourceEntry(
    entry: ResourceEntry,
    revision: number,
    timestamps: StoredResourceEntryTimestamps
): StoredResourceEntry {
    const { expiryTs, endTs, nextTs } = timestamps;
    return {
        keyString: toKeyAsString(entry.key),
        revision,
        fairnessDueEpochMs: toOptionalEpochMs(nextTs),
        key: { ...entry.key },
        resource: entry.resource,
        typeId: entry.typeId,
        audit: {
            date: timestamps.date.toString(),
            createdBy: entry.audit.createdBy,
            createdTs: timestamps.createdTs.toString(),
            expiryTs: expiryTs.toString()
        },
        expiryEpochMs: Number(expiryTs.epochMilliseconds),
        status: entry.status,
        dequeueAudit: {
            startTs: timestamps.startTs?.toString(),
            endTs: endTs?.toString(),
            nextTs: nextTs?.toString({ fractionalSecondDigits: 9 }),
            attempts: entry.dequeueAudit.attempts
        },
        endEpochMs: toExpectedEndEpochMs(entry.status, endTs)
    };
}

function decodeStoredResourceEntryTimestamps(
    stored: StoredResourceEntry
): StoredResourceEntryTimestamps {
    const date = toPlainTime(stored.audit.date);
    const createdTs = toPlainDateTime(stored.audit.createdTs);
    const expiryTs = toInstant(stored.audit.expiryTs);
    if (stored.expiryEpochMs !== Number(expiryTs.epochMilliseconds)) {
        throw new TypeError(
            'IndexedDB queue expiry timestamp (ms) differs from its expiry instant'
        );
    }
    const startTs = toOptionalInstant(stored.dequeueAudit.startTs);
    const endTs = toOptionalInstant(stored.dequeueAudit.endTs);
    if (stored.endEpochMs !== toExpectedEndEpochMs(stored.status, endTs)) {
        throw new TypeError('IndexedDB queue end timestamp (ms) differs from its dequeue audit');
    }
    const nextTs = toOptionalInstant(stored.dequeueAudit.nextTs);
    if (stored.fairnessDueEpochMs !== toOptionalEpochMs(nextTs)) {
        throw new TypeError('IndexedDB queue fairness timestamp differs from its next timestamp');
    }
    return { date, createdTs, expiryTs, startTs, endTs, nextTs };
}

function freezeVerifiedStoredResourceEntry(
    stored: StoredResourceEntry,
    timestamps: StoredResourceEntryTimestamps
): StoredResourceEntry {
    Object.freeze(stored.key);
    Object.freeze(stored.audit);
    Object.freeze(stored.dequeueAudit);
    verifiedTimestamps.set(Object.freeze(stored), timestamps);
    return stored;
}

function getVerifiedTimestamps<Value>(value: Value): StoredResourceEntryTimestamps | undefined {
    return typeof value === 'object' && value !== null ? verifiedTimestamps.get(value) : undefined;
}

/**
 * A completed row that never passed through release (e.g. a canonical entry admitted
 * already-COMPLETED) has no dequeueAudit.endTs. Defaulting it to 0 instead of null keeps the
 * row indexable by `by-status-end`: IndexedDB drops a compound-index record when any key
 * component is null, which would hide such rows from retention cleanup forever.
 */
function toExpectedEndEpochMs(
    status: EntityStatus,
    endTs: Temporal.Instant | undefined
): number | null {
    if (endTs !== undefined) {
        return Number(endTs.epochMilliseconds);
    }
    return COMPLETED_STATUSES.has(status) ? 0 : null;
}

function toOptionalEpochMs(instant: Temporal.Instant | undefined): number | undefined {
    return instant === undefined ? undefined : Number(instant.epochMilliseconds);
}

function toPlainTime(value: string | Temporal.PlainTime): Temporal.PlainTime {
    if (value instanceof Temporal.PlainTime) {
        return value;
    }
    if (typeof value !== 'string') {
        throw new TypeError('IndexedDB queue audit date must be a plain time');
    }
    return Temporal.PlainTime.from(value);
}

function toPlainDateTime(value: string | Temporal.PlainDateTime): Temporal.PlainDateTime {
    if (value instanceof Temporal.PlainDateTime) {
        return value;
    }
    if (typeof value !== 'string') {
        throw new TypeError('IndexedDB queue creation timestamp must be a plain date-time');
    }
    return Temporal.PlainDateTime.from(value);
}

function toInstant(value: string | Temporal.Instant): Temporal.Instant {
    if (value instanceof Temporal.Instant) {
        return value;
    }
    if (typeof value !== 'string') {
        throw new TypeError('IndexedDB queue timestamp must be an instant');
    }
    return Temporal.Instant.from(value);
}

function toOptionalInstant(
    value: string | Temporal.Instant | undefined
): Temporal.Instant | undefined {
    return value === undefined ? undefined : toInstant(value);
}

function decodeStoredResourceEntryFields<Value>(value: Value): StoredResourceEntry {
    const stored = requireDataRecord(value, 'IndexedDB queue row', ROW_FIELDS);
    const key = requireDataRecord(stored.key, 'IndexedDB queue key', KEY_FIELDS);
    const audit = requireDataRecord(stored.audit, 'IndexedDB queue audit', AUDIT_FIELDS);
    const dequeueAudit = requireDataRecord(
        stored.dequeueAudit,
        'IndexedDB queue dequeue audit',
        DEQUEUE_AUDIT_FIELDS
    );
    const canonical = {
        keyString: requireString(stored.keyString, 'IndexedDB queue key string'),
        revision: requireNonNegativeInteger(stored.revision, 'IndexedDB queue revision'),
        ...(stored.fairnessDueEpochMs === undefined
            ? {}
            : {
                fairnessDueEpochMs: requireSafeInteger(
                    stored.fairnessDueEpochMs,
                    'IndexedDB queue fairness timestamp'
                )
            }),
        key: {
            topicId: requireString(key.topicId, 'IndexedDB queue topic id'),
            resourceId: requireString(key.resourceId, 'IndexedDB queue resource id'),
            contextId: requireString(key.contextId, 'IndexedDB queue context id')
        },
        resource: requireString(stored.resource, 'IndexedDB queue resource'),
        typeId: requireString(stored.typeId, 'IndexedDB queue type id'),
        audit: toStoredAudit(audit),
        expiryEpochMs: requireSafeInteger(
            stored.expiryEpochMs,
            'IndexedDB queue expiry timestamp (ms)'
        ),
        status: requireEntityStatus(stored.status),
        dequeueAudit: toStoredDequeueAudit(dequeueAudit),
        endEpochMs: requireSafeIntegerOrNull(
            stored.endEpochMs,
            'IndexedDB queue end timestamp (ms)'
        )
    } satisfies StoredResourceEntry;
    if (canonical.keyString !== toKeyAsString(canonical.key)) {
        throw new TypeError('IndexedDB queue row key differs from its canonical key');
    }
    return canonical;
}

function toStoredAudit(audit: IndexedDbQueueDataRecord): StoredResourceEntry['audit'] {
    return {
        date: requireString(audit.date, 'IndexedDB queue audit date'),
        createdBy: requireString(audit.createdBy, 'IndexedDB queue creator'),
        createdTs: requireString(audit.createdTs, 'IndexedDB queue creation timestamp'),
        expiryTs: requireString(audit.expiryTs, 'IndexedDB queue expiry timestamp')
    };
}

function toStoredDequeueAudit(
    dequeueAudit: IndexedDbQueueDataRecord
): StoredResourceEntry['dequeueAudit'] {
    return {
        ...(dequeueAudit.startTs === undefined
            ? {}
            : { startTs: requireString(dequeueAudit.startTs, 'IndexedDB queue start timestamp') }),
        ...(dequeueAudit.endTs === undefined
            ? {}
            : { endTs: requireString(dequeueAudit.endTs, 'IndexedDB queue end timestamp') }),
        ...(dequeueAudit.nextTs === undefined
            ? {}
            : { nextTs: requireString(dequeueAudit.nextTs, 'IndexedDB queue next timestamp') }),
        attempts: requireNonNegativeInteger(dequeueAudit.attempts, 'IndexedDB queue attempt count')
    };
}

function requireDataRecord<Value>(
    value: Value,
    label: string,
    fields: DataRecordFields
): IndexedDbQueueDataRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be a record`);
    }
    const record = value as IndexedDbQueueDataRecord;
    const permitted = new Set([...fields.required, ...(fields.optional ?? [])]);
    const keys = Object.keys(record);
    if (
        fields.required.some((key) => !Object.hasOwn(record, key)) ||
        keys.some((key) => !permitted.has(key)) ||
        Reflect.ownKeys(record).length !== keys.length
    ) {
        throw new TypeError(`${label} fields are invalid`);
    }
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${label} must contain only data fields`);
        }
    }
    return record;
}

function requireString(value: IndexedDbQueueDataValue, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function requireSafeInteger(value: IndexedDbQueueDataValue, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError(`${label} must be a safe integer`);
    }
    return value;
}

function requireSafeIntegerOrNull(value: IndexedDbQueueDataValue, label: string): number | null {
    return value === null ? null : requireSafeInteger(value, label);
}

function requireNonNegativeInteger(value: IndexedDbQueueDataValue, label: string): number {
    const integer = requireSafeInteger(value, label);
    if (integer < 0 || Object.is(integer, -0)) {
        throw new TypeError(`${label} must be non-negative`);
    }
    return integer;
}

function requireEntityStatus(value: IndexedDbQueueDataValue): EntityStatus {
    for (const status of Object.values(EntityStatus)) {
        if (value === status) {
            return status;
        }
    }
    throw new TypeError('IndexedDB queue status is invalid');
}
```

- [ ] **Step 6: Compare expiry and the next attempt on the mirrors.** In
      `packages/shared/queuebox/indexed-db-queue-box-entry.ts`:
  - make the body of `isStoredQueueEntryExpired`:

```ts
return isAtOrAfterStoredInstant(now, stored.expiryEpochMs, stored.audit.expiryTs);
```

- end `isStoredQueueEntryReservable` with:

```ts
return !stored.dequeueAudit.nextTs ||
    isAtOrAfterStoredInstant(now, stored.fairnessDueEpochMs, stored.dequeueAudit.nextTs);
```

- add before `function toIndexedDbQueueExpectedState(`:

```ts
/** An epoch-ms mirror is its instant floored to the millisecond, so only a tie needs the instant itself. */
function isAtOrAfterStoredInstant(
    now: Temporal.Instant,
    epochMs: number | undefined,
    instant: string
): boolean {
    const nowMs = Number(now.epochMilliseconds);
    if (epochMs === undefined || nowMs === epochMs) {
        return Temporal.Instant.compare(now, Temporal.Instant.from(instant)) >= 0;
    }
    return nowMs > epochMs;
}
```

- [ ] **Step 7: Take the fairness due time from the decoded entry.** In
      `packages/shared/queuebox/compute-indexed-db-fairness-reservation.ts`:
  - change line 1 to `import type { Temporal } from '@js-temporal/polyfill';`;
  - replace

```ts
const selectedDueTs = Temporal.Instant.from(stored.dequeueAudit.nextTs!);
const entry = computeReservedQueueEntry(decodeStoredResourceEntry(stored), input.now);
```

with

```ts
const decoded = decodeStoredResourceEntry(stored);
const selectedDueTs = decoded.dequeueAudit.nextTs!;
const entry = computeReservedQueueEntry(decoded, input.now);
```

- [ ] **Step 8: Run the tests again; they now pass.**

```sh
npx vitest run packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts packages/tests/shared/queuebox/indexed-db-queue-box-entry.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts
```

Expected: `Test Files  3 passed (3)`, `Tests  50 passed (50)`.

- [ ] **Step 9: Run the wider suites.**

```sh
npx vitest run packages/tests/shared/queuebox packages/tests/shared/alm
npx vitest run packages/tests/shared/queuebox packages/tests/shared/alm packages/tests/shared/indexeddb-queuebox.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts packages/tests/shared-web/al-runtime
npx vitest run packages/tests/shared/ packages/tests/shared-web/
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
```

Expected in the scratch tree:

| Command | Test files       | Tests              |
| ------- | ---------------- | ------------------ |
| First   | 95 passed (95)   | 1227 passed (1227) |
| Second  | 103 passed (103) | 1325 passed (1325) |
| Third   | 451 passed (451) | 4843 passed (4843) |
| Fourth  | —                | 1 passed (1)       |

Use the trailing slashes in the third command: `packages/tests/shared` without one also matches
`shared-test` and `shared-server`, whose loopback and Postgres tests fail under the sandbox.

- [ ] **Step 10: Format the touched files and run the type gates.**

```sh
npx dprint fmt packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts packages/shared/queuebox/indexed-db-queue-box-entry.ts packages/shared/queuebox/compute-indexed-db-fairness-reservation.ts packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts packages/tests/shared/queuebox/indexed-db-queue-box-entry.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
node scripts/check-tests-typecheck.mjs
```

Expected:

- `npx dprint check` on the six files exits 0.
- `tsc` exits 0.
- `deno task check` exits 0.
- `check-tests-typecheck: 1400 test files enforced, 0 files carrying known debt (0 errors).`

The same environmental `apps/rallar-black-box/vite.config.ts` line as in Task 3 appears in a worktree
without `apps/rallar-black-box/node_modules`.

- [ ] **Step 11: Commit.**

```sh
git add packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts packages/shared/queuebox/indexed-db-queue-box-entry.ts packages/shared/queuebox/compute-indexed-db-fairness-reservation.ts packages/tests/shared/queuebox/indexed-db-queue-box-entry-codec.test.ts packages/tests/shared/queuebox/indexed-db-queue-box-entry.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts
git commit -m "Decode an IndexedDB queue row with one parse per timestamp, and compare on its epoch-ms mirrors

Decoding a row validated every timestamp and then parsed each one again to build the entry;
a row already read was verified again on every later decode and put. The decoder now builds
the entry from the Temporal values its validation produced and records them with the frozen
canonical row, so a row read once is not parsed again. Expiry and the next-attempt check
compare the stored epoch-ms mirrors and read the instant only when now falls in the mirror's
millisecond, and a fairness reservation takes its due time from the decoded entry."
```

- [ ] **Step 12: Run the changed-range gates on the commit.**

```sh
npm run check:repo-style:changed -- <branch base> HEAD
node scripts/check-test-structure-coupling.mjs --changed <branch base> HEAD
```

Expected:

- `PASS: no new repository style findings`
- the three structure-coupling `PASS` lines from Task 3, Step 9

- [ ] **Step 13: Measure the per-send figure and the bundles, and record them for Task 8.**
  - Copy the probe from `<scratchpad>/p1-survey/probe/` into a scratch folder and point it at the tree:
    replace the checkout path in `instrument.ts`, `vitest.probe.config.ts`, `outbound.probe.ts` and
    `inbound.probe.ts`.
  - Add a counter to `countT` in `instrument.ts`:
    `if (/queuebox\/indexed-db-queue-box-entry-codec\.ts/.test(caller)) codec.calls += 1;`. Reset it in
    `start()` and print `CODEC calls=` in `report()`.
  - Run the probe, then run the bundle measure with `TMPDIR` pointed at a private directory, so that a
    concurrent session cannot overwrite the output.

```sh
npx vitest run --config <probe dir>/vitest.probe.config.ts
TMPDIR=<private dir> npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

Expected:

- warm send: `CODEC calls=50` and `TEMPORAL total=112`;
- inbound: `CODEC calls=40` and `TEMPORAL total=90` (93 on the alternating rounds);
- `Bundle budget check passed.`

**Figures measured in the scratch tree at `bd27d5472`**

Parse pins:

| Operation                                                  | Before |                 After |
| ---------------------------------------------------------- | -----: | --------------------: |
| Decode of a read row                                       |     12 | 6 (one per timestamp) |
| A later decode and put of that row                         |     18 |                     0 |
| Expiry plus next-attempt check, now in another millisecond |      3 |                     0 |
| Fairness reservation of a read row                         |     14 |                     0 |

Survey probe (codec calls are those whose immediate caller is the codec file):

| Path                      | Codec calls, before → after Task 3 → after Task 4 | All polyfill calls, same stages |
| ------------------------- | ------------------------------------------------- | ------------------------------- |
| Warm durable send         | **165 → 94 → 50**                                 | **233 → 162 → 112**             |
| Cold send                 | 165 → 94 → 50                                     | 238 → 167 → 117                 |
| Inbound admit and deliver | 148 → 99 → 40                                     | 201/204 → 152/155 → 90/93       |

What remains in the warm send's codec count is irreducible:

- the parse of the five rows the send reads from IndexedDB (`PlainTime.from` 5, `PlainDateTime.from` 5,
  `Instant.from` 8);
- the formatting and mirror getters of the five rows it writes.

`isAtOrAfterStoredInstant` costs one `epochMilliseconds` getter per check (6 per send); these sit outside
the codec count.

Bundles, brotli:

| Bundle                                           | `52cc85b32` |  Task 3 |  Task 4 |     Change over both tasks | Budget                                 |
| ------------------------------------------------ | ----------: | ------: | ------: | -------------------------: | -------------------------------------- |
| `rallar.ts`                                      |     233,724 | 233,808 | 233,968 | +244 bytes (minified +694) | 228.5 of 229 KiB, **528 bytes left**   |
| Headless agent (the test's own esbuild settings) |     298,532 | 298,926 | 298,822 |                 +290 bytes | 291.818 of 292 KiB, **186 bytes left** |

If a later task crosses a budget, the standing ruling applies: raise it to the next whole KiB and record
the figure.

---

### Task 5: The decision read merged with the commit's observation read for a single send; the group path keeps its own observation read

Decision D108 (proposal §1.4, §2.1; survey §A.2 transactions #1 and #3, §D row 1). A single durable
send decides inside its decision read session. That session also reads the effect row its bundle
writes and answers the canonical pair from the rows the decision read already holds. The commit
takes that observation and opens only the D17 fence snapshot and the readwrite. The fence snapshot
(#4) and the write (#5) are unchanged. A group (`commitAll` with ≥ 2 members) keeps its N decision
reads and its own observation read in `commitBundles`. `commitBundle(bundle)` without an
observation (repair, receipt and control callers, and every test spy that forwards only the
bundle) still reads its own observation first.

Measured with the survey probe (fake-indexeddb, warm send 2..4, identical each run):

| Figure (warm durable send)                                |              Before |     After |
| --------------------------------------------------------- | ------------------: | --------: |
| chain: transactions from `enqueueIfAbsent` to the carrier |                  11 |        10 |
| total transactions until the release commits              |                  14 |        13 |
| requests                                                  |                  46 |        44 |
| `al-admission` operations                                 |                  10 |        10 |
| `al-work` operations                                      |                  12 |        10 |
| cold (the pinned shape): `al-admission` + `al-work`       |             10 + 15 |   10 + 13 |
| cold transactions / requests                              |             21 / 52 |   20 / 50 |
| inbound admit-and-deliver (tx, `al-admission`, `al-work`) | 11 or 13, 8, 5 or 7 | unchanged |

The merged decision read (#1) now issues 10 gets: `version`, `sent`, `pending-ack`,
`repair-attempt`, `control:acks`, `control:nacks`, `control:repairs`, then the work rows
`AL_OUTBOUND_MESSAGE/…`, `AL_OUTBOUND_IDENTITY/…` and the effect slot `AL_OUTBOUND/<ns>/send-…`.
The old #3 (effect slot, canonical, identity) is gone.

**Files**

- Create: `packages/shared/alm/outbound/admission/al-outbound-decision-read-session.ts` (33 lines)
- Modify: `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts`:
  - imports `:70-71`;
  - `ALOutboundCommitObservation` `:117-120`, now exported, plus two new types;
  - the interface `:267-272` and `:307-309`;
  - `readOutgoingMessage` `:410-414` gains a sibling;
  - `commitBundle` / `commitBundles` `:463-506`;
  - a predicate before `assertALOutboundBundleGroup` `:656`.
- Modify: `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts`:
  - imports `:9-14`;
  - `commitDispatchOnce` `:271-295`;
  - `readDispatchDecision` `:297-306`;
  - `readDispatch` `:475-498`.
- Modify: `packages/shared/alm/outbound/README.md` `:104`, `:126-131`, `:551`
- Modify: `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` `:161-164`
- Test: `packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts`:
  - imports `:12`, `:20-35`;
  - pin `:77-83`;
  - the fixture `:85-88`;
  - tests `:194-205` and `:259`;
  - a helper before `:385`.
- Test: `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` `:217-234` (the cold pin: 15 → 13)
- Test: `packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts` `:20-21`. It relied on
  `commitBundle` delegating to `commitBundles`, which a single send with an observation no longer
  does. The semantics are unchanged: both handoff attempts conflict.
- Test (Task 1's): `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts`, whose pins
  are lowered.

The whole change as committed in the prototype is in
`/private/tmp/claude-501/-Users-knuthelge-ProjectLocker-github-ar-eye-hunter/dbbbec19-0da0-4f14-a05d-3a007089fcf4/scratchpad/p1-plan/task-5.patch`
(`git format-patch` of scratch commit `f30ffecc9` on `52cc85b32`). Every hunk below is taken from it.

**Interfaces**

Consumes:

- `ALAdmissionWorkBackend.readWithin<T>(read: (session: ALAdmissionReadSession) => Promise<T>): Promise<T>`
  (`packages/shared/alm/al-admission-work-backend.ts:35`). The IndexedDB session reopens a snapshot
  when the previous one ended, so no caller depends on one transaction lasting.
- `ALOutboundAdmissionReads.readOutgoingMessage(session, input)` (`admission/al-outbound-admission-reads.ts:115`)
- `ALOutboundAdmissionEffectStore.readEffects(session, effects, canonicalEntry?)` (`admission/al-outbound-admission-effect-store.ts:82`)
- `readALOutboundCanonicalWrites` (`al-outbound-canonical-storage.ts:117`) through the store's private `readCanonicalWrites`

Produces (in `al-outbound-admission-store.ts`):

```ts
/** What one bundle's commit fences: the effect rows it may replace and the canonical pair it may write. */
export interface ALOutboundCommitObservation<TPrepared> {
    readonly effects: readonly ALOutboundEffectObservation<TPrepared>[];
    readonly canonicalWrites: readonly ALOutboundCanonicalFactWrite[];
}

/** What a single send decided on its decision surface: `commit` names the bundle its commit writes. */
export type ALOutboundOutgoingDecision<TPrepared> =
    | Readonly<{ kind: 'settled'; }>
    | Readonly<{ kind: 'commit'; bundle: ALOutboundCommitBundle<TPrepared>; }>;

/** A single send's decision, and the observation its commit fences when that commit writes. */
export interface ALOutboundObservedDecision<TPrepared, TDecision> {
    readonly decision: TDecision;
    readonly observation: ALOutboundCommitObservation<TPrepared> | undefined;
}

// ALOutboundAdmissionStore<TPrepared> gains:
readonly readOutgoingDecision: <TDecision extends ALOutboundOutgoingDecision<TPrepared>>(
    input: ALOutboundOutgoingReadInput<TPrepared>,
    decide: (read: ALOutboundMessageReadDto<TPrepared>) => Promise<TDecision>
) => Promise<ALOutboundObservedDecision<TPrepared, TDecision>>;
// and commitBundle takes the observation its decision read holds:
readonly commitBundle: (
    bundle: ALOutboundCommitBundle<TPrepared>,
    observation?: ALOutboundCommitObservation<TPrepared>
) => Promise<'committed' | 'conflict' | 'expired'>;
```

and `export class ALOutboundDecisionReadSession implements ALAdmissionReadSession` (constructor
`(session: ALAdmissionReadSession)`). `commitBundles(bundles)` keeps its signature and its own
observation read. Task 6 (W5) consumes the same `commitBundle` and `readWorkSnapshot`; Task 7
touches the same store file (`readReceiptState`/`isMessageSuperseded`, `:423-449`), which this
task does not change.

Global constraints (copied): no guarantee change, and every existing semantic test holds. No schema
bump, no migration, no new dependency, no worker. No comments in source except an essential
invariant, and never a plan, decision, task or PR id in code. Pins only fall, lowered in the same
commit with the reason in the assertion message. Run dprint only on touched files. Functions stay
at ≤ 40 lines, with canonical verbs, an `Either` for expected failure, and ≤ 3 positional
parameters. Never `git stash`, never push, never `db:*`.

- [ ] **Step 1: Write the failing tests.** Apply these test-only hunks: the transactions test, the
      cold pin, and the RTC spy. The RTC spy change passes before and after; it is here because the
      implementation removes the delegation that its `commitBundles` spy relied on.

```diff
diff --git a/packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts b/packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts
index 402a2c502..ab543d269 100644
--- a/packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts
+++ b/packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts
@@ -9,7 +9,10 @@ import {
     vi
 } from 'vitest';
 
-import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
+import {
+    createTestALOutboundControlAdmission,
+    createTestALOutboundWorkPort
+} from '@shared-test/shared/create-test-al-outbound-work-port.ts';
 import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
 import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
 import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
@@ -20,15 +23,21 @@ import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-da
 import {
     createALOutboundAdmissionStore,
     type ALOutboundAdmissionStore,
+    type ALOutboundCommitBundle,
+    type ALOutboundMessageReadDto,
     type ALOutboundPlanner
 } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
+import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
 import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
+import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
 import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
 import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
+import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
 
 import {
     computeOutboundTestAdmission,
     createDefaultOutboundTestRuntime,
+    createOutboundCanonicalEntry,
     createOutboundMessage
 } from '../outbound-runtime-test-fixture.ts';
 import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';
@@ -75,18 +84,49 @@ const AUTHORITY_BREAKING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg)
 };
 
 /**
- * What an admission that reaches its commit costs: the decision surface, then the write phase's own
- * snapshot, then the conditional write. The second readonly is not a duplicate of the first — a
- * fence re-read has to observe a store state later than the surface it is fencing, so it can see a
- * commit that landed in between.
+ * What the commit of a single send costs: the write phase's own snapshot, then the conditional write.
+ * Its decision read already holds the effect rows and the canonical pair the commit fences, so the
+ * commit opens no observation read of its own (it did until the two reads merged: three became two).
+ * The snapshot is not a duplicate of the decision read — a fence re-read has to observe a store
+ * state later than the surface it is fencing, so it can see a commit that landed in between.
+ */
+const COMMITTING_ADMISSION_TRANSACTIONS: readonly IDBTransactionMode[] = ['readonly', 'readwrite'];
+
+/**
+ * A commit that holds no observation reads one first: a group, whose members decide in reads of
+ * their own, and a bundle handed to `commitBundle` alone.
  */
-const COMMITTING_ADMISSION_TRANSACTIONS: readonly IDBTransactionMode[] = ['readonly', 'readonly', 'readwrite'];
+const OBSERVING_ADMISSION_TRANSACTIONS: readonly IDBTransactionMode[] = [
+    'readonly',
+    ...COMMITTING_ADMISSION_TRANSACTIONS
+];
 
 interface AdmissionTransactionFixture {
     readonly store: ALOutboundAdmissionStore<OutboundTestPayload>;
     readonly backend: IndexedDbAdmissionBackend;
 }
 
+/** The single-send and group commit of the runtime, without the worker that would claim what it commits. */
+function createTransactionDispatchAdmission(
+    { store, backend }: AdmissionTransactionFixture
+): ALOutboundDispatchAdmission<OutboundTestPayload> {
+    return new ALOutboundDispatchAdmission<OutboundTestPayload>({
+        lane: 'durable',
+        admissionStore: store,
+        workPort: createTestALOutboundWorkPort({ admissionStore: store, workQueue: backend.workQueue, nowMs: Date.now }),
+        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
+        decodePreparedMessage: decodeOutboundTestPayload,
+        clock: { nowMs: Date.now },
+        browserLocks: undefined,
+        diagnostics: undefined,
+        settlements: () => {}
+    });
+}
+
+function toSendDispatch(msg: ALMessage): ALOutboundDispatchAdmission.Input<OutboundTestPayload> {
+    return { msg, intent: 'enqueue', phase: 'immediate', origin: 'send', options: {}, planner: SEND_PLANNER };
+}
+
 async function createAdmissionFixture(name: string): Promise<AdmissionTransactionFixture> {
     const backend = createTransactionBackend(name);
     const store = createTransactionAdmissionStore(backend);
@@ -191,19 +231,84 @@ it('reads a re-admitted supersedence-tracked message from one readonly transacti
     expect(recorded.modes()).toEqual(['readonly']);
 });
 
-it('commits one bundle with one read snapshot, one fence snapshot and one write', async () => {
+it('commits a bundle handed over alone with its own read snapshot, one fence snapshot and one write', async () => {
     const { store } = await createAdmissionFixture('commit-bundle');
     const bundle = await computeOutboundTestAdmission(store, createOutboundMessage('commit-bundle'), SEND_PLANNER);
 
     const recorded = recordIndexedDbTransactions();
     expect(await store.commitBundle(bundle)).toBe('committed');
 
-    expect(recorded.modes()).toEqual(COMMITTING_ADMISSION_TRANSACTIONS);
+    expect(recorded.modes()).toEqual(OBSERVING_ADMISSION_TRANSACTIONS);
     // Each one starts on an unlocked store: the write phase's fence snapshot is closed before the
     // conditional write is created, so the readwrite never queues behind an idle readonly.
     expect(recorded.liveWhenOpened()).toEqual([0, 0, 0]);
 });
 
+it('reads a single send decision and the observation its commit fences from one readonly transaction', async () => {
+    const { store } = await createAdmissionFixture('single-send-decision');
+    const message = createOutboundMessage('single-send-decision');
+
+    const recorded = recordIndexedDbTransactions();
+    const { decision, observation } = await store.readOutgoingDecision({
+        msg: message,
+        planner: SEND_PLANNER,
+        observedCanonicalEntry: undefined,
+        intent: 'enqueue'
+    }, async (read) => ({ kind: 'commit', bundle: toTestBundle(store, read) }));
+
+    expect(recorded.modes()).toEqual(['readonly']);
+    // The effect row the commit writes, observed empty, and the canonical pair it writes beside it.
+    expect(observation?.effects.map((effect) => [effect.effect.effectId, effect.existing])).toEqual([
+        [decision.bundle.durableEffects[0]!.effectId, undefined]
+    ]);
+    expect(observation?.canonicalWrites.map((write) => write.expected)).toEqual([undefined, undefined]);
+});
+
+it('commits a single send with its decision read, one fence snapshot and one write', async () => {
+    const fixture = await createAdmissionFixture('single-send');
+    const admission = createTransactionDispatchAdmission(fixture);
+
+    const recorded = recordIndexedDbTransactions();
+    const result = await admission.commit(toSendDispatch(createOutboundMessage('single-send')));
+
+    expect(result.committed).toBe(true);
+    expect(recorded.modes()).toEqual(['readonly', ...COMMITTING_ADMISSION_TRANSACTIONS]);
+    expect(recorded.liveWhenOpened()).toEqual([0, 0, 0]);
+    admission.dispose();
+});
+
+it('commits a group of two sends with an observation read of its own after both decision reads', async () => {
+    const fixture = await createAdmissionFixture('group-send');
+    const admission = createTransactionDispatchAdmission(fixture);
+
+    const recorded = recordIndexedDbTransactions();
+    const results = await admission.commitAll([
+        toSendDispatch(createOutboundMessage('group-send-first')),
+        toSendDispatch(createOutboundMessage('group-send-second'))
+    ]);
+
+    expect(results.map((result) => result.committed)).toEqual([true, true]);
+    // One decision read per member, then the group's one observation of both bundles, then one commit.
+    expect(recorded.modes()).toEqual(['readonly', 'readonly', ...OBSERVING_ADMISSION_TRANSACTIONS]);
+    admission.dispose();
+});
+
+it('conflicts a single send whose canonical row was written after its decision read observed it empty', async () => {
+    const { store, backend } = await createAdmissionFixture('held-observation');
+    const message = createOutboundMessage('held-observation');
+    const { decision, observation } = await store.readOutgoingDecision({
+        msg: message,
+        planner: SEND_PLANNER,
+        observedCanonicalEntry: undefined,
+        intent: 'enqueue'
+    }, async (read) => ({ kind: 'commit', bundle: toTestBundle(store, read) }));
+
+    // Written without an admission, so the sender version the commit also fences does not move.
+    await backend.workQueue.enqueue(createOutboundCanonicalEntry(store, message));
+
+    expect(await store.commitBundle(decision.bundle, observation)).toBe('conflict');
+});
+
 it('closes the fence snapshot of a commit that conflicts inside its own write phase', async () => {
     const { store } = await createAdmissionFixture('commit-conflict');
     const message = createOutboundMessage('commit-conflict');
@@ -256,7 +361,8 @@ it('reads a control decision surface from one readonly transaction before its wr
     const recorded = recordIndexedDbTransactions();
     expect((await control.admit(ack, 'peer')).kind).toBe('committed');
 
-    expect(recorded.modes()).toEqual(COMMITTING_ADMISSION_TRANSACTIONS);
+    // Its decision surface, then the commit.
+    expect(recorded.modes()).toEqual(OBSERVING_ADMISSION_TRANSACTIONS);
 });
 
 it('leaves an expired work row where a session read found it, for the queue sweep to remove', async () => {
@@ -382,6 +488,24 @@ describe('control sends committed as one outbound admission', () => {
     );
 });
 
+function toTestBundle(
+    store: ALOutboundAdmissionStore<OutboundTestPayload>,
+    read: ALOutboundMessageReadDto<OutboundTestPayload>
+): ALOutboundCommitBundle<OutboundTestPayload> {
+    const computed = computeALOutboundDispatch({
+        read,
+        outboxEntry: createOutboundCanonicalEntry(store, read.msg),
+        dispatchAtMs: Date.now(),
+        intent: 'enqueue',
+        phase: 'immediate',
+        options: {}
+    });
+    if (!computed.bundle) {
+        throw new Error(`Expected outbound admission, received ${computed.verdict.kind}`);
+    }
+    return computed.bundle;
+}
+
 /** The outbound owner of a receiver, ready, so the measured window holds the admission and nothing of start-up. */
 async function createControlSendRuntime(
     storage: 'memory' | 'indexeddb',
diff --git a/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts b/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
index db96211ca..f143af63e 100644
--- a/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
+++ b/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
@@ -214,7 +214,7 @@ describe('outbound work owner IndexedDB scan volume', () => {
 });
 
 describe('outbound default send IndexedDB volume', () => {
-    it('sends one durable message in 10 al-admission and 15 al-work operations', async () => {
+    it('sends one durable message in 10 al-admission and 13 al-work operations', async () => {
         const observer = createCountingIndexedDbOperationObserver();
         const runtime = createDefaultOutboundTestRuntime({
             stores: createIndexedDbOutboundCountStores(observer, 'outbound-default-send'),
@@ -229,7 +229,10 @@ describe('outbound default send IndexedDB volume', () => {
         const counts = observer.getCounts();
         // These figures protect the default send's admission and work I/O budget.
         expect(counts.byOwner['al-admission'], 'one default send spends 10 al-admission operations today').toBe(10);
-        expect(counts.byOwner['al-work'], 'one default send spends 15 al-work operations today').toBe(15);
+        expect(
+            counts.byOwner['al-work'],
+            'one default send spends 13 al-work operations: its decision read holds the effect row and canonical pair its commit fences, so the commit re-reads neither'
+        ).toBe(13);
         runtime.dispose();
     });
 });
diff --git a/packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts b/packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts
index ea6bd3122..9a4e31910 100644
--- a/packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts
+++ b/packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts
@@ -17,8 +17,10 @@ afterEach(() => {
 it('retries the inbound ACK owner when RTC control handoff conflicts', async () => {
     vi.useFakeTimers({ toFake: ['Date'] });
     const { receiver, sender } = createConnectedEndpoints();
-    vi.spyOn(receiver.outbound.admissionStore, 'commitBundles').mockResolvedValueOnce('conflict');
-    vi.spyOn(receiver.outbound.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
+    // The handoff and its one retry both conflict; a single send commits through `commitBundle` alone.
+    vi.spyOn(receiver.outbound.admissionStore, 'commitBundle')
+        .mockResolvedValueOnce('conflict')
+        .mockResolvedValueOnce('conflict');
     vi.spyOn(receiver.outbound.admissionStore, 'retainPendingAdmission')
         .mockResolvedValue('conflict');
     const message = newALUnicastMessage(
```

- [ ] **Step 2: Run the tests and see them fail.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts
```

Expected (measured, 4 failed | 49 passed):

```text
   × reads a single send decision and the observation its commit fences from one readonly transaction
   × commits a single send with its decision read, one fence snapshot and one write
   × conflicts a single send whose canonical row was written after its decision read observed it empty
     × sends one durable message in 10 al-admission and 13 al-work operations
AssertionError: one default send spends 13 al-work operations: its decision read holds the effect row and canonical pair its commit fences, so the commit re-reads neither: expected 15 to be 13 // Object.is equality
TypeError: store.readOutgoingDecision is not a function
AssertionError: expected [ 'readonly', 'readonly', …(2) ] to deeply equal [ 'readonly', 'readonly', 'readwrite' ]
TypeError: store.readOutgoingDecision is not a function
 Test Files  2 failed | 1 passed (3)
      Tests  4 failed | 49 passed (53)
```

The group test (`commits a group of two sends with an observation read of its own after both
decision reads`) passes already. It is the guard that the group path keeps its observation read:
`['readonly', 'readonly', 'readonly', 'readonly', 'readwrite']`.

- [ ] **Step 3: Create the decision read session** at
      `packages/shared/alm/outbound/admission/al-outbound-decision-read-session.ts`:

```ts
import { toKeyAsString, type Key, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALAdmissionBackendEntry } from '../../al-admission-backend.ts';
import type { ALAdmissionDecoder } from '../../al-admission-decoder.ts';
import type { ALAdmissionReadSession } from '../../al-admission-work-backend.ts';

/**
 * The read session of one single-send decision. A work row it already read answers again from that
 * read, so the observation its commit fences re-reads nothing the decision surface holds; the write
 * re-reads every observed row inside its fence, so a held row is never trusted past that fence.
 */
export class ALOutboundDecisionReadSession implements ALAdmissionReadSession {
    readonly #session: ALAdmissionReadSession;
    readonly #workReads = new Map<string, Promise<ResourceEntry | undefined>>();

    constructor(session: ALAdmissionReadSession) {
        this.#session = session;
    }

    read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        return this.#session.read(key, decode);
    }

    list<V>(
        prefix: string,
        decode: ALAdmissionDecoder<V>
    ): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        return this.#session.list(prefix, decode);
    }

    readWork(key: Key): Promise<ResourceEntry | undefined> {
        const keyString = toKeyAsString(key);
        const held = this.#workReads.get(keyString) ?? this.#session.readWork(key);
        this.#workReads.set(keyString, held);
        return held;
    }
}
```

Why a held read and not a field on the read DTO: when the caller supplies an
`observedCanonicalEntry` (dequeue), the decision read never read the canonical row from the store.
A DTO field could not tell that apart. The session reuses only rows it actually read, and the
write's canonical re-read (`writeALOutboundCanonicalFacts`) and `validateObservedWork` still
compare every observation inside the readwrite.

- [ ] **Step 4: Change the admission store** (`packages/shared/alm/outbound/admission/al-outbound-admission-store.ts`).
      The hunks, exactly as committed:

```diff
diff --git a/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts b/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
index fe6813365..639366ea5 100644
--- a/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
+++ b/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
@@ -69,6 +69,7 @@ import {
 } from './al-outbound-admission-mutations.ts';
 import { ALOutboundAdmissionReads } from './al-outbound-admission-reads.ts';
 import type { ALOutboundCapturedPolicy, ALStoredOutboundMessage } from './al-outbound-admission-validation.ts';
+import { ALOutboundDecisionReadSession } from './al-outbound-decision-read-session.ts';
 
 export interface CreateALOutboundAdmissionStoreInput<TPrepared> {
     readonly nowMs: () => number;
@@ -114,11 +115,23 @@ export interface ALOutboundOutgoingReadInput<TPrepared> {
     readonly intent: ALOutboundComputeIntent;
 }
 
-interface ALOutboundCommitObservation<TPrepared> {
+/** What one bundle's commit fences: the effect rows it may replace and the canonical pair it may write. */
+export interface ALOutboundCommitObservation<TPrepared> {
     readonly effects: readonly ALOutboundEffectObservation<TPrepared>[];
     readonly canonicalWrites: readonly ALOutboundCanonicalFactWrite[];
 }
 
+/** What a single send decided on its decision surface: `commit` names the bundle its commit writes. */
+export type ALOutboundOutgoingDecision<TPrepared> =
+    | Readonly<{ kind: 'settled'; }>
+    | Readonly<{ kind: 'commit'; bundle: ALOutboundCommitBundle<TPrepared>; }>;
+
+/** A single send's decision, and the observation its commit fences when that commit writes. */
+export interface ALOutboundObservedDecision<TPrepared, TDecision> {
+    readonly decision: TDecision;
+    readonly observation: ALOutboundCommitObservation<TPrepared> | undefined;
+}
+
 interface ALOutboundCommitCandidate<TPrepared> {
     readonly executionExpiresAtMs: number | null;
     readonly bundle: ALOutboundCommitBundle<TPrepared>;
@@ -268,6 +281,16 @@ export interface ALOutboundAdmissionStore<TPrepared> extends ALReadyable {
         input: ALOutboundOutgoingReadInput<TPrepared>
     ) => Promise<ALOutboundMessageReadDto<TPrepared>>;
 
+    /**
+     * One session for a single send: the decision surface, the decision `decide` takes on it, and the
+     * observation the commit of that decision fences. A group decides member by member and reads
+     * its observation in `commitBundles`.
+     */
+    readonly readOutgoingDecision: <TDecision extends ALOutboundOutgoingDecision<TPrepared>>(
+        input: ALOutboundOutgoingReadInput<TPrepared>,
+        decide: (read: ALOutboundMessageReadDto<TPrepared>) => Promise<TDecision>
+    ) => Promise<ALOutboundObservedDecision<TPrepared, TDecision>>;
+
     /** Admission-store read round trips issued so far, so a commit can report its own read cost. */
     readonly getReadOperationCount: () => number;
 
@@ -304,8 +327,10 @@ export interface ALOutboundAdmissionStore<TPrepared> extends ALReadyable {
     /** Decodes one claimed work row of this scope, including the canonical message its payload references. */
     readonly readWorkSnapshot: (entry: ResourceEntry) => Promise<ALOutboundEffectSnapshot<TPrepared>>;
 
+    /** Without the `observation` its decision read already holds, the commit reads its own first. */
     readonly commitBundle: (
-        bundle: ALOutboundCommitBundle<TPrepared>
+        bundle: ALOutboundCommitBundle<TPrepared>,
+        observation?: ALOutboundCommitObservation<TPrepared>
     ) => Promise<'committed' | 'conflict' | 'expired'>;
 
     /** Commits bundles decided against one read of the version of one sender under one version fence. */
@@ -413,6 +438,20 @@ class ProviderBackedALOutboundAdmissionStore<TPrepared> implements ALOutboundAdm
         return await this.backend.readWithin((session) => this.reads.readOutgoingMessage(session, input));
     }
 
+    async readOutgoingDecision<TDecision extends ALOutboundOutgoingDecision<TPrepared>>(
+        input: ALOutboundOutgoingReadInput<TPrepared>,
+        decide: (read: ALOutboundMessageReadDto<TPrepared>) => Promise<TDecision>
+    ): Promise<ALOutboundObservedDecision<TPrepared, TDecision>> {
+        return await this.backend.readWithin(async (backendSession) => {
+            const session = new ALOutboundDecisionReadSession(backendSession);
+            const decision = await decide(await this.reads.readOutgoingMessage(session, input));
+            const observation = decision.kind === 'commit' && hasALOutboundBundleWrites(decision.bundle)
+                ? await this.readCommitObservation(session, decision.bundle)
+                : undefined;
+            return { decision, observation };
+        });
+    }
+
     async readRepairMessage(
         msgId: string,
         planner: ALOutboundPlanner<TPrepared>
@@ -460,8 +499,16 @@ class ProviderBackedALOutboundAdmissionStore<TPrepared> implements ALOutboundAdm
         return await this.effectStore.readWorkSnapshot(entry);
     }
 
-    async commitBundle(bundle: ALOutboundCommitBundle<TPrepared>): Promise<'committed' | 'conflict' | 'expired'> {
-        return await this.commitBundles([bundle]);
+    async commitBundle(
+        bundle: ALOutboundCommitBundle<TPrepared>,
+        observation?: ALOutboundCommitObservation<TPrepared>
+    ): Promise<'committed' | 'conflict' | 'expired'> {
+        if (observation === undefined) {
+            return await this.commitBundles([bundle]);
+        }
+        return hasALOutboundBundleWrites(bundle)
+            ? await this.commitObserved([bundle], [observation], this.nowMs())
+            : 'committed';
     }
 
     /**
@@ -474,7 +521,7 @@ class ProviderBackedALOutboundAdmissionStore<TPrepared> implements ALOutboundAdm
         bundles: readonly ALOutboundCommitBundle<TPrepared>[]
     ): Promise<'committed' | 'conflict' | 'expired'> {
         assertALOutboundBundleGroup(bundles);
-        const writing = bundles.filter((bundle) => bundle.mutations.length > 0 || bundle.durableEffects.length > 0);
+        const writing = bundles.filter(hasALOutboundBundleWrites);
         if (writing.length === 0) {
             return 'committed';
         }
@@ -488,13 +535,29 @@ class ProviderBackedALOutboundAdmissionStore<TPrepared> implements ALOutboundAdm
         const observed = await this.backend.readWithin(async (session) => {
             const reads: ALOutboundCommitObservation<TPrepared>[] = [];
             for (const bundle of writing) {
-                reads.push({
-                    effects: await this.effectStore.readEffects(session, bundle.durableEffects, bundle.canonicalEntry),
-                    canonicalWrites: await this.readCanonicalWrites(session, bundle)
-                });
+                reads.push(await this.readCommitObservation(session, bundle));
             }
             return reads;
         });
+        return await this.commitObserved(writing, observed, nowMs);
+    }
+
+    private async readCommitObservation(
+        session: ALAdmissionReadSession,
+        bundle: ALOutboundCommitBundle<TPrepared>
+    ): Promise<ALOutboundCommitObservation<TPrepared>> {
+        return {
+            effects: await this.effectStore.readEffects(session, bundle.durableEffects, bundle.canonicalEntry),
+            canonicalWrites: await this.readCanonicalWrites(session, bundle)
+        };
+    }
+
+    /** `writing` is one non-empty group, each bundle paired with the observation at its index. */
+    private async commitObserved(
+        writing: readonly ALOutboundCommitBundle<TPrepared>[],
+        observed: readonly ALOutboundCommitObservation<TPrepared>[],
+        nowMs: number
+    ): Promise<'committed' | 'conflict' | 'expired'> {
         const candidates = writing.map((bundle, index) => this.computeCommitCandidate(bundle, observed[index]!, nowMs));
         if (this.hasExpiredWork(candidates)) {
             return 'expired';
@@ -653,6 +716,10 @@ class ProviderBackedALOutboundAdmissionStore<TPrepared> implements ALOutboundAdm
     }
 }
 
+function hasALOutboundBundleWrites<TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>): boolean {
+    return bundle.mutations.length > 0 || bundle.durableEffects.length > 0;
+}
+
 /** Every bundle of one group was decided against the same read of the version of one sender. */
 function assertALOutboundBundleGroup<TPrepared>(bundles: readonly ALOutboundCommitBundle<TPrepared>[]): void {
     const [first] = bundles;
```

- [ ] **Step 5: Change the dispatch admission** (`packages/shared/alm/outbound/al-outbound-dispatch-admission.ts`).
      A single send (`commitDispatchOnce`) decides inside `readOutgoingDecision` and hands the
      observation to `commitBundle`. A group member (`readDispatchDecision`) keeps
      `readOutgoingMessage`. Both paths share `decideDispatch`: the pending-admission probe, compute,
      validate and log. The hunks, exactly as committed:

```diff
diff --git a/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts b/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts
index c0e461660..822742cb0 100644
--- a/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts
+++ b/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts
@@ -9,6 +9,9 @@ import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
 import type {
     ALOutboundAdmissionStore,
     ALOutboundCommitBundle,
+    ALOutboundMessageReadDto,
+    ALOutboundObservedDecision,
+    ALOutboundOutgoingReadInput,
     ALOutboundPlanner,
     ALOutboundPreparedMessageDecoder
 } from './admission/al-outbound-admission-store.ts';
@@ -272,13 +275,13 @@ export class ALOutboundDispatchAdmission<TPrepared> {
         dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
         phases: ALOutboundCommitPhases
     ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
-        const decision = await this.readDispatchDecision(dispatch, phases);
+        const { decision, observation } = await this.readObservedDispatchDecision(dispatch, phases);
         if (decision.kind === 'settled') {
             return decision.result;
         }
 
         const { input, computed, bundle } = decision;
-        const status = await phases.withCommitPhase(() => this.admissionStore.commitBundle(bundle));
+        const status = await phases.withCommitPhase(() => this.admissionStore.commitBundle(bundle, observation));
         if (status === 'conflict' && dispatch.intent === 'enqueue' && !dispatch.options.pendingAdmission) {
             const retained = await this.retainPendingDispatch(input, computed, phases);
             if (this.isInitialControlHandoff(dispatch) && retained.computed.verdict.kind === 'failed') {
@@ -294,7 +297,26 @@ export class ALOutboundDispatchAdmission<TPrepared> {
         return result;
     }
 
-    /** Everything one dispatch decides before its write: the read, its retained pending admission, compute and validate. */
+    /** A single send decides inside its decision read, so that read also holds what its commit fences. */
+    private async readObservedDispatchDecision(
+        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
+        phases: ALOutboundCommitPhases
+    ): Promise<ALOutboundObservedDecision<TPrepared, ALOutboundDispatchDecision<TPrepared>>> {
+        if (this.disposed) {
+            return {
+                decision: { kind: 'settled', result: ALOutboundDispatchAdmission.toDisposedResult() },
+                observation: undefined
+            };
+        }
+        return await phases.withReadPhase(() =>
+            this.admissionStore.readOutgoingDecision(
+                this.toOutgoingReadInput(dispatch),
+                (read) => this.decideDispatch(dispatch, this.toDispatchInput(dispatch, read))
+            )
+        );
+    }
+
+    /** One group member's decision; the group reads the observation of every bundle in its own commit. */
     private async readDispatchDecision(
         dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
         phases: ALOutboundCommitPhases
@@ -302,8 +324,18 @@ export class ALOutboundDispatchAdmission<TPrepared> {
         if (this.disposed) {
             return { kind: 'settled', result: ALOutboundDispatchAdmission.toDisposedResult() };
         }
-        const input = await phases.withReadPhase(() => this.readDispatch(dispatch));
-        const pending = await phases.withReadPhase(() => this.readPendingDispatch(input));
+        return await phases.withReadPhase(async () => {
+            const read = await this.admissionStore.readOutgoingMessage(this.toOutgoingReadInput(dispatch));
+            return await this.decideDispatch(dispatch, this.toDispatchInput(dispatch, read));
+        });
+    }
+
+    /** Everything one dispatch decides on its read: its retained pending admission, compute and validate. */
+    private async decideDispatch(
+        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
+        input: ComputeALOutboundDispatchInput<TPrepared>
+    ): Promise<ALOutboundDispatchDecision<TPrepared>> {
+        const pending = await this.readPendingDispatch(input);
         if (pending) {
             return toALOutboundSettledDecision(pending.verdict, {
                 msg: input.read.msg,
@@ -472,16 +504,22 @@ export class ALOutboundDispatchAdmission<TPrepared> {
         };
     }
 
-    private async readDispatch(
+    private toOutgoingReadInput(
         dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
-    ): Promise<ComputeALOutboundDispatchInput<TPrepared>> {
-        const read = await this.admissionStore.readOutgoingMessage({
+    ): ALOutboundOutgoingReadInput<TPrepared> {
+        return {
             msg: dispatch.msg,
             planner: dispatch.planner,
             observedCanonicalEntry: dispatch.options.observedOutboxEntry,
             dequeueAuthority: dispatch.dequeueAuthority,
             intent: dispatch.intent
-        });
+        };
+    }
+
+    private toDispatchInput(
+        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
+        read: ALOutboundMessageReadDto<TPrepared>
+    ): ComputeALOutboundDispatchInput<TPrepared> {
         const entry = read.canonicalEntry ?? this.dependencies.toOutboxEntry(read.msg);
         return {
             read,
```

- [ ] **Step 6: Run the focused tests and see them pass.**

```sh
npx dprint fmt packages/shared/alm/outbound/admission/al-outbound-decision-read-session.ts packages/shared/alm/outbound/admission/al-outbound-admission-store.ts packages/shared/alm/outbound/al-outbound-dispatch-admission.ts packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts
npx vitest run packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts
```

Expected: `Tests  53 passed (53)`. Under the sandbox dprint also prints `Error saving incremental
file … Operation not permitted`. That is its cache, not a failure: `npx dprint check <files>` exits 0.

- [ ] **Step 7: Lower the ledger pins** in Task 1's
      `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts`, warm outbound send only.
      Change each literal and put the reason in each assertion message:
  - chain 11 → 10;
  - total 14 → 13;
  - requests 46 → 44;
  - `al-work` 12 → 10;
  - `al-admission` stays 10.

  The reason string is: `"a single send's decision read also reads the effect row its commit
  writes and holds the canonical pair, so the commit opens no observation read (−1 transaction,
  −2 al-work, −2 requests)"`. The inbound pins do not move; the probe measured them unchanged.

  This step was **not run in the prototype**: the ledger test did not exist on `52cc85b32`. The
  figures come from the survey probe copied to `<scratchpad>/p1-plan/probe-4/`, which
  `summarize()` extends:

```text
==== WARM second send                   (before: 52cc85b32)
SUMMARY tx-before-carrier=12 readiness-probes-before-carrier=1 chain=11 total=14 requests=46
COUNTS {"total":22,"byOwner":{"al-admission":10,"al-work":12},"byKind":{"read":9,"work-page":1,"work-read":7,"write":1,"work-probe":2,"work-reserve":1,"work-release":1}}
==== WARM second send                   (after: f30ffecc9; sends 3 and 4 identical)
SUMMARY tx-before-carrier=11 readiness-probes-before-carrier=1 chain=10 total=13 requests=44
COUNTS {"total":20,"byOwner":{"al-admission":10,"al-work":10},"byKind":{"read":9,"work-page":1,"work-read":5,"write":1,"work-probe":2,"work-reserve":1,"work-release":1}}
==== COLD (pinned test shape)            (after)
SUMMARY tx-before-carrier=18 readiness-probes-before-carrier=1 chain=17 total=20 requests=50
COUNTS {"total":23,"byOwner":{"al-admission":10,"al-work":13},...}
```

Run: `npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts`.
Expected: it fails on today's figures before Step 4, and passes after.

- [ ] **Step 8: Update the navigation docs.** `packages/shared/alm/outbound/README.md` gets the
      cold figure, the new session in the admission directory, the single-send and group read
      sessions, and the group's observation read. `runtime-diagnostic-contract.md` records that a
      single send's `readDurationMs` now also covers the effect-row read and the decision. The hunks:

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
index c7ac8f298..c9835a001 100644
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -160,8 +160,9 @@ every session the page opens. The event's `data` is the event itself:
   that sent it, and a lane's commits can be counted apart from the rest
 - `commit-phases` splits what `browser-lock-hold` measures as one number:
   `readDurationMs` and `readOperationCount` for the admission read chain
-  (`readOutgoingMessage` plus the pending-admission probe, and the
-  admission-store round trips observed while they ran), then
+  (`readOutgoingMessage` plus the pending-admission probe and the decision;
+  for a single send also the effect rows its commit fences, read in the same
+  session; and the admission-store round trips observed while they ran), then
   `commitDurationMs` and `commitOutcome` for the write transaction —
   `committed`, `conflict`, `expired`, or `not-attempted` when the admission
   settled before opening one
diff --git a/packages/shared/alm/outbound/README.md b/packages/shared/alm/outbound/README.md
index 089f66f3c..ed13fb83b 100644
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -101,7 +101,7 @@ every server message keeps its one backend.
 
 The storage cost is pinned in
 [`al-indexeddb-operation-counts.test.ts`](../../../tests/shared/alm/al-indexeddb-operation-counts.test.ts):
-one durable send spends 10 `al-admission` and 15 `al-work` IndexedDB operations, unchanged by S3a; one
+one durable send spends 10 `al-admission` and 13 `al-work` IndexedDB operations; one
 volatile send beside a durable pair spends 0 `al-admission` and 0 non-probe `al-work` operations. The
 idle durable owner's probes (`work-page`, `work-probe`) are reported beside that zero, never inside it
 (D55): a cold runtime's first volatile send runs the durable owner's one-time bootstrap batch over an
@@ -124,17 +124,24 @@ guards that write carries, and applies it inside the transaction;
 [`al-outbound-admission-keys.ts`](./admission/al-outbound-admission-keys.ts) owns
 every admission key string;
 [`ALOutboundAdmissionEffectStore`](./admission/al-outbound-admission-effect-store.ts)
-owns durable effect rows; and
+owns durable effect rows;
+[`ALOutboundDecisionReadSession`](./admission/al-outbound-decision-read-session.ts)
+is the read session of a single send's decision, which answers a work row it already read from that
+read; and
 [`al-outbound-admission-validation.ts`](./admission/al-outbound-admission-validation.ts)
 decodes the persisted snapshots. Every fence — the sender version, the pending-admission
 row, an observed effect row, and a moved supersedence observation — resolves a conflict
 the same way: the guard throws `ALAdmissionBackendConflictError` inside the transaction so
 the backend aborts without writing, leaving every row at the revision and write token it
 already had, and the store catches it at its public boundary and returns the typed
-`'conflict'` result. Only a write conflicts. A read chain's expiry eviction that finds its row
-moved by another writer leaves the row to that writer and answers from its snapshot (the inbound
-README's decision-surface section), so `ALOutboundControlAdmission.admit` never loses an
-acknowledgement to a throw out of `readControlAdmission` or its effect read.
+`'conflict'` result. A single send (`readOutgoingDecision`) reads its decision surface, decides on
+it, and reads the effect rows and canonical pair its bundle's commit fences in one readonly session,
+so its commit opens only the write phase's fence snapshot and the write; `commitBundle` without that
+observation, and a group's `commitBundles`, read it in a readonly session of their own first. Every
+observation is re-read inside the write, however old it is. Only a write conflicts. A read chain's
+expiry eviction that finds its row moved by another writer leaves the row to that writer and answers
+from its snapshot (the inbound README's decision-surface section), so `ALOutboundControlAdmission.admit`
+never loses an acknowledgement to a throw out of `readControlAdmission` or its effect read.
 
 ## Canonical message storage
 
@@ -548,7 +555,8 @@ which hands it to WS, where the shared budget admits it.
 `enqueueAllIfAbsent` admits one sender's messages as one group. `ALOutboundDispatchAdmission.commitAll`
 takes one sender-queue slot and one browser lock for an ordinary data group. Canonical initial
 controls bypass those waits and use the same optimistic group commit; a mixed group settles each
-member alone. Each member uses the single-message decision. `commitBundles` fences the sender version once, runs every
+member alone. Each member uses the single-message decision in a read of its own; `commitBundles` then reads
+every bundle's effect rows and canonical pair in one observation read, fences the sender version once, runs every
 bundle's own pending, effect, observation and identity fences, writes every bundle and bumps the version
 once. The group falls back when a member settles before its write (it fails validation, finds its own
 pending admission, or has nothing to commit), when a version moved between the members' reads, when two
```

- [ ] **Step 9: Run the constraint checks.** The outputs below were measured in the prototype:

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit          # exit 0
node scripts/check-tests-typecheck.mjs                      # "1398 test files enforced, 0 files carrying known debt"
npx dprint check <the eight touched files>                  # exit 0
npx vitest run packages/tests/shared/alm packages/tests/shared-web/al-runtime packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts
                                                            # Test Files 94 passed (94); Tests 1167 passed (1167)
npx vitest run --project unit                               # sandbox off; see below
npx vitest run --project tooling                            # Test Files 110 passed (110); Tests 1434 passed (1434)
cd apps/api-v1 && deno task check                           # exit 0 (the store also serves the Postgres backend)
```

Notes on those outputs:

- `packages/tests/shared-web/al-runtime` holds 6 files:
  - `browser-al-runtime-cleanup-validation`;
  - `browser-al-runtime-ownership`;
  - `browser-al-runtime-stores`;
  - `browser-al-storage-reset`;
  - `browser-outbound-cleanup`;
  - `browser-session-inbound-store`.
- Other shared-web files that name al-runtime, all green in the `unit` run:
  - `websocket/ws-durable-owner-recovery`, `websocket/ws-retained-work-fault`,
    `websocket/create-browser-web-socket-queue-box`;
  - `rtc/rtc-durable-owner-recovery`, `rtc/initialise-browser-rtc-runtime`;
  - `messages/browser-message-tracked-receipt`, `state-read/rtc-authority-recovery`,
    `session/browser-auth-session-cleanup`, `calls/browser-call-signal-runtime`,
    `connection/initialise-browser-middleware`, `director/director-command-storage-volume`.
- The `unit` run in the prototype gave 4 failed files out of 1322, none from this change:
  - `rtc-control-handoff-recovery` was the spy change of Step 1, now green.
  - `rallar-black-box/control-bootstrap` and `recipe-console-build-boundary` failed with
    `Cannot find package '@vitejs/plugin-react'`: the scratch tree's symlinked `node_modules` has no
    app-local packages.
  - `group-presence-summary-storage-revision` passed on rerun.
- `check-tests-typecheck` reports the same environment gap as
  `FAIL: new type errors in an enforced file: apps/rallar-black-box/vite.config.ts (1)`.
  `tsc -p packages/tests/tsconfig.json` shows it is TS2307 for `@vitejs/plugin-react`, and no error
  is in a touched file. In a real worktree with `npm ci` both pass.

- [ ] **Step 10: Commit.**

```sh
git add packages/shared/alm/outbound/admission/al-outbound-decision-read-session.ts \
  packages/shared/alm/outbound/admission/al-outbound-admission-store.ts \
  packages/shared/alm/outbound/al-outbound-dispatch-admission.ts \
  packages/shared/alm/outbound/README.md \
  packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md \
  packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts \
  packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts \
  packages/tests/shared/webrtc/rtc-control-handoff-recovery.test.ts \
  packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
git commit -m "Read a single send's commit observation inside its decision read

A single durable send now decides inside its decision read session, which
also reads the effect row its bundle writes and answers the canonical pair
from the rows that read already holds. The commit takes that observation and
opens only its fence snapshot and write. A group keeps its own observation
read in commitBundles, and commitBundle without an observation reads one.

Warm send: 11 -> 10 transactions before the carrier, 14 -> 13 in all,
12 -> 10 al-work operations. Cold pin: 15 -> 13 al-work."
```

- [ ] **Step 11: Run the changed-range gates on the commit.**

```sh
npm run check:repo-style:changed -- 52cc85b32 HEAD
node scripts/check-test-structure-coupling.mjs --changed 52cc85b32 HEAD
```

Expected (measured):

```text
PASS: no new repository style findings (52cc85b3224142bef4d404285ae6d7c97d979729 -> HEAD).
PASS: no current structure-coupled test candidates
PASS: changed-range structure-coupling review has complete individual classifications
PASS: registry entries are complete and current
```

When Tasks 1 to 4 sit below this commit, use the commit before this task as the base.

---

### Task 6: The committed canonical message handed to dispatch in memory

Decision D108 (lever "hand the committed canonical message to dispatch in memory"); survey §A.2 row #10
and §D row 3; proposal §1.4 and §2.1. Prototyped in `<scratchpad>/p1-plan/scratch-5` as commit
`64ecc81d6` on `52cc85b32` (Task 5 not applied there: every count below is measured relative to
`52cc85b32`, and the pin figures are restated for a tree where Task 5 has landed).

**What changes.** After a commit, the durable lane records the canonical row the commit wrote for
each `send-prepared` effect of the bundle, keyed by that effect's work slot (`toALOutboundWorkKey
(namespace, effectId)`, one slot per effect id). The claim takes it (`takeCanonical`) and hands it to
`readWorkSnapshot`, which checks it against the claimed row's reference exactly as it checks a stored
pair (the existing in-memory candidate path, `decodeALOutboundCanonicalMessage` over a synthesized
identity entry) and skips the IndexedDB session (transaction #10: 2 `work-read`s). The hand-off is a
cache of an immutable row, never a source:

- a miss reads storage as before: another tab's claim, a reload, a replayed pending admission (its
  commit goes through `ALOutboundDispatchAdmission` directly, not the lane), a retried claim (the
  entry is consumed by the first take), a foreign dequeue row;
- a row at or past its deadline reads storage too (`reference.expiresAtMs > nowMs` guards the hit),
  because a stored row reads as absent there (`isStoredQueueEntryExpired` is `now >= expiry`, and the
  identity row expires exactly at `reference.expiresAtMs`), so the expiry path is byte-for-byte the
  old one;
- bounded to `AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT = 4 * AL_OUTBOUND_WORK_PAGE_SIZE = 64` entries,
  oldest dropped first (insertion-ordered `Map`);
- dropped on `dispose()` of the lane and when the IndexedDB pair's database is reset
  (`ALStorageResetListeners`, notified from the backend's `onStorageReset` port in
  `createIndexedDbALOutboundRuntimeStores`, beside the diagnostics sink);
- owned by the durable lane only: the runtime gives the volatile (memory pair) lane
  `canonicalHandoff: undefined` (D54).

**Why the bound is 64.** One claiming batch reserves at most `AL_OUTBOUND_WORK_PAGE_SIZE` (16) rows.
In the steady state the claim that follows a commit consumes its entry at once, so the hand-off holds
0 to a few entries (one per prepared copy). Entries accumulate only when commits outrun claims (a
burst, a multicast with many prepared copies, a batch in flight) or when another tab claims. Four
pages absorbs a burst of four batches' worth of sends before any claim misses, and caps the memory at
64 retained canonical rows (each one `ResourceEntry` whose `resource` is the message's JSON; several
prepared copies of one message share one object). Past the bound the oldest entry is dropped and its
claim reads storage, which is only slower.

**Measured (probe `<scratchpad>/p1-plan/probe-5`, warm sends 2..4 identical):**

| Tree                   | chain (enqueue→carrier) | total tx | requests | `al-admission` | `al-work` | cold `al-work` pin |
| ---------------------- | ----------------------: | -------: | -------: | -------------: | --------: | -----------------: |
| `52cc85b32` (base)     |                      11 |       14 |       46 |             10 |        12 |                 15 |
| + Task 6 (`64ecc81d6`) |                      10 |       13 |       44 |             10 |        10 |                 13 |
| delta                  |                      −1 |       −1 |       −2 |              0 |        −2 |                 −2 |

Projected onto the plan's sequence (Task 5 first): chain 10 → **9**, total 13 → **12**, `al-work`
10 → **8**, requests (Task 5's figure) − 2, cold `al-work` (Task 5's figure, expected 13) − 2 → **11**.
Inbound ledger unchanged (11/13 tx, 8 `al-admission`, 5/7 `al-work`, same as the survey).
Bundle: `browser/rallar.ts` brotli 228.2 → 228.5 KiB (budget < 229.0); the headless bundle boundary
test passes.

**Files**

- Create: `packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts` (62 lines)
- Create: `packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts`
- Modify: `packages/shared/alm/open-indexed-db-admission-database.ts` (after
  `createPassThroughALStorageResetSink`, ~line 50: `ALStorageResetListeners`)
- Modify: `packages/shared/alm/al-runtime-stores.ts` (`createIndexedDbALOutboundRuntimeStores`,
  ~lines 158–190; import block ~line 25)
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (`ALOutboundRuntimeStores`
  ~line 167; `ALOutboundMessageRuntime.Resources` ~line 321; the two `new ALOutboundStoreLane` calls
  ~lines 410–431; imports)
- Modify: `packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts`
  (`createDefaultALOutboundRuntimeResources`, ~line 112)
- Modify: `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts` (Input ~line 53; fields ~line
  75; constructor end ~line 109; `dispose` ~line 116; `commit` / `commitAll` ~lines 126–151;
  `readOutboundWork` ~line 260)
- Modify: `packages/shared/alm/outbound/admission/al-outbound-admission-effect-store.ts`
  (`readWorkSnapshot` ~lines 101–107; `readWorkCanonicalMessage` / `readReferencedMessage` ~lines
  188–216)
- Modify: `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts` (interface member
  `readWorkSnapshot` ~line 304; implementation ~line 459)
- Modify: `packages/shared/alm/outbound/control/al-outbound-control-admission.ts:281`
- Modify: `packages/shared/alm/outbound/README.md` ("Canonical message storage", after the
  "Superseding messages retain separate canonical payloads" paragraph, ~line 165)
- Test call sites of `readWorkSnapshot` (second argument `undefined`):
  `packages/tests/api-v1/psql-admission-work.test.ts:285`,
  `packages/tests/shared-server/integration/postgres/al-admission-queue-work.test.ts:559`,
  `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts:369`,
  `packages/tests/shared/al-indexeddb-runtime-stores.test.ts:705`,
  `packages/tests/shared/al-outbound-durable-effects.test.ts:760,773`,
  `packages/tests/shared/alm/al-outbound-control-admission.test.ts:765`,
  `packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts:310`,
  `packages/tests/shared/alm/outbound-ack-conflict-replay.test.ts:126`,
  `packages/tests/shared/alm/outbound-runtime-test-fixture.ts:251`
- Test literal of `ALOutboundMessageRuntime.Resources`: `packages/tests/shared/al-outbound-message-runtime.test.ts:60`
- Pin: `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts:217-234` (cold send `al-work`)
- Pin: `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts` (Task 1's warm ledger)

**Interfaces**

- Consumes: `ALOutboundDispatchAdmission.Result<TPrepared>` (`computed.bundle`, `committed`),
  `ALOutboundCommitBundle<TPrepared>` (`canonicalEntry`, `durableEffects`), `toALOutboundWorkKey`,
  `AL_OUTBOUND_WORK_PAGE_SIZE`, `ALStorageResetEvent`, `IndexedDbAdmissionBackend.Input.onStorageReset`.
- Produces:
  - `export const AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT: number` (= 64)
  - `export class ALOutboundCanonicalHandoff { constructor(input: { namespace: string; limit: number }); setCommitted<TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>): void; takeCanonical(workKey: Key): ResourceEntry | undefined; clear(): void }`
  - `export class ALStorageResetListeners { add(listener: (event: ALStorageResetEvent) => void): () => void; notify(event: ALStorageResetEvent): void }` (in `open-indexed-db-admission-database.ts`)
  - `ALOutboundRuntimeStores.storageResets?: ALStorageResetListeners` (absent: a pair no reset reaches, memory or PostgreSQL)
  - `ALOutboundMessageRuntime.Resources.storageResets: ALStorageResetListeners | undefined`
  - `ALOutboundStoreLane.Input.canonicalHandoff: ALOutboundCanonicalHandoff | undefined`
  - `ALOutboundAdmissionStore.readWorkSnapshot: (entry: ResourceEntry, handedOffCanonical: ResourceEntry | undefined) => Promise<ALOutboundEffectSnapshot<TPrepared>>` (was one parameter)

**Applying after Task 5.** The prototype behind this task was built on `52cc85b32`, before Task 5 changed
`al-outbound-admission-effect-store.ts` and `al-outbound-admission-store.ts`. The code blocks below show those two
files' hunks against that base; apply them onto Task 5's result (the functions are the same, the surrounding lines
differ). The prototype's whole diff is available to the controller as `scratch-5.patch` for reference.

- [ ] **Step 1: Write the failing test.** Create
      `packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts`:

```ts
import '../../../setup-browser-indexeddb.ts';

import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createDefaultIndexedDbALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    ALStorageResetListeners,
    openIndexedDbAdmissionDatabase,
    type ALStorageResetEvent
} from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT,
    ALOutboundCanonicalHandoff
} from '@shared/alm/outbound/lane/al-outbound-canonical-handoff.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    holdOutboundClaims,
    runOutboundWorkTask
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const HANDOFF_NAMESPACE = 'canonical-handoff';

const SEND_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    persist: true,
    preparedMessages: [{ peer: 'receiver' }]
});

interface HandoffTestPair {
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly counting: CountingIndexedDbOperationObserver;
}

/** One tab's view of a shared database: its own connection, store and operation counts. */
function openHandoffTestPair(
    dbName: string,
    storageResets?: ALStorageResetListeners
): HandoffTestPair {
    const counting = createCountingIndexedDbOperationObserver();
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: counting
    });
    const admissionStore = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: HANDOFF_NAMESPACE,
        decodePrepared: decodeOutboundTestPayload,
        namespace: HANDOFF_NAMESPACE,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { stores: { admissionStore, workQueue: backend.workQueue, storageResets }, counting };
}

function createHandoffTestRuntime(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    sent: ALMessage[]
) {
    return createDefaultOutboundTestRuntime({
        stores,
        planOutgoingMessage: SEND_PLANNER,
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage);
            return { status: 'sent', submissionAttempted: true };
        }
    });
}

describe('the canonical hand-off bound', () => {
    it('keeps the newest committed sends up to its limit and gives each one up once', async () => {
        const store = createDefaultOutboundTestStores().admissionStore;
        const peers = Array.from(
            { length: AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT + 1 },
            (_, index) => ({ peer: `p${index}` })
        );
        const bundle = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('bounded'),
            (msg) => ({ msg, dropReasonCode: undefined, persist: true, preparedMessages: peers })
        );
        const sends = bundle.durableEffects.filter((effect) =>
            effect.payload.kind === 'send-prepared'
        );
        expect(sends).toHaveLength(AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT + 1);
        const handoff = new ALOutboundCanonicalHandoff({
            namespace: store.namespace,
            limit: AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT
        });

        handoff.setCommitted(bundle);

        const oldest = toALOutboundWorkKey(store.namespace, sends[0]!.effectId);
        const newest = toALOutboundWorkKey(store.namespace, sends.at(-1)!.effectId);
        expect(handoff.takeCanonical(oldest), 'the oldest send past the limit is dropped')
            .toBeUndefined();
        expect(handoff.takeCanonical(newest)).toBe(bundle.canonicalEntry);
        expect(handoff.takeCanonical(newest), 'a claim consumes what it was handed')
            .toBeUndefined();
    });

    it('holds nothing after it is cleared', async () => {
        const store = createDefaultOutboundTestStores().admissionStore;
        const bundle = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('cleared'),
            SEND_PLANNER
        );
        const [send] = bundle.durableEffects;
        const handoff = new ALOutboundCanonicalHandoff({ namespace: store.namespace, limit: 4 });
        handoff.setCommitted(bundle);

        handoff.clear();

        expect(handoff.takeCanonical(toALOutboundWorkKey(store.namespace, send!.effectId)))
            .toBeUndefined();
    });
});

describe('the committed canonical message handed to dispatch', () => {
    it('reaches the claim of the tab that committed it without reading the canonical pair back', async () => {
        const { stores, counting } = openHandoffTestPair(`handoff-hit-${crypto.randomUUID()}`);
        const sent: ALMessage[] = [];
        const runtime = createHandoffTestRuntime(stores, sent);
        const claims = holdOutboundClaims(stores);
        const message = createOutboundMessage('handoff-hit');
        expect((await runtime.enqueueIfAbsent(message)).verdict).toMatchObject({
            kind: 'admitted',
            durable: true
        });
        counting.reset();
        await claims.release();

        await runOutboundWorkTask(runtime);

        expect(sent).toEqual([message]);
        expect(
            counting.getCounts().byKind['work-read'] ?? 0,
            'a hit reads neither canonical nor identity row'
        ).toBe(0);
        runtime.dispose();
    });

    it.each(['another tab', 'a reload'] as const)(
        'is read back when %s claims the committed row',
        async (claimant) => {
            const dbName = `handoff-miss-${crypto.randomUUID()}`;
            const committing = openHandoffTestPair(dbName);
            const committer = createHandoffTestRuntime(committing.stores, []);
            // The committing tab never claims: only the claimant below can send the row.
            const claims = holdOutboundClaims(committing.stores);
            const message = createOutboundMessage('handoff-miss');
            expect((await committer.enqueueIfAbsent(message)).verdict).toMatchObject({
                kind: 'admitted',
                durable: true
            });
            if (claimant === 'a reload') {
                committer.dispose();
            }
            const claiming = openHandoffTestPair(dbName);
            const sent: ALMessage[] = [];
            const runtime = createHandoffTestRuntime(claiming.stores, sent);

            await runtime.ready();
            await runOutboundWorkTask(runtime);

            expect(sent).toEqual([message]);
            expect(
                claiming.counting.getCounts().byKind['work-read'],
                'a miss reads the canonical pair'
            ).toBe(2);
            await claims.release();
        }
    );

    it('sends the stored canonical message when its lane replays a retained pending admission', async () => {
        const { stores } = openHandoffTestPair(`handoff-replay-${crypto.randomUUID()}`);
        const store = stores.admissionStore;
        const competitor = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('competing-sender-version')
        );
        const commit = store.commitBundle.bind(store);
        let first = true;
        // A competing commit wins the sender version inside the first commit, so the send below is
        // retained as a pending admission and replayed by the lane's own work.
        vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle) => {
            if (first) {
                first = false;
                expect(await commit(competitor)).toBe('committed');
            }
            return await commit(bundle);
        });
        const engine = new InboxOutboxEngine();
        const sent: ALMessage[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            queueEngine: engine,
            planOutgoingMessage: SEND_PLANNER,
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                sent.push(lifecycle.canonicalMessage);
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const message = createOutboundMessage('handoff-replay');

        // The replay commits through dispatch admission, not the lane's own commit, so the send's
        // claim finds nothing handed over and reads the canonical pair.
        expect((await runtime.enqueueIfAbsent(message)).verdict).toEqual({ kind: 'pending' });
        await expect.poll(async () => {
            await engine.executeOnce();
            return sent;
        }).toEqual([message]);
        runtime.dispose();
    });

    it('is dropped when the storage of its pair is reset', async () => {
        const storageResets = new ALStorageResetListeners();
        const { stores, counting } = openHandoffTestPair(
            `handoff-reset-${crypto.randomUUID()}`,
            storageResets
        );
        const sent: ALMessage[] = [];
        const runtime = createHandoffTestRuntime(stores, sent);
        const claims = holdOutboundClaims(stores);
        const message = createOutboundMessage('handoff-reset');
        expect((await runtime.enqueueIfAbsent(message)).verdict).toMatchObject({
            kind: 'admitted',
            durable: true
        });

        storageResets.notify({
            dbName: 'handoff-reset',
            previousSchemaId: undefined,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            reason: 'store-schema-mismatch'
        });
        counting.reset();
        await claims.release();
        await runOutboundWorkTask(runtime);

        expect(sent).toEqual([message]);
        expect(
            counting.getCounts().byKind['work-read'],
            'the claim after a reset reads the canonical pair'
        ).toBe(2);
        runtime.dispose();
    });

    it('is dropped when its runtime is disposed', async () => {
        const { stores } = openHandoffTestPair(`handoff-dispose-${crypto.randomUUID()}`);
        const setCommitted = vi.spyOn(ALOutboundCanonicalHandoff.prototype, 'setCommitted');
        const runtime = createHandoffTestRuntime(stores, []);
        const claims = holdOutboundClaims(stores);
        for (const resourceId of ['held-until-dispose', 'dropped-by-dispose']) {
            expect((await runtime.enqueueIfAbsent(createOutboundMessage(resourceId))).verdict)
                .toMatchObject({ kind: 'admitted', durable: true });
        }
        // The durable lane's own hand-off, and the work slot of each send it was handed.
        const [handoff] = setCommitted.mock.contexts as ALOutboundCanonicalHandoff[];
        const [held, dropped] = setCommitted.mock.calls.map(([bundle]) =>
            toALOutboundWorkKey(stores.admissionStore.namespace, bundle.durableEffects[0]!.effectId)
        );
        expect(handoff!.takeCanonical(held!), 'held while the runtime lives').toBeDefined();

        runtime.dispose();

        expect(handoff!.takeCanonical(dropped!)).toBeUndefined();
        await claims.release();
    });

    it('tells the lane of an IndexedDB pair when its database is reset on open', async () => {
        const dbName = `handoff-reset-open-${crypto.randomUUID()}`;
        const stale = await openIndexedDbAdmissionDatabase({
            dbName,
            storeName: 'entries',
            schemaId: 'rallar-alm-previous-schema',
            onStorageReset: () => {}
        });
        stale.close();
        const reported: ALStorageResetEvent[] = [];
        const stores = createDefaultIndexedDbALOutboundRuntimeStores({
            dbName,
            decodePrepared: decodeOutboundTestPayload,
            onStorageReset: (event) => reported.push(event)
        });
        const heard: ALStorageResetEvent[] = [];
        stores.storageResets?.add((event) => heard.push(event));

        await stores.admissionStore.ready();

        expect(reported).toHaveLength(1);
        expect(heard).toEqual(reported);
    });
});
```

- [ ] **Step 2: Run it and see it fail on the missing module.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts
```

Expected:

```text
Error: Cannot find package '@shared/alm/outbound/lane/al-outbound-canonical-handoff.ts' imported from .../packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 3: Create the hand-off.** Create
      `packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts`:

```ts
import { toKeyAsString, type Key, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALOutboundCommitBundle } from '../admission/al-outbound-admission-store.ts';
import { AL_OUTBOUND_WORK_PAGE_SIZE, toALOutboundWorkKey } from '../al-outbound-work-entry.ts';

/** Four work pages: what the commits between two claiming batches of one lane can hand over. */
export const AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT = 4 * AL_OUTBOUND_WORK_PAGE_SIZE;

export namespace ALOutboundCanonicalHandoff {
    export interface Input {
        readonly namespace: string;
        readonly limit: number;
    }
}

/**
 * The canonical row a commit of one lane wrote, held for the claim of each prepared send that
 * references it so that claim need not read it back. A cache of an immutable row, never a source:
 * a claim that finds nothing here reads storage.
 */
export class ALOutboundCanonicalHandoff {
    private readonly namespace: string;
    private readonly limit: number;
    private readonly canonicalByWorkKey = new Map<string, ResourceEntry>();

    constructor(input: ALOutboundCanonicalHandoff.Input) {
        this.namespace = input.namespace;
        this.limit = input.limit;
    }

    /** Holds a committed bundle's canonical row for each prepared send it wrote; past the limit the oldest go. */
    setCommitted<TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>): void {
        const canonical = bundle.canonicalEntry;
        if (canonical === undefined) {
            return;
        }
        for (const effect of bundle.durableEffects) {
            if (effect.payload.kind === 'send-prepared') {
                const workKey = toKeyAsString(toALOutboundWorkKey(this.namespace, effect.effectId));
                this.canonicalByWorkKey.delete(workKey);
                this.canonicalByWorkKey.set(workKey, canonical);
            }
        }
        for (const workKey of this.canonicalByWorkKey.keys()) {
            if (this.canonicalByWorkKey.size <= this.limit) {
                return;
            }
            this.canonicalByWorkKey.delete(workKey);
        }
    }

    /** The row held for one claimed work slot, given up as it is handed over: a retried claim reads storage. */
    takeCanonical(workKey: Key): ResourceEntry | undefined {
        const keyString = toKeyAsString(workKey);
        const canonical = this.canonicalByWorkKey.get(keyString);
        this.canonicalByWorkKey.delete(keyString);
        return canonical;
    }

    clear(): void {
        this.canonicalByWorkKey.clear();
    }
}
```

- [ ] **Step 4: Add the reset listeners beside the reset event.** In
      `packages/shared/alm/open-indexed-db-admission-database.ts`, insert after
      `createPassThroughALStorageResetSink`:

```diff
--- a/packages/shared/alm/open-indexed-db-admission-database.ts
+++ b/packages/shared/alm/open-indexed-db-admission-database.ts
@@ -51,6 +51,28 @@ export function createPassThroughALStorageResetSink(): (event: ALStorageResetEve
     return () => {};
 }
 
+/**
+ * The owners that keep memory of one store pair's rows, told when its database was deleted and
+ * recreated so they forget it. The pair's composition notifies; each owner adds and removes itself.
+ */
+export class ALStorageResetListeners {
+    private readonly listeners = new Set<(event: ALStorageResetEvent) => void>();
+
+    /** Returns the removal of this listener, for its owner's dispose. */
+    add(listener: (event: ALStorageResetEvent) => void): () => void {
+        this.listeners.add(listener);
+        return () => {
+            this.listeners.delete(listener);
+        };
+    }
+
+    notify(event: ALStorageResetEvent): void {
+        for (const listener of this.listeners) {
+            listener(event);
+        }
+    }
+}
+
 /**
  * Opens the admission database, resetting it once (delete and recreate) when its stores or its
  * schema identity do not match. A mismatch that persists after that single reset is a storage
```

- [ ] **Step 5: Run the test: the bound passes, the lane behaviour fails.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts
```

Expected (3 failed, 6 passed; the miss, replay and reset cases already hold because every claim still reads):

```text
     × reaches the claim of the tab that committed it without reading the canonical pair back
     × is dropped when its runtime is disposed
     × tells the lane of an IndexedDB pair when its database is reset on open
AssertionError: a hit reads neither canonical nor identity row: expected 2 to be +0 // Object.is equality
TypeError: Cannot read properties of undefined (reading 'takeCanonical')
AssertionError: expected [] to deeply equal [ { …(4) } ]
      Tests  3 failed | 6 passed (9)
```

- [ ] **Step 6: Let the claim read take a handed-over row.** In
      `packages/shared/alm/outbound/admission/al-outbound-admission-effect-store.ts` (the candidate branch
      of `readReferencedMessage` becomes `toCandidateMessage`, reused by the hit):

```diff
--- a/packages/shared/alm/outbound/admission/al-outbound-admission-effect-store.ts
+++ b/packages/shared/alm/outbound/admission/al-outbound-admission-effect-store.ts
@@ -98,11 +98,14 @@ export class ALOutboundAdmissionEffectStore<TPrepared> {
         }));
     }
 
-    /** Decodes one claimed queue row, reading the canonical message the payload references. */
-    async readWorkSnapshot(entry: ResourceEntry): Promise<ALOutboundEffectSnapshot<TPrepared>> {
+    /** Decodes one claimed queue row with the canonical message its payload references. */
+    async readWorkSnapshot(
+        entry: ResourceEntry,
+        handedOffCanonical: ResourceEntry | undefined
+    ): Promise<ALOutboundEffectSnapshot<TPrepared>> {
         return decodeALOutboundWorkEntry(entry, this.namespace, {
             decodePrepared: this.decodePrepared,
-            message: await this.backend.readWithin((session) => this.readWorkCanonicalMessage(session, entry))
+            message: await this.readWorkCanonicalMessage(entry, handedOffCanonical)
         });
     }
 
@@ -185,12 +188,22 @@ export class ALOutboundAdmissionEffectStore<TPrepared> {
         }
     }
 
+    /**
+     * A canonical row the lane's own commit handed over answers only while it is live: past its
+     * deadline a stored row reads as absent, so the read decides then, exactly as without a hand-off.
+     */
     private async readWorkCanonicalMessage(
-        session: ALAdmissionReadSession,
-        entry: ResourceEntry
+        entry: ResourceEntry,
+        handedOffCanonical: ResourceEntry | undefined
     ): Promise<ALMessage | undefined> {
         const reference = readALOutboundWorkMessageReference(entry);
-        return reference === undefined ? undefined : await this.readReferencedMessage(session, reference);
+        if (reference === undefined) {
+            return undefined;
+        }
+        if (handedOffCanonical !== undefined && reference.expiresAtMs > this.nowMs()) {
+            return this.toCandidateMessage(reference, handedOffCanonical);
+        }
+        return await this.backend.readWithin((session) => this.readReferencedMessage(session, reference));
     }
 
     private async readReferencedMessage(
@@ -198,21 +211,33 @@ export class ALOutboundAdmissionEffectStore<TPrepared> {
         reference: ALOutboundMessageReference,
         candidate?: ResourceEntry
     ): Promise<ALMessage> {
+        if (candidate !== undefined) {
+            return this.toCandidateMessage(reference, candidate);
+        }
+        this.assertOwnCanonicalScope(reference);
+        const canonical = await session.readWork(reference.key);
+        const identity = await session.readWork(toALOutboundIdentityKey(reference.key));
+        return decodeALOutboundCanonicalMessage(reference, canonical, identity);
+    }
+
+    /** A canonical row already in hand, checked against the reference exactly as a stored pair is. */
+    private toCandidateMessage(reference: ALOutboundMessageReference, candidate: ResourceEntry): ALMessage {
+        this.assertOwnCanonicalScope(reference);
+        const creationExpiry = captureALOutboundCreationExpiry(decodePersistedALMessage(candidate.resource));
+        return decodeALOutboundCanonicalMessage(
+            reference,
+            candidate,
+            toALOutboundIdentityEntry(reference, candidate, creationExpiry)
+        );
+    }
+
+    private assertOwnCanonicalScope(reference: ALOutboundMessageReference): void {
         if (reference.scope !== this.canonicalScope) {
             throw new ALAdmissionCorruptionError(
                 JSON.stringify(reference.key),
                 new TypeError('Outbound reference belongs to another local scope')
             );
         }
-        const canonical = candidate ?? await session.readWork(reference.key);
-        const identity = candidate
-            ? toALOutboundIdentityEntry(
-                reference,
-                candidate,
-                captureALOutboundCreationExpiry(decodePersistedALMessage(candidate.resource))
-            )
-            : await session.readWork(toALOutboundIdentityKey(reference.key));
-        return decodeALOutboundCanonicalMessage(reference, canonical, identity);
     }
 }
```

In `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts`:

```diff
--- a/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
+++ b/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
@@ -301,8 +301,14 @@ export interface ALOutboundAdmissionStore<TPrepared> extends ALReadyable {
     /** The sent message, its receipt and its origin's version fence, read in one session. */
     readonly readReceiptAdmission: (receipt: ALOutboundPendingAckRef) => Promise<ALOutboundReceiptAdmissionSurface>;
 
-    /** Decodes one claimed work row of this scope, including the canonical message its payload references. */
-    readonly readWorkSnapshot: (entry: ResourceEntry) => Promise<ALOutboundEffectSnapshot<TPrepared>>;
+    /**
+     * Decodes one claimed work row of this scope, including the canonical message its payload
+     * references: the canonical row the lane's own commit handed over while it is live, else read.
+     */
+    readonly readWorkSnapshot: (
+        entry: ResourceEntry,
+        handedOffCanonical: ResourceEntry | undefined
+    ) => Promise<ALOutboundEffectSnapshot<TPrepared>>;
 
     readonly commitBundle: (
         bundle: ALOutboundCommitBundle<TPrepared>
@@ -456,8 +462,11 @@ class ProviderBackedALOutboundAdmissionStore<TPrepared> implements ALOutboundAdm
         }));
     }
 
-    async readWorkSnapshot(entry: ResourceEntry): Promise<ALOutboundEffectSnapshot<TPrepared>> {
-        return await this.effectStore.readWorkSnapshot(entry);
+    async readWorkSnapshot(
+        entry: ResourceEntry,
+        handedOffCanonical: ResourceEntry | undefined
+    ): Promise<ALOutboundEffectSnapshot<TPrepared>> {
+        return await this.effectStore.readWorkSnapshot(entry, handedOffCanonical);
     }
 
     async commitBundle(bundle: ALOutboundCommitBundle<TPrepared>): Promise<'committed' | 'conflict' | 'expired'> {
```

In `packages/shared/alm/outbound/control/al-outbound-control-admission.ts` (a nack-retry read is
never handed over):

```diff
--- a/packages/shared/alm/outbound/control/al-outbound-control-admission.ts
+++ b/packages/shared/alm/outbound/control/al-outbound-control-admission.ts
@@ -278,7 +278,7 @@ export class ALOutboundControlAdmission<TPrepared> {
         if (existing === undefined || !isPendingALOutboundWork(existing)) {
             return undefined;
         }
-        const work = await this.effectStore.readWorkSnapshot(existing);
+        const work = await this.effectStore.readWorkSnapshot(existing, undefined);
         if (work.payload.kind !== 'nack-retry' || work.payload.msgId !== msgId) {
             throw new ALAdmissionCorruptionError(
                 toALOutboundNotYetInSyncRetryKey(this.namespace, msgId),
```

- [ ] **Step 7: Wire the lane: record after the commit, take on the claim, drop on dispose and reset.**
      In `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`:

```diff
--- a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
+++ b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
@@ -39,6 +39,7 @@ import type { ALOutboundControlSource } from '../compute-al-outbound-control-adm
 import type { ALOutboundComputedDto } from '../compute-al-outbound-dispatch.ts';
 import type { ALOutboundControlAdmissionResult } from '../control/al-outbound-control-admission.ts';
 import { ALOutboundReceiptAdmission } from '../control/al-outbound-receipt-admission.ts';
+import type { ALOutboundCanonicalHandoff } from './al-outbound-canonical-handoff.ts';
 import type { ALOutboundSendControls } from './al-outbound-send-controls.ts';
 
 export namespace ALOutboundStoreLane {
@@ -52,6 +53,8 @@ export namespace ALOutboundStoreLane {
         readonly browserLocks: ALOutboundMessageRuntime.BrowserLocks | undefined;
         /** The memory pair's sweep; undefined for a lane over a durable pair. */
         readonly evictExpired: (() => void) | undefined;
+        /** What this lane's commits hand its own claims; the memory pair's lane reads memory and has none. */
+        readonly canonicalHandoff: ALOutboundCanonicalHandoff | undefined;
         readonly runtime: ALOutboundMessageRuntime.Dependencies<TPrepared>;
         readonly sendControls: ALOutboundSendControls;
         readonly settlements: ALOutboundSettlementEmitter;
@@ -72,6 +75,7 @@ export class ALOutboundStoreLane<TPrepared> {
     private readonly repairRetransmission: ALOutboundRepairRetransmission<TPrepared>;
     private readonly work: ALWorkHandler;
     private readonly effects: ALOutboundMessageEffects<TPrepared>;
+    private readonly removeStorageResetListener: (() => void) | undefined;
     private nextEvictionAtMs = Number.NEGATIVE_INFINITY;
 
     constructor(input: ALOutboundStoreLane.Input<TPrepared>) {
@@ -106,6 +110,7 @@ export class ALOutboundStoreLane<TPrepared> {
             sendSignal: input.sendControls.signal,
             settlements
         });
+        this.removeStorageResetListener = stores.storageResets?.add(() => input.canonicalHandoff?.clear());
     }
 
     async ready(): Promise<void> {
@@ -116,6 +121,8 @@ export class ALOutboundStoreLane<TPrepared> {
     dispose(): void {
         this.work.dispose();
         this.dispatchAdmission.dispose();
+        this.removeStorageResetListener?.();
+        this.input.canonicalHandoff?.clear();
     }
 
     /** A memory read on the volatile lane: whether this lane admitted the message. */
@@ -127,6 +134,7 @@ export class ALOutboundStoreLane<TPrepared> {
         dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
     ): Promise<ALOutboundComputedDto<TPrepared>> {
         const result = await this.dispatchAdmission.commit(dispatch);
+        this.setCanonicalHandoff(result);
 
         if (hasWrittenWork(result)) {
             this.work.committed();
@@ -144,12 +152,20 @@ export class ALOutboundStoreLane<TPrepared> {
             this.work.committed();
             throw error;
         });
+        results.forEach((result) => this.setCanonicalHandoff(result));
         if (results.some(hasWrittenWork)) {
             this.work.committed();
         }
         return results.map((result) => this.toStoreComputed(result.computed));
     }
 
+    /** Before the wake: the batch it starts claims what this commit wrote and finds its canonical row here. */
+    private setCanonicalHandoff(result: ALOutboundDispatchAdmission.Result<TPrepared>): void {
+        if (result.committed && result.computed.bundle !== undefined) {
+            this.input.canonicalHandoff?.setCommitted(result.computed.bundle);
+        }
+    }
+
     async acceptControlMessage(
         msg: ALMessage,
         source: ALOutboundControlSource
@@ -260,7 +276,10 @@ export class ALOutboundStoreLane<TPrepared> {
     private async readOutboundWork(entry: ResourceEntry): Promise<ALOutboundEffectSnapshot<TPrepared>> {
         return this.input.dequeueTypes.has(entry.typeId)
             ? toALOutboundDequeueWork(entry, this.input.runtime.readMessageFromEntry)
-            : await this.input.stores.admissionStore.readWorkSnapshot(entry);
+            : await this.input.stores.admissionStore.readWorkSnapshot(
+                entry,
+                this.input.canonicalHandoff?.takeCanonical(entry.key)
+            );
     }
 
     private async runDurableEffect(
```

- [ ] **Step 8: Give the durable lane its hand-off and carry the reset port.** In
      `packages/shared/alm/outbound/al-outbound-message-runtime.ts`:

```diff
--- a/packages/shared/alm/outbound/al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
@@ -18,6 +18,7 @@ import type {
     ALDeliverySettlement,
     ALDeliverySettlementSink
 } from '../delivery/al-delivery-lifecycle.ts';
+import type { ALStorageResetListeners } from '../open-indexed-db-admission-database.ts';
 import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
 import type { ALWorkReadinessProbeCause } from '../work/al-work-handler.ts';
 import type {
@@ -31,6 +32,10 @@ import { controlTargetMsgId, type ALOutboundControlSource } from './compute-al-o
 import type { ALOutboundComputedDto } from './compute-al-outbound-dispatch.ts';
 import type { ALOutboundControlAdmissionResult } from './control/al-outbound-control-admission.ts';
 import { admitALOutboundVolatileBudget } from './lane/admit-al-outbound-volatile-budget.ts';
+import {
+    AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT,
+    ALOutboundCanonicalHandoff
+} from './lane/al-outbound-canonical-handoff.ts';
 import { ALOutboundSendControls, type ALOutboundCancelOutcome } from './lane/al-outbound-send-controls.ts';
 import { ALOutboundStoreLane } from './lane/al-outbound-store-lane.ts';
 
@@ -167,6 +172,8 @@ export interface ALOutboundDispatchPlan<TPrepared> {
 export interface ALOutboundRuntimeStores<TPrepared> {
     readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
     readonly workQueue: QueueBoxResourceEntryRepository;
+    /** Told when the pair's database is deleted and recreated; absent for a pair no reset reaches. */
+    readonly storageResets?: ALStorageResetListeners;
 }
 
 /** The memory pair of a carrier runtime: nothing in it survives the document, and its lane sweeps it. */
@@ -322,6 +329,8 @@ export namespace ALOutboundMessageRuntime {
         /** The durable pair, and the only one of a runtime without `volatileStores`. */
         readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
         readonly workQueue: QueueBoxResourceEntryRepository;
+        /** The durable pair's resets; `undefined` for a pair no reset reaches (memory, PostgreSQL). */
+        readonly storageResets: ALStorageResetListeners | undefined;
         /** The memory pair a volatile admission goes to; `undefined` keeps one backend for every admission. */
         readonly volatileStores: ALVolatileOutboundRuntimeStores<TPrepared> | undefined;
         readonly effectWorkerId: string;
@@ -414,6 +423,10 @@ export class ALOutboundMessageRuntime<TPrepared> {
             dequeueTypes: dependencies.dequeue.types,
             browserLocks: dependencies.browserLocks,
             evictExpired: undefined,
+            canonicalHandoff: new ALOutboundCanonicalHandoff({
+                namespace: dependencies.admissionStore.namespace,
+                limit: AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT
+            }),
             runtime: dependencies,
             sendControls: this.sendControls,
             settlements
@@ -425,6 +438,7 @@ export class ALOutboundMessageRuntime<TPrepared> {
             dequeueTypes: new Set<string>(),
             browserLocks: undefined,
             evictExpired: dependencies.volatileStores.evictExpired,
+            canonicalHandoff: undefined,
             runtime: dependencies,
             sendControls: this.sendControls,
             settlements
```

In `packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts`:

```diff
--- a/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
@@ -112,6 +112,7 @@ export function createDefaultALOutboundRuntimeResources<TPrepared>(
     return {
         admissionStore: stores.admissionStore,
         workQueue: stores.workQueue,
+        storageResets: stores.storageResets,
         volatileStores: input.volatileStores,
         effectWorkerId: `al-outbound:${crypto.randomUUID()}`,
         clock: { nowMs },
```

In `packages/shared/alm/al-runtime-stores.ts` (the IndexedDB pair's composition fans the backend's
reset out to the lane before the diagnostics sink):

```diff
--- a/packages/shared/alm/al-runtime-stores.ts
+++ b/packages/shared/alm/al-runtime-stores.ts
@@ -24,6 +24,7 @@ import type {
 import { IndexedDbAdmissionBackend } from './indexed-db-admission-backend.ts';
 import {
     AL_ADMISSION_SCHEMA_ID,
+    ALStorageResetListeners,
     createPassThroughALStorageResetSink,
     type ALStorageResetEvent
 } from './open-indexed-db-admission-database.ts';
@@ -158,6 +159,7 @@ export function createIndexedDbALInboundRuntimeStores(
 export function createIndexedDbALOutboundRuntimeStores<TPrepared>(
     input: CreateIndexedDbALOutboundRuntimeStoresInput<TPrepared>
 ): ALOutboundRuntimeStores<TPrepared> {
+    const storageResets = new ALStorageResetListeners();
     const backend = input.outboundBackend ??
         new IndexedDbAdmissionBackend({
             dbName: input.dbName ?? DEFAULT_INDEXED_DB_NAME,
@@ -166,9 +168,13 @@ export function createIndexedDbALOutboundRuntimeStores<TPrepared>(
             newWriteToken: crypto.randomUUID.bind(crypto),
             observer: input.observer,
             schemaId: input.schemaId,
-            onStorageReset: input.onStorageReset
+            onStorageReset: (event) => {
+                storageResets.notify(event);
+                input.onStorageReset(event);
+            }
         });
     return {
+        storageResets,
         admissionStore: createALOutboundAdmissionStore({
             nowMs: input.nowMs,
             namespace: `${input.namespace}:outbound:admission`,
```

- [ ] **Step 9: Update the callers of the changed contracts in tests.** Every direct
      `readWorkSnapshot` call passes `undefined` (nothing handed over), and the one literal
      `ALOutboundMessageRuntime.Resources` names `storageResets: undefined`:

```diff
--- a/packages/tests/api-v1/psql-admission-work.test.ts
+++ b/packages/tests/api-v1/psql-admission-work.test.ts
@@ -282,7 +282,7 @@ describe('PostgreSQL outbound admission', () => {
         const claimed = await port.claim({ maxCount: 1, observedEntries: undefined });
 
         expect(claimed).toHaveLength(1);
-        expect((await store.readWorkSnapshot(claimed[0]!.entry)).effectId).toBe(effectId);
+        expect((await store.readWorkSnapshot(claimed[0]!.entry, undefined)).effectId).toBe(effectId);
         await port.releaseAll([{ claim: claimed[0]!, outcome: { status: 'completed' } }]);
         expect(await backend.workQueue.getItem(workKey)).toMatchObject({ status: EntityStatus.COMPLETED });
         expect(await peekOutboundWorkReadyAt(backend.workQueue, namespace)).toBeUndefined();
--- a/packages/tests/shared-server/integration/postgres/al-admission-queue-work.test.ts
+++ b/packages/tests/shared-server/integration/postgres/al-admission-queue-work.test.ts
@@ -556,7 +556,7 @@ function createOutboundWork(stores: ALOutboundRuntimeStores<ALOutboundTransportM
             const claims = await port.claim({ maxCount, observedEntries: undefined });
             return await Promise.all(claims.map(async (claim) => ({
                 claim,
-                work: await stores.admissionStore.readWorkSnapshot(claim.entry)
+                work: await stores.admissionStore.readWorkSnapshot(claim.entry, undefined)
             })));
         }
     };
--- a/packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
+++ b/packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts
@@ -366,7 +366,7 @@ it('observes a retained pending admission without storage reads and wakes on the
     const retained = await Promise.all((await backend.workQueue.getAllKeys()).map(async (key) => {
         const entry = await backend.workQueue.getItem(key);
         return entry?.typeId === toALOutboundWorkType('pending-observation')
-            ? (await admissionStore.readWorkSnapshot(entry)).payload
+            ? (await admissionStore.readWorkSnapshot(entry, undefined)).payload
             : undefined;
     }));
     expect(retained).toContainEqual(
--- a/packages/tests/shared/al-indexeddb-runtime-stores.test.ts
+++ b/packages/tests/shared/al-indexeddb-runtime-stores.test.ts
@@ -702,7 +702,7 @@ describe('IndexedDB AL runtime stores', () => {
         vi.spyOn(stores.workQueue, 'reserveEntries').mockImplementation(async (input) => {
             const reserved = await reserveEntries(input);
             const payloads = await Promise.all(
-                [...reserved.values()].map(async (entry) => (await admissionStore.readWorkSnapshot(entry)).payload)
+                [...reserved.values()].map(async (entry) => (await admissionStore.readWorkSnapshot(entry, undefined)).payload)
             );
             if (!acceptedAckDuringTimeout && payloads.some((payload) => payload.kind === 'ack-timeout')) {
                 acceptedAckDuringTimeout = true;
--- a/packages/tests/shared/al-outbound-durable-effects.test.ts
+++ b/packages/tests/shared/al-outbound-durable-effects.test.ts
@@ -757,7 +757,7 @@ async function hasAckTimeoutWork(
     const payloads = await Promise.all(
         entries
             .filter((entry) => entry.typeId === toALOutboundWorkType(stores.admissionStore.namespace))
-            .map(async (entry) => (await stores.admissionStore.readWorkSnapshot(entry)).payload)
+            .map(async (entry) => (await stores.admissionStore.readWorkSnapshot(entry, undefined)).payload)
     );
     return payloads.some((payload) => payload.kind === 'ack-timeout');
 }
@@ -770,6 +770,6 @@ async function readRetainedWorkKinds(stores: OutboundTestStores): Promise<readon
         cursor: null
     });
     return await Promise.all(
-        page.entries.map(async (entry) => (await stores.admissionStore.readWorkSnapshot(entry)).payload.kind)
+        page.entries.map(async (entry) => (await stores.admissionStore.readWorkSnapshot(entry, undefined)).payload.kind)
     );
 }
--- a/packages/tests/shared/alm/al-outbound-control-admission.test.ts
+++ b/packages/tests/shared/alm/al-outbound-control-admission.test.ts
@@ -762,7 +762,7 @@ async function readRetainedWork(
         cursor: null
     });
     return await Promise.all(
-        page.entries.map(async (entry) => (await admissionStore.readWorkSnapshot(entry)).payload)
+        page.entries.map(async (entry) => (await admissionStore.readWorkSnapshot(entry, undefined)).payload)
     );
 }
 
--- a/packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts
+++ b/packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts
@@ -307,7 +307,7 @@ describe('outbound IndexedDB durable queue replay', () => {
         runtime1.dispose();
         vi.setSystemTime(Date.now() + 10_001);
         const [claimed] = await claimOne(port);
-        const work = await admissionStore.readWorkSnapshot(claimed!.entry);
+        const work = await admissionStore.readWorkSnapshot(claimed!.entry, undefined);
         expect(work.payload.kind).toBe('send-prepared');
         expect(work.canonicalMessage).toEqual(msg);
         expect(claimed!.entry.audit.date).toBeInstanceOf(Temporal.PlainTime);
--- a/packages/tests/shared/alm/outbound-ack-conflict-replay.test.ts
+++ b/packages/tests/shared/alm/outbound-ack-conflict-replay.test.ts
@@ -123,7 +123,7 @@ it.each(
         });
         const pending = [];
         for (const entry of page.entries) {
-            const work = await admissionStore.readWorkSnapshot(entry);
+            const work = await admissionStore.readWorkSnapshot(entry, undefined);
             if (work.payload.kind === 'admit-control') {
                 pending.push(entry);
             }
--- a/packages/tests/shared/alm/outbound-runtime-test-fixture.ts
+++ b/packages/tests/shared/alm/outbound-runtime-test-fixture.ts
@@ -248,7 +248,7 @@ export async function claimOutboundTestWork<TPrepared>(
 ): Promise<readonly ALOutboundEffectSnapshot<TPrepared>[]> {
     const port = createOutboundWorkPort(stores.workQueue, stores.admissionStore.namespace);
     const claims = await port.claim({ maxCount, observedEntries: undefined });
-    return await Promise.all(claims.map((claim) => stores.admissionStore.readWorkSnapshot(claim.entry)));
+    return await Promise.all(claims.map((claim) => stores.admissionStore.readWorkSnapshot(claim.entry, undefined)));
 }
 
 /** Releases one claimed row the way the owner's attempt does. */
--- a/packages/tests/shared/al-outbound-message-runtime.test.ts
+++ b/packages/tests/shared/al-outbound-message-runtime.test.ts
@@ -58,6 +58,7 @@ describe('ALOutboundMessageRuntime', () => {
             settlements: undefined,
             admissionStore,
             workQueue: stores.workQueue,
+            storageResets: undefined,
             volatileStores: undefined,
             dequeue: { types: new Set<string>(), resilience: createDefaultALOutboundDequeueResilience() },
             effectWorkerId: 'injected-outbound-worker',
```

- [ ] **Step 10: Run the new test: all green.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts
```

Expected: `Tests  9 passed (9)`.

- [ ] **Step 11: Run the cold pin and see it fall by the two canonical work reads.**

```sh
npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
```

Expected on `52cc85b32` + this task (on a tree with Task 5 the figures read 13 and 11 instead of 15 and 13):

```text
     × sends one durable message in 10 al-admission and 15 al-work operations
AssertionError: one default send spends 15 al-work operations today: expected 13 to be 15 // Object.is equality
      Tests  1 failed | 19 passed (20)
```

- [ ] **Step 12: Lower the cold pin by 2 with its reason.** In
      `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` (figures as prototyped on
      `52cc85b32`; after Task 5 write 13 → 11 with the same reason):

```diff
--- a/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
+++ b/packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
@@ -214,7 +214,7 @@ describe('outbound work owner IndexedDB scan volume', () => {
 });
 
 describe('outbound default send IndexedDB volume', () => {
-    it('sends one durable message in 10 al-admission and 15 al-work operations', async () => {
+    it('sends one durable message in 10 al-admission and 13 al-work operations', async () => {
         const observer = createCountingIndexedDbOperationObserver();
         const runtime = createDefaultOutboundTestRuntime({
             stores: createIndexedDbOutboundCountStores(observer, 'outbound-default-send'),
@@ -229,7 +229,10 @@ describe('outbound default send IndexedDB volume', () => {
         const counts = observer.getCounts();
         // These figures protect the default send's admission and work I/O budget.
         expect(counts.byOwner['al-admission'], 'one default send spends 10 al-admission operations today').toBe(10);
-        expect(counts.byOwner['al-work'], 'one default send spends 15 al-work operations today').toBe(15);
+        expect(
+            counts.byOwner['al-work'],
+            'one default send spends 13 al-work operations: its claim takes the committed canonical pair in memory instead of two work reads'
+        ).toBe(13);
         runtime.dispose();
     });
 });
```

- [ ] **Step 13: Lower the warm ledger pins by the measured delta.** In
      `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts` (Task 1), outbound warm send:
      chain **−1** (10 → 9 after Task 5), total **−1** (13 → 12), requests **−2** (Task 5's figure − 2),
      `al-work` **−2** (10 → 8), `al-admission` unchanged (10). Reason string for each lowered assertion:
      `'the claim takes the canonical pair its own commit handed over instead of reading it back'`.
      The inbound pins do not move. Measured with the probe on `52cc85b32` + this task: chain 11 → 10,
      total 14 → 13, requests 46 → 44, operations 10 + 12 → 10 + 10. Run:

```sh
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
```

Expected: both files pass.

- [ ] **Step 14: Update the outbound README.** In `packages/shared/alm/outbound/README.md`, "Canonical
      message storage":

```diff
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -164,6 +164,15 @@ payload-dependent sends and repair stop at the deadline. Live missing or mismatc
 references are corruption. Superseding messages retain separate canonical payloads;
 they do not overwrite a predecessor's envelope.
 
+A claim reads the canonical pair its work row references unless the durable lane's own commit
+handed it over. [`ALOutboundCanonicalHandoff`](./lane/al-outbound-canonical-handoff.ts) holds the
+committed canonical row for each prepared send the commit wrote, keyed by that send's work slot and
+bounded to four work pages, oldest dropped first; the claim takes it and checks it against the
+reference exactly as it checks a stored pair. It is a cache of an immutable row, never a source:
+another tab's claim, a reload, a replayed pending admission, a retried claim and a row at its
+deadline read storage. Dispose and a storage reset drop it (the IndexedDB pair's composition tells
+the lane through `ALStorageResetListeners`); the memory pair's lane has none.
+
 A validated initial AL control enqueue runs the normal read, computation, validation,
 and optimistic commit without entering the sender queue or browser Web Lock (D105). An
 uncontended commit returns `admitted`; a real commit conflict atomically retains the
```

- [ ] **Step 15: Run the semantic suites.** First list the shared-web al-runtime files:

```sh
ls packages/tests/shared-web/al-runtime/
```

Expected: `browser-al-runtime-cleanup-validation.test.ts browser-al-runtime-ownership.test.ts
browser-al-runtime-stores.test.ts browser-al-storage-reset.test.ts browser-outbound-cleanup.test.ts
browser-session-inbound-store.test.ts`.

```sh
npx vitest run packages/tests/shared/alm packages/tests/shared-web/al-runtime
```

Expected (prototype on `52cc85b32`): `Test Files  94 passed (94)`, `Tests  1161 passed (1161)`.
Then the callers of the widened contracts outside `alm/` (sandbox off: loopback-port suites under
`packages/tests/shared-test` fail with `listen EPERM` in a sandbox):

```sh
npx vitest run packages/tests/shared packages/tests/api-v1/psql-admission-work.test.ts
```

Expected: every file passes (prototype: 1046 files passed, 4 skipped).

- [ ] **Step 16: Type checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
node scripts/check-tests-typecheck.mjs
cd apps/api-v1 && deno task check; cd -
```

Expected: no output from the three `tsc` runs; `check-tests-typecheck: 1399 test files enforced, 0
files carrying known debt (0 errors).`; `deno task check` exits 0 (`ALOutboundRuntimeStores` reaches the
server's PostgreSQL pair). In a scratch worktree without app-local `node_modules` the ratchet also
prints `FAIL: new type errors in an enforced file: apps/rallar-black-box/vite.config.ts (1)` (`Cannot
find module '@vitejs/plugin-react'`): environmental, not this change; `npm ci` clears it.

- [ ] **Step 17: Format the touched files and check style.**

```sh
npx dprint fmt packages/shared/alm/al-runtime-stores.ts packages/shared/alm/open-indexed-db-admission-database.ts packages/shared/alm/outbound/README.md packages/shared/alm/outbound/admission/al-outbound-admission-effect-store.ts packages/shared/alm/outbound/admission/al-outbound-admission-store.ts packages/shared/alm/outbound/al-outbound-message-runtime.ts packages/shared/alm/outbound/control/al-outbound-control-admission.ts packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Expected: `browser/rallar.ts` brotli about +0.3 KiB over the tree before this task (prototype 228.2 →
228.5 KiB, `< 229.0 KiB | ok`); both bundle tests pass. A crossed budget is raised to the next whole
KiB with the measured figure recorded.

- [ ] **Step 18: Commit.**

```sh
git add packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts packages/shared/alm/open-indexed-db-admission-database.ts packages/shared/alm/al-runtime-stores.ts packages/shared/alm/outbound/README.md packages/shared/alm/outbound/admission/al-outbound-admission-effect-store.ts packages/shared/alm/outbound/admission/al-outbound-admission-store.ts packages/shared/alm/outbound/al-outbound-message-runtime.ts packages/shared/alm/outbound/control/al-outbound-control-admission.ts packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts packages/tests/api-v1/psql-admission-work.test.ts packages/tests/shared-server/integration/postgres/al-admission-queue-work.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-outbound-control-admission.test.ts packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts packages/tests/shared/alm/outbound-ack-conflict-replay.test.ts packages/tests/shared/alm/outbound-runtime-test-fixture.ts
git commit -m "Hand the committed canonical message to its own claim in memory

A durable lane's commit holds the canonical row it wrote for each prepared
send, and that send's claim takes it instead of reading the canonical and
identity rows back. The hand-off is bounded to four work pages, dropped on
dispose and on a storage reset, and a miss (another tab, a reload, a replayed
pending admission, a retried claim, a row at its deadline) reads storage as
before."
```

- [ ] **Step 19: Changed-range gates on the commit.**

```sh
npm run check:repo-style:changed -- <task-6-base> HEAD
node scripts/check-test-structure-coupling.mjs --changed <task-6-base> HEAD
npm run check:test-reachability
```

Expected: `PASS: no new repository style findings`; `PASS: changed-range structure-coupling review has
complete individual classifications`; the new test file is reached by the `unit` project. (Prototype:
putting the hand-off in `outbound/` or the listeners in their own `alm/` file trips
`layout.directory-density` for both directories; `lane/` and `open-indexed-db-admission-database.ts`
do not. Asserting on `mock.calls` of `readWorkSnapshot` trips `mock-invocation-count-or-order`; the
test therefore observes `work-read` counts and the hand-off's own state.)

---

### Task 7: Dispatch's readonly guard sessions as one

Decision D108 (lever "dispatch's three readonly sessions as one"); survey §A.2 rows #11–#12 and §D
row 4; proposal §1.4 and §2.1. Prototyped in `<scratchpad>/p1-plan/scratch-5` as commit `dc93de7d4`
on Task 6's `64ecc81d6` (Task 5 not applied; deltas are relative).

**What changes.** `writeAttemptedSend` (`al-outbound-message-effects.ts:189-245`) read its two guards
in two readonly sessions: `isMessageSuperseded` (`sent:<msgId>`, plus the supersedence pair when the
message is tracked) and then `readReceiptState` (`pending-ack:[sender,msgId]`). A new store method
`readSendGuards(message)` reads both in one `readWithin` session, in the same order, and still skips
the receipt read when the message is superseded (a corrupt receipt row behind a superseded message must
keep settling `superseded`, not fail the attempt). The result is a discriminated union, so "superseded"
and "no receipt" stay distinct. Merged, never skipped: skipping the receipt read on a first attempt
cannot be proven safe (a hand-over or fallback receipt may complete before it, D56/S3b), and skipping
the supersedence read is safe only when tracking is off. The guards keep their place after
`attempt-started`, so a failing guard read still ends the attempt it stated
(`writePreparedMessage`'s catch), the deadline check still follows the read, and the abort check
still follows the deadline. The transport half of `writeAttemptedSend` moves to
`writeTransportAttempt` so the function drops from 57 to 38 lines without raising the file's
cognitive load (a `??`-based split raised it from 49 to 50 and tripped the changed-style gate).

**On a hand-off miss the canonical read stays its own session** (see the open decision in the
controller report): folding it into the guard session would move either the canonical read after
`attempt-started` (a missing or corrupt canonical row, or a deadline crossed during the read, would
then state `attempt-started` plus a failed `attempt-settled` instead of nothing, and the silent
expiry of `readExpirableOutboundWork` would be lost) or the guard reads before it (a failing guard
read would no longer end a stated attempt). A miss therefore costs two sessions (canonical, guards)
instead of three; a hit costs one instead of two.

**Measured (probe `<scratchpad>/p1-plan/probe-5`, warm sends 2..4 identical):**

| Tree                   | chain | total tx | requests | `al-admission` | `al-work` | cold tx |
| ---------------------- | ----: | -------: | -------: | -------------: | --------: | ------: |
| `52cc85b32` (base)     |    11 |       14 |       46 |             10 |        12 |      21 |
| + Task 6 (`64ecc81d6`) |    10 |       13 |       44 |             10 |        10 |      20 |
| + Task 7 (`dc93de7d4`) |     9 |       12 |       44 |             10 |        10 |      19 |
| Task 7 delta           |    −1 |       −1 |        0 |              0 |         0 |      −1 |

Projected onto the plan's sequence (Tasks 5 and 6 first): chain 9 → **8**, total 12 → **11**,
operations unchanged (10 `al-admission` + 8 `al-work`; one `read` op per key, so the two reads stay
two ops). The cold 10 + 15 operation pin does not move. Inbound unchanged. Bundle: `browser/rallar.ts`
brotli 228.5 → 228.7 KiB (budget < 229.0; headroom 0.3 KiB after Tasks 6 and 7 on `52cc85b32`).

**Files**

- Create: `packages/tests/shared/alm/outbound/al-outbound-send-guards.test.ts`
- Modify: `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts` (new type
  `ALOutboundSendGuards` after `ALOutboundCommitBundle`, ~line 244; interface member after
  `isMessageSuperseded`, ~line 285; implementation after `isMessageSuperseded`, ~line 440)
- Modify: `packages/shared/alm/outbound/al-outbound-message-effects.ts` (`writeAttemptedSend`,
  lines 189–245, split into `writeAttemptedSend` + `writeTransportAttempt`)
- Modify: `packages/shared/alm/outbound/README.md` ("Admission and invocation paths" table, the
  `send-prepared` work row, ~line 222)
- Modify (the seam two existing tests inject into moves from `readReceiptState` to `readSendGuards`;
  their assertions do not change): `packages/tests/shared/al-outbound-durable-effects.test.ts:47-56`
  ("does not send when the deadline passes during the receipt read"),
  `packages/tests/shared/alm/outbound-delivery-settlements.test.ts:719-725` ("cancels an attempt still
  inside its pre-transport reads")
- Pin: `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts` (Task 1's warm ledger)

**Interfaces**

- Consumes: `ALOutboundAdmissionReads.isMessageSuperseded(session, msg)`,
  `ALOutboundAdmissionReads.readReceiptState(session, receipt)`, `ALAdmissionWorkBackend.readWithin`,
  `isALOutboundReceiptComplete`.
- Produces:
  - `export type ALOutboundSendGuards = Readonly<{ kind: 'superseded' }> | Readonly<{ kind: 'current'; receiptState: ALOutboundPendingAckSnapshot | undefined }>`
  - `ALOutboundAdmissionStore.readSendGuards: (message: ALMessage) => Promise<ALOutboundSendGuards>`
    (`isMessageSuperseded` and `readReceiptState` stay: the dequeue path, receipt admission and tests
    use them)

- [ ] **Step 1: Write the failing test.** Create
      `packages/tests/shared/alm/outbound/al-outbound-send-guards.test.ts`:

```ts
import '../../../setup-browser-indexeddb.ts';

import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    holdOutboundClaims,
    runOutboundWorkTask,
    trackOutboundTestAcks
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';
import { recordIndexedDbTransactions } from '../record-indexed-db-transactions.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const GUARDS_NAMESPACE = 'send-guards';
const STATE_STORE_NAME = 'entries';

const SEND_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    persist: true,
    preparedMessages: [{ peer: 'receiver' }]
});

const SUPERSEDING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    ...SEND_PLANNER(msg, undefined),
    supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
});

const ACKED_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    ...SEND_PLANNER(msg, undefined),
    ackTracking: trackOutboundTestAcks(['receiver'])
});

function createGuardsTestStores(dbName: string): ALOutboundRuntimeStores<OutboundTestPayload> {
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName,
        storeName: STATE_STORE_NAME,
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const admissionStore = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: GUARDS_NAMESPACE,
        decodePrepared: decodeOutboundTestPayload,
        namespace: GUARDS_NAMESPACE,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { admissionStore, workQueue: backend.workQueue };
}

async function admitGuardedMessage(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage,
    planner: ALOutboundPlanner<OutboundTestPayload>
): Promise<void> {
    await store.ready();
    expect(await store.commitBundle(await computeOutboundTestAdmission(store, message, planner)))
        .toBe('committed');
}

/**
 * The read sessions a claim opens: readonly over both the state store and the work store. Work
 * probes, reservations and releases touch the work store alone.
 */
function recordAdmissionReadSessions(): () => number {
    const sessions: string[] = [];
    const openTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
    ) {
        const names = typeof storeNames === 'string' ? [storeNames] : [...storeNames];
        if (
            (mode ?? 'readonly') === 'readonly' && names.includes(STATE_STORE_NAME) &&
            names.length === 2
        ) {
            sessions.push(names.join(','));
        }
        return openTransaction.call(this, storeNames, mode, options);
    });
    return () => sessions.length;
}

describe('the guards a prepared send rechecks before its carrier runs', () => {
    it('reads a first dispatch\'s supersedence and receipt from one readonly transaction', async () => {
        const { admissionStore } = createGuardsTestStores(
            `send-guards-first-${crypto.randomUUID()}`
        );
        const message = createOutboundMessage('first-dispatch');
        await admitGuardedMessage(admissionStore, message, SEND_PLANNER);

        const recorded = recordIndexedDbTransactions();
        const guards = await admissionStore.readSendGuards(message);

        expect(guards).toEqual({ kind: 'current', receiptState: undefined });
        expect(recorded.modes()).toEqual(['readonly']);
    });

    it('reads a tracked receipt beside the supersedence check in the same transaction', async () => {
        const { admissionStore } = createGuardsTestStores(
            `send-guards-receipt-${crypto.randomUUID()}`
        );
        const message = createOutboundMessage('acked-dispatch');
        await admitGuardedMessage(admissionStore, message, ACKED_PLANNER);

        const recorded = recordIndexedDbTransactions();
        const guards = await admissionStore.readSendGuards(message);

        expect(guards.kind).toBe('current');
        expect(guards.kind === 'current' ? guards.receiptState?.expectedPeerIds : undefined)
            .toEqual(['receiver']);
        expect(recorded.modes()).toEqual(['readonly']);
    });

    it('answers superseded for a replaced tracked message without reading its receipt', async () => {
        const { admissionStore } = createGuardsTestStores(
            `send-guards-superseded-${crypto.randomUUID()}`
        );
        const older = createOutboundMessage('older');
        const newer = {
            ...createOutboundMessage('newer'),
            id: { ...createOutboundMessage('newer').id, ts: older.id.ts + 1 }
        };
        await admitGuardedMessage(admissionStore, older, SUPERSEDING_PLANNER);
        await admitGuardedMessage(admissionStore, newer, SUPERSEDING_PLANNER);

        const recorded = recordIndexedDbTransactions();
        const [olderGuards, newerGuards] = [
            await admissionStore.readSendGuards(older),
            await admissionStore.readSendGuards(newer)
        ];

        expect(olderGuards).toEqual({ kind: 'superseded' });
        expect(newerGuards).toEqual({ kind: 'current', receiptState: undefined });
        expect(recorded.modes()).toEqual(['readonly', 'readonly']);
    });

    it.each(['hit', 'miss'] as const)(
        'costs a claim one guard session on a hand-off %s',
        async (handoff) => {
            const dbName = `send-guards-${handoff}-${crypto.randomUUID()}`;
            const committing = createGuardsTestStores(dbName);
            const sent: ALMessage[] = [];
            const committer = createDefaultOutboundTestRuntime({
                stores: committing,
                planOutgoingMessage: SEND_PLANNER,
                sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                    sent.push(lifecycle.canonicalMessage);
                    return { status: 'sent', submissionAttempted: true };
                }
            });
            const claims = holdOutboundClaims(committing);
            const message = createOutboundMessage(`guards-${handoff}`);
            expect((await committer.enqueueIfAbsent(message)).verdict).toMatchObject({
                kind: 'admitted',
                durable: true
            });
            await claims.release();
            if (handoff === 'miss') {
                committer.dispose();
            }
            const readSessions = recordAdmissionReadSessions();
            // A miss: a restarted runtime over the same database claims what the first one committed.
            const claimant = handoff === 'hit' ? committer : createDefaultOutboundTestRuntime({
                stores: createGuardsTestStores(dbName),
                planOutgoingMessage: SEND_PLANNER,
                sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                    sent.push(lifecycle.canonicalMessage);
                    return { status: 'sent', submissionAttempted: true };
                }
            });

            await claimant.ready();
            await runOutboundWorkTask(claimant);

            expect(sent).toEqual([message]);
            expect(
                readSessions(),
                'one guard session, and the canonical read before it only on a miss'
            )
                .toBe(handoff === 'hit' ? 1 : 2);
        }
    );
});
```

- [ ] **Step 2: Run it and see it fail.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-send-guards.test.ts
```

Expected (after Task 6; the miss case reads the canonical pair in its own session, then two guard sessions):

```text
     × reads a first dispatch's supersedence and receipt from one readonly transaction
     × reads a tracked receipt beside the supersedence check in the same transaction
     × answers superseded for a replaced tracked message without reading its receipt
     × costs a claim one guard session on a hand-off hit
     × costs a claim one guard session on a hand-off miss
TypeError: admissionStore.readSendGuards is not a function
TypeError: admissionStore.readSendGuards is not a function
TypeError: admissionStore.readSendGuards is not a function
AssertionError: one guard session, and the canonical read before it only on a miss: expected 2 to be 1 // Object.is equality
AssertionError: one guard session, and the canonical read before it only on a miss: expected 3 to be 2 // Object.is equality
      Tests  5 failed (5)
```

- [ ] **Step 3: Add `readSendGuards` to the admission store.** In
      `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts`:

```diff
--- a/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
+++ b/packages/shared/alm/outbound/admission/al-outbound-admission-store.ts
@@ -242,6 +242,11 @@ export interface ALOutboundCommitBundle<TPrepared> {
     readonly durableEffects: readonly ALOutboundDurableEffectWrite<TPrepared>[];
 }
 
+/** What a prepared send rechecks before its carrier runs: a superseded message reads no receipt. */
+export type ALOutboundSendGuards =
+    | Readonly<{ kind: 'superseded'; }>
+    | Readonly<{ kind: 'current'; receiptState: ALOutboundPendingAckSnapshot | undefined; }>;
+
 export interface ALOutboundNotYetInSyncRetrySchedule {
     readonly senderId: string;
     readonly expectedVersion: number | undefined;
@@ -278,6 +283,9 @@ export interface ALOutboundAdmissionStore<TPrepared> extends ALReadyable {
 
     readonly isMessageSuperseded: (msg: ALMessage) => Promise<boolean>;
 
+    /** The supersedence check and then the receipt state of one canonical message, read in one session. */
+    readonly readSendGuards: (message: ALMessage) => Promise<ALOutboundSendGuards>;
+
     /** True while the admission fact is retained, including after the canonical payload expired. */
     readonly hasSentMessageAdmission: (msgId: string) => Promise<boolean>;
 
@@ -430,6 +438,16 @@ class ProviderBackedALOutboundAdmissionStore<TPrepared> implements ALOutboundAdm
         return await this.backend.readWithin((session) => this.reads.isMessageSuperseded(session, msg));
     }
 
+    async readSendGuards(message: ALMessage): Promise<ALOutboundSendGuards> {
+        return await this.backend.readWithin(async (session): Promise<ALOutboundSendGuards> => {
+            if (await this.reads.isMessageSuperseded(session, message)) {
+                return { kind: 'superseded' };
+            }
+            const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
+            return { kind: 'current', receiptState: await this.reads.readReceiptState(session, receipt) };
+        });
+    }
+
     async hasSentMessageAdmission(msgId: string): Promise<boolean> {
         return await this.backend.readWithin((session) => this.reads.hasSentMessageAdmission(session, msgId));
     }
```

- [ ] **Step 4: Read the guards once in `writeAttemptedSend`.** In
      `packages/shared/alm/outbound/al-outbound-message-effects.ts`:

```diff
--- a/packages/shared/alm/outbound/al-outbound-message-effects.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-effects.ts
@@ -189,10 +189,10 @@ export class ALOutboundMessageEffects<TPrepared> {
     private async writeAttemptedSend(
         send: ALOutboundMessageEffects.PreparedSend<TPrepared>
     ): Promise<ALWorkAttemptResult> {
-        const runtime = this.dependencies.runtime;
         const { lifecycle } = send;
         const msgId = send.payload.message.msgId;
-        if (await this.dependencies.admissionStore.isMessageSuperseded(lifecycle.canonicalMessage)) {
+        const guards = await this.dependencies.admissionStore.readSendGuards(lifecycle.canonicalMessage);
+        if (guards.kind === 'superseded') {
             this.dependencies.settlements({
                 kind: 'attempt-settled',
                 msgId,
@@ -205,11 +205,7 @@ export class ALOutboundMessageEffects<TPrepared> {
             return { status: 'completed' };
         }
         // A complete receipt already stated the delivery; this attempt owes no settlement of its own.
-        const receipts = await this.dependencies.admissionStore.readReceiptState({
-            originPeerId: lifecycle.canonicalMessage.id.senderId,
-            msgId
-        });
-        if (receipts && isALOutboundReceiptComplete(receipts)) {
+        if (guards.receiptState && isALOutboundReceiptComplete(guards.receiptState)) {
             return { status: 'completed' };
         }
         if (lifecycle.expiresAtMs !== undefined && lifecycle.expiresAtMs <= this.readNowMs()) {
@@ -220,12 +216,20 @@ export class ALOutboundMessageEffects<TPrepared> {
             });
             return { status: 'completed' };
         }
-        // The abort can land here -- inside these pre-transport reads -- before the carrier ever runs;
+        // The abort can land here -- inside the pre-transport read -- before the carrier ever runs;
         // this attempt already stated `attempt-started`, so it terminates its own settlement here, the
         // same way a throwing carrier does (`writePreparedMessage`'s catch), instead of leaving it open.
         if (lifecycle.signal.aborted) {
             return this.writeCancelledBeforeTransport(send, msgId);
         }
+        return await this.writeTransportAttempt(send);
+    }
+
+    private async writeTransportAttempt(
+        send: ALOutboundMessageEffects.PreparedSend<TPrepared>
+    ): Promise<ALWorkAttemptResult> {
+        const runtime = this.dependencies.runtime;
+        const { lifecycle } = send;
         const retry = retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, send.attempts, runtime.random());
         const sendResult = await runtime.sendPreparedMessage(send.payload.prepared, send.payload.phase, lifecycle);
         const timing = {
```

- [ ] **Step 5: Run the new test and the two suites that inject into the pre-transport read.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-send-guards.test.ts packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/alm/outbound-delivery-settlements.test.ts
```

Expected: the new file passes; two existing tests fail because their spy targets a read the send no
longer makes, so the injected event never lands:

```text
     × does not send when the deadline passes during the receipt read
   × cancels an attempt still inside its pre-transport reads: no transport call, one settlement pair over memory
   × cancels an attempt still inside its pre-transport reads: no transport call, one settlement pair over indexeddb
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
AssertionError: expected [ 'send' ] to deeply equal []
      Tests  3 failed | 53 passed (56)
```

- [ ] **Step 6: Move those two injections to the merged read.** Their assertions stay as they are:
      the deadline still passes, and the abort still lands, inside the pre-transport read.

```diff
--- a/packages/tests/shared/al-outbound-durable-effects.test.ts
+++ b/packages/tests/shared/al-outbound-durable-effects.test.ts
@@ -49,9 +49,11 @@ describe('AL outbound durable effect lifecycle', () => {
         vi.setSystemTime(1_000);
         const stores = createDefaultOutboundTestStores();
         const send = vi.fn(async () => ({ status: 'sent' as const, submissionAttempted: true }));
-        vi.spyOn(stores.admissionStore, 'readReceiptState').mockImplementation(async () => {
+        const readSendGuards = stores.admissionStore.readSendGuards.bind(stores.admissionStore);
+        vi.spyOn(stores.admissionStore, 'readSendGuards').mockImplementation(async (message) => {
+            const guards = await readSendGuards(message);
             vi.setSystemTime(2_000);
-            return undefined;
+            return guards;
         });
         const runtime = createDefaultOutboundTestRuntime({
             stores,
--- a/packages/tests/shared/alm/outbound-delivery-settlements.test.ts
+++ b/packages/tests/shared/alm/outbound-delivery-settlements.test.ts
@@ -717,11 +717,11 @@ it.each(BACKEND_KINDS)(
             }
         });
         const message = createOutboundMessage('msg-cancelled-pre-transport');
-        // The abort lands mid-await, inside `writeAttemptedSend`'s own reads -- before its carrier runs.
-        const readReceiptState = stores.admissionStore.readReceiptState.bind(stores.admissionStore);
-        vi.spyOn(stores.admissionStore, 'readReceiptState').mockImplementationOnce(async (receipt) => {
-            runtime.cancel(receipt.msgId);
-            return await readReceiptState(receipt);
+        // The abort lands mid-await, inside `writeAttemptedSend`'s own read -- before its carrier runs.
+        const readSendGuards = stores.admissionStore.readSendGuards.bind(stores.admissionStore);
+        vi.spyOn(stores.admissionStore, 'readSendGuards').mockImplementationOnce(async (sent) => {
+            runtime.cancel(sent.id.msgId);
+            return await readSendGuards(sent);
         });
 
         await enqueueOutboundOrThrow(runtime, message);
```

- [ ] **Step 7: Run them green.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-send-guards.test.ts packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/alm/outbound-delivery-settlements.test.ts packages/tests/shared/alm/outbound-supersedence-concurrency.test.ts packages/tests/shared/alm/al-outbound-message-expiry.test.ts
```

Expected: every file passes (prototype, with `packages/tests/shared/alm/outbound` added: `Tests  294 passed (294)`).

- [ ] **Step 8: Lower the warm ledger pins by the measured delta.** In
      `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts`, outbound warm send: chain
      **−1** (9 → 8 after Tasks 5 and 6), total **−1** (12 → 11); requests and operations unchanged.
      Reason string: `'a prepared send reads its supersedence and receipt guards in one session'`.
      Measured with the probe on Task 6 + this task: chain 10 → 9, total 13 → 12, requests 44 → 44,
      operations 10 + 10 → 10 + 10. The cold operation pin in `al-indexeddb-operation-counts.test.ts` does
      not move. Run:

```sh
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
```

Expected: both files pass.

- [ ] **Step 9: Update the outbound README.** In `packages/shared/alm/outbound/README.md`, the
      `send-prepared` row of "Admission and invocation paths":

```diff
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -219,7 +219,7 @@ transport action and does not confirm the logical audience; a server receipt doe
 | `acceptControlMessage`       | Repair admission checks that this scope owns the control, then `ALOutboundControlAdmission` validates identity, control history, and pending receipts and commits control state and repair work together.                                               | The runtime wakes the existing worker; repair admission schedules a not-yet-in-sync retry when the committed control is a not-yet-in-sync NACK.                                                                                                                             |
 | `admit-message` work         | `ALOutboundMessageEffects` reads pending admission authority, rechecks the retained deadline, and commits the retained policy through dispatch admission.                                                                                               | The claim completes. Rejected or expired authority completes without admitting; a not-ready authority reschedules with its own delay.                                                                                                                                       |
 | `dequeue-message` work       | A foreign queue row this owner admits: `ALOutboundMessageEffects` first reads the carrier's pending admission authority with no prepared copies, then rereads the message, drops it when superseded, and commits a dispatch plan.                       | Circuit-open resilience reschedules; a `not-ready` authority holds the claim (one `not-ready` attempt, re-checks in memory); `no-route` retries; expired, superseded and skipped complete; an admitted plan completes and runs the configured `afterDequeueAdmission` port. |
-| `send-prepared` work         | `ALOutboundMessageEffects` rechecks supersedence, receipt completion, deadline, and abort before calling the transport.                                                                                                                                 | An immediate outcome completes or reschedules; a queued native send is retained until the transport settles it.                                                                                                                                                             |
+| `send-prepared` work         | `ALOutboundMessageEffects` rechecks supersedence and receipt completion from one read session (`readSendGuards`), then the deadline and abort, before calling the transport.                                                                            | An immediate outcome completes or reschedules; a queued native send is retained until the transport settles it.                                                                                                                                                             |
 | `ack-timeout` work           | Repair admission rereads the receipt snapshot. Before the deadline it recommits the next timeout; at it, it charges one attempt and commits the next timeout plus a `repair-hint`, clears a complete receipt, and out of budget schedules nothing more. | New work is available to the existing engine; the schedule never sends directly.                                                                                                                                                                                            |
 | `repair-hint` / `nack-retry` | Repair retransmission reresolves the cached message (by ordering track when the hint names missing sequences), applies repair policy, and commits a fresh dispatch through dispatch admission.                                                          | New work is available to the existing engine; retransmission does not recursively invoke the work handler.                                                                                                                                                                  |
 | Startup / scheduled wakeup   | `ALWorkQueuePort.claim` reserves; `ALOutboundAdmissionEffectStore` then decodes and validates the claimed row (`readWorkSnapshot`, `validateObservedWork`). Malformed work becomes `NON_RETRYABLE`; valid claims remain independently available.        | One batch runs at a time and its claims run in order; a commit landing behind a batch earns one follow-up batch. QueueBox compares the exact reservation on release, so an old worker cannot alter a newer claim.                                                           |
```

- [ ] **Step 10: Run the semantic suites.**

```sh
ls packages/tests/shared-web/al-runtime/
npx vitest run packages/tests/shared/alm packages/tests/shared-web/al-runtime
```

Expected: the six files listed in Task 6; `Test Files  95 passed (95)`, `Tests  1166 passed (1166)`.
(Prototype: one run under full-suite load failed the inbound-only `browser-al-runtime-stores.test.ts >
keeps the session inbound memory pair out of IndexedDB, so session cleanup never reaches it`; it passed
in four reruns, alone and in the full set. This task touches no inbound path.) Then, sandbox off:

```sh
npx vitest run packages/tests/shared packages/tests/api-v1/psql-admission-work.test.ts
```

Expected: `Test Files  1046 passed | 4 skipped (1050)`, `Tests  9704 passed | 12 skipped (9716)` (prototype).

- [ ] **Step 11: Type checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
node scripts/check-tests-typecheck.mjs
cd apps/api-v1 && deno task check; cd -
```

Expected: as in Task 6 (`check-tests-typecheck: 1400 test files enforced, 0 files carrying known debt
(0 errors).`; `deno task check` exits 0).

- [ ] **Step 12: Format, bundle figures, style.**

```sh
npx dprint fmt packages/shared/alm/outbound/admission/al-outbound-admission-store.ts packages/shared/alm/outbound/al-outbound-message-effects.ts packages/shared/alm/outbound/README.md packages/tests/shared/alm/outbound/al-outbound-send-guards.test.ts packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/alm/outbound-delivery-settlements.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Expected: `browser/rallar.ts` brotli about +0.2 KiB over Task 6 (prototype 228.7 KiB `< 229.0 KiB | ok`);
both bundle tests pass. A crossed budget is raised to the next whole KiB with the measured figure.

- [ ] **Step 13: Commit.**

```sh
git add packages/shared/alm/outbound/admission/al-outbound-admission-store.ts packages/shared/alm/outbound/al-outbound-message-effects.ts packages/shared/alm/outbound/README.md packages/tests/shared/alm/outbound/al-outbound-send-guards.test.ts packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/alm/outbound-delivery-settlements.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
git commit -m "Read a prepared send's supersedence and receipt guards in one session

The attempt reads the supersedence check and then, unless superseded, the
receipt state in one readonly session instead of two. The guards keep their
order and their place after attempt-started, so a failing read still ends
the attempt it stated."
```

- [ ] **Step 14: Changed-range gates on the commit.**

```sh
npm run check:repo-style:changed -- <task-7-base> HEAD
node scripts/check-test-structure-coupling.mjs --changed <task-7-base> HEAD
```

Expected: `PASS: no new repository style findings`; `PASS: changed-range structure-coupling review has
complete individual classifications`.

---

### Task 8: Close: final figures, gates, hosted proofs, the PR body and the plan file

Runs after tasks 1–7 are committed, reviewed and pushed. It records the final pins and figures, runs the local
merge bar, runs one final whole-branch review with one fix wave, takes the branch through the Branch Release Gate,
the hosted ALM manifests and the ALM observation, publishes the PR title and body, and deletes this plan file in its
last commit. It never merges and never takes the PR out of draft on its own.

**Files**

- Modify: `playground/alm/alm-qos-product-plan.md` §7.1 (the measured figures after P1a, with the commit they were
  measured on), `packages/shared-web/bundle-budgets.json` and
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` only if a budget is crossed.
- Modify (fix wave only): the files the final review's Critical and Important findings name.
- Delete (last commit): `plans/active/alm-p1a-codec-and-send-chain-implementation-plan.md`.
- Create (never committed): `tmp/p1a-task8/**` (logs, artifacts, `pr-body.md`, `hosted.md`).
- Test: the local merge bar (steps 3–7); no new test file.

**Interfaces**

- Consumes: task 1's ledger test at its final figures (chain ≤ 8, total ≤ 11, `al-admission` 10, `al-work` 8;
  inbound ≤ 13 / ≤ 7 / 8); task 2's harness (`npm run perf:alm:durable-send`) and its before-figures in
  `.superpowers/sdd/alm-p1a-codec-and-send-chain-implementation-plan/evidence/harness-before.md`; tasks 3–7 pushed.
- Produces: code head `H1` (reviewed and gated), final head `H2` (H1 plus the last commit), the PR title and body.

Throughout: `WT=/Users/knuthelge/ProjectLocker/github/ar-eye-hunter/.claude/worktrees/alm-p1`,
`R=intact-software-systems/ar-eye-hunter`, `B=claude/alm-p1-durable-path-cost`, `T=$WT/tmp/p1a-task8`,
`E=$WT/.superpowers/sdd/alm-p1a-codec-and-send-chain-implementation-plan/evidence`. Every `gh`, `git fetch`,
`git push`, `docker` command, every lane, Playwright run and black-box runner, and `npm run test:unit` need the
sandbox disabled. Use `gh run list` and `gh run view`, never `gh pr checks`.

**Lane rule.** One lane at a time on this machine: the ALM lane, `test:e2e`, `test:full-stack:memory`, the harness
and the black-box runners share ports 18080–18082, 5177, 5178 and 5180, and Playwright attaches to whatever already
listens there. Before every lane:

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
test -f $E/harness-before.md && echo HARNESS-BEFORE
gh pr view 627 -R $R --json mergeable,mergeStateStatus --jq '[.mergeable, .mergeStateStatus] | @tsv'
```

Expected: no status output; the two hashes equal; `0` variables; `HARNESS-BEFORE`; `MERGEABLE`. If main moved
(the `wc -l` is not `0`) or the PR reads `CONFLICTING`, merge main first: `git -C $WT merge --no-ff origin/main -m
"Merge origin/main into $B"`, resolve keeping both sides' behaviour and tests, `npm ci` if `package-lock.json`
changed, then `npm run typecheck 2>&1 | tail -3` and `node scripts/check-test-reachability.mjs` before step 2.

- [ ] **Step 2: Final ledger, cold pin and bundle figures**

```sh
cd $WT && npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts 2>&1 | grep -E "✓|✗|Tests  "
grep -n -E "toHaveLength\(|toBe\([0-9]+" packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts | head -20
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles | grep -E "browser/rallar(-core|-realtime|-data|-crdt)?\.ts "
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts 2>&1 | grep -E "KiB|Tests  "
```

Expected: both pin files pass; the ledger pins read chain `8`, total `11`, `al-admission` `10`, `al-work` `8` (or
lower, with the reason strings tasks 5–7 wrote), inbound `13` / `7` / `8`; the cold pin reads `10` and the
`al-work` figure task 6 measured (11 from code). Record the five bundle lines and the headless figure in
`$T/figures.md`. If `browser/rallar.ts` or the headless bundle exceeds its budget, set the budget to the next whole
KiB above the measured figure in the data file (never higher), and commit `chore(bundles): raise the <entry> budget
to <N> KiB (measured <x.xx> KiB at <sha>)`; the figure and the reason go into the PR body.

- [ ] **Step 3: Harness after-figures**

Three runs, sandbox disabled, no other lane running:

```sh
cd $WT && for k in 1 2 3; do npm run -s perf:alm:durable-send 2>&1 | tee $T/harness-after-$k.log | grep -E "p50|p95|polyfill|codec|artifact"; done
ls -t tmp/perf/alm-durable-send/*.json | head -3
```

Expected: three artifacts; each of the four configurations (idle, 4× CPU, 1× with the frame load, 4× CPU with the
frame load) reports send-to-dispatch p50 and p95, and the profile line reports the CPU shares of the polyfill, JSBI
and the codec. The machine must be quiet (load average below about 5: `uptime`); if the load average differs from
the one recorded in `$E/harness-before.md`, first re-run the three before-runs at the Task 2 commit
(`git -C $WT worktree add $T/before <task-2 sha>` with `node_modules` symlinked, `npm run -s perf:alm:durable-send`
there three times, then `git worktree remove --force $T/before`) back to back with the after-runs, so both sides
share one session's noise. Write `$E/harness-after.md` with the three runs beside the before-figures
from `$E/harness-before.md`, the machine, the Chromium version, and the commit each was measured on. The after-p95
under the frame load at 4× CPU is the figure D89 reads after P1b; here it is recorded, not judged. A run whose
before-and-after differ by less than the machine's run-to-run spread (the three before-runs' spread) is reported as
"within noise", never as a gain.

- [ ] **Step 4: Local merge bar, static checks**

```sh
cd $WT
npm run typecheck 2>&1 | tail -3
npm run build 2>&1 | tail -15
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
npm run check:test-reachability
(cd apps/api-v1 && deno task check) && (cd apps/rallar-black-box-control-server && deno task check) && (cd apps/relic-hunter-server-v1 && deno task check)
npx dprint check $(git diff --name-only origin/main HEAD | tr '\n' ' ')
```

Expected: `check-tests-typecheck: N test files enforced, 0 files carrying known debt (0 errors)`; build exits 0
with no `error` line; `PASS: no new repository style findings`; the coupling check prints `PASS:`;
`check:test-reachability` exits 0 (the harness spec is owned by `tests/manual-suites.json`); the three Deno checks
exit 0; dprint check exits 0.

- [ ] **Step 5: Local merge bar, `test:ci`**

Sandbox disabled, lane rule applies:

```sh
cd $WT && npm run test:ci 2>&1 | tee $T/test-ci.log | grep -E "Test Files|Tests  |ok \||passed|failed|flaky"
```

Expected, in order: Vitest `Test Files  N passed | K skipped (N)` and `Tests  N passed | K skipped (N)` with 0
failed; four Deno blocks each `ok | N passed | 0 failed`; Playwright `test:rallar` and the recipe console `N
passed`; the in-memory full stack `N passed`. Known intermittent reds that pass alone: `repo-style-changed-check.test.ts`
and `state-write-malformed-evidence.test.ts` (timeouts under load), the memory-QueueBox work-page test, and
`full-stack-quick-test-ws`. Rerun such a file alone, record both results, then rerun `npm run test:ci`; a red that
repeats alone is a defect.

- [ ] **Step 6: Local merge bar, API black-box on Postgres**

```sh
docker ps --filter name=ar-eye-hunter-postgres --format '{{.Status}}'
cd $WT && npm run test:api-v1:black-box:memory 2>&1 | tee $T/bb-memory.log | grep "Matrix profile\|FAILED"
npm run test:api-v1:black-box:postgres 2>&1 | tee $T/bb-postgres.log | grep "Matrix profile\|FAILED"
```

Expected: the container `Up ...` (if stopped: `docker start ar-eye-hunter-postgres`; never `db:test:up`, never
`db:down`); every `Matrix profile <name>: passed=N failed=0 skipped=K` line with `failed=0`. The medium-scale gate
is not required: P1a changes no api-v1 mutation path (`git diff origin/main --stat -- apps/api-v1
packages/shared-server` shows nothing); if it shows anything, run
`npm run test:api-v1:black-box:postgres:medium-scale` too.

- [ ] **Step 7: Local merge bar, the full ALM lane**

```sh
cd $WT && rm -rf apps/rallar-black-box/test-results
RALLAR_BLACK_BOX_ALM_SCOPE=full npm run -s test:rallar:full-stack:memory:alm 2>&1 | tee $T/alm-full.log | grep -E "family over|passed|failed|flaky|skipped"
for F in apps/rallar-black-box/test-results/alm-observation/*-full*.json; do case $F in *-snapshot.json|*-page-diagnostics.json) ;; *) printf '%s ' $F; jq -r '.cellOutcome + " " + .regime' $F;; esac; done
```

Expected: every `baseline`, `addressed` and `three-agent` family over `ws`, `rtc` and `rtc-with-ws-fallback` in
`(full)` passes, `durable-opt-in` and `delivery-baseline` included; the summary shows `N passed` and no `failed` or
`flaky`; every cell file reads `passed`. Harness budgets unchanged (`git diff origin/main --
packages/shared-test/rallar-bb-test/conformance` touches no timeout constant).

- [ ] **Step 8: Final whole-branch review, three seats, and one fix wave**

Per the subagent-driven-development skill's final review: dispatch the reviewer on the most capable model with the
whole-branch diff (`git diff origin/main...HEAD`, packaged to a file), the spec (`playground/alm/alm-p1-design-proposal.md`
§2.1, §5) and the Global Constraints, in three seats: product (guarantees unchanged: fence, supersedence,
settlement, expiry, group commit, volatile lane), harness (the ledger and the harness measure what they claim), and
code quality (repo style, sizes, names, READMEs true). ONE fix dispatch for every Critical and Important finding,
one scoped re-review, residual minors adjudicated in the ledger. Each fix is a TDD commit. Then repeat steps 2, 4
and the focused tests the fixes touched; steps 5–7 are repeated only if a fix touched product code.

- [ ] **Step 9: Push the code head and read the gate**

```sh
cd $WT && git push origin HEAD:$B && git rev-parse HEAD > $T/H1
gh run list -R $R --branch $B --limit 6 --json name,status,conclusion,databaseId,headSha --jq '.[] | "\(.databaseId) \(.name) \(.status) \(.conclusion) \(.headSha[0:9])"'
```

Poll `gh run view <RUN> -R $R --json status,conclusion` every few minutes (foreground `gh`, sandbox disabled).
Expected: `Branch Release Gate` `success` on H1; read every failed job from its log and artifacts
(`gh run view <RUN> --log-failed`, `gh run download`), never from a theory; a fix is a TDD commit with a
counter-case, pushed, and the gate is read again on the new head.

- [ ] **Step 10: Hosted manifests 18 and 22 from the branch**

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

- [ ] **Step 11: ALM observation, smoke on three consecutive runs and at most two full reads**

The gate on H1 started `alm-conformance-observation.yml` beside it (smoke). Add two smoke re-runs of that job
with no push in between, then at most two full reads:

```sh
gh variable list -R $R | grep -c RALLAR_BLACK_BOX_ALM_SCOPE
gh run list -R $R --workflow alm-conformance-observation.yml --branch $B --limit 3 --json databaseId,status,conclusion,headSha
gh run rerun <OBS_RUN> -R $R
gh run view <OBS_RUN> -R $R --log 2>/dev/null | grep -E "family over|passed|failed|regime=" | tail -20
```

Expected: `0` variables; three attempts each `success`, each log showing every `(smoke)` family `passed`. Then,
for each full read (the second only if the first ran fewer cells than the lane has, or a fix went in after it):

```sh
gh variable set RALLAR_BLACK_BOX_ALM_SCOPE -R $R --body full
gh run rerun <OBS_RUN> -R $R
gh run view <OBS_RUN> -R $R --json status,conclusion
```

Poll until `completed` (at most 30 minutes), then at once:

```sh
gh variable delete RALLAR_BLACK_BOX_ALM_SCOPE -R $R
gh variable list -R $R | grep -c RALLAR_BLACK_BOX_ALM_SCOPE
gh run view <OBS_RUN> -R $R --log > $T/alm-full-read-<k>.log; grep -E "family over .*\(full\)|passed|failed|regime=" $T/alm-full-read-<k>.log
```

Expected: the delete succeeds and the count is `0` (if the session may end before the job completes, write in
`$T/hosted.md`: "delete RALLAR_BLACK_BOX_ALM_SCOPE once run <id> completes"). Acceptance, cell by cell, against
#566's accepted read: every `ws` cell passed; `addressed` and `three-agent` over `rtc` passed; `baseline` over `rtc`
passed or failed only at `not-yet-in-sync-delivered-after-refresh` `received-1`; `rtc-with-ws-fallback` cells any
outcome, recorded (the 30-minute job timeout cuts them). Any WS red, or an RTC red at another step, is not accepted:
download the artifact and diagnose before a second read.

- [ ] **Step 12: The last commit: the figures and the plan file**

In `playground/alm/alm-qos-product-plan.md` §7.1, add the measured after-figures (the ledger counts and the
harness p50/p95 per configuration) with the commit they were measured on, as a "measured (P1a, <sha>)" label, and
delete this plan file:

```sh
cd $WT && git rm plans/active/alm-p1a-codec-and-send-chain-implementation-plan.md
npx dprint fmt playground/alm/alm-qos-product-plan.md
git add playground/alm/alm-qos-product-plan.md
git commit -m "Record P1a's measured figures and close its plan"
git push origin HEAD:$B && git rev-parse HEAD > $T/H2
```

Expected: the commit contains only the two paths; the Branch Release Gate runs again on H2 and is read as in step
9 (docs-only, so the earlier hosted and observation reads on H1 stand; the PR body names both heads).

- [ ] **Step 13: The PR title and body**

Title: `ALM Release 4, P1a: the codec and the send chain (D108–D111)`. Body sections in this order: Goal, Changes
(one bullet per task, the pin each moved), Acceptance (the ledger figures before and after; the harness table from
`$E/harness-after.md`; the bundle figures and any budget raise; the ALM lane full read and manifests 18 and 22, run
ids), Validation (steps 4–7 and 9–11 with counts and run ids, measured on H1; the H2 gate), Rulings (every `Ruling:`
line from the SDD ledger, with what it costs if wrong), Risk and rollback (revert the merge commit; no schema change,
so no reset), Follow-up (P1b; the fence-snapshot fold; bundle removal; the native alias; the D89 reading after P1b),
and the attribution line. Publish with `gh pr edit 627 -R $R --title "..." --body-file $T/pr-body.md`. Leave the PR
in draft; the maintainer reviews and merges. Then write `Task 8: complete` and `PLAN COMPLETE <date>: PR #627 at

<H2>` in the ledger.

- [ ] **Step 14: After the maintainer merges**

Watch main's `Push on main`, `Deploy Web + API` and `Run Hetzner Supported Distributed Manifests` on the merge
commit (`gh run list -R $R --branch main --limit 4`), report them, and record P1a as delivered in memory. P1b's plan
is written next, from P1a's measured figures.

---
