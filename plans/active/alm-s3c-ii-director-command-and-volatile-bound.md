# ALM S3c-ii The Director Command and the Volatile Bound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** written on 2026-09-28 after S3c-i merged (`322c50854`, #605), on the branch of PR #606, which also carries
the persistence and performance QoS plan ([alm-qos-product-plan.md](../../playground/alm/alm-qos-product-plan.md),
D83–D90). The decisions are the maintainer's of 2026-09-28 (D60, D70, D74, D75, D78; proposal §10 Q9–Q13). The
post-S3c-i code survey found fourteen corrections and eleven questions the decisions leave open; this plan answers
them as choices C1–C17, each the survey's recommended option, ruled R-S3c-ii-0 in "Rulings during execution". The
maintainer reviews them with the PR and may overturn any of them.

**Goal:** A typed send can address one peer over RTC with a WS fallback inside the deadline; AR Eye Hunter's pickup,
combat and sync-request intents travel `command` channels to the director with the director's receipt; the volatile
store keeps rows for the deadline plus the receipt grace and is bounded per session with a typed `capacity` refusal; a
failed delivery states a typed failure; and the conformance lane proves the addressed-send scenarios.

**Architecture:** The RTC carrier already plans a direct unicast, and the S3b dispatch, fallback controller and
settlement-free hand-over are target-agnostic, so the RTC unicast is a sender path: one room-naming unicast envelope
admitted on RTC and re-admitted unchanged on WS, where S3c-i's router delivery and one-member receipt take it. The
director relay sends intents through two typed `command` channels and subscribes the director to their type ids on
the ALM RTC inbox; the realtime targeted leg and `sendWsUnicast` are deleted. The volatile pair's long-lived rows
expire at the message deadline plus the receipt grace through one exported rule. One budget per session, a ledger
keyed by message id and released at each message's deadline, is consulted by the outbound admission of the two
volatile outbound pairs and fed by the inbound pair; over the bound an outbound data admission is refused `capacity`
and the session's QoS provider reports `overloaded`. The delivery reducer states a typed `failure` beside the prose
reason.

**Tech Stack:** TypeScript across Node, Deno and browser; Vitest; Deno test; the black-box JSON recipe runner and the
Playwright conformance lane; dprint.

**Spec:** [playground/alm/alm-s3-design-proposal.md](../../playground/alm/alm-s3-design-proposal.md) §1.4, §1.5,
§2.3, §8, §10 (Q9–Q13); [playground/alm/alm-improvement-plan.md](../../playground/alm/alm-improvement-plan.md) (D2,
D3, D8, D13, D15, D24, D42, D51, D53, D54, D55, D59, D60, D63–D66, D70, D71, D74, D75, D76, D78, D82, the S3 bullet,
matrix rows F1, F4, F5, "Consumer proofs in the games");
[playground/alm/alm-qos-product-plan.md](../../playground/alm/alm-qos-product-plan.md) §5, §6, §7.2, §10.3 (D83–D90);
the S3c-i plan's "Carried to S3c-ii / later"
([plans/alm-s3c-i-addressed-sends-and-server-receipts-implementation-plan.md](../alm-s3c-i-addressed-sends-and-server-receipts-implementation-plan.md)).
S3c-ii starts from `main` `322c50854`. The code survey is the session scratchpad `s3c-ii-code-survey.md`; every line
number below was read on `322c50854`.

## Global Constraints

The S3c-i constraints apply unchanged (D8 search-first, no legacy, touched-file closure, canonical verbs, values not
exceptions, required fields, the size tiers, the non-blocking lane, the push-time gate list, maintainer-reviewed
landing), with S3c-ii's values:

- **No migration.** Reset-on-mismatch is the only lever (D3, D17). S3c-ii persists no new field (C16): the typed
  failure lives on the in-memory handle, the receipt-exhausted cause on a settlement, the budget in memory, and the
  retention rule changes expiry values, not shapes. `AL_ADMISSION_SCHEMA_ID`
  (`packages/shared/alm/open-indexed-db-admission-database.ts:16`) stays `'rallar-alm-2026-09-s3c-i'`. **Bump rule:** a
  task that finds a persisted field unavoidable bumps it to `'rallar-alm-2026-09-s3c-ii'` in the same commit and the
  PR body names what a deploy discards.
- **No new third-party dependency** (D8).
- **No new timer, queue or registry beyond the session budget.** `ALVolatileSessionBudget` is one `Map` per session,
  released on read; it schedules nothing.
- **No legacy** (C15): `sendWsUnicast`, the realtime targeted leg for intents, and the WS-only names
  (`createBrowserWsUnicastMessage`, `validateBrowserWsPeerInput`, `validateBrowserWsPeerServer`) are renamed or deleted
  with every caller in the same commit; no alias stays.
- **PR #566** (open, conflicting with `main`, rewriting the WS server path and
  `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`) is not a base for this plan. S3c-ii changes that
  file only if a behaviour cannot live elsewhere, and then by the smallest hunk (Task 4 states whether it does).
- **Harness budgets fixed:** `CONNECT_READINESS_TIMEOUT_MS` 30 000, `CONFORMANCE_DEADLINE_MS` 18 000,
  `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500, `CARRIER_TEST_TIMEOUT_MS` 480 000, regimes 30/35 ms.
- **Bundle ceilings:** facade `browser/rallar.ts` 224 KiB (recorded 223.056640625 in the test; 223.84 measured on the
  final S3c-i head), headless 286 KiB (recorded 285.8173828125; 285.857 measured on the merged head), raised only by
  the next-whole-KiB rule (maintainer ruling 2026-09-05) with the measured figure recorded in the test comment, the
  measure script and the task commit. Headroom is under 0.2 KiB on both, so every task that reaches the browser
  measures and raises a crossed entry in the task that crosses it.
- **Storage budgets (D87).** The operation-count pins in
  `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` may only fall. Every volatile send, the director
  intents included, stays at zero `al-admission` and zero non-probe `al-work` operations. The PR body reports the
  storage figures beside the bundle figures.
- **`rallar.realtime` untouched as a public surface** (D15). Public surface that moves: the typed `send` accepts
  `peerId` on `rtc` and `rtc-with-ws-fallback`; `ALDeliveryEvidence.failure`; the exported type names
  `ALDeliveryFailure` and `ALDeliveryReceiptExhaustedCause` wherever `ALDeliveryEvidence` is exported (the public API
  snapshot moves for those two names only).
- **The mutation doctrine** (`.agents/skills/rallar-code-writing/references/convergent-service-writing.md`). S3c-ii
  adds no server database mutation. The medium-scale PostgreSQL gate runs locally only if a task changes
  `packages/shared/services/ws-queue-box-server/**` (Q13); CI runs it on every `packages/shared/**` change regardless.
- Files at a cognitive-load tier take call lines only; new behaviour goes into new files beside the owner:
  `web-rtc-overlay-multicast-manager.ts` (918 lines), `al-outbound-message-runtime.ts` (630),
  `browser-rallar-message-sender.ts` (458), `browser-director-relay-session.ts` (417), `al-runtime-stores.ts` (285; 11
  runtime value exports, add none), `to-arena-labels.ts` (11 value exports, add none), `al-contract.ts`,
  `al-policy.ts`. `packages/shared-test/rallar-bb-test/conformance/alm/` holds 20 direct files, the directory-density
  threshold: new scenario files go under `scenarios/`.
- **Per-task validation** (every task, before its commit; a task names the extra gates it needs):
  - the focused Vitest files the task names (`npx vitest run <files>`), then `npm run test:unit` (both Vitest roots)
    before the push — grep the summary line, not the exit code;
  - `npm run typecheck` (includes `npm run typecheck:tests`);
  - `npm run check:repo-style:changed -- origin/main HEAD`;
  - `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` (commit a registry fix before
    re-running: the checker reads the head revision);
  - `npx dprint check <every touched file>` (never a glob; `npx dprint fmt <files>` only on touched files);
  - whenever `packages/shared`, `packages/shared-server` or `packages/shared-test` changed:
    `cd apps/api-v1 && deno task check`, `cd apps/rallar-black-box-control-server && deno task check`,
    `cd apps/relic-hunter-server-v1 && deno task check`, then `npm run test:deno`;
  - for any change reaching the browser:
    `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
    and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
  - the smoke lane `RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm` (unsandboxed;
    verify the summary line; one lane runner at a time on ports 18080/5180; no edits while it runs) after Tasks 3, 4, 5
    and 6;
  - `npm run test:repo-governance` when docs under `docs/`, `examples/` or `.agents/` change.
- Every task ends with a commit, pushed with `git push origin HEAD:codex/queuebox-persistence-qos-product-plan`
  (PR #606; never `main`).
- Acceptance follows D51: the local full lanes on normal pages plus the both-normal hosted smoke; the hosted full read
  is attempted at most twice and reported, never a blocker (Q13). The observation job's 30-minute timeout no longer
  fits the full scope on slow runners (S3c-i's two unusable reads); that is reported, not worked around.
- PRs land through the maintainer's review: no `pr:delivery -- ready`, no auto-merge.
- **The plan file's life** (`plans/README.md`): this file lives at `plans/active/` while S3c-ii is in flight; Task 7
  deletes it in the last commit before the maintainer's merge, after its rulings are folded into the proposal (§11).

---

## Pre-execution rulings

### The survey's corrections to §10

1. The rows the volatile pair keeps for an hour are the sent-message and message-owner rows (reference, captured
   policy, ids), not the envelope, which expires at the message deadline. A count bound over the raw pair measures
   retention; a byte bound mostly does not. The budget therefore counts admissions by their own envelope bytes and
   releases them at their own deadline (C4), and the retention rule is fixed first (C5, Task 2).
2. An RTC room unicast is also checked at dispatch against the server topology edge. An addressee that is
   RTC-connected but not the origin's overlay next hop settles `not-ready` on every attempt and falls back after
   `AL_FALLBACK_NOT_READY_ATTEMPTS` (3); it does not read `no-route` at admission.
3. An RTC unicast on a `room.*` topic without `groupRef` is refused `unauthorized` at admission, which is no fallback
   trigger. The RTC unicast names its room.
4. `carrier-refused` is never an end settlement. It is evidence of a hand-over. A refusal outside the fallback list is
   an `admission` settlement that ends `rejected`, and its typed reason is dropped today (C1, C2).
5. The director does not dedup by message id. The game layer refuses a lower sequence as `stale-sequence` across all
   intents of one sender, so a retried or fallback-reordered intent is dropped while its receipt reads `acknowledged`
   (C10).
6. Under default QoS `overloaded` drops only best-effort messages, the WS outbound path never consults it, and the
   product facade installs no provider (C13 states the limits).
7. The "relay row" is the RTC relay peer's inbound pending-ACK row in the browser, kept until the message deadline; no
   figure for it is recorded anywhere (C14).
8. "One `command` channel" needs two typed channels, because a channel fixes one `typeId` (C12). The
   `GAME_DIRECTOR_*_TYPE_ID` constants are unused.
9. The public API snapshots pin export names only, so `peerId` on an existing input moves no snapshot.
10. The medium-scale gate runs in CI on any `packages/shared/**` change; the `ws-queue-box-server/**` rule of Q13 is
    plan policy for the local run.
11. The director relay's WS fallback is refused by authorization (it names no room), and the relay still reports
    `sent` (C15).
12. Without a subscription for the intent type ids on the ALM RTC inbox, an RTC command is acknowledged and then
    parked until it expires (Task 5).
13. The lane cannot name a peer, and no connect field lowers a setting (C11).
14. N1, "refuse a peer send whose `contextId` differs from its room at the sender", was parked in the S3c-i re-review
    and is recorded nowhere in the repository (C8).

### Choices this plan makes inside those answers

| Choice | What it decides                                                                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1     | `capacity` joins `ALDeliveryRefusalReason` and `ALOutboundDropReasonCode`; a refused admission ends `rejected`; `capacity` stays out of the fallback lists; D78's "as `carrier-refused`" is recorded as applied "`rejected` with `evidence.failure`". |
| C2     | `evidence.failure` is the discriminated union `ALDeliveryFailure`, set by the reducer; `receipt-exhausted` states a typed cause at its two producers.                                                                                                 |
| C3     | The budget is created per session in `initialise-browser-middleware.ts`, handed to the three volatile pairs, and read by a per-session QoS provider that wraps the application's.                                                                     |
| C4     | The budget counts data admissions the session originates or receives; controls, receipts, ACKs, NACKs, repairs, retransmissions and relay forwards are exempt; each is released at its own message deadline.                                          |
| C5     | Volatile retention is a rule in the row writers: deadline plus `AL_RECEIPT_DEADLINE_GRACE_MS`. Durable rows keep today's rule.                                                                                                                        |
| C6     | Only the sender's outbound admission refuses over the bound; an inbound admission is counted, never refused.                                                                                                                                          |
| C7     | `RallarRtcSendInput` is unchanged; `peerId` is accepted on the typed `send` for `ws`, `rtc`, `rtc-with-ws-fallback`; `ws-then-rtc` with a `peerId` stays refused (V1).                                                                                |
| C8     | A peer send whose `contextId` differs from its room is refused at the sender, for every strategy (N1).                                                                                                                                                |
| C9     | A peer send to the server id is refused `unsupported` on `rtc` and `rtc-with-ws-fallback`; the server-unknown refusal also covers `rtc-with-ws-fallback`.                                                                                             |
| C10    | The director accepts client intents out of order: an equal sequence is a duplicate, a lower one is accepted. Director outputs keep the stale rule.                                                                                                    |
| C11    | The lane names a peer by role (`toPeer`: `server` or `receiver`, as amended by R-S3c-ii-2); a lane-only connect field lowers the volatile bound, never a public connect option.                                                                       |
| C12    | Intents and sync requests use two typed `command` channels on the existing derived type ids.                                                                                                                                                          |
| C13    | `overloaded` is true while the budget is at or over either limit; its stated limits are correction 6.                                                                                                                                                 |
| C14    | The relay-row retention figure is measured by a test and recorded in the inbound README and the roadmap.                                                                                                                                              |
| C15    | `sendWsUnicast` and the realtime targeted leg for intents are deleted; the S3a pin is replaced.                                                                                                                                                       |
| C16    | No persisted shape changes; the schema id stays.                                                                                                                                                                                                      |
| C17    | Envelope bytes come from the existing walk, exported as `computeALMessageEnvelopeBytes`.                                                                                                                                                              |

### Alignment with the QoS plan (PR #606, D83–D90)

- **One vocabulary.** `capacity` is a refusal reason read through `evidence.failure`. I2a's `storage-unavailable`
  becomes one more reason on the same union; no second failure surface is added.
- **One retention rule.** `resolveALReceiptRetentionExpiryMs`
  (`packages/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts`) is the rule "deadline plus the receipt
  grace". I2a's dedup retention (QoS plan §5) reuses it.
- **The bound is the checkpoint basis.** `AL_VOLATILE_SESSION_MAX_ADMISSIONS` and `AL_VOLATILE_SESSION_MAX_BYTES` are
  the figures the QoS plan's H4 measured a checkpoint at. They stay named constants behind `ALVolatileSessionLimits`,
  so I2b can extend the budget to `local-checkpoint` admissions without a second counter.
- **`onStorageUnavailable: 'volatile'`** (I2a) admits into the volatile pair, so such a send counts against the budget.
- **Storage budgets.** The volatile zero pin (D55, D87) is extended to the director intents (Task 5) and the
  empty-audience send (Task 2).
- **Sequencing.** The QoS plan's §10.3 holds: it lands no ALM code beside S3c. S3c-ii is the one active slice; P1 and
  I2a start from `main` after it merges.

### PR #566 and this plan

PR #566 (`codex/rtc-b06-overlay-gap-plan`, 330 files, draft) conflicts with `main` in 16 files after S3c-i. It is not
landed first and not stacked: its WS scope and audience layer duplicates S3c-i's frozen audience
(`readServerPublishAudience`) and cluster audience read (`readAdmittedAudience`), contradicts D53/D71 (unicast scope on
the wire), D72/D77 (Relic), D54 (fanout derived from QoS) and R-S3c-i-29/31 (repair merge), and its overlay-gap rework
narrows S3b's RTC-to-WS fallback. Its heartbeat fix and its RTC offer/answer correlation touch no file S3c-ii touches.
The one semantic overlap with S3c-ii is `web-rtc-overlay-multicast-manager.ts`, which this plan avoids. The
sequencing is the maintainer's decision; the analysis is in the PR #606 body.

### Carried to V1 / later

- Post-admission fallback for `ws-then-rtc` and for a resumed durable message; a `peerId` on `ws-then-rtc` (V1).
- The congestion aspect beyond the first producer: track, intake and age budgets, fairness, and WS outbound planning
  consulting `overloaded` (V1).
- D82's multicast and broadcast `contextId` gap (known debt).
- Relic's rule-error text on a reply channel (I1); Relic's app-data write through AppInbox (R-S3c-i-8).
- The observation job's 30-minute timeout against the full scope; manifest 18's 300 s terminal timeout; issue #594.

---

## File structure

Each task's **Files** block is the authority for its paths. New files, by owner:

| File                                                                                                                      | Task | Responsibility                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `packages/shared/alm/delivery/al-delivery-failure.ts`                                                                     | 1    | the typed failure union and the receipt-exhausted cause                                          |
| `packages/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts`                                                  | 2    | the rule "deadline plus the receipt grace"                                                       |
| `packages/shared/alm/volatile-budget/al-volatile-session-budget.ts`                                                       | 3    | the per-session ledger, its constants and limits                                                 |
| `packages/shared-web/browser/messages/create-browser-unicast-message.ts`                                                  | 4    | renamed from `create-browser-ws-unicast-message.ts`: the unicast builder and the peer validators |
| `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/*`                                                         | 6    | the four addressed-send scenarios                                                                |
| `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/resolve-black-box-rallar-message-peer.ts` | 6    | the lane role (`server`, `receiver`) resolved to one peer id                                     |
| `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts`     | 6    | the lane-only volatile limits the session reads at initialisation                                |

---

### Task 1: Typed failure evidence and the capacity vocabulary (D75, D78, C1, C2)

**Files:**

- Create: `packages/shared/alm/delivery/al-delivery-failure.ts`,
  `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`.
- Modify:
  - `packages/shared/alm/delivery/al-delivery-lifecycle.ts:1-2` (import), `:56` (`capacity`), `:78-82` (the skipped
    reason gets its name), `:115-122` (`attempts-exhausted` gains its `reason`), `:157-171` (`receipt-exhausted` gains
    its cause), `:280-281` and `:344` (`evidence.failure`);
  - `packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts:1-14`, `:58-61`, `:80`, `:156-171`, `:199-205`,
    `:212`, `:256-262`, `:393-401`;
  - `packages/shared/alm/outbound/al-outbound-message-runtime.ts:102-110` (one union member; the file is at a tier and
    takes this vocabulary line only);
  - `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts:254-256`;
  - `packages/shared/alm/outbound/control/to-al-outbound-receipt-exhausted-fact.ts:1-17`;
  - `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts:138-155`;
  - `packages/shared/alm/outbound/al-outbound-repair-admission.ts:341-345`;
  - `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts:239-241`;
  - `packages/shared-web/browser/rallar.ts:273-282`, `packages/shared-web/browser/rallar-core.ts:119-128`,
    `packages/shared-web/browser/rallar-messages.ts:35-44` (two exported type names each);
  - `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:361-362`,
    `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts:61`,
    `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts:40-41`,
    `packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts:1-22`, `:137`, `:253-276`,
    `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts:40`, `:93`,
    `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md:342-345`, `:367`;
  - bundle ceilings only if crossed: `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts:44-59`,
    `packages/shared-web/scripts/measure-browser-bundles.mjs:34-49`,
    `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts:70-83`.
- Test: create `packages/tests/shared/alm/delivery/al-delivery-failure.test.ts`,
  `packages/tests/shared-test/alm-delivery-failure-decoding.test.ts`; modify
  `packages/tests/shared/alm/outbound/al-outbound-receipt-exhaustion.test.ts:102-108`,
  `packages/tests/shared/alm/al-outbound-control-admission.test.ts:561-568`, `:679-682`,
  `packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts:185-194`,
  `packages/tests/shared/alm/outbound-admission-verdict.test.ts` (one case after `:134-164`),
  `packages/tests/shared/alm/delivery/resolve-al-delivery-fallback-trigger.test.ts:1-14`, `:72-87`, `:162-170`,
  `packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts:177-196`,
  `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts:36-40`, `:288-292`, `:549-553`,
  `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts:88`, `:551-559`; the fixture sweep of Step 9
  and Step 13 (listed there, each a one-field edit), including the Deno test
  `apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts:391-411`.

**Interfaces:**

- Consumes nothing from another S3c-ii task.
- Produces `packages/shared/alm/delivery/al-delivery-failure.ts`:
  - `export type ALDeliveryReceiptExhaustedCause = 'budget' | 'hop-refused';`
  - `export type ALDeliveryReceiptExhaustion = Readonly<{ cause: 'budget'; }>`
    `| Readonly<{ cause: 'hop-refused'; hopPeerId: string; nackReason: ALNackReason; }>;`
    (added to the ledger: the one shape the settlement and the failure share);
  - `export type ALDeliveryFailure` =
    `Readonly<{ kind: 'refused'; reason: ALDeliveryRefusalReason; }>`
    `| Readonly<{ kind: 'relay-rejected'; rejection: ALDeliveryRelayRejection; }>`
    `| Readonly<{ kind: 'admission-failed'; }>`
    `| Readonly<{ kind: 'skipped'; reason: ALDeliverySkippedReason; }>`
    `| Readonly<{ kind: 'unroutable'; reason: ALDeliveryUnroutableReason; }>`
    `| Readonly<{ kind: 'attempt-failed'; outcome: Extract<ALDeliveryAttemptOutcome, 'failed' | 'no-targets'>; }>`
    `| (Readonly<{ kind: 'receipt-exhausted'; }> & ALDeliveryReceiptExhaustion)`
    `| Readonly<{ kind: 'expired'; }>`.
- Produces in `al-delivery-lifecycle.ts`: `ALDeliveryRefusalReason` gains `'capacity'`;
  `export type ALDeliverySkippedReason = 'disposed' | 'repair-exhausted' | 'pending-terminated' | 'planner-drop';`
  (added to the ledger: the ledger's `<the existing skipped reason type>` had no name; the verdict now uses it);
  `ALDeliveryEvidence.failure: ALDeliveryFailure | undefined` (required, `undefined` until the send ends `rejected`,
  `failed` or `expired`); the `receipt-exhausted` settlement is
  `Readonly<{ ...its fields }> & ALDeliveryReceiptExhaustion`;
  the `attempts-exhausted` settlement gains `reason: ALDeliveryUnroutableReason` (added to the ledger, see
  Correction 2).
- Produces `ALOutboundDropReasonCode` with `'capacity'`, mapped by `toALOutboundAdmissionVerdict` to
  `{ kind: 'refused', reason: 'capacity', detail }`; `AL_DELIVERY_FALLBACK_REFUSAL_REASONS` stays `['unsupported']`.
  **No producer of `capacity` exists after this task**; Task 3's `ALVolatileSessionBudget` refusal is the first.
- Produces `toALOutboundReceiptExhaustedFact(receipt, exhaustion: ALDeliveryReceiptExhaustion, detail: string)`.
- Produces the lane observation's `failure: ALDeliveryFailure | undefined` on `BlackBoxRallarDeliveryObservation` and
  `RallarBlackBoxTestMessagesObserveResultValue` (both `Pick<ALDeliveryEvidence, 'relayRejection' | 'failure'>`),
  decoded by `decodeAlmDeliveryFailure(value: unknown): Either<string, ALDeliveryFailure>` (Task 6 reads it).
- Produces the public type names `ALDeliveryFailure` and `ALDeliveryReceiptExhaustedCause` on `rallar.ts`,
  `rallar-core.ts` and `rallar-messages.ts` (where `ALDeliveryEvidence` is exported today).
- The apps' prose readers (`to-relic-command-phase.ts`, `send-relic-ws-command.ts`, `to-match-delivery.ts`,
  `browser-director-relay-transport.ts:152,176`) are unchanged: `evidence.reason` keeps its value and meaning.

#### Corrections found while writing

1. **The skipped reason has no name.** The verdict spells it inline (`al-delivery-lifecycle.ts:78-82`). This task
   names it `ALDeliverySkippedReason` beside `ALDeliveryUnroutableReason` and `ALDeliveryRefusalReason` and uses it in
   the verdict and the failure. The attempt outcome is the existing `ALDeliveryAttemptOutcome`, narrowed to the two
   outcomes that end a send (`compute-al-delivery-lifecycle.ts:393-398`).
2. **Survey row 5: `attempts-exhausted` carries no reason** (`al-delivery-lifecycle.ts:116-122`), so the reducer
   could only infer `unroutable.reason` from the last attempt row. The one producer knows it
   (`browser-rallar-message-dispatch.ts:239-241`, `verdict.reason`), so the settlement gains
   `reason: ALDeliveryUnroutableReason` and the reducer reads the settlement it ends on.
3. **The WS server has no `receipt-exhausted` producer of its own.** Both outbound owners (the WS client, the WS
   server's own origin and the browser carriers) reuse the two shared producers,
   `al-outbound-repair-admission.ts:341-345` (budget) and `compute-al-outbound-control-admission.ts:141-155`
   (hop-refused). `packages/shared-server/rallar-system/observability/alm-receipt-diagnostics.ts:60` reads the
   settlement's shared fields and compiles unchanged. The WS client's hop-refused pin
   (`ws-queue-box-client-relay-rejection.test.ts:185-194`, the server's `unauthorized` NACK on a tracked hop) moves.
4. **`resync-required` never reaches `hop-refused`.** `toALOutboundControlSettlements` returns the `relay-rejected`
   fact for it first (`compute-al-outbound-control-admission.ts:117-119`), so the reachable NACK reasons of
   `hop-refused` are `expired`, `unauthorized` and `stale`; the field stays `ALNackReason` as the ledger names it.
5. **The black-box observation has a strict decoder, no JSON schema and no golden corpus.** The page result is
   decoded by `decode-alm-runtime-result.ts:125-160`; the hosted manifests
   (`apps/rallar-black-box/manifests/hetzner/*.json`)
   reference result paths, not the shape, and stay unchanged. The field list lives in the capability prose
   (`rallar-black-box-alm-command-capabilities.ts:40,93`) and `schema-and-capabilities.md:342-345`; both move here.
6. **`al-delivery-lifecycle.ts` and `al-delivery-failure.ts` import each other's types.** The cycle is type-only and
   erased; no import-cycle gate exists in `scripts/`.
7. **Bundle headroom.** The pinned comments record 223.056640625 KiB of 224 for the facade and 285.8173828125 KiB of
   286 for headless; the frame's "under 0.2 KiB" holds for headless. Step 16 measures both and raises a crossed
   ceiling in this task.

- [ ] **Step 1: RED -- the reducer states a typed failure for every failure meaning.** Create
      `packages/tests/shared/alm/delivery/al-delivery-failure.test.ts`:

```ts
import type {
    ALDeliveryFailure,
    ALDeliveryReceiptExhaustedCause,
    ALDeliveryReceiptExhaustion
} from '@shared/alm/delivery/al-delivery-failure.ts';
import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryAttemptOutcome,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement,
    type ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    computeALDeliveryDeadline,
    computeALDeliveryLifecycle,
    computeALDeliveryUnobservable
} from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import {
    describe,
    expect,
    expectTypeOf,
    it
} from 'vitest';

const MSG_ID = 'msg-1';
const AT_MS = 2_000;
const EXPIRES_AT_MS = 30_000;

type ReceiptAlgo = 'receiver' | 'none';

function createSubmittedLifecycle(receiptAlgo: ReceiptAlgo): ALDeliveryLifecycle {
    return createInitialALDeliveryLifecycle({
        msgId: MSG_ID,
        typeId: 'room.command.v1',
        ackMode: receiptAlgo,
        receiptAlgo,
        expiresAtMs: EXPIRES_AT_MS,
        submittedAtMs: 1_000
    });
}

function toEnded(
    settlements: readonly ALDeliverySettlement[],
    receiptAlgo: ReceiptAlgo = 'receiver'
): ALDeliveryLifecycle {
    return settlements.reduce(
        (lifecycle, settlement) => computeALDeliveryLifecycle(lifecycle, settlement),
        createSubmittedLifecycle(receiptAlgo)
    );
}

function toAdmission(
    verdict: ALDeliveryAdmissionVerdict,
    trackedReceiptAlgo: ReceiptAlgo = 'none'
): ALDeliverySettlement {
    return {
        kind: 'admission',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        verdict,
        trackedReceiptAlgo
    };
}

function toAttemptSettled(outcome: ALDeliveryAttemptOutcome): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        attemptId: 'attempt-1',
        outcome,
        submissionAttempted: outcome === 'sent',
        detail: `attempt ${outcome}`,
        willRetry: false
    };
}

function toReceiptExhausted(exhaustion: ALDeliveryReceiptExhaustion): ALDeliverySettlement {
    return {
        kind: 'receipt-exhausted',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        mode: 'receiver',
        confirmedPeerIds: ['b'],
        unconfirmedPeerIds: ['c'],
        ...exhaustion,
        detail: 'The receipt ended.'
    };
}

const ADMITTED = toAdmission({ kind: 'admitted', durable: false, queuedAttempts: 1 }, 'receiver');

const SERVER_REFUSAL: ALDeliverySettlement = {
    kind: 'relay-rejected',
    msgId: MSG_ID,
    carrier: 'ws',
    atMs: AT_MS,
    relayRejection: { relay: 'trusted-server', reason: 'unauthorized' },
    detail: 'The server refused the message: unauthorized.'
};

interface FailureCase {
    readonly meaning: string;
    readonly settlements: readonly ALDeliverySettlement[];
    readonly state: ALDeliveryState;
    readonly failure: ALDeliveryFailure;
    readonly reason: string;
}

// One row per failure meaning; the prose each end already stated stays beside it.
const FAILURE_CASES: readonly FailureCase[] = [
    {
        meaning: 'a carrier refusal no fallback took over',
        settlements: [
            toAdmission({ kind: 'refused', reason: 'unsupported', detail: 'receiver over rtc' })
        ],
        state: 'rejected',
        failure: { kind: 'refused', reason: 'unsupported' },
        reason: 'receiver over rtc'
    },
    {
        meaning: 'a refusal over the volatile bound (D78)',
        settlements: [
            toAdmission({
                kind: 'refused',
                reason: 'capacity',
                detail: 'The session is over its volatile bound.'
            })
        ],
        state: 'rejected',
        failure: { kind: 'refused', reason: 'capacity' },
        reason: 'The session is over its volatile bound.'
    },
    {
        meaning: 'a refusal by the trusted server',
        settlements: [ADMITTED, SERVER_REFUSAL],
        state: 'rejected',
        failure: {
            kind: 'relay-rejected',
            rejection: { relay: 'trusted-server', reason: 'unauthorized' }
        },
        reason: 'The server refused the message: unauthorized.'
    },
    {
        meaning: 'an admission that threw',
        settlements: [toAdmission({ kind: 'failed', detail: 'Storage unavailable' })],
        state: 'failed',
        failure: { kind: 'admission-failed' },
        reason: 'Storage unavailable'
    },
    {
        meaning: 'a skipped admission',
        settlements: [
            toAdmission({
                kind: 'skipped',
                reason: 'planner-drop',
                detail: 'Congestion dropped the message.'
            })
        ],
        state: 'failed',
        failure: { kind: 'skipped', reason: 'planner-drop' },
        reason: 'Congestion dropped the message.'
    },
    {
        meaning: 'no carrier left after an unroutable verdict',
        settlements: [
            toAdmission({
                kind: 'unroutable',
                reason: 'rate-limited',
                detail: 'rate-limited at rtc'
            }),
            {
                kind: 'attempts-exhausted',
                msgId: MSG_ID,
                carrier: 'rtc',
                atMs: AT_MS,
                reason: 'rate-limited',
                detail: 'rate-limited at rtc'
            }
        ],
        state: 'failed',
        failure: { kind: 'unroutable', reason: 'rate-limited' },
        reason: 'rate-limited at rtc'
    },
    {
        meaning: 'a failed attempt that will not retry',
        settlements: [ADMITTED, toAttemptSettled('failed')],
        state: 'failed',
        failure: { kind: 'attempt-failed', outcome: 'failed' },
        reason: 'attempt failed'
    },
    {
        meaning: 'an attempt that found no targets',
        settlements: [ADMITTED, toAttemptSettled('no-targets')],
        state: 'failed',
        failure: { kind: 'attempt-failed', outcome: 'no-targets' },
        reason: 'attempt no-targets'
    },
    {
        meaning: 'a spent receipt budget',
        settlements: [ADMITTED, toReceiptExhausted({ cause: 'budget' })],
        state: 'failed',
        failure: { kind: 'receipt-exhausted', cause: 'budget' },
        reason: 'The receipt ended.'
    },
    {
        meaning: 'a tracked hop that refused the message for good',
        settlements: [
            ADMITTED,
            toReceiptExhausted({ cause: 'hop-refused', hopPeerId: 'relay-1', nackReason: 'stale' })
        ],
        state: 'failed',
        failure: {
            kind: 'receipt-exhausted',
            cause: 'hop-refused',
            hopPeerId: 'relay-1',
            nackReason: 'stale'
        },
        reason: 'The receipt ended.'
    },
    {
        meaning: 'an expired admission',
        settlements: [
            toAdmission({
                kind: 'expired',
                detail: 'Message deadline elapsed before carrier admission.'
            })
        ],
        state: 'expired',
        failure: { kind: 'expired' },
        reason: 'Message deadline elapsed before carrier admission.'
    },
    {
        meaning: 'an expired attempt',
        settlements: [ADMITTED, toAttemptSettled('expired')],
        state: 'expired',
        failure: { kind: 'expired' },
        reason: 'attempt expired'
    },
    {
        meaning: 'a fallback past the deadline',
        settlements: [{
            kind: 'expired',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS,
            detail: 'Message deadline elapsed before fallback.'
        }],
        state: 'expired',
        failure: { kind: 'expired' },
        reason: 'Message deadline elapsed before fallback.'
    }
];

describe('the typed failure of a send that ended (D75, C2)', () => {
    it.each(FAILURE_CASES)(
        'states $failure.kind for $meaning and keeps the prose',
        ({ settlements, state, failure, reason }) => {
            const ended = toEnded(settlements);

            expect(ended.state).toBe(state);
            expect(ended.evidence.failure).toEqual(failure);
            expect(ended.evidence.reason).toBe(reason);
        }
    );

    it('states expired when an observer reads the deadline before any end', () => {
        const read = computeALDeliveryDeadline(toEnded([ADMITTED]), EXPIRES_AT_MS);

        expect(read.state).toBe('expired');
        expect(read.evidence.failure).toEqual({ kind: 'expired' });
        expect(read.evidence.reason).toBe('The deadline elapsed before a terminal settlement.');
    });

    it.each(
        [
            { meaning: 'a submitted send', settlements: [], state: 'submitted' },
            {
                meaning: 'a refused leg the fallback carrier took over',
                settlements: [{
                    kind: 'carrier-refused',
                    msgId: MSG_ID,
                    carrier: 'rtc',
                    atMs: AT_MS,
                    reason: 'unsupported',
                    detail: 'receiver over rtc'
                }],
                state: 'submitted'
            },
            {
                meaning: 'a superseded send',
                settlements: [ADMITTED, {
                    kind: 'superseded',
                    msgId: MSG_ID,
                    carrier: 'rtc',
                    atMs: AT_MS,
                    replacementMsgId: 'msg-2',
                    detail: 'Replaced.'
                }],
                state: 'superseded'
            },
            {
                meaning: 'a superseded attempt',
                settlements: [ADMITTED, toAttemptSettled('superseded')],
                state: 'superseded'
            },
            {
                meaning: 'a cancelled send',
                settlements: [ADMITTED, {
                    kind: 'cancelled',
                    msgId: MSG_ID,
                    carrier: 'rtc',
                    atMs: AT_MS
                }],
                state: 'cancelled'
            }
        ] satisfies ReadonlyArray<{
            meaning: string;
            settlements: readonly ALDeliverySettlement[];
            state: ALDeliveryState;
        }>
    )('states no failure for $meaning', ({ settlements, state }) => {
        const lifecycle = toEnded(settlements);

        expect(lifecycle.state).toBe(state);
        expect(lifecycle.evidence.failure).toBeUndefined();
    });

    it('states no failure when the observation is lost', () => {
        const lost = computeALDeliveryUnobservable(toEnded([ADMITTED]));

        expect(lost.state).toBe('unobservable');
        expect(lost.evidence.failure).toBeUndefined();
    });

    it('keeps a receipt-less send transport-accepted with no failure when a hop refuses it late (R-S2c-ii-5a)', () => {
        const ended = toEnded([
            toAdmission({ kind: 'admitted', durable: false, queuedAttempts: 1 }),
            toAttemptSettled('sent'),
            SERVER_REFUSAL
        ], 'none');

        expect(ended.state).toBe('transport-accepted');
        expect(ended.evidence.relayRejection).toEqual({
            relay: 'trusted-server',
            reason: 'unauthorized'
        });
        expect(ended.evidence.failure).toBeUndefined();
    });

    it('keeps the first failure when a relay refusal lands after the end', () => {
        const ended = toEnded([ADMITTED, toReceiptExhausted({ cause: 'budget' }), SERVER_REFUSAL]);

        expect(ended.state).toBe('failed');
        expect(ended.evidence.failure).toEqual({ kind: 'receipt-exhausted', cause: 'budget' });
        expect(ended.evidence.relayRejection).toEqual({
            relay: 'trusted-server',
            reason: 'unauthorized'
        });
    });

    it('names the two receipt-exhausted causes', () => {
        expectTypeOf<ALDeliveryReceiptExhaustion['cause']>().toEqualTypeOf<
            ALDeliveryReceiptExhaustedCause
        >();
    });
});
```

Run: `npx vitest run packages/tests/shared/alm/delivery/al-delivery-failure.test.ts`
Expected: FAIL -- the 13 `FAILURE_CASES` rows, the deadline read and "keeps the first failure when a relay refusal
lands after the end" fail with `expected undefined to deeply equal` (no `failure` field exists); the no-failure cases pass (the field is absent, so `undefined`); the type pin is erased
at run time and is checked by `npm run typecheck` in Step 16.

- [ ] **Step 2: GREEN, the vocabulary.** Create `packages/shared/alm/delivery/al-delivery-failure.ts`:

```ts
import type { ALNackReason } from '../../al-contracts/al-control.ts';
import type {
    ALDeliveryAttemptOutcome,
    ALDeliveryRefusalReason,
    ALDeliveryRelayRejection,
    ALDeliverySkippedReason,
    ALDeliveryUnroutableReason
} from './al-delivery-lifecycle.ts';

/** Why a receipt ended before every expected peer confirmed. */
export type ALDeliveryReceiptExhaustedCause = 'budget' | 'hop-refused';

/**
 * A receipt's end as its producer states it: the retry budget ran out, or a hop the receipt tracks refused the
 * message for good with a terminal NACK, named with its reason.
 */
export type ALDeliveryReceiptExhaustion =
    | Readonly<{ cause: 'budget'; }>
    | Readonly<{ cause: 'hop-refused'; hopPeerId: string; nackReason: ALNackReason; }>;

/**
 * Why a send ended `rejected`, `failed` or `expired`; `evidence.reason` keeps the prose. A refusal ends `rejected`,
 * the deadline `expired`, every other kind `failed`.
 */
export type ALDeliveryFailure =
    | Readonly<{ kind: 'refused'; reason: ALDeliveryRefusalReason; }>
    | Readonly<{ kind: 'relay-rejected'; rejection: ALDeliveryRelayRejection; }>
    | Readonly<{ kind: 'admission-failed'; }>
    | Readonly<{ kind: 'skipped'; reason: ALDeliverySkippedReason; }>
    | Readonly<{ kind: 'unroutable'; reason: ALDeliveryUnroutableReason; }>
    | Readonly<{
        kind: 'attempt-failed';
        outcome: Extract<ALDeliveryAttemptOutcome, 'failed' | 'no-targets'>;
    }>
    | (Readonly<{ kind: 'receipt-exhausted'; }> & ALDeliveryReceiptExhaustion)
    | Readonly<{ kind: 'expired'; }>;
```

In `packages/shared/alm/delivery/al-delivery-lifecycle.ts`:

- after `:2` add `import type { ALDeliveryFailure, ALDeliveryReceiptExhaustion } from './al-delivery-failure.ts';`
- replace `:56` with:

```ts
/** `capacity`: the sending session is over its volatile bound (D78); it ends the send and never hands it over. */
export type ALDeliveryRefusalReason =
    | 'unauthorized'
    | 'malformed'
    | 'oversized'
    | 'unsupported'
    | 'capacity';

export type ALDeliverySkippedReason =
    | 'disposed'
    | 'repair-exhausted'
    | 'pending-terminated'
    | 'planner-drop';
```

- replace the skipped verdict `:78-82` with:

```ts
| Readonly<{ kind: 'skipped'; reason: ALDeliverySkippedReason; detail: string; }>
```

- replace the `attempts-exhausted` member `:115-122` with:

```ts
/** The sender's strategy has no carrier left to try after an `unroutable` verdict: the last carrier's reason. */
| Readonly<{
    kind: 'attempts-exhausted';
    msgId: string;
    carrier: ALDeliveryCarrier;
    atMs: number;
    reason: ALDeliveryUnroutableReason;
    detail: string;
}>
```

- replace the `receipt-exhausted` member `:157-171` with (the doc comment is the existing one plus its last sentence):

```ts
/**
 * A receipt ended before every expected peer confirmed: its retry budget ran out, or a hop refused the
 * message for good. Terminal. The peer lists are the receipt row's own -- next hops under `hop` and
 * `subtree`, logical recipients under `receiver` -- so the confirmed progress stays in evidence. The
 * producer states which of the two ended it.
 */
| (
    & Readonly<{
        kind: 'receipt-exhausted';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        mode: ALReceiptMode;
        confirmedPeerIds: readonly string[];
        unconfirmedPeerIds: readonly string[];
        detail: string;
    }>
    & ALDeliveryReceiptExhaustion
)
```

- in `ALDeliveryEvidence`, after `readonly carrierFallback: ALDeliveryCarrierFallback | undefined;` (`:279`) add:

```ts
/** Undefined until the send ends `rejected`, `failed` or `expired`: why it ended, typed beside `reason`. */
readonly failure: ALDeliveryFailure | undefined;
```

- in `createInitialALDeliveryLifecycle`, after `carrierFallback: undefined,` (`:343`) add `failure: undefined,`.

(`npx dprint fmt` settles the intersection layout; run it on the touched files in Step 16.)

- [ ] **Step 3: GREEN, the reducer and the one `attempts-exhausted` producer.** In
      `packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts`:

- after `:1` add `import type { ALDeliveryFailure } from './al-delivery-failure.ts';`
- replace the two cases `:58-61` with:

```ts
case 'attempts-exhausted':
    return toFailedLifecycle(previous, { kind: 'unroutable', reason: settlement.reason }, settlement.detail);
case 'expired':
    return toFailedLifecycle(previous, { kind: 'expired' }, settlement.detail);
```

- replace `:80` with:

```ts
return toFailedLifecycle(
    lifecycle,
    { kind: 'expired' },
    'The deadline elapsed before a terminal settlement.'
);
```

- replace the cases `:156-171` of `toAdmissionLifecycle` with:

```ts
case 'refused':
    return toFailedLifecycle(previous, { kind: 'refused', reason: verdict.reason }, verdict.detail);
case 'unroutable':
    return toAdmissionAttemptLifecycle(previous, {
        outcome: 'unroutable',
        carrier: settlement.carrier,
        atMs: settlement.atMs,
        detail: verdict.detail,
        reason: verdict.reason
    });
case 'superseded':
    return toReasonedLifecycle(previous, 'superseded', verdict.detail);
case 'expired':
    return toFailedLifecycle(previous, { kind: 'expired' }, verdict.detail);
case 'failed':
    return toFailedLifecycle(previous, { kind: 'admission-failed' }, verdict.detail);
case 'skipped':
    return toFailedLifecycle(previous, { kind: 'skipped', reason: verdict.reason }, verdict.detail);
```

- replace `toRelayRejectedLifecycle` `:199-205` with:

```ts
function toRelayRejectedLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryRelayRejectedSettlement
): ALDeliveryLifecycle {
    const rejection = settlement.relayRejection;
    const rejected = toFailedLifecycle(
        previous,
        { kind: 'relay-rejected', rejection },
        settlement.detail
    );
    return { ...rejected, evidence: { ...rejected.evidence, relayRejection: rejection } };
}
```

- replace the first line of `toReceiptExhaustedLifecycle` (`:212`) with
  `const failed = toFailedLifecycle(previous, toReceiptExhaustedFailure(settlement), settlement.detail);`
- replace `toReasonedLifecycle` `:256-262` with:

```ts
/** A failure's kind fixes the state it ends in. */
const AL_DELIVERY_FAILURE_STATES: Readonly<Record<ALDeliveryFailure['kind'], ALDeliveryState>> = {
    refused: 'rejected',
    'relay-rejected': 'rejected',
    'admission-failed': 'failed',
    skipped: 'failed',
    unroutable: 'failed',
    'attempt-failed': 'failed',
    'receipt-exhausted': 'failed',
    expired: 'expired'
};

function toFailedLifecycle(
    previous: ALDeliveryLifecycle,
    failure: ALDeliveryFailure,
    reason: string | undefined
): ALDeliveryLifecycle {
    return {
        ...previous,
        state: AL_DELIVERY_FAILURE_STATES[failure.kind],
        evidence: { ...previous.evidence, failure, reason }
    };
}

/** The ends that are no failure, so they state none. */
type ALDeliveryUnfailedEnd = Extract<ALDeliveryState, 'superseded' | 'cancelled' | 'unobservable'>;

function toReasonedLifecycle(
    previous: ALDeliveryLifecycle,
    state: ALDeliveryUnfailedEnd,
    reason: string | undefined
): ALDeliveryLifecycle {
    return { ...previous, state, evidence: { ...previous.evidence, reason } };
}

function toReceiptExhaustedFailure(
    settlement: ALDeliveryReceiptExhaustedSettlement
): ALDeliveryFailure {
    return settlement.cause === 'budget'
        ? { kind: 'receipt-exhausted', cause: 'budget' }
        : {
            kind: 'receipt-exhausted',
            cause: 'hop-refused',
            hopPeerId: settlement.hopPeerId,
            nackReason: settlement.nackReason
        };
}
```

- replace the two terminal branches of `toSettledAttemptLifecycle` `:393-401` with:

```ts
if (
    (settlement.outcome === 'failed' || settlement.outcome === 'no-targets') &&
    !settlement.willRetry &&
    !hasSentAttempt(next.evidence)
) {
    return toFailedLifecycle(
        next,
        { kind: 'attempt-failed', outcome: settlement.outcome },
        settlement.detail
    );
}
if (settlement.outcome === 'expired') {
    return toFailedLifecycle(next, { kind: 'expired' }, settlement.detail);
}
if (settlement.outcome === 'superseded') {
    return toReasonedLifecycle(next, 'superseded', settlement.detail);
}
```

The narrowed `toReasonedLifecycle` makes the compiler refuse any `rejected`, `failed` or `expired` end that states
no failure; the table makes it refuse a new failure kind without a state.

In `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts` replace `:239-241` with:

```ts
return verdict.kind === 'unroutable'
    ? {
        kind: 'attempts-exhausted',
        msgId,
        carrier,
        atMs,
        reason: verdict.reason,
        detail: verdict.detail
    }
    : undefined;
```

Run: `npx vitest run packages/tests/shared/alm/delivery`
Expected: PASS -- `al-delivery-failure.test.ts` green, and the existing reducer, receipt-end, carrier-fallback and
fallback-trigger files unchanged in outcome (Vitest does not type-check; their fixtures gain the new required fields
in Step 9).

- [ ] **Step 4: RED -- the two producers state the cause.**

In `packages/tests/shared/alm/outbound/al-outbound-receipt-exhaustion.test.ts:102-108` (the budget producer), make
the expected fact:

```ts
expect(fixture.facts).toEqual([{
    kind: 'receipt-exhausted',
    msgId: fixture.message.id.msgId,
    mode: 'hop',
    confirmedPeerIds: ['peer-1'],
    unconfirmedPeerIds: ['peer-2'],
    cause: 'budget',
    detail: 'The receipt ran out of retries after 3 of 3.'
}]);
```

In `packages/tests/shared/alm/al-outbound-control-admission.test.ts:561-568` (a hop refused for good), make it:

```ts
expect(facts[1]).toEqual({
    kind: 'receipt-exhausted',
    msgId: 'message',
    mode: 'hop',
    confirmedPeerIds: [],
    unconfirmedPeerIds: ['receiver'],
    cause: 'hop-refused',
    hopPeerId: 'receiver',
    nackReason: reason,
    detail: `Hop receiver refused the message: ${reason}.`
});
```

and at `:679-682` (R-S3c-i-28, the trusted server's refusal on the hop its receipt tracks):

```ts
expect(settlements).toMatchObject([
    { kind: 'acknowledgement', msgId: 'message' },
    {
        kind: 'receipt-exhausted',
        cause: 'hop-refused',
        hopPeerId: 'ws-server-1',
        nackReason: 'unauthorized',
        detail: 'Hop ws-server-1 refused the message: unauthorized.'
    }
]);
```

In `packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts:185-194` (the WS client's path through
the same shared producer), make the expected settlement:

```ts
expect(settlements.filter((settlement) => settlement.kind === 'receipt-exhausted')).toEqual([{
    kind: 'receipt-exhausted',
    msgId: 'hop-to-outsider',
    carrier: 'ws',
    atMs: expect.any(Number),
    mode: 'hop',
    confirmedPeerIds: [],
    unconfirmedPeerIds: ['server-1'],
    cause: 'hop-refused',
    hopPeerId: 'server-1',
    nackReason: 'unauthorized',
    detail: 'Hop server-1 refused the message: unauthorized.'
}]);
```

Run: `npx vitest run packages/tests/shared/alm/outbound/al-outbound-receipt-exhaustion.test.ts packages/tests/shared/alm/al-outbound-control-admission.test.ts packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts`
Expected: FAIL -- the four assertions above: the facts carry no `cause`, `hopPeerId` or `nackReason`.

- [ ] **Step 5: GREEN -- the producers.** Replace
      `packages/shared/alm/outbound/control/to-al-outbound-receipt-exhausted-fact.ts` with:

```ts
import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type { ALDeliveryReceiptExhaustion } from '../../delivery/al-delivery-failure.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';

/** A receipt that ended unconfirmed, in its row's own peer terms: next hops, or logical recipients under `receiver`. */
export function toALOutboundReceiptExhaustedFact(
    receipt: Pick<
        ALOutboundPendingAckSnapshot,
        'msgId' | 'mode' | 'expectedPeerIds' | 'ackedPeerIds'
    >,
    exhaustion: ALDeliveryReceiptExhaustion,
    detail: string
): ALOutboundSettlementFact {
    return {
        kind: 'receipt-exhausted',
        msgId: receipt.msgId,
        mode: receipt.mode,
        confirmedPeerIds: receipt.expectedPeerIds.filter((peerId) =>
            receipt.ackedPeerIds.includes(peerId)
        ),
        unconfirmedPeerIds: receipt.expectedPeerIds.filter((peerId) =>
            !receipt.ackedPeerIds.includes(peerId)
        ),
        ...exhaustion,
        detail
    };
}
```

In `packages/shared/alm/outbound/al-outbound-repair-admission.ts` replace `:342-345` with:

```ts
this.dependencies.settlements(toALOutboundReceiptExhaustedFact(
    pending,
    { cause: 'budget' },
    `The receipt ran out of retries after ${pending.attempts} of ${pending.maxAttempts}.`
));
```

In `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts` replace the tail of `toRefusedReceiptFact`
`:150-154` with:

```ts
const nack = read.parsed.payload;
return toALOutboundReceiptExhaustedFact(
    receipt,
    { cause: 'hop-refused', hopPeerId: nack.fromPeerId, nackReason: nack.reason },
    `Hop ${nack.fromPeerId} refused the message: ${nack.reason}.`
);
```

Run: the Step 4 command.
Expected: PASS.

- [ ] **Step 6: RED -- `capacity` is a refusal that ends the send and never hands it over (D78, C1).**

In `packages/tests/shared/alm/outbound-admission-verdict.test.ts` add
`import { isALDeliveryAdmissionFallbackVerdict } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';`
beside the other `@shared/alm/delivery` import, and after the `'is refused as unauthorized ...'` case (`:134-164`)
add:

```ts
it('is refused as capacity when the planner drops the message with that code, and hands nothing over (D78, C1)', async () => {
    const stores = createDefaultOutboundTestStores();
    const store = stores.admissionStore;
    const message = createOutboundMessage('verdict-capacity');
    const read = await store.readOutgoingMessage({
        msg: message,
        planner: () => ({
            msg: message,
            dropReason: 'The session is over its volatile bound.',
            dropReasonCode: 'capacity',
            persist: false,
            preparedMessages: []
        }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    const computed = computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(store, read.msg),
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    });

    expect(computed.verdict).toEqual({
        kind: 'refused',
        reason: 'capacity',
        detail: 'The session is over its volatile bound.'
    });
    expect(isALDeliveryAdmissionFallbackVerdict(computed.verdict)).toBe(false);
});
```

In `packages/tests/shared/alm/delivery/resolve-al-delivery-fallback-trigger.test.ts` import
`type ALDeliveryRefusalReason` from `@shared/alm/delivery/al-delivery-lifecycle.ts` and
`AL_DELIVERY_FALLBACK_REFUSAL_REASONS` from `@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts` (`:1-14`),
add the row `[{ kind: 'refused', reason: 'capacity', detail: 'over the volatile bound' }, false],` after the
`unauthorized` row (`:84`), and add inside `describe('the declared retryable outcomes (D56)', ...)` after the first
`it` (`:72-75`):

```ts
it('keeps capacity out of the refusals that hand over: a send over the bound ends rejected (D78, C1)', () => {
    expectTypeOf<Extract<ALDeliveryRefusalReason, 'capacity'>>().toEqualTypeOf<'capacity'>();
    expect(AL_DELIVERY_FALLBACK_REFUSAL_REASONS).toEqual(['unsupported']);
});
```

In `packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts` add the row
`['capacity', 'rejected', { kind: 'refused', reason: 'capacity', detail: 'capacity' }],` after the `malformed` row
(`:183`), and after that `it.each` block (`:177-196`) add the end-to-end case through the real outbound runtime:

```ts
it('ends a send its first carrier refuses for capacity rejected with the typed failure, and starts no WS leg (D78)', async () => {
    const fixture = createChannel({
        firstVerdict: ADMITTED_VERDICT,
        firstPlanner: (msg) => ({
            msg,
            persist: false,
            preparedMessages: [],
            dropReason: 'The session is over its volatile bound.',
            dropReasonCode: 'capacity'
        })
    });
    const handle = await fixture.channel.send({ action: 'ready' });

    expect((await handle.wait()).lifecycle).toMatchObject({
        state: 'rejected',
        evidence: {
            failure: { kind: 'refused', reason: 'capacity' },
            reason: 'The session is over its volatile bound.'
        }
    });
    expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(['rtc']);
});
```

Run: `npx vitest run packages/tests/shared/alm/outbound-admission-verdict.test.ts packages/tests/shared/alm/delivery/resolve-al-delivery-fallback-trigger.test.ts packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts`
Expected: FAIL -- the verdict case (`toALOutboundAdmissionVerdict` has no `capacity` case and returns `undefined`) and
the end-to-end case (no verdict reaches the handle). The fallback-trigger pin and the table row pass already: they
pin C1, which the code already honours.

- [ ] **Step 7: GREEN -- the drop code.** In `packages/shared/alm/outbound/al-outbound-message-runtime.ts:102-110`
      add `| 'capacity'` after `| 'unsupported'` in `ALOutboundDropReasonCode`. In
      `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts:254-256` make the refused group:

```ts
case 'unauthorized':
case 'unsupported':
case 'capacity':
    return { kind: 'refused', reason: plan.dropReasonCode, detail };
```

`resolve-al-delivery-fallback-trigger.ts` is unchanged: `AL_DELIVERY_FALLBACK_REFUSAL_REASONS` stays
`['unsupported']`, so `computeFallbackDisposition` (`browser-rallar-message-dispatch.ts:211-221`) answers `stop` and
`toCarrierAdmissionSettlement` (`:223-228`) states an `admission` settlement, which the reducer ends `rejected` with
`{ kind: 'refused', reason: 'capacity' }`. `carrier-refused` keeps its one meaning.
`toALOutboundDropReasonCodeFromHandlingPlan` (`web-rtc-overlay-multicast-manager.ts:900-918`) and
`toRtcEmptyAudienceDispatchPlan`
(`web-rtc-overlay-frozen-audience.ts:115-124`) compile and behave unchanged: neither produces nor rewrites `capacity`.

Run: the Step 6 command.
Expected: PASS.

- [ ] **Step 8: Run the reducer and producer suites together.**

Run: `npx vitest run packages/tests/shared/alm packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts packages/tests/shared-web/messages packages/tests/shared-server/rallar-system/observability/alm-receipt-diagnostics.test.ts`
Expected: PASS (the summary line reads 0 failed).

- [ ] **Step 9: The settlement fixtures state the new required fields.** Each edit adds one field to a literal that
      `npm run typecheck` (its `typecheck:tests` half) now refuses:

  - `packages/tests/shared-server/rallar-system/observability/alm-receipt-diagnostics.test.ts:43-51`,
    `packages/tests/shared/alm/delivery/al-delivery-carrier-fallback.test.ts:61-70`,
    `packages/tests/shared/alm/delivery/al-delivery-receipt-ends.test.ts:43-52`,
    `packages/tests/shared/alm/delivery/resolve-al-delivery-fallback-trigger.test.ts:162-170`,
    `packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts:145-154`: add `cause: 'budget',`
    before `detail` in the `receipt-exhausted` literal (each models a spent budget: "ran out of retries").
  - `packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts:193-199`: add `reason: 'no-route',`
    before `detail` in the `attempts-exhausted` literal, and after
    `expect(next.evidence.reason).toBe('no carrier left to try');` (`:203`) add
    `expect(next.evidence.failure).toEqual({ kind: 'unroutable', reason: 'no-route' });`.
  - `packages/tests/rallar-black-box/browser-rallar-runtime.test.ts:1329`: make the recorded settlement
    `{ kind: 'attempts-exhausted', msgId: handle.msgId, carrier: 'rtc', atMs: Date.now(), reason: 'no-route',`
    `detail }`.

Run: `npx vitest run packages/tests/shared-server/rallar-system/observability/alm-receipt-diagnostics.test.ts packages/tests/shared/alm/delivery packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts packages/tests/rallar-black-box/browser-rallar-runtime.test.ts && npm run typecheck:tests`
Expected: PASS; `typecheck:tests` reports no finding above its baseline (the remaining new findings, in the harness
fixtures, are removed in Step 13; if the ratchet names one of those files already, continue to Step 10 and re-run
after Step 13).

- [ ] **Step 10: RED -- the lane observation carries the typed failure.** Create
      `packages/tests/shared-test/alm-delivery-failure-decoding.test.ts`:

```ts
import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
import { describe, expect, it } from 'vitest';
import { decodeAlmDeliveryResultValue } from '../../shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts';

const OBSERVATION = {
    handleId: 'handle-1',
    state: 'failed',
    submitted: true,
    enqueued: false,
    confirmedHopPeerIds: [],
    unconfirmedHopPeerIds: ['relay-session'],
    receiptMode: 'hop',
    expectedRecipientPeerIds: ['relay-session'],
    confirmedRecipientPeerIds: [],
    unconfirmedRecipientPeerIds: ['relay-session'],
    attempts: 1,
    attemptOutcomes: ['sent'],
    attemptCarriers: ['rtc'],
    reason: 'Hop relay-session refused the message: stale.'
};

describe('the typed failure a delivery observation carries (D75, C2)', () => {
    it.each(
        [
            { kind: 'refused', reason: 'capacity' },
            {
                kind: 'relay-rejected',
                rejection: { relay: 'trusted-server', reason: 'unauthorized' }
            },
            {
                kind: 'relay-rejected',
                rejection: { relay: 'peer', peerId: 'relay-session', reason: 'resync-required' }
            },
            { kind: 'admission-failed' },
            { kind: 'skipped', reason: 'planner-drop' },
            { kind: 'unroutable', reason: 'no-route' },
            { kind: 'attempt-failed', outcome: 'no-targets' },
            { kind: 'receipt-exhausted', cause: 'budget' },
            {
                kind: 'receipt-exhausted',
                cause: 'hop-refused',
                hopPeerId: 'relay-session',
                nackReason: 'stale'
            },
            { kind: 'expired' }
        ] satisfies readonly ALDeliveryFailure[]
    )('reads a $kind failure as the page stated it', (failure) => {
        expect(decodeAlmDeliveryResultValue({ ...OBSERVATION, failure }).failure).toEqual(failure);
    });

    it('reads an observation without a failure as none', () => {
        expect(decodeAlmDeliveryResultValue(OBSERVATION).failure).toBeUndefined();
    });

    it.each([
        { failure: 'refused', field: 'failure.kind' },
        { failure: { kind: 'lost' }, field: 'failure.kind' },
        { failure: { kind: 'refused', reason: 'busy' }, field: 'failure.reason' },
        {
            failure: {
                kind: 'relay-rejected',
                rejection: { relay: 'trusted-server', peerId: 'server-1', reason: 'unauthorized' }
            },
            field: 'failure.rejection'
        },
        { failure: { kind: 'skipped', reason: 'no-route' }, field: 'failure.reason' },
        { failure: { kind: 'unroutable', reason: 'planner-drop' }, field: 'failure.reason' },
        { failure: { kind: 'attempt-failed', outcome: 'sent' }, field: 'failure.outcome' },
        { failure: { kind: 'receipt-exhausted', cause: 'timeout' }, field: 'failure.cause' },
        {
            failure: { kind: 'receipt-exhausted', cause: 'hop-refused', nackReason: 'stale' },
            field: 'failure.hopPeerId'
        },
        {
            failure: {
                kind: 'receipt-exhausted',
                cause: 'hop-refused',
                hopPeerId: 'relay-session',
                nackReason: 'late'
            },
            field: 'failure.nackReason'
        }
    ])('refuses a failure whose $field is unusable', ({ failure, field }) => {
        expect(() => decodeAlmDeliveryResultValue({ ...OBSERVATION, failure }))
            .toThrowError(`The page runtime returned no usable delivery observation.${field}.`);
    });
});
```

In `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts` make the unroutable case (`:551-559`) state
the settlement's reason and read the failure through the ledger:

```ts
facade.behavior.typedSend.mockImplementation(async () => {
    const handle = openFacadeDelivery('ws', { kind: 'unroutable', reason, detail });
    facade.deliveries.record({
        kind: 'attempts-exhausted',
        msgId: handle.msgId,
        carrier: 'ws',
        atMs: Date.now(),
        reason,
        detail
    });
    return handle;
});
await runtime.connect(connection);
await runtime.sendMessage(send);

expect(await runtime.readReceipts(query)).toMatchObject({
    state: 'failed',
    backpressured,
    enqueued: false,
    failure: { kind: 'unroutable', reason }
});
```

and add `failure: undefined,` after `relayRejection: undefined,` in `unknownObservation` (`:88`).

Run: `npx vitest run packages/tests/shared-test/alm-delivery-failure-decoding.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts`
Expected: FAIL -- the decoder drops `failure` (the ten reads get `undefined`; the ten refusals do not throw), and the
ledger projects no `failure` (the three unroutable rows). The "without a failure" case passes.

- [ ] **Step 11: GREEN -- the ledger projects the failure and the decoder reads it.** Create
      `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts` (a new file beside the 368-line
      `decode-alm-runtime-result.ts`, which takes call lines only; the relay-rejection decoding moves here so the
      failure's `rejection` and the observation's `relayRejection` share one decoder):

```ts
import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
import type {
    ALDeliveryRefusalReason,
    ALDeliveryRelayRejection,
    ALDeliverySkippedReason,
    ALDeliveryUnroutableReason
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

type AlmFailureDecoder = (failure: RallarBlackBoxTestRecord) => Either<string, ALDeliveryFailure>;

type AlmFailedAttemptOutcome = Extract<
    ALDeliveryFailure,
    Readonly<{ kind: 'attempt-failed'; }>
>['outcome'];

/** Keyed by every value, so a new reason, outcome or NACK reason fails to compile here instead of decoding as invalid. */
const ALM_REFUSAL_REASONS: Readonly<Record<ALDeliveryRefusalReason, true>> = {
    unauthorized: true,
    malformed: true,
    oversized: true,
    unsupported: true,
    capacity: true
};

const ALM_SKIPPED_REASONS: Readonly<Record<ALDeliverySkippedReason, true>> = {
    disposed: true,
    'repair-exhausted': true,
    'pending-terminated': true,
    'planner-drop': true
};

const ALM_UNROUTABLE_REASONS: Readonly<Record<ALDeliveryUnroutableReason, true>> = {
    'no-route': true,
    'rate-limited': true,
    'circuit-open': true
};

const ALM_FAILED_ATTEMPT_OUTCOMES: Readonly<Record<AlmFailedAttemptOutcome, true>> = {
    failed: true,
    'no-targets': true
};

const ALM_NACK_REASONS: Readonly<Record<ALNackReason, true>> = {
    duplicate: true,
    gap: true,
    'resync-required': true,
    expired: true,
    unauthorized: true,
    'no-route': true,
    overloaded: true,
    stale: true,
    'not-yet-in-sync': true
};

/** Keyed by every failure kind, so a new kind fails to compile here instead of decoding as invalid. */
const ALM_FAILURE_DECODERS: Readonly<Record<ALDeliveryFailure['kind'], AlmFailureDecoder>> = {
    refused: (failure) =>
        decodeAlmFailureKey(ALM_REFUSAL_REASONS, failure.reason, 'reason')
            .mapRight((reason): ALDeliveryFailure => ({ kind: 'refused', reason })),
    'relay-rejected': (failure) =>
        decodeAlmRelayRejection(failure.rejection, 'failure.rejection')
            .mapRight((rejection): ALDeliveryFailure => ({ kind: 'relay-rejected', rejection })),
    'admission-failed': () =>
        Either.ofRight<string, ALDeliveryFailure>({ kind: 'admission-failed' }),
    skipped: (failure) =>
        decodeAlmFailureKey(ALM_SKIPPED_REASONS, failure.reason, 'reason')
            .mapRight((reason): ALDeliveryFailure => ({ kind: 'skipped', reason })),
    unroutable: (failure) =>
        decodeAlmFailureKey(ALM_UNROUTABLE_REASONS, failure.reason, 'reason')
            .mapRight((reason): ALDeliveryFailure => ({ kind: 'unroutable', reason })),
    'attempt-failed': (failure) =>
        decodeAlmFailureKey(ALM_FAILED_ATTEMPT_OUTCOMES, failure.outcome, 'outcome')
            .mapRight((outcome): ALDeliveryFailure => ({ kind: 'attempt-failed', outcome })),
    'receipt-exhausted': decodeAlmReceiptExhaustedFailure,
    expired: () => Either.ofRight<string, ALDeliveryFailure>({ kind: 'expired' })
};

/** The failure the page stated, or the path of the field under the observation that it could not read. */
export function decodeAlmDeliveryFailure(value: unknown): Either<string, ALDeliveryFailure> {
    const failure = decodeAlmFailureRecord(value);
    const kind = failure.kind;
    return typeof kind === 'string' && Object.hasOwn(ALM_FAILURE_DECODERS, kind)
        ? ALM_FAILURE_DECODERS[kind as ALDeliveryFailure['kind']](failure)
        : Either.ofLeft('failure.kind');
}

/**
 * A trusted server relay is never named, so an id on one is refused. A trusted server refuses with `resync-required`
 * after admission or `unauthorized` before it (S3c-i C3); a peer relay only with `resync-required`.
 */
export function decodeAlmRelayRejection(
    value: unknown,
    field: string
): Either<string, ALDeliveryRelayRejection> {
    const rejection = decodeAlmFailureRecord(value);
    if (
        (rejection.reason === 'resync-required' || rejection.reason === 'unauthorized') &&
        rejection.relay === 'trusted-server' && rejection.peerId === undefined
    ) {
        return Either.ofRight<string, ALDeliveryRelayRejection>({
            relay: 'trusted-server',
            reason: rejection.reason
        });
    }
    if (
        rejection.reason === 'resync-required' && rejection.relay === 'peer' &&
        typeof rejection.peerId === 'string'
    ) {
        return Either.ofRight<string, ALDeliveryRelayRejection>({
            relay: 'peer',
            peerId: rejection.peerId,
            reason: 'resync-required'
        });
    }
    return Either.ofLeft(field);
}

function decodeAlmReceiptExhaustedFailure(
    failure: RallarBlackBoxTestRecord
): Either<string, ALDeliveryFailure> {
    if (failure.cause === 'budget') {
        return Either.ofRight<string, ALDeliveryFailure>({
            kind: 'receipt-exhausted',
            cause: 'budget'
        });
    }
    if (failure.cause !== 'hop-refused') {
        return Either.ofLeft('failure.cause');
    }
    const hopPeerId = failure.hopPeerId;
    if (typeof hopPeerId !== 'string') {
        return Either.ofLeft('failure.hopPeerId');
    }
    return decodeAlmFailureKey(ALM_NACK_REASONS, failure.nackReason, 'nackReason')
        .mapRight((nackReason): ALDeliveryFailure => ({
            kind: 'receipt-exhausted',
            cause: 'hop-refused',
            hopPeerId,
            nackReason
        }));
}

function decodeAlmFailureKey<TKey extends string>(
    keys: Readonly<Record<TKey, true>>,
    value: unknown,
    field: string
): Either<string, TKey> {
    return typeof value === 'string' && Object.hasOwn(keys, value)
        ? Either.ofRight(value as TKey)
        : Either.ofLeft(`failure.${field}`);
}

function decodeAlmFailureRecord(value: unknown): RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null ? value as RallarBlackBoxTestRecord : {};
}
```

(`decodeAlmFailureRecord` repeats the three-line object guard of `decodeAlmRuntimeRecord` rather than importing it:
`decode-alm-runtime-result.ts` imports this file, and a value import back would make a runtime module cycle.)

In `packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts`:

- to the imports (`:1-22`) add `import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';`
  and `import { decodeAlmDeliveryFailure, decodeAlmRelayRejection } from './decode-alm-delivery-failure.ts';`
- in `decodeAlmDeliveryResultValue` after `relayRejection: readAlmRelayRejectionField(record, path),` (`:137`) add
  `failure: readAlmFailureField(record, path),`
- replace `readAlmRelayRejectionField` and its doc comment (`:253-276`) with:

```ts
/** Absent unless a hop refused the message. */
function readAlmRelayRejectionField(
    record: RallarBlackBoxTestRecord,
    path: string
): ALDeliveryRelayRejection | undefined {
    if (record.relayRejection === undefined) {
        return undefined;
    }
    const decoded = decodeAlmRelayRejection(record.relayRejection, 'relayRejection');
    if (decoded.left !== undefined) {
        throw toAlmInvalidRuntimeResultError(`${path}.${decoded.left}`);
    }
    return decoded.right;
}

/** Absent until the send ended `rejected`, `failed` or `expired`. */
function readAlmFailureField(
    record: RallarBlackBoxTestRecord,
    path: string
): ALDeliveryFailure | undefined {
    if (record.failure === undefined) {
        return undefined;
    }
    const decoded = decodeAlmDeliveryFailure(record.failure);
    if (decoded.left !== undefined) {
        throw toAlmInvalidRuntimeResultError(`${path}.${decoded.left}`);
    }
    return decoded.right;
}
```

The existing refusals keep their message: `rallar-bb-test-alm-commands.test.ts:926-929` still reads
`The page runtime returned no usable delivery observation.relayRejection.`

In `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts:40-41` and
`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:361-362`
widen the pick to `Pick<ALDeliveryEvidence, 'relayRejection' | 'failure'>`. In
`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts`
after `relayRejection: lifecycle?.evidence.relayRejection,` (`:61`) add `failure: lifecycle?.evidence.failure,`.

Run: the Step 10 command, then `npx vitest run packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`
Expected: PASS -- the decoder test, the ledger's three unroutable rows, and the existing ALM command suite (its
`toEqual` reads of a decoded observation see `failure: undefined`, which `toEqual` treats as absent).

- [ ] **Step 12: The lane prose names the field.** In
      `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts` replace `:40` with the
      two lines:

```ts
'The in-page handle projects admission, carrier attempts with their attemptOutcomes and attemptCarriers, a relayRejection, ' +
'the typed failure of a send that ended rejected, failed or expired, and the ' +
```

and in `:93` replace `attemptCarriers, relayRejection, submission facts and reason.` with
`attemptCarriers, relayRejection, failure, submission facts and reason.`.

In `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md` replace `:342-345` (the field list) with:

```md
Carrier settlements update the handle directly. Observations include
`submitted`, `attempts`, `attemptOutcomes`, `attemptCarriers`, `relayRejection`, `failure`,
`receiptMode`, `confirmedHopPeerIds`, `unconfirmedHopPeerIds`, `expectedRecipientPeerIds`,
`confirmedRecipientPeerIds`, `unconfirmedRecipientPeerIds`, `reason`,
```

and break `:367` after ``only, in `relayRejection`.`` so that `` `backpressured` is true when a carrier `` starts
its own line, then insert between the two, with one blank line on each side:

```md
`failure` is present once the send ended `rejected`, `failed` or `expired`, and says why, typed:
`refused` with the carrier's `reason` (`capacity`, a session over its volatile bound, never hands
the send over), `relay-rejected` with its `rejection`, `admission-failed`, `skipped` with its
`reason`, `unroutable` with its `reason`, `attempt-failed` with its `outcome`, `receipt-exhausted`
with its `cause` (`budget`, or `hop-refused` with `hopPeerId` and `nackReason`), or `expired`.
`reason` keeps the prose; a receipt-less send refused late keeps `transport-accepted` and no failure.
```

- [ ] **Step 13: The observation fixtures state the new required field.** `BlackBoxRallarDeliveryObservation` and
      `RallarBlackBoxTestMessagesObserveResultValue` now require `failure`; add `failure: undefined,` after
      `relayRejection: undefined,` in each typed literal:

  - `packages/tests/rallar-black-box/live-rtc-control-client.test.ts:212`, `:324`, `:435`, `:502`, `:698`, `:763`
    (arguments of `toDeliveryObservationFixture`, which drops `undefined` fields, so every expected JSON is
    unchanged);
  - `packages/tests/shared-test/alm-lifecycle-recipes.test.ts:116`;
  - `apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts:408` (Deno; `deno task check` covers
    `test/` in that app, `apps/rallar-black-box-control-server/deno.json:14`).

Run: `npx vitest run packages/tests/rallar-black-box/live-rtc-control-client.test.ts packages/tests/shared-test/alm-lifecycle-recipes.test.ts && npm run typecheck:tests && (cd apps/rallar-black-box-control-server && deno task check)`
Expected: PASS; `typecheck:tests` reports no finding above its baseline.

- [ ] **Step 14: RED -- the two type names are public.** In
      `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`, in each of the three `types` lists
      (`rallar.ts` `:31-45`, `rallar-core.ts` `:283-297`, `rallar-messages.ts` `:545-557`) insert
      `'ALDeliveryFailure',` after `'ALDeliveryEvidence',` and `'ALDeliveryReceiptExhaustedCause',` after
      `'ALDeliveryReceiptEvidence',`.

Run: `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
Expected: FAIL -- three surfaces miss the two names.

- [ ] **Step 15: GREEN -- export them where `ALDeliveryEvidence` is exported.** In
      `packages/shared-web/browser/rallar.ts` after the `al-delivery-lifecycle.ts` type export block (`:273-282`),
      in `packages/shared-web/browser/rallar-core.ts` after `:119-128` and in
      `packages/shared-web/browser/rallar-messages.ts` after `:35-44`, add:

```ts
export type {
    ALDeliveryFailure,
    ALDeliveryReceiptExhaustedCause
} from '@shared/alm/delivery/al-delivery-failure.ts';
```

`ALDeliveryReceiptExhaustion` and `ALDeliverySkippedReason` stay internal names: an application reads them through
`ALDeliveryFailure` (the ledger names only the two public ones).

Run: the Step 14 command.
Expected: PASS.

- [ ] **Step 16: Validate.** The per-task set of the global constraints, with these files:

  1. `npx vitest run packages/tests/shared/alm packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts packages/tests/shared-web/messages packages/tests/shared-server/rallar-system/observability/alm-receipt-diagnostics.test.ts packages/tests/shared-test/alm-delivery-failure-decoding.test.ts packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts packages/tests/shared-test/alm-lifecycle-recipes.test.ts packages/tests/rallar-black-box/live-rtc-control-client.test.ts packages/tests/rallar-black-box/browser-rallar-runtime.test.ts`
     then `npm run test:unit`; read the `Tests` summary line (0 failed), not the exit code.
  2. `npm run typecheck` (its `typecheck:tests` half is the ratchet the fixture sweeps satisfy).
  3. `npm run check:repo-style:changed -- origin/main HEAD` and
     `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` (commit a registry fix first if it
     names a candidate).
  4. `npx dprint fmt` then `npx dprint check` on exactly the touched files: the four created files
     (`packages/shared/alm/delivery/al-delivery-failure.ts`,
     `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`,
     `packages/tests/shared/alm/delivery/al-delivery-failure.test.ts`,
     `packages/tests/shared-test/alm-delivery-failure-decoding.test.ts`) and every file under "Modify" and "Test"
     above; never a glob.
  5. `packages/shared` and `packages/shared-test` changed:
     `cd apps/api-v1 && deno task check`, `cd apps/rallar-black-box-control-server && deno task check`,
     `cd apps/relic-hunter-server-v1 && deno task check`, then `npm run test:deno` (it runs
     `control-alm-evidence.test.ts`; read its summary line).
  6. The change reaches the browser (the reducer and the dispatch are in the facade; the ledger and decoder in the
     black-box bundles):
     `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
     and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`. Record both figures. If the facade
     reaches 224 KiB, raise it to the next whole KiB in
     `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts:44-59` and
     `packages/shared-web/scripts/measure-browser-bundles.mjs:34-49`, appending to each comment
     "The S3c-ii typed failure evidence and the capacity vocabulary measure <the measured figure> KiB. The next
     whole-KiB ceiling is <N>."; if headless reaches 286 KiB, do the same in
     `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts:70-83` ("... measure <figure> KiB
     here. The next whole-KiB ceiling is <N>."). Re-run the three tests after a raise.
  7. The smoke lane is not run here (the frame runs it after Tasks 3, 4, 5 and 6); the medium-scale gate is not run
     (no `packages/shared/services/ws-queue-box-server/**` change).
  8. The storage pins are untouched: `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` passes inside
     `packages/tests/shared/alm` with unchanged counts (no store write moved).

- [ ] **Step 17: Commit and push.**

```bash
git add \
  packages/shared/alm/delivery \
  packages/shared/alm/outbound/al-outbound-message-runtime.ts \
  packages/shared/alm/outbound/compute-al-outbound-dispatch.ts \
  packages/shared/alm/outbound/control/to-al-outbound-receipt-exhausted-fact.ts \
  packages/shared/alm/outbound/compute-al-outbound-control-admission.ts \
  packages/shared/alm/outbound/al-outbound-repair-admission.ts \
  packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts \
  packages/shared-web/browser/rallar.ts packages/shared-web/browser/rallar-core.ts \
  packages/shared-web/browser/rallar-messages.ts \
  packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts \
  packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts \
  packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts \
  packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts \
  packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts \
  packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts \
  packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md \
  packages/tests/shared/alm/delivery \
  packages/tests/shared/alm/outbound/al-outbound-receipt-exhaustion.test.ts \
  packages/tests/shared/alm/al-outbound-control-admission.test.ts \
  packages/tests/shared/alm/outbound-admission-verdict.test.ts \
  packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts \
  packages/tests/shared-server/rallar-system/observability/alm-receipt-diagnostics.test.ts \
  packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts \
  packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts \
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
  packages/tests/shared-test/alm-delivery-failure-decoding.test.ts \
  packages/tests/shared-test/alm-lifecycle-recipes.test.ts \
  packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts \
  packages/tests/rallar-black-box/live-rtc-control-client.test.ts \
  packages/tests/rallar-black-box/browser-rallar-runtime.test.ts \
  apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts
git commit -m "feat(alm): S3c-ii -- a failed send states a typed failure; capacity joins the refusal vocabulary (D75, D78, C1, C2)"
git push origin HEAD:codex/queuebox-persistence-qos-product-plan
```

Add the bundle files Step 16 raised, and any test-structure-coupling registry fix, to the `git add`. The commit body
records both bundle figures, says that no persisted shape changed (`AL_ADMISSION_SCHEMA_ID` stays
`'rallar-alm-2026-09-s3c-i'`, C16: evidence and settlements are in-memory, and no decoder reads a refusal reason or a
drop code), and that `capacity` has no producer until Task 3.

---

### Task 2: Volatile retention, the empty-audience pin and the relay-row figure (D74 first half, D75, C5, C14)

**Files:**

- Create: `packages/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts`.
- Modify: `packages/shared/alm/outbound/control/compute-al-outbound-receipt-admission.ts:1` and `:62` (the receipt row
  already uses the rule; it now calls the one helper).
- Modify: `packages/shared/alm/outbound/admission/al-outbound-admission-mutations.ts:1-33` (imports), `:105-129`
  (input and constructor), `:233-248` (`computeMessageOwnerWrite`), `:293-318` (`computeSentMessageWrite`, plus one
  private method after it).
- Modify (size tier, 659 lines — call lines only: one import, the sibling factory's single construction call, the
  `durability` field and its pass-through): `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts:18-24`
  (imports), `:306-310` (the factory), `:316`, `:324`, `:328`, `:347-352` (constructor), `:359-370`
  (`createControlAdmission`).
- Modify (size tier, 915 lines — call lines only: one import, the sibling factory's single construction call and the
  `durability` field lines): `packages/shared/alm/inbound/al-inbound-admission-store.ts:14-18` (imports), `:144`,
  `:163`, `:193` (three read DTOs), `:321` (the store interface), `:349-399` (factory, `Dependencies`, constructor),
  `:438`, `:505`, `:827`, `:864`, `:882`, `:913`.
- Modify (size tier, 405 lines — one input member, one field, two call sites, one private method):
  `packages/shared/alm/outbound/control/al-outbound-control-admission.ts:13-16`, `:77-88`, `:97`, `:108`, `:363-392`.
- Modify: `packages/shared/alm/inbound/control/al-inbound-control-admission.ts:8`, `commitControlAdmission` and one
  private method after it.
- Modify: `packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts:1-36`.
- Modify: `packages/shared/alm/inbound/admission/compute-al-inbound-admission.ts:43-47` (import), `:104`, `:218`.
- Modify: `packages/shared/alm/al-runtime-stores.ts:15-34` (imports), `:93-138`, `:208-239` (no runtime value export
  is added: the two new functions are private).
- Modify: `packages/shared/alm/inbound/README.md:82-96`, `packages/shared/alm/outbound/README.md:80-82` and `:105`.
- Modify: `docs/test-structure-coupling-exceptions.md:118` and `:178` (contract prose only; no entry id moves).
- Modify (tests): `packages/tests/shared/alm/al-outbound-store-lane.test.ts:7-8`, `:122-123`, `:130-150`;
  `packages/tests/shared/alm/al-inbound-store-lane.test.ts:8-10`, `:191-192`, `:221-231`;
  `packages/tests/shared/alm/al-inbound-admission-preparation.test.ts:145`;
  `packages/tests/shared/multicast/rtc-origin-overlay-fixture.ts:8-12`, `:52-59`, `:80-83`;
  `packages/tests/shared/multicast/rtc-relay-overlay-fixture.ts:6`, `:23-28`, `:65-70`.
- Test (create): `packages/tests/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.test.ts`,
  `packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts`,
  `packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts`,
  `packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts` (beside
  `al-indexeddb-operation-counts.test.ts`, which at 749 lines is at a size tier, so it is not touched),
  `packages/tests/shared/multicast/rtc-relay-row-retention.test.ts`.

**Interfaces:**

- Consumes `AL_RECEIPT_DEADLINE_GRACE_MS = 30_000` (`packages/shared/al-contracts/al-control.ts:97`),
  `export type ALStoreDurability = 'volatile' | 'durable'` (`packages/shared/alm/al-runtime-stores.ts:41`, a type:
  `al-runtime-stores.ts` gains no runtime value export), `resolveALMessageExpireAtMs(msg: ALMessage, effective?:
  ALQosEffectivePolicy): number | undefined` (`packages/shared/al-contracts/al-policy.ts:418-444`).
- Produces (ledger) `packages/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts`:
  `export function resolveALReceiptRetentionExpiryMs(deadlineAtMs: number): number` (= deadline + 30 000).
- Produces (added to the ledger; the mechanism by which a row writer knows its pair):
  - `export function createVolatileALOutboundAdmissionStore<TPrepared>(input: CreateALOutboundAdmissionStoreInput<TPrepared>): ALOutboundAdmissionStore<TPrepared>`
    beside the unchanged `createALOutboundAdmissionStore` (`al-outbound-admission-store.ts:306-310`), which keeps
    building the durable rule. Both construct the private `ProviderBackedALOutboundAdmissionStore` with a private
    input that adds `readonly durability: ALStoreDurability`, handed to the row writer as
    `CreateALOutboundAdmissionMutationsInput.durability: ALStoreDurability` (a required field).
  - `export function createVolatileALInboundAdmissionStore(input: CreateALInboundAdmissionStoreInput): ALInboundAdmissionStore`
    beside the unchanged `createALInboundAdmissionStore` (`al-inbound-admission-store.ts:349-359`);
    `ProviderBackedALInboundAdmissionStore.Dependencies.durability: ALStoreDurability`, and a required
    `readonly durability: ALStoreDurability` on `ALInboundAdmissionRead`, `ALInboundMessageReadDto` and
    `ALInboundBufferedReleaseReadDto`, set by the store from its own pair.
  - `export function computeALInboundMessageOwnerExpiryMs(read: ALInboundMessageReadDto | ALInboundBufferedReleaseReadDto, deadlineAtMs: number): number`
    in `al-inbound-delivery-mutations.ts` (used by `compute-al-inbound-admission.ts` only).
  - The two volatile constructors (`createVolatileALOutboundRuntimeStores`, `createVolatileALInboundRuntimeStores`,
    `al-runtime-stores.ts:208-230`) are the only production callers of the two volatile factories: the choice of
    rule is made where the memory pair is made, and nothing below it reads a flag. Their signatures do not change;
    Task 3 edits the same two constructors on top of this shape (a private `toInMemoryAL*AdmissionStoreInput`
    helper each).
  - `CreateALOutboundControlAdmissionInput.durability: ALStoreDurability` (required; its one constructor is the
    store's `createControlAdmission`), and a public `readonly durability: ALStoreDurability` on the
    `ALInboundAdmissionStore` interface beside `retention`, read by `ALInboundControlAdmission`.
  - Test fixtures: `RtcOriginOverlayFixtureInput.stores?: ALOutboundRuntimeStores<ALOutboundTransportMessage>`
    (absent: an in-memory durable pair) and `RtcRelayOverlayFixtureInput.inboundVolatileStores?:
    ALVolatileInboundRuntimeStores` (absent: every admission uses one in-memory pair).
- No persisted shape changes (C16): `durability` is never written; `AL_ADMISSION_SCHEMA_ID` stays.

**The rules this task states (read before the steps):**

- _Volatile rows._ The outbound owner and sent rows of the volatile pair expire at
  `resolveALReceiptRetentionExpiryMs(deadline)`; the inbound owner row of the volatile pair expires at
  `resolveALReceiptRetentionExpiryMs(deadline)` and is then extended by `prepareALInboundCommitBundle`
  (`prepare-al-inbound-commit-bundle.ts:106-114`) to outlive the work it owns, unchanged; the buffered-release owner
  row is `max(that, the slot's expiry)` as today. Durable rows keep today's rules exactly: outbound
  `max(deadline, now + ttl, now + controlHistoryTtl)`, inbound admission `now + msgOwnerTtlMs` (it has no deadline
  term today), buffered release `max(now + msgOwnerTtlMs, expiry)`.
- _Control rows (the ruling on correction 1)._ On the volatile pair the outbound control-history rows and a completed
  receipt row, and the inbound acknowledgement-history row of a relay row, expire at `min(their TTL expiry,
  resolveALReceiptRetentionExpiryMs(deadline))`; a pending receipt keeps its deadline. Their readers need nothing
  later: every outbound control is gated by the owner row (`validate-al-outbound-control-admission.ts:17-19`), the
  receipt admission refuses past deadline + grace (`compute-al-outbound-receipt-admission.ts:82-84`), the send-time
  completeness check (`al-outbound-message-effects.ts:196-202`) and the read of an outgoing or repaired message
  (`al-outbound-admission-reads.ts:106-118`, `:365-379`) run only while the message's work lives, which ends at the
  deadline; inbound, an acknowledgement reaches the history only through the control-owner index, which expires at the
  deadline (`control/al-inbound-control-rows.ts:61-78`), and a data copy that reads it past the deadline is refused
  `expired` (`al-inbound-message-admission.ts:99-106`). The per-origin version row and the history row of a relay row
  that names no deadline keep their TTL (see "Rows that keep their TTL").
- _A message without a deadline._ It cannot reach the outbound pairs: the same computation that writes the owner and
  sent rows builds the canonical reference, and `toALOutboundMessageReference` throws "Canonical outbound messages
  require an absolute delivery deadline" (`al-outbound-canonical-message.ts:94-96`). The owner mutation's optional
  `expireAtTimestamp` (`al-outbound-admission-mutations.ts:42`) is absent only in direct store tests, so the volatile
  writer reads a missing deadline as `nowMs` (the row keeps just the grace) instead of widening a type every direct
  store test builds. Inbound it can exist (a peer or the server may send an envelope with no expiry; existing tests
  admit one, `al-inbound-effect-worker-lifecycle.test.ts:140`): the admission already implies the deadline
  `nowMs + retention.durableEffectTtlMs` (30 min; `al-inbound-message-admission.ts:99-100`,
  `prepare-al-inbound-commit-bundle.ts:100`), and the volatile owner row keeps that implied deadline plus the grace.
- _A control that arrives after the message is gone._ Outbound, the owner row gates every control
  (`al-outbound-control-admission.ts:295-298`, `validate-al-outbound-control-admission.ts:17-19`) and the sent row
  names the lane that owns the message (`al-outbound-message-runtime.ts:552-560`). Before this task a volatile
  message's rows answered for an hour. Now: an ACK after the deadline is refused in memory as today ("arrived after
  its message deadline", `validate-al-outbound-control-admission.ts:42-44`); a receipt is already refused past
  deadline + grace (`compute-al-outbound-receipt-admission.ts:82-84`), which is now exactly when the rows go; a NACK
  (for example the server's `unauthorized` refusal, S3c-i C3) is admitted until deadline + grace. Past it, no lane
  owns the message, the control goes to the durable lane and is refused there as "AL control has no retained
  outbound message obligation", the unknown-message path — at one owner read of the durable pair (IndexedDB in a
  browser), as any control about an unknown message costs today. The outbound ACK retry schedule never runs past
  the deadline (`toALOutboundAckRetryScheduleEndTimestamp`, `transition-al-outbound-pending-ack.ts:151-157`), so no
  owned work outlives the rows. Inbound, a late child ACK is decided by the control-owner index, which already
  expires at the pending deadline (`compute-al-inbound-admission.ts:298-316`), and a late data copy is refused
  `expired` before any write (`al-inbound-message-admission.ts:99-106`); the shorter inbound owner row changes
  neither.

#### Rows that keep their TTL

On the volatile pair, carried openly; durable rows are unchanged throughout.

- _The per-origin version row_ (`toALOutboundVersionKey(namespace, senderId)`, `versionTtlMs`, 1 h, refreshed by
  every write: `al-outbound-admission-store.ts:495`, `:542`; `al-outbound-control-admission.ts:387-391`, `:227-228`).
  Readers: the commit fence of every admission, repair and control of that origin
  (`ALOutboundAdmissionReads.readClientRecord`, `al-outbound-admission-reads.ts:308-314`, read by
  `readOutgoingMessage` `:113`, `readRepairMessage` `:175`, the commit fence `al-outbound-admission-store.ts:576` and
  `hasCurrentControlFence` `al-outbound-control-admission.ts:346-360`). It is keyed by the origin, not by a message,
  so it has no message deadline: each commit would re-stamp it with that commit's message deadline plus the grace,
  and a short-lived send would cut the fence under a longer-lived message of the same origin still in flight, which
  then restarts at version 1 while an earlier reader may hold a higher observation (the ABA a monotone fence exists to
  prevent). It is one row per origin, so it does not grow with sends and the bound of Task 3 does not need it short.
- _The acknowledgement-history row of a relay row whose message named no deadline_
  (`set-control-acks`, `controlHistoryTtlMs`, 30 min from the ACK; `compute-al-inbound-control-admission.ts:62`).
  Reader: the next acknowledgement's decision surface (`control/al-inbound-control-rows.ts:61-78`). The rule needs a
  deadline and the relay row carries one only when the message did (`ALPendingAckSnapshot.expireAtTimestamp?`,
  `al-control.ts:144`); such a message's owner index already falls back to `controlPendingTtlMs` (30 min,
  `compute-al-inbound-admission.ts:298-316`), so the history keeps the same TTL scale instead of a deadline it does
  not have. A browser send always names one (`to-browser-message-send-defaults.ts:40`, `:52` fall back to the lane
  TTL), so the row is the exception the rule does not reach.

- [ ] **Step 1: RED — the one rule.** Create
      `packages/tests/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import { resolveALReceiptRetentionExpiryMs } from '@shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts';

describe('resolveALReceiptRetentionExpiryMs (D74)', () => {
    it('keeps a row for the message deadline plus the 30 s receipt grace', () => {
        expect(resolveALReceiptRetentionExpiryMs(1_800_000_000_000)).toBe(1_800_000_030_000);
    });

    it('is the window a receipt about the message is still admitted in', () => {
        const deadlineAtMs = 1_000;

        expect(resolveALReceiptRetentionExpiryMs(deadlineAtMs) - deadlineAtMs).toBe(
            AL_RECEIPT_DEADLINE_GRACE_MS
        );
    });
});
```

Run: `npx vitest run packages/tests/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.test.ts`
Expected: FAIL — the module `@shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts` does not exist.

- [ ] **Step 2: GREEN — the helper, and the receipt row calls it.** Create
      `packages/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts`:

```ts
import { AL_RECEIPT_DEADLINE_GRACE_MS } from '../../al-contracts/al-control.ts';

/**
 * How long a row that answers a message's receipts outlives the message: its deadline plus the receipt grace, the
 * window in which a receipt or a late control about it is still admitted (D74). The volatile pair keeps its message
 * rows exactly this long, and the origin's receipt row already did.
 */
export function resolveALReceiptRetentionExpiryMs(deadlineAtMs: number): number {
    return deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS;
}
```

In `packages/shared/alm/outbound/control/compute-al-outbound-receipt-admission.ts` replace line 1
`import { AL_RECEIPT_DEADLINE_GRACE_MS, type ALReceiptPayload } from '../../../al-contracts/al-control.ts';` with

```ts
import type { ALReceiptPayload } from '../../../al-contracts/al-control.ts';
```

add after the `import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';` line

```ts
import { resolveALReceiptRetentionExpiryMs } from '../../delivery/resolve-al-receipt-retention-expiry-ms.ts';
```

and replace line 62 `expireAtTimestamp: current.deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS` (the last property of
the `write` object literal, so no trailing comma) with

```text
expireAtTimestamp: resolveALReceiptRetentionExpiryMs(current.deadlineAtMs)
```

Run: `npx vitest run packages/tests/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.test.ts packages/tests/shared/services/ws-queue-box-client-receipt-tracking.test.ts packages/tests/shared/services/ws-queue-box-server-receipt-aggregation.test.ts`
Expected: PASS (the receipt row's expiry is the same number it was).

- [ ] **Step 3: RED — the outbound volatile rows and the late control.** Create
      `packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts`:

```ts
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALNackControlMessage
} from '@shared/al-contracts/al-control.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import {
    DEFAULT_AL_REPOSITORY_TTL_MS,
    normalizeALRuntimeStoreRetention
} from '@shared/alm/ALStoreRetention.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    toALOutboundMessageOwnerKey,
    toALOutboundSentMessageKey
} from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import {
    createALOutboundAdmissionStore,
    createVolatileALOutboundAdmissionStore
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const NAMESPACE = 'volatile-retention';
const SERVER_PEER_ID = 'ws-server';

interface ObservedOutboundPair {
    readonly state: ALAdmissionMemoryState;
    readonly stores: ALVolatileOutboundRuntimeStores<OutboundTestPayload>;
}

describe('the rows a volatile outbound send keeps (D74)', () => {
    it('keeps the owner and sent rows for the message deadline plus the receipt grace', async () => {
        useFakeDate();
        const pair = createObservedOutboundPair('volatile');
        const runtime = createVolatileSendRuntime(pair.stores, []);
        const message = createOutboundMessage('volatile-rows', { ttlMs: 1_000 });

        await enqueueOutboundOrThrow(runtime, message);

        const keptUntilMs = readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS;
        expect(readRowExpiries(pair.state, message)).toEqual({
            owner: keptUntilMs,
            sent: keptUntilMs
        });
    });

    it('keeps the owner and sent rows of a durable send for the repository retention, as before', async () => {
        useFakeDate();
        const pair = createObservedOutboundPair('durable');
        const runtime = createDefaultOutboundTestRuntime({
            stores: pair.stores,
            planOutgoingMessage: (msg) => ({ ...planSend(msg), persist: true }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('durable-rows', { ttlMs: 1_000 });
        const admittedAtMs = Date.now();

        await enqueueOutboundOrThrow(runtime, message);

        const keptUntilMs = admittedAtMs + DEFAULT_AL_REPOSITORY_TTL_MS;
        expect(readRowExpiries(pair.state, message)).toEqual({
            owner: keptUntilMs,
            sent: keptUntilMs
        });
    });

    it('answers a server refusal that arrives after the deadline but inside the receipt grace', async () => {
        useFakeDate();
        const settlements: ALDeliverySettlement[] = [];
        const runtime = createVolatileSendRuntime(
            createObservedOutboundPair('volatile').stores,
            settlements
        );
        const message = createOutboundMessage('late-inside-grace', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);

        vi.setSystemTime(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS - 1);

        expect(await runtime.acceptControlMessage(toServerRefusal(message), 'trusted-server'))
            .toEqual({ kind: 'committed' });
        expect(settlements.filter((settlement) => settlement.kind === 'relay-rejected')).toEqual([
            expect.objectContaining({
                msgId: message.id.msgId,
                relayRejection: { relay: 'trusted-server', reason: 'unauthorized' }
            })
        ]);
    });

    it('drops a server refusal that arrives once the grace has passed, as a control about an unknown message', async () => {
        useFakeDate();
        const settlements: ALDeliverySettlement[] = [];
        const runtime = createVolatileSendRuntime(
            createObservedOutboundPair('volatile').stores,
            settlements
        );
        const message = createOutboundMessage('late-past-grace', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);

        vi.setSystemTime(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS);

        expect(await runtime.acceptControlMessage(toServerRefusal(message), 'trusted-server'))
            .toEqual({
                kind: 'rejected',
                reason: 'AL control has no retained outbound message obligation'
            });
        expect(settlements.filter((settlement) => settlement.kind === 'relay-rejected')).toEqual(
            []
        );
    });
});

/** Fakes only the clock the rows are stamped with; the owner's rounds keep their real timers. */
function useFakeDate(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
}

/** A memory pair whose admission map the test reads back: each row with the expiry it was written with. */
function createObservedOutboundPair(durability: 'durable' | 'volatile'): ObservedOutboundPair {
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const input = {
        nowMs: Date.now,
        namespace: NAMESPACE,
        canonicalScope: NAMESPACE,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        decodePrepared: decodeOutboundTestPayload
    };
    return {
        state,
        stores: {
            admissionStore: durability === 'volatile'
                ? createVolatileALOutboundAdmissionStore(input)
                : createALOutboundAdmissionStore(input),
            workQueue: backend.workQueue,
            evictExpired: () => backend.evictExpired()
        }
    };
}

function createVolatileSendRuntime(
    volatileStores: ALVolatileOutboundRuntimeStores<OutboundTestPayload>,
    settlements: ALDeliverySettlement[]
): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores: createDefaultOutboundTestStores(),
        volatileStores,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend,
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
}

function planSend(msg: ALMessage): ALOutboundDispatchPlan<OutboundTestPayload> {
    return { msg, dropReasonCode: undefined, persist: false, preparedMessages: [{ kind: 'send' }] };
}

function readDeadlineMs(message: ALMessage): number {
    const deadlineAtMs = message.constraints?.expiresAtMs;
    if (deadlineAtMs === undefined) {
        throw new Error('The fixture message names its deadline');
    }
    return deadlineAtMs;
}

function readRowExpiries(
    state: ALAdmissionMemoryState,
    message: ALMessage
): Readonly<{ owner: number | undefined; sent: number | undefined; }> {
    return {
        owner: state.data.get(toALOutboundMessageOwnerKey(NAMESPACE, message.id.msgId))
            ?.expireAtTimestamp,
        sent: state.data.get(toALOutboundSentMessageKey(NAMESPACE, message.id.msgId))
            ?.expireAtTimestamp
    };
}

/** The trusted server refusing a message it holds no receipt row for (S3c-i C3): the owner and sent rows decide it. */
function toServerRefusal(message: ALMessage): ALMessage {
    return newALNackControlMessage(
        { v: 2, msgId: `refusal-${message.id.msgId}`, senderId: SERVER_PEER_ID, ts: Date.now() },
        {
            fromPeerId: SERVER_PEER_ID,
            toPeerId: message.id.senderId,
            msgId: message.id.msgId,
            reason: 'unauthorized',
            observedAtEpochMs: Date.now()
        }
    );
}
```

Run: `npx vitest run packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts`
Expected: FAIL — `al-outbound-admission-store.ts` has no export `createVolatileALOutboundAdmissionStore`.

- [ ] **Step 4: GREEN — the outbound row writer knows its pair.** In
      `packages/shared/alm/outbound/admission/al-outbound-admission-mutations.ts`:

  1. After the `import type { ... } from '../../al-runtime-state-stores.ts';` block (`:8-12`) add
     `import type { ALStoreDurability } from '../../al-runtime-stores.ts';`, and after the
     `import type { ... } from '../../compute-al-supersedence-observation.ts';` block (`:14-17`) add
     `import { resolveALReceiptRetentionExpiryMs } from '../../delivery/resolve-al-receipt-retention-expiry-ms.ts';`.
  2. Replace `CreateALOutboundAdmissionMutationsInput` and the class head through the constructor (`:105-129`) with:

```ts
export interface CreateALOutboundAdmissionMutationsInput {
    readonly namespace: string;
    readonly canonicalScope: string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly supersedenceTrackTtlMs: number;
    /** The pair the rows are written to: the volatile pair keeps a message's rows only through its receipt grace. */
    readonly durability: ALStoreDurability;
}

/** What a re-read inside the write found: a losable conflict, or a persisted identity that is corrupt. */
export type ALOutboundCommitFenceIssue =
    | Readonly<{ kind: 'conflict'; message: string; }>
    | Readonly<{ kind: 'corruption'; key: string; message: string; }>;

/** Owns the outbound mutation vocabulary: the state write each mutation names, its guards, and its apply. */
export class ALOutboundAdmissionMutations {
    private readonly namespace: string;
    private readonly canonicalScope: string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly supersedenceTrackTtlMs: number;
    private readonly durability: ALStoreDurability;

    constructor(input: CreateALOutboundAdmissionMutationsInput) {
        this.namespace = input.namespace;
        this.canonicalScope = input.canonicalScope;
        this.retention = input.retention;
        this.supersedenceTrackTtlMs = input.supersedenceTrackTtlMs;
        this.durability = input.durability;
    }
```

3. Replace `computeMessageOwnerWrite` (`:233-248`) with:

```ts
/** The owner row answers control that arrives after the message itself is gone, so it outlives both. */
private computeMessageOwnerWrite(
    mutation: Extract<ALOutboundAdmissionMutation, { kind: 'set-msg-owner'; }>,
    nowMs: number
): ALOutboundStateWrite {
    return {
        key: toALOutboundMessageOwnerKey(this.namespace, mutation.msgId),
        value: mutation.senderId,
        expireAtTimestamp: this.computeMessageRowExpiryMs(
            mutation.expireAtTimestamp,
            nowMs,
            this.retention.msgOwnerTtlMs
        ),
        supersedenceGuard: undefined
    };
}
```

4. In `computeSentMessageWrite` (`:293-318`) replace the `expireAtTimestamp: Math.max(...)` property (`:311-315`)
   with

```ts
expireAtTimestamp: this.computeMessageRowExpiryMs(
    mutation.expireAtTimestamp,
    nowMs,
    this.retention.sentMessageTtlMs
),
```

    and add this method right after `computeSentMessageWrite`:

```ts
/**
 * A durable pair answers a late control for the row's TTL past the send; the volatile pair only until the message
 * deadline plus the receipt grace (D74). An admission always names the deadline, so only a bare store write
 * reaches the volatile branch without one, and keeps just the grace.
 */
private computeMessageRowExpiryMs(deadlineAtMs: number | undefined, nowMs: number, rowTtlMs: number): number {
    if (this.durability === 'volatile') {
        return resolveALReceiptRetentionExpiryMs(deadlineAtMs ?? nowMs);
    }
    return Math.max(deadlineAtMs ?? 0, nowMs + rowTtlMs, nowMs + this.retention.controlHistoryTtlMs);
}
```

In `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts`:

1. After the `import type { ... } from '../../al-runtime-state-stores.ts';` block (`:18-22`) add
   `import type { ALStoreDurability } from '../../al-runtime-stores.ts';`.
2. Replace `createALOutboundAdmissionStore` (`:306-310`) with:

```ts
/** Every store but the session's memory pair: its message rows keep their TTL retention. */
export function createALOutboundAdmissionStore<TPrepared>(
    input: CreateALOutboundAdmissionStoreInput<TPrepared>
): ALOutboundAdmissionStore<TPrepared> {
    return new ProviderBackedALOutboundAdmissionStore({ ...input, durability: 'durable' });
}

/** The memory pair's store: a message's owner and sent rows live for its deadline plus the receipt grace (D74). */
export function createVolatileALOutboundAdmissionStore<TPrepared>(
    input: CreateALOutboundAdmissionStoreInput<TPrepared>
): ALOutboundAdmissionStore<TPrepared> {
    return new ProviderBackedALOutboundAdmissionStore({ ...input, durability: 'volatile' });
}

/** The pair a store writes for, fixed by the factory that built it. */
interface ALOutboundPairAdmissionStoreInput<TPrepared>
    extends CreateALOutboundAdmissionStoreInput<TPrepared> {
    readonly durability: ALStoreDurability;
}
```

3. Change the constructor signature (`:324`) to
   `constructor(input: ALOutboundPairAdmissionStoreInput<TPrepared>) {`, and replace the
   `this.mutations = new ALOutboundAdmissionMutations({ ... });` statement (`:347-352`) with:

```ts
this.mutations = new ALOutboundAdmissionMutations({
    namespace: input.namespace,
    canonicalScope: input.canonicalScope,
    retention: input.retention,
    supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
    durability: input.durability
});
```

In `packages/shared/alm/al-runtime-stores.ts`:

1. Replace the outbound store import (`:27-30`) with:

```ts
import {
    createALOutboundAdmissionStore,
    createVolatileALOutboundAdmissionStore,
    type ALOutboundPreparedMessageDecoder,
    type CreateALOutboundAdmissionStoreInput
} from './outbound/admission/al-outbound-admission-store.ts';
```

2. Replace the body of `createInMemoryALOutboundRuntimeStores` (`:119-137`) with:

```ts
const backend = input.outboundBackend ??
    new InMemoryAdmissionBackend(
        createInMemoryALAdmissionState(
            new InMemoryQueueBox(
                undefined,
                () => Temporal.Instant.fromEpochMilliseconds(input.nowMs())
            )
        ),
        input.nowMs
    );
return {
    admissionStore: createALOutboundAdmissionStore(
        toInMemoryALOutboundAdmissionStoreInput(input, backend)
    ),
    workQueue: backend.workQueue
};
```

3. Replace `createVolatileALOutboundRuntimeStores` (`:208-220`) with:

```ts
/** The memory pair a browser carrier routes volatile admissions to; it persists nothing. */
export function createVolatileALOutboundRuntimeStores<TPrepared>(
    options: CreateDefaultALOutboundRuntimeStoresInput<TPrepared>
): ALVolatileOutboundRuntimeStores<TPrepared> {
    const input = { ...toDefaultInMemoryInput(options), decodePrepared: options.decodePrepared };
    const backend = createVolatileALAdmissionBackend(input.nowMs);
    return {
        admissionStore: createVolatileALOutboundAdmissionStore(
            toInMemoryALOutboundAdmissionStoreInput(input, backend)
        ),
        workQueue: backend.workQueue,
        evictExpired: () => backend.evictExpired()
    };
}
```

4. Add after `createVolatileALAdmissionBackend` (`:232-239`):

```ts
function toInMemoryALOutboundAdmissionStoreInput<TPrepared>(
    input: CreateInMemoryALOutboundRuntimeStoresInput<TPrepared>,
    backend: ALAdmissionWorkBackend
): CreateALOutboundAdmissionStoreInput<TPrepared> {
    return {
        nowMs: input.nowMs,
        namespace: `${input.namespace}:outbound:admission`,
        canonicalScope: input.canonicalScope ?? input.namespace,
        backend,
        supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
        retention: normalizeALRuntimeStoreRetention(input.retention),
        decodePrepared: input.decodePrepared
    };
}
```

Run: `npx vitest run packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts packages/tests/shared/alm/outbound packages/tests/shared/alm/al-outbound-store-lane.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/multicast packages/tests/shared/al-outbound-message-runtime.test.ts`
Expected: PASS — the four new tests, and every existing outbound test (the lane test still builds a durable-rule
pair over `createInMemoryALOutboundRuntimeStores` until Step 5, and its two-hour jump still clears it).

- [ ] **Step 5: The outbound lane's eviction test runs over a real volatile pair.** In
      `packages/tests/shared/alm/al-outbound-store-lane.test.ts`:

  1. Replace lines 7-8 (`import { createInMemoryALOutboundRuntimeStores } ...;` and
     `import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '@shared/alm/ALStoreRetention.ts';`) with:

```ts
import {
    AL_VOLATILE_STORE_EVICTION_INTERVAL_MS,
    normalizeALRuntimeStoreRetention
} from '@shared/alm/ALStoreRetention.ts';
import { createVolatileALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
```

2. Replace lines 122-123 (the "one hour" comment and `vi.setSystemTime(startedAtMs + 2 * 60 * 60_000);`) with:

```ts
// The sent and owner rows keep the 1 s deadline plus the receipt grace (D74), gone well before this round.
vi.setSystemTime(startedAtMs + 2 * AL_VOLATILE_STORE_EVICTION_INTERVAL_MS);
```

    The four `toHaveBeenCalledTimes` assertions and their order stay byte-identical, so the four registered
    candidate ids (`docs/test-structure-coupling-exceptions.md:6384-6426`) do not move.

3. Replace the `stores` constant of `createObservedVolatileStores` (`:137-148`) with:

```ts
const stores: ALVolatileOutboundRuntimeStores<OutboundTestPayload> = {
    admissionStore: createVolatileALOutboundAdmissionStore({
        nowMs: Date.now,
        namespace: 'lane-eviction',
        canonicalScope: 'lane-eviction',
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        decodePrepared: decodeOutboundTestPayload
    }),
    workQueue: backend.workQueue,
    evictExpired
};
```

4. In `docs/test-structure-coupling-exceptions.md` replace, in both eviction contracts' `coverageRelation`
   (`:118` outbound, `:178` inbound — Step 8 changes the inbound test), the words
   `past the one-hour row retention` with `past the message deadline plus the receipt grace its rows keep (D74)`:

```bash
sed -i '' 's/past the one-hour row retention/past the message deadline plus the receipt grace its rows keep (D74)/' docs/test-structure-coupling-exceptions.md
grep -c 'past the message deadline plus the receipt grace its rows keep (D74)' docs/test-structure-coupling-exceptions.md
```

Expected: the `grep -c` prints `2`.

Run: `npx vitest run packages/tests/shared/alm/al-outbound-store-lane.test.ts` — Expected: PASS (3 tests).
Run: `node scripts/check-test-structure-coupling.mjs --files packages/tests/shared/alm/al-outbound-store-lane.test.ts`
(the working-tree file mode; the `--changed` range check runs in Step 17 once the work is committed)
— Expected: its four `mock-invocation-count-or-order` candidates report as registered. If one reports
unregistered, an assertion's text moved: restore that line to its original text rather than registering a new id.

- [ ] **Step 6: RED — the inbound owner row.** Create
      `packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts`:

```ts
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import {
    DEFAULT_AL_EPHEMERAL_TTL_MS,
    DEFAULT_AL_REPOSITORY_TTL_MS,
    normalizeALRuntimeStoreRetention
} from '@shared/alm/ALStoreRetention.ts';
import {
    createALInboundAdmissionStore,
    createVolatileALInboundAdmissionStore,
    type ALInboundAdmissionStore,
    type CreateALInboundAdmissionStoreInput
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { toALInboundMessageKey } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import { toALInboundMessageOwnerKey } from '@shared/alm/inbound/al-inbound-source-validation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SELF_PEER_ID,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from '../inbound-runtime-test-fixture.ts';

const NAMESPACE = 'inbound-retention';

interface ObservedBackend {
    readonly state: ALAdmissionMemoryState;
    readonly backend: InMemoryAdmissionBackend;
}

interface ObservedInboundPairs {
    readonly fixture: InboundTestRuntime;
    readonly durable: ALAdmissionMemoryState;
    readonly volatile: ALAdmissionMemoryState;
    readonly durableStore: ALInboundAdmissionStore;
    readonly volatileStore: ALInboundAdmissionStore;
}

describe('the owner row a volatile inbound message keeps (D74)', () => {
    it('keeps it for the message deadline plus the receipt grace, past the work the message owns', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const message = createInboundTestMessage({ msgId: 'volatile-owner' });

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right
        )
            .toEqual({ kind: 'admitted' });

        const rows = readRowExpiries(pairs.volatile, message);
        expect(rows.owner).toBe(readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS);
        // The canonical envelope lives exactly as long as the work that names it: the dispatch, at the deadline.
        expect(rows.canonicalMessage).toBe(readDeadlineMs(message));
    });

    it('keeps a durable message owner row for the repository retention, as before', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const message = createInboundTestMessage({
            msgId: 'durable-owner',
            durability: 'local-inbox'
        });
        const admittedAtMs = Date.now();

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right
        )
            .toEqual({ kind: 'admitted' });

        expect(readRowExpiries(pairs.durable, message).owner).toBe(
            admittedAtMs + DEFAULT_AL_REPOSITORY_TTL_MS
        );
    });

    it('gives a volatile message that names no deadline the one its admission implies, plus the grace', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const message = newALUnicastMessage(
            INBOUND_TEST_SENDER_PEER_ID,
            { topicId: 'chat', resourceId: 'no-deadline', contextId: 'room' },
            INBOUND_TEST_SELF_PEER_ID,
            'chat.private-text.v1',
            { text: 'no-deadline' }
        );
        const admittedAtMs = Date.now();

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right
        )
            .toEqual({ kind: 'admitted' });

        // The admission implies `nowMs + durableEffectTtlMs` (30 min) for a message with no expiry of its own.
        expect(readRowExpiries(pairs.volatile, message).owner)
            .toBe(admittedAtMs + DEFAULT_AL_EPHEMERAL_TTL_MS + AL_RECEIPT_DEADLINE_GRACE_MS);
    });
});

/** Fakes only the clock the rows are stamped with; the rotation keeps its real timers. */
function useFakeDate(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
}

/** A durable and a volatile memory pair whose admission maps the test reads back, behind one ready runtime. */
async function createReadyObservedPairs(): Promise<ObservedInboundPairs> {
    const durable = createObservedBackend();
    const volatile = createObservedBackend();
    const durableStore = createALInboundAdmissionStore(toStoreInput(durable.backend));
    const volatileStore = createVolatileALInboundAdmissionStore(toStoreInput(volatile.backend));
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: { admissionStore: durableStore, workQueue: durable.backend.workQueue },
        volatileStores: {
            admissionStore: volatileStore,
            workQueue: volatile.backend.workQueue,
            evictExpired: () => volatile.backend.evictExpired()
        },
        effectWorkerId: 'al-inbound:retention'
    });
    await fixture.runtime.ready();
    return {
        fixture,
        durable: durable.state,
        volatile: volatile.state,
        durableStore,
        volatileStore
    };
}

function createObservedBackend(): ObservedBackend {
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    return { state, backend: new InMemoryAdmissionBackend(state, Date.now) };
}

function toStoreInput(backend: InMemoryAdmissionBackend): CreateALInboundAdmissionStoreInput {
    return {
        nowMs: Date.now,
        namespace: NAMESPACE,
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    };
}

function readDeadlineMs(message: ALMessage): number {
    const deadlineAtMs = message.constraints?.expiresAtMs;
    if (deadlineAtMs === undefined) {
        throw new Error('The fixture message names its deadline');
    }
    return deadlineAtMs;
}

function readRowExpiries(
    state: ALAdmissionMemoryState,
    message: ALMessage
): Readonly<{ owner: number | undefined; canonicalMessage: number | undefined; }> {
    const { msgId, senderId } = message.id;
    return {
        owner: state.data.get(toALInboundMessageOwnerKey(NAMESPACE, msgId, senderId))
            ?.expireAtTimestamp,
        canonicalMessage: state.data.get(toALInboundMessageKey(NAMESPACE, { msgId, senderId }))
            ?.expireAtTimestamp
    };
}
```

Run: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts`
Expected: FAIL — `al-inbound-admission-store.ts` has no export `createVolatileALInboundAdmissionStore`.

- [ ] **Step 7: GREEN — the inbound owner row knows its pair.** In
      `packages/shared/alm/inbound/al-inbound-admission-store.ts`:

  1. After the `'../al-admission-work-backend.ts'` type import (`:17`) add
     `import type { ALStoreDurability } from '../al-runtime-stores.ts';`.
  2. In `ALInboundMessageReadDto` after `readonly retention: NormalizedALRuntimeStoreRetentionConfig;` (`:144`), in
     `ALInboundAdmissionRead` after the same line (`:163`) and in `ALInboundBufferedReleaseReadDto` after the same
     line (`:193`) add:

```ts
/** The pair the read came from: the volatile pair keeps the message's owner row only through its receipt grace. */
readonly durability: ALStoreDurability;
```

3. Replace `createALInboundAdmissionStore` (`:349-359`) with the two factories below; add
   `readonly durability: ALStoreDurability;` as the last member of
   `ProviderBackedALInboundAdmissionStore.Dependencies` (after `readonly nowMs: () => number;`, `:375`); add the
   public field, read by the control admission in Step 10, to the `ALInboundAdmissionStore` interface after its
   `readonly retention: NormalizedALRuntimeStoreRetentionConfig;` (`:321`; not `:316`, which is the same line in
   `CreateALInboundAdmissionStoreInput`):

```ts
/** The pair this store is: the volatile pair keeps a message's rows only through its receipt grace (D74). */
readonly durability: ALStoreDurability;
```

    and, as `retention` is, to the class: `readonly durability: ALStoreDurability;` after
    `readonly retention: NormalizedALRuntimeStoreRetentionConfig;` (`:381`) and `this.durability = input.durability;`
    after `this.nowMs = input.nowMs;` in the constructor (`:394`):

```ts
/** Every store but the session's memory pair: its message rows keep their TTL retention. */
export function createALInboundAdmissionStore(
    input: CreateALInboundAdmissionStoreInput
): ALInboundAdmissionStore {
    return new ProviderBackedALInboundAdmissionStore({ ...input, durability: 'durable' });
}

/** The session's memory pair's store: a message's owner row lives for its deadline plus the receipt grace (D74). */
export function createVolatileALInboundAdmissionStore(
    input: CreateALInboundAdmissionStoreInput
): ALInboundAdmissionStore {
    return new ProviderBackedALInboundAdmissionStore({ ...input, durability: 'volatile' });
}
```

4. In the two read calls, after `retention: this.retention` of `toALInboundAdmissionRead({ ... })` (`:438`) and of
   `toALInboundBufferedReleaseReadDto({ ... })` (`:505`), add `durability: this.durability` (each with a `,` after
   the preceding `retention: this.retention`).
5. In `ToALInboundAdmissionReadInput` (after `:827`) and `ToALInboundBufferedReleaseReadDtoInput` (after `:882`) add
   `readonly durability: ALStoreDurability;`; in `toALInboundAdmissionRead` after `retention: observed.retention,`
   (`:864`) add `durability: observed.durability,`; in `toALInboundBufferedReleaseReadDto` replace the last property
   `retention: observed.retention` (`:913`) with `retention: observed.retention,` and
   `durability: observed.durability`.

Replace lines 1-36 of `packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts` (the imports and
`toALInboundAdmittedMessageMutations`) with:

```ts
import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import { resolveExpireAtTimestampWithFallback } from '../../ALStoreRetention.ts';
import { resolveALReceiptRetentionExpiryMs } from '../../delivery/resolve-al-receipt-retention-expiry-ms.ts';
import type {
    ALInboundAdmissionMutation,
    ALInboundBufferedReleaseReadDto,
    ALInboundMessageReadDto
} from '../al-inbound-admission-store.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';

/** The provenance, ordering and dedup rows an admitted message owns. */
export function toALInboundAdmittedMessageMutations(
    read: ALInboundMessageReadDto
): readonly ALInboundAdmissionMutation[] {
    const deadlineAtMs = resolveALMessageExpireAtMs(read.msg, read.plan.effective) ??
        read.nowMs + read.retention.durableEffectTtlMs;
    const mutations: ALInboundAdmissionMutation[] = [
        {
            kind: 'set-msg-owner',
            value: {
                msgId: read.msg.id.msgId,
                senderId: read.msg.id.senderId,
                source: read.source,
                supersedenceKey: read.plan.supersedence.key ?? null
            },
            expireAtTimestamp: computeALInboundMessageOwnerExpiryMs(read, deadlineAtMs)
        }
    ];
    if (read.orderingAcceptance.observation.trackKey && read.orderingAcceptance.nextSnapshot) {
        mutations.push({
            kind: 'set-ordering',
            trackKey: read.orderingAcceptance.observation.trackKey,
            snapshot: read.orderingAcceptance.nextSnapshot
        });
    }
    mutations.push({
        kind: 'set-dedup',
        dedupKey: read.plan.dedupKey,
        expireAtTimestamp: read.nowMs + Math.max(0, read.plan.effective.dedup.opts.windowMs)
    });
    return mutations;
}

/**
 * The owner row answers a copy or a control that arrives after the message: the durable pair keeps it for its TTL,
 * the volatile pair for the deadline plus the receipt grace (D74), a message with no expiry of its own having the
 * deadline its admission implies. The commit bundle then extends either to outlive the work the message owns.
 */
export function computeALInboundMessageOwnerExpiryMs(
    read: ALInboundMessageReadDto | ALInboundBufferedReleaseReadDto,
    deadlineAtMs: number
): number {
    return read.durability === 'volatile'
        ? resolveALReceiptRetentionExpiryMs(deadlineAtMs)
        : read.nowMs + read.retention.msgOwnerTtlMs;
}
```

In `packages/shared/alm/inbound/admission/compute-al-inbound-admission.ts`:

1. Replace the delivery-mutations import (`:43-47`) with:

```ts
import {
    computeALInboundMessageOwnerExpiryMs,
    toALInboundAdmittedMessageMutations,
    toALInboundDeliveryMutations,
    toALInboundSupersedenceMutations
} from './al-inbound-delivery-mutations.ts';
```

2. In `computeALInboundMessageRead`, after `retention: read.retention,` (`:104`) add `durability: read.durability,`.
3. In `computeALInboundBufferedRelease`, replace
   `expireAtTimestamp: Math.max(read.nowMs + read.retention.msgOwnerTtlMs, expireAtTimestamp)` (`:218`, the last
   property of the `set-msg-owner` mutation literal, so no trailing comma) with:

```text
expireAtTimestamp: Math.max(
    computeALInboundMessageOwnerExpiryMs(read, expireAtTimestamp),
    expireAtTimestamp
)
```

    (the durable value is `max(now + msgOwnerTtlMs, expiry)` exactly as before; the volatile one is
    `expiry + grace`).

In `packages/shared/alm/al-runtime-stores.ts`:

1. Replace `import { createALInboundAdmissionStore } from './inbound/al-inbound-admission-store.ts';` (`:15`) with:

```ts
import {
    createALInboundAdmissionStore,
    createVolatileALInboundAdmissionStore,
    type CreateALInboundAdmissionStoreInput
} from './inbound/al-inbound-admission-store.ts';
```

2. Replace the `return { admissionStore: createALInboundAdmissionStore({ ... }), workQueue: backend.workQueue };` of
   `createInMemoryALInboundRuntimeStores` (`:103-113`) with:

```ts
return {
    admissionStore: createALInboundAdmissionStore(
        toInMemoryALInboundAdmissionStoreInput(input, backend)
    ),
    workQueue: backend.workQueue
};
```

3. Replace `createVolatileALInboundRuntimeStores` (`:222-230`) with:

```ts
/** The session's inbound memory pair, shared by both carriers' volatile lanes; it persists nothing. */
export function createVolatileALInboundRuntimeStores(
    options: CreateDefaultALRuntimeStoresInput = {}
): ALVolatileInboundRuntimeStores {
    const input = toDefaultInMemoryInput(options);
    const backend = createVolatileALAdmissionBackend(input.nowMs);
    return {
        admissionStore: createVolatileALInboundAdmissionStore(
            toInMemoryALInboundAdmissionStoreInput(input, backend)
        ),
        workQueue: backend.workQueue,
        evictExpired: () => backend.evictExpired()
    };
}
```

4. Add beside `toInMemoryALOutboundAdmissionStoreInput` (Step 4):

```ts
function toInMemoryALInboundAdmissionStoreInput(
    input: CreateInMemoryALRuntimeStoresInput,
    backend: ALAdmissionWorkBackend
): CreateALInboundAdmissionStoreInput {
    return {
        nowMs: input.nowMs,
        namespace: `${input.namespace}:inbound:admission`,
        backend,
        orderingTrackTtlMs: input.orderingTrackTtlMs,
        supersedenceTrackTtlMs: input.supersedenceTrackTtlMs,
        retention: normalizeALRuntimeStoreRetention(input.retention)
    };
}
```

In `packages/tests/shared/alm/al-inbound-admission-preparation.test.ts` the buffered-release read literal
(`:125-146`) is typed by `computeALInboundBufferedRelease`: replace its last property `retention:
  prepared.read.retention` (`:145`) with `retention: prepared.read.retention,` and `durability:
  prepared.read.durability`.

Run: `npx vitest run packages/tests/shared/alm/inbound packages/tests/shared/alm/al-inbound-store-lane.test.ts packages/tests/shared/alm/al-inbound-admission-preparation.test.ts packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
Expected: PASS — the three new tests and every existing inbound test (no durable figure moves, so the inbound
operation-count pins stay at 8, 0 and 8).

- [ ] **Step 8: The inbound lane's eviction test runs over a real volatile pair.** In
      `packages/tests/shared/alm/al-inbound-store-lane.test.ts`:

  1. Replace lines 8-10 (`import { createInMemoryALInboundRuntimeStores } ...;`,
     `import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } ...;` and
     `import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';`) with:

```ts
import {
    AL_VOLATILE_STORE_EVICTION_INTERVAL_MS,
    normalizeALRuntimeStoreRetention
} from '@shared/alm/ALStoreRetention.ts';
import {
    createVolatileALInboundAdmissionStore,
    type ALInboundAdmissionStore
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
```

2. Replace lines 191-192 (`// The owner rows keep the repository retention, well past the message deadline.` and
   `vi.setSystemTime(startedAtMs + 2 * 60 * 60_000);`) with:

```ts
// The owner row keeps the 60 s deadline plus the receipt grace (D74): gone 90 s after the send.
vi.setSystemTime(startedAtMs + 2 * AL_VOLATILE_STORE_EVICTION_INTERVAL_MS);
```

    The four `toHaveBeenCalledTimes` assertions stay byte-identical (registered ids
    `test-structure-coupling-a76905264c4dbd25`, `-3ed44bfcf42e6b49`, `-e70640c1eff73157`, `-28e5829345b59be3`).

3. Replace the `stores` constant of `createObservedInboundPairs` (`:221-231`) with:

```ts
const stores: ALVolatileInboundRuntimeStores = {
    admissionStore: createVolatileALInboundAdmissionStore({
        nowMs: Date.now,
        namespace: 'lane-volatile',
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    }),
    workQueue: backend.workQueue,
    evictExpired
};
```

The contract prose at `docs/test-structure-coupling-exceptions.md:178` was already updated in Step 5.

Run: `npx vitest run packages/tests/shared/alm/al-inbound-store-lane.test.ts` — Expected: PASS (every test; the
routing tests read the owner row back within its 90 s).
Run: `node scripts/check-test-structure-coupling.mjs --files packages/tests/shared/alm/al-inbound-store-lane.test.ts`
— Expected: every candidate of the file reports as registered.

- [ ] **Step 9: RED — the control rows of a volatile message.** Two (a) rows of the ruling, one per direction: the
      outbound control-history row with a completed receipt row, and the inbound acknowledgement-history row of a
      relay row.

  In `packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts` (Step 3):

  1. Replace the key import with

```ts
import {
    toALOutboundControlHistoryKey,
    toALOutboundMessageOwnerKey,
    toALOutboundPendingAckKey,
    toALOutboundSentMessageKey
} from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
```

    the retention import with
    `import { DEFAULT_AL_EPHEMERAL_TTL_MS, DEFAULT_AL_REPOSITORY_TTL_MS, normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';`,
    and the fixture import with

```ts
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    toOutboundTestAck,
    trackOutboundTestAcks
} from '../outbound-runtime-test-fixture.ts';
```

2. Append at the end of the file:

```ts
describe('the control rows a volatile outbound send keeps (D74)', () => {
    it('keeps a completed receipt row and its acknowledgement history for the deadline plus the receipt grace', async () => {
        useFakeDate();
        const pair = createObservedOutboundPair('volatile');
        const runtime = createDefaultOutboundTestRuntime({
            stores: createDefaultOutboundTestStores(),
            volatileStores: pair.stores,
            planOutgoingMessage: (msg) => ({
                ...planSend(msg),
                ackTracking: trackOutboundTestAcks(['peer-1'])
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('acknowledged-rows', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);

        expect(await runtime.acceptControlMessage(toOutboundTestAck(message, 'peer-1'), 'peer'))
            .toEqual({ kind: 'committed' });

        const keptUntilMs = readDeadlineMs(message) + AL_RECEIPT_DEADLINE_GRACE_MS;
        expect(readControlRowExpiries(pair.state, message)).toEqual({
            receipt: keptUntilMs,
            acks: keptUntilMs
        });
    });

    it('keeps them for the ephemeral TTL on the durable pair, as before', async () => {
        useFakeDate();
        const pair = createObservedOutboundPair('durable');
        const runtime = createDefaultOutboundTestRuntime({
            stores: pair.stores,
            planOutgoingMessage: (msg) => ({
                ...planSend(msg),
                persist: true,
                ackTracking: trackOutboundTestAcks(['peer-1'])
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('acknowledged-durable-rows', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);
        const acknowledgedAtMs = Date.now();

        expect(await runtime.acceptControlMessage(toOutboundTestAck(message, 'peer-1'), 'peer'))
            .toEqual({ kind: 'committed' });

        const keptUntilMs = acknowledgedAtMs + DEFAULT_AL_EPHEMERAL_TTL_MS;
        expect(readControlRowExpiries(pair.state, message)).toEqual({
            receipt: keptUntilMs,
            acks: keptUntilMs
        });
    });
});

/** The receipt row, which the completing ACK leaves as its final snapshot, and the ACK history beside it. */
function readControlRowExpiries(
    state: ALAdmissionMemoryState,
    message: ALMessage
): Readonly<{ receipt: number | undefined; acks: number | undefined; }> {
    const { msgId, senderId } = message.id;
    return {
        receipt: state.data.get(
            toALOutboundPendingAckKey({ namespace: NAMESPACE, originPeerId: senderId, msgId })
        )
            ?.expireAtTimestamp,
        acks: state.data.get(toALOutboundControlHistoryKey(NAMESPACE, 'acks', msgId))
            ?.expireAtTimestamp
    };
}
```

In `packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts` (Step 6):

1. Replace `import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';` with
   `import { AL_RECEIPT_DEADLINE_GRACE_MS, newALAckControlMessage } from '@shared/al-contracts/al-control.ts';`, add
   `import { toALInboundControlAcksKey } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';` after the
   `al-inbound-source-validation.ts` import, and add `readInboundTestDecisionSurface,` to the fixture import after
   `INBOUND_TEST_SOURCE,`.
2. Append at the end of the file:

```ts
describe('the acknowledgement history a volatile relay row keeps (D74)', () => {
    it('keeps it for the relayed message deadline plus the receipt grace', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const tracked = createInboundTestMessage({ msgId: 'relayed-volatile' });
        await seedRelayRow(pairs.volatileStore, tracked);

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(
                toSenderAck(tracked),
                INBOUND_TEST_SOURCE
            )).right
        )
            .toEqual({ kind: 'control', handled: true });

        expect(readAcksExpiry(pairs.volatile, tracked)).toBe(
            readDeadlineMs(tracked) + AL_RECEIPT_DEADLINE_GRACE_MS
        );
    });

    it('keeps it for the control-history TTL on the durable pair, as before', async () => {
        useFakeDate();
        const pairs = await createReadyObservedPairs();
        const tracked = createInboundTestMessage({
            msgId: 'relayed-durable',
            durability: 'local-inbox'
        });
        await seedRelayRow(pairs.durableStore, tracked);
        const acknowledgedAtMs = Date.now();

        expect(
            (await pairs.fixture.runtime.admitIncomingMessage(
                toSenderAck(tracked),
                INBOUND_TEST_SOURCE
            )).right
        )
            .toEqual({ kind: 'control', handled: true });

        expect(readAcksExpiry(pairs.durable, tracked)).toBe(
            acknowledgedAtMs + DEFAULT_AL_EPHEMERAL_TTL_MS
        );
    });
});

/** The relay row this peer keeps for the tracked message: the fixture's sender owes one ACK before the deadline. */
async function seedRelayRow(store: ALInboundAdmissionStore, message: ALMessage): Promise<void> {
    const deadlineAtMs = readDeadlineMs(message);
    const { msgId, senderId } = message.id;
    const committed = await store.commitBundle({
        admissionExpiresAtMs: null,
        senderId,
        observations: (await readInboundTestDecisionSurface(store, message)).observations,
        mutations: [{
            kind: 'set-msg-owner',
            value: { msgId, senderId, source: INBOUND_TEST_SOURCE, supersedenceKey: null },
            expireAtTimestamp: deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS
        }, {
            kind: 'set-control-pending',
            msgId,
            senderId,
            value: {
                kind: 'pending',
                value: {
                    toPeerId: 'upstream',
                    status: 'subtree-complete',
                    localReady: true,
                    expectedFromPeerIds: [INBOUND_TEST_SENDER_PEER_ID],
                    ackedFromPeerIds: [],
                    expireAtTimestamp: deadlineAtMs,
                    carrier: 'ws'
                }
            },
            expireAtTimestamp: deadlineAtMs
        }, {
            kind: 'set-control-owners',
            msgId,
            value: {
                ambiguous: false,
                values: [{ peerId: INBOUND_TEST_SENDER_PEER_ID, senderId }]
            },
            expireAtTimestamp: deadlineAtMs
        }],
        durableEffects: []
    });
    expect(committed).toBe('committed');
}

function toSenderAck(tracked: ALMessage): ALMessage {
    return newALAckControlMessage(
        {
            v: 2,
            msgId: `ack-${tracked.id.msgId}`,
            senderId: INBOUND_TEST_SENDER_PEER_ID,
            ts: Date.now()
        },
        {
            ackedMsgId: tracked.id.msgId,
            fromPeerId: INBOUND_TEST_SENDER_PEER_ID,
            toPeerId: INBOUND_TEST_SELF_PEER_ID,
            originPeerId: tracked.id.senderId,
            logicalRecipientPeerId: INBOUND_TEST_SENDER_PEER_ID,
            carrier: 'ws',
            status: 'accepted',
            observedAtEpochMs: Date.now()
        }
    );
}

function readAcksExpiry(state: ALAdmissionMemoryState, message: ALMessage): number | undefined {
    const { msgId, senderId } = message.id;
    return state.data.get(toALInboundControlAcksKey(NAMESPACE, msgId, senderId))?.expireAtTimestamp;
}
```

Run: `npx vitest run packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts`
Expected: FAIL — exactly the two volatile tests of the new describes: the outbound receipt and history rows read
`acknowledgedAt + 30 min` instead of `deadline + 30 s`, and the inbound history row reads `acknowledgedAt + 30 min`.
Both durable tests and every earlier test pass.

- [ ] **Step 10: GREEN — the control admissions cap a volatile message's control rows.** One rule in both
      directions: on the volatile pair a control row expires at `min(its TTL expiry, deadline + grace)`, so a
      pending receipt keeps its deadline and a history or completed-receipt row stops at the grace.

  In `packages/shared/alm/outbound/control/al-outbound-control-admission.ts` (405 lines, at a size tier: one field,
  one input member, two call sites and one private method):

  1. After `import { ALAdmissionBackendConflictError } from '../../ALAdmissionBackendConflictError.ts';` (`:13`) add
     `import type { ALStoreDurability } from '../../al-runtime-stores.ts';`, and after the
     `'../../work/al-work-queue-port.ts'` import (`:16`) add
     `import { resolveALReceiptRetentionExpiryMs } from '../../delivery/resolve-al-receipt-retention-expiry-ms.ts';`.
  2. In `CreateALOutboundControlAdmissionInput` (`:77-88`) add after `readonly retention: ...;`:

```ts
/** The pair the control rows are written to: the volatile pair keeps them only through the receipt grace. */
readonly durability: ALStoreDurability;
```

    add `private readonly durability: ALStoreDurability;` after `private readonly retention: ...;` (`:97`) and
    `this.durability = input.durability;` after `this.retention = input.retention;` (`:108`).

3. In `applyControlAdmission` (`:363-392`) replace the history write's third argument
   `candidate.controlExpireAtTimestamp` (`:371`) with
   `this.computeControlRowExpiryMs(candidate.controlExpireAtTimestamp, read)` and the receipt write
   `await tx.set(pendingAckKey, candidate.pending.value, candidate.receiptExpireAtTimestamp);` (`:382`) with

```ts
await tx.set(
    pendingAckKey,
    candidate.pending.value,
    this.computeControlRowExpiryMs(candidate.receiptExpireAtTimestamp, read)
);
```

    and add after `applyControlAdmission`:

```ts
/**
 * The volatile pair keeps a message's control rows no longer than its deadline plus the receipt grace (D74):
 * past it the owner row is gone and no control reads them. A pending receipt still ends at the deadline.
 */
private computeControlRowExpiryMs(expireAtTimestamp: number, read: ALControlAdmissionRead): number {
    if (this.durability !== 'volatile' || read.sent === undefined) {
        return expireAtTimestamp;
    }
    return Math.min(expireAtTimestamp, resolveALReceiptRetentionExpiryMs(read.sent.reference.expiresAtMs));
}
```

In `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts` (Step 4 already gives the constructor its
`durability` input): add `private readonly durability: ALStoreDurability;` after
`private readonly retention: NormalizedALRuntimeStoreRetentionConfig;` (`:316`), `this.durability = input.durability;`
after `this.retention = input.retention;` (`:328`), and in `createControlAdmission` (`:359-370`) replace
`retention: this.retention` with `retention: this.retention,` and `durability: this.durability`.

In `packages/shared/alm/inbound/control/al-inbound-control-admission.ts`:

1. After `import type { ALWorkOutcome, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';` (`:8`) add
   `import { resolveALReceiptRetentionExpiryMs } from '../../delivery/resolve-al-receipt-retention-expiry-ms.ts';`.
2. In `commitControlAdmission` replace `const bundle = toALInboundControlCommitBundle(candidate);` with
   `const bundle = toALInboundControlCommitBundle(this.toStoreCandidate(candidate));`, and add after
   `commitControlAdmission`:

```ts
/**
 * The volatile pair keeps a message's acknowledgement history no longer than its deadline plus the receipt grace
 * (D74): the control-owner index that admits an acknowledgement expires at the deadline, and a data copy past it
 * is refused expired. A relay row of a message that named no deadline carries none, so its history keeps the TTL.
 */
private toStoreCandidate(candidate: ALInboundControlAdmissionCandidate): ALInboundControlAdmissionCandidate {
    const deadlineAtMs = candidate.read.pending?.expireAtTimestamp;
    if (this.admissionStore.durability !== 'volatile' || deadlineAtMs === undefined) {
        return candidate;
    }
    return {
        ...candidate,
        controlExpireAtTimestamp: Math.min(
            candidate.controlExpireAtTimestamp,
            resolveALReceiptRetentionExpiryMs(deadlineAtMs)
        )
    };
}
```

(`ALInboundControlAdmission` reads `admissionStore.durability`, the public field Step 7 added; its dependencies
and `createTestALInboundControlAdmission` in `packages/shared-test/shared/create-test-al-inbound-work-port.ts` do
not change.)

Run: `npx vitest run packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts packages/tests/shared/alm/al-outbound-control-admission.test.ts packages/tests/shared/alm/inbound packages/tests/shared/alm/outbound-control-version-candidate.test.ts packages/tests/shared/alm/al-outbound-store-lane.test.ts packages/tests/shared/alm/al-inbound-store-lane.test.ts`
Expected: PASS (the durable writers and the pure `compute*ControlAdmission` functions are unchanged, so their
direct tests keep their figures).

- [ ] **Step 11: RED — the empty-audience volatile pin (D75).** Create
      `packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationCounts,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    toOriginFrozenTargets
} from '../multicast/rtc-origin-overlay-fixture.ts';

const NAMESPACE = 'rtc-origin-alone';

describe('an RTC origin alone in its room, sending volatile (D75)', () => {
    it('acknowledges a receiver send in 0 al-admission and 0 non-probe al-work IndexedDB operations', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const durableStores = createIndexedDbOriginStores(observer);
        const volatileStores = createVolatileALOutboundRuntimeStores({
            decodePrepared: decodeALOutboundTransportMessage
        });
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a'], 4),
            nextHopPeerIds: [],
            stores: durableStores,
            volatileStores
        });
        const message = createOriginReceiverMulticast('alone-counted');

        const admitted = await fixture.manager.enqueueIfAbsent(message);

        // The origin's durable pair is the counted IndexedDB pair, so the zeros below measure it.
        expect(fixture.resources.admissionStore).toBe(durableStores.admissionStore);
        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: false });
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets([], 4));
        expect(await volatileStores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(
            true
        );
        await vi.waitFor(() =>
            expect(
                fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')
            ).toEqual([
                expect.objectContaining({
                    msgId: message.id.msgId,
                    mode: 'receiver',
                    complete: true
                })
            ])
        );
        const counts = observer.getCounts();
        expect(counts.byOwner['al-admission'], 'an origin alone commits nothing to IndexedDB').toBe(
            0
        );
        expect(computeNonProbeWorkOperations(counts), 'the idle durable owner only probes').toBe(0);
    });
});

function createIndexedDbOriginStores(
    observer: IndexedDbOperationObserver
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `${NAMESPACE}-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer
    });
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: NAMESPACE,
            decodePrepared: decodeALOutboundTransportMessage,
            namespace: NAMESPACE,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue
    };
}

/** Probes (`work-page`, `work-probe`) are the idle durable owner reading an empty queue, never work (R-S3a-11). */
function computeNonProbeWorkOperations(counts: IndexedDbOperationCounts): number {
    return counts.byOwner['al-work'] - (counts.byKind['work-page'] ?? 0) -
        (counts.byKind['work-probe'] ?? 0);
}
```

(`computeNonProbeWorkOperations` repeats the private one-line helper of
`al-indexeddb-operation-counts.test.ts:698-700` rather than touching that file, which is at a size tier and holds
registered candidates.)

Run: `npx vitest run packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts`
Expected: FAIL at `expect(fixture.resources.admissionStore).toBe(durableStores.admissionStore)` — the fixture has no
`stores` input yet and builds an in-memory durable pair, so without this guard the zeros would measure nothing.

- [ ] **Step 12: GREEN — the origin fixture takes the counted durable pair.** In
      `packages/tests/shared/multicast/rtc-origin-overlay-fixture.ts`:

  1. Add `ALOutboundRuntimeStores,` to the type import from `'@shared/alm/outbound/al-outbound-message-runtime.ts'`
     (`:8-12`), between `ALOutboundMessageRuntime,` and `ALVolatileOutboundRuntimeStores`.
  2. In `RtcOriginOverlayFixtureInput` (`:52-59`) add before `volatileStores`:

```ts
/** The durable pair the origin admits to; absent, an in-memory pair (a counting test hands an IndexedDB one). */
readonly stores?: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
```

3. Replace the `createDefaultALOutboundRuntimeResources({ ... })` call (`:80-83`) with:

```ts
const resources = createDefaultALOutboundRuntimeResources({
    decodePrepared: decodeALOutboundTransportMessage,
    stores: input.stores,
    volatileStores: input.volatileStores
});
```

Run: `npx vitest run packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts packages/tests/shared/multicast`
Expected: PASS. A failure of either zero is a regression of S3a's volatile path (D55), not an expectation to
edit: stop and report the counts by kind.

- [ ] **Step 13: RED — the relay-row figure (C14).** The standard relay workload is the one the relay tests use
      (`web-rtc-overlay-missing-recipient-repair.test.ts:68-80`): room `['a', 'r', 'b', 'c']`, origin `a` addressing
      `r` and `c`, relay `r` owning child `b`. Create
      `packages/tests/shared/multicast/rtc-relay-row-retention.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALAckControlMessage
} from '@shared/al-contracts/al-control.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createVolatileALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { toALInboundMessageKey } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import type { ALVolatileInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundMessageOwnerKey } from '@shared/alm/inbound/al-inbound-source-validation.ts';
import {
    toALInboundControlAcksKey,
    toALInboundControlOwnersKey,
    toALInboundControlPendingKey
} from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain
} from './rtc-origin-overlay-fixture.ts';
import {
    createRtcRelayOverlayFixture,
    type RtcRelayOverlayFixture
} from './rtc-relay-overlay-fixture.ts';

const RELAY_NAMESPACE = 'relay-rows';
/** The dedup window of every default policy (`normalize-al-qos-policy.ts:171`). */
const DEDUP_WINDOW_MS = 60_000;

interface RelayedMessage {
    readonly relay: RtcRelayOverlayFixture;
    readonly state: ALAdmissionMemoryState;
    readonly copy: ALMessage;
    readonly admittedAtMs: number;
}

interface ObservedVolatileInboundPair {
    readonly state: ALAdmissionMemoryState;
    readonly stores: ALVolatileInboundRuntimeStores;
}

describe('the rows an RTC relay keeps for one relayed volatile message (C14)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('keeps its relay row, owner index and envelope to the deadline and its owner row through the grace', async () => {
        const relayed = await relayOneMessage();
        const deadlineAtMs = readDeadlineMs(relayed.copy);

        expect(readRowKinds(relayed.state)).toEqual([
            'control:owners',
            'control:pending',
            'dedup',
            'message',
            'msg-owner'
        ]);
        expect(readRelayRowExpiries(relayed.state, relayed.copy)).toEqual({
            pendingAck: deadlineAtMs,
            controlOwners: deadlineAtMs,
            canonicalMessage: deadlineAtMs,
            messageOwner: deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS,
            dedup: relayed.admittedAtMs + DEDUP_WINDOW_MS
        });
    });

    it('keeps the acknowledgement-history row its child ACK adds through the grace, like its owner row', async () => {
        const relayed = await relayOneMessage();

        await relayed.relay.receive(toChildAck(relayed.copy), 'b');

        const { msgId, senderId } = relayed.copy.id;
        expect(
            relayed.state.data.get(toALInboundControlAcksKey(RELAY_NAMESPACE, msgId, senderId))
                ?.expireAtTimestamp
        )
            .toBe(readDeadlineMs(relayed.copy) + AL_RECEIPT_DEADLINE_GRACE_MS);
    });
});

async function relayOneMessage(): Promise<RelayedMessage> {
    const snapshot = createOriginSnapshot(['a', 'r', 'b', 'c'], 4);
    const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['r', 'c'] });
    const pair = createObservedVolatileInboundPair();
    const relay = createRtcRelayOverlayFixture({
        selfPeerId: 'r',
        snapshot,
        neighbourPeerIds: ['a', 'b'],
        inboundVolatileStores: pair.stores
    });
    await enqueueAndDrain(origin.manager, createOriginReceiverMulticast('relay-rows'));
    const copy = origin.channels.r!.sent[0]!;
    const admittedAtMs = Date.now();
    await relay.receive(copy, 'a');
    return { relay, state: pair.state, copy, admittedAtMs };
}

/** The relay session's memory pair, whose admission map the test reads back. */
function createObservedVolatileInboundPair(): ObservedVolatileInboundPair {
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    return {
        state,
        stores: {
            admissionStore: createVolatileALInboundAdmissionStore({
                nowMs: Date.now,
                namespace: RELAY_NAMESPACE,
                backend,
                orderingTrackTtlMs: 5 * 60_000,
                supersedenceTrackTtlMs: 5 * 60_000,
                retention: normalizeALRuntimeStoreRetention()
            }),
            workQueue: backend.workQueue,
            evictExpired: () => backend.evictExpired()
        }
    };
}

/** Each row's kind: the key segment after the namespace, with the second segment under `control`. */
function readRowKinds(state: ALAdmissionMemoryState): readonly string[] {
    return [...state.data.keys()].map((key) => {
        const [kind = '', detail = ''] = key.slice(RELAY_NAMESPACE.length + 1).split(':');
        return kind === 'control' ? `${kind}:${detail}` : kind;
    }).sort();
}

function readRelayRowExpiries(
    state: ALAdmissionMemoryState,
    copy: ALMessage
): Readonly<
    Record<
        'pendingAck' | 'controlOwners' | 'canonicalMessage' | 'messageOwner' | 'dedup',
        number | undefined
    >
> {
    const { msgId, senderId } = copy.id;
    const expiryOf = (key: string) => state.data.get(key)?.expireAtTimestamp;
    return {
        pendingAck: expiryOf(toALInboundControlPendingKey(RELAY_NAMESPACE, msgId, senderId)),
        controlOwners: expiryOf(toALInboundControlOwnersKey(RELAY_NAMESPACE, msgId)),
        canonicalMessage: expiryOf(toALInboundMessageKey(RELAY_NAMESPACE, { msgId, senderId })),
        messageOwner: expiryOf(toALInboundMessageOwnerKey(RELAY_NAMESPACE, msgId, senderId)),
        dedup: [...state.data.values()].find((row) =>
            row.key.startsWith(`${RELAY_NAMESPACE}:dedup:`)
        )?.expireAtTimestamp
    };
}

function readDeadlineMs(message: ALMessage): number {
    const deadlineAtMs = message.constraints?.expiresAtMs;
    if (deadlineAtMs === undefined) {
        throw new Error('The origin copy names its deadline');
    }
    return deadlineAtMs;
}

/** The leaf `b`'s terminal ACK to its relay `r` for the origin's message. */
function toChildAck(copy: ALMessage): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: 'ack-b', senderId: 'b', ts: Date.now() },
        {
            ackedMsgId: copy.id.msgId,
            fromPeerId: 'b',
            toPeerId: 'r',
            originPeerId: copy.id.senderId,
            logicalRecipientPeerId: 'b',
            carrier: 'rtc',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}
```

Run: `npx vitest run packages/tests/shared/multicast/rtc-relay-row-retention.test.ts`
Expected: FAIL — the relay fixture has no `inboundVolatileStores` input yet, so the relay admits into its own
in-memory pair and the observed map is empty (`readRowKinds` returns `[]`).

- [ ] **Step 14: GREEN — the relay fixture takes the session's memory pair; record the figure.** In
      `packages/tests/shared/multicast/rtc-relay-overlay-fixture.ts`:

  1. After `import { decodePersistedALMessage } ...;` (`:5`) add
     `import type { ALVolatileInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';`.
  2. In `RtcRelayOverlayFixtureInput` (`:23-28`) add after `neighbourPeerIds`:

```ts
/** The session's memory pair a volatile message is admitted to; absent, every admission uses one in-memory pair. */
readonly inboundVolatileStores?: ALVolatileInboundRuntimeStores;
```

3. In the `shared.createDefaultWebRtcRxStreamerService({ ... })` call (`:65-70`) add after
   `inboundStores: shared.createDefaultInMemoryALInboundRuntimeStores(),`:

```ts
inboundVolatileStores: input.inboundVolatileStores,
```

Run: `npx vitest run packages/tests/shared/multicast/rtc-relay-row-retention.test.ts packages/tests/shared/multicast`
Expected: PASS. The table is derived from the code (pending row and owner index at the pending deadline,
`compute-al-inbound-admission.ts:244-316`; the envelope at its owned work,
`prepare-al-inbound-commit-bundle.ts:135-149`; the owner row at deadline + grace; the dedup row at admission + 60 s;
the acknowledgement history capped at deadline + grace by Step 10). If only
`readRowKinds` differs, the received list is the measurement: set the expected list to it, name each added kind in
the commit message, and carry the count into Step 15. A differing expiry is a defect in Steps 6-10: stop and report
it.

- [ ] **Step 15: Docs — the retention rule, the pin and the relay-row figure.**

  In `packages/shared/alm/inbound/README.md` replace the "Eviction on the owner's round" bullet (`:82-88`) with:

```markdown
- **Eviction on the owner's round.** Session cleanup and a storage reset never reach the
  memory pair; it dies with the middleware. Each lane over it (worker id
  `${effectWorkerId}/volatile`) sweeps its expired rows from its own work round, at most
  once per `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS` (60 s) of its clock. Its message-owner
  row lives for the message deadline plus the 30 s receipt grace
  ([`resolveALReceiptRetentionExpiryMs`](../delivery/resolve-al-receipt-retention-expiry-ms.ts), D74),
  or longer when the work the message owns does; a message with no expiry of its own has
  the deadline its admission implies (`durableEffectTtlMs`, 30 min). The durable pair keeps
  the owner row for the repository's 1 h. Both inbound lanes sweep the shared pair on their
  own 60 s schedule; this is idempotent.
```

and insert after the paragraph that ends ``(`work-page`, `work-probe`, R-S3a-11).`` (`:97`), with one blank line on
each side:

```markdown
An RTC relay keeps <RELAY_ROWS_AFTER_ADMISSION> rows in the session's memory pair for one relayed volatile message
([`rtc-relay-row-retention.test.ts`](../../../tests/shared/multicast/rtc-relay-row-retention.test.ts), the
standard four-session relay): its pending-ACK row (the relay row), its control-owner index and the canonical
envelope until the message deadline, its message-owner row until the deadline plus the 30 s receipt grace, and
the dedup row for the 60 s dedup window. Once its child's ACK arrives it adds an acknowledgement-history row, kept
until the deadline plus the grace as well. Before S3c-ii the owner row stayed for an hour and the history row
30 min.
```

`<RELAY_ROWS_AFTER_ADMISSION>` is a measurement slot: write the number of entries of the expected `readRowKinds`
list in the passing Step 14 run (five as derived; the measured count if Step 14 recorded another).

In `packages/shared/alm/outbound/README.md` replace the two sentences of the "Eviction on the owner's round" bullet
that begin `The rows it sweeps carry the repository's 1 h retention` (`:80-82`) with the lines below, each indented
two spaces in the README as a continuation of that bullet (the block shows them at column 0):

```markdown
timer runs for it. Its message-owner and sent-message rows live for the message deadline plus the 30 s
receipt grace ([`resolveALReceiptRetentionExpiryMs`](../delivery/resolve-al-receipt-retention-expiry-ms.ts), D74), the
window in which a receipt or a late control about the message is still answered; the durable pair keeps
them for `max(deadline, now + 1 h)`. A control that arrives after them finds no lane owning its message,
goes to the durable lane and is refused there as a control about an unknown message. The control-history
rows and a completed receipt row stop at the same deadline plus the grace on the volatile pair and keep 30 min
(`controlHistoryTtlMs`, `durableEffectTtlMs`) on the durable pair; the per-origin version row keeps
`versionTtlMs` (1 h) on both, since it fences every commit of its origin rather than one message.
```

(the replaced text starts at `timer runs for it. The rows it sweeps` on `:80` and ends at `bound.` on `:82`), and
append to the storage-cost paragraph, after `(R-S3a-11, R-S3a-13).` (`:105`):

```markdown
An RTC origin alone in its room spends 0 `al-admission` and 0 non-probe `al-work` operations on a volatile
`receiver` send and states its complete acknowledgement at the commit
([`al-indexeddb-empty-audience-counts.test.ts`](../../../tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts),
D75).
```

Run: `npx dprint check packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md`
Expected: no diff (`npx dprint fmt` on those two files if it reports one).

- [ ] **Step 16: Validate.** Read each summary line, not the exit code.

  1. `npx vitest run packages/tests/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.test.ts packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts packages/tests/shared/multicast/rtc-relay-row-retention.test.ts packages/tests/shared/alm/al-outbound-store-lane.test.ts packages/tests/shared/alm/al-inbound-store-lane.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-outbound-control-admission.test.ts packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts`
     — Expected: all pass; the operation-count pins read 10/15, 0/0, 8, 0/0, 8 as before (D87: they may only fall).
  2. `npm run test:unit` — Expected: the summary line shows 0 failed. A failure in a test that delivers a control or
     receipt to a volatile message later than its deadline plus 30 s is this task's stated behaviour change (the
     rules above); if such a test asserts the old one-hour answer, report it to the controller with the test name
     instead of editing its assertion.
  3. `npm run typecheck` and `npm run typecheck:tests` — Expected: 0 errors, and no new entry over the tests
     typecheck baseline.
  4. Deno, since `packages/shared` changed: `cd apps/api-v1 && deno task check`,
     `cd apps/rallar-black-box-control-server && deno task check`, `cd apps/relic-hunter-server-v1 && deno task check`,
     then `npm run test:deno` — Expected: every check clean and the `test:deno` summary with 0 failed.
  5. Browser reach (`packages/shared/alm` is in both bundles):
     `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
     and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` — Expected: PASS, no snapshot moves
     (no shared-web export changes). Record both measured figures for the commit message. If the facade figure
     crosses its ceiling (224 unless an earlier task raised it), raise `brotliBudgetKiB` to the next whole KiB in
     `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts` and
     `packages/shared-web/scripts/measure-browser-bundles.mjs` and append to both comments
     `The S3c-ii volatile retention rule measures <measured facade KiB> KiB. The next whole-KiB ceiling is
     <new ceiling>.`;
     if the headless figure crosses its ceiling (286 unless raised), raise `toBeLessThan(...)` in
     `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` the same way, with
     `The S3c-ii volatile retention rule measures <measured headless KiB> KiB here.` (measurement slots).
  6. `npx dprint check` with every touched file listed (never a glob):
     `npx dprint check packages/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts packages/shared/alm/outbound/control/compute-al-outbound-receipt-admission.ts packages/shared/alm/outbound/admission/al-outbound-admission-mutations.ts packages/shared/alm/outbound/admission/al-outbound-admission-store.ts packages/shared/alm/outbound/control/al-outbound-control-admission.ts packages/shared/alm/inbound/al-inbound-admission-store.ts packages/shared/alm/inbound/control/al-inbound-control-admission.ts packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts packages/shared/alm/inbound/admission/compute-al-inbound-admission.ts packages/shared/alm/al-runtime-stores.ts packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md docs/test-structure-coupling-exceptions.md packages/tests/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.test.ts packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts packages/tests/shared/multicast/rtc-relay-row-retention.test.ts packages/tests/shared/alm/al-outbound-store-lane.test.ts packages/tests/shared/alm/al-inbound-store-lane.test.ts packages/tests/shared/alm/al-inbound-admission-preparation.test.ts packages/tests/shared/multicast/rtc-origin-overlay-fixture.ts packages/tests/shared/multicast/rtc-relay-overlay-fixture.ts`
     (plus the bundle files if 5 raised a ceiling) — Expected: no diff; run `npx dprint fmt` with the same list if
     it reports one.
  7. `node scripts/check-test-structure-coupling.mjs --files packages/tests/shared/alm/al-outbound-store-lane.test.ts packages/tests/shared/alm/al-inbound-store-lane.test.ts packages/tests/shared/alm/al-inbound-admission-preparation.test.ts packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts packages/tests/shared/multicast/rtc-relay-row-retention.test.ts packages/tests/shared/multicast/rtc-origin-overlay-fixture.ts packages/tests/shared/multicast/rtc-relay-overlay-fixture.ts`
     — Expected: no unregistered candidate. The new tests assert on returned values, stored rows and settlements,
     never on mock counts.
  8. `npm run test:repo-governance` (`docs/` changed) — Expected: PASS.

- [ ] **Step 17: Commit, gate the range, push.**

```bash
git add packages/shared/alm/delivery/resolve-al-receipt-retention-expiry-ms.ts \
  packages/shared/alm/outbound/control/compute-al-outbound-receipt-admission.ts \
  packages/shared/alm/outbound/admission/al-outbound-admission-mutations.ts \
  packages/shared/alm/outbound/admission/al-outbound-admission-store.ts \
  packages/shared/alm/outbound/control/al-outbound-control-admission.ts \
  packages/shared/alm/inbound/al-inbound-admission-store.ts \
  packages/shared/alm/inbound/control/al-inbound-control-admission.ts \
  packages/shared/alm/inbound/admission/al-inbound-delivery-mutations.ts \
  packages/shared/alm/inbound/admission/compute-al-inbound-admission.ts \
  packages/shared/alm/al-runtime-stores.ts packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md \
  docs/test-structure-coupling-exceptions.md packages/tests/shared/alm packages/tests/shared/multicast
git commit -m "feat(alm): S3c-ii -- the volatile pair keeps message rows for the deadline plus the receipt grace (D74, D75, C5, C14)"
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
git push origin HEAD:codex/queuebox-persistence-qos-product-plan
```

Add the bundle files to the `git add` if Step 16.5 raised a ceiling. The commit message body names the two bundle
figures of Step 16.5 and the relay row count of Step 14. Expected: `check:repo-style:changed` reports no worsened
finding and the coupling range check reports no unregistered changed occurrence before the push; a finding is
fixed and folded into this task's one commit with `git commit --amend --no-edit` before the push (the branch is
not `main`), never by editing a gate.

#### Corrections found while writing

1. **Survey correction 1 was incomplete; ruled in scope.** Besides the owner and sent rows, four row kinds outlived
   deadline + grace on the volatile pair. Per the coordinator's ruling, three now stop there (Steps 9-10: the outbound
   control-history row, a completed outbound receipt row, the relay's inbound acknowledgement-history row); the
   per-origin version row, and the history row of a relay row with no deadline, keep their TTL for the reasons under
   "Rows that keep their TTL".
2. **The inbound durable rule is not `max(deadline, now + ttl)`.** An admitted inbound owner row is written at
   `now + msgOwnerTtlMs` with no deadline term (`al-inbound-delivery-mutations.ts:20`) and only then extended to its
   owned work; the buffered release uses `max(now + msgOwnerTtlMs, expiry)` (`compute-al-inbound-admission.ts:218`).
   Both durable values are kept exactly (C5 "durable rows keep today's rule").
3. **A late control on the volatile pair now reaches IndexedDB.** Once a volatile message's sent row is gone no lane
   owns it, so `readLaneForMessage` (`al-outbound-message-runtime.ts:552-555`) sends its control to the durable lane,
   which reads the owner row from IndexedDB and refuses it. Before this task the one-hour rows kept such controls in
   memory. Only controls later than deadline + 30 s pay it; no operation-count pin covers them.
4. **A message without a deadline cannot reach an outbound pair** (`al-outbound-canonical-message.ts:94-96`), but can
   reach the inbound volatile pair, where the admission already implies `now + durableEffectTtlMs`
   (`al-inbound-message-admission.ts:99-100`).
5. **`al-inbound-admission-store.ts` (915 lines) and `al-outbound-admission-store.ts` (659) are at size tiers** though
   the frame's list omits them. This task adds to each one exported factory of five lines and field lines only; the
   rule itself lives in the row writers and the new helper file.
6. **The WS server's receipt outbox rows use the same rule** (`max(deadline, observedAt) + grace`,
   `ws-queue-box-server-receipt-aggregation.ts:263-280`) but are not switched to the helper here: touching
   `packages/shared/services/ws-queue-box-server/**` would require the local medium-scale gate for no behaviour
   change.

---

### Task 3: The volatile bound (D74 second half, D78, C3, C4, C6, C13, C17)

One per-session ledger counts the data admissions the session's three memory pairs hold, each released at its own
message deadline on read. The memory pairs carry the ledger (C3: "handed to the three volatile constructors"), so it
reaches the WS client's outbound runtime, the RTC overlay's outbound runtime and both inbound runtimes through the
store objects they already receive; no service, manager or streamer input changes, and
`web-rtc-overlay-multicast-manager.ts` (PR #566) is not touched. The outbound seam is `planAdmission`
(`al-outbound-message-runtime.ts:535-544`): it is the one place that sees a plan's lane before the commit, and only
admissions the owner plans itself pass it (an application send and each member of a group; a relay forward carries
its plan to `enqueueIfAbsent` and a retransmission goes through `retransmitAdmittedMessage`, and neither reaches
it). A refusal rewrites the plan to the drop code `capacity`, which Task 1 maps to `refused/capacity`, so the store
lane, the dispatch and the reducer change nothing.

What `overloaded` does under default QoS (survey correction 6, restated with the inbound half the code shows): the
default congestion policy is `drop-low`, priority 5 for at-least-once and 0 for best-effort
(`normalize-al-qos-policy.ts:306-311`, threshold 0 at `al-policy.ts:336`). While the session is at or over a limit,
the RTC origin planner drops a **best-effort** send as `skipped/planner-drop` (the handle ends `failed`, no fallback),
and both carriers' inbound planners drop a best-effort arrival with a NACK `overloaded` (`al-policy.ts:600-606`,
`ws-queue-box-client-service.ts:299-318`, `web-rtc-overlay-multicast-manager.ts:382-407`). It never drops an
at-least-once message (every typed-channel purpose), and the WS client's outbound `planOutgoingMessage`
(`ws-queue-box-client-service.ts:266-297`) never runs the congestion plan, so a WS send ignores it. The typed
refusal of an over-bound send is the `capacity` admission refusal, not `overloaded`.

**Files:**

- Create: `packages/shared/alm/volatile-budget/al-volatile-session-budget.ts`,
  `packages/shared/alm/volatile-budget/to-al-volatile-session-admission.ts`,
  `packages/shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts`,
  `packages/shared/alm/outbound/lane/admit-al-outbound-volatile-budget.ts`,
  `packages/shared/alm/inbound/lane/admit-al-inbound-volatile-budget.ts`,
  `packages/shared-web/browser/connection/create-browser-session-volatile-bound.ts`.
- Modify: `packages/shared/al-contracts/al-message-resource-limits.ts:76-128` (C17 rename);
  `packages/shared/alm/outbound/al-outbound-message-runtime.ts:1-26`, `:137-140`, `:344-348`, `:536-545` (after
  Task 1's one added line; call lines, one interface field, one doc bullet); `packages/shared/alm/inbound/al-inbound-message-runtime.ts:1-28`, `:35-38`,
  `:124-126`, `:236`; `packages/shared/alm/al-runtime-stores.ts` (one import and the two volatile constructors as Task 2 left them; no
  value export added);
  `packages/shared/multicast/is-rtc-enqueue-breaker-success.ts:3-20`;
  `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts:1-31`, `:126-143`;
  `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts:1-51`, `:94-96`;
  `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts:1-57`, `:74-76`;
  `packages/shared-web/browser/connection/initialise-browser-middleware.ts:1-88`, `:168-175`, `:188-244`,
  `:266-267`, `:334-342`; `packages/shared-web/browser/session/session-connection-lifecycle.ts:14`, `:40-47`,
  `:89-93`, `:194-197`; `packages/shared-web/browser/session/rallar-session-controller.ts:21-27`, `:58-60`;
  `packages/shared-web/browser/composition/browser-session-composition.ts:18`, `:42-47`, `:69-70`;
  `packages/shared-web/browser/composition/create-rallar-facade.ts:163-168`;
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts:339-344`;
  bundle ceilings only if crossed (`packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts:39-60`,
  `packages/shared-web/scripts/measure-browser-bundles.mjs:30-50`,
  `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts:64-83`).
- Test (create): `packages/tests/shared/alm/volatile-budget/al-volatile-session-budget.test.ts`,
  `packages/tests/shared/alm/volatile-budget/to-al-volatile-session-admission.test.ts`,
  `packages/tests/shared/alm/volatile-budget/to-al-volatile-session-qos-provider.test.ts`,
  `packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts`,
  `packages/tests/shared/alm/inbound/al-inbound-volatile-budget.test.ts`,
  `packages/tests/shared/multicast/web-rtc-overlay-volatile-overload.test.ts`,
  `packages/tests/shared-web/connection/create-browser-session-volatile-bound.test.ts`.
- Test (modify): `packages/tests/shared/al-message-resource-limits.test.ts:14-17`, `:277`;
  `packages/tests/shared/multicast/is-rtc-enqueue-breaker-success.test.ts:54-61`;
  `packages/tests/shared/multicast/rtc-origin-overlay-fixture.ts:5`, `:52-59`, `:90` (numbers before Task 2 Step 12);
  `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts:1-10`, `:232-270`, `:282`, `:319`, `:407-416`,
  `:625-670`; `packages/tests/shared/alm/outbound-runtime-test-fixture.ts:280-282`;
  `packages/tests/shared/alm/al-storage-snapshot.test.ts:128-132`; `packages/tests/shared/ws-qos-policy.test.ts:721`;
  `packages/tests/shared/multicast/web-rtc-overlay-missing-recipient-repair.test.ts:265`;
  `packages/tests/shared/alm/al-outbound-store-lane.test.ts:147`; `packages/tests/shared/alm/al-inbound-store-lane.test.ts:229`;
  Task 2's `packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts`,
  `packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts`,
  `packages/tests/shared/multicast/rtc-relay-row-retention.test.ts` and
  `packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts` (one field or argument each);
  `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts:527-540`;
  `packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts:73`, `:151`;
  `packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts:93`, `:137`, `:459`;
  `packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts:66`, `:117`, `:156`, `:209`;
  `packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts:270-275`, `:281`, `:354`;
  `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts:180-185`, `:252-257`;
  `packages/tests/shared-web/rallar-facade-defaults.test.ts:278`;
  `packages/tests/shared-web/composition/browser-facade-behavior.test.ts:191`;
  `packages/tests/shared-web/connection/browser-transport-cleanup.test.ts:62`, `:112`, `:160`, `:210`, `:265`,
  `:340`, `:395`, end of file; `packages/tests/shared-web/messages/browser-message-handle-admission.test.ts` end of file
  (the `messages/` test directory holds 18 files; this task adds none there).

**Interfaces:**

- Consumes (Task 1): `ALDeliveryRefusalReason` and `ALOutboundDropReasonCode` with `'capacity'`;
  `toALOutboundAdmissionVerdict` (`compute-al-outbound-dispatch.ts:249-271`) mapping the drop code `'capacity'` to
  `{ kind: 'refused', reason: 'capacity', detail }`; `ALDeliveryEvidence.failure`, which a refused admission sets to
  `{ kind: 'refused', reason: 'capacity' }`.
- Consumes (Task 2): the two volatile constructors in `al-runtime-stores.ts` as Task 2 Steps 4 and 7 leave them
  (built on `createVolatileALOutboundAdmissionStore` / `createVolatileALInboundAdmissionStore` through
  `toInMemoryALOutboundAdmissionStoreInput` / `toInMemoryALInboundAdmissionStoreInput`); Task 2's four new test files
  that build a volatile pair (Step 7 lists them).
- Consumes (existing): `resolveALMessageExpireAtMs(msg: ALMessage, effective?: ALQosEffectivePolicy): number | undefined`
  (`al-policy.ts:418-444`); `isALControlTypeId(typeId: string): boolean` (`al-control-type-ids.ts:7-12`);
  `ALQosInputProvider` (`al-policy.ts:181-198`); `toALCarrierQosInputProvider` (`al-carrier-capabilities.ts:31-44`),
  which keeps wrapping the session provider on both carriers.
- Produces, as the interface ledger names them: `AL_VOLATILE_SESSION_MAX_ADMISSIONS`, `AL_VOLATILE_SESSION_MAX_BYTES`,
  `ALVolatileSessionLimits`, `ALVolatileSessionUsage`, `ALVolatileSessionBudget` (`tryAdmit`, `record`, `readUsage`,
  `isOverloaded`), `ALVolatileSessionBudget.Admission`, and the browser seam
  `readVolatileSessionLimits: (() => ALVolatileSessionLimits) | undefined` on `MiddlewareInitOptions`,
  `BrowserSessionConnectionLifecycle.Input`, `CreateRallarSessionControllerOptions` and
  `CreateBrowserSessionCoreCompositionInput` (the four input contracts of the survey's B6 chain).
- Produces, names this task adds to the ledger:
  - `constructor(limits: ALVolatileSessionLimits)` on `ALVolatileSessionBudget`, and
    `ALVolatileSessionBudget.Refusal { readonly limit: 'admissions' | 'bytes'; readonly usage: ALVolatileSessionUsage; readonly limits: ALVolatileSessionLimits; }`;
  - `export function computeALMessageEnvelopeBytes(value: unknown, byteLimits: ALMessageByteLimits = AL_MESSAGE_RESOURCE_LIMITS): Either<ALMessageResourceIssue, number>` (C17);
  - `export function toALVolatileSessionAdmission(msg: ALMessage, nowMs: number): ALVolatileSessionBudget.Admission | undefined`;
  - `export function toALVolatileSessionQosProvider(provider: ALQosInputProvider | undefined, budget: ALVolatileSessionBudget, nowMs: () => number): ALQosInputProvider`;
  - `export function admitALOutboundVolatileBudget<TPrepared>(input: AdmitALOutboundVolatileBudgetInput<TPrepared>): ALOutboundDispatchPlan<TPrepared>`;
  - `export function admitALInboundVolatileBudget(input: AdmitALInboundVolatileBudgetInput): ALVolatileSessionUsage | undefined`;
  - `ALVolatileOutboundRuntimeStores<TPrepared>.budget` and `ALVolatileInboundRuntimeStores.budget`, both
    `ALVolatileSessionBudget | undefined` (`undefined`: an unbounded pair, as a test or a runtime outside a session);
  - `createVolatileALOutboundRuntimeStores(options, budget: ALVolatileSessionBudget | undefined)`,
    `createVolatileALInboundRuntimeStores(options: CreateDefaultALRuntimeStoresInput, budget: ALVolatileSessionBudget | undefined)`
    (the inbound `options` loses its `= {}` default; every caller passes it),
    `createBrowserALVolatileOutboundRuntimeStores(name: string, budget: ALVolatileSessionBudget | undefined)`,
    `createBrowserALVolatileInboundRuntimeStores(name: string, budget: ALVolatileSessionBudget | undefined)`;
  - `CreateBrowserWebSocketQueueBox.Input.volatileBudget` and `InitialiseRtcOverlayMulticastManagerInput.volatileBudget`,
    both `ALVolatileSessionBudget | undefined`;
  - `export function createBrowserSessionVolatileBound(input: CreateBrowserSessionVolatileBoundInput): BrowserSessionVolatileBound`
    with `BrowserSessionVolatileBound { readonly budget: ALVolatileSessionBudget; readonly qosProvider: ALQosInputProvider; }`.
- Task 6 passes its reader as `readVolatileSessionLimits` to `createBrowserSessionCoreComposition` in
  `browser-rallar-runtime-composition.ts:339`, where this task leaves `readVolatileSessionLimits: undefined`.
- No persisted shape changes (C16): the ledger lives in memory only; `AL_ADMISSION_SCHEMA_ID` stays.

- [ ] **Step 1: RED -- the envelope byte count is exported (C17).** In
      `packages/tests/shared/al-message-resource-limits.test.ts` extend the import at `:14-17` to

```ts
import {
    computeALMessageEnvelopeBytes,
    validateALMessageResourceLimits,
    validateSerializedALMessageSize
} from '@shared/al-contracts/al-message-resource-limits.ts';
```

and add, as the last `it` of the `describe` (after "does not mutate caller-owned values ...", `:277`):

```ts
it('counts the envelope bytes the validator walks, in UTF-8 as the wire carries them (C17)', () => {
    const message: ALMessage = {
        ...messageFixture(),
        payload: {
            typeId: 'message.v1',
            contentType: 'application/json',
            resource: '{"text":"blåbær"}'
        }
    };
    const oversized: ALMessage = {
        ...message,
        payload: { ...message.payload, resource: JSON.stringify({ text: 'x'.repeat(130 * 1024) }) }
    };

    expect(computeALMessageEnvelopeBytes(message).right)
        .toBe(new TextEncoder().encode(JSON.stringify(message)).length);
    expect(computeALMessageEnvelopeBytes(oversized).left?.code).toBe('oversized');
});
```

Run: `npx vitest run packages/tests/shared/al-message-resource-limits.test.ts`
Expected: FAIL -- `computeALMessageEnvelopeBytes is not a function` (the counter is module-private today).

- [ ] **Step 2: GREEN -- rename and export the walk.** In `packages/shared/al-contracts/al-message-resource-limits.ts`
      replace `:85` (`const measured = computeALMessageEnvelopeSize(value, byteLimits);`) with
      `const measured = computeALMessageEnvelopeBytes(value, byteLimits);`, and replace the head of the private
      function at `:93-96` with the exported one (the body `:97-128` is unchanged):

```ts
/**
 * The envelope's JSON bytes in UTF-8, walked without invoking getters or `toJSON`; past a limit, the issue.
 * A value it cannot inspect as plain data (a revoked proxy) throws, which `validateALMessageResourceLimits`
 * states as `malformed`; a caller measuring an envelope a decoder already accepted never meets it.
 */
export function computeALMessageEnvelopeBytes(
    value: unknown,
    byteLimits: ALMessageByteLimits = AL_MESSAGE_RESOURCE_LIMITS
): Either<ALMessageResourceIssue, number> {
```

`validateALMessageResourceLimits` (`:77-91`) was the only caller; no alias is left.

Run: `npx vitest run packages/tests/shared/al-message-resource-limits.test.ts`
Expected: PASS, every existing case included.

- [ ] **Step 3: RED -- the budget ledger.** Create `packages/tests/shared/alm/volatile-budget/al-volatile-session-budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

const NOW_MS = 1_700_000_000_000;

interface AdmissionOverrides {
    readonly bytes?: number;
    readonly deadlineAtMs?: number;
    readonly nowMs?: number;
}

function toAdmission(
    msgId: string,
    overrides: AdmissionOverrides = {}
): ALVolatileSessionBudget.Admission {
    return {
        msgId,
        bytes: overrides.bytes ?? 100,
        deadlineAtMs: overrides.deadlineAtMs ?? NOW_MS + 30_000,
        nowMs: overrides.nowMs ?? NOW_MS
    };
}

describe('the per-session volatile budget (D74)', () => {
    it('holds D74\'s two limits', () => {
        expect(AL_VOLATILE_SESSION_MAX_ADMISSIONS).toBe(1_000);
        expect(AL_VOLATILE_SESSION_MAX_BYTES).toBe(4 * 1024 * 1024);
    });

    it('counts outbound and inbound admissions and their bytes together', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 10, maxBytes: 1_000 });

        expect(budget.tryAdmit(toAdmission('sent', { bytes: 100 })).right).toEqual({
            admissions: 1,
            bytes: 100
        });
        expect(budget.record(toAdmission('received', { bytes: 250 }))).toEqual({
            admissions: 2,
            bytes: 350
        });
        expect(budget.readUsage(NOW_MS)).toEqual({ admissions: 2, bytes: 350 });
    });

    it('refuses the admission past the count limit, names that limit and counts nothing for it', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 2, maxBytes: 1_000 });
        budget.tryAdmit(toAdmission('first'));
        budget.tryAdmit(toAdmission('second'));

        expect(budget.tryAdmit(toAdmission('third')).left).toEqual({
            limit: 'admissions',
            usage: { admissions: 2, bytes: 200 },
            limits: { maxAdmissions: 2, maxBytes: 1_000 }
        });
        expect(budget.readUsage(NOW_MS)).toEqual({ admissions: 2, bytes: 200 });
    });

    it('refuses an admission whose bytes would pass the byte limit and admits one that meets it', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 10, maxBytes: 300 });

        expect(budget.tryAdmit(toAdmission('first', { bytes: 200 })).right).toEqual({
            admissions: 1,
            bytes: 200
        });
        expect(budget.tryAdmit(toAdmission('too-large', { bytes: 101 })).left?.limit).toBe('bytes');
        expect(budget.tryAdmit(toAdmission('fits', { bytes: 100 })).right).toEqual({
            admissions: 2,
            bytes: 300
        });
    });

    it('counts one msgId once, however many carriers admit it', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 1, maxBytes: 1_000 });

        expect(budget.tryAdmit(toAdmission('fallback')).right).toEqual({
            admissions: 1,
            bytes: 100
        });
        // The WS leg of an rtc-with-ws-fallback send re-admits the RTC envelope while the bound is full.
        expect(budget.tryAdmit(toAdmission('fallback')).right).toEqual({
            admissions: 1,
            bytes: 100
        });
        expect(budget.record(toAdmission('fallback'))).toEqual({ admissions: 1, bytes: 100 });
    });

    it('releases each admission at its own deadline, read without a timer', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 2, maxBytes: 1_000 });
        budget.tryAdmit(toAdmission('short', { deadlineAtMs: NOW_MS + 1_000 }));
        budget.tryAdmit(toAdmission('long', { deadlineAtMs: NOW_MS + 5_000 }));

        expect(budget.tryAdmit(toAdmission('early', { nowMs: NOW_MS + 999 })).left?.limit).toBe(
            'admissions'
        );
        expect(budget.readUsage(NOW_MS + 1_000)).toEqual({ admissions: 1, bytes: 100 });
        expect(
            budget.tryAdmit(
                toAdmission('after-short', { nowMs: NOW_MS + 1_000, deadlineAtMs: NOW_MS + 9_000 })
            ).right
        ).toEqual({ admissions: 2, bytes: 200 });
        expect(budget.readUsage(NOW_MS + 5_000)).toEqual({ admissions: 1, bytes: 100 });
        expect(budget.readUsage(NOW_MS + 9_000)).toEqual({ admissions: 0, bytes: 0 });
    });

    it('holds nothing for an admission whose deadline already passed', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 1, maxBytes: 1_000 });

        expect(budget.tryAdmit(toAdmission('late', { deadlineAtMs: NOW_MS })).right).toEqual({
            admissions: 0,
            bytes: 0
        });
        expect(budget.tryAdmit(toAdmission('current')).right).toEqual({
            admissions: 1,
            bytes: 100
        });
    });

    it('never refuses a recorded inbound admission, which still counts toward the next outbound refusal (C6)', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 1, maxBytes: 1_000 });
        budget.record(toAdmission('received-1'));

        expect(budget.record(toAdmission('received-2'))).toEqual({ admissions: 2, bytes: 200 });
        expect(budget.tryAdmit(toAdmission('sent')).left?.limit).toBe('admissions');
    });

    it('is overloaded at or over either limit and clear below both (C13)', () => {
        const byCount = new ALVolatileSessionBudget({ maxAdmissions: 2, maxBytes: 1_000 });
        byCount.record(toAdmission('first'));
        expect(byCount.isOverloaded(NOW_MS)).toBe(false);
        byCount.record(toAdmission('second'));
        expect(byCount.isOverloaded(NOW_MS)).toBe(true);
        expect(byCount.isOverloaded(NOW_MS + 30_000)).toBe(false);

        const byBytes = new ALVolatileSessionBudget({ maxAdmissions: 10, maxBytes: 250 });
        byBytes.record(toAdmission('large', { bytes: 250 }));
        expect(byBytes.isOverloaded(NOW_MS)).toBe(true);
    });
});
```

Create `packages/tests/shared/alm/volatile-budget/to-al-volatile-session-admission.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { computeALMessageEnvelopeBytes } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toALVolatileSessionAdmission } from '@shared/alm/volatile-budget/to-al-volatile-session-admission.ts';

const NOW_MS = 1_700_000_000_000;

describe('a message as the session budget counts it', () => {
    it('counts the envelope walk\'s bytes until the message deadline', () => {
        const msg = newALUnicastMessage(
            'self',
            { topicId: 'chat', resourceId: 'counted', contextId: 'room' },
            'peer',
            'chat.message.v1',
            { text: 'counted' },
            { ttlMs: 30_000 }
        );

        expect(toALVolatileSessionAdmission(msg, NOW_MS)).toEqual({
            msgId: msg.id.msgId,
            bytes: computeALMessageEnvelopeBytes(msg).right,
            deadlineAtMs: msg.constraints?.expiresAtMs,
            nowMs: NOW_MS
        });
    });

    it('counts no message without a deadline, as the RTC signaling transport sends every signal', () => {
        const signal = newALUnicastMessage(
            'self',
            { topicId: 'rtc-signaling', resourceId: 'offer', contextId: 'peer' },
            'peer',
            'rtc-signaling',
            { kind: 'offer' }
        );

        expect(toALVolatileSessionAdmission(signal, NOW_MS)).toBeUndefined();
    });
});
```

Run: `npx vitest run packages/tests/shared/alm/volatile-budget`
Expected: FAIL -- the modules `al-volatile-session-budget.ts` and `to-al-volatile-session-admission.ts` do not exist.

- [ ] **Step 4: GREEN -- the ledger and the message view.** Create
      `packages/shared/alm/volatile-budget/al-volatile-session-budget.ts`:

```ts
import { Either } from '../../resilience/Either.ts';

/** The data admissions one session's memory pairs hold at once (D74). */
export const AL_VOLATILE_SESSION_MAX_ADMISSIONS = 1_000;
/** The envelope bytes one session's memory pairs hold at once (D74). */
export const AL_VOLATILE_SESSION_MAX_BYTES = 4 * 1024 * 1024;

export interface ALVolatileSessionLimits {
    readonly maxAdmissions: number;
    readonly maxBytes: number;
}

export interface ALVolatileSessionUsage {
    readonly admissions: number;
    readonly bytes: number;
}

interface ALVolatileSessionEntry {
    readonly bytes: number;
    readonly deadlineAtMs: number;
}

export namespace ALVolatileSessionBudget {
    /** One data message, counted from its admission until its own deadline. */
    export interface Admission {
        readonly msgId: string;
        readonly bytes: number;
        readonly deadlineAtMs: number;
        readonly nowMs: number;
    }

    /** The limit a new admission would pass, and the usage it met. */
    export interface Refusal {
        readonly limit: 'admissions' | 'bytes';
        readonly usage: ALVolatileSessionUsage;
        readonly limits: ALVolatileSessionLimits;
    }
}

/**
 * One session's count of the data admissions its memory pairs hold (D74): the WS client's and the RTC overlay's
 * outbound pairs and the session's inbound pair share it. Each admission is released at its own deadline, computed
 * on read, so the budget schedules nothing; a msgId counts once however many carriers admit it.
 */
export class ALVolatileSessionBudget {
    private readonly limits: ALVolatileSessionLimits;
    private readonly entries = new Map<string, ALVolatileSessionEntry>();
    private bytes = 0;
    private nextReleaseAtMs = Number.POSITIVE_INFINITY;

    constructor(limits: ALVolatileSessionLimits) {
        this.limits = limits;
    }

    /** An outbound admission: refused when it would pass either limit (D78). */
    tryAdmit(
        input: ALVolatileSessionBudget.Admission
    ): Either<ALVolatileSessionBudget.Refusal, ALVolatileSessionUsage> {
        const usage = this.readUsage(input.nowMs);
        if (this.entries.has(input.msgId)) {
            return Either.ofRight(usage);
        }
        const limit = resolveALVolatileSessionPassedLimit(usage, input.bytes, this.limits);
        return limit === undefined
            ? Either.ofRight(this.record(input))
            : Either.ofLeft({ limit, usage, limits: this.limits });
    }

    /** An inbound admission: counted, never refused (C6). */
    record(input: ALVolatileSessionBudget.Admission): ALVolatileSessionUsage {
        this.releaseDue(input.nowMs);
        if (!this.entries.has(input.msgId) && input.deadlineAtMs > input.nowMs) {
            this.entries.set(input.msgId, { bytes: input.bytes, deadlineAtMs: input.deadlineAtMs });
            this.bytes += input.bytes;
            this.nextReleaseAtMs = Math.min(this.nextReleaseAtMs, input.deadlineAtMs);
        }
        return this.toUsage();
    }

    readUsage(nowMs: number): ALVolatileSessionUsage {
        this.releaseDue(nowMs);
        return this.toUsage();
    }

    /** At or over either limit: what the session's QoS provider states as `overloaded` (C13). */
    isOverloaded(nowMs: number): boolean {
        const usage = this.readUsage(nowMs);
        return usage.admissions >= this.limits.maxAdmissions || usage.bytes >= this.limits.maxBytes;
    }

    private releaseDue(nowMs: number): void {
        if (nowMs < this.nextReleaseAtMs) {
            return;
        }
        let nextReleaseAtMs = Number.POSITIVE_INFINITY;
        for (const [msgId, entry] of this.entries) {
            if (entry.deadlineAtMs <= nowMs) {
                this.entries.delete(msgId);
                this.bytes -= entry.bytes;
            }
            else {
                nextReleaseAtMs = Math.min(nextReleaseAtMs, entry.deadlineAtMs);
            }
        }
        this.nextReleaseAtMs = nextReleaseAtMs;
    }

    private toUsage(): ALVolatileSessionUsage {
        return { admissions: this.entries.size, bytes: this.bytes };
    }
}

function resolveALVolatileSessionPassedLimit(
    usage: ALVolatileSessionUsage,
    bytes: number,
    limits: ALVolatileSessionLimits
): ALVolatileSessionBudget.Refusal['limit'] | undefined {
    if (usage.admissions + 1 > limits.maxAdmissions) {
        return 'admissions';
    }
    return usage.bytes + bytes > limits.maxBytes ? 'bytes' : undefined;
}
```

Create `packages/shared/alm/volatile-budget/to-al-volatile-session-admission.ts`:

```ts
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    computeALMessageEnvelopeBytes
} from '../../al-contracts/al-message-resource-limits.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import type { ALVolatileSessionBudget } from './al-volatile-session-budget.ts';

/**
 * The budget's view of one data message, or `undefined` for a message with no deadline: the budget releases an
 * admission at its deadline, and RTC signaling (`WsRtcSignalingTransportUsingWsQBox.send`) is the volatile data a
 * session sends and receives without one, which the bound must never refuse.
 */
export function toALVolatileSessionAdmission(
    msg: ALMessage,
    nowMs: number
): ALVolatileSessionBudget.Admission | undefined {
    const deadlineAtMs = resolveALMessageExpireAtMs(msg);
    if (deadlineAtMs === undefined) {
        return undefined;
    }
    return {
        msgId: msg.id.msgId,
        bytes: computeALMessageEnvelopeBytes(msg).right ?? AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
        deadlineAtMs,
        nowMs
    };
}
```

Run: `npx vitest run packages/tests/shared/alm/volatile-budget`
Expected: PASS (both files).

- [ ] **Step 5: RED -- the session QoS provider (C13).** Create
      `packages/tests/shared/alm/volatile-budget/to-al-volatile-session-qos-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALQosInputProvider, ALQosMessageContext } from '@shared/al-contracts/al-policy.ts';
import { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';

const NOW_MS = 1_700_000_000_000;
const CONTEXT: ALQosMessageContext = { direction: 'outbound' };
const MESSAGE = newALUnicastMessage(
    'self',
    { topicId: 'chat', resourceId: 'planned', contextId: 'room' },
    'peer',
    'chat.message.v1',
    { text: 'planned' },
    { ttlMs: 30_000 }
);
const APPLICATION: ALQosInputProvider = {
    defaultsForMessage: () => ({ durability: { algo: 'local-outbox', opts: {} } }),
    capabilitiesForMessage: () => ({ supportedAck: ['none'] }),
    authorizationForMessage: () => ({ maxDurability: 'volatile' }),
    liveForMessage: () => ({ connectedNeighborCount: 3 })
};

function createFullBudget(): ALVolatileSessionBudget {
    const budget = new ALVolatileSessionBudget({ maxAdmissions: 1, maxBytes: 1_000 });
    budget.record({ msgId: 'received', bytes: 10, deadlineAtMs: NOW_MS + 1_000, nowMs: NOW_MS });
    return budget;
}

describe('the session QoS provider over the volatile budget (D78, C13)', () => {
    it('answers the application\'s live fields while the session is under its bound', () => {
        const budget = new ALVolatileSessionBudget({ maxAdmissions: 1, maxBytes: 1_000 });
        const provider = toALVolatileSessionQosProvider(APPLICATION, budget, () => NOW_MS);

        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toEqual({ connectedNeighborCount: 3 });
    });

    it('adds overloaded at the bound and keeps the application\'s other live fields', () => {
        const provider = toALVolatileSessionQosProvider(
            APPLICATION,
            createFullBudget(),
            () => NOW_MS
        );

        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toEqual({
            connectedNeighborCount: 3,
            overloaded: true
        });
    });

    it('states overloaded with no application provider, and nothing below the bound', () => {
        const budget = createFullBudget();
        let nowMs = NOW_MS;
        const provider = toALVolatileSessionQosProvider(undefined, budget, () => nowMs);

        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toEqual({ overloaded: true });
        nowMs = NOW_MS + 1_000;
        expect(provider.liveForMessage?.(MESSAGE, CONTEXT)).toBeUndefined();
    });

    it('passes the application\'s defaults, capabilities and authorization through unchanged', () => {
        const provider = toALVolatileSessionQosProvider(
            APPLICATION,
            createFullBudget(),
            () => NOW_MS
        );

        expect(provider.defaultsForMessage?.(MESSAGE, CONTEXT)).toEqual({
            durability: { algo: 'local-outbox', opts: {} }
        });
        expect(provider.capabilitiesForMessage?.(MESSAGE, CONTEXT)).toEqual({
            supportedAck: ['none']
        });
        expect(provider.authorizationForMessage?.(MESSAGE, CONTEXT)).toEqual({
            maxDurability: 'volatile'
        });
    });
});
```

Run: `npx vitest run packages/tests/shared/alm/volatile-budget/to-al-volatile-session-qos-provider.test.ts`
Expected: FAIL -- the module does not exist.

- [ ] **Step 6: GREEN -- the provider.** Create `packages/shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts`:

```ts
import type { ALQosInputProvider } from '../../al-contracts/al-policy.ts';
import type { ALVolatileSessionBudget } from './al-volatile-session-budget.ts';

/**
 * The application's provider with `overloaded` set while the session's volatile budget is at or over a limit
 * (D78, C13); every other answer is the application's own. Under default QoS only best-effort traffic reads it.
 */
export function toALVolatileSessionQosProvider(
    provider: ALQosInputProvider | undefined,
    budget: ALVolatileSessionBudget,
    nowMs: () => number
): ALQosInputProvider {
    return {
        defaultsForMessage: (msg, context) => provider?.defaultsForMessage?.(msg, context),
        capabilitiesForMessage: (msg, context) => provider?.capabilitiesForMessage?.(msg, context),
        authorizationForMessage: (msg, context) =>
            provider?.authorizationForMessage?.(msg, context),
        liveForMessage: (msg, context) => {
            const live = provider?.liveForMessage?.(msg, context);
            return budget.isOverloaded(nowMs()) ? { ...live, overloaded: true } : live;
        }
    };
}
```

Run: `npx vitest run packages/tests/shared/alm/volatile-budget`
Expected: PASS (three files).

- [ ] **Step 7: The memory pairs carry the budget.** No behaviour yet: the field exists and every constructor names it.
      In `packages/shared/alm/outbound/al-outbound-message-runtime.ts` add to the imports (`:1-26`)
      `import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';` and replace the
      doc comment and declaration of `ALVolatileOutboundRuntimeStores` (`:137-140` once Task 1's drop-code line is in)
      with:

```ts
/** The memory pair of a carrier runtime: nothing in it survives the document, and its lane sweeps it. */
export interface ALVolatileOutboundRuntimeStores<TPrepared>
    extends ALOutboundRuntimeStores<TPrepared> {
    evictExpired(): void;
    /** The session's bound over what this pair holds; `undefined` leaves the pair unbounded (C3). */
    readonly budget: ALVolatileSessionBudget | undefined;
}
```

In `packages/shared/alm/inbound/al-inbound-message-runtime.ts` add
`import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';` and replace
`:35-38` with:

```ts
/** The session's inbound memory pair: nothing in it survives the document, and each lane over it sweeps it. */
export interface ALVolatileInboundRuntimeStores extends ALInboundRuntimeStores {
    evictExpired(): void;
    /** The session's bound over what this pair holds; `undefined` leaves the pair unbounded (C3). */
    readonly budget: ALVolatileSessionBudget | undefined;
}
```

In `packages/shared/alm/al-runtime-stores.ts` add
`import type { ALVolatileSessionBudget } from './volatile-budget/al-volatile-session-budget.ts';` after the
`./outbound/al-outbound-message-runtime.ts` import, and replace the two functions
`createVolatileALOutboundRuntimeStores` and `createVolatileALInboundRuntimeStores`, as Task 2 Steps 4 and 7 left
them, with (this step adds only the parameter and the returned field; Task 2's bodies stay):

```ts
/** The memory pair a browser carrier routes volatile admissions to; it persists nothing. */
export function createVolatileALOutboundRuntimeStores<TPrepared>(
    options: CreateDefaultALOutboundRuntimeStoresInput<TPrepared>,
    budget: ALVolatileSessionBudget | undefined
): ALVolatileOutboundRuntimeStores<TPrepared> {
    const input = { ...toDefaultInMemoryInput(options), decodePrepared: options.decodePrepared };
    const backend = createVolatileALAdmissionBackend(input.nowMs);
    return {
        admissionStore: createVolatileALOutboundAdmissionStore(
            toInMemoryALOutboundAdmissionStoreInput(input, backend)
        ),
        workQueue: backend.workQueue,
        evictExpired: () => backend.evictExpired(),
        budget
    };
}

/** The session's inbound memory pair, shared by both carriers' volatile lanes; it persists nothing. */
export function createVolatileALInboundRuntimeStores(
    options: CreateDefaultALRuntimeStoresInput,
    budget: ALVolatileSessionBudget | undefined
): ALVolatileInboundRuntimeStores {
    const input = toDefaultInMemoryInput(options);
    const backend = createVolatileALAdmissionBackend(input.nowMs);
    return {
        admissionStore: createVolatileALInboundAdmissionStore(
            toInMemoryALInboundAdmissionStoreInput(input, backend)
        ),
        workQueue: backend.workQueue,
        evictExpired: () => backend.evictExpired(),
        budget
    };
}
```

In `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts` add
`import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';` after the
`@shared/alm/outbound/al-outbound-transport-message.ts` import (`:28-31`), and replace `:126-143` with:

```ts
/** Always memory, whatever the browser supports: the pair a carrier routes volatile admissions to. */
export function createBrowserALVolatileOutboundRuntimeStores(
    name: string,
    budget: ALVolatileSessionBudget | undefined
): ALVolatileOutboundRuntimeStores<ALOutboundTransportMessage> {
    return createVolatileALOutboundRuntimeStores(
        { namespace: `browser:${name}:volatile`, decodePrepared: decodeALOutboundTransportMessage },
        budget
    );
}

/**
 * Always memory: the session's inbound pair for volatile messages, created once per middleware and
 * shared by both carriers (D20). Session cleanup and a storage reset never reach it; it dies with the
 * middleware.
 */
export function createBrowserALVolatileInboundRuntimeStores(
    name: string,
    budget: ALVolatileSessionBudget | undefined
): ALVolatileInboundRuntimeStores {
    return createVolatileALInboundRuntimeStores({ namespace: `browser:${name}:volatile` }, budget);
}
```

In `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts` add
`import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';` after the
`@shared/alm/outbound/al-outbound-message-runtime.ts` import (`:14`), add to `CreateBrowserWebSocketQueueBox.Input`
after `readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;` (`:44`):

```ts
/** The session's one volatile budget, which this client's outbound memory pair counts against (C3). */
readonly volatileBudget: ALVolatileSessionBudget | undefined;
```

and replace `:94-96` with:

```ts
outboundVolatileStores: createBrowserALVolatileOutboundRuntimeStores(
    toBrowserWsClientALRuntimeStoreId(clientData.sessionId),
    input.volatileBudget
),
```

In `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts` add the same type import after the
`@shared/alm/outbound/al-outbound-transport-message.ts` import (`:18`), add to
`InitialiseRtcOverlayMulticastManagerInput` after `readonly qosProvider: ALQosInputProvider | undefined;` (`:52`):

```ts
/** The session's one volatile budget, which the overlay's outbound memory pair counts against (C3). */
readonly volatileBudget: ALVolatileSessionBudget | undefined;
```

and replace `:74-76` (the `volatileStores` property of the object passed to
`createDefaultALOutboundRuntimeResources({ ... })`) with:

```text
volatileStores: createBrowserALVolatileOutboundRuntimeStores(
    toBrowserRtcOverlayALRuntimeStoreId(webRtcConnectionService.input.sessionId),
    input.volatileBudget
)
```

In `packages/shared-web/browser/connection/initialise-browser-middleware.ts` replace `:200-202` with
`const inboundVolatileStores = createBrowserALVolatileInboundRuntimeStores(toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId), undefined);`,
add `volatileBudget: undefined,` after `qosProvider: input.options.qosProvider,` at `:267` and at `:337` (Step 15
replaces these three `undefined`s with the session's budget, so this step compiles alone).

Update the callers that are tests, each by adding the budget argument or field, nothing else:

- `createVolatileALOutboundRuntimeStores({ ... })` gains a second argument `undefined` in
  `packages/tests/shared/ws-qos-policy.test.ts:721`, `packages/tests/shared/alm/al-storage-snapshot.test.ts:129`,
  `packages/tests/shared/multicast/web-rtc-overlay-missing-recipient-repair.test.ts:265`,
  `packages/tests/shared/alm/outbound-runtime-test-fixture.ts:281` and
  `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts:238-240`, `:282`, `:319` (Step 19 gives `:238`
  a budget);
- `createVolatileALInboundRuntimeStores({ namespace: ... })` gains `, undefined` in
  `packages/tests/shared/alm/al-storage-snapshot.test.ts:132` and `al-indexeddb-operation-counts.test.ts:639`;
- the two hand-built pairs gain `budget: undefined` after `evictExpired` in
  `packages/tests/shared/alm/al-outbound-store-lane.test.ts:147` and `packages/tests/shared/alm/al-inbound-store-lane.test.ts:229`;
- the three hand-built pairs Task 2 created gain `budget: undefined` after their `evictExpired` property: the
  `stores` literal of `createObservedOutboundPair` in `packages/tests/shared/alm/outbound/al-outbound-volatile-retention.test.ts`,
  the `volatileStores` literal of `createReadyObservedPairs` in `packages/tests/shared/alm/inbound/al-inbound-volatile-retention.test.ts`
  and the `stores` literal of `createObservedVolatileInboundPair` in `packages/tests/shared/multicast/rtc-relay-row-retention.test.ts`;
  and the `createVolatileALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage })` call of
  `packages/tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts` gains the second argument `undefined`;
- `createBrowserALVolatileOutboundRuntimeStores('browser-ws-client:session-1')` gains `, undefined` at
  `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts:528-529`, and
  `createBrowserALVolatileInboundRuntimeStores(toBrowserSessionALInboundRuntimeStoreId(...))` gains `, undefined` inside
  its closing parenthesis at `browser-al-runtime-stores.test.ts:539`, `ws-retained-work-fault.test.ts:73`, `:151`,
  `ws-durable-owner-recovery.test.ts:93`, `:137`, `:459`, `create-browser-web-socket-queue-box.test.ts:66`, `:117`,
  `:156`, `:209` and `acknowledgement-under-hold-fixture.ts:281`, `:354`;
- every `createBrowserWebSocketQueueBox({ ... })` call among those (all but `browser-al-runtime-stores.test.ts:539`
  and `acknowledgement-under-hold-fixture.ts:281`) gains the line `volatileBudget: undefined,` directly below its
  `inboundVolatileStores:` line, at the same indentation;
- `initialiseRtcOverlayMulticastManager({ ... })` gains `volatileBudget: undefined,` below its `qosProvider:` line at
  `acknowledgement-under-hold-fixture.ts:271` and `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts:181`, `:253`.

Run: `npm run typecheck` and `npm run typecheck:tests`
Expected: both clean (the budget is carried and read by nothing yet).
Run: `npx vitest run packages/tests/shared/alm packages/tests/shared/multicast packages/tests/shared-web/al-runtime packages/tests/shared-web/websocket packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts packages/tests/shared-web/messages`
Expected: PASS, unchanged counts.

- [ ] **Step 8: RED -- the outbound admission refuses over the bound (C4, D78).** Create
      `packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const DURABLE_TYPE_ID = 'chat.durable.v1';

/** Volatile unless the message's type says durable, with one prepared send: what every browser planner states. */
function planByTypeId(msg: ALMessage): ALOutboundDispatchPlan<OutboundTestPayload> {
    return {
        msg,
        dropReasonCode: undefined,
        persist: msg.payload.typeId === DURABLE_TYPE_ID,
        preparedMessages: [{ kind: 'send' }]
    };
}

function createBudgetedRuntime(budget: ALVolatileSessionBudget, carrier: ALDeliveryCarrier = 'ws') {
    return createDefaultOutboundTestRuntime({
        carrier,
        volatileStores: createVolatileALOutboundRuntimeStores({
            decodePrepared: decodeOutboundTestPayload
        }, budget),
        planOutgoingMessage: planByTypeId,
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
    });
}

function createDefaultBudget(): ALVolatileSessionBudget {
    return new ALVolatileSessionBudget({
        maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
}

/** One volatile admission short of a full bound, so this session's next data admission is its 1 000th. */
function recordReceivedUntilOneShort(budget: ALVolatileSessionBudget): void {
    const nowMs = Date.now();
    for (let index = 0; index < AL_VOLATILE_SESSION_MAX_ADMISSIONS - 1; index += 1) {
        budget.record({
            msgId: `received-${index}`,
            bytes: 1,
            deadlineAtMs: nowMs + 60_000,
            nowMs
        });
    }
}

/** A budget of one, filled by one volatile data admission of the runtime under test. */
async function createFullRuntime() {
    const budget = new ALVolatileSessionBudget({
        maxAdmissions: 1,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
    const runtime = createBudgetedRuntime(budget);
    expect((await runtime.enqueueIfAbsent(createOutboundMessage('fills-the-bound'))).verdict.kind)
        .toBe('admitted');
    return { budget, runtime };
}

describe('the session volatile bound at the outbound admission (D74, D78)', () => {
    it('refuses the 1 001st volatile data admission with the drop code capacity', async () => {
        const budget = createDefaultBudget();
        recordReceivedUntilOneShort(budget);
        const runtime = createBudgetedRuntime(budget);

        const thousandth = await runtime.enqueueIfAbsent(createOutboundMessage('volatile-1000'));
        const refused = await runtime.enqueueIfAbsent(createOutboundMessage('volatile-1001'));

        expect(thousandth.verdict).toMatchObject({ kind: 'admitted', durable: false });
        expect(refused.verdict).toMatchObject({ kind: 'refused', reason: 'capacity' });
        expect(refused.reason).toContain('volatile bound');
        expect(refused.entries).toEqual([]);
        expect(budget.readUsage(Date.now()).admissions).toBe(AL_VOLATILE_SESSION_MAX_ADMISSIONS);
    });

    it('counts each member of a group this session sends, in order', async () => {
        const budget = new ALVolatileSessionBudget({
            maxAdmissions: 2,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        });
        const runtime = createBudgetedRuntime(budget);

        const results = await runtime.enqueueAllIfAbsent([
            createOutboundMessage('group-1'),
            createOutboundMessage('group-2'),
            createOutboundMessage('group-3')
        ]);

        expect(results.map(({ verdict }) => verdict.kind)).toEqual([
            'admitted',
            'admitted',
            'refused'
        ]);
        expect(results[2]?.verdict).toMatchObject({ kind: 'refused', reason: 'capacity' });
    });

    it('counts a msgId once when a second carrier re-admits it, as the WS leg of a fallback does', async () => {
        const budget = new ALVolatileSessionBudget({
            maxAdmissions: 1,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        });
        const rtc = createBudgetedRuntime(budget, 'rtc');
        const ws = createBudgetedRuntime(budget, 'ws');
        const message = createOutboundMessage('handed-over');

        expect((await rtc.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');
        expect((await ws.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('never counts an ACK batch, even one that carries a deadline', async () => {
        const { budget, runtime } = await createFullRuntime();
        const ack = newALAckControlMessage(
            { v: 2, msgId: 'ack-at-the-bound', senderId: 'self', ts: Date.now() },
            {
                ackedMsgId: 'received-message',
                fromPeerId: 'self',
                toPeerId: 'peer-1',
                originPeerId: 'peer-1',
                logicalRecipientPeerId: 'self',
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: Date.now()
            }
        );
        // A deadline, so only the control rule can exempt it.
        const [acked] = await runtime.enqueueAllIfAbsent([{
            ...ack,
            constraints: { expiresAtMs: Date.now() + 30_000 }
        }]);

        expect(acked?.verdict.kind).toBe('admitted');
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('never counts a relay forward, whose admission carries its plan', async () => {
        const { budget, runtime } = await createFullRuntime();
        const forward = createOutboundMessage('relayed');

        expect((await runtime.enqueueIfAbsent(forward, planByTypeId(forward))).verdict)
            .toMatchObject({ kind: 'admitted', durable: false });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('never counts a durable send', async () => {
        const { budget, runtime } = await createFullRuntime();
        const durable = newALUnicastMessage(
            'self',
            { topicId: 'chat', resourceId: 'durable', contextId: 'conversation-1' },
            'peer-1',
            DURABLE_TYPE_ID,
            { text: 'durable' },
            { ttlMs: 30_000 }
        );

        expect((await runtime.enqueueIfAbsent(durable)).verdict).toMatchObject({
            kind: 'admitted',
            durable: true
        });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('never counts a volatile message without a deadline, as an RTC signal is sent', async () => {
        const { budget, runtime } = await createFullRuntime();
        const signal = newALUnicastMessage(
            'self',
            { topicId: 'rtc-signaling', resourceId: 'offer', contextId: 'peer-1' },
            'peer-1',
            'rtc-signaling',
            { kind: 'offer' }
        );

        expect((await runtime.enqueueIfAbsent(signal)).verdict).toMatchObject({
            kind: 'admitted',
            durable: false
        });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });
});
```

Run: `npx vitest run packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts`
Expected: FAIL -- nothing counts yet: the 1 001st send is admitted, the group admits all three, and every usage
reads 0 (the four exemption cases fail only on their usage line, since `createFullRuntime`'s send is not counted).

- [ ] **Step 9: GREEN -- the outbound seam.** Create `packages/shared/alm/outbound/lane/admit-al-outbound-volatile-budget.ts`:

```ts
import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { isALControlTypeId } from '../../../al-contracts/al-control-type-ids.ts';
import type { ALVolatileSessionBudget } from '../../volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionAdmission } from '../../volatile-budget/to-al-volatile-session-admission.ts';
import type { ALOutboundDispatchPlan } from '../al-outbound-message-runtime.ts';

export interface AdmitALOutboundVolatileBudgetInput<TPrepared> {
    /** A message this owner plans itself: a relay forward or a retransmission never reaches here. */
    readonly msg: ALMessage;
    /** The plan of an admission the volatile lane takes. */
    readonly plan: ALOutboundDispatchPlan<TPrepared>;
    readonly budget: ALVolatileSessionBudget | undefined;
    readonly nowMs: number;
}

/**
 * The plan a volatile data admission this session originates commits under the session's bound (D74). A control,
 * a plan that already drops, and a message with no deadline are not counted; one past the bound is dropped with the
 * code `capacity`, which ends its handle `rejected` and is never a fallback trigger (D78, C1).
 */
export function admitALOutboundVolatileBudget<TPrepared>(
    input: AdmitALOutboundVolatileBudgetInput<TPrepared>
): ALOutboundDispatchPlan<TPrepared> {
    const { msg, plan, budget } = input;
    if (
        budget === undefined || plan.dropReason !== undefined ||
        plan.dropReasonCode !== undefined ||
        isALControlTypeId(msg.payload.typeId)
    ) {
        return plan;
    }
    const admission = toALVolatileSessionAdmission(msg, input.nowMs);
    const admitted = admission === undefined ? undefined : budget.tryAdmit(admission);
    return admitted?.left === undefined ? plan : toCapacityRefusedPlan(plan, admitted.left);
}

function toCapacityRefusedPlan<TPrepared>(
    plan: ALOutboundDispatchPlan<TPrepared>,
    refusal: ALVolatileSessionBudget.Refusal
): ALOutboundDispatchPlan<TPrepared> {
    const { usage, limits } = refusal;
    return {
        ...plan,
        dropReason:
            `The session's volatile bound is full (${refusal.limit}): ${usage.admissions} of ` +
            `${limits.maxAdmissions} admissions, ${usage.bytes} of ${limits.maxBytes} bytes.`,
        dropReasonCode: 'capacity',
        preparedMessages: []
    };
}
```

In `packages/shared/alm/outbound/al-outbound-message-runtime.ts` add
`import { admitALOutboundVolatileBudget } from './lane/admit-al-outbound-volatile-budget.ts';` before the
`./lane/al-outbound-send-controls.ts` import (`:25`), add this bullet to the class comment after the first bullet
(after `:343`, "The lane over the memory pair states no admission durable."):

```ts
* - An admission the owner plans itself that resolves to the volatile lane counts against the session's
*   bound, which the memory pair carries; past it, the plan drops with the code `capacity` (D74, D78).
```

and replace `planAdmission` (`:535-544`) with:

```ts
private planAdmission(msg: ALMessage): ALOutboundPlannedAdmission<TPrepared> {
    const planOutgoingMessage = this.dependencies.planOutgoingMessage;
    let plan: ALOutboundDispatchPlan<TPrepared>;
    try {
        plan = planOutgoingMessage(msg);
    }
    catch {
        return { lane: this.durable, planner: planOutgoingMessage };
    }
    const lane = this.resolveLaneForPlan(plan);
    const bounded = lane === this.volatile
        ? admitALOutboundVolatileBudget({
            msg,
            plan,
            budget: this.dependencies.volatileStores?.budget,
            nowMs: this.dependencies.clock.nowMs()
        })
        : plan;
    return { lane, planner: toPlannedOnce(msg, bounded, planOutgoingMessage) };
}
```

The existing doc comment above `planAdmission` (`:531-534`) stays: a throwing planner still goes to the durable lane,
and the bound is taken outside the `try`, so a bound decision never sends a message there. The admission read calls
the planner with the same `msg` and no admitted audience for a new message
(`al-outbound-admission-reads.ts:355`), so `toPlannedOnce` hands it the bounded plan, and `toEarlyDispatchResult`
(`compute-al-outbound-dispatch.ts:201-203`) states Task 1's `refused/capacity` verdict without a write.

Run: `npx vitest run packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts packages/tests/shared/alm`
Expected: PASS -- the new file, and every existing outbound case (a runtime without a budget plans as before).

- [ ] **Step 10: RED, then GREEN -- a capacity refusal is not a transport failure of the RTC breaker.** In
      `packages/tests/shared/multicast/is-rtc-enqueue-breaker-success.test.ts` add to the `it.each` table after the
      `unsupported` row (`:57`):

```ts
{ verdict: { kind: 'refused', reason: 'capacity', detail: 'bound' }, success: true },
```

Run: `npx vitest run packages/tests/shared/multicast/is-rtc-enqueue-breaker-success.test.ts`
Expected: FAIL -- the `capacity` row reads `success=false`, so repeated capacity refusals would open the breaker and
turn later RTC admissions into `unroutable/circuit-open`, which IS a fallback trigger
(`resolve-al-delivery-fallback-trigger.ts:15-19`).

In `packages/shared/multicast/is-rtc-enqueue-breaker-success.ts` replace `:3-20` with:

```ts
/**
 * Whether an RTC enqueue counts as a success for its circuit breaker. A typed refusal is a policy value
 * (an unauthorized origin, an ack the carrier cannot track, the session's volatile bound), not a transport
 * failure, so it never opens the breaker; a failure, another refusal, and the protection results themselves do.
 */
export function isRtcEnqueueBreakerSuccess(result: ALOutboundEnqueueResult): boolean {
    const verdict = result.verdict;
    switch (verdict.kind) {
        case 'failed':
            return false;
        case 'refused':
            return verdict.reason === 'unauthorized' || verdict.reason === 'unsupported' ||
                verdict.reason === 'capacity';
        case 'unroutable':
            return verdict.reason !== 'rate-limited' && verdict.reason !== 'circuit-open';
        default:
            return true;
    }
}
```

Run: `npx vitest run packages/tests/shared/multicast/is-rtc-enqueue-breaker-success.test.ts`
Expected: PASS.

- [ ] **Step 11: RED -- the inbound admission records and never refuses (C6).** Create
      `packages/tests/shared/alm/inbound/al-inbound-volatile-budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createVolatileALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE
} from '../inbound-runtime-test-fixture.ts';

function createBudgetedInboundRuntime(limits: ALVolatileSessionLimits) {
    const budget = new ALVolatileSessionBudget(limits);
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: 'inbound-budget',
            storage: 'memory',
            observer: createCountingIndexedDbOperationObserver()
        }),
        volatileStores: createVolatileALInboundRuntimeStores({
            namespace: 'inbound-budget-volatile'
        }, budget),
        effectWorkerId: 'al-inbound:budget'
    });
    return { budget, runtime: fixture.runtime };
}

describe('the session volatile bound at the inbound admission (D74, C6)', () => {
    it('records a volatile data admission with its envelope bytes', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({
            maxAdmissions: 10,
            maxBytes: 1_000_000
        });

        const admitted = await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'received-1' }),
            INBOUND_TEST_SOURCE
        );

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
        expect(budget.readUsage(Date.now()).bytes).toBeGreaterThan(0);
    });

    it('admits past the bound, counting each arrival toward overloaded', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({
            maxAdmissions: 1,
            maxBytes: 1_000_000
        });

        const first = await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'received-1' }),
            INBOUND_TEST_SOURCE
        );
        const second = await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'received-2' }),
            INBOUND_TEST_SOURCE
        );

        expect(first.right).toEqual({ kind: 'admitted' });
        expect(second.right).toEqual({ kind: 'admitted' });
        expect(budget.readUsage(Date.now()).admissions).toBe(2);
        expect(budget.isOverloaded(Date.now())).toBe(true);
    });

    it('counts a copy of one message once', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({
            maxAdmissions: 10,
            maxBytes: 1_000_000
        });
        const message = createInboundTestMessage({ msgId: 'received-twice' });

        await runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE);
        const copy = await runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE);

        expect(copy.right).toEqual({ kind: 'duplicate' });
        expect(budget.readUsage(Date.now()).admissions).toBe(1);
    });

    it('does not count a local-inbox message, which the durable lane admits', async () => {
        const { budget, runtime } = createBudgetedInboundRuntime({
            maxAdmissions: 10,
            maxBytes: 1_000_000
        });

        const admitted = await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'durable', durability: 'local-inbox' }),
            INBOUND_TEST_SOURCE
        );

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(budget.readUsage(Date.now()).admissions).toBe(0);
    });
});
```

Run: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-volatile-budget.test.ts`
Expected: FAIL -- the first three cases read zero admissions; the local-inbox case passes.

- [ ] **Step 12: GREEN -- the inbound seam.** Create `packages/shared/alm/inbound/lane/admit-al-inbound-volatile-budget.ts`:

```ts
import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type {
    ALVolatileSessionBudget,
    ALVolatileSessionUsage
} from '../../volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionAdmission } from '../../volatile-budget/to-al-volatile-session-admission.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';

export interface AdmitALInboundVolatileBudgetInput {
    readonly msg: ALMessage;
    /** What the memory lane answered; `undefined` for an arrival it rejected. */
    readonly acceptance: ALInboundMessageRuntime.Acceptance | undefined;
    readonly budget: ALVolatileSessionBudget | undefined;
    readonly nowMs: number;
}

/**
 * Counts a data message the session's memory lane admitted against the session's bound (D74). An inbound
 * admission is never refused for capacity (C6): it raises the usage the session's own sends and `overloaded`
 * read. A duplicate, a rejection and a message with no deadline count nothing.
 */
export function admitALInboundVolatileBudget(
    input: AdmitALInboundVolatileBudgetInput
): ALVolatileSessionUsage | undefined {
    const kind = input.acceptance?.kind;
    if (input.budget === undefined || (kind !== 'admitted' && kind !== 'pending-admission')) {
        return undefined;
    }
    const admission = toALVolatileSessionAdmission(input.msg, input.nowMs);
    return admission === undefined ? undefined : input.budget.record(admission);
}
```

In `packages/shared/alm/inbound/al-inbound-message-runtime.ts` add
`import { admitALInboundVolatileBudget } from './lane/admit-al-inbound-volatile-budget.ts';` before the
`./lane/al-inbound-store-lane.ts` import (`:19`), add to the class comment after the first bullet (after `:126`):

```ts
* - A data message the volatile lane admits counts against the session's bound, which the memory pair
*   carries; an inbound admission is never refused for it (D74, C6).
```

and replace `:236` (`return await this.resolveDataLane(msg).admitData(msg, source, planIncomingMessage);`) with:

```ts
const lane = this.resolveDataLane(msg);
const admitted = await lane.admitData(msg, source, planIncomingMessage);
if (lane === this.volatile) {
    admitALInboundVolatileBudget({
        msg,
        acceptance: admitted.right,
        budget: this.dependencies.volatileStores?.budget,
        nowMs: this.dependencies.clock.nowMs()
    });
}
return admitted;
```

Run: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-volatile-budget.test.ts packages/tests/shared/alm`
Expected: PASS.

- [ ] **Step 13: The `overloaded` signal at the RTC origin (C13).** In
      `packages/tests/shared/multicast/rtc-origin-overlay-fixture.ts` import
      `import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';` after the
      `@shared/al-contracts/al-control.ts` import (`:5`), add to `RtcOriginOverlayFixtureInput` after `volatileStores`
      (`:58`):

```ts
/** The session's provider the composition hands the manager; absent, the carrier's capabilities alone. */
readonly qosProvider?: ALQosInputProvider;
```

and replace the line `qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, undefined),` (`:90` on
main, `:97` after Task 2 Step 12 and the two insertions above) with
`qosProvider: toALCarrierQosInputProvider(AL_RTC_OVERLAY_CAPABILITIES, input.qosProvider),`.
Create `packages/tests/shared/multicast/web-rtc-overlay-volatile-overload.test.ts`:

```ts
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

/** The origin `a` whose session budget of one is full exactly when `atTheBound`. */
function createBoundOriginFixture(atTheBound: boolean): RtcOriginOverlayFixture {
    const budget = new ALVolatileSessionBudget({
        maxAdmissions: 1,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
    if (atTheBound) {
        budget.record({
            msgId: 'received',
            bytes: 1,
            deadlineAtMs: Date.now() + 60_000,
            nowMs: Date.now()
        });
    }
    return createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c'], 4),
        nextHopPeerIds: ['b', 'c'],
        qosProvider: toALVolatileSessionQosProvider(undefined, budget, Date.now)
    });
}

function createBestEffortMulticast(resourceId: string): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        { text: resourceId },
        { reliability: 'best-effort', ack: 'none', ttlMs: 30_000 }
    );
}

describe('the session volatile bound as the RTC origin\'s overloaded signal (D78, C13)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('admits a best-effort send while the session is under its bound', async () => {
        const fixture = createBoundOriginFixture(false);

        expect(
            (await enqueueAndDrain(fixture.manager, createBestEffortMulticast('under'))).verdict
                .kind
        ).toBe('admitted');
    });

    it('drops a best-effort send in the planner while the session is at its bound', async () => {
        const fixture = createBoundOriginFixture(true);

        expect((await enqueueAndDrain(fixture.manager, createBestEffortMulticast('over'))).verdict)
            .toMatchObject({ kind: 'skipped', reason: 'planner-drop' });
    });

    it('still admits an at-least-once send at the bound: default congestion drops only low priority', async () => {
        const fixture = createBoundOriginFixture(true);

        expect(
            (await enqueueAndDrain(fixture.manager, createOriginReceiverMulticast('at-least-once')))
                .verdict.kind
        )
            .toBe('admitted');
    });
});
```

Run: `npx vitest run packages/tests/shared/multicast`
Expected: PASS at once -- this pins the composition of the new provider with the existing congestion rule
(`al-policy.ts:499-507`, `web-rtc-overlay-multicast-manager.ts:900-918`), which the wiring in Step 15 relies on;
if the second case reads `admitted`, the provider is not reaching `planALMessageHandling` and Step 6 is wrong.

- [ ] **Step 14: RED -- one budget per session, read once (C3).** Create
      `packages/tests/shared-web/connection/create-browser-session-volatile-bound.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createBrowserSessionVolatileBound } from '@shared-web/browser/connection/create-browser-session-volatile-bound.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    type ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

const NOW_MS = 1_700_000_000_000;
const MESSAGE = newALUnicastMessage(
    'self',
    { topicId: 'chat', resourceId: 'planned', contextId: 'room' },
    'peer',
    'chat.message.v1',
    { text: 'planned' },
    { ttlMs: 30_000 }
);

function toAdmission(msgId: string, bytes = 1): ALVolatileSessionBudget.Admission {
    return { msgId, bytes, deadlineAtMs: NOW_MS + 30_000, nowMs: NOW_MS };
}

describe('the session volatile bound the middleware builds (C3, C13)', () => {
    it('bounds a session by D74\'s two constants when the composition gives no reader', () => {
        const bound = createBrowserSessionVolatileBound({
            readVolatileSessionLimits: undefined,
            qosProvider: undefined,
            nowMs: () => NOW_MS
        });

        expect(
            bound.budget.tryAdmit(toAdmission('too-large', AL_VOLATILE_SESSION_MAX_BYTES + 1)).left
                ?.limit
        )
            .toBe('bytes');
        for (let index = 0; index < AL_VOLATILE_SESSION_MAX_ADMISSIONS; index += 1) {
            expect(bound.budget.tryAdmit(toAdmission(`sent-${index}`)).left).toBeUndefined();
        }
        expect(bound.budget.tryAdmit(toAdmission('one-too-many')).left?.limit).toBe('admissions');
    });

    it('bounds the session by the limits its reader answered first', () => {
        const answers = [{ maxAdmissions: 2, maxBytes: 4_096 }];
        const bound = createBrowserSessionVolatileBound({
            readVolatileSessionLimits: () =>
                answers.shift() ?? { maxAdmissions: 1_000, maxBytes: 4_096 },
            qosProvider: undefined,
            nowMs: () => NOW_MS
        });

        bound.budget.tryAdmit(toAdmission('first'));
        bound.budget.tryAdmit(toAdmission('second'));

        // A second read would answer 1 000 admissions and admit the third.
        expect(bound.budget.tryAdmit(toAdmission('third')).left?.limit).toBe('admissions');
    });

    it('hands the carriers a provider over the same budget that keeps the application\'s answers', () => {
        const bound = createBrowserSessionVolatileBound({
            readVolatileSessionLimits: () => ({ maxAdmissions: 1, maxBytes: 4_096 }),
            qosProvider: { liveForMessage: () => ({ hasAlternateRoute: true }) },
            nowMs: () => NOW_MS
        });

        expect(bound.qosProvider.liveForMessage?.(MESSAGE, { direction: 'inbound' }))
            .toEqual({ hasAlternateRoute: true });
        bound.budget.record(toAdmission('received'));
        expect(bound.qosProvider.liveForMessage?.(MESSAGE, { direction: 'inbound' }))
            .toEqual({ hasAlternateRoute: true, overloaded: true });
    });
});
```

In `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts` add to the imports
`import { AL_VOLATILE_SESSION_MAX_ADMISSIONS, AL_VOLATILE_SESSION_MAX_BYTES, ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';`
and, after the case "gives every carrier a fresh, empty memory pair ..." (`:527-534`), add:

```ts
it('carries the one session budget it is handed on every memory pair (C3)', () => {
    const budget = new ALVolatileSessionBudget({
        maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
    const outbound = createBrowserALVolatileOutboundRuntimeStores(
        'browser-ws-client:session-budget',
        budget
    );
    const overlay = createBrowserALVolatileOutboundRuntimeStores(
        'browser-rtc-overlay:session-budget',
        budget
    );
    const inbound = createBrowserALVolatileInboundRuntimeStores(
        toBrowserSessionALInboundRuntimeStoreId('session-budget'),
        budget
    );

    expect(outbound.budget).toBe(budget);
    expect(overlay.budget).toBe(budget);
    expect(inbound.budget).toBe(budget);
});
```

Run: `npx vitest run packages/tests/shared-web/connection/create-browser-session-volatile-bound.test.ts packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts`
Expected: FAIL -- the bound module does not exist; the new store case already passes (Step 7).

- [ ] **Step 15: GREEN -- the bound and the middleware's per-session construction.** Create
      `packages/shared-web/browser/connection/create-browser-session-volatile-bound.ts`:

```ts
import type { ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionQosProvider } from '@shared/alm/volatile-budget/to-al-volatile-session-qos-provider.ts';

/** What one session's transports share: the budget its three memory pairs count against, and its QoS provider. */
export interface BrowserSessionVolatileBound {
    readonly budget: ALVolatileSessionBudget;
    /** The application's provider with the budget's `overloaded` (C13); both carriers plan with it. */
    readonly qosProvider: ALQosInputProvider;
}

export interface CreateBrowserSessionVolatileBoundInput {
    /** The composition's limit reader, read once here; `undefined` keeps D74's two constants. */
    readonly readVolatileSessionLimits: (() => ALVolatileSessionLimits) | undefined;
    /** The application's provider the session's provider wraps. */
    readonly qosProvider: ALQosInputProvider | undefined;
    readonly nowMs: () => number;
}

export function createBrowserSessionVolatileBound(
    input: CreateBrowserSessionVolatileBoundInput
): BrowserSessionVolatileBound {
    const budget = new ALVolatileSessionBudget(
        input.readVolatileSessionLimits?.() ?? {
            maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        }
    );
    return {
        budget,
        qosProvider: toALVolatileSessionQosProvider(input.qosProvider, budget, input.nowMs)
    };
}
```

In `packages/shared-web/browser/connection/initialise-browser-middleware.ts`:

- add `import type { ALVolatileSessionLimits } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';`
  after the `@shared/alm/inbound/al-inbound-message-runtime.ts` import (`:3-6`), and
  `import { createBrowserSessionVolatileBound, type BrowserSessionVolatileBound } from '@shared-web/browser/connection/create-browser-session-volatile-bound.ts';`
  before the `connection-http-api.ts` import (`:44`);
- add to `MiddlewareInitOptions` after `readonly qosProvider: ALQosInputProvider | undefined;` (`:77`):

```ts
/** The session's volatile limits, read once per initialisation; `undefined` keeps D74's two constants. */
readonly readVolatileSessionLimits: (() => ALVolatileSessionLimits) | undefined;
```

- add to `InitialiseBrowserTransportInput` after `readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;` (`:173`):

```ts
/** The session's one volatile budget and its QoS provider, handed to both carriers (C3, C13). */
readonly volatileBound: BrowserSessionVolatileBound;
```

- replace `initialiseMiddleware` (`:188-244`, 57 lines today) with the function below and a new
  `createBrowserTransportInput`, which also brings `initialiseMiddleware` under the 40-line rule:

```ts
export async function initialiseMiddleware(
    session: AuthSession,
    rtcSignalingTopicId: string,
    options: MiddlewareInitOptions
): Promise<RallarBrowserMiddleware> {
    const transportInput = createBrowserTransportInput(session, options);
    const webSocketTransport = await initialiseBrowserWebSocketTransport(transportInput);
    const rtcTransport = await initialiseBrowserRtcTransport({
        ...transportInput,
        rtcSignalingTopicId,
        webSocketTransport
    });
    const bootstrapDegree = resolveBootstrapDegree({
        bootstrapDegree: options.bootstrapDegree,
        maxPeerConnections: options.maxPeerConnections
    });
    await initialiseBrowserStateTransport({
        ...transportInput,
        webSocketQueueBox: webSocketTransport.webSocketQueueBox,
        webRtcGroupManager: rtcTransport.webRtcGroupManager,
        bootstrapDegree
    });
    const heartbeatHandle = await heartbeat.initHeartbeat(transportInput.clientData, {
        authSession: session,
        scope: options.scope,
        onAuthInvalid: options.onAuthInvalid
            ? (caught) => options.onAuthInvalid?.(toError(caught))
            : undefined
    });

    return {
        ...webSocketTransport,
        ...rtcTransport,
        heartbeat: heartbeatHandle
    };
}

/** One session's stores, its one volatile bound over the three memory pairs (C3) and its creation ports. */
function createBrowserTransportInput(
    session: AuthSession,
    options: MiddlewareInitOptions
): InitialiseBrowserTransportInput {
    const clientData: ClientInfo = {
        clientId: session.clientId,
        sessionId: session.sessionId,
        isOnline: true
    };
    initialiseBrowserRuntimeStores(clientData.sessionId, options.diagnosticsPorts);
    const volatileBound = createBrowserSessionVolatileBound({
        readVolatileSessionLimits: options.readVolatileSessionLimits,
        qosProvider: options.qosProvider,
        nowMs: Date.now
    });
    return {
        session,
        clientData,
        inboundStores: resolveBrowserSessionALInboundRuntimeStores(clientData.sessionId),
        inboundVolatileStores: createBrowserALVolatileInboundRuntimeStores(
            toBrowserSessionALInboundRuntimeStoreId(clientData.sessionId),
            volatileBound.budget
        ),
        volatileBound,
        options,
        creation: {
            createMessage: newALUntargetedMessage,
            newConnectionRequestId: crypto.randomUUID.bind(crypto)
        }
    };
}
```

The order is today's: runtime stores configured, then the inbound IndexedDB pair resolved, then the memory pair.

- in `initialiseBrowserWebSocketTransport` replace `qosProvider: input.options.qosProvider,` and the
  `volatileBudget: undefined,` line Step 7 added (`:267-268`) with:

```ts
qosProvider: input.volatileBound.qosProvider,
volatileBudget: input.volatileBound.budget,
```

- in `initialiseBrowserRtcTransport` replace the same two lines in the `initialiseRtcOverlayMulticastManager` input
  (`:337-338`) with:

```ts
qosProvider: input.volatileBound.qosProvider,
volatileBudget: input.volatileBound.budget,
```

The application's `qosProvider` now reaches the carriers only through the session provider, which
`toALCarrierQosInputProvider` wraps exactly as it wrapped the application's (`create-browser-web-socket-queue-box.ts:84`
into `ws-queue-box-client-service.ts:659`; `initialise-browser-rtc-runtime.ts:81`); below the bound every answer is
the application's own.

Run: `npx vitest run packages/tests/shared-web/connection/create-browser-session-volatile-bound.test.ts packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts`
Expected: PASS. (`npm run typecheck` reports `session-connection-lifecycle.ts` missing `readVolatileSessionLimits`
until Step 17.)

- [ ] **Step 16: RED -- the reader flows from the composition to the middleware.** In
      `packages/tests/shared-web/connection/browser-transport-cleanup.test.ts`, after the closing `});` of
      `describe('Browser transport cleanup', ...)` (`:436`), add:

```ts
describe('the session volatile limits seam', () => {
    it('hands the composition\'s limit reader to the session\'s middleware initialisation', async () => {
        const middleware = createDefaultApiMiddlewareTestDouble();
        mocks.readSession.mockReturnValue(middleware.session);
        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
        const transportRuntime = new BrowserTransportRuntime();
        onTestFinished(() => transportRuntime.shutdown());
        const readVolatileSessionLimits = () => ({ maxAdmissions: 3, maxBytes: 4_096 });
        const connection = new BrowserSessionConnectionLifecycle({
            qosProvider: undefined,
            readVolatileSessionLimits,
            sessionDeliveries: createDeliveryObservation(transportRuntime).sessionDeliveries,
            connectionRuntime: new BrowserFacadeRuntimeState(transportRuntime),
            transportRuntime,
            lifecycle: createRallarLifecycleCoordinator(),
            clearCurrentRoom: () => {}
        });

        await connection.connect(toConnectionInput(middleware.session));

        expect(mocks.initialiseMiddleware.mock.calls.at(-1)?.[2].readVolatileSessionLimits)
            .toBe(readVolatileSessionLimits);
    });
});
```

Run: `npx vitest run packages/tests/shared-web/connection/browser-transport-cleanup.test.ts`
Expected: FAIL -- the lifecycle builds its middleware options without the reader (`undefined`).

- [ ] **Step 17: GREEN -- the four input contracts of the chain.**
- `packages/shared-web/browser/session/session-connection-lifecycle.ts`: add
  `import type { ALVolatileSessionLimits } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';` after
  the `al-policy.ts` import (`:14`); in `BrowserSessionConnectionLifecycle.Input` after `qosProvider` (`:41`) add

```ts
/** The composition's reader of the session's volatile limits; `undefined` keeps D74's constants. */
readonly readVolatileSessionLimits: (() => ALVolatileSessionLimits) | undefined;
```

in `connect` add `readVolatileSessionLimits: this.input.readVolatileSessionLimits,` after
`qosProvider: this.input.qosProvider,` (`:91`); and make the return type of `toMiddlewareOptions` (`:196`)
`Omit<MiddlewareInitOptions, 'deliverySettlements' | 'qosProvider' | 'readVolatileSessionLimits'>`.

- `packages/shared-web/browser/session/rallar-session-controller.ts`: same import after `al-policy.ts` (`:21`); in
  `CreateRallarSessionControllerOptions` after `qosProvider` (`:26`) add
  `readonly readVolatileSessionLimits: (() => ALVolatileSessionLimits) | undefined;`; in the
  `BrowserSessionConnectionLifecycle` input (`:59`) add `readVolatileSessionLimits: options.readVolatileSessionLimits,`.
- `packages/shared-web/browser/composition/browser-session-composition.ts`: same import after `al-policy.ts`
  (`:18`); in `CreateBrowserSessionCoreCompositionInput` after `qosProvider` (`:43`) add

```ts
/** Read once per session; the product passes `undefined`, the black-box lane a lowered bound (C11). */
readonly readVolatileSessionLimits: (() => ALVolatileSessionLimits) | undefined;
```

and in `createRallarSessionController({ ... })` (`:70`) add `readVolatileSessionLimits: input.readVolatileSessionLimits,`.

- `packages/shared-web/browser/composition/create-rallar-facade.ts:167`: after `qosProvider: undefined` add
  `readVolatileSessionLimits: undefined` (with the comma on the line before).
- `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts:340`:
  after `qosProvider: { defaultsForMessage: computeAlmConformanceQosDefaults },` add
  `readVolatileSessionLimits: undefined,` (Task 6 replaces it with the lane's reader).
- Tests pinning the whole options object or constructing the lifecycle: add `readVolatileSessionLimits: undefined,`
  after `qosProvider: undefined,` at `packages/tests/shared-web/rallar-facade-defaults.test.ts:278`,
  `packages/tests/shared-web/composition/browser-facade-behavior.test.ts:191`, and
  `packages/tests/shared-web/connection/browser-transport-cleanup.test.ts:62`, `:112`, `:160`, `:210`, `:265`,
  `:340`, `:395`.

Run: `npx vitest run packages/tests/shared-web/connection packages/tests/shared-web/rallar-facade-defaults.test.ts packages/tests/shared-web/composition packages/tests/shared-web/session`
Expected: PASS.
Run: `npm run typecheck` and `npm run typecheck:tests`
Expected: both clean.

- [ ] **Step 18: The handle of an over-bound send (D78, C1).** In
      `packages/tests/shared-web/messages/browser-message-handle-admission.test.ts`, after the closing `});` of
      `describe('message handle admission', ...)` (the file's end), add:

```ts
describe('a send the session volatile bound refuses (D78)', () => {
    function toCapacityRefusal(message: ALMessage): ALOutboundEnqueueResult {
        const detail =
            'The session\'s volatile bound is full (admissions): 1000 of 1000 admissions.';
        return {
            verdict: { kind: 'refused', reason: 'capacity', detail },
            message,
            entries: [],
            reason: detail,
            trackedReceiptAlgo: 'none'
        };
    }

    it('ends a WS send rejected with the typed capacity failure', async () => {
        const fixture = createBrowserMessageSenderFixture();
        fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent = async (message) =>
            toCapacityRefusal(message);

        const handle = await fixture.sender.sendWs(
            { typeId: 'room.ready', payload: true },
            undefined
        );

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'capacity' } }
        });
    });

    it('never hands an RTC capacity refusal to WS under rtc-with-ws-fallback', async () => {
        const fixture = createBrowserMessageSenderFixture();
        fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent = async (message) =>
            toCapacityRefusal(message);

        const handle = await fixture.sender.sendTyped(
            { typeId: 'room.ready', payload: true, strategy: 'rtc-with-ws-fallback' },
            undefined
        );
        const { lifecycle } = await handle.wait();

        expect(lifecycle).toMatchObject({
            state: 'rejected',
            evidence: {
                failure: { kind: 'refused', reason: 'capacity' },
                carrierFallback: undefined
            }
        });
        // A hand-over would have left the refused RTC leg as an attempt row before a WS leg.
        expect(lifecycle.evidence.attempts).toEqual([]);
    });
});
```

Run: `npx vitest run packages/tests/shared-web/messages/browser-message-handle-admission.test.ts`
Expected: PASS at once -- the carrier doubles state the verdict Step 9 makes the runtime state, and the path from it
to the handle is Task 1's (`capacity` outside `AL_DELIVERY_FALLBACK_REFUSAL_REASONS`, so
`toCarrierAdmissionSettlement`, `browser-rallar-message-dispatch.ts:223-228`, states an `admission` settlement and
never a hand-over). A FAIL here means Task 1's reducer or C1 moved; stop and report rather than adjust this test.

- [ ] **Step 19: The storage pins: a bounded volatile path still spends zero IndexedDB operations (D87).** In
      `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` add to the imports (`:1-10`)
      `import { AL_VOLATILE_SESSION_MAX_ADMISSIONS, AL_VOLATILE_SESSION_MAX_BYTES, ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';`
      and a module helper beside `computeNonProbeWorkOperations`:

```ts
/** The production bound over one session's memory pairs (D74). */
function createDefaultSessionBudget(): ALVolatileSessionBudget {
    return new ALVolatileSessionBudget({
        maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
        maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
    });
}
```

In "sends one volatile message beside a durable pair in 0 al-admission and 0 non-probe al-work operations"
(`:233-270`) add `const budget = createDefaultSessionBudget();` as the test's first line, pass it as the second
argument of `createVolatileALOutboundRuntimeStores` (`:238-240`, where Step 7 put `undefined`), and before
`runtime.dispose();` add:

```ts
// S3c-ii (D74): the session budget counts the send in memory and moves no IndexedDB counter.
expect(budget.readUsage(Date.now()).admissions, 'the bounded send is counted once').toBe(1);
```

In `AdmittedInboundDelivery` (`:625-632`) add, after `nonProbeWorkOperations`:

```ts
/** What the session budget over the memory pair counted: zero when no memory pair admitted it. */
readonly budgetAdmissions: number;
```

in `readAdmittedInboundDelivery` (`:634-670`) add `const budget = createDefaultSessionBudget();` before
`const volatileStores`, pass `budget` in place of Step 7's `undefined` at `:639`, and return
`budgetAdmissions: budget.readUsage(Date.now()).admissions` beside `nonProbeWorkOperations`. In "admits and delivers
one volatile message beside a durable pair in 0 admission and 0 non-probe work operations" (`:407-416`) add after its
last `expect`:

```ts
expect(admitted.budgetAdmissions, 'the bounded arrival is counted in memory').toBe(1);
```

Run: `npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
Expected: PASS with every pin unchanged: 10 / 15 for the durable send, 0 `al-admission` and 0 non-probe `al-work`
for the bounded volatile send and the bounded volatile arrival, 8 for the local-inbox arrival. The pins may only
fall; none moves here.

- [ ] **Step 20: Validate.** In order, reading each summary line rather than the exit code:
  - `npx vitest run packages/tests/shared/al-message-resource-limits.test.ts packages/tests/shared/alm/volatile-budget packages/tests/shared/alm/outbound/al-outbound-volatile-budget.test.ts packages/tests/shared/alm/inbound/al-inbound-volatile-budget.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/multicast packages/tests/shared-web/connection packages/tests/shared-web/al-runtime packages/tests/shared-web/messages packages/tests/shared-web/websocket packages/tests/shared-web/rtc`, then `npm run test:unit`;
  - `npm run typecheck` and `npm run typecheck:tests`;
  - `npm run check:repo-style:changed -- origin/main HEAD` (expected: no worsened finding; `initialiseMiddleware`
    falls from 57 lines to under 40);
  - `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` (commit a registry fix first if it
    names a new candidate);
  - `npx dprint check` on exactly the files this task created or modified (the Files list above), and
    `npx dprint fmt` on those files only if it reports any;
  - `packages/shared` and `packages/shared-test` changed: `cd apps/api-v1 && deno task check`,
    `cd apps/rallar-black-box-control-server && deno task check`, `cd apps/relic-hunter-server-v1 && deno task check`,
    then `npm run test:deno`;
  - the browser gates: `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
    and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`. No public export name moves (every new
    name lives in a module no entry point re-exports). Record both bundle figures; the budget, the two admissions
    and the provider reach both bundles, and the headroom is under 0.2 KiB, so a crossed ceiling is raised to the next
    whole KiB in `shared-web-browser-bundle-boundaries.test.ts:39-60`, `measure-browser-bundles.mjs:30-50` and
    `headless-bundle-boundary.test.ts:64-83`, appending to each comment "The S3c-ii volatile bound (the session budget,
    its outbound refusal and inbound count, and the overloaded provider) measures <the measured figure> KiB. The next
    whole-KiB ceiling is <N>.";
  - the smoke lane, unsandboxed and alone on ports 18080/5180, no edits while it runs:
    `RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm` (expected: the summary line shows
    every smoke scenario passed; the default bound is far above any smoke workload, and RTC signaling carries no
    deadline, so connection setup never meets it).

- [ ] **Step 21: Commit and push.**

```bash
git add packages/shared/al-contracts/al-message-resource-limits.ts packages/shared/alm/volatile-budget packages/shared/alm/outbound/al-outbound-message-runtime.ts packages/shared/alm/outbound/lane/admit-al-outbound-volatile-budget.ts packages/shared/alm/inbound/al-inbound-message-runtime.ts packages/shared/alm/inbound/lane/admit-al-inbound-volatile-budget.ts packages/shared/alm/al-runtime-stores.ts packages/shared/multicast/is-rtc-enqueue-breaker-success.ts packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts packages/shared-web/browser/connection/initialise-browser-middleware.ts packages/shared-web/browser/connection/create-browser-session-volatile-bound.ts packages/shared-web/browser/session/session-connection-lifecycle.ts packages/shared-web/browser/session/rallar-session-controller.ts packages/shared-web/browser/composition/browser-session-composition.ts packages/shared-web/browser/composition/create-rallar-facade.ts packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts packages/tests/shared packages/tests/shared-web packages/tests/rallar-black-box-headless packages/shared-web/scripts/measure-browser-bundles.mjs
git commit -m "feat(alm): S3c-ii -- one volatile bound per session refuses capacity and states overloaded (D74, D78)"
git push origin HEAD:codex/queuebox-persistence-qos-product-plan
```

#### Corrections found while writing (Task 3)

1. **RTC signaling is volatile data the session originates, with no deadline.** C4's exempt list does not name it,
   but `WsRtcSignalingTransportUsingWsQBox.send` (`ws-rtc-signaling-transport-using-ws-q-box.ts:103-110`) builds
   `newALUnicastMessage` without `ttlMs`, so the envelope has no `constraints.expiresAtMs`
   (`al-contract.ts:209-222`), the volatile default applies (`normalize-al-qos-policy.ts:272`), and it is admitted
   through the WS client's `enqueueOutboxIfAbsent` like an application send. Counted, it would hold a ledger entry
   with no release point and could refuse an offer, which strands the peer (the file's own comment, `:97-101`). The
   rule applied: an admission with no deadline is not counted (`toALVolatileSessionAdmission`). Every browser
   messages send carries one (`to-browser-message-send-defaults.ts:40`, `:52`; `DEFAULT_MESSAGE_TTL_MS = 30_000`,
   `browser-rallar-message-sender.ts:108`), so no application send escapes the bound this way.
2. **A capacity refusal would open the RTC circuit breaker and so leak into the WS fallback.**
   `isRtcEnqueueBreakerSuccess` (`is-rtc-enqueue-breaker-success.ts:13-14`) counts every refusal but `unauthorized`
   and `unsupported` as a failure; repeated `capacity` refusals would open the breaker, and the next RTC admissions
   would read `unroutable/circuit-open`, which is an admission fallback trigger
   (`resolve-al-delivery-fallback-trigger.ts:15-19`). Step 10 makes `capacity` a breaker success, which D78's "never
   a fallback trigger" requires.
3. **C13's stated limit is incomplete.** Besides best-effort RTC sends at the origin, `overloaded` drops best-effort
   **arrivals** on both carriers and NACKs them `overloaded`: the WS client's `planIncomingMessage`
   (`ws-queue-box-client-service.ts:299-318`) and the RTC manager's (`web-rtc-overlay-multicast-manager.ts:382-407`)
   both plan with the provider, and `al-policy.ts:600-606` turns the drop into a NACK. The section's opening states
   the full effect; at-least-once traffic is untouched either way.
4. **The budget rides on the memory pairs, not on the services.** The survey's B1 names three constructors and B6 a
   `qosProvider` chain into `ws-queue-box-client-service.ts:659`, `web-rtc-rx-streamer-service.ts:503` and the RTC
   manager. Carrying the budget on `ALVolatileOutboundRuntimeStores` / `ALVolatileInboundRuntimeStores` reaches all
   three runtimes through inputs they already take (`volatileStores`, `inboundVolatileStores`,
   `outboundVolatileStores`), so no service, streamer or manager input changes and
   `web-rtc-overlay-multicast-manager.ts` is untouched (PR #566).
5. **`initialiseMiddleware` is 57 lines today** (`initialise-browser-middleware.ts:188-244`), over the 40-line rule;
   the per-session construction goes into a new `createBrowserTransportInput`, which brings it under 40.
6. **`packages/shared/alm/outbound/` and `packages/shared/alm/inbound/` hold 22 direct files each**, over the
   20-file threshold, so the two admission seams live in their `lane/` folders (2 files each) beside the store lanes.
7. **The ledger has no release call** (the interface ledger names none): a reservation whose commit then admits
   nothing -- an RTC plan with no prepared send ends `unroutable/no-route` at `compute-al-outbound-dispatch.ts:128-141`
   -- stays counted until its deadline. The WS leg of that fallback re-admits the same msgId without a second count,
   so the fallback itself costs one entry.
8. **One counter spans inbound, so a busy receiver meets `capacity` on its own sends.** Inbound admissions are
   never refused (C6) but count; at the 30 s default TTL a session whose volatile traffic in and out stays above
   about 33 messages a second refuses its own volatile sends. The director receiving intents is the first place
   this shows; Task 6's lowered bound and Task 7's docs should say so.
9. **`computeALMessageEnvelopeBytes` keeps the walk's one throw.** C17 makes it a rename of the private walk, which
   throws for a value it cannot inspect (a revoked proxy); `validateALMessageResourceLimits` keeps its `try` and
   states that as `malformed`. The new callers measure envelopes a decoder already accepted (the browser dispatch,
   `browser-rallar-message-dispatch.ts:162`; inbound `admitIncomingMessage`, `al-inbound-message-runtime.ts:187`),
   and the outbound call sits outside `planAdmission`'s `try`, so a throw could never move a message to the durable
   lane.

---

### Task 4: The RTC unicast and the unicast fallback (Q11's RTC half, C7, C8, C9)

**Files:**

- Create:
  - `packages/shared-web/browser/messages/validate-browser-rtc-peer-send.ts` (the rules of a peer send whose first leg
    is RTC; the sender takes call lines only);
  - `packages/tests/shared/multicast/rtc-room-unicast-dispatch.test.ts` (the carrier pin: the unchanged overlay
    manager already plans a room unicast as this task needs);
  - `packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts` (the sender contract and what the handle reads
    in each RTC outcome; the `messages/` test directory goes from 18 to 19 files).
- Rename (`git mv`, then rewrite): `packages/shared-web/browser/messages/create-browser-ws-unicast-message.ts` ->
  `packages/shared-web/browser/messages/create-browser-unicast-message.ts` (`createBrowserWsUnicastMessage` ->
  `createBrowserUnicastMessage`, `validateBrowserWsPeerInput` -> `validateBrowserPeerInput`,
  `validateBrowserWsPeerServer` -> `validateBrowserPeerServer`, `CreateBrowserWsUnicastMessageInput` ->
  `CreateBrowserUnicastMessageInput`; no alias; the only importer is the sender).
- Modify:
  - `packages/shared-web/browser/messages/browser-rallar-message-sender.ts:30-34` (imports), `:176-184` (`sendWs`),
    `:207-214` (`sendTyped`), a new private `sendRtcPeer` inserted before `:233` (`sendRoomWithFallback`), `:317-325`
    (`createWsSendMessage`). Call lines only: the file measures cognitive load 37 today and 40 after the change
    (tier 50), 458 lines today and 506 after;
  - `packages/shared-web/browser/messages/rallar-message-contracts.ts:73-78` (the doc comment on
    `RallarWsSendInput.peerId`; the type is unchanged, `RallarRtcSendInput` is unchanged, C7);
  - `packages/tests/shared-web/messages/browser-ws-peer-send.test.ts:10` (describe title) and `:61-74` (the WS-only
    refusal pin becomes the `ws-then-rtc` refusal pin);
  - bundle ceilings only if crossed: `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts:44-59`,
    `packages/shared-web/scripts/measure-browser-bundles.mjs:34-49`,
    `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts:70-83` (line numbers as Tasks 1-3 leave
    them; read the current ceiling first).
- Not modified, by decision: `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts` (PR #566's file; Step 1
  pins that it already plans the room unicast), `browser-rallar-message-dispatch.ts`,
  `browser-message-fallback-controller.ts`, `browser-rallar-delivery-registry.ts` (target-agnostic, see the audit
  below), `BrowserRallarMessageSender.sendWsUnicast` and the director relay (Task 5 owns them),
  `docs/test-structure-coupling-exceptions.md` (no registered test file is touched and the new tests carry no
  candidate).
- Test: the two created test files and `browser-ws-peer-send.test.ts`; regression runs of
  `browser-message-fallback-controller.test.ts`, `browser-message-fallback-identity.test.ts`,
  `browser-typed-message-channels.test.ts`, `browser-rallar-message-sender.test.ts`,
  `browser-message-handle-admission.test.ts` (the S3a `sendWsUnicast` pin stays green: Task 5 replaces it).

**Interfaces:**

- Consumes (Task 1): `ALDeliveryEvidence.failure: ALDeliveryFailure | undefined`; the `receipt-exhausted` settlement
  `Readonly<{ kind: 'receipt-exhausted'; ... }> & ALDeliveryReceiptExhaustion` (tests state `cause: 'budget'`); the
  reducer maps `attempts-exhausted` to `{ kind: 'unroutable', reason }` and a budget exhaustion to
  `{ kind: 'receipt-exhausted', cause: 'budget' }`. Nothing from Tasks 2 and 3.
- Consumes (existing, unchanged):
  - `BrowserRallarMessageSender.resolveRtcMessageTarget<T>(input: RallarRtcSendInput<T>, initialIssues: readonly RallarValidationIssue[]): ResolvedRtcMessageTarget`
    (`browser-rallar-message-sender.ts:277-310`, private), `capturePayload` (`:262-269`), `startDelivery`
    (`:271-275`);
  - `BrowserMessageInputValidator.validateWs<T>(resolved: ResolvedWsMessageInput<T>): readonly RallarValidationIssue[]`
    (`browser-message-input-validator.ts:91-116`) and `ResolvedWsMessageInput<T>` (`:24-29`);
  - `BrowserRallarMessageDispatch.Delivery { context; carrier; message; canFallback; payloadIssues }`
    (`browser-rallar-message-dispatch.ts:41-47`);
  - `AL_FALLBACK_NOT_READY_ATTEMPTS = 3` (`packages/shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts:12`).
- Produces in `packages/shared-web/browser/messages/create-browser-unicast-message.ts`:
  - `export type BrowserPeerSendStrategy = 'ws' | 'rtc' | 'rtc-with-ws-fallback';`
  - `export interface CreateBrowserUnicastMessageInput<T>` — as the old `CreateBrowserWsUnicastMessageInput<T>`
    except `readonly serializedPayload: string` replaces `readonly payload: unknown` (see correction 2);
  - `export function createBrowserUnicastMessage<T>(input: CreateBrowserUnicastMessageInput<T>): ALMessage`;
  - `export interface ValidateBrowserPeerInput<T> { readonly send: RallarWsSendInput<T>; readonly roomRef: GroupRef | undefined; }`
  - `export function validateBrowserPeerInput<T>(input: ValidateBrowserPeerInput<T>): readonly RallarValidationIssue[]`
    — adds C8: `{ path: '$.contextId', code: 'context-room-mismatch', message: 'A peer-addressed send routes in the room it names: contextId must equal the room id.' }`
    when a room is named and `contextId !== roomRef.groupId`;
  - `export interface ValidateBrowserPeerServerInput { readonly peerId: string | undefined; readonly strategy: BrowserPeerSendStrategy; readonly serverPeerId: string | undefined; }`
  - `export function validateBrowserPeerServer(input: ValidateBrowserPeerServerInput): readonly RallarValidationIssue[]`
    — C9: `{ path: '$.peerId', code: 'unsupported', message: 'The server is addressed over WS: a peer-addressed send to it takes the ws strategy.' }`
    for `peerId === serverPeerId` on `rtc` and `rtc-with-ws-fallback`; the R-S3c-i-32 issue (message unchanged) on
    `ws` and `rtc-with-ws-fallback`, never on `rtc`.
- Produces in `packages/shared-web/browser/messages/validate-browser-rtc-peer-send.ts`:
  - `export type BrowserRtcPeerSendStrategy = Exclude<BrowserPeerSendStrategy, 'ws'>;`
  - `export interface BrowserRtcPeerSend<T> { readonly send: RallarRtcSendInput<T> & RallarWsSendInput<T>; readonly peerId: string; readonly strategy: BrowserRtcPeerSendStrategy; }`
  - `export interface ValidateBrowserRtcPeerSendInput<T> { readonly peer: BrowserRtcPeerSend<T>; readonly resolved: ResolvedWsMessageInput<T>; readonly inputValidator: BrowserMessageInputValidator; }`
  - `export function validateBrowserRtcPeerSend<T>(input: ValidateBrowserRtcPeerSendInput<T>): readonly RallarValidationIssue[]`
    — `$.scope` `unsupported` 'A peer-addressed RTC send names its room: its scope is room.' and `$.peerId`
    `unsupported` 'A peer-addressed send carries no membership fence and no overlay routing.'.
- Produces on the public surface (no new export name, so no snapshot moves, survey correction 9):
  `RallarTypedMessageChannel<T>.send(payload, { peerId, strategy })` accepts `peerId` on `ws`, `rtc` and
  `rtc-with-ws-fallback` (the room channel's default); on `ws-then-rtc` it is refused
  `{ path: '$.peerId', code: 'unsupported', message: 'A peer-addressed typed send takes the ws, rtc or rtc-with-ws-fallback strategy.' }`
  (V1 carry). Task 5 calls `rallar.messages.room<T>(definition).send(payload, { peerId: appointment.sessionId, strategy: 'rtc-with-ws-fallback' })`.
- Handle behaviour Task 5 and Task 6 rely on (pinned in Step 2): directly ready addressee that ACKs -> `acknowledged`
  on RTC; addressee missing from a non-empty ready set -> RTC `unroutable/no-route`, WS admission at once, WS receipt
  -> `acknowledged`; connected addressee off the server tree -> three `not-ready` attempts, hand-over, WS receipt ->
  `acknowledged`; RTC `receipt-exhausted` inside the deadline -> hand-over; strategy `rtc` never falls back
  (`failed` with `evidence.failure` `{ kind: 'unroutable', reason: 'no-route' }` or
  `{ kind: 'receipt-exhausted', cause: 'budget' }`).

**Audit (survey A2), confirmed in the code:** the dispatch never reads `targets`: `writeCapturedMessage`
(`browser-rallar-message-dispatch.ts:92-134`) re-admits the envelope the first leg returned (`result.message`,
`:121-128`); `watchFallbackLeg` (`:137-156`) registers on `canFallback && carrier === 'rtc'` and an owned verdict,
with `wsLeg.message = result.message`; `writeCarrierOutboxAdmission` (`:200-208`) picks the carrier by name. The
fallback controller reads `message.id.msgId` and `message.constraints?.expiresAtMs` only
(`browser-message-fallback-controller.ts:49-110`). The registry reads `message.delivery?.ack` and
`resolveALDeliveryReceiptAlgo(message)` at open (`browser-rallar-delivery-registry.ts:166-180`). The only
room-multicast-specific code is in the sender (`sendRoomWithFallback`, `createRtcMessage`,
`validateRoomFallbackInput`, `toRoomFallbackMessage`), which the peer path does not use. On the RTC carrier a unicast
passes `toRtcOriginFrozenMessage` unchanged (`web-rtc-overlay-frozen-audience.ts:33-60`) and
`toRtcEmptyAudienceDispatchPlan` unchanged (its frozen audience is `undefined`, `:120-126`); `toALOutboundMessage`
adds `qos.expiry` and `constraints.expiresAtMs` only (`to-al-outbound-message.ts:7-15`), so the WS leg receives the
unicast with its `groupRef` and `route.contextId` intact. The overlay manager plans it directly
(`planOriginatingDispatch`, `web-rtc-overlay-multicast-manager.ts:555-564` -> `planDirectDispatch` `:494-511`),
refuses a missing addressee `no-route` at admission (`:635-645`) and settles an off-tree addressee `not-ready` at
dispatch (`sendPreparedMessage` `:696-731` with `resolveRtcRoomEdgeDenial`, `rtc-room-snapshot-admission.ts:214-253`).
The manager needs no change; Step 1 pins all three from the real class.

**Corrections found while writing:**

1. The WS-only refusal is pinned in `packages/tests/shared-web/messages/browser-ws-peer-send.test.ts:61-74`, not in
   `browser-rallar-message-sender.test.ts` or `browser-typed-message-channels.test.ts` (neither names `peerId` on a
   typed `send`). Their registry entries (`browser-invalid-fallback-no-admission`,
   `browser-explicit-ws-strategy-excludes-rtc`, `docs/test-structure-coupling-exceptions.md:3209-3240`, `:7385-7415`)
   stay valid and untouched; `browser-ws-peer-send.test.ts` has no candidate.
2. `create-browser-ws-unicast-message.ts:19` (`readonly payload: unknown;`) is a sleeping `boundary.unknown` finding:
   the odd apostrophe in the comment on `:18` masks it (the checker strips quoted text without knowing comments). A
   rename plus a comment edit would wake it as a new finding in the changed-range gate. The renamed builder therefore
   takes `serializedPayload: string` (the captured serialization, `CapturedMessagePayload.serialized`) and parses it
   itself; the new file has no `unknown` token and no apostrophe in its comments.
3. A room unicast finds its overlay only under the scoped key: `readOverlayId`
   (`web-rtc-overlay-multicast-manager.ts:459-487`) falls back to `groupRef.groupId` for a multicast only, and the
   product keys the accepted overlay cache by `toScopedOverlayId(groupRef)`
   (`packages/shared/services/webrtc-group-overlay-reading.ts:39-50`). The shared test fixture
   `rtc-origin-overlay-fixture.ts:79` on main (`:85` after Tasks 2 and 3) keys it `'room'`, so a unicast there reads no overlay and every attempt settles
   `not-ready` ("Awaiting server room relay authority"). Step 1 stores the overlay under the scoped key too.
4. The sender is at a tier by length only: its cognitive load is 37 (measured with
   `scripts/repo-style-check/cognitive-load-rules.mjs`); after this task 40, with `sendRtcPeer` 35 lines.
5. The C9 server rules and R-S3c-i-32 read `serverPeerId`, which exists only after `connect()`; like `sendWs`
   (`:183-184`) they are thrown after connect and before a handle opens.
6. C8 also changes the plain WS peer send (`messages.ws.send`, a channel `sendWs`): a `contextId` naming another room
   was sent and refused by the server router (`decode-rallar-server-ws-ingress.ts:69-76`); it is now refused at the
   sender. No caller in the repository sets `contextId` on a peer send (Relic's `send-relic-ws-command.ts:34` passes
   `{ peerId }` only).

- [ ] **Step 1: Pin the carrier (expected PASS, no source change).** Create
      `packages/tests/shared/multicast/rtc-room-unicast-dispatch.test.ts`:

```ts
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { AL_FALLBACK_NOT_READY_ATTEMPTS } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';

import {
    acknowledgeAtOrigin,
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    readSentTargets,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

type AttemptSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-settled'; }>>;

describe('a room-naming RTC unicast at its origin, through the unchanged overlay manager (Q11)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('sends straight to an addressee that is directly ready and its overlay next hop, and completes on its ACK', async () => {
        const fixture = createRoomUnicastFixture(['b'], ['b']);
        const message = createRoomUnicast('direct', 'b');

        const admitted = await enqueueAndDrain(fixture.manager, message);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(readSentTargets(fixture.channels.b!)).toEqual([{
            mode: 'unicast',
            toPeerId: 'b',
            groupRef: ORIGIN_ROOM
        }]);
        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'b',
            logicalRecipientPeerId: 'b',
            status: 'delivered'
        });
        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        )
            .toMatchObject({ mode: 'receiver', complete: true, unconfirmedRecipientPeerIds: [] });
    });

    it('refuses it at admission as unroutable no-route when the addressee is missing from a non-empty ready set', async () => {
        const fixture = createRoomUnicastFixture(['b', 'c'], ['b', 'c']);

        const admitted = await enqueueAndDrain(fixture.manager, createRoomUnicast('missing', 'd'));

        expect(admitted.verdict).toMatchObject({ kind: 'unroutable', reason: 'no-route' });
        expect(fixture.channels.d!.sent).toEqual([]);
    });

    it('settles every attempt not-ready when the addressee is directly ready but not the overlay next hop', async () => {
        const fixture = createRoomUnicastFixture(['b', 'c', 'd'], ['b', 'c']);
        const message = createRoomUnicast('off-tree', 'd');

        const admitted = await enqueueAndDrain(fixture.manager, message);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        const outcomes = fixture.settlements
            .filter((settlement): settlement is AttemptSettlement =>
                settlement.kind === 'attempt-settled'
            )
            .filter((settlement) => settlement.msgId === message.id.msgId)
            .map((settlement) => settlement.outcome);
        expect(outcomes.length).toBeGreaterThanOrEqual(AL_FALLBACK_NOT_READY_ATTEMPTS);
        expect(new Set(outcomes)).toEqual(new Set(['not-ready']));
        expect(fixture.channels.d!.sent).toEqual([]);
    });
});

/** The origin `a` in a four-session room: `readyPeerIds` hold open channels, the server tree gives it `nextHopPeerIds`. */
function createRoomUnicastFixture(
    readyPeerIds: readonly string[],
    nextHopPeerIds: readonly string[]
): RtcOriginOverlayFixture {
    const fixture = createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c', 'd'], 4),
        nextHopPeerIds: readyPeerIds
    });
    // A unicast finds its overlay by the scoped room key, the key the product overlay cache uses.
    fixture.overlays.accept(toScopedOverlayId(ORIGIN_ROOM), createOriginOverlay(nextHopPeerIds));
    return fixture;
}

function createRoomUnicast(resourceId: string, toPeerId: string): ALMessage {
    return newALUnicastMessage(
        'a',
        { topicId: 'room.director.intent', resourceId, contextId: 'room' },
        toPeerId,
        'room.director.intent.v1',
        { intent: resourceId },
        {
            groupRef: ORIGIN_ROOM,
            reliability: 'at-least-once',
            ack: 'receiver',
            ownership: 'shared',
            ttlMs: 30_000
        }
    );
}
```

Run: `npx vitest run packages/tests/shared/multicast/rtc-room-unicast-dispatch.test.ts`
Expected: PASS (3 tests) against the unchanged manager. This is a characterization pin, not a RED step: it proves the
carrier already does what Step 2's carrier doubles assume. If any case fails, stop and report to the controller; the
premise "no change to `web-rtc-overlay-multicast-manager.ts`" is then wrong and needs a ruling (PR #566 owns the
file).

- [ ] **Step 2: RED, the sender contract and the handle outcomes.** Create
      `packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts`. The first describe drives the real sender
      through `createBrowserMessageSenderFixture` (its server names `'server'`); the second drives the production
      sender, dispatch, registry and fallback controller over carrier doubles that record every admission (no mock
      call is asserted, so the file carries no test-structure-coupling candidate):

```ts
import { describe, expect, it, vi } from 'vitest';

import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import { BrowserTypedMessageChannels } from '@shared-web/browser/messages/browser-typed-message-channels.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryCarrier,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { AL_FALLBACK_NOT_READY_ATTEMPTS } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { createBrowserMessageSenderFixture } from './browser-message-sender-fixture.ts';

const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const COMMAND_CHANNEL = { purpose: 'command', durability: undefined } as const;
const DIRECTOR = 'director';
const INTENT = {
    typeId: 'room.director.intent.v1',
    topicId: 'room.director.intent',
    payload: { intent: 'pickup' }
};
const DIRECTOR_UNICAST = { mode: 'unicast', toPeerId: DIRECTOR, groupRef: ROOM_REF };
const ADMITTED: ALDeliveryAdmissionVerdict = {
    kind: 'admitted',
    durable: false,
    queuedAttempts: 1
};
const NO_ROUTE: ALDeliveryAdmissionVerdict = {
    kind: 'unroutable',
    reason: 'no-route',
    detail: 'Skipping RTC outbound dispatch without planned transport messages'
};
const SERVER_OVER_WS =
    'The server is addressed over WS: a peer-addressed send to it takes the ws strategy.';
const SERVER_NAMES_NO_PEER_ID =
    'A peer-addressed send needs a server that names its peer id; this server names none.';
const CONTEXT_NAMES_ANOTHER_ROOM =
    'A peer-addressed send routes in the room it names: contextId must equal the room id.';

describe('a typed send addressed to one peer over RTC (Q11, C7)', () => {
    it.each(['rtc', 'rtc-with-ws-fallback'] as const)(
        'admits one receipted room unicast on RTC for a command channel on %s',
        async (strategy) => {
            const fixture = createBrowserMessageSenderFixture();
            const rtcAdmission = vi.spyOn(
                fixture.middleware.middleware.rtcRxStreamer,
                'enqueueOutboxIfAbsent'
            );

            const handle = await fixture.sender.sendTyped({
                ...INTENT,
                roomId: 'room',
                peerId: DIRECTOR,
                strategy
            }, COMMAND_CHANNEL);

            const message = rtcAdmission.mock.calls[0][0];
            expect(message.id.msgId).toBe(handle.msgId);
            expect(message.targets).toEqual(DIRECTOR_UNICAST);
            expect(message.route).toMatchObject({
                topicId: 'room.director.intent',
                contextId: 'room'
            });
            // A unicast that names its room has a logical audience, so a command asks the addressee receipt.
            expect(message.delivery).toEqual({
                ownership: 'shared',
                reliability: 'at-least-once',
                ack: 'receiver'
            });
            expect(message.qos?.durability).toEqual({ algo: 'volatile' });
        }
    );

    it('names the current room when the send names none: over RTC a peer send always names its room', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const rtcAdmission = vi.spyOn(
            fixture.middleware.middleware.rtcRxStreamer,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendTyped({ ...INTENT, peerId: DIRECTOR }, COMMAND_CHANNEL);

        const message = rtcAdmission.mock.calls[0][0];
        expect(message.targets).toEqual(DIRECTOR_UNICAST);
        expect(message.route.contextId).toBe('room');
    });

    it('sends a typed room channel send to one peer over RTC with WS fallback by default (D75)', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const rtcAdmission = vi.spyOn(
            fixture.middleware.middleware.rtcRxStreamer,
            'enqueueOutboxIfAbsent'
        );
        const channels = new BrowserTypedMessageChannels({
            inputValidator: new BrowserMessageInputValidator({
                readMaxPayloadBytes: () => 64 * 1024
            }),
            sender: fixture.sender,
            rtc: { onMessage: () => () => {} },
            ws: { onMessage: () => () => {} }
        });
        const intents = channels.room<{ intent: string; }>({
            topicId: 'room.director.intent',
            typeId: 'room.director.intent.v1',
            roomId: 'room',
            purpose: 'command'
        });

        await intents.send({ intent: 'pickup' }, { peerId: DIRECTOR });

        const message = rtcAdmission.mock.calls[0][0];
        expect(message.targets).toEqual(DIRECTOR_UNICAST);
        expect(message.delivery).toMatchObject({ reliability: 'at-least-once', ack: 'receiver' });
    });

    it.each(['ws', 'rtc', 'rtc-with-ws-fallback'] as const)(
        'refuses a contextId naming another room at the sender on %s (N1, C8)',
        async (strategy) => {
            const fixture = createBrowserMessageSenderFixture();

            await expect(fixture.sender.sendTyped({
                ...INTENT,
                roomId: 'room',
                contextId: 'other-room',
                peerId: DIRECTOR,
                strategy
            }, COMMAND_CHANNEL)).rejects.toMatchObject({
                issues: [{
                    path: '$.contextId',
                    code: 'context-room-mismatch',
                    message: CONTEXT_NAMES_ANOTHER_ROOM
                }]
            });
        }
    );

    it('accepts a contextId that names its own room', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const rtcAdmission = vi.spyOn(
            fixture.middleware.middleware.rtcRxStreamer,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendTyped({
            ...INTENT,
            roomId: 'room',
            contextId: 'room',
            peerId: DIRECTOR
        }, COMMAND_CHANNEL);

        const message = rtcAdmission.mock.calls[0][0];
        expect(message.route.contextId).toBe('room');
    });

    it.each(['rtc', 'rtc-with-ws-fallback'] as const)(
        'refuses a send to the server on %s: the server is addressed over WS (C9)',
        async (strategy) => {
            const fixture = createBrowserMessageSenderFixture();

            await expect(
                fixture.sender.sendTyped(
                    { ...INTENT, roomId: 'room', peerId: 'server', strategy },
                    COMMAND_CHANNEL
                )
            )
                .rejects.toMatchObject({
                    issues: [{ path: '$.peerId', code: 'unsupported', message: SERVER_OVER_WS }]
                });
        }
    );

    it('refuses a fallback send while the server names no peer id, since its second leg is WS (R-S3c-i-32, C9)', async () => {
        const fixture = createBrowserMessageSenderFixture();
        Object.assign(fixture.middleware.middleware.webSocketQueueBox, { serverPeerId: undefined });

        await expect(
            fixture.sender.sendTyped(
                { ...INTENT, roomId: 'room', peerId: DIRECTOR },
                COMMAND_CHANNEL
            )
        )
            .rejects.toMatchObject({
                issues: [{
                    path: '$.peerId',
                    code: 'unsupported',
                    message: SERVER_NAMES_NO_PEER_ID
                }]
            });
    });

    it('sends a plain RTC peer send while the server names no peer id: it never reaches WS (C9)', async () => {
        const fixture = createBrowserMessageSenderFixture();
        Object.assign(fixture.middleware.middleware.webSocketQueueBox, { serverPeerId: undefined });
        const rtcAdmission = vi.spyOn(
            fixture.middleware.middleware.rtcRxStreamer,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendTyped({
            ...INTENT,
            roomId: 'room',
            peerId: DIRECTOR,
            strategy: 'rtc'
        }, COMMAND_CHANNEL);

        const message = rtcAdmission.mock.calls[0][0];
        expect(message.targets).toEqual(DIRECTOR_UNICAST);
    });

    it.each([
        ['exclusions', { exceptPeerIds: ['peer-c'] }],
        ['a membership fence', { membershipEpoch: 1 }],
        ['a next hop', { nextHopPeerIds: ['peer-c'] }],
        ['an overlay', { overlayId: 'overlay-1' }],
        ['a fan-out limit', { fanoutLimit: 2 }]
    ])(
        'refuses a peer send over RTC that carries %s, which a unicast cannot honour',
        async (_name, extra) => {
            const fixture = createBrowserMessageSenderFixture();

            const sending = fixture.sender.sendTyped({
                ...INTENT,
                roomId: 'room',
                peerId: DIRECTOR,
                ...extra
            }, COMMAND_CHANNEL);

            await expect(sending).rejects.toSatisfy(isRallarValidationError);
            await expect(sending).rejects.toMatchObject({
                issues: expect.arrayContaining([
                    expect.objectContaining({ path: '$.peerId', code: 'unsupported' })
                ])
            });
        }
    );

    it('refuses a peer send over RTC whose scope is not its room', async () => {
        const fixture = createBrowserMessageSenderFixture();

        await expect(
            fixture.sender.sendTyped({
                ...INTENT,
                roomId: 'room',
                peerId: DIRECTOR,
                scope: 'all',
                strategy: 'rtc'
            }, COMMAND_CHANNEL)
        )
            .rejects.toMatchObject({ issues: [{ path: '$.scope', code: 'unsupported' }] });
    });
});

describe('what the handle of a peer send over RTC reads (Q11, D56)', () => {
    it('ends acknowledged on RTC when the addressee is directly ready and ACKs', async () => {
        const fixture = createPeerFallbackFixture(ADMITTED);
        const handle = await fixture.send('rtc-with-ws-fallback');

        fixture.settle(toReceipt(handle.msgId, 'rtc'));

        expect(handle.lifecycle().state).toBe('acknowledged');
        expect(handle.lifecycle().evidence.carrierFallback).toBeUndefined();
        expect(handle.lifecycle().evidence.failure).toBeUndefined();
        expect(readCarriers(fixture)).toEqual(['rtc']);
    });

    it('falls back at admission when the addressee is missing from a non-empty ready set, the WS leg keeping its room', async () => {
        const fixture = createPeerFallbackFixture(NO_ROUTE);
        const handle = await fixture.send('rtc-with-ws-fallback');
        await waitForCarriers(fixture, ['rtc', 'ws']);

        const [rtcLeg, wsLeg] = fixture.admissions;
        // The WS leg is the envelope the RTC admission returned: its msgId, its deadline, its room and its context.
        expect(wsLeg!.message).toEqual(rtcLeg!.message);
        expect(wsLeg!.message.targets).toEqual(DIRECTOR_UNICAST);
        expect(wsLeg!.message.route.contextId).toBe('room');
        expect(fixture.handedOver).toEqual([]);
        expect(handle.lifecycle().evidence.attempts).toMatchObject([{
            carrier: 'rtc',
            outcome: 'unroutable'
        }]);

        fixture.settle(toReceipt(handle.msgId, 'ws'));

        expect(handle.lifecycle().state).toBe('acknowledged');
    });

    it('hands the leg to WS after the not-ready bound when the addressee is connected but not the overlay next hop', async () => {
        const fixture = createPeerFallbackFixture(ADMITTED);
        const handle = await fixture.send('rtc-with-ws-fallback');

        for (let attempt = 1; attempt < AL_FALLBACK_NOT_READY_ATTEMPTS; attempt += 1) {
            fixture.settle(toNotReady(handle.msgId, `send-${attempt}`));
        }
        expect(fixture.handedOver).toEqual([]);
        fixture.settle(toNotReady(handle.msgId, 'send-last'));
        await waitForCarriers(fixture, ['rtc', 'ws']);

        expect(fixture.handedOver).toEqual([handle.msgId]);
        expect(fixture.admissions[1]!.message).toEqual(fixture.admissions[0]!.message);
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            from: 'rtc',
            to: 'ws',
            reason: 'not-ready'
        });

        fixture.settle(toReceipt(handle.msgId, 'ws'));

        expect(handle.lifecycle().state).toBe('acknowledged');
    });

    it('hands a receipt that ran out on RTC to WS inside the deadline, and ends on the WS receipt', async () => {
        const fixture = createPeerFallbackFixture(ADMITTED);
        const handle = await fixture.send('rtc-with-ws-fallback');

        fixture.settle(toExhausted(handle.msgId));
        await waitForCarriers(fixture, ['rtc', 'ws']);

        expect(handle.lifecycle().state).not.toBe('failed');
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            from: 'rtc',
            to: 'ws',
            reason: 'receipt-exhausted'
        });
        fixture.settle(toReceipt(handle.msgId, 'ws'));
        expect(handle.lifecycle().state).toBe('acknowledged');
        expect(handle.lifecycle().evidence.failure).toBeUndefined();
    });

    describe('on the rtc strategy alone, which never falls back', () => {
        it('ends failed when the addressee has no route', async () => {
            const fixture = createPeerFallbackFixture(NO_ROUTE);
            const handle = await fixture.send('rtc');

            const { lifecycle } = await handle.wait();
            expect(lifecycle.state).toBe('failed');
            expect(lifecycle.evidence.failure).toEqual({ kind: 'unroutable', reason: 'no-route' });
            expect(readCarriers(fixture)).toEqual(['rtc']);
        });

        it('ends failed when the RTC receipt runs out: the receipt end is the message end', async () => {
            const fixture = createPeerFallbackFixture(ADMITTED);
            const handle = await fixture.send('rtc');

            fixture.settle(toExhausted(handle.msgId));
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(handle.lifecycle().state).toBe('failed');
            expect(handle.lifecycle().evidence.failure).toMatchObject({
                kind: 'receipt-exhausted',
                cause: 'budget'
            });
            expect(fixture.handedOver).toEqual([]);
            expect(readCarriers(fixture)).toEqual(['rtc']);
        });

        it('keeps the message on RTC through any run of not-ready attempts', async () => {
            const fixture = createPeerFallbackFixture(ADMITTED);
            const handle = await fixture.send('rtc');

            for (let attempt = 0; attempt <= AL_FALLBACK_NOT_READY_ATTEMPTS; attempt += 1) {
                fixture.settle(toNotReady(handle.msgId, `send-${attempt}`));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(fixture.handedOver).toEqual([]);
            expect(readCarriers(fixture)).toEqual(['rtc']);
            expect(handle.lifecycle().state).not.toBe('failed');
        });
    });
});

interface PeerAdmission {
    readonly carrier: ALDeliveryCarrier;
    readonly message: ALMessage;
}

interface CarrierDoubles {
    readonly context: ApiMiddleware;
    readonly admissions: readonly PeerAdmission[];
    readonly handedOver: readonly string[];
}

interface PeerFallbackFixture {
    readonly admissions: readonly PeerAdmission[];
    readonly handedOver: readonly string[];
    settle(settlement: ALDeliverySettlement): void;
    send(strategy: 'rtc' | 'rtc-with-ws-fallback'): Promise<RallarMessageHandle>;
}

/** The production sender, dispatch, registry and fallback controller over the carrier doubles. */
function createPeerFallbackFixture(rtcVerdict: ALDeliveryAdmissionVerdict): PeerFallbackFixture {
    const { context, admissions, handedOver } = createCarrierDoubles(rtcVerdict);
    const deliveries = new BrowserRallarDeliveryRegistry({
        nowMs: Date.now,
        retainTerminalMs: 60_000,
        maxEntries: 512,
        cancel: () => {}
    });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, {
        deliverySettlements: feed,
        readMiddleware: () => context
    });
    sessionDeliveries.beginSession(context.session);
    const epoch = feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
    const sender = new BrowserRallarMessageSender({
        creation: {
            createUnicast: newALUnicastMessage,
            createMulticast: newALMulticastMessage,
            createBroadcast: newALBroadcastMessage,
            newResourceId: crypto.randomUUID.bind(crypto)
        },
        deliveries,
        dispatch: new BrowserRallarMessageDispatch({
            deliveries,
            sessionDeliveries,
            nowMs: Date.now
        }),
        inputValidator: new BrowserMessageInputValidator({ readMaxPayloadBytes: () => 64 * 1024 }),
        connect: async () => context,
        requireSession: () => context.session,
        resolveDefaultRoom: () => ROOM_REF,
        resolveCurrentRoomRef: () => ROOM_REF,
        toRoomId: (room) => typeof room === 'string' ? room : room?.groupId,
        resolveRoomRef: () => ROOM_REF,
        resolveRoomMinSnapshotVersion: (_room, explicit) => explicit
    });
    return {
        admissions,
        handedOver,
        settle: (settlement) => epoch.settlements[settlement.carrier](settlement),
        send: async (strategy) => {
            const handle = await sender.sendTyped({
                ...INTENT,
                roomRef: ROOM_REF,
                peerId: DIRECTOR,
                strategy
            }, COMMAND_CHANNEL);
            await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });
            return handle;
        }
    };
}

/** RTC answers with `rtcVerdict` and returns the envelope with the deadline it selected; WS admits what it is handed. */
function createCarrierDoubles(rtcVerdict: ALDeliveryAdmissionVerdict): CarrierDoubles {
    const admissions: PeerAdmission[] = [];
    const handedOver: string[] = [];
    const admit = async (
        carrier: ALDeliveryCarrier,
        message: ALMessage
    ): Promise<ALOutboundEnqueueResult> => {
        const admitted = carrier === 'rtc'
            ? {
                ...message,
                constraints: { ...message.constraints, expiresAtMs: message.id.ts + 29_000 }
            }
            : message;
        admissions.push({ carrier, message: admitted });
        return {
            verdict: carrier === 'rtc' ? rtcVerdict : ADMITTED,
            message: admitted,
            entries: [],
            trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(admitted)
        };
    };
    const context = createDefaultApiMiddlewareTestDouble({
        middleware: {
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: (message) => admit('rtc', message),
                handOverOutbox: async (msgId) => {
                    handedOver.push(msgId);
                }
            },
            webSocketQueueBox: { enqueueOutboxIfAbsent: (message) => admit('ws', message) }
        }
    });
    return { context, admissions, handedOver };
}

function readCarriers(fixture: PeerFallbackFixture): readonly ALDeliveryCarrier[] {
    return fixture.admissions.map((admission) => admission.carrier);
}

/** The WS admission settles in a later microtask than its carrier call; one task turn lands it. */
async function waitForCarriers(
    fixture: PeerFallbackFixture,
    carriers: readonly ALDeliveryCarrier[]
): Promise<void> {
    await vi.waitFor(() => expect(readCarriers(fixture)).toEqual(carriers));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function toNotReady(msgId: string, attemptId: string): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId,
        carrier: 'rtc',
        atMs: Date.now(),
        attemptId,
        outcome: 'not-ready',
        submissionAttempted: false,
        detail: 'RTC relay edge is not permitted by current server room topology',
        willRetry: true
    };
}

function toExhausted(msgId: string): ALDeliverySettlement {
    return {
        kind: 'receipt-exhausted',
        msgId,
        carrier: 'rtc',
        atMs: Date.now(),
        mode: 'receiver',
        confirmedPeerIds: [],
        unconfirmedPeerIds: [DIRECTOR],
        detail: 'The receipt ran out of retries after 3 of 3.',
        cause: 'budget'
    };
}

function toReceipt(msgId: string, carrier: ALDeliveryCarrier): ALDeliverySettlement {
    return {
        kind: 'acknowledgement',
        msgId,
        carrier,
        atMs: Date.now(),
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: [DIRECTOR],
        confirmedRecipientPeerIds: [DIRECTOR],
        unconfirmedRecipientPeerIds: [],
        complete: true
    };
}
```

Run: `npx vitest run packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts`
Expected: FAIL. Every RTC peer send rejects with "A peer-addressed typed send travels WS only until the RTC unicast
lands." (the admission, room, channel, contextId-on-RTC, server, scope and handle cases); the `ws` case of the
contextId test resolves instead of rejecting. The five "carries %s" cases already pass (the WS-only refusal is also
`$.peerId` `unsupported`); they stay as the pin of the new rule.

- [ ] **Step 3: RED, the `ws-then-rtc` pin replaces the WS-only pin.** In
      `packages/tests/shared-web/messages/browser-ws-peer-send.test.ts` replace `:10`
      `describe('a WS send addressed to one peer (Q11, WS only)', () => {` with
      `describe('a WS send addressed to one peer (Q11)', () => {`, and replace the test at `:61-74` (`it('refuses a
      peer target on any strategy but ws until the RTC unicast lands (S3c-ii)', ...)`) with:

```ts
it('refuses a peer target on ws-then-rtc, which hands over at admission only (V1)', async () => {
    const fixture = createBrowserMessageSenderFixture();

    const sending = fixture.sender.sendTyped({
        typeId: 'relic.command.v1',
        payload: {},
        roomId: 'room',
        peerId: 'server',
        strategy: 'ws-then-rtc'
    }, COMMAND_CHANNEL);

    await expect(sending).rejects.toSatisfy(isRallarValidationError);
    // The default topic would fail the WS topic rule too; the peer refusal must come first.
    await expect(sending).rejects.toMatchObject({
        issues: [{
            path: '$.peerId',
            code: 'unsupported',
            message:
                'A peer-addressed typed send takes the ws, rtc or rtc-with-ws-fallback strategy.'
        }]
    });
});
```

Run: `npx vitest run packages/tests/shared-web/messages/browser-ws-peer-send.test.ts`
Expected: FAIL in that one test only (the message is still the WS-only one); the other ten stay green.

- [ ] **Step 4: GREEN, rename the builder and give it the peer rules (C8, C9).** Run

```bash
git mv packages/shared-web/browser/messages/create-browser-ws-unicast-message.ts \
  packages/shared-web/browser/messages/create-browser-unicast-message.ts
```

and replace the whole content of `packages/shared-web/browser/messages/create-browser-unicast-message.ts` with (keep
comments free of apostrophes and the file free of the `unknown` token, correction 2):

```ts
import type { ResolvedWsMessageInput } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type { RallarWsSendInput } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    toBrowserMessageSendDefaults,
    type BrowserTypedChannelPolicy
} from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import {
    newALRoute,
    type ALMessage,
    type newALUnicastMessage
} from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    validateRallarRouteId,
    type RallarValidationIssue
} from '@shared/api/rallar-validation.ts';

/** The strategies a peer send travels; `ws-then-rtc` hands over at admission only and stays refused (V1). */
export type BrowserPeerSendStrategy = 'ws' | 'rtc' | 'rtc-with-ws-fallback';

export interface CreateBrowserUnicastMessageInput<T> {
    readonly creation: Readonly<
        { createUnicast: typeof newALUnicastMessage; newResourceId(): string; }
    >;
    readonly resolved: ResolvedWsMessageInput<T>;
    readonly peerId: string;
    /** The payload as the validator captured and serialized it; the message carries a parse of this copy. */
    readonly serializedPayload: string;
    readonly senderId: string;
    readonly channel: BrowserTypedChannelPolicy | undefined;
    readonly laneTtlMs: number;
}

export interface ValidateBrowserPeerInput<T> {
    readonly send: RallarWsSendInput<T>;
    /** The room the unicast names; `undefined` for a WS peer send outside a room, whose context is its scope. */
    readonly roomRef: GroupRef | undefined;
}

export interface ValidateBrowserPeerServerInput {
    readonly peerId: string | undefined;
    readonly strategy: BrowserPeerSendStrategy;
    /** The peer id the server named at connect; `undefined` for a server that names none. */
    readonly serverPeerId: string | undefined;
}

/**
 * A send to one peer (Q11) on either carrier: a unicast that names the room it resolved, so the room authority admits
 * it on RTC and on WS, and the WS leg of a fallback is the same envelope (D53, D56). The channel purpose fills what
 * the send left out, with the addressee as the logical audience when a room is named, so a `command` asks the
 * addressee receipt.
 */
export function createBrowserUnicastMessage<T>(
    input: CreateBrowserUnicastMessageInput<T>
): ALMessage {
    const { resolved } = input;
    const send = resolved.input;
    const defaults = toBrowserMessageSendDefaults({
        send,
        channel: input.channel,
        hasLogicalAudience: resolved.roomRef !== undefined,
        laneTtlMs: input.laneTtlMs
    });
    return input.creation.createUnicast(
        input.senderId,
        newALRoute(
            send.topicId ?? send.typeId,
            send.contextId ?? resolved.roomId ?? resolved.scope,
            send.resourceId ?? input.creation.newResourceId()
        ),
        input.peerId,
        send.typeId,
        JSON.parse(input.serializedPayload),
        {
            groupRef: resolved.roomRef,
            ttlMs: defaults.ttlMs,
            reliability: defaults.reliability,
            ack: defaults.ack,
            ownership: send.ownership ?? 'shared',
            qos: defaults.qos
        }
    );
}

/**
 * A peer send names its peer, routes in the room it names and carries no exclusions, no ordering, no snapshot floor
 * and no hop limit: the unicast has no field for them, so they are refused rather than dropped (R-S3c-i-23), and a
 * context naming another room is refused at the sender on every strategy (N1).
 */
export function validateBrowserPeerInput<T>(
    input: ValidateBrowserPeerInput<T>
): readonly RallarValidationIssue[] {
    const { send } = input;
    if (send.peerId === undefined) {
        return [];
    }
    return [
        ...validatePeerId(send.peerId),
        ...validatePeerCarriage(send),
        ...validatePeerContext(send.contextId, input.roomRef)
    ];
}

/**
 * The server is addressed over WS only, and a send whose WS leg needs the server peer id is refused while the server
 * names none (R-S3c-i-32): on `ws`, and on `rtc-with-ws-fallback`, whose second leg is WS.
 */
export function validateBrowserPeerServer(
    input: ValidateBrowserPeerServerInput
): readonly RallarValidationIssue[] {
    if (input.peerId === undefined) {
        return [];
    }
    if (input.strategy !== 'ws' && input.peerId === input.serverPeerId) {
        return [{
            path: '$.peerId',
            code: 'unsupported',
            message:
                'The server is addressed over WS: a peer-addressed send to it takes the ws strategy.'
        }];
    }
    return input.strategy === 'rtc' || input.serverPeerId !== undefined ? [] : [{
        path: '$.peerId',
        code: 'unsupported',
        message:
            'A peer-addressed send needs a server that names its peer id; this server names none.'
    }];
}

function validatePeerId(peerId: string): readonly RallarValidationIssue[] {
    return peerId.length === 0
        ? [{
            path: '$.peerId',
            code: 'missing-peer-id',
            message: 'A peer-addressed send names its peer.'
        }]
        : validateRallarRouteId(peerId, '$.peerId', 'Peer ID').issues;
}

function validatePeerCarriage<T>(send: RallarWsSendInput<T>): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    if (
        send.exceptPeerIds !== undefined || send.orderingKey !== undefined || send.seq !== undefined
    ) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no exclusions and no ordering.'
        });
    }
    if (send.minSnapshotVersion !== undefined || send.ttlHops !== undefined) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no snapshot floor and no hop limit.'
        });
    }
    return issues;
}

function validatePeerContext(
    contextId: string | undefined,
    roomRef: GroupRef | undefined
): readonly RallarValidationIssue[] {
    return roomRef === undefined || contextId === undefined || contextId === roomRef.groupId
        ? []
        : [{
            path: '$.contextId',
            code: 'context-room-mismatch',
            message:
                'A peer-addressed send routes in the room it names: contextId must equal the room id.'
        }];
}
```

- [ ] **Step 5: GREEN, the rules of a peer send whose first leg is RTC.** Create
      `packages/shared-web/browser/messages/validate-browser-rtc-peer-send.ts`:

```ts
import type {
    BrowserMessageInputValidator,
    ResolvedWsMessageInput
} from '@shared-web/browser/messages/browser-message-input-validator.ts';
import {
    validateBrowserPeerInput,
    type BrowserPeerSendStrategy
} from '@shared-web/browser/messages/create-browser-unicast-message.ts';
import type {
    RallarRtcSendInput,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/** The peer send strategies whose first leg is RTC: alone, or with WS inside the deadline (D56). */
export type BrowserRtcPeerSendStrategy = Exclude<BrowserPeerSendStrategy, 'ws'>;

/** A typed send addressed to one peer whose first leg is RTC (Q11). */
export interface BrowserRtcPeerSend<T> {
    readonly send: RallarRtcSendInput<T> & RallarWsSendInput<T>;
    readonly peerId: string;
    readonly strategy: BrowserRtcPeerSendStrategy;
}

export interface ValidateBrowserRtcPeerSendInput<T> {
    readonly peer: BrowserRtcPeerSend<T>;
    /** The send resolved to the room its unicast names: over RTC a peer send always names one. */
    readonly resolved: ResolvedWsMessageInput<T>;
    readonly inputValidator: BrowserMessageInputValidator;
}

/**
 * A peer send over RTC keeps the rules of every peer send and, when it may fall back, the room rules of its WS leg.
 * It carries no scope but its room, no membership fence and no overlay routing: the unicast has no field for them.
 */
export function validateBrowserRtcPeerSend<T>(
    input: ValidateBrowserRtcPeerSendInput<T>
): readonly RallarValidationIssue[] {
    const { peer, resolved } = input;
    return [
        ...validateBrowserPeerInput({ send: peer.send, roomRef: resolved.roomRef }),
        ...(peer.strategy === 'rtc-with-ws-fallback'
            ? input.inputValidator.validateWs(resolved)
            : []),
        ...validateRtcPeerCarriage(peer.send)
    ];
}

function validateRtcPeerCarriage<T>(
    send: BrowserRtcPeerSend<T>['send']
): readonly RallarValidationIssue[] {
    const issues: RallarValidationIssue[] = [];
    if (send.scope !== undefined && send.scope !== 'room') {
        issues.push({
            path: '$.scope',
            code: 'unsupported',
            message: 'A peer-addressed RTC send names its room: its scope is room.'
        });
    }
    if (
        send.membershipEpoch !== undefined || send.nextHopPeerIds !== undefined ||
        send.overlayId !== undefined || send.fanoutLimit !== undefined
    ) {
        issues.push({
            path: '$.peerId',
            code: 'unsupported',
            message: 'A peer-addressed send carries no membership fence and no overlay routing.'
        });
    }
    return issues;
}
```

- [ ] **Step 6: GREEN, the sender takes call lines only.** In
      `packages/shared-web/browser/messages/browser-rallar-message-sender.ts`:

- replace the import at `:30-34` with:

```ts
import {
    createBrowserUnicastMessage,
    validateBrowserPeerInput,
    validateBrowserPeerServer
} from './create-browser-unicast-message.ts';
import {
    validateBrowserRtcPeerSend,
    type BrowserRtcPeerSend
} from './validate-browser-rtc-peer-send.ts';
```

- in `sendWs`, replace `...validateBrowserWsPeerInput(input)` (`:179`) with
  `...validateBrowserPeerInput({ send: input, roomRef })` (the `roomRef` resolved at `:174`, `undefined` outside a
  room), and replace `:184` with:

```ts
throwIfMessageIssues(validateBrowserPeerServer({
    peerId: input.peerId,
    strategy: 'ws',
    serverPeerId: context.middleware.webSocketQueueBox.serverPeerId
}));
```

- in `sendTyped`, replace `:208-214` (the WS-only refusal) with:

```ts
if (input.peerId !== undefined && strategy === 'ws-then-rtc') {
    return throwMessageValidationIssue(
        '$.peerId',
        'unsupported',
        'A peer-addressed typed send takes the ws, rtc or rtc-with-ws-fallback strategy.'
    );
}
if (input.peerId !== undefined && (strategy === 'rtc' || strategy === 'rtc-with-ws-fallback')) {
    return await this.sendRtcPeer({ send: input, peerId: input.peerId, strategy }, channel);
}
```

(a peer send on `ws` still reaches `sendWs` through the unchanged `switch`);

- insert before `private async sendRoomWithFallback<T>(` (`:233`):

```ts
private async sendRtcPeer<T>(
    peer: BrowserRtcPeerSend<T>,
    channel: BrowserTypedChannelPolicy | undefined
): Promise<RallarMessageHandle> {
    const target = this.resolveRtcMessageTarget(peer.send, []);
    const resolved: ResolvedWsMessageInput<T> = {
        input: peer.send,
        scope: 'room',
        roomId: target.roomId,
        roomRef: target.roomRef
    };
    throwIfMessageIssues(validateBrowserRtcPeerSend({ peer, resolved, inputValidator: this.input.inputValidator }));
    const payloadValidation = this.capturePayload(peer.send.payload);
    const context = await this.input.connect();
    throwIfMessageIssues(validateBrowserPeerServer({
        peerId: peer.peerId,
        strategy: peer.strategy,
        serverPeerId: context.middleware.webSocketQueueBox.serverPeerId
    }));
    return this.startDelivery({
        context,
        carrier: 'rtc',
        message: createBrowserUnicastMessage({
            creation: this.input.creation,
            resolved,
            peerId: peer.peerId,
            serializedPayload: payloadValidation.serialized,
            senderId: this.input.requireSession().sessionId,
            channel,
            laneTtlMs: BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS
        }),
        canFallback: peer.strategy === 'rtc-with-ws-fallback',
        payloadIssues: payloadValidation.issues
    });
}
```

`resolveRtcMessageTarget` refuses a send with no room (`missing-room`, `missing-room-ref`), so every RTC peer send
names its room: `groupRef` from `target.roomRef` and `route.contextId` = the room id unless the caller stated the
same id (survey correction 3; C8 refuses any other). `startDelivery` opens the handle with
`carrier: 'rtc'`; the dispatch registers the fallback watch only for `canFallback: true` on an owned verdict and
re-admits the envelope the RTC admission returned on WS (`browser-rallar-message-dispatch.ts:121-128`, `:137-156`);

- in `createWsSendMessage`, replace `:317-321`

```ts
return createBrowserWsUnicastMessage({
    creation: this.input.creation,
    resolved: input.resolved,
    peerId,
    payload: parseCapturedPayload(input.payloadValidation),
```

with

```ts
return createBrowserUnicastMessage({
    creation: this.input.creation,
    resolved: input.resolved,
    peerId,
    serializedPayload: input.payloadValidation.serialized,
```

(`parseCapturedPayload` keeps its other callers, `createWsMessage`, `createRtcMessage` and, until Task 5,
`sendWsUnicast`, and its reviewed
`boundary.unknown` disposition in `scripts/repo-style-check/reviewed-browser-dispositions.mjs:52-60`; the file keeps
exactly its two `unknown` findings).

`sendWsUnicast` (`:115-140`) is untouched: Task 5 deletes it with the director relay change.

- [ ] **Step 7: GREEN, the public doc of `peerId`.** In
      `packages/shared-web/browser/messages/rallar-message-contracts.ts` replace the comment at `:73-77` with (one
      apostrophe, as before):

```ts
/**
 * The one session or server a send addresses; absent, the send reaches its scope. A peer send names the room it
 * resolves and routes in it (a `contextId` naming another room is refused), so the room admits it and asks the
 * peer's receipt under a `command` purpose (D53). A typed `send` carries it on `ws`, `rtc` and
 * `rtc-with-ws-fallback` (the server on `ws` only); it carries no exclusions, no ordering, no snapshot floor and
 * no hop limit, which a unicast cannot honour.
 */
```

`RallarWsSendInput`, `RallarRtcSendInput` and `RallarTypedMessageSendOptions` keep their members (C7).

- [ ] **Step 8: Format and run GREEN.**

```bash
npx dprint fmt \
  packages/shared-web/browser/messages/create-browser-unicast-message.ts \
  packages/shared-web/browser/messages/validate-browser-rtc-peer-send.ts \
  packages/shared-web/browser/messages/browser-rallar-message-sender.ts \
  packages/shared-web/browser/messages/rallar-message-contracts.ts \
  packages/tests/shared/multicast/rtc-room-unicast-dispatch.test.ts \
  packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts \
  packages/tests/shared-web/messages/browser-ws-peer-send.test.ts
npx vitest run \
  packages/tests/shared/multicast/rtc-room-unicast-dispatch.test.ts \
  packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts \
  packages/tests/shared-web/messages/browser-ws-peer-send.test.ts \
  packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts \
  packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts \
  packages/tests/shared-web/messages/browser-typed-message-channels.test.ts \
  packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts \
  packages/tests/shared-web/messages/browser-message-handle-admission.test.ts
```

Expected: PASS, every file (read the summary line), and
`grep -rn --include='*.ts' --exclude-dir=node_modules "create-browser-ws-unicast-message\|BrowserWsUnicast\|BrowserWsPeer" packages apps`
prints nothing.

- [ ] **Step 9: Validate.** Commit nothing yet; the two changed-range checkers read committed trees, so run them on a
      local WIP commit (`git add` the Step 11 list, `git commit -m wip`) and fold it into Step 11 with
      `git reset --soft HEAD~1` afterwards.

  1. `npm run test:unit` — read the summary line (not the exit code).
  2. `npm run typecheck` (it ends with `typecheck:tests`, which checks the new test files against Task 1's
     `evidence.failure` and the `cause` on `receipt-exhausted`).
  3. `npm run check:repo-style:changed -- origin/main HEAD` — expected: no new finding. The rewritten builder is below the rename
     threshold, so git reports a delete and an add; the new file carries no `boundary.unknown`; `validate-browser-rtc-peer-send.ts` measures
     cognitive load 5 and one value export; the sender 40 (tier 50); `packages/shared-web/browser/messages/` goes from
     17 to 18 files (threshold > 20).
  4. `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` — expected: no changed candidate (the
     new tests assert on returned values, recorded admissions and settlements; every `mock.calls` read is assigned to
     a local before its assertion). If it reports one, register it in `docs/test-structure-coupling-exceptions.md` in
     a commit of its own first, as the frame requires.
  5. `npx dprint check` on the seven files of Step 8 and on any bundle file item 7 raises (explicit paths, never a
     glob).
  6. No `packages/shared`, `packages/shared-server` or `packages/shared-test` source changed (the new
     `packages/tests/shared/multicast` file is a test), so the three `deno task check` runs and `npm run test:deno`
     are not required; say so in the handoff.
  7. The change reaches the browser:
     `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
     and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`. The public API snapshot passes
     unchanged (no export name moved in `rallar.ts`, `rallar-core.ts` or `rallar-messages.ts`; the renamed and new
     files are internal). Record the facade and headless figures. If the facade reaches its current ceiling (224 KiB
     unless Tasks 1-3 raised it), raise it to the next whole KiB in
     `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts` and
     `packages/shared-web/scripts/measure-browser-bundles.mjs` (the `browser/rallar.ts` entry's `brotliBudgetKiB` and
     its comment), appending "The S3c-ii RTC unicast and its WS fallback measure <the measured figure> KiB. The next
     whole-KiB ceiling is <N>."; if headless reaches its ceiling (286 KiB unless raised), do the same in
     `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` ("... measure <figure> KiB here. The
     next whole-KiB ceiling is <N>.", and the `toBeLessThan(<N>)`). Write the sentence without an apostrophe (the
     browser bundle-boundaries test holds an `unknown` token at `:21`). Re-run the three tests after a raise.
  8. The storage pins are untouched: `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` passes in
     `npm run test:unit` with unchanged counts (a peer send over RTC is volatile under `command`).

- [ ] **Step 10: The smoke lane (unsandboxed, one lane runner at a time on 18080/5180, no edits while it runs).**

```bash
RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm
```

Expected: the summary line reports every smoke scenario passed. No lane scenario sends to one peer yet (Task 6 adds
`ws-unicast-receipt`, `unicast-fallback` and `server-command`); this run proves the room multicast, the room fallback
and the WS peer send (C8 now at the sender) are unchanged.

- [ ] **Step 11: Commit and push.**

```bash
git add \
  packages/shared-web/browser/messages/create-browser-unicast-message.ts \
  packages/shared-web/browser/messages/validate-browser-rtc-peer-send.ts \
  packages/shared-web/browser/messages/browser-rallar-message-sender.ts \
  packages/shared-web/browser/messages/rallar-message-contracts.ts \
  packages/tests/shared/multicast/rtc-room-unicast-dispatch.test.ts \
  packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts \
  packages/tests/shared-web/messages/browser-ws-peer-send.test.ts
git commit -m "feat(alm): S3c-ii -- a typed send may address one peer over RTC with the WS fallback (Q11, C7, C8, C9)"
git push origin HEAD:codex/queuebox-persistence-qos-product-plan
```

The `git mv` of Step 4 already staged the removal of `create-browser-ws-unicast-message.ts`, so the list does not name
it (`git add` of a removed path fails and stages nothing). Add the bundle files Step 9 raised to the `git add` (and a
coupling registry fix, committed first, if Step 9 needed one). The commit body records the facade and headless figures, that the public API snapshot did not move, that
`web-rtc-overlay-multicast-manager.ts` is unchanged (Step 1 pins the three carrier outcomes), that no persisted shape
changed (`AL_ADMISSION_SCHEMA_ID` stays `'rallar-alm-2026-09-s3c-i'`, C16), and that `ws-then-rtc` with a `peerId`
stays refused (V1).

---

### Task 5: The director command (D60, D75, C10, C12, C15)

**Files:**

- Create: `packages/shared-web/game/rallar-game-intent-sequences.ts`.
- Modify (shared-web): `packages/shared-web/browser/director/browser-director-relay-transport.ts:1-243` (whole file),
  `packages/shared-web/browser/director/browser-director-relay-session.ts:13,26,34,49,63,83-94,152-163,189-235`,
  `packages/shared-web/browser/director/browser-director-relay-runtime.ts:6,17`,
  `packages/shared-web/browser/director/rallar-director-facade.ts:6,71-78,88`,
  `packages/shared-web/browser/composition/browser-product-composition.ts:66-72,144-145,176-189`,
  `packages/shared-web/browser/composition/create-rallar-facade.ts:110-116`,
  `packages/shared-web/browser/messages/browser-rallar-message-sender.ts:97-108,119-144` (after Task 4's import
  lines; review tier: deletions only), `packages/shared-web/browser/calls/browser-call-signal-runtime.ts:1,32-58,132-152`,
  `packages/shared-web/game/envelopes.ts:1,141-191`,
  `packages/shared-web/game/director/rallar-game-director-relay-runtime.ts:13,40,158,166`,
  `packages/shared-web/game/match.ts:131`.
- Modify (harness, the relay's dead `laneId`): `packages/shared-test/rallar-bb-test/schema.ts:328`,
  `packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts:179`,
  `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts:613`,
  `packages/shared-test/rallar-bb-test/control/validate-director-control-command.ts:26`,
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:585`,
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts:196,418`,
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts:178-184`,
  `tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts:441`,
  `examples/director-relay/README.md:30`.
- Modify (AR Eye Hunter): `apps/ar-eye-hunter-v1/src/game/types.ts:11-15`,
  `apps/ar-eye-hunter-v1/src/game/arena-runtime/match/use-arena-match-runtime.ts:117`.
- Modify (ceiling comments; Step 11 appends both measured figures):
  `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts:54-55`,
  `packages/shared-web/scripts/measure-browser-bundles.mjs:44-45`,
  `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts:79-83`.
- Test: create `packages/tests/shared-web/director/director-command-storage-volume.test.ts`; modify
  `packages/tests/shared-web/rallar-game-envelopes.test.ts`,
  `packages/tests/shared-web/rallar-game-match.test.ts:67-76,860-865,1078-1088`,
  `packages/tests/shared-web/rallar-game-director-relay-runtime.test.ts:34-40,114-120`,
  `packages/tests/shared-web/director/browser-director-relay-transport.test.ts`,
  `packages/tests/shared-web/director/browser-director-relay-runtime.test.ts:280-330` (+ six `laneId` lines),
  `packages/tests/shared-web/messages/browser-message-handle-admission.test.ts:15-37,154-169`,
  `packages/tests/shared-web/calls/browser-call-signal-runtime.test.ts:22-24,113-131,180-215`,
  `packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts`,
  `packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts`,
  `packages/tests/ar-eye-hunter-v1/rallarGameMatchAdapter.test.ts`.

**Interfaces:**

- Consumes (Task 4): the typed channel's `send(payload, { peerId, strategy: 'rtc-with-ws-fallback' })` builds one
  room-naming unicast (`targets: { mode: 'unicast', toPeerId, groupRef }`, `route.contextId` = the room id) and hands
  that message, one msgId, to `rtcRxStreamer.enqueueOutboxIfAbsent` first and to
  `webSocketQueueBox.enqueueOutboxIfAbsent` on fallback (`browser-rallar-message-dispatch.ts:206-207`). C9's "server
  unknown" refusal throws a `RallarValidationError` from `send` (the relay does not catch it; AR Eye Hunter's
  `runBestEffortNetworkTask` records it, `use-arena-network-transport-support.ts:87-104`). C8's `contextId` check
  compares against the room the send resolved and does not fire for a `scope: 'all'` peer send, which resolves no room
  (the call signals below rely on this).
- Consumes (Task 1): `ALDeliveryEvidence.failure`, `{ kind: 'refused', reason }` for a refused admission.
- Consumes (Task 3): `createVolatileALOutboundRuntimeStores(options, budget: ALVolatileSessionBudget | undefined)`;
  the storage pin below passes `undefined` (an unbounded pair: it measures IndexedDB operations, not the bound).
- Produces (ledger additions, private to shared-web):
  - `BrowserDirectorRelayTransport.Input { readonly messages: RallarMessagesOperations; readSession(): AuthSession | undefined; }`
    (the fields `createTargetedChannel` and `sendWsUnicast` are deleted).
  - `BrowserDirectorRelayTransport.SendCommandInput<T> { current: RallarDirectorStatus; topicId: string; typeId: string; payload: T }`
    and
    `sendCommand<T>(input: BrowserDirectorRelayTransport.SendCommandInput<T>): Promise<RallarDirectorRelaySendResult>`
    (renamed from `sendIntent`/`SendIntentInput`: it carries intents and sync requests, the two director commands).
  - `RALLAR_GAME_INTENT_SEQUENCE_WINDOW = 1_024` and `class RallarGameIntentSequences` with
    `accept(seq: number): 'duplicate-sequence' | 'stale-sequence' | undefined`, in
    `packages/shared-web/game/rallar-game-intent-sequences.ts` (not re-exported from `game/mod.ts`).
- Produces (public shapes; export names unchanged, so no public API snapshot moves):
  - `RallarDirectorRelaySendResult`: `rtc?: RallarMessageHandle` (was
    `RallarTargetedSendResult | RallarMessageHandle`), `ws?: RallarMessageHandle` unchanged; both are set only by a
    best-effort room envelope (heartbeat, snapshot, output without `ack`). A command (intent, sync request) sets only
    `receipt`: its one carrier-neutral handle. `status: 'sent'` for a command means the director's receipt arrived
    (`lifecycle.state === 'acknowledged'`); everything else is `status: 'failed'` with `receipt` and `reason`.
  - `RallarDirectorRelayConfig.laneId` deleted; `RallarGameDirectorRelayRuntime.Input.laneIds` deleted;
    `CreateBrowserDirectorCompositionInput.realtime` and `BrowserDirectorRelayRuntime.Input.realtime` deleted.
  - `BrowserRallarMessageSender.sendWsUnicast`, `BrowserRallarMessageSender.WsUnicastInput`,
    `BrowserRallarMessageSender.WsUnicastRoute` deleted. `BrowserCallSignalRuntime.Input` loses `sendWsUnicast` and
    its `messages.ws` becomes `Pick<RallarMessagesOperations['ws'], 'onMessage' | 'send'>`;
    `BrowserCallSignalRuntime.SignalSendInput` and `SignalRoute` deleted.
  - The black-box command `director.relay.start` loses its optional `laneId` field (strict schema: a recipe that
    states it is now refused; no recipe, example or golden corpus entry states it).

**Decisions inside this task (applying D60, C10, C12, C15):**

- _What the relay waits for._ `sendCommand` waits for the director's receipt (`until: ['acknowledged']`, bounded by
  the command's own life, `AL_CHANNEL_SEND_DEFAULTS.command.ttlMs` = 30 000). Waiting only for the admitted states, as
  the receipted output does, would resolve at the local volatile admission, before any carrier outcome, so a command
  the server or the director refuses after admission would still read `sent` (correction 11 in another form). The cost
  falls on awaiting callers only: pickup, shot, hit and the peer-ready sync run through `runBestEffortNetworkTask`
  (fire and forget), the diagnostics drawer's sync is a user action whose refresh now means "the director confirmed",
  the black-box `director.intent` command awaits it as its proof (the orchestration spec's 30 000 ms command
  timeout, `full-stack-director-orchestration.spec.ts:458,467`, equals the wait), the awaited match-start intent
  (`use-arena-world-actions.ts:94`) is sent only by the director and takes the local path, `match-support.ts:76`
  (`submitCommand`) hands the promise to its caller unchanged, the RTC-lifecycle peer-ready sync
  (`use-arena-rtc-lifecycle.ts:153`) already runs in a best-effort task, and the one sequencing caller, the
  arena-join sync (`use-arena-match-runtime.ts:117`), becomes a best-effort task so the peer-ready sync never waits
  on it. Each command now holds a live delivery-registry entry until its receipt
  (`BROWSER_DELIVERY_RETENTION.maxEntries` 512): past 512 unconfirmed sends the registry ends the oldest live handles
  `unobservable`, which a fresh-but-silent director reaches after about 24 s at the 632-per-30-s peak; the staleness
  guard normally refuses sends first.
- _`isSuccessfulDirectorDelivery`_ is unchanged and reads only room envelopes (`isALDeliveryAdmitted || superseded`);
  commands never use it.
- _The receive side._ `subscribeToRtcRoomMessages` subscribes the intent and sync-request type ids too (correction
  13). The `realtime.onJson(laneId)` subscription is deleted, and with it the relay's only lane use, so
  `RallarDirectorRelayConfig.laneId` goes (no legacy). The `combat` lane stays for what is not a director command: it
  is `ARENA_RALLAR_GAME_LANE_IDS.intent` (`rallar-game-match-adapter.ts:27`), the game's ordered `rtc-game-intent`
  data channel that carries the peer-shot fallback (`use-arena-combat-actions.ts:91-96`, received at
  `use-arena-match-runtime.ts:142`), the realtime default lane (`main.tsx:31-34`), and one of the lanes the peer-ready
  and RTC lifecycle waits read (`use-arena-match-runtime.ts:123`, `use-arena-rtc-lifecycle.ts:56-62`).
- _C10's bound._ `RALLAR_GAME_INTENT_SEQUENCE_WINDOW = 1_024` sequences per key (room, match, epoch, sender, kind
  `intent`). A command lives 30 s, so a retried or fallback copy reaches the director at most 30 s after its send.
  AR Eye Hunter's fastest intent source is one accepted-shot intent plus at most one hit intent per shot at the 95 ms
  weapon cooldown (`simulation.ts:153`): 2 x 30 000 / 95 = 632 sequences, under 1 024. A sequence older than the
  window cannot be proven new and is refused `stale-sequence`, so memory stays at most 1 024 numbers per key. Keys
  are dropped only by `reset()` at `match.start()` (`rallar-game-match-lifecycle-runtime.ts:41`), so a leaver's and
  every earlier director epoch's intent keys stay for the match's life: at most senders x epochs x 1 024 sequences
  per match (one number per key before).
- _Replay safety of the handlers_ (`accept-arena-match-intent.ts`): a hit replayed more than 1.5 s late is refused
  `stale-hit` (`simulation.ts:817-819`); a pickup replay is refused `pickup-unavailable` once picked
  (`simulation.ts:739-741`); an accepted-shot replay only republishes its visual event (`:65-67`). A hit replayed
  within 1.5 s would apply twice in the handler, so the exact replay (same envelope `seq`) is stopped by the tracker's
  `duplicate-sequence`. Both are pinned.
- _No delivery row in AR Eye Hunter._ The relay's `sent` now is the director's receipt, pinned in shared-web and
  proven end to end by the director orchestration spec and Task 6's `unicast-fallback` scenario; a row would add a
  label (a 12th value export in `to-arena-labels.ts`) for sends the game fires and forgets. None is added.
- _Call signals._ `sendWsUnicast`'s other caller, call signalling, moves to `messages.ws.send({ scope: 'all', peerId,
  topicId, typeId, contextId: callId, payload, reliability: 'best-effort' })`: the same room-free best-effort unicast
  under its call id; its only wire change is an explicit `delivery: { ownership: 'shared', reliability: 'best-effort',
  ack: 'none' }`. One behaviour change: `sendWs` refuses a peer send while the server names no peer id (R-S3c-i-32),
  which `sendWsUnicast` never checked; api-v1 names one, and the PR body says so.

**Corrections found while writing:**

1. `sendWsUnicast` has two callers, not one: the director transport (`browser-product-composition.ts:182`) and call
   signalling (`browser-call-signal-runtime.ts:141`, wired at `browser-product-composition.ts:144-145`). Both move.
2. The transport's `sendIntent` also carries sync requests (`browser-director-relay-session.ts:152-163`), so it is
   renamed `sendCommand`.
3. Survey D1 lists the four `requestSync` sites as "results discarded"; `startAndSyncArenaMatch` awaits the arena-join
   sync before starting the peer-ready sync (`use-arena-match-runtime.ts:117-118`). It becomes a best-effort task.
4. `RallarDirectorRelayConfig.laneId` (`rallar-director-facade.ts:88`) is dead once the targeted leg and the `onJson`
   subscription go, and it is threaded through the black-box `director.relay.start` schema, its validator, its
   normalizer and one Playwright spec (`full-stack-director-orchestration.spec.ts:441`); all go in this task.
5. The hit handler is not idempotent inside 1.5 s (`resolvePlayerHitIntent`, `simulation.ts:801-819`); C10's safety
   for hits rests on the tracker's duplicate refusal, not on the handler.
6. AL inbound dedup is per carrier lane (`al-inbound-message-admission.ts:216-217`), so a command delivered on RTC
   and again on its WS fallback reaches the relay twice; the game tracker drops the copy, a generic relay user (the
   black-box director controller) sees it twice. Task 7's docs state that relay commands are at-least-once.

- [ ] **Step 1: RED -- the director accepts intents out of order (C10).** In
      `packages/tests/shared-web/rallar-game-envelopes.test.ts` add the import
      `import { RALLAR_GAME_INTENT_SEQUENCE_WINDOW } from '@shared-web/game/rallar-game-intent-sequences.ts';` and, after
      "keeps sequences independent per director epoch", add:

```ts
it('accepts a lower intent sequence and refuses an equal one as a duplicate (C10)', () => {
    const tracker = createRallarGameSequenceTracker();
    const intent = (seq: number) =>
        createRallarGameEnvelope({ ...validEnvelope, kind: 'intent', seq });

    expect([5, 3, 5, 3, 4].map((seq) => tracker.accept(intent(seq)))).toMatchObject([
        { accepted: true },
        { accepted: true },
        { accepted: false, reason: 'duplicate-sequence' },
        { accepted: false, reason: 'duplicate-sequence' },
        { accepted: true }
    ]);
    expect(tracker.last(intent(0))).toBe(5);
});

it.each(
    ['capability', 'presence', 'input', 'event', 'snapshot', 'sync-request', 'heartbeat'] as const
)(
    'keeps refusing a lower %s sequence as stale (C10)',
    (kind) => {
        const tracker = createRallarGameSequenceTracker();
        const envelope = (seq: number) => createRallarGameEnvelope({ ...validEnvelope, kind, seq });

        expect(tracker.accept(envelope(5))).toMatchObject({ accepted: true });
        expect(tracker.accept(envelope(3))).toMatchObject({
            accepted: false,
            reason: 'stale-sequence'
        });
    }
);

it('forgets the oldest intent sequence past its window and refuses it as stale, never as new (C10)', () => {
    const tracker = createRallarGameSequenceTracker();
    const intent = (seq: number) =>
        createRallarGameEnvelope({ ...validEnvelope, kind: 'intent', seq });
    for (let seq = 1; seq <= RALLAR_GAME_INTENT_SEQUENCE_WINDOW + 1; seq++) {
        expect(tracker.accept(intent(seq)).accepted).toBe(true);
    }

    expect(tracker.accept(intent(1))).toMatchObject({ accepted: false, reason: 'stale-sequence' });
    expect(tracker.accept(intent(0))).toMatchObject({ accepted: false, reason: 'stale-sequence' });
    expect(tracker.accept(intent(2))).toMatchObject({
        accepted: false,
        reason: 'duplicate-sequence'
    });
});

it('forgets remembered intent sequences on reset', () => {
    const tracker = createRallarGameSequenceTracker();
    const intent = createRallarGameEnvelope({ ...validEnvelope, kind: 'intent', seq: 5 });
    tracker.accept(intent);

    tracker.reset();

    expect(tracker.accept(intent)).toMatchObject({ accepted: true });
});
```

In `packages/tests/shared-web/rallar-game-match.test.ts`:

- in `FakeRallarState.relayConfig` (`:860-865`) replace the `Pick` key list with
  `'topicId' | 'intentTypeId' | 'outputTypeId' | 'snapshotTypeId' | 'syncRequestTypeId' | 'heartbeatTypeId' | 'readSnapshot' | 'onSnapshot' | 'onIntent'`;
- in `createFakeRelayPorts` (`:1078-1088`) delete `laneId: config.laneId,` and add after the `onSnapshot` line:
  `onIntent: config.onIntent as RallarDirectorRelayConfig<ApiJsonValue, ApiJsonValue>['onIntent']` (with a comma
  after the `onSnapshot` entry);
- in "configures the director relay with the game wire topics" (`:67-76`) delete `laneId: 'game-intent',`;
- after "rejects relay snapshots without a configured match identity" add:

```ts
it('routes a relayed intent that arrives out of order and drops its replay (C10)', async () => {
    const fake = createFakeRallar({
        directorPeerId: 'peer-a',
        directorIsFresh: true
    });
    const received: number[] = [];
    const match = createMatch(fake, {
        onIntent: (intent) => {
            received.push(intent.seq);
        }
    });
    await match.start();

    for (const seq of [5, 3, 5, 3, 4]) {
        await emitRelayIntent(fake, seq);
    }

    expect(received).toEqual([5, 3, 4]);
});
```

    with, beside `emitRelaySnapshot`:

```ts
async function emitRelayIntent(fake: FakeRallar, seq: number): Promise<void> {
    const intent = toTestJsonValue(
        envelope({ kind: 'intent', senderId: 'peer-b', payload: { action: `move-${seq}` }, seq })
    ) ?? null;
    await fake.relayConfig?.onIntent?.({
        transport: 'rtc',
        senderId: 'peer-b',
        data: intent,
        envelope: {
            protocol: 'rallar.director.relay.v1',
            topicId: 'game.topic',
            typeId: 'game.topic.intent.v1',
            roomId: 'room-1',
            epoch: 1,
            sentAtEpochMs: 1_000 + seq,
            payload: intent
        },
        receivedAtEpochMs: 1_100 + seq
    }, fake.relay);
}
```

Run: `npx vitest run packages/tests/shared-web/rallar-game-envelopes.test.ts packages/tests/shared-web/rallar-game-match.test.ts`
Expected: FAIL -- the import of `@shared-web/game/rallar-game-intent-sequences.ts` does not resolve, so the envelopes
file fails to load; in the match file `received` is `[5]` (3 and 4 are `stale-sequence` today). The laneId deletion in
the "wire topics" test still passes (`toMatchObject`).

- [ ] **Step 2: GREEN -- the intent sequence window.** Create
      `packages/shared-web/game/rallar-game-intent-sequences.ts`:

```ts
/** Covers every intent one sender can issue within a command's 30 s life, so a retried or fallback copy stays inside it. */
export const RALLAR_GAME_INTENT_SEQUENCE_WINDOW = 1_024;

/** Intents cross two carriers out of order (C10): a lower sequence is new unless seen; past the window it is stale. */
export class RallarGameIntentSequences {
    private readonly seen = new Set<number>();
    private forgottenThrough = -1;

    public accept(seq: number): 'duplicate-sequence' | 'stale-sequence' | undefined {
        if (seq <= this.forgottenThrough) {
            return 'stale-sequence';
        }
        if (this.seen.has(seq)) {
            return 'duplicate-sequence';
        }
        this.seen.add(seq);
        if (this.seen.size > RALLAR_GAME_INTENT_SEQUENCE_WINDOW) {
            this.forgetOldest();
        }
        return undefined;
    }

    private forgetOldest(): void {
        const oldest = Math.min(...this.seen);
        this.seen.delete(oldest);
        this.forgottenThrough = oldest;
    }
}
```

In `packages/shared-web/game/envelopes.ts` add as the first line
`import { RallarGameIntentSequences } from './rallar-game-intent-sequences.ts';` (and a blank line), and replace
`createRallarGameSequenceTracker` (`:141-191`) with:

```ts
export function createRallarGameSequenceTracker(): RallarGameSequenceTracker {
    const lastSeqByKey = new Map<string, number>();
    const intentSequencesByKey = new Map<string, RallarGameIntentSequences>();
    const rejectBySequence = <T>(envelope: RallarGameEnvelope<T>, key: string) =>
        envelope.kind === 'intent'
            ? getIntentSequences(intentSequencesByKey, key).accept(envelope.seq)
            : rejectByOrderedSequence(lastSeqByKey.get(key), envelope.seq);

    return {
        accept<T>(
            envelope: RallarGameEnvelope<T>,
            constraints: RallarGameSequenceAcceptConstraints = {}
        ): RallarGameSequenceAcceptResult<T> {
            const key = sequenceKey(envelope);
            const reason = rejectByConstraints(envelope, constraints) ??
                rejectBySequence(envelope, key);
            if (reason) {
                return { accepted: false, reason, envelope };
            }
            lastSeqByKey.set(key, Math.max(envelope.seq, lastSeqByKey.get(key) ?? envelope.seq));
            return { accepted: true, envelope };
        },
        last(envelope): number | undefined {
            return lastSeqByKey.get(sequenceKey(envelope));
        },
        reset(): void {
            lastSeqByKey.clear();
            intentSequencesByKey.clear();
        }
    };
}

function rejectByOrderedSequence(
    previous: number | undefined,
    seq: number
): 'duplicate-sequence' | 'stale-sequence' | undefined {
    if (previous === undefined || seq > previous) {
        return undefined;
    }
    return seq === previous ? 'duplicate-sequence' : 'stale-sequence';
}

function getIntentSequences(
    byKey: Map<string, RallarGameIntentSequences>,
    key: string
): RallarGameIntentSequences {
    const existing = byKey.get(key);
    if (existing) {
        return existing;
    }
    const created = new RallarGameIntentSequences();
    byKey.set(key, created);
    return created;
}
```

`rejectByConstraints` and `sequenceKey` (`:193-243`) are unchanged; the key still includes the envelope kind, so
the window holds intent sequences only, whatever other kinds share the sender's `nextSequence` counter
(`rallar-game-match-routing-runtime.ts:63`).

Run: `npx vitest run packages/tests/shared-web/rallar-game-envelopes.test.ts packages/tests/shared-web/rallar-game-match.test.ts`
Expected: PASS (read the summary line: every test passed, none skipped).

- [ ] **Step 3: PIN -- AR Eye Hunter's intent handlers are safe for a late replay (C10).** In
      `packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts` add `onTestFinished` to the `vitest` import and, after
      "rejects a current-room %s intent against a retained prior-room snapshot", add:

```ts
it.each(['hit', 'pickup'] as const)(
    'refuses a %s intent replayed 30 s after its acceptance (C10)',
    async (kind) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        await arena.render();
        await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
        const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
        const fixture = acceptedIntentFixture(kind, Date.now());
        await act(async () => arena.current?.publishArenaSnapshot(fixture.snapshot));
        const published: ArenaSnapshot[] = [];
        mockMatch.publishSnapshot.mockImplementation(async (snapshot: ArenaSnapshot) => {
            published.push(snapshot);
            return { status: 'sent' };
        });
        const intent = createRallarGameEnvelope({
            protocol: 'ar-eye-hunter.v1',
            kind: 'intent',
            roomId: 'arena-1',
            senderId: 'peer-1',
            seq: 1,
            directorEpoch: 1,
            sentAtEpochMs: fixture.nowEpochMs,
            payload: fixture.message
        });

        await act(async () => config?.onIntent?.(intent));
        vi.setSystemTime(fixture.nowEpochMs + 30_000);
        await act(async () => config?.onIntent?.(intent));

        expect(published).toHaveLength(1);
        expect(kind === 'hit' ? arena.current?.remotePlayerHits : arena.current?.pickupAcceptances)
            .toHaveLength(1);
        mockMatch.publishSnapshot.mockReset();
    }
);

it('republishes a replayed accepted shot as its visual event only, leaving the arena state unchanged (C10)', async () => {
    await arena.render();
    await waitForState(() => arena.current?.directorAttempt.status === 'not-elected');
    const config = vi.mocked(createArenaRallarGameMatch).mock.calls.at(-1)?.[0];
    await act(async () => arena.current?.publishArenaSnapshot(arenaSnapshot(1)));
    const before = arena.current?.arenaSnapshot;
    const shot: GameRealtimeMessage = {
        protocol: 'ar-eye-hunter.v1',
        kind: 'director-shot-accepted',
        accepted: peerShotMessage(undefined).accepted
    };
    const intent = createRallarGameEnvelope({
        protocol: 'ar-eye-hunter.v1',
        kind: 'intent',
        roomId: 'arena-1',
        senderId: 'peer-1',
        seq: 1,
        directorEpoch: 1,
        sentAtEpochMs: 1_000,
        payload: shot
    });
    mockMatch.publishEvent.mockClear();
    mockMatch.publishSnapshot.mockClear();

    await act(async () => config?.onIntent?.(intent));
    await act(async () => config?.onIntent?.(intent));

    expect(mockMatch.publishEvent.mock.calls.map(([event]) => event)).toEqual([shot, shot]);
    expect(mockMatch.publishSnapshot).not.toHaveBeenCalled();
    expect(arena.current?.arenaSnapshot).toEqual(before);
});
```

The fake `Date` is installed before `render`, because the arena captures `Date.now` as its clock at render
(`use-rallar-arena.ts:219`, the `nowMs: Date.now` handed to `useArenaMatchRuntime`). An exact replay inside 1.5 s is
not a handler case: it carries the same envelope `seq` and Step 1's tracker drops it before `onIntent` (the match pin
in Step 1 covers that path).

Run: `npx vitest run packages/tests/ar-eye-hunter-v1/arena-game-realtime.test.ts`
Expected: PASS -- these pin that today's handlers apply a late replay once (the handler returns no reason, so the pin
does not name which refusal fires), which C10 now relies on (`stale-hit` past 1.5 s,
`pickup-unavailable` once picked, a visual-only accepted shot).

- [ ] **Step 4: RED -- the transport sends a command to the director and reports its receipt (D60, C12).** In
      `packages/tests/shared-web/director/browser-director-relay-transport.test.ts`:

  - in `createTransport` delete the `createTargetedChannel` and `sendWsUnicast` entries (`:177-182`), leaving
    `messages` and `readSession`;
  - after `const envelopeInput = ...` (`:23`) add:

```ts
const clientStatus: RallarDirectorStatus = { ...current, role: 'client', isDirector: false };
const commandInput = {
    current: clientStatus,
    topicId: 'room.director',
    typeId: 'room.director.intent.v1',
    payload: { revision: 7 }
};
```

- after the `describe('director receipt output', ...)` block add:

```ts
describe('director command', () => {
    afterEach(() => vi.useRealTimers());

    it.each(['room.director.intent.v1', 'room.director.sync-request.v1'])(
        'sends %s on its own command channel to the director and reports sent on the director\'s receipt',
        async (typeId) => {
            const command = createMessageDelivery('rtc', {
                kind: 'admitted',
                durable: false,
                queuedAttempts: 1
            }, 'receiver');
            const room = createRoomChannel(async () => command.handle);
            const transport = createTransport(
                createMessageDelivery('rtc', undefined),
                rejectCarrierSend,
                {
                    room: toRoomOperation(room),
                    rtcSend: rejectCarrierSend
                }
            );

            const sending = transport.sendCommand({ ...commandInput, typeId });
            await vi.waitFor(() => expect(room.send).toHaveBeenCalledTimes(1));
            recordDirectorReceipt(command);

            expect(await sending).toEqual({ status: 'sent', receipt: command.handle });
            expect(room.open).toHaveBeenCalledWith({
                topicId: 'room.director',
                typeId,
                roomRef: current.roomRef,
                purpose: 'command'
            });
            expect(room.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    protocol: 'rallar.director.relay.v1',
                    typeId,
                    roomId: 'room',
                    epoch: 1,
                    payload: { revision: 7 }
                }),
                { peerId: 'director', strategy: 'rtc-with-ws-fallback' }
            );
        }
    );

    it('reports a refused command as failed with its typed refusal, never as sent (correction 11)', async () => {
        const command = createMessageDelivery('ws', {
            kind: 'refused',
            reason: 'unsupported',
            detail: 'Server unknown'
        }, 'receiver');
        const transport = createTransport(
            createMessageDelivery('rtc', undefined),
            rejectCarrierSend,
            {
                room: toRoomOperation(createRoomChannel(async () => command.handle)),
                rtcSend: rejectCarrierSend
            }
        );

        expect(await transport.sendCommand(commandInput)).toEqual({
            status: 'failed',
            receipt: command.handle,
            reason: 'Server unknown'
        });
        expect(command.handle.lifecycle().evidence.failure).toEqual({
            kind: 'refused',
            reason: 'unsupported'
        });
    });

    it('reports an admitted command the director never confirms as failed at its deadline', async () => {
        vi.useFakeTimers();
        const command = createMessageDelivery('rtc', {
            kind: 'admitted',
            durable: false,
            queuedAttempts: 1
        }, 'receiver');
        const transport = createTransport(
            createMessageDelivery('rtc', undefined),
            rejectCarrierSend,
            {
                room: toRoomOperation(createRoomChannel(async () => command.handle)),
                rtcSend: rejectCarrierSend
            }
        );

        const sending = transport.sendCommand(commandInput);
        await vi.advanceTimersByTimeAsync(30_000);

        expect(await sending).toEqual({
            status: 'failed',
            receipt: command.handle,
            reason: 'The director did not confirm the command before its deadline.'
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(
        [
            { current: { ...clientStatus, isFresh: false }, status: 'stale-director' },
            { current, status: 'not-director' },
            { current: { ...clientStatus, roomRef: undefined }, status: 'no-director' }
        ] as const
    )(
        'refuses a command to a $status target without opening a channel',
        async ({ current: target, status }) => {
            const transport = createTransport(
                createMessageDelivery('rtc', undefined),
                rejectCarrierSend,
                {
                    room: () => {
                        throw new Error('A refused command must not open a channel.');
                    },
                    rtcSend: rejectCarrierSend
                }
            );

            expect(await transport.sendCommand({ ...commandInput, current: target })).toMatchObject(
                { status }
            );
        }
    );
});

function recordDirectorReceipt(command: MessageDeliveryFixture): void {
    command.registry.record({
        kind: 'acknowledgement',
        carrier: 'rtc',
        msgId: command.handle.msgId,
        atMs: Date.now(),
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: ['director'],
        confirmedRecipientPeerIds: ['director'],
        unconfirmedRecipientPeerIds: [],
        complete: true
    });
}
```

In `packages/tests/shared-web/director/browser-director-relay-runtime.test.ts`:

- add the imports `import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';` (merging
  with the existing `ALMessage` type import) and
  `import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';`;
- replace the test "sends director intents with WS unicast fallback when RTC is not ready" (`:280-330`) with:

```ts
it.each(
    [
        { command: 'intent', typeId: 'game.intent' },
        { command: 'sync request', typeId: 'game.sync-request' }
    ] as const
)(
    'sends a director $command as one room-naming command unicast whose WS fallback keeps its msgId (D60)',
    async ({ command, typeId }) => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now());
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'director-session',
            principalId: 'director-principal',
            epoch: 2,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        mockRtcNoRoute();
        const relay = createRallarFacade().director.createRelay<
            DirectorMove,
            DirectorAcknowledgement
        >({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            syncRequestTypeId: 'game.sync-request',
            heartbeatIntervalMs: 60_000
        });

        const sending = command === 'intent'
            ? relay.sendIntent({ move: 'left' })
            : relay.requestSync({ reason: 'late-join' });
        await vi.advanceTimersByTimeAsync(30_000);
        const result = await sending;
        relay.stop();

        const isCommand = (message: ALMessage) => message.payload.typeId === typeId;
        const rtcCommands = mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls.map(([message]) =>
            message
        ).filter(isCommand);
        const wsCommands = mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls.map((
            [message]
        ) => message).filter(isCommand);
        expect(rtcCommands).toHaveLength(1);
        expect(wsCommands.map((message) => message.id.msgId)).toEqual(
            rtcCommands.map((message) => message.id.msgId)
        );
        expect(wsCommands[0]).toMatchObject({
            id: { msgId: result.receipt?.msgId },
            route: { topicId: 'app.game.director', contextId: 'room-1' },
            targets: {
                mode: 'unicast',
                toPeerId: 'director-session',
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }
            },
            delivery: { reliability: 'at-least-once', ack: 'receiver' }
        });
        // The mocked carriers deliver no receipt, so the command must not read as sent (correction 11).
        expect(result).toMatchObject({
            status: 'failed',
            receipt: expect.objectContaining({ typeId })
        });
        expect(result.rtc).toBeUndefined();
        expect(result.ws).toBeUndefined();
    }
);

it('delivers RTC director commands to the director\'s handlers (correction 13)', async () => {
    const { createRallarFacade } = await import(
        '@shared-web/browser/rallar.ts'
    );
    const rtcInbox = new Map<string, Parameters<typeof mocks.rtcRxStreamer.onInboxMessageDo>[1]>();
    mocks.rtcRxStreamer.onInboxMessageDo.mockImplementation((typeId, callback) => {
        rtcInbox.set(typeId, callback);
        return mocks.ctx.middleware.rtcRxStreamer;
    });
    mockGroupSnapshot(createDirectorGroupSnapshot({
        sessionId: 'session-1',
        principalId: 'principal-1',
        epoch: 3,
        appointedAtEpochMs: Date.now(),
        heartbeatTtlMs: 60_000
    }));
    const facade = createRallarFacade();
    const intents: unknown[] = [];
    const syncRequests: unknown[] = [];
    const relay = facade.director.createRelay<DirectorMove, DirectorAcknowledgement>({
        roomId: 'room-1',
        topicId: 'app.game.director',
        intentTypeId: 'game.intent',
        outputTypeId: 'game.output',
        syncRequestTypeId: 'game.sync-request',
        heartbeatIntervalMs: 60_000,
        onIntent: (message) => {
            intents.push(message.data);
        },
        onSyncRequest: (message) => {
            syncRequests.push(message.data);
        }
    });
    await facade.connect();

    await rtcInbox.get('game.intent')?.onMessage(
        toDirectorCommand('game.intent', { move: 'left' }),
        toResourceEntry('game.intent', {})
    );
    await rtcInbox.get('game.sync-request')?.onMessage(
        toDirectorCommand('game.sync-request', { reason: 'late-join' }),
        toResourceEntry('game.sync-request', {})
    );
    relay.stop();

    expect(intents).toEqual([{ move: 'left' }]);
    expect(syncRequests).toEqual([{ reason: 'late-join' }]);
});
```

- after the replaced block delete the remaining `laneId: 'director',` line of each `createRelay` config (six
  configs, formerly `:349`, `:392`, `:425`, `:464`, `:501`, `:558`); in "falls back to WS when director room RTC
  output has no remote route" replace
  `expect(result.rtc && 'lifecycle' in result.rtc ? result.rtc.lifecycle().state : undefined).toBe('failed');` with
  `expect(result.rtc?.lifecycle().state).toBe('failed');`;
- add beside `mockRtcNoRoute`:

```ts
function toDirectorCommand(typeId: string, payload: object): ALMessage {
    return newALUnicastMessage(
        'session-2',
        newALRoute('app.game.director', 'room-1', `${typeId}-1`),
        'session-1',
        typeId,
        {
            protocol: 'rallar.director.relay.v1',
            topicId: 'app.game.director',
            typeId,
            roomId: 'room-1',
            epoch: 3,
            sentAtEpochMs: Date.now(),
            payload
        },
        { groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' } }
    );
}
```

Run: `npx vitest run packages/tests/shared-web/director/browser-director-relay-transport.test.ts packages/tests/shared-web/director/browser-director-relay-runtime.test.ts`
Expected: FAIL -- `transport.sendCommand is not a function`; the facade send still takes the targeted leg and sends
the WS unicast with no `groupRef` and no receipt; the RTC inbox has no `game.intent` / `game.sync-request` callback,
so `intents` and `syncRequests` are empty.

- [ ] **Step 5: GREEN -- the transport sends commands on two typed `command` channels (D60, C12, C15).** Replace
      `packages/shared-web/browser/director/browser-director-relay-transport.ts` with:

```ts
import type {
    RallarDirectorOutputOptions,
    RallarDirectorRelayEnvelope,
    RallarDirectorRelaySendResult,
    RallarDirectorStatus
} from '@shared-web/browser/director/rallar-director-facade.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    isALDeliveryAdmitted,
    type ALDeliveryLifecycle
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export const RALLAR_DIRECTOR_RELAY_PROTOCOL = 'rallar.director.relay.v1';

const DIRECTOR_COMMAND_UNCONFIRMED_REASON =
    'The director did not confirm the command before its deadline.';

export namespace BrowserDirectorRelayTransport {
    export interface Input {
        readonly messages: RallarMessagesOperations;
        readSession(): AuthSession | undefined;
    }

    /** An intent or a sync request to the appointed director; it counts as sent once the director's receipt arrives. */
    export interface SendCommandInput<T> {
        readonly current: RallarDirectorStatus;
        readonly topicId: string;
        readonly typeId: string;
        readonly payload: T;
    }

    export interface SendRoomEnvelopeInput<T> {
        readonly current: RallarDirectorStatus;
        readonly topicId: string;
        readonly typeId: string;
        readonly payload: T;
        /** Undefined sends best effort; a stated ack asks the frozen room audience for a logical receipt. */
        readonly ack: RallarDirectorOutputOptions['ack'] | undefined;
    }
}

export class BrowserDirectorRelayTransport {
    private readonly input: BrowserDirectorRelayTransport.Input;

    public constructor(input: BrowserDirectorRelayTransport.Input) {
        this.input = input;
    }

    public async sendCommand<T>(
        input: BrowserDirectorRelayTransport.SendCommandInput<T>
    ): Promise<RallarDirectorRelaySendResult> {
        const rejection = this.readCommandRejection(input.current);
        if (rejection) {
            return rejection;
        }
        const { appointment, roomRef } = input.current;
        if (!appointment || !roomRef) {
            throw new Error('Validated director command target is missing.');
        }
        const receipt = await this.input.messages
            .room<RallarDirectorRelayEnvelope<T>>({
                topicId: input.topicId,
                typeId: input.typeId,
                roomRef,
                purpose: 'command'
            })
            .send(createEnvelope(input), {
                peerId: appointment.sessionId,
                strategy: 'rtc-with-ws-fallback'
            });
        const outcome = await receipt.wait({
            until: ['acknowledged'],
            timeoutMs: AL_CHANNEL_SEND_DEFAULTS.command.ttlMs
        });
        return outcome.lifecycle.state === 'acknowledged'
            ? { status: 'sent', receipt }
            : {
                status: 'failed',
                receipt,
                reason: outcome.lifecycle.evidence.reason ?? DIRECTOR_COMMAND_UNCONFIRMED_REASON
            };
    }

    public async sendRoomEnvelope<T>(
        input: BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>
    ): Promise<RallarDirectorRelaySendResult> {
        const rejection = this.readRoomSendRejection(input.current);
        if (rejection) {
            return rejection;
        }
        const roomRef = input.current.roomRef;
        if (!roomRef) {
            throw new Error('Validated director room target is missing.');
        }
        return input.ack === undefined
            ? await this.sendBestEffortRoomEnvelope(input, roomRef)
            : await this.sendReceiptRoomEnvelope(input, roomRef);
    }

    private async sendBestEffortRoomEnvelope<T>(
        input: BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>,
        roomRef: GroupRef
    ): Promise<RallarDirectorRelaySendResult> {
        const message = {
            roomRef,
            topicId: input.topicId,
            typeId: input.typeId,
            payload: createEnvelope(input),
            reliability: 'best-effort' as const,
            ack: 'none' as const,
            ttlMs: 5_000
        };
        const rtc = await this.input.messages.rtc.send(message);
        const rtcOutcome = await rtc.wait({
            until: AL_DELIVERY_ADMITTED_STATES,
            timeoutMs: message.ttlMs
        });
        if (isSuccessfulDirectorDelivery(rtcOutcome.lifecycle)) {
            return { status: 'sent', rtc };
        }
        const ws = await this.input.messages.ws.send(message);
        const wsOutcome = await ws.wait({
            until: AL_DELIVERY_ADMITTED_STATES,
            timeoutMs: message.ttlMs
        });
        return isSuccessfulDirectorDelivery(wsOutcome.lifecycle)
            ? { status: 'sent', rtc, ws }
            : {
                status: 'failed',
                rtc,
                ws,
                reason: wsOutcome.lifecycle.evidence.reason ?? rtcOutcome.lifecycle.evidence.reason
            };
    }

    private async sendReceiptRoomEnvelope<T>(
        input: BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>,
        roomRef: GroupRef
    ): Promise<RallarDirectorRelaySendResult> {
        const ttlMs = BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS;
        const receipt = await this.input.messages
            .room<RallarDirectorRelayEnvelope<T>>({
                topicId: input.topicId,
                typeId: input.typeId,
                roomRef,
                purpose: 'notification'
            })
            .send(createEnvelope(input), {
                strategy: 'rtc-with-ws-fallback',
                reliability: 'at-least-once',
                ack: input.ack,
                ttlMs
            });
        const outcome = await receipt.wait({
            until: AL_DELIVERY_ADMITTED_STATES,
            timeoutMs: ttlMs
        });
        return isSuccessfulDirectorDelivery(outcome.lifecycle)
            ? { status: 'sent', receipt }
            : { status: 'failed', receipt, reason: outcome.lifecycle.evidence.reason };
    }

    private readCommandRejection(
        current: RallarDirectorStatus
    ): RallarDirectorRelaySendResult | undefined {
        if (!this.input.readSession()) {
            return { status: 'no-director', reason: 'Auth session ended.' };
        }
        if (!current.appointment || !current.roomRef || !current.roomId) {
            return {
                status: 'no-director',
                reason: 'No director is appointed for this room.'
            };
        }
        if (!current.isFresh) {
            return {
                status: 'stale-director',
                reason: 'The appointed director is stale or inactive.'
            };
        }
        return current.isDirector
            ? { status: 'not-director', reason: 'The local session is the director.' }
            : undefined;
    }

    private readRoomSendRejection(
        current: RallarDirectorStatus
    ): RallarDirectorRelaySendResult | undefined {
        if (!this.input.readSession()) {
            return { status: 'no-director', reason: 'Auth session ended.' };
        }
        if (!current.appointment || !current.roomRef || !current.roomId) {
            return {
                status: 'no-director',
                reason: 'No director is appointed for this room.'
            };
        }
        return current.isDirector
            ? undefined
            : {
                status: 'not-director',
                reason: 'Only the appointed local director can send director output.'
            };
    }
}

function createEnvelope<T>(
    input:
        | BrowserDirectorRelayTransport.SendCommandInput<T>
        | BrowserDirectorRelayTransport.SendRoomEnvelopeInput<T>
): RallarDirectorRelayEnvelope<T> {
    if (!input.current.appointment || !input.current.roomId) {
        throw new Error('Cannot create director envelope without appointment.');
    }
    return {
        protocol: RALLAR_DIRECTOR_RELAY_PROTOCOL,
        topicId: input.topicId,
        typeId: input.typeId,
        roomId: input.current.roomId,
        epoch: input.current.appointment.epoch,
        sentAtEpochMs: Date.now(),
        payload: input.payload
    };
}

function isSuccessfulDirectorDelivery(lifecycle: ALDeliveryLifecycle): boolean {
    // A newer intent replaced it; falling back over WS would resend stale state.
    return isALDeliveryAdmitted(lifecycle) || lifecycle.state === 'superseded';
}
```

In `packages/shared-web/browser/director/browser-director-relay-session.ts`:

- delete the import `import type { RallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';`
  (`:13`), the constant `DEFAULT_RALLAR_REALTIME_LANE_ID` (`:26`), the input field
  `readonly realtime: RallarRealtimeFacade;` (`:34`), the field `private readonly laneId: string;` (`:49`) and its
  assignment (`:63`);
- replace `sendIntent` (`:83-94`) with:

```ts
public readonly sendIntent = async (
    intent: TIntent
): Promise<RallarDirectorRelaySendResult> => {
    const guarded = this.guardSend();
    return guarded ?? await this.input.transport.sendCommand({
        current: this.status(),
        topicId: this.topicId,
        typeId: this.input.config.intentTypeId,
        payload: intent
    });
};
```

- replace `requestSync` (`:152-163`) with:

```ts
public readonly requestSync = async <TPayload>(
    payload?: TPayload
): Promise<RallarDirectorRelaySendResult> => {
    const guarded = this.guardSend();
    return guarded ?? await this.input.transport.sendCommand({
        current: this.status(),
        topicId: this.topicId,
        typeId: this.syncRequestTypeId,
        payload: payload ?? {}
    });
};
```

- replace `subscribe` and `subscribeToRtcRoomMessages` (`:189-235`) with:

```ts
    private subscribe(): void {
        this.subscriptions.add(this.input.messages.ws.onMessage<RallarDirectorRelayEnvelope>(
            { topicId: this.topicId },
            async (message) => {
                await this.receive({
                    transport: 'ws',
                    senderId: message.senderId,
                    envelope: message.payload
                });
            }
        ));
        this.subscribeToRtcRoomMessages();
    }

    private subscribeToRtcRoomMessages(): void {
        for (
            const typeId of [
                this.input.config.intentTypeId,
                this.syncRequestTypeId,
                this.input.config.outputTypeId,
                this.heartbeatTypeId,
                this.snapshotTypeId
            ]
        ) {
            this.subscriptions.add(
                this.input.messages.rtc.onMessage<RallarDirectorRelayEnvelope>(
                    { topicId: this.topicId, typeId },
                    async (message) => {
                        await this.receive({
                            transport: 'rtc',
                            senderId: message.senderId,
                            envelope: message.payload
                        });
                    }
                )
            );
        }
    }
```

In `packages/shared-web/browser/director/browser-director-relay-runtime.ts` delete the import of
`RallarRealtimeFacade` (`:6`) and the field `readonly realtime: RallarRealtimeFacade;` (`:17`).

In `packages/shared-web/browser/director/rallar-director-facade.ts` delete the import of `RallarTargetedSendResult`
(`:6`), delete `readonly laneId?: string;` from `RallarDirectorRelayConfig` (`:88`), and replace
`RallarDirectorRelaySendResult` (`:71-78`) with:

```ts
export interface RallarDirectorRelaySendResult {
    readonly status: RallarDirectorRelaySendStatus;
    readonly rtc?: RallarMessageHandle;
    readonly ws?: RallarMessageHandle;
    /** The one carrier-neutral handle of a command, or of an output sent with a logical receipt request. */
    readonly receipt?: RallarMessageHandle;
    readonly reason?: string;
}
```

In `packages/shared-web/browser/composition/browser-product-composition.ts` delete the line
`readonly realtime: BrowserRealtimeCoreComposition;` inside `CreateBrowserDirectorCompositionInput` (`:69`; the same
text at `:48` and `:61` stays), and replace the transport and
relay-runtime construction (`:176-189`) with:

```ts
const relayTransport = new BrowserDirectorRelayTransport({
    messages: input.messaging.messages,
    readSession
});
const directorRelays = new BrowserDirectorRelayRuntime({
    status: directorStatus,
    transport: relayTransport,
    messages: input.messaging.messages,
    readSession
});
```

Delete the `realtime,` line of the `createBrowserDirectorComposition({ ... })` calls in
`packages/shared-web/browser/composition/create-rallar-facade.ts:113` and
`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts:181`.

In `packages/shared-web/game/director/rallar-game-director-relay-runtime.ts` delete the import of
`RallarGameLaneIds` (`:13`), the field `readonly laneIds: RallarGameLaneIds;` (`:40`) and the line
`laneId: laneIds.intent,` (`:166`), and change `:158` to `const { config, typeIds } = this.input;`. In
`packages/shared-web/game/match.ts` delete `laneIds: this.laneIds,` from `createDirectorRelayRuntime` (`:131`). In
`packages/tests/shared-web/rallar-game-director-relay-runtime.test.ts` delete the two `laneIds: { ... },` blocks
(`:34-40`, `:114-120`).

Run: `npx vitest run packages/tests/shared-web/director packages/tests/shared-web/rallar-game-director-relay-runtime.test.ts packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-envelopes.test.ts packages/tests/shared-test/rallar-browser-runtime/director.test.ts`
Expected: PASS (summary line: all files passed).

- [ ] **Step 6: The relay names no lane anywhere (no legacy).** Delete these lines, each an exact whole line:

  - `packages/shared-test/rallar-bb-test/schema.ts:328` `laneId: stringSchema,` (in
    `directorRelayConfigProperties`);
  - `packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts:179` `'laneId',` (in
    the `'director.relay.start'` optional list);
  - `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts:613` `laneId?: string;` (in
    `RallarBlackBoxTestDirectorRelayStartCommand`);
  - `packages/shared-test/rallar-bb-test/control/validate-director-control-command.ts:26` `'laneId',` (in
    `RELAY_STRING_FIELDS`);
  - `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:585`
    `readonly laneId?: string;` (in `BlackBoxRallarDirectorRelayStartInput`);
  - `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts:196`
    `laneId: stringValue(record.laneId),` and `:418` `laneId: context.input.laneId,`;
  - `tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts:441`
    `laneId: 'director',`;
  - `examples/director-relay/README.md:30` `laneId: 'director',`.

  Then confirm nothing still names the relay's lane:
  `git grep -n "laneId" -- packages/shared-web/browser/director packages/shared-web/game/director 'packages/shared-test/**/director*' packages/shared-test/rallar-bb-test/schema.ts examples/director-relay tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts`
  Expected: no output.

Run: `npx vitest run packages/tests/shared-test/rallar-browser-runtime/director.test.ts packages/tests/shared-test/rallar-bb-runtime/capabilities.test.ts packages/tests/shared-test/rallar-bb-test-control-client.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts`
Expected: PASS (no fixture or golden corpus entry states `laneId` on `director.relay.start`,
`packages/shared-test/rallar-bb-test/fixtures/schema/v1/golden-compatibility-corpus.json:410-421`).

- [ ] **Step 7: RED -- `sendWsUnicast` has no caller left (C15).** In
      `packages/tests/shared-web/messages/browser-message-handle-admission.test.ts`:

  - in the payload-capture `it.each` (`:15-37`) replace the spy target and the `unicast` branch so the peer send goes
    through the typed send, RTC first:

```ts
const envelope = vi.spyOn(
    fixture.middleware.middleware[path === 'ws' ? 'webSocketQueueBox' : 'rtcRxStreamer'],
    'enqueueOutboxIfAbsent'
);
const sending = path === 'unicast'
    ? fixture.sender.sendTyped({
        typeId: 'app.ready',
        payload,
        peerId: 'peer',
        strategy: 'rtc-with-ws-fallback'
    }, undefined)
    : path === 'fallback'
    ? fixture.sender.sendTyped({ typeId: 'app.ready', payload }, undefined)
    : path === 'rtc'
    ? fixture.sender.sendRtc({ typeId: 'app.ready', payload }, undefined)
    : fixture.sender.sendWs({ typeId: 'app.ready', payload }, undefined);
```

- replace the S3a pin "keeps the director relay's WS unicast purpose-free and best-effort until S3c (D53, D60)"
  (`:154-169`) with:

```ts
it('sends a director command as one room-naming unicast that asks the director\'s receipt (D60, C15)', async () => {
    const fixture = createBrowserMessageSenderFixture();
    const envelope = vi.spyOn(fixture.middleware.middleware.rtcRxStreamer, 'enqueueOutboxIfAbsent');

    await fixture.sender.sendTyped(
        {
            topicId: 'room.director',
            typeId: 'room.director.intent.v1',
            payload: { kind: 'pickup-intent' },
            peerId: 'director',
            strategy: 'rtc-with-ws-fallback'
        },
        { purpose: 'command', durability: undefined }
    );

    const message = envelope.mock.calls[0][0];
    expect(message.targets).toEqual({
        mode: 'unicast',
        toPeerId: 'director',
        groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' }
    });
    expect(message.route).toMatchObject({ topicId: 'room.director', contextId: 'room' });
    expect(message.delivery).toMatchObject({ reliability: 'at-least-once', ack: 'receiver' });
    expect(message.qos?.durability).toEqual({ algo: 'volatile' });
});

it('keeps a call signal a room-free best-effort WS unicast under its call id (C15)', async () => {
    const fixture = createBrowserMessageSenderFixture();
    const envelope = vi.spyOn(
        fixture.middleware.middleware.webSocketQueueBox,
        'enqueueOutboxIfAbsent'
    );

    await fixture.sender.sendWs(
        {
            scope: 'all',
            peerId: 'callee',
            topicId: 'app.rallar.calls',
            typeId: 'app.rallar.calls.invite.v1',
            contextId: 'call-1',
            payload: { kind: 'invite' },
            reliability: 'best-effort'
        },
        undefined
    );

    const message = envelope.mock.calls[0][0];
    expect(message.targets).toEqual({ mode: 'unicast', toPeerId: 'callee' });
    expect(message.route).toMatchObject({ topicId: 'app.rallar.calls', contextId: 'call-1' });
    expect(message.delivery).toEqual({
        ownership: 'shared',
        reliability: 'best-effort',
        ack: 'none'
    });
});
```

In `packages/tests/shared-web/calls/browser-call-signal-runtime.test.ts`:

- add `RallarWsSendInput` to the `rallar-message-contracts.ts` type import and change `CallSignalTestInput.onSend`
  (`:23`) to `readonly onSend?: (input: RallarWsSendInput<unknown>) => void;`;
- in "uses composition time and identity while excluding the sending session" change the array type to
  `const sent: RallarWsSendInput<unknown>[] = [];` and replace the `expect(sent)` assertion with:

```ts
expect(sent).toMatchObject([{
    scope: 'all',
    peerId: 'peer',
    topicId: 'app.rallar.calls',
    typeId: 'app.rallar.calls.invite.v1',
    contextId: 'generated-call',
    reliability: 'best-effort',
    payload: {
        fromPeerId: 'session-1',
        callId: 'generated-call',
        occurredAtEpochMs: 123,
        media: { audio: false, video: true, screen: false }
    }
}]);
```

- in `createDefaultCallSignalRuntime` delete the `sendWsUnicast` entry (`:194-197`), and in `createMessages` replace
  `send: unsupportedCallOperation,` of the `ws` lane with:

```ts
send: async (send) => {
    input.onSend?.(send);
    return createMessageDelivery('ws', undefined).handle;
},
```

Run: `npx vitest run packages/tests/shared-web/messages/browser-message-handle-admission.test.ts packages/tests/shared-web/calls/browser-call-signal-runtime.test.ts`
Expected: FAIL -- the call runtime still calls `this.input.sendWsUnicast`, which the test double no longer provides,
so `invite` rejects with `TypeError: this.input.sendWsUnicast is not a function`. The two new sender pins
and the `unicast` capture case already pass on Task 4's typed peer send; they replace the S3a pin.

- [ ] **Step 8: GREEN -- delete `sendWsUnicast` and move call signals to the WS lane (C15).** In
      `packages/shared-web/browser/calls/browser-call-signal-runtime.ts`:

  - change the first import to
    `import type { RallarMessage } from '@shared-web/browser/messages/rallar-message-contracts.ts';`;
  - delete `SignalRoute` and `SignalSendInput` (`:33-44`) from the namespace, and in `Input` replace
    `readonly messages: { readonly ws: Pick<RallarMessagesOperations['ws'], 'onMessage'>; };` with
    `readonly messages: { readonly ws: Pick<RallarMessagesOperations['ws'], 'onMessage' | 'send'>; };` and delete
    `sendWsUnicast<T>(input: SignalSendInput<T>): Promise<RallarMessageHandle>;` (`:56`);
  - replace `sendSignals` (`:132-152`) with:

```ts
private async sendSignals(
    peerIds: readonly string[],
    payload: RallarCallSignalPayload
): Promise<readonly RallarCallSignalSend[]> {
    const uniquePeerIds = [...new Set(peerIds)]
        .filter((peerId) => peerId !== payload.fromPeerId);
    return await Promise.all(
        uniquePeerIds.map(async (peerId) => ({
            peerId,
            result: await this.input.messages.ws.send({
                scope: 'all',
                peerId,
                topicId: RALLAR_CALL_SIGNAL_TOPIC_ID,
                typeId: toCallSignalTypeId(payload.kind),
                contextId: payload.callId,
                payload,
                reliability: 'best-effort'
            })
        }))
    );
}
```

In `packages/shared-web/browser/composition/browser-product-composition.ts` delete the `sendWsUnicast` entry of the
`BrowserCallSignalRuntime` input (`:144-145`); its `messages: input.messaging.messages` already carries `ws.send`.

In `packages/shared-web/browser/messages/browser-rallar-message-sender.ts` delete `WsUnicastInput` and
`WsUnicastRoute` (`:97-108` after Task 4) and the method `sendWsUnicast` (`:119-144`), each by name. `newALRoute`
stays imported (the broadcast and multicast builders use it).

Then confirm: `git grep -n "sendWsUnicast\|WsUnicastInput\|WsUnicastRoute\|SignalSendInput" -- packages apps tests`
Expected: no output.

Run: `npx vitest run packages/tests/shared-web/messages/browser-message-handle-admission.test.ts packages/tests/shared-web/calls packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts packages/tests/shared-web/messages/browser-typed-message-channels.test.ts`
Expected: PASS.

- [ ] **Step 9: PIN -- a director command costs no IndexedDB write (D60, D87).** The app tests mock the facade
      (`arena-runtime-test-harness.ts:115`), so the pin sends through the real transport, the real typed room channel and
      the real sender into a real outbound runtime whose durable pair is IndexedDB under the operation observer and whose
      volatile pair is memory; the lane choice is the real rule the browser planners state (`shouldPersistOutbox`,
      `al-policy.ts:394`, over the message's normalized QoS). Create
      `packages/tests/shared-web/director/director-command-storage-volume.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { BrowserDirectorRelayTransport } from '@shared-web/browser/director/browser-director-relay-transport.ts';
import type { RallarDirectorStatus } from '@shared-web/browser/director/rallar-director-facade.ts';
import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import type { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { BrowserTypedMessageChannels } from '@shared-web/browser/messages/browser-typed-message-channels.ts';
import type {
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannelDefinition
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { shouldPersistOutbox } from '@shared/al-contracts/al-policy.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/normalize-al-qos-policy.ts';
import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationCounts,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { describe, expect, it, vi } from 'vitest';

import { createDefaultOutboundTestRuntime } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import {
    decodeOutboundTestPayload,
    type OutboundTestPayload
} from '../../shared/alm/outbound-test-payload.ts';
import { createBrowserMessageSenderFixture } from '../messages/browser-message-sender-fixture.ts';

const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

const CLIENT_STATUS: RallarDirectorStatus = {
    roomRef: ROOM_REF,
    roomId: 'room',
    role: 'client',
    state: 'fresh',
    isDirector: false,
    isFresh: true,
    active: true,
    freshness: 'fresh',
    nowEpochMs: 0,
    appointment: {
        version: 1,
        mode: 'appointed-spa',
        sessionId: 'director',
        principalId: 'principal',
        epoch: 1,
        appointedAtEpochMs: 0,
        heartbeatTtlMs: 5_000
    }
};

describe('director command browser storage volume (D60, D87)', () => {
    it('sends a director intent through the real sender in 0 al-admission and 0 non-probe al-work operations', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createIndexedDbOutboundCountStores(observer, 'director-command-volume'),
            volatileStores: createVolatileALOutboundRuntimeStores(
                { decodePrepared: decodeOutboundTestPayload },
                undefined
            ),
            carrier: 'rtc',
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                persist: shouldPersistOutbox(normalizeALQosPolicy(msg).effective),
                preparedMessages: [{ kind: 'send' }]
            }),
            sendPreparedMessage: async () => {
                sent.push('send');
                return { status: 'sent' as const, submissionAttempted: true };
            }
        });
        await runtime.ready();
        observer.reset();
        const fixture = createBrowserMessageSenderFixture();
        const admitted: ALMessage[] = [];
        fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent = async (message) => {
            admitted.push(message);
            return await runtime.enqueueIfAbsent(message);
        };

        const sending = createCommandTransport(fixture.sender).sendCommand({
            current: CLIENT_STATUS,
            topicId: 'room.director',
            typeId: 'room.director.intent.v1',
            payload: { kind: 'pickup-intent' }
        });
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
        const counts = observer.getCounts();
        recordDirectorReceipt(fixture.registry, admitted[0]);

        expect(admitted).toHaveLength(1);
        expect(admitted[0]).toMatchObject({
            targets: { mode: 'unicast', toPeerId: 'director', groupRef: ROOM_REF },
            delivery: { reliability: 'at-least-once', ack: 'receiver' },
            qos: { durability: { algo: 'volatile' } }
        });
        expect(counts.byOwner['al-admission'], 'a director command commits nothing to IndexedDB')
            .toBe(0);
        expect(computeNonProbeWorkOperations(counts), 'no non-probe al-work operation').toBe(0);
        expect(await sending).toMatchObject({ status: 'sent' });
        runtime.dispose();
    });
});

function createCommandTransport(sender: BrowserRallarMessageSender): BrowserDirectorRelayTransport {
    const channels = new BrowserTypedMessageChannels({
        inputValidator: new BrowserMessageInputValidator({ readMaxPayloadBytes: () => 64 * 1024 }),
        sender,
        rtc: { onMessage: () => () => {} },
        ws: { onMessage: () => () => {} }
    });
    return new BrowserDirectorRelayTransport({
        messages: {
            rtc: { send: rejectLaneSend, onMessage: () => () => {} },
            ws: { send: rejectLaneSend, onMessage: () => () => {} },
            channel: <T>(definition: RallarTypedMessageChannelDefinition) =>
                channels.channel<T>(definition),
            room: <T>(definition: RallarRoomMessageChannelDefinition) =>
                channels.room<T>(definition)
        },
        readSession: () => ({
            clientId: 'client',
            sessionId: 'session',
            username: 'user',
            accessToken: 'test',
            expiresAtEpochMs: 60_000
        })
    });
}

async function rejectLaneSend(): Promise<never> {
    throw new Error('A director command travels its typed command channel, never a lane send.');
}

function recordDirectorReceipt(
    registry: ReturnType<typeof createBrowserMessageSenderFixture>['registry'],
    message: ALMessage | undefined
): void {
    if (!message) {
        throw new Error('The director command reached no carrier.');
    }
    registry.record({
        kind: 'acknowledgement',
        carrier: 'rtc',
        msgId: message.id.msgId,
        atMs: Date.now(),
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: ['director'],
        confirmedRecipientPeerIds: ['director'],
        unconfirmedRecipientPeerIds: [],
        complete: true
    });
}

/** The durable pair the count pins observe (`al-indexeddb-operation-counts.test.ts:350-374`), kept private there. */
function createIndexedDbOutboundCountStores(
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

function computeNonProbeWorkOperations(counts: IndexedDbOperationCounts): number {
    return counts.byOwner['al-work'] - (counts.byKind['work-page'] ?? 0) -
        (counts.byKind['work-probe'] ?? 0);
}
```

The count file keeps its own private copy of the two helpers: this task does not touch
`al-indexeddb-operation-counts.test.ts` (Task 3 edits it at `:1-10` and `:238-240`; its pins may only fall, D87).
This is the third private copy of `computeNonProbeWorkOperations` (Task 2 adds the second); a shared count fixture is
a follow-up, not this task.

Run: `npx vitest run packages/tests/shared-web/director/director-command-storage-volume.test.ts`
Expected: PASS -- zero `al-admission` and zero non-probe `al-work` operations; the command settles `sent` on the
recorded receipt. (Before Step 5 this file fails: `sendCommand` does not exist.)

- [ ] **Step 10: AR Eye Hunter -- delete the unused type ids, pin the command channel ids, and stop the join sync from
      holding the peer-ready sync.** In `apps/ar-eye-hunter-v1/src/game/types.ts` delete the five unused constants
      `GAME_DIRECTOR_INTENT_TYPE_ID`, `GAME_DIRECTOR_OUTPUT_TYPE_ID`, `GAME_DIRECTOR_HEARTBEAT_TYPE_ID`,
      `GAME_DIRECTOR_SNAPSHOT_TYPE_ID`, `GAME_DIRECTOR_SYNC_REQUEST_TYPE_ID` (`:11-15`; `git grep` finds no reader). The
      match adapter keeps deriving its ids from `GAME_DIRECTOR_TOPIC_ID` (`rallar-game-match-adapter.ts:64-82`, no
      `typeIds`), so the two command channels are `room.ar-eye-hunter.director.intent.v1` and `.sync-request.v1` (C12).

  In `apps/ar-eye-hunter-v1/src/game/arena-runtime/match/use-arena-match-runtime.ts` replace
  `await session.match.requestSync({ reason: 'arena-join' });` (`:117`) with:

```ts
session.input.runBestEffortNetworkTask(
    () => session.match.requestSync({ reason: 'arena-join' }),
    session.generation
);
```

In `packages/tests/ar-eye-hunter-v1/rallarGameMatchAdapter.test.ts` add
`import { resolveRallarGameTypeIds } from '@shared-web/game/match.ts';` and, after "uses room-scoped topics for
production WS fallback compatibility", add:

```ts
it('sends director intents and sync requests on the two derived command channel ids (C12)', () => {
    expect(resolveRallarGameTypeIds(GAME_DIRECTOR_TOPIC_ID)).toMatchObject({
        intent: 'room.ar-eye-hunter.director.intent.v1',
        syncRequest: 'room.ar-eye-hunter.director.sync-request.v1'
    });
});
```

In `packages/tests/ar-eye-hunter-v1/arena-director-delivery.test.ts` add `type RallarGameSendResult` to the
`@shared-web/game/mod.ts` import and, after "requests solo arena sync immediately after director appointment
without waiting for RTC lanes", add:

```ts
it('starts the peer-ready sync while the director has not yet confirmed the join sync (D60)', async () => {
    const joinSync = Promise.withResolvers<RallarGameSendResult>();
    mockMatch.requestSync.mockReturnValueOnce(joinSync.promise);

    await arena.render();

    await vi.waitFor(() =>
        expect(mockMatch.waitForReadyLanes).toHaveBeenCalledWith(
            expect.objectContaining({ expect: { min: 0 }, timeoutMs: 650 })
        )
    );
    expect(mockMatch.requestSync).toHaveBeenCalledWith({ reason: 'arena-join' });
    await act(async () => {
        joinSync.resolve({ status: 'sent', transport: 'director-relay' });
        await joinSync.promise;
    });
});
```

(`{ min: 0 }` with 650 ms is the peer-ready wait's own call, `use-arena-match-runtime.ts:122-126`; the RTC lifecycle
wait asks `{ min: 1 }`.)

Run: `npx vitest run packages/tests/ar-eye-hunter-v1`
Expected: PASS; before the `use-arena-match-runtime.ts` change the new delivery test fails (the peer-ready wait is
never called while the join sync is pending).

- [ ] **Step 11: Measure the bundles.** The facade loses `sendWsUnicast` and the director's targeted leg and gains two
      RTC subscriptions and the receipt wait; the headless bundle also loses the controller's `laneId` path.

Run: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` and
`npx vitest run packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
Expected: PASS with each figure under its current ceiling (read it first: 224 KiB facade and 286 KiB headless
unless Tasks 1-4 raised them); the public API snapshots do not move (no export name changes). Record both brotli
figures: append to the end of the `browser/rallar.ts` entry's comment in `shared-web-browser-bundle-boundaries.test.ts`
and, duplicated, in `measure-browser-bundles.mjs` the sentence `The S3c-ii director command (the typed command
channels, the intent sequence window, sendWsUnicast deleted) measures <facade figure> KiB.` and to the end of the
headless comment (above `toBeLessThan` in `headless-bundle-boundary.test.ts`) `The S3c-ii director command measures
<headless figure> KiB here.` with the measured figures written in full. If a figure crosses its ceiling, raise that ceiling to the next whole KiB in the same places (maintainer ruling) and say so in the commit
body. A figure that falls leaves its ceiling where it is.

- [ ] **Step 12: Validate.** Run, reading each summary line (not the exit code):

  - `npx vitest run packages/tests/shared-web/director packages/tests/shared-web/rallar-game-envelopes.test.ts packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-director-relay-runtime.test.ts packages/tests/shared-web/messages/browser-message-handle-admission.test.ts packages/tests/shared-web/calls packages/tests/ar-eye-hunter-v1 packages/tests/shared-test/rallar-browser-runtime/director.test.ts`
    -- all pass;
  - `npm run test:unit` -- all pass (a sandbox port-bind failure is rerun unsandboxed before it is read as a result);
  - `npm run typecheck`, `npm --workspace ar-eye-hunter-v1 run build`, `node scripts/check-tests-typecheck.mjs` (the
    tests ratchet over `packages/tests`, which the root `tsc` excludes);
  - `npm run check:repo-style:changed -- origin/main HEAD` and
    `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` (the touched test files
    `browser-message-handle-admission.test.ts` and `browser-director-relay-runtime.test.ts` gate their registered
    candidates, and this task adds `mock-invocation-count-or-order` candidates in
    `browser-director-relay-transport.test.ts` (`toHaveBeenCalledTimes(1)`) and `arena-game-realtime.test.ts`
    (`.not.toHaveBeenCalled()`, `.mock.calls` `toEqual`); classify each and commit the registry fix first);
  - `npx dprint check` over every file this task touched, listed explicitly (never a glob);
  - `packages/shared-test` changed: `cd apps/api-v1 && deno task check`, `cd apps/rallar-black-box-control-server &&
    deno task check`, `cd apps/relic-hunter-server-v1 && deno task check`, then `npm run test:deno`;
  - the browser gates of Step 11;
  - `npm run test:repo-governance` (`examples/director-relay/README.md` changed);
  - unsandboxed, one lane runner at a time, no edits while it runs: the director orchestration spec, the only
    end-to-end run of relay intents and sync requests against the real API-v1 and browsers,
    `RALLAR_BLACK_BOX_FULL_STACK=1 RALLAR_BLACK_BOX_API_MODE=memory VITE_RALLAR_API_BASE_URL=http://localhost:18080 VITE_RALLAR_SPA_BASE_URL=http://localhost:5177 npx playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts`
    -- 1 passed (B's and C's intents reach A as `rallar.browser.director.intent_received`, now over the command
    channel, and each `director.intent` / `director.sync.request` returns only after A's receipt);
  - then the smoke lane `RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm` -- passes.

  No server database mutation and no `ws-queue-box-server` change: the medium-scale gate runs in CI only.

- [ ] **Step 13: Commit and push.**

```bash
git add packages/shared-web/browser/director packages/shared-web/browser/composition/browser-product-composition.ts \
  packages/shared-web/browser/composition/create-rallar-facade.ts \
  packages/shared-web/browser/messages/browser-rallar-message-sender.ts \
  packages/shared-web/browser/calls/browser-call-signal-runtime.ts packages/shared-web/game/envelopes.ts \
  packages/shared-web/game/rallar-game-intent-sequences.ts packages/shared-web/game/director/rallar-game-director-relay-runtime.ts \
  packages/shared-web/game/match.ts packages/shared-web/scripts/measure-browser-bundles.mjs \
  packages/shared-test/rallar-bb-test/schema.ts packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts \
  packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts \
  packages/shared-test/rallar-bb-test/control/validate-director-control-command.ts \
  packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts \
  packages/shared-test/black-box-runner/browser/rallar-browser-runtime/director-controller.ts \
  packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts \
  tests/playwright/rallar-black-box/full-stack-director-orchestration.spec.ts examples/director-relay/README.md \
  apps/ar-eye-hunter-v1/src/game/types.ts apps/ar-eye-hunter-v1/src/game/arena-runtime/match/use-arena-match-runtime.ts \
  packages/tests/shared-web/director packages/tests/shared-web/rallar-game-envelopes.test.ts \
  packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-director-relay-runtime.test.ts \
  packages/tests/shared-web/messages/browser-message-handle-admission.test.ts \
  packages/tests/shared-web/calls/browser-call-signal-runtime.test.ts packages/tests/ar-eye-hunter-v1 \
  packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts \
  packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
git commit -m "feat(director): S3c-ii -- intents and sync requests travel command channels to the director with its receipt (D60, D75, C10, C12, C15)"
git push origin HEAD:codex/queuebox-persistence-qos-product-plan
```

The commit body lists: the relay reports `sent` only on the director's receipt; the realtime targeted leg,
`sendWsUnicast` and the relay's `laneId` (facade config, black-box `director.relay.start` field) are deleted; call
signals ride `messages.ws.send`; the director accepts out-of-order intents inside a 1 024-sequence window; the new
storage pin (a director command: 0 `al-admission`, 0 non-probe `al-work` operations); both bundle figures.

---

### Task 6: The lane scenarios and the hosted manifests (C11)

**Files:**

- Create:
  - `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/ws-unicast-receipt.ts`,
    `scenarios/unicast-fallback.ts`, `scenarios/server-command.ts`, `scenarios/capacity.ts` (`scenarios/` goes from
    14 to 18 files; `conformance/alm/` itself holds 20 and takes none)
  - `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/resolve-black-box-rallar-message-peer.ts`
  - `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts`
- Modify (harness contract, the six registries of a new `messages.send` field):
  - `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts:313-333` (`toPeer`)
  - `packages/shared-test/rallar-bb-test/schema/rallar-black-box-command-fields.ts:97-116,280-299`
  - `packages/shared-test/rallar-bb-test/schema.ts:598-616`
  - `packages/shared-test/rallar-bb-test/alm/validate-alm-control-command.ts:80-104`
  - `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts:8-104`
  - `packages/shared-test/rallar-bb-test/fixtures/schema/v1/golden-compatibility-corpus.json` (after `:152`, and the
    end of `invalidRecipes`)
  - `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md:150-162,186-190,340-370,405-440`,
    `packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md` (one upgrade note appended)
- Modify (the observation's `carrierFallback`):
  - `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts:40-51`
  - `packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts:1-9,125-160,276`
  - `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:76-114,281-302,361-376`
- Modify (the page):
  - `.../rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts:22-57,92-112`
  - `.../rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts:1-68,86-120,227-238`
  - `.../rallar-browser-runtime/messaging/black-box-rallar-typed-channels.ts:1-25,49-60,93-104`
  - `.../rallar-browser-runtime/messaging/black-box-rallar-delivery-error-message-prefixes.ts:6-13`
  - `packages/shared-test/rallar-bb-test/alm/browser-adapter-alm-commands.ts:115-133` (two call lines; 541 lines)
  - `.../rallar-browser-runtime/decode-black-box-rallar-connection-config.ts:1-5,125-170`
  - `.../rallar-browser-runtime/browser-rallar-runtime-composition.ts:1-126,166-224,278-344`
  - `.../rallar-browser-runtime/black-box-rallar-runtime.ts:1-10,72-88`
  - `.../rallar-browser-runtime/connection/black-box-rallar-connection-runtime.ts:73-83,100-109,282-326,370-418`
  - `.../rallar-browser-runtime/connection/black-box-rallar-connect-operation.ts:52-66,168-172` (call lines only)
  - `.../rallar-browser-runtime/connection/black-box-rallar-crdt-live-connection.ts:14-23,63-67` (call lines only)
  - `.../rallar-browser-runtime/connection/configure-black-box-rallar-connection.ts:1-22`
- Modify (the lane and the hosted manifests):
  - `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts:18-32`
  - `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts:30-43,75-90`
  - `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-message-commands.ts:26-36,246`
  - `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:37-87`
  - `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json` (regenerated; 22 is unchanged: every
    new scenario runs on two agents)
  - `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts:21,56,112-180,183-186,254-257,305-320` (the
    addressed family, R-S3c-ii-5)
- Test:
  - create `packages/tests/shared-test/alm-conformance-addressed-scenarios.test.ts`,
    `packages/tests/shared-test/rallar-browser-runtime/resolve-black-box-rallar-message-peer.test.ts`
  - modify `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts:224-255,508-531,915-1016`,
    `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts:1-55,82-98,493-510` (three cases appended
    after `:510`),
    `packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts:1-36,185-200,345-406,457-480`,
    `packages/tests/shared-test/rallar-browser-runtime/browser-rallar-runtime-test-harness.ts:118-130`,
    `packages/tests/shared-test/rallar-browser-runtime/connection.test.ts` (one case appended),
    `packages/tests/shared-test/rallar-browser-runtime/composition.test.ts:60,93`,
    `packages/tests/rallar-black-box/browser-rallar-runtime.test.ts:56`,
    `packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts:26-66`,
    `packages/tests/shared-web/composition/browser-runtime-construction.test.ts:71-99`,
    `packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts:555-575`,
    `packages/tests/rallar-black-box/live-rtc-control-client.test.ts:212,324,435,502,698,763`,
    `packages/tests/shared-test/alm-conformance-recipes.test.ts:116-157,247-272,326-375`,
    `packages/tests/shared-test/alm-conformance-recipe-validation.test.ts:20-68`,
    `packages/tests/shared-test/alm-lifecycle-recipes.test.ts:116`,
    `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts:1146-1220`,
    `packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts:59-95`,
    `packages/tests/rallar-black-box/alm-reload-manifest.test.ts:20-37`,
    `apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts:28-51,121-196,251-330,470-520`,
    `apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts:87-88,120-127,388-411`,
    and, only if the measure crosses it, `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`;
    only if Step 28's coupling check names a candidate, `docs/test-structure-coupling-exceptions.md`

**Interfaces:**

- Consumes:
  - Task 1: `ALDeliveryEvidence.failure: ALDeliveryFailure | undefined`, carried on
    `BlackBoxRallarDeliveryObservation.failure` and `RallarBlackBoxTestMessagesObserveResultValue.failure` and decoded
    by `decodeAlmDeliveryResultValue`; a refused admission reads `{ kind: 'refused', reason: 'capacity' }`.
  - Task 3: `ALVolatileSessionLimits`, `AL_VOLATILE_SESSION_MAX_ADMISSIONS`, `AL_VOLATILE_SESSION_MAX_BYTES` from
    `@shared/alm/volatile-budget/al-volatile-session-budget.ts`; `computeALMessageEnvelopeBytes(value: unknown,
    byteLimits: ALMessageByteLimits): Either<ALMessageResourceIssue, number>` (C17); the seam
    `readVolatileSessionLimits: (() => ALVolatileSessionLimits) | undefined` on
    `CreateBrowserSessionCoreCompositionInput` (beside `qosProvider`) and on `MiddlewareInitOptions`, read once per
    session initialisation; the outbound `capacity` refusal ending the handle `rejected` with no fallback (C1, C6).
  - Task 4: `RallarTypedMessageSendOptions.peerId` accepted for `ws`, `rtc` and `rtc-with-ws-fallback`; a peer send to
    `serverPeerId()` refused on the two RTC strategies (C9).
- Produces (names this task adds; none is a product export):
  - `RallarBlackBoxTestMessagesSendCommand.toPeer?: 'server' | 'receiver'`;
    `RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesToPeer: readonly ['server', 'receiver']`;
    `BlackBoxRallarMessageSendInput.toPeer: 'server' | 'receiver' | undefined`.
  - `export function resolveBlackBoxRallarMessagePeer(input: ResolveBlackBoxRallarMessagePeerInput): Either<string, string>`
    (`messaging/resolve-black-box-rallar-message-peer.ts`).
  - `export interface BlackBoxBrowserPeersDependency extends Pick<RallarConnectionOperations, 'serverPeerId' | 'session'>
    { readRoomSessions(roomRef: GroupRef): readonly GroupPresenceSession[] | undefined; }` and
    `BlackBoxBrowserRallarRuntimeDependency.peers` (`browser-rallar-runtime-composition.ts`).
  - `BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.peerUnresolved = 'Message peer unresolved'`, result code
    `RALLAR_BLACK_BOX_ALM_PEER_UNRESOLVED`.
  - `BlackBoxRallarConfig.almVolatileLimits?: ALVolatileSessionLimits` (decoded from `rtc.connect.rallar`);
    `export class BlackBoxRallarVolatileLimits { get: () => ALVolatileSessionLimits; set(config): void }`;
    `export function createBlackBoxBrowserRallarRuntimeDependency(input: CreateBlackBoxBrowserRallarRuntimeDependencyInput)`
    with `CreateBlackBoxBrowserRallarRuntimeDependencyInput { readVolatileSessionLimits: () => ALVolatileSessionLimits }`;
    `BlackBoxRallarConnectionRuntime.Input.volatileLimits`.
  - `carrierFallback: ALDeliveryCarrierFallback | undefined` on `BlackBoxRallarDeliveryObservation` and
    `RallarBlackBoxTestMessagesObserveResultValue` (a `Pick` of `ALDeliveryEvidence`, no new type name).
  - `toAddresseeReceiptAssertions(sender: AlmConformanceStepInput, resultName: string): readonly RallarBlackBoxTestCommand[]`
    in `alm-conformance-message-commands.ts`; `AlmConformanceSendDelivery.toPeer`.
  - `AlmConformanceScenarioId` members `'capacity' | 'server-command' | 'unicast-fallback' | 'ws-unicast-receipt'`,
    registered after `noFallbackAfterDeadline` and before `...receiptedAudience`.

**What this task decides (inside C11), and why:**

- **How the page learns a peer.** `server` reads `rallar.serverPeerId()` (`rallar-connection-facade.ts:136`), learned
  from `/api/config`. `receiver` reads the connection room's cached roster,
  `roomStateStore.findGroupSnapshot(roomRef)?.activeSessions` (`rooms/room-state-store.ts:146-153`), keeps the
  sessions that are `active` with an unexpired lease, drops the page's own session (`rallar.session()?.sessionId`),
  and resolves only when exactly one remains. The connect config's `rallar.peerIds` cannot serve: a recipe is written
  before any session exists. The roster is keyed by session, not principal, because hosted agents may all log in as
  one user (`scripts/hosted-rallar/controller/09-start-headless-workers.sh:121-124`).
- **`recipient-b` is not a value.** The roster (`GroupPresenceSession`, `packages/shared/api/group-types.ts:209-236`)
  names no role, the lane starts both recipients of a three-agent run in parallel
  (`tests/playwright/rallar-black-box/full-stack-three-agent-run.ts:70-73`) and hosted agents may share a principal,
  so nothing the page holds tells `receiver` from `recipient-b`. `toPeer` is `'server' | 'receiver'` and the four
  scenarios run on two agents (see "Corrections found while writing", item 1). On two agents a room send asking
  `receiver` yields the same lane evidence as a peer send (its frozen audience is the one receiver), so
  `ws-unicast-receipt` and `unicast-fallback` prove the addressed path end to end but would not fail if the page
  dropped `toPeer`; the Step 7 delivery case and `server-command`'s absence window are what pin the addressing.
- **An unresolvable role is a typed command failure.** The resolver returns an `Either`; the ledger turns its Left
  into the page's own failure `Message peer unresolved: …`, which the browser adapter classifies as
  `RALLAR_BLACK_BOX_ALM_PEER_UNRESOLVED` (the page's failures cross `page.evaluate` only as prefixed errors,
  `black-box-rallar-delivery-error-message-prefixes.ts:1-5`, the channel a replay the page cannot perform already
  uses). No handle opens and the product is never called.
- **Purpose.** A `toPeer` send opens its typed channel with `purpose: 'command'`; a room send keeps `'notification'`.
  The purpose fills only what the send leaves out (`to-browser-message-send-defaults.ts:30-57`), and a product
  addresses one peer as a `command` (the WS peer send "asks the peer's receipt under a `command` purpose",
  `rallar-message-contracts.ts:73-77`; C12's director channels), so the lane exercises that shape. Every recipe still
  states its `ack`, and for one addressee `receiver` and `all-logical-recipients` are one algorithm (D41).
- **The lowered bound.** A session reads its limits once, when it initialises, and the facade reuses its middleware
  across connects (`session/session-connection-lifecycle.ts:80-84`), so the `capacity` sender closes, reconnects with
  `rallar.almVolatileLimits`, and closes and reconnects again without it before the next scenario. The connection
  state is written only after `rallar.connect` (`connection/black-box-rallar-connect-operation.ts:133-142` vs `:185`),
  so the reader cannot read it; a holder the connect sets before it connects is the read port.
- **Bytes decide the lowered bound.** C4 counts received data admissions too, so a count bound of 2 would be decided
  by whatever the session happened to receive. The lane keeps `maxAdmissions` at the constant and lowers `maxBytes`
  to 128 KiB against ≈45.6 KB sends: two fit with ≈39 KB to spare for the session's other admissions, a third never
  fits (45 000 × 3 > 131 072 before any envelope overhead).
- **`server-command` runs on `ws` only.** The server is no RTC peer; on `rtc` and `rtc-with-ws-fallback` a send
  addressed to it is refused before admission (C9), a sender-side verdict Task 4 pins. An RTC cell would restate that
  unit pin through a whole scenario window.
- **Smoke gains none of the four.** The hosted smoke job has 30 minutes on slow runners; all four are `FULL_TAGS`.
- **Wall time.** Absence windows are the floor. Of the four, only `server-command` holds one (17 s: that nothing
  reaches the member is its claim). The others' receivers prove a presence: a second copy after a hand-over is S3b's
  `fallback-within-deadline` pin on the same fallback controller, and a refused send is never submitted, which
  `attempts equals 0` proves. The lane's widest cell (`rtc-with-ws-fallback`, two agents, measured 7.0–7.1 min of the
  fixed 8 min `CARRIER_TEST_TIMEOUT_MS`) would gain three scenarios without a window, ≈33-39 s at its own measured
  11-13 s of other work per scenario, to ≈460-465 s before `capacity`'s two extra close-and-reconnect cycles: at the
  edge of the budget, with ≈15 s to spare at best. So the four addressed scenarios run as their own two-agent family,
  `addressed`, one test per carrier under the same fixed budget (R-S3c-ii-5, Step 26), and the baseline two-agent
  test's wall time does not grow; Step 30 measures both. Manifest 18's 31 blocks already hold 513 s of
  absence windows, so its 300 s never held; with 39 blocks the floor is 530 s and the run ≈1 100 s, so
  `recommendedTerminalTimeoutSeconds` rises to 1 200 (Step 21).

- [ ] **Step 1: RED — `toPeer` in the recipe contract.** In
      `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`, rename the case at `:224` to
      `'rejects the supersedence key and a literal peer id, which no recipe knows when it is written'` (its body is
      unchanged: `key` and `toPeerId` stay refused), and add after it:

```ts
it('accepts a lane role on messages.send, and refuses an unknown role and a role beside a replay (C11)', () => {
    const send = {
        kind: 'messages.send',
        commandId: 'send-to-peer',
        carrier: 'rtc',
        typeId: 'alm.conformance',
        payload: { n: 1 }
    };
    for (const toPeer of ['server', 'receiver']) {
        const schemaResult = validateJsonSchema(
            RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
            recipeWithCommand(`send-${toPeer}`, { ...send, toPeer })
        );
        expect(schemaResult.ok, toPeer).toBe(true);
        expect(validateRallarBlackBoxTestCommand({ ...send, toPeer }).ok, toPeer).toBe(true);
    }

    const unknownRole = validateJsonSchema(
        RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
        recipeWithCommand('send-recipient-b', { ...send, toPeer: 'recipient-b' })
    );
    expect(unknownRole.ok).toBe(false);
    if (!unknownRole.ok) {
        expect(formatJsonSchemaValidationErrors(unknownRole.errors))
            .toContain('toPeer: Expected one of "server", "receiver".');
    }
    const refusedRole = validateRallarBlackBoxTestCommand({ ...send, toPeer: 'recipient-b' });
    expect(refusedRole.ok).toBe(false);
    if (!refusedRole.ok) {
        expect(refusedRole.messages).toEqual([
            'messages.send.toPeer must be one of server, receiver.'
        ]);
    }
    const replay = validateRallarBlackBoxTestCommand({
        kind: 'messages.send',
        commandId: 'send-replay-to-peer',
        replayOnCarrier: { handleId: 'h-1', carrier: 'ws' },
        toPeer: 'receiver'
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
        expect(replay.messages).toEqual([
            'messages.send.toPeer is not allowed on a replay; a replay names only connection and replayOnCarrier.'
        ]);
    }
});
```

    In the case `'classifies the page runtime rejections by their exported message prefixes'` (`:979`) add to
    `cases`, before the `alm-receipts-bad-input` entry:

```ts
{
    commandId: 'alm-receipts-peer-unresolved',
    message: `${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.peerUnresolved}: messages.send.toPeer ` +
        'receiver names no peer: the room holds 2 other live sessions, not exactly one.',
    code: 'RALLAR_BLACK_BOX_ALM_PEER_UNRESOLVED'
},
```

    In the `it.each` at `:918` add the rows

```ts
{ field: 'carrierFallback', value: { from: 'rtc', to: 'ws', reason: 'deadline', atMs: 5, detail: 'x' } },
{ field: 'carrierFallback', value: { from: 'server', to: 'ws', reason: 'not-ready', atMs: 5, detail: 'x' } },
{ field: 'carrierFallback', value: { from: 'rtc', to: 'ws', reason: 'not-ready' } }
```

    and after the case `'reads a trusted server\'s refusal before admission …'` (`:508-531`) add:

```ts
it('reads the hand-over to the fallback carrier from a delivery observation (D56)', async () => {
    const carrierFallback = {
        from: 'rtc',
        to: 'ws',
        reason: 'not-ready',
        atMs: 5,
        detail: 'three not-ready'
    } as const;
    const runtime = createRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createAlmBrowserRuntimeFake(createAlmRuntimeCaptures()),
            observeDelivery: async () => ({ ...DELIVERY_OBSERVATION, carrierFallback })
        }
    });

    const observed = await runtime.execute({
        kind: 'messages.observe',
        commandId: 'alm-observe-hand-over',
        handleId: 'handle-1',
        state: ['acknowledged'],
        timeoutMs: 2_500
    });

    expect(observed.ok, observed.error?.message).toBe(true);
    expect(observed.value).toMatchObject({ carrierFallback });
});
```

- [ ] **Step 2: Run the RED test.**

Run: `npx vitest run packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`
Expected: FAIL — the lane-role case (`toPeer` is an unexpected property, and `messages.send has unsupported field:
toPeer.`), the prefix case (`peerUnresolved` is `undefined` in the message and the code is
`RALLAR_BLACK_BOX_ALM_INVALID_COMMAND_INPUT`), the three `carrierFallback` rows (the decoder ignores the field and the
command passes) and the hand-over case (`carrierFallback` is absent from the value).

- [ ] **Step 3: The field in every recipe registry.** In `rallar-black-box-test-contracts.ts`
      `RallarBlackBoxTestMessagesSendCommand` (`:313-333`) add after `handleId?: string;`:

```ts
/**
 * One peer the send addresses, named by its lane role (C11): `server` is the WS server, `receiver` the one
 * other live session of the room. The page resolves it at send time; absent, the send addresses its scope.
 */
toPeer?: 'server' | 'receiver';
```

    In `schema/rallar-black-box-command-fields.ts` add `'toPeer'` after `'qos'` in the `messages.send` optional list
    (`:100-114`), and to `RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES` (`:280-299`) after `messagesQosAckAlgo`:

```ts
/** The lane roles a `messages.send` may address; a session id is unknown when a recipe is written (C11). */
messagesToPeer: ['server', 'receiver'],
```

    In `schema.ts` add to the `messages.send` properties (`:598-616`), after `qos: messagesQosSchema,`:

```ts
toPeer: { type: 'string', enum: RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesToPeer },
```

    In `alm/validate-alm-control-command.ts` `validateOrdinaryMessagesSendCommand` (`:80-104`) add after the
    `durability` line:

```ts
...validateEnumField({ record: command, key: 'toPeer', path, allowed: values.messagesToPeer }),
```

      A replay already refuses every listed field (`validateMessagesReplayCommand`, `:64-78`), `toPeer` included.

      In `alm/rallar-black-box-alm-command-capabilities.ts`, in the `messages.send` description (`:11-18`), split
      `:16` (`'durability; absent, the send is volatile. A replay names only replayOnCarrier (and connection): a ' +`)
      into `'durability; absent, the send is volatile. ' +`, the three lines below, and
      `'A replay names only replayOnCarrier (and connection): a ' +`:

```ts
'toPeer (server or receiver) addresses one peer by its lane role, which the page resolves at send time to ' +
'the WS server\'s peer id or to the one other live session of the room; a role it cannot resolve fails ' +
'the send and opens no handle. ' +
```

    and name `a carrierFallback` after `a relayRejection` in the `messages.observe` description (`:40`), and
    `carrierFallback` after `relayRejection` in the `messages.receipts` description (`:93`).

- [ ] **Step 4: The observation's `carrierFallback` and the page failure code.** In
      `alm/rallar-black-box-alm-result-values.ts:40-41` add `'carrierFallback'` to the `Pick<ALDeliveryEvidence, …>`
      union (beside `'relayRejection'` and Task 1's `'failure'`). In `black-box-rallar-operation-contracts.ts:361-362`
      do the same for `BlackBoxRallarDeliveryObservation`.

      In `alm/decode-alm-runtime-result.ts` add `ALDeliveryCarrierFallback` and `ALDeliveryFallbackReason` to the
      `@shared/alm/delivery/al-delivery-lifecycle.ts` import (`:2-9`, a value import of `AL_DELIVERY_STATES` with
      inline `type` specifiers) as `type ALDeliveryCarrierFallback` and `type ALDeliveryFallbackReason`, add
      `carrierFallback: readAlmCarrierFallbackField(record, path),` after the `relayRejection` line of
      `decodeAlmDeliveryResultValue` (`:137`), add after `ALM_ATTEMPT_OUTCOMES` (`:58-68`):

```ts
/** Keyed by every fallback reason, so a new reason fails to compile here instead of decoding as an invalid result. */
const ALM_FALLBACK_REASONS: Readonly<Record<ALDeliveryFallbackReason, true>> = {
    'not-ready': true,
    'not-yet-in-sync-exhausted': true,
    'receipt-exhausted': true
};
```

    and after `readAlmFailureField` (Task 1 Step 11 places it after the `readAlmRelayRejectionField` it rewrites;
    `:276` today):

```ts
/** Absent unless the strategy handed the admitted message to its second carrier (D56). */
function readAlmCarrierFallbackField(
    record: RallarBlackBoxTestRecord,
    path: string
): ALDeliveryCarrierFallback | undefined {
    const value = record.carrierFallback;
    if (value === undefined) {
        return undefined;
    }
    const fallback = decodeAlmRuntimeRecord(value);
    const legs = RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesCarrierLeg;
    const from = legs.find((carrier) => carrier === fallback.from);
    const to = legs.find((carrier) => carrier === fallback.to);
    const { reason, atMs, detail } = fallback;
    if (
        from === undefined || to === undefined || !isAlmFallbackReason(reason) ||
        typeof atMs !== 'number' || typeof detail !== 'string'
    ) {
        throw toAlmInvalidRuntimeResultError(`${path}.carrierFallback`);
    }
    return { from, to, reason, atMs, detail };
}

function isAlmFallbackReason(value: unknown): value is ALDeliveryFallbackReason {
    return typeof value === 'string' && Object.hasOwn(ALM_FALLBACK_REASONS, value);
}
```

    In `black-box-rallar-delivery-error-message-prefixes.ts` add an entry after `rawControlUnavailable`, which gains a
    comma, so that the object reads:

```ts
export const BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES = {
    deliveryStateTimeout: 'Delivery handle',
    scriptedPortsUnavailable: 'Scripted transport and storage ports are not installed',
    /** The page cannot replay now: no connected session, or the capturing carrier no longer retains the envelope. */
    replayUnavailable: 'Message replay unavailable',
    /** The page has no connected session to submit a raw control from. */
    rawControlUnavailable: 'Raw control submission unavailable',
    /** A `messages.send.toPeer` role the page could not resolve to exactly one peer. */
    peerUnresolved: 'Message peer unresolved'
} as const;
```

    In `alm/browser-adapter-alm-commands.ts` add
    `peerUnresolved: 'RALLAR_BLACK_BOX_ALM_PEER_UNRESOLVED',` after `rawControlUnavailable` in `ALM_ERROR_CODES`
    (`:115-125`) and `'peerUnresolved'` to `ALM_PAGE_RUNTIME_ERROR_CODE_KEYS` (`:128-133`).

- [ ] **Step 5: The golden corpus and the upgrade note.** In `golden-compatibility-corpus.json`, recipe
      `golden-all-primitive-commands-v1`, insert after the `messages-send-v1` command (`:133-152`):

```json
{
  "kind": "messages.send",
  "commandId": "messages-send-to-peer-v1",
  "connection": "goldenRtc",
  "carrier": "rtc-with-ws-fallback",
  "typeId": "room.golden.compatibility.alm.command",
  "payload": {
    "text": "golden addressed payload"
  },
  "roomRef": {
    "applicationId": "rallar-server",
    "workspaceId": "default",
    "groupId": "golden-room"
  },
  "ack": "receiver",
  "toPeer": "receiver",
  "handleId": "messages-send-to-peer-v1-handle"
},
```

    and append to `invalidRecipes` (add a comma after its current last entry, which closes at `:1021`):

```json
{
  "caseId": "messages-send-unknown-peer-role",
  "expectedErrors": [
    "$.commands[0].toPeer: Expected one of \"server\", \"receiver\"."
  ],
  "value": {
    "schemaVersion": 1,
    "recipeId": "messages-send-unknown-peer-role",
    "commands": [
      {
        "kind": "messages.send",
        "commandId": "messages-send-recipient-b",
        "carrier": "ws",
        "typeId": "room.golden.compatibility.alm",
        "payload": { "n": 1 },
        "toPeer": "recipient-b"
      }
    ]
  }
}
```

    Append to `docs/schema-compatibility-guide.md`, inside the `## Upgrade Notes` section, one block:

```text
Title: messages.send names one peer by its lane role
Date: 2026-09-28
Owner: ALM S3c-ii Task 6

Change type:
- Compatible optional addition

Affected schemas:
- RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA
- Other: RALLAR_BLACK_BOX_COMMAND_FIELDS['messages.send'] and the control validator

Old shape:
messages.send addressed its scope only; toPeerId was refused.

New shape:
messages.send may name toPeer: 'server' | 'receiver'. The page resolves the role at send time to the WS server's
peer id or to the room's one other live session; an unresolvable role fails with
RALLAR_BLACK_BOX_ALM_PEER_UNRESOLVED. A replay refuses toPeer. toPeerId stays refused.

Migration:
None: a recipe without toPeer is unchanged.

Golden corpus updates:
golden-all-primitive-commands-v1 gained messages-send-to-peer-v1; new invalid messages-send-unknown-peer-role case.

Prompt/documentation updates:
schema-and-capabilities.md "ALM Commands" describes toPeer and its failure.

Verification:
npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts
```

- [ ] **Step 6: GREEN.** Run: `npx vitest run packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts
      packages/tests/shared-test/rallar-bb-test-schema.test.ts`
      Expected: PASS (the corpus case still covers every command kind, and the new invalid case fails on `toPeer`
      only).

- [ ] **Step 7: RED — the page resolves a role.** In
      `packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts` add
      `GroupPresenceSession` (from `@shared/api/group-types.ts`) and `BlackBoxBrowserPeersDependency` (from
      `browser-rallar-runtime-composition.ts`, beside the other dependency types) to the type imports, add to
      `facadeBehavior` after `resolveRoomMinSnapshotVersion` (`:198`, the object's last entry today: give it a
      trailing comma):

```ts
serverPeerId: vi.fn<BlackBoxBrowserPeersDependency['serverPeerId']>(),
readRoomSessions: vi.fn<BlackBoxBrowserPeersDependency['readRoomSessions']>()
```

    add after the `deliveries` constant (`:350-355`):

```ts
const peers: BlackBoxBrowserPeersDependency = {
    serverPeerId: () => facadeBehavior.serverPeerId(),
    session: () => facadeSession,
    readRoomSessions: (roomRef) => facadeBehavior.readRoomSessions(roomRef)
};
```

    add `peers` after `deliveries` in `rallarFacadeTestDouble` (`:405`), and export after `openFacadeDelivery`:

```ts
/** A presence entry of room-1 whose lease runs a minute past now, unless the case states its own. */
export function toRoomRosterSession(
    sessionId: string,
    lease: Readonly<{ status?: 'active' | 'disconnected'; expiresAtEpochMs?: number; }> = {}
): GroupPresenceSession {
    const nowMs = Date.now();
    const entry = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        sessionId,
        // Hosted agents may all log in as one user, so the principal never tells two sessions apart.
        principalId: 'client-1',
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        connectedAtEpochMs: nowMs - 5_000,
        lastHeartbeatAtEpochMs: nowMs - 1_000,
        expiresAtEpochMs: lease.expiresAtEpochMs ?? nowMs + 60_000
    };
    return lease.status === 'disconnected'
        ? {
            ...entry,
            status: 'disconnected',
            disconnectedAtEpochMs: nowMs - 500,
            disconnectReason: 'closed'
        }
        : { ...entry, status: 'active', disconnectedAtEpochMs: null, disconnectReason: null };
}
```

    Create `packages/tests/shared-test/rallar-browser-runtime/resolve-black-box-rallar-message-peer.test.ts`:

```ts
import {
    describe,
    expect,
    it
} from 'vitest';

import { resolveBlackBoxRallarMessagePeer } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/resolve-black-box-rallar-message-peer.ts';

import { toRoomRosterSession } from './browser-runtime-facade-test-double.ts';

describe('the lane role a messages.send addresses (C11)', () => {
    const nowMs = Date.now();
    const input = { serverPeerId: 'server-peer', ownSessionId: 'sender-session', nowMs };

    it('names the server by the peer id it answers as', () => {
        expect(
            resolveBlackBoxRallarMessagePeer({
                ...input,
                toPeer: 'server',
                roomSessions: undefined
            }).right
        )
            .toBe('server-peer');
    });

    it('names the receiver as the one other live session of the room, whatever principal it logged in as', () => {
        const roomSessions = [
            toRoomRosterSession('sender-session'),
            toRoomRosterSession('receiver-session'),
            toRoomRosterSession('left-session', { status: 'disconnected' }),
            toRoomRosterSession('lapsed-session', { expiresAtEpochMs: nowMs })
        ];

        expect(
            resolveBlackBoxRallarMessagePeer({ ...input, toPeer: 'receiver', roomSessions }).right
        )
            .toBe('receiver-session');
    });

    it('states, as a value, a role that no one peer answers', () => {
        const withoutServer = resolveBlackBoxRallarMessagePeer({
            ...input,
            serverPeerId: undefined,
            toPeer: 'server',
            roomSessions: undefined
        });
        const withoutRoster = resolveBlackBoxRallarMessagePeer({
            ...input,
            toPeer: 'receiver',
            roomSessions: undefined
        });
        const twoOthers = resolveBlackBoxRallarMessagePeer({
            ...input,
            toPeer: 'receiver',
            roomSessions: ['sender-session', 'receiver-session', 'recipient-b-session'].map((id) =>
                toRoomRosterSession(id)
            )
        });

        expect(withoutServer.left).toBe('the WS server named no peer id');
        expect(withoutRoster.left).toBe('the room holds 0 other live sessions, not exactly one');
        expect(twoOthers.left).toBe('the room holds 2 other live sessions, not exactly one');
    });
});
```

    In `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts` add
    `import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-error-message-prefixes.ts';`,
    import `toRoomRosterSession` beside `openFacadeDelivery` (`:55`), add `carrierFallback: undefined,` after
    `relayRejection: undefined,` in `unknownObservation` (`:88`), and add after the case
    `'passes a stated QoS request to the typed send as given, and none without one'` (`:493-510`):

```ts
it('addresses a lane role through the page: the server by its peer id, the receiver as the room\'s one other session', async () => {
    const runtime = await loadRuntime();
    await runtime.connect(connection);
    facade.behavior.serverPeerId.mockReturnValue('server-peer');
    facade.behavior.readRoomSessions.mockReturnValue([
        toRoomRosterSession(facade.session.sessionId),
        toRoomRosterSession('bob-session')
    ]);

    await runtime.sendMessage({ ...send, handleId: 'h-server', toPeer: 'server' });
    await runtime.sendMessage({
        ...send,
        carrier: 'rtc',
        handleId: 'h-receiver',
        toPeer: 'receiver'
    });
    await runtime.sendMessage({ ...send, handleId: 'h-room' });

    expect(facade.records.typedSends.map(([, options]) => options?.peerId))
        .toEqual(['server-peer', 'bob-session', undefined]);
    // A product names one peer as a command (D53, C12); the purpose fills only what the recipe leaves out.
    expect(facade.records.typedChannelOpens.slice(-3).map((definition) => definition.purpose))
        .toEqual(['command', 'command', 'notification']);
    expect(facade.behavior.readRoomSessions).toHaveBeenCalledWith(
        expect.objectContaining({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        })
    );
});

it('fails a lane role the page cannot resolve with its own failure, before any handle opens', async () => {
    const runtime = await loadRuntime();
    await runtime.connect(connection);
    facade.behavior.readRoomSessions.mockReturnValue([
        toRoomRosterSession('bob-session'),
        toRoomRosterSession('carol-session')
    ]);
    const prefix = BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.peerUnresolved;

    await expect(runtime.sendMessage({ ...send, handleId: 'h-server', toPeer: 'server' }))
        .rejects.toThrow(
            `${prefix}: messages.send.toPeer server names no peer: the WS server named no peer id.`
        );
    await expect(runtime.sendMessage({ ...send, handleId: 'h-receiver', toPeer: 'receiver' }))
        .rejects.toThrow(
            `${prefix}: messages.send.toPeer receiver names no peer: the room holds 2 other live sessions, not exactly one.`
        );
    await expect(runtime.sendMessage({ ...send, handleId: 'h-role', toPeer: 'recipient-b' }))
        .rejects.toThrow('messages.send.toPeer must be server or receiver.');
    const replay = {
        connection: 'aliceAlm',
        timeoutMs: 100,
        replayOnCarrier: { handleId: 'h-server', carrier: 'ws' }
    };
    await expect(runtime.sendMessage({ ...replay, toPeer: 'receiver' }))
        .rejects.toThrow(
            'messages.send names toPeer beside replayOnCarrier; a replay names only the handle and its carrier.'
        );
    expect(facade.records.typedSends).toEqual([]);
    expect(events.some((event) => JSON.stringify(event).includes('h-receiver')), 'no send_started')
        .toBe(false);
});

it('projects the hand-over to the fallback carrier on every ledger view (D56)', async () => {
    const runtime = await loadRuntime();
    await runtime.connect(connection);
    const { msgId } = await runtime.sendMessage(send);
    facade.deliveries.record({
        kind: 'carrier-fallback',
        msgId,
        carrier: 'rtc',
        to: 'ws',
        reason: 'not-ready',
        atMs: 5,
        detail: 'three consecutive not-ready attempts'
    });

    const handle = { connection: 'aliceAlm', handleId: 'h-1' };
    // The admitted handle is not terminal, so the observe asks for its current state and never waits out the timer.
    const views = [
        await runtime.observeDelivery({ ...handle, state: ['accepted', 'queued'], timeoutMs: 100 }),
        await runtime.readReceipts(handle),
        await runtime.cancelDelivery(handle)
    ];
    for (const observation of views) {
        expect(observation.carrierFallback)
            .toEqual({
                from: 'rtc',
                to: 'ws',
                reason: 'not-ready',
                atMs: 5,
                detail: 'three consecutive not-ready attempts'
            });
    }
});
```

      The third case records the `carrier-fallback` settlement as declared at
      `packages/shared/alm/delivery/al-delivery-lifecycle.ts:104-114` (`carrier` is the carrier the message left); the
      reducer states it as `{ from, to, reason, atMs, detail }` (`compute-al-delivery-lifecycle.ts:245-254`).

      In `packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts` add to the ledger input (`:555-575`),
      after `deliveries`:

```ts
peers: {
    serverPeerId: () => {
        throw new Error('This fixture never addresses a peer.');
    },
    session: () => undefined,
    readRoomSessions: () => {
        throw new Error('This fixture never addresses a peer.');
    }
},
now: Date.now,
```

- [ ] **Step 8: Run the RED tests.**

Run: `npx vitest run packages/tests/shared-test/rallar-browser-runtime/resolve-black-box-rallar-message-peer.test.ts
packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts`
Expected: FAIL — the resolver module does not exist; the first delivery case sends with `peerId` undefined and every
channel as `notification`; the second resolves each `toPeer` send (nothing decodes it), so no rejection; the third
reads no `carrierFallback`.

- [ ] **Step 9: The resolver.** Create
      `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/resolve-black-box-rallar-message-peer.ts`:

```ts
import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { BlackBoxRallarMessageSendInput } from '../black-box-rallar-operation-contracts.ts';

export interface ResolveBlackBoxRallarMessagePeerInput {
    readonly toPeer: NonNullable<BlackBoxRallarMessageSendInput['toPeer']>;
    /** Undefined until connected, and when the server names none. */
    readonly serverPeerId: string | undefined;
    readonly ownSessionId: string | undefined;
    /** The room's cached roster; undefined while the page holds no snapshot of the room. */
    readonly roomSessions: readonly GroupPresenceSession[] | undefined;
    readonly nowMs: number;
}

/**
 * A lane role names one peer (C11): `server` the id the WS server answers as, `receiver` the one other live session of
 * the room. The roster names no role, so `receiver` resolves only while exactly one other session is live; sessions are
 * told apart by id, since hosted agents may share one principal.
 */
export function resolveBlackBoxRallarMessagePeer(
    input: ResolveBlackBoxRallarMessagePeerInput
): Either<string, string> {
    if (input.toPeer === 'server') {
        return input.serverPeerId === undefined
            ? Either.ofLeft('the WS server named no peer id')
            : Either.ofRight(input.serverPeerId);
    }
    const others = (input.roomSessions ?? []).filter((session) =>
        session.status === 'active' && session.expiresAtEpochMs > input.nowMs &&
        session.sessionId !== input.ownSessionId
    );
    const [receiver] = others;
    return others.length === 1 && receiver !== undefined
        ? Either.ofRight(receiver.sessionId)
        : Either.ofLeft(`the room holds ${others.length} other live sessions, not exactly one`);
}
```

- [ ] **Step 10: The page decodes and sends `toPeer`.** In `black-box-rallar-operation-contracts.ts`
      `BlackBoxRallarMessageSendInput` (`:281-302`) add after `handleId`:

```ts
/** Absent, the send addresses its scope; a lane role the page resolves to one peer at send time (C11). */
readonly toPeer: 'server' | 'receiver' | undefined;
```

    In `messaging/decode-black-box-rallar-message-send-input.ts` add `'toPeer'` after `'qos'` in
    `REPLAY_REFUSED_FIELDS` (`:41-57`), add after `REPLAY_CARRIERS` (`:39`):

```ts
const MESSAGE_PEER_ROLES: readonly NonNullable<BlackBoxRallarMessageSendInput['toPeer']>[] = [
    'server',
    'receiver'
];
```

    replace `decodeOrdinarySend` (`:92-112`) with:

```ts
function decodeOrdinarySend(
    value: BlackBoxRallarCommandRecord
): Either<BlackBoxRallarInputIssue, BlackBoxRallarMessageSendInput> {
    const payload = value.payload;
    if (!('payload' in value) || !isRallarMessagePayload(payload)) {
        return Either.ofLeft({ message: 'messages.send.payload is required.' });
    }
    const toPeer = decodeMessagePeerRole(value.toPeer);
    if (toPeer !== undefined && typeof toPeer !== 'string') {
        return Either.ofLeft(toPeer);
    }
    return decodeMessageSendIdentity(value).flatMap(
        (issue) => Either.ofLeft(issue),
        (identity) =>
            decodeMessageSendOptions(value).mapRight((options) => ({
                ...identity,
                ...options,
                payload,
                toPeer,
                topicId: decodeBlackBoxCommandString(value.topicId),
                ttlMs: decodeBlackBoxCommandNumber(value.ttlMs),
                orderingKey: decodeBlackBoxCommandString(value.orderingKey),
                seq: decodeBlackBoxCommandNumber(value.seq)
            }))
    );
}

function decodeMessagePeerRole(
    value: unknown
): NonNullable<BlackBoxRallarMessageSendInput['toPeer']> | BlackBoxRallarInputIssue | undefined {
    if (value === undefined) {
        return undefined;
    }
    return MESSAGE_PEER_ROLES.find((role) => role === value) ??
        { message: 'messages.send.toPeer must be server or receiver.' };
}
```

    In `messaging/black-box-rallar-typed-channels.ts` add
    `import type { ALChannelPurpose } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';`, add to
    `TypedChannelRoute` (`:20-25`):

```ts
/** A send to one peer is a `command`; everything else the harness sends is a `notification`. */
readonly purpose: ALChannelPurpose;
```

      make `open` pass `purpose: route.purpose,` in place of `purpose: 'notification',` (`:58`), and add
      `purpose: 'notification'` to the route `subscribe` opens (`:98-103`).

      In `messaging/black-box-rallar-delivery-ledger.ts`: import `BlackBoxBrowserPeersDependency` beside
      `BlackBoxBrowserDeliveriesDependency` (`:25`) and
      `import { resolveBlackBoxRallarMessagePeer } from './resolve-black-box-rallar-message-peer.ts';`; make the
      input (`:31-37`):

```ts
export interface Input {
    readonly deliveries: BlackBoxBrowserDeliveriesDependency;
    readonly peers: BlackBoxBrowserPeersDependency;
    readonly typedChannels: BlackBoxRallarTypedChannels;
    readonly resources: BlackBoxRallarMessagingResourceController;
    readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
    readonly now: () => number;
    requireConfig(): BlackBoxRallarConnectionConfig;
}
```

    add `carrierFallback: lifecycle?.evidence.carrierFallback,` after the `relayRejection` line of
    `toDeliveryObservation` (`:61`); in `#sendNewMessage` (`:86-120`) add
    `const peerId = this.#resolvePeer(send, roomRef);` after the `snapshotFloorOption` line, add
    `purpose: send.toPeer === undefined ? 'notification' : 'command'` to the route `open` receives (after
    `durability: send.durability,`), and make the send line
    `const handle = await channel.send(send.payload, { ...toTypedSendOptions(send, peerId), ...snapshotFloorOption });`;
    add after `#resolveSnapshotFloor` (`:156-178`):

```ts
/** A lane role resolves here, where the session ids live; a role no one peer answers fails the send (C11). */
#resolvePeer(send: BlackBoxRallarMessageSendInput, roomRef: GroupRef | undefined): string | undefined {
    if (send.toPeer === undefined) {
        return undefined;
    }
    const { peers } = this.#input;
    return resolveBlackBoxRallarMessagePeer({
        toPeer: send.toPeer,
        serverPeerId: peers.serverPeerId(),
        ownSessionId: peers.session()?.sessionId,
        roomSessions: roomRef === undefined ? undefined : peers.readRoomSessions(roomRef),
        nowMs: this.#input.now()
    }).fold(
        (detail) => {
            throw new Error(
                `${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.peerUnresolved}: messages.send.toPeer ` +
                    `${send.toPeer} names no peer: ${detail}.`
            );
        },
        (peerId) => peerId
    );
}
```

    and replace `toTypedSendOptions` (`:227-238`) with:

```ts
function toTypedSendOptions(
    send: BlackBoxRallarMessageSendInput,
    peerId: string | undefined
): RallarTypedMessageSendOptions<RallarMessagePayload> {
    return {
        strategy: send.carrier,
        ...(peerId === undefined ? {} : { peerId }),
        ...(send.reliability === undefined ? {} : { reliability: send.reliability }),
        ...(send.ack === undefined ? {} : { ack: send.ack }),
        ...(send.ttlMs === undefined ? {} : { ttlMs: send.ttlMs }),
        ...(send.orderingKey === undefined ? {} : { orderingKey: send.orderingKey }),
        ...(send.seq === undefined ? {} : { seq: send.seq }),
        ...(send.scope === undefined ? {} : { scope: send.scope }),
        ...(send.qos === undefined ? {} : { qos: send.qos })
    };
}
```

    `#sendNewMessage` grows from 35 to 37 lines.

- [ ] **Step 11: The composition hands the page its peers.** In `browser-rallar-runtime-composition.ts` add
      `import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';` (replacing the
      `GroupRef`-only import at `:54`; the runtime dependency's own `Pick` of `RallarConnectionOperations` stays as it
      is, the page reads the server id through `peers`), and add after `BlackBoxBrowserDeliveriesDependency`
      (`:121-126`):

```ts
/** What the page reads to name a peer by its lane role: the WS server's id, its own session and the room's roster. */
export interface BlackBoxBrowserPeersDependency
    extends Pick<RallarConnectionOperations, 'serverPeerId' | 'session'> {
    /** The room's cached presence roster; undefined while the page holds no snapshot of the room. */
    readRoomSessions(roomRef: GroupRef): readonly GroupPresenceSession[] | undefined;
}
```

    add `readonly peers: BlackBoxBrowserPeersDependency;` after `deliveries` in
    `BlackBoxBrowserRallarRuntimeDependency` (`:100`) and in `BlackBoxBrowserRuntimeComponents` (`:286`), return
    `peers` beside `deliveries` in `toBlackBoxBrowserRuntimeDependency` (`:291`, `:329`), and move the `deliveries`
    literal out of `createBlackBoxBrowserRallarRuntimeDependency` (`:206-222` today, `:205-221` once Task 5 deletes
    `:181`; the function is 59 lines today and 58 after Task 5) into:

```ts
function toBlackBoxBrowserMessagingPorts(
    input: Readonly<{ session: BrowserSessionCoreComposition; state: BrowserStateComposition; }>
): Pick<BlackBoxBrowserRuntimeComponents, 'deliveries' | 'peers'> {
    const { session, state } = input;
    return {
        deliveries: {
            getHandle: (msgId) => browserDeliveryComposition.deliveries.getHandle(msgId),
            replayCapturedMessage: async (replay) =>
                await replayBlackBoxCapturedMessage({
                    ...replay,
                    sessionId: session.connection.session()?.sessionId,
                    context: session.session.readMiddleware()
                }),
            submitRawControl: async (control) =>
                await submitBlackBoxRawControl({
                    control,
                    sessionId: session.connection.session()?.sessionId,
                    context: session.session.readMiddleware(),
                    nowMs: Date.now()
                }),
            resolveRoomMinSnapshotVersion: (roomRef) =>
                state.roomStateStore.resolveRoomMinSnapshotVersion(roomRef)
        },
        peers: {
            serverPeerId: () => session.connection.serverPeerId(),
            session: () => session.connection.session(),
            readRoomSessions: (roomRef) =>
                state.roomStateStore.findGroupSnapshot(roomRef)?.activeSessions
        }
    };
}
```

      so the `toBlackBoxBrowserRuntimeDependency({ … })` call passes `...toBlackBoxBrowserMessagingPorts({ session,
      state })` in place of `deliveries: { … }` (the composition function falls from 58 lines, after Task 5, to 42).

      In `connection/black-box-rallar-connection-runtime.ts` `createMessagingControllers` (`:410-416`) add
      `peers: rallar.peers,` after `deliveries: rallar.deliveries,` and `now: clock.now,` after `diagnostics,`.

- [ ] **Step 12: GREEN.** Run the Step 8 command, then
      `npx vitest run packages/tests/shared-test/rallar-browser-runtime packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts`.
      Expected: PASS.

- [ ] **Step 13: RED — the lane-only volatile limits.** In
      `packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts` add after the case
      `'validates connection configuration before calling the native runtime'` (`:26-66`):

```ts
it('decodes the lane-only volatile limits of a connect and refuses a partial or non-positive pair', async () => {
    const connect = vi.fn(async (input) => input);
    vi.stubGlobal('window', { __blackBoxRallar: { connect } });
    const bridge = createSpaBrowserRallarRuntime();
    const input = {
        connection: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            almVolatileLimits: { maxAdmissions: 2, maxBytes: 4_096 }
        }
    };

    await expect(bridge.connect(input)).resolves.toEqual(input);
    for (
        const almVolatileLimits of [
            { maxAdmissions: 0, maxBytes: 4_096 },
            { maxAdmissions: 2 },
            { maxAdmissions: 2, maxBytes: 1.5 },
            { maxAdmissions: 2, maxBytes: 4_096, maxAgeMs: 1 }
        ]
    ) {
        await expect(bridge.connect({ ...input, rallar: { ...input.rallar, almVolatileLimits } }))
            .rejects.toThrow(
                'rallar.almVolatileLimits must name maxAdmissions and maxBytes, each a positive integer.'
            );
    }
    expect(connect).toHaveBeenCalledTimes(1);
});
```

    In `packages/tests/shared-test/rallar-browser-runtime/browser-rallar-runtime-test-harness.ts` import
    `BlackBoxRallarVolatileLimits` from
    `@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts`
    and make `loadRuntime` (`:118-130`):

```ts
export async function loadRuntime(
    volatileLimits = new BlackBoxRallarVolatileLimits()
): Promise<BlackBoxRallarRuntime> {
    const target: BlackBoxRallarRuntimeInstallationTarget = {
        __blackBoxRallarEmit: (event) => {
            events.push(event);
        }
    };
    return createBlackBoxRallarRuntime({
        facade: facade.rallar,
        volatileLimits,
        targetWindow: target,
        clock: { now: Date.now },
        readDocument: () => ({
            timeOrigin: 1_700_000_000_000.25,
            origin: 'https://runtime.example.test'
        }),
        delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    });
}
```

      Add `volatileLimits: new BlackBoxRallarVolatileLimits(),` after `facade: facade.rallar,` in the other three
      `createBlackBoxRallarRuntime({ … })` calls (`packages/tests/rallar-black-box/browser-rallar-runtime.test.ts:56`,
      `packages/tests/shared-test/rallar-browser-runtime/composition.test.ts:60,93`), with the same import.

      Append to `packages/tests/shared-test/rallar-browser-runtime/connection.test.ts` (importing
      `BlackBoxRallarVolatileLimits` from
      `@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts`,
      and `AL_VOLATILE_SESSION_MAX_ADMISSIONS`, `AL_VOLATILE_SESSION_MAX_BYTES` and the
      type `ALVolatileSessionLimits` from `@shared/alm/volatile-budget/al-volatile-session-budget.ts`):

```ts
it('holds a connect\'s lowered volatile limits for the session the facade initialises, and the constants after', async () => {
    const volatileLimits = new BlackBoxRallarVolatileLimits();
    const runtime = await loadRuntime(volatileLimits);
    const read: ALVolatileSessionLimits[] = [];
    facade.behavior.connect.mockImplementation(async () => {
        read.push(volatileLimits.get());
    });
    const config = {
        connection: 'aliceAlm',
        actor: 'alice',
        rallar: { apiBaseUrl: 'https://api.example.test', username: 'alice', password: 'secret' }
    };

    await runtime.connect({
        ...config,
        rallar: { ...config.rallar, almVolatileLimits: { maxAdmissions: 2, maxBytes: 4_096 } }
    });
    await runtime.close();
    await runtime.connect(config);
    await runtime.close();

    // The facade initialises its session inside `connect`, so what it reads there is what the session keeps.
    expect(read).toEqual([
        { maxAdmissions: 2, maxBytes: 4_096 },
        {
            maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        }
    ]);
});
```

    In `packages/tests/shared-web/composition/browser-runtime-construction.test.ts` import the same three names and
    `BlackBoxRallarVolatileLimits` (dynamically, beside `createBlackBoxBrowserRallarRuntimeDependency`), make the
    existing call at `:90` `createBlackBoxBrowserRallarRuntimeDependency({ readVolatileSessionLimits: new
    BlackBoxRallarVolatileLimits().get })`, and add after that case:

```ts
it('hands the black-box session a volatile-limits read port that the connect sets before it initialises (C11)', async () => {
    const { createBlackBoxBrowserRallarRuntimeDependency } = await import(
        '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts'
    );
    const { BlackBoxRallarVolatileLimits } = await import(
        '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts'
    );
    const volatileLimits = new BlackBoxRallarVolatileLimits();
    const read: (ALVolatileSessionLimits | undefined)[] = [];
    runtime.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => {
        read.push(options.readVolatileSessionLimits?.());
        return runtime.middleware.middleware;
    });
    const blackBox = createBlackBoxBrowserRallarRuntimeDependency({
        readVolatileSessionLimits: volatileLimits.get
    });
    const config = { connection: 'sender', rallar: { apiBaseUrl: 'https://api.example.test' } };

    volatileLimits.set({
        ...config,
        rallar: { ...config.rallar, almVolatileLimits: { maxAdmissions: 3, maxBytes: 4_096 } }
    });
    await blackBox.connect();
    await blackBox.disconnect();
    volatileLimits.set(config);
    await blackBox.connect();
    await blackBox.disconnect();

    expect(read).toEqual([
        { maxAdmissions: 3, maxBytes: 4_096 },
        {
            maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
            maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
        }
    ]);
});
```

- [ ] **Step 14: Run the RED tests.**

Run: `npx vitest run packages/tests/shared-test/rallar-bb-test-browser-rallar-runtime-bridge.test.ts
packages/tests/shared-test/rallar-browser-runtime/connection.test.ts
packages/tests/shared-web/composition/browser-runtime-construction.test.ts`
Expected: FAIL — `connection.test.ts` fails to load (it imports the missing `black-box-rallar-volatile-limits.ts`); in
`browser-runtime-construction.test.ts` the two black-box cases fail at their dynamic import of that file; in the bridge
test the new case fails because the decoder drops `almVolatileLimits` (the forwarded config lacks it, and the four
malformed pairs resolve instead of rejecting).

- [ ] **Step 15: The read port and the connect field.** Create
      `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts`:

```ts
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    AL_VOLATILE_SESSION_MAX_BYTES,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';

const DEFAULT_LIMITS: ALVolatileSessionLimits = {
    maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
};

/**
 * The volatile bound the facade's next session initialisation reads (D74). The facade is composed before any connect
 * arrives, so it holds `get` as a read port; only a connect sets the value, from its own config, before it connects.
 */
export class BlackBoxRallarVolatileLimits {
    #limits: ALVolatileSessionLimits = DEFAULT_LIMITS;

    get = (): ALVolatileSessionLimits => this.#limits;

    set(config: BlackBoxRallarConnectionConfig): void {
        this.#limits = config.rallar.almVolatileLimits ?? DEFAULT_LIMITS;
    }
}
```

    In `black-box-rallar-operation-contracts.ts` import the type `ALVolatileSessionLimits` and add to
    `BlackBoxRallarConfig` (`:76-114`) after `logoutOnClose`:

```ts
/** Harness-only (C11): the volatile bound of the session this connect initialises; absent, the constants. */
readonly almVolatileLimits?: ALVolatileSessionLimits;
```

    In `decode-black-box-rallar-connection-config.ts` import the type `ALVolatileSessionLimits`, add
    `almVolatileLimits: decodeAlmVolatileLimits(record.almVolatileLimits),` after the `logoutOnClose` line of
    `decodeBlackBoxRallarConfigFields` (`:168`), and add before it (`:124`):

```ts
/** Harness-only (C11): lowers the session's volatile bound; both limits, each a positive integer. */
function decodeAlmVolatileLimits(value: unknown): ALVolatileSessionLimits | undefined {
    if (value === undefined) {
        return undefined;
    }
    const record = configRecord(value);
    const { maxAdmissions, maxBytes } = record;
    if (
        !isPositiveInteger(maxAdmissions) || !isPositiveInteger(maxBytes) ||
        Object.keys(record).length !== 2
    ) {
        throw new TypeError(
            'rallar.almVolatileLimits must name maxAdmissions and maxBytes, each a positive integer.'
        );
    }
    return { maxAdmissions, maxBytes };
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
```

    Replace `connection/configure-black-box-rallar-connection.ts` with:

```ts
import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';

import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import { toBlackBoxRallarDefaults } from './black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarVolatileLimits } from './black-box-rallar-volatile-limits.ts';

export interface ConfigureBlackBoxRallarConnectionInput {
    readonly rallar: BlackBoxBrowserRallarRuntimeDependency;
    readonly diagnosticsPorts: RallarDiagnosticsPorts;
    readonly volatileLimits: BlackBoxRallarVolatileLimits;
    readonly config: BlackBoxRallarConnectionConfig;
}

/**
 * A connection that names no application has no defaults, so it also carries no scripted diagnostics ports. Its
 * volatile limits reach only the session the facade initialises next: a facade already connected keeps its own.
 */
export function configureBlackBoxRallarConnection(
    input: ConfigureBlackBoxRallarConnectionInput
): Parameters<BlackBoxBrowserRallarRuntimeDependency['setDefaults']>[0] {
    const { rallar, diagnosticsPorts, volatileLimits, config } = input;
    rallar.configure({ apiBaseUrl: config.rallar.apiBaseUrl });
    const defaults = toBlackBoxRallarDefaults(config);
    rallar.setDefaults(defaults === undefined ? undefined : { ...defaults, diagnosticsPorts });
    volatileLimits.set(config);
    return defaults;
}
```

      Add `readonly volatileLimits: BlackBoxRallarVolatileLimits;` (type import from
      `./black-box-rallar-volatile-limits.ts`) to `BlackBoxRallarConnectOperation.Input`
      (`connect-operation.ts:53-66`) and to `BlackBoxRallarCrdtLiveConnection.Input`
      (`crdt-live-connection.ts:15-22`), and pass `volatileLimits: this.#input.volatileLimits,` to the
      `configureBlackBoxRallarConnection({ … })` call of each (`connect-operation.ts:168-172`,
      `crdt-live-connection.ts:63-67`). Both are built from the foundation spread, so in
      `connection/black-box-rallar-connection-runtime.ts` add `readonly volatileLimits: BlackBoxRallarVolatileLimits;`
      to `Input` (`:74-82`) and to `Foundation` (`:100-109`), and `volatileLimits: input.volatileLimits,` to the
      object `createConnectionFoundation` returns (`:303`).

      In `browser-rallar-runtime-composition.ts` import the type `ALVolatileSessionLimits`, add before
      `createBlackBoxBrowserRallarRuntimeDependency`:

```ts
export interface CreateBlackBoxBrowserRallarRuntimeDependencyInput {
    /** The session reads it once, when it initialises (D74); a connect sets what it returns before it connects. */
    readonly readVolatileSessionLimits: () => ALVolatileSessionLimits;
}
```

    make the function
    `createBlackBoxBrowserRallarRuntimeDependency(input: CreateBlackBoxBrowserRallarRuntimeDependencyInput)` call
    `createBlackBoxBrowserTransportComposition(input.readVolatileSessionLimits)`, and make that function
    (`:333-362`) take `readVolatileSessionLimits: () => ALVolatileSessionLimits` and hand it to the session
    composition beside the provider (Task 3's field on `CreateBrowserSessionCoreCompositionInput`):

```ts
const session = createBrowserSessionCoreComposition({
    qosProvider: { defaultsForMessage: computeAlmConformanceQosDefaults },
    readVolatileSessionLimits,
    foundation,
    state,
    sessionDeliveries: browserDeliveryComposition.sessionDeliveries
});
```

    In `black-box-rallar-runtime.ts` import `BlackBoxRallarVolatileLimits` and make `installBlackBoxRallarRuntime`
    (`:72-88`) construct the holder first and hand the facade only its read port:

```ts
export function installBlackBoxRallarRuntime(
    targetWindow: BlackBoxRallarRuntimeInstallationTarget
): BlackBoxRallarRuntime {
    const volatileLimits = new BlackBoxRallarVolatileLimits();
    const installation = new BlackBoxRallarConnectionRuntime({
        facade: createBlackBoxBrowserRallarRuntimeDependency({
            readVolatileSessionLimits: volatileLimits.get
        }),
        volatileLimits,
        targetWindow,
        clock: { now: Date.now },
        readDocument: () => ({
            timeOrigin: globalThis.performance.timeOrigin,
            origin: globalThis.location.origin
        }),
        delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)))
    }).installation();
    targetWindow.__blackBoxRallar = installation.runtime;
    installation.emitRuntimeLoaded();
    return installation.runtime;
}
```

    Nothing calls into the facade to change a limit: the product holds a function it reads at initialisation, the
    harness owns the only writer, and `rallar.connect` takes no new option (the public surface is unchanged).

- [ ] **Step 16: GREEN.** Run the Step 14 command, then
      `npx vitest run packages/tests/shared-test/rallar-browser-runtime packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/shared-web/composition`.
      Expected: PASS.

- [ ] **Step 17: RED — the four scenarios.** Create
      `packages/tests/shared-test/alm-conformance-addressed-scenarios.test.ts`:

```ts
import {
    describe,
    expect,
    it
} from 'vitest';

import { isRallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/alm/is-rallar-black-box-test-messages-send-command.ts';
import {
    ALM_CONFORMANCE_CARRIERS,
    type AlmConformanceCarrier
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    computeALMessageEnvelopeBytes
} from '@shared/al-contracts/al-message-resource-limits.ts';
import { AL_VOLATILE_SESSION_MAX_ADMISSIONS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const ADDRESSED_KEYS = ['ws-unicast-receipt', 'unicast-fallback', 'server-command', 'capacity'];
const ADDRESSED_KEYS_BY_CARRIER: Readonly<Record<AlmConformanceCarrier, readonly string[]>> = {
    ws: ['ws-unicast-receipt', 'server-command', 'capacity'],
    rtc: ['ws-unicast-receipt', 'capacity'],
    'rtc-with-ws-fallback': ['ws-unicast-receipt', 'unicast-fallback', 'capacity']
};
const ADMITTED = 'state matches ^(accepted|queued|transport-accepted|acknowledged)$';
const ADDRESSEE_RECEIPT = [
    'state equals acknowledged',
    'receiptMode equals receiver',
    'expectedRecipientPeerIds.length equals 1',
    'confirmedRecipientPeerIds.length equals 1'
];
const CAPACITY_LIMITS = { maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS, maxBytes: 128 * 1024 };

function scenarioOf(carrier: AlmConformanceCarrier, key: string): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioKey === key);
    if (scenario === undefined) {
        throw new Error(`${carrier} must run ${key}.`);
    }
    return scenario;
}

/** The scenario's own commands: after the prologue connect, without the storage readings and the closing stats. */
function bodyOf(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestCommand[] {
    return recipe.commands
        .slice(recipe.commands.findIndex((command) => command.kind === 'rtc.connect') + 1, -1)
        .filter((command) => command.kind !== 'storage.counters');
}

function shapeOf(command: RallarBlackBoxTestCommand): string {
    switch (command.kind) {
        case 'fault.inject':
            return `fault.inject:${command.carrier}:${String(command.remaining)}`;
        case 'wait':
            return `wait:${command.match.kind}${command.absent === true ? ':absent' : ''}`;
        case 'messages.received':
            return `received:${command.count}${command.absent === true ? ':absent' : ''}`;
        case 'messages.send':
            return isRallarBlackBoxTestMessagesSendCommand(command) && command.toPeer !== undefined
                ? `messages.send:${command.toPeer}`
                : 'messages.send';
        default:
            return command.kind;
    }
}

function assertionsOf(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return bodyOf(recipe).flatMap((command) =>
        command.kind === 'assert'
            ? [`${command.source.split('.value.')[1]} ${command.operator} ${
                String(command.expected)
            }`]
            : []
    );
}

describe('the addressed-send family (C11)', () => {
    it('runs on two agents in the full scope, over the carriers each scenario can address', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier))
                .filter((scenario) => ADDRESSED_KEYS.includes(scenario.scenarioKey));

            expect(scenarios.map((scenario) => scenario.scenarioKey), carrier).toEqual(
                ADDRESSED_KEYS_BY_CARRIER[carrier]
            );
            for (const scenario of scenarios) {
                expect(scenario.roles, scenario.scenarioKey).toEqual(['sender', 'receiver']);
                expect(scenario.tags, scenario.scenarioKey).toEqual(['full']);
            }
        }
    });

    it('sends a command to the receiver by its role on every carrier and pins its receipt to the receiver', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenario = scenarioOf(carrier, 'ws-unicast-receipt');

            expect(bodyOf(scenario.sender).map(shapeOf), carrier).toEqual([
                'messages.send:receiver',
                'messages.observe',
                'assert',
                'messages.observe',
                'assert',
                'assert',
                'assert',
                'assert',
                'messages.receipts'
            ]);
            expect(assertionsOf(scenario.sender), carrier).toEqual([
                ADMITTED,
                ...ADDRESSEE_RECEIPT
            ]);
            expect(scenario.sender.metadata?.almReceiptRoles, carrier).toEqual([
                {
                    handleId: `alm-${carrier}-ws-unicast-receipt-send-1`,
                    confirmed: ['receiver'],
                    unconfirmed: []
                }
            ]);
            expect(bodyOf(scenario.receiver).map(shapeOf), carrier).toEqual(['received:1']);
        }
    });

    it('drops the RTC leg of a unicast until WS delivers it, and reads the hand-over from carrierFallback', () => {
        const scenario = scenarioOf('rtc-with-ws-fallback', 'unicast-fallback');

        expect(bodyOf(scenario.sender).map(shapeOf)).toEqual([
            'fault.inject:rtc:until-cleared',
            'messages.send:receiver',
            'messages.observe',
            'assert',
            'messages.observe',
            'assert',
            'assert',
            'assert',
            'assert',
            'assert',
            'assert',
            'fault.inject:rtc:0'
        ]);
        expect(assertionsOf(scenario.sender)).toEqual([
            ADMITTED,
            'state equals acknowledged',
            'attemptCarriers contains rtc',
            'attemptCarriers contains ws',
            'carrierFallback.from equals rtc',
            'carrierFallback.to equals ws',
            'carrierFallback.reason equals not-ready'
        ]);
        expect(bodyOf(scenario.receiver).map(shapeOf)).toEqual(['received:1', 'wait:diagnostic']);
        const arrival = bodyOf(scenario.receiver).at(-1);
        expect(arrival?.kind === 'wait' ? arrival.match.contains : undefined)
            .toContain('"carrier":"ws","outcome":"committed","reason":"admitted"');
    });

    it('addresses the server over ws, reads its own ACK as the receipt, and proves the member receives nothing', () => {
        const scenario = scenarioOf('ws', 'server-command');

        expect(bodyOf(scenario.sender).map(shapeOf)).toEqual([
            'messages.send:server',
            'messages.observe',
            'assert',
            'messages.observe',
            'assert',
            'assert',
            'assert',
            'assert'
        ]);
        expect(assertionsOf(scenario.sender)).toEqual([ADMITTED, ...ADDRESSEE_RECEIPT]);
        expect(bodyOf(scenario.receiver).map(shapeOf)).toEqual(['received:1:absent']);
    });

    it('reconnects under a lowered byte bound, refuses the third send capacity with no attempt, and restores it', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenario = scenarioOf(carrier, 'capacity');
            const body = bodyOf(scenario.sender);

            expect(body.map(shapeOf), carrier).toEqual([
                'close',
                'rtc.connect',
                ...['messages.send', 'messages.observe', 'assert'],
                ...['messages.send', 'messages.observe', 'assert'],
                ...['messages.send', 'messages.observe', 'assert', 'assert', 'assert', 'assert'],
                ...['messages.observe', 'assert', 'messages.observe', 'assert'],
                'close',
                'rtc.connect'
            ]);
            expect(assertionsOf(scenario.sender), carrier).toEqual([
                ADMITTED,
                ADMITTED,
                'status equals rejected',
                'failure.kind equals refused',
                'failure.reason equals capacity',
                'attempts equals 0',
                'state equals acknowledged',
                'state equals acknowledged'
            ]);
            const connects = body.flatMap((command) =>
                command.kind === 'rtc.connect' ? [command] : []
            );
            expect(connects.map((command) => command.rallar?.almVolatileLimits), carrier)
                .toEqual([CAPACITY_LIMITS, undefined]);
            const [arrivals, ...rest] = bodyOf(scenario.receiver);
            expect(rest, carrier).toEqual([]);
            // The sender reconnects before it sends, so the receiver's positive wait also owns one RTC readiness.
            expect(arrivals, carrier).toMatchObject({
                kind: 'messages.received',
                count: 2,
                windowMs: 57_000,
                timeoutMs: 58_000
            });
        }
    });

    it('fits two capacity sends under the lowered byte bound with room to spare, and never a third', () => {
        const send = scenarioOf('rtc', 'capacity').sender.commands.find(
            isRallarBlackBoxTestMessagesSendCommand
        );
        if (send === undefined) {
            throw new Error('capacity must send.');
        }
        const message = newALMulticastMessage(
            'sender-session',
            { topicId: 'room.alm-conformance', resourceId: 'capacity', contextId: 'room-alm' },
            { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            send.typeId,
            send.payload,
            { reliability: 'at-least-once', ack: 'receiver', ttlMs: 30_000 }
        );
        const bytes = computeALMessageEnvelopeBytes(message, AL_MESSAGE_RESOURCE_LIMITS).right;
        if (bytes === undefined) {
            throw new Error('A capacity send must be measurable.');
        }

        expect(3 * bytes).toBeGreaterThan(CAPACITY_LIMITS.maxBytes);
        // C4 counts what the session receives too; the lowered bound leaves room for it.
        expect(CAPACITY_LIMITS.maxBytes - 2 * bytes).toBeGreaterThan(32 * 1024);
    });
});
```

- [ ] **Step 18: Run the RED test.**

Run: `npx vitest run packages/tests/shared-test/alm-conformance-addressed-scenarios.test.ts`
Expected: FAIL — `rtc must run capacity.`-style errors from `scenarioOf` and an empty key list in the first case.

- [ ] **Step 19: The shared pieces.** In `alm-conformance-message-commands.ts` add to `AlmConformanceSendDelivery`
      (`:26-36`):

```ts
/** One peer by its lane role (C11); absent, the send addresses its room. */
readonly toPeer?: RallarBlackBoxTestMessagesSendCommand['toPeer'];
```

    (`toSendCommand` spreads `delivery` into the command, so it passes through), and add after
    `toHandedOverAssertions` (`:246`), beside it (R-S3b-3: `conformance/alm/` takes no new file):

```ts
/**
 * An addressed send's receipt names one recipient, its addressee (Q11): `acknowledged` under the `receiver` mode with
 * one expected and one confirmed recipient. Which session that is, the identity assessment joins after the run.
 */
export function toAddresseeReceiptAssertions(
    sender: AlmConformanceStepInput,
    resultName: string
): readonly RallarBlackBoxTestCommand[] {
    const facts = [
        ['state', 'acknowledged'],
        ['receiptMode', 'receiver'],
        ['expectedRecipientPeerIds.length', 1],
        ['confirmedRecipientPeerIds.length', 1]
    ] as const;
    return facts.map(([field, expected]) =>
        toResultAssertion({
            step: sender,
            name: `assert-addressee-${field.replace('.length', '-count')}-1`,
            resultName,
            field,
            operator: 'equals',
            expected
        })
    );
}
```

- [ ] **Step 20: The four scenarios.** Create `scenarios/ws-unicast-receipt.ts`:

```ts
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAddresseeReceiptAssertions,
    toAdmissionCommands,
    toObserveCommand,
    toReceiptsCommand,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import type { AlmConformanceReceiptRoles } from '../alm-conformance-receipt-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

const RECEIVER_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver'], unconfirmed: [] };

/**
 * Q11 on every carrier: a `command` addressed to the receiver by its lane role ends `acknowledged` on the addressee's own
 * receipt. The identity assessment joins the receipt's recipient lists to the receiver's session after the run, which
 * proves the page resolved the role to that session.
 */
export const wsUnicastReceipt: AlmConformanceScenarioDefinition = {
    scenarioId: 'ws-unicast-receipt',
    scenarioKey: 'ws-unicast-receipt',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    toReceiptRoles: () => RECEIVER_CONFIRMED,
    toSenderCommands: toWsUnicastReceiptSenderCommands,
    toRecipientCommands: (
        receiver
    ) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false })]
};

function toWsUnicastReceiptSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                toPeer: 'receiver',
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' }),
        ...toAddresseeReceiptAssertions(sender, 'observe-acknowledged-1'),
        toReceiptsCommand({ ...sender, index: 1 })
    ];
}
```

    Create `scenarios/unicast-fallback.ts`:

```ts
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    MESSAGE_CONTROL_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    toBudgetMs
} from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';
import { toRtcDropFaultCommand } from '../alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toHandedOverAssertions,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toAdmissionOutcomeWait, toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/** D56's hand-over as the handle states it: which carrier the message left, which it went to, and why. */
const HAND_OVER = [['from', 'rtc'], ['to', 'ws'], ['reason', 'not-ready']] as const;

/**
 * Q11's fallback: the sender drops its own RTC frames of an addressed send, so every RTC attempt settles `not-ready`;
 * the third hands the unicast to WS inside its 30 s deadline, and the receiver admits the copy WS carries. That no
 * second copy follows a hand-over is `fallback-within-deadline`'s pin on the same fallback controller.
 */
export const unicastFallback: AlmConformanceScenarioDefinition = {
    scenarioId: 'unicast-fallback',
    scenarioKey: 'unicast-fallback',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toUnicastFallbackSenderCommands,
    toRecipientCommands: toUnicastFallbackReceiverCommands
};

function toUnicastFallbackSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toRtcDropFaultCommand(sender, 'hold-rtc', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                toPeer: 'receiver',
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' }),
        ...toHandedOverAssertions(sender, 'observe-acknowledged-1'),
        ...HAND_OVER.map(([field, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-fallback-${field}-1`,
                resultName: 'observe-acknowledged-1',
                field: `carrierFallback.${field}`,
                operator: 'equals',
                expected
            })
        ),
        toRtcDropFaultCommand(sender, 'release-rtc', 0)
    ];
}

/**
 * The receiver states its admission outcome as it admits the copy, around the delivery; a wait also matches a past
 * event, so the control budget costs nothing once the outcome is in the buffer.
 */
function toUnicastFallbackReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        toAdmissionOutcomeWait(receiver, {
            name: 'ws-arrival',
            contains: '"carrier":"ws","outcome":"committed","reason":"admitted"',
            timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, receiver.input.deadlineMs)
        })
    ];
}
```

    Create `scenarios/server-command.ts`:

```ts
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
import {
    toAddresseeReceiptAssertions,
    toAdmissionCommands,
    toObserveCommand,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/** The server is no RTC peer: an RTC strategy refuses a send addressed to it before admission (C9). */
const SERVER_COMMAND_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];

/**
 * D57 as applied: a `command` addressed to the WS server by its role ends `acknowledged` on the server's own ACK, and
 * the server keeps it, so the room's other member receives nothing for the whole window.
 */
export const serverCommand: AlmConformanceScenarioDefinition = {
    scenarioId: 'server-command',
    scenarioKey: 'server-command',
    tags: FULL_TAGS,
    carriers: SERVER_COMMAND_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toServerCommandSenderCommands,
    toRecipientCommands: (
        receiver
    ) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true })]
};

function toServerCommandSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                toPeer: 'server',
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' }),
        ...toAddresseeReceiptAssertions(sender, 'observe-acknowledged-1')
    ];
}
```

    Create `scenarios/capacity.ts`:

```ts
import {
    AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    CONNECT_READINESS_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    RESPONSE_MARGIN_MS
} from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toConnectCommand } from '../alm-conformance-session-commands.ts';
import { toCommandId } from '../alm-conformance-step-identities.ts';

/** Close to the 64 KiB payload bound, so the scenario's own sends decide the lowered byte bound. */
const CAPACITY_FILLER = 'x'.repeat(45_000);
/**
 * Two sends of ≈45.6 KB fit with ≈39 KB to spare for what the session receives meanwhile (C4 counts it); a third
 * never fits. The count bound keeps its constant, so bytes alone decide.
 */
const CAPACITY_LIMITS: ALVolatileSessionLimits = {
    maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
    maxBytes: 128 * 1024
};
const ADMITTED_INDEXES = [1, 2] as const;
const REFUSED_INDEX = 3;
const REFUSAL = [['failure.kind', 'refused'], ['failure.reason', 'capacity'], [
    'attempts',
    0
]] as const;

/**
 * D74 and D78: the sender reconnects under a lowered bound, sends up to it, and the next send ends `rejected` with
 * `refused`/`capacity`, no carrier attempt and so no fallback; the receipts of the admitted ones still arrive. A
 * session reads its bound once, when it initialises, so the sender closes first and restores the constants after.
 */
export const capacity: AlmConformanceScenarioDefinition = {
    scenarioId: 'capacity',
    scenarioKey: 'capacity',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toCapacitySenderCommands,
    toRecipientCommands: toCapacityReceiverCommands
};

function toCapacitySenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toReconnectCommands(sender, 'lowered', CAPACITY_LIMITS),
        ...ADMITTED_INDEXES.flatMap((
            index
        ) => [toCapacitySend(sender, index), ...toAdmissionCommands({ ...sender, index })]),
        toCapacitySend(sender, REFUSED_INDEX),
        toObserveCommand({ ...sender, index: REFUSED_INDEX, state: 'rejected' }),
        toResultAssertion({
            step: sender,
            name: `assert-status-${REFUSED_INDEX}`,
            resultName: `send-${REFUSED_INDEX}`,
            field: 'status',
            operator: 'equals',
            expected: 'rejected'
        }),
        ...REFUSAL.map(([field, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-${field.replace('.', '-')}-${REFUSED_INDEX}`,
                resultName: `observe-rejected-${REFUSED_INDEX}`,
                field,
                operator: 'equals',
                expected
            })
        ),
        ...ADMITTED_INDEXES.flatMap((index) => toAcknowledgedCommands(sender, index)),
        ...toReconnectCommands(sender, 'restored', undefined)
    ];
}

function toReconnectCommands(
    sender: AlmConformanceStepInput,
    name: 'lowered' | 'restored',
    limits: ALVolatileSessionLimits | undefined
): readonly RallarBlackBoxTestCommand[] {
    const connect = toConnectCommand(sender);
    return [
        { kind: 'close', commandId: toCommandId(sender, `close-before-${name}`) },
        {
            ...connect,
            commandId: toCommandId(sender, `connect-${name}`),
            rallar: limits === undefined
                ? connect.rallar
                : {
                    ...connect.rallar,
                    almVolatileLimits: {
                        maxAdmissions: limits.maxAdmissions,
                        maxBytes: limits.maxBytes
                    }
                }
        }
    ];
}

function toCapacitySend(sender: AlmConformanceStepInput, index: number): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index,
        payload: {
            marker: sender.scenarioId,
            carrier: sender.input.carrier,
            index,
            filler: CAPACITY_FILLER
        },
        delivery: {
            ack: 'receiver',
            ttlMs: NON_EXPIRING_TTL_MS,
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
}

function toAcknowledgedCommands(
    sender: AlmConformanceStepInput,
    index: number
): readonly RallarBlackBoxTestCommand[] {
    return [
        toObserveCommand({ ...sender, index, state: 'acknowledged' }),
        toResultAssertion({
            step: sender,
            name: `assert-acknowledged-${index}`,
            resultName: `observe-acknowledged-${index}`,
            field: 'state',
            operator: 'equals',
            expected: 'acknowledged'
        })
    ];
}

/** The receiver's window opens before the sender's reconnect, so it also owns one RTC readiness budget. */
function toCapacityReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const timeoutMs = receiver.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS +
        CONNECT_READINESS_TIMEOUT_MS;
    return [{
        ...toReceivedCommand({
            ...receiver,
            index: 1,
            count: ADMITTED_INDEXES.length,
            absent: false
        }),
        windowMs: timeoutMs - RESPONSE_MARGIN_MS,
        timeoutMs
    }];
}
```

    The refused send is never submitted, which `attempts equals 0` proves, so the receiver runs no absence window
    for it (Step 30's wall-time budget depends on that).

- [ ] **Step 21: Register them, and the hosted entry.** In `alm-conformance-scenario-definition.ts:18-32` make the
      union:

```ts
export type AlmConformanceScenarioId =
    | 'bounded-rejection'
    | 'capacity'
    | 'cross-carrier-duplicate'
    | 'deadline-expiry'
    | 'delivery-baseline'
    | 'delivery-lifecycle'
    | 'delivery-reload'
    | 'durable-opt-in'
    | 'fallback-within-deadline'
    | 'no-fallback-after-deadline'
    | 'not-yet-in-sync'
    | 'ordering-resync'
    | 'receipt-exhausted-fallback'
    | 'receipted-audience'
    | 'server-command'
    | 'unicast-fallback'
    | 'volatile-default'
    | 'ws-unicast-receipt';
```

    In `create-alm-conformance-recipes.ts` import the four definitions among the scenario imports (`:30-43`,
    alphabetical by path: `capacity` after `bounded-rejection`, `server-command` after `receipted-audience`,
    `unicast-fallback` after it, `ws-unicast-receipt` after `volatile-default`; `npx dprint fmt` sorts them by path in
    any case) and make `ALM_CONFORMANCE_SCENARIOS` (`:75-90`, keeping
    its doc comment):

```ts
const ALM_CONFORMANCE_SCENARIOS: readonly AlmConformanceScenarioDefinition[] = [
    volatileDefault,
    boundedRejection,
    deadlineExpiry,
    deliveryBaseline,
    deliveryLifecycle,
    durableOptIn,
    deliveryReload,
    orderingResync,
    ...crossCarrierDuplicate,
    ...notYetInSync,
    fallbackWithinDeadline,
    receiptExhaustedFallback,
    noFallbackAfterDeadline,
    wsUnicastReceipt,
    unicastFallback,
    serverCommand,
    capacity,
    ...receiptedAudience
];
```

      `capacity` is the last two-agent scenario of each carrier: it is the only one that closes and reconnects the
      sender, so a failed restore can reach no scenario after it in the lane's run of that carrier.

      In `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts` add after
      `ALM_CONFORMANCE_DEADLINE_MS` (`:37`):

```ts
/** Also each combined root's execution budget (distributed-run-commands.ts), so it bounds the whole hosted run. */
const ALM_CONFORMANCE_2_AGENT_TERMINAL_TIMEOUT_SECONDS = 1_200;
```

    and in `createAlmConformance2AgentEntry` (`:53-87`) make the description

```ts
description: 'ALM conformance family (the volatile default, bounded rejection, deadline expiry, delivery ' +
    'baseline, lifecycle, the durable opt-in, durable reload, ordering resync, the cross-carrier duplicate, ' +
    'not-yet-in-sync, fallback within the deadline: a dropped RTC leg, a spent RTC receipt, and no ' +
    'fallback after the deadline, and the addressed sends: a command to the receiver, its unicast ' +
    'fallback, a command to the server, and the volatile session bound) across ws, rtc, and ' +
    'rtc-with-ws-fallback carriers.',
```

      and `recommendedTerminalTimeoutSeconds: ALM_CONFORMANCE_2_AGENT_TERMINAL_TIMEOUT_SECONDS,` (`:82`). The combined
      composition needs nothing else: `toCombinedAlmConnect` spreads each connect's own `rallar` (`:290-294`), so the
      lowered `almVolatileLimits` survives, and each block's leading commands are not fault injections for `capacity`
      (it starts with `close`), so its `armed` barrier follows `start` directly (`:247-255`).

      The 300 s figure: the current 31 blocks already hold 513 s of absence windows (a sum over the checked-in absent
      manifest's `messages.received` windows and absent waits, the longest role per block), and the value is also the
      combined roots' `timeoutMs`
      (`apps/rallar-black-box-control-server/src/distributed/distributed-run-commands.ts:82-95`), so a hosted run of
      manifest 18 times out at 300 s today. This task adds 8 blocks (ws 3, rtc 2, fallback 3) and 17 s of windows
      (`server-command`'s): a 530 s floor. The lane's widest cell measured 7.1 min (426 s) for 15 two-agent scenarios
      over 231 s of absence windows (the 14 blocks manifest 18 also runs; `not-yet-in-sync-delivered-after-refresh`
      holds none), 11-13 s of other work per scenario; 530 + 39 × 13 + 3 × 20 (the reload checkpoints' page reloads)
      ≈ 1 097 s, before the 78 barrier round trips per role and `capacity`'s six reconnects that the lane figure does
      not contain, rounded up to 20 minutes, 1 200 s, which leaves ≈8 % for slower hosted runners.

- [ ] **Step 22: The pinned lists.** In `packages/tests/shared-test/alm-conformance-recipes.test.ts`:
  - `SCENARIO_KEYS_BY_CARRIER` (`:116-157`): append `'ws-unicast-receipt', 'server-command', 'capacity'` to `ws`,
    `'ws-unicast-receipt', 'capacity'` to `rtc`, and `'ws-unicast-receipt', 'unicast-fallback', 'capacity'` to
    `rtc-with-ws-fallback`;
  - in `'adds the send budget only to positive receive windows…'` (`:247-272`) add beside `durableOptInReceived1`

```ts
// The capacity sender reconnects before it sends; that wait is pinned in alm-conformance-addressed-scenarios.
const capacityReceived1 = command.commandId?.endsWith('capacity-receiver-received-1') === true;
```

    and make the skip `if (durableOptInReceived1 || capacityReceived1) {`;

- in `'keeps reload and ordering-resync full-only…'` (`:326-375`) add
  `'ws-unicast-receipt', 'unicast-fallback', 'capacity',` after `'no-fallback-after-deadline',` in the fallback
  non-smoke list, and make the `rtc` tags list six `['smoke', 'full']` followed by ten `['full']` (reload,
  ordering-resync, the two not-yet-in-sync variants, `ws-unicast-receipt`, `capacity`, and the four
  receipted-audience keys).

  In `packages/tests/shared-test/alm-conformance-recipe-validation.test.ts` add the doc-comment line
  `* The addressed family (C11) runs on two agents: server-command over ws only, unicast-fallback on the fallback cell.`
  (`:20-24`) and insert before each `...Array.from(… 'receipted-audience' …)` entry (`:25-68`):
  `'ws-unicast-receipt', 'server-command', 'capacity',` for `ws`, `'ws-unicast-receipt', 'capacity',` for `rtc`,
  `'ws-unicast-receipt', 'unicast-fallback', 'capacity',` for `rtc-with-ws-fallback` (14, 16 and 22 ids).

  In `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`, case
  `'adds the ALM conformance 2-agent manifest…'` (`:1146-1220`):
- make `metadata.scenarios` (`:1170-1184`, the array inside `toMatchObject({ … })`; the `});` after it stays):

```text
scenarios: [
    'delivery-reload',
    'volatile-default',
    'bounded-rejection',
    'deadline-expiry',
    'delivery-baseline',
    'delivery-lifecycle',
    'durable-opt-in',
    'ordering-resync',
    'ws-unicast-receipt',
    'server-command',
    'capacity',
    'not-yet-in-sync',
    'cross-carrier-duplicate',
    'fallback-within-deadline',
    'receipt-exhausted-fallback',
    'no-fallback-after-deadline',
    'unicast-fallback'
]
```

- make `expect(rtcConnects).toHaveLength(5);` (`:1200`) `toHaveLength(11)` with the comment
  `// Two prologues, three reload reconnects, and the capacity sender's lowered and restored connect per carrier.`;
- add after the `not-yet-in-sync-expires` loop (`:1194-1196`):

```ts
// The server is no RTC peer (C9), so only the ws block addresses it.
expect(commandIds).toContain('alm-ws-server-command-sender-send-1');
expect(
    commandIds.some((commandId) => /^alm-rtc(-with-ws-fallback)?-server-command-/.test(commandId))
).toBe(false);
expect(entry?.manifest.metadata?.recommendedTerminalTimeoutSeconds).toBe(1_200);
```

    In `packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts` make the two-agent `scenarioKeys`
    (`:62`) `['delivery-baseline', 'delivery-reload', 'ws-unicast-receipt', 'capacity']`, import
    `AL_VOLATILE_SESSION_MAX_ADMISSIONS` and the type `RallarBlackBoxTestRtcConnectCommand`, and add to the first
    `describe`:

```ts
it('keeps the capacity sender\'s lowered volatile limits through the combined connect, then restores them', () => {
    const sender = createAlmConformance2AgentEntry().manifest.recipes
        .find((selection) => selection.role === 'sender')!.recipe as RallarBlackBoxTestRecipe;
    const connects = sender.commands.filter((
        command
    ): command is RallarBlackBoxTestRtcConnectCommand =>
        command.kind === 'rtc.connect' && command.commandId?.includes('-capacity-sender-') === true
    );

    expect(connects.map((command) => [command.commandId, command.rallar?.almVolatileLimits]))
        .toEqual(
            ['ws', 'rtc', 'rtc-with-ws-fallback'].flatMap((carrier) => [
                [`alm-${carrier}-capacity-sender-connect-lowered`, {
                    maxAdmissions: AL_VOLATILE_SESSION_MAX_ADMISSIONS,
                    maxBytes: 131_072
                }],
                [`alm-${carrier}-capacity-sender-connect-restored`, undefined]
            ])
        );
    expect(connects.every((command) => command.readiness?.minReadyPeers === 1)).toBe(true);
});
```

    In `packages/tests/rallar-black-box/alm-reload-manifest.test.ts` make `:20` `.toBe(1_200)` and the two
    `timeoutMs: 300_000` of the bound pair (`:29`, `:37`) `timeoutMs: 1_200_000`.

- [ ] **Step 23: The fixtures that stand in for a page.** Add `carrierFallback: undefined,` after
      `relayRejection: undefined,` in every typed observation literal: `live-rtc-control-client.test.ts` (`:212`,
      `:324`, `:435`, `:502`, `:698`, `:763`), `packages/tests/shared-test/alm-lifecycle-recipes.test.ts:116`, and
      `toReceiptsFabricatedValue` in `apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts:408`. In
      that file make the root budget pins (`:87-88`) `assertEquals(sender.command.timeoutMs, 1_200_000);` and
      `assertEquals(receiver.command.timeoutMs, 1_200_000);`, and `:120`/`:127` `now = queuedAt + 1_199_999;` and
      `now = queuedAt + 1_200_000;` (Step 21's terminal budget is the roots' execution budget).

      `apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts` answers every command of
      manifest 18 from fixture ports, so it must answer the new ones. Make `PortMessage` (`:28-35`):

```ts
interface PortMessage {
    readonly command: RallarBlackBoxTestMessagesSendCommand;
    readonly msgId: string;
    state: string;
    submitted: boolean;
    attemptCarriers: readonly ('rtc' | 'ws')[];
    attemptOutcomes: readonly ('not-ready' | 'sent')[];
    /** The volatile bound's refusal (D78); undefined for every send it admits. */
    readonly failure: Readonly<{ kind: 'refused'; reason: 'capacity'; }> | undefined;
    carrierFallback:
        | Readonly<{ from: 'rtc'; to: 'ws'; reason: HandedOverOutcome['fallbackReason']; }>
        | undefined;
}
```

    add `readonly fallbackReason: 'not-ready' | 'receipt-exhausted';` to `HandedOverOutcome` (`:37-42`), and make
    `HANDED_OVER_WS_OUTCOMES` (`:48-51`, adding "An addressed `unicast-fallback` hands over the same way." to its
    doc comment):

```ts
const HANDED_OVER_WS_OUTCOMES: Readonly<Record<string, HandedOverOutcome>> = {
    'fallback-within-deadline': {
        outcome: 'committed',
        reason: 'admitted',
        attemptOutcomes: ['not-ready', 'sent'],
        fallbackReason: 'not-ready'
    },
    'receipt-exhausted-fallback': {
        outcome: 'not-handled',
        reason: 'duplicate',
        attemptOutcomes: ['sent', 'sent'],
        fallbackReason: 'receipt-exhausted'
    },
    'unicast-fallback': {
        outcome: 'committed',
        reason: 'admitted',
        attemptOutcomes: ['not-ready', 'sent'],
        fallbackReason: 'not-ready'
    }
};
```

    In `executePort` add before `case 'barrier':` (`:185`):

```ts
case 'close':
    return { status: 'ok', value: { status: 'closed' } };
```

    make the `messages.observe` value (`:148-155`):

```ts
value: {
    handleId: command.handleId,
    state: message?.state ?? 'unobservable',
    enqueued,
    submitted: message?.submitted ?? false,
    attempts: message?.attemptCarriers.length ?? 0,
    attemptCarriers: message?.attemptCarriers ?? [],
    attemptOutcomes: message?.attemptOutcomes ?? [],
    failure: message?.failure,
    carrierFallback: message?.carrierFallback,
    ...(message?.command.toPeer !== undefined && message.state === 'acknowledged'
        ? toAddresseeReceipt(message.command.toPeer)
        : {})
}
```

    add at the top of the `messages.receipts` case, after `assert(message);` (`:164`):

```ts
if (message.command.toPeer !== undefined) {
    return { status: 'ok', value: toAddresseeReceipt(message.command.toPeer) };
}
```

    make the `arrived` line of `messages.received` (`:179`):

```ts
// A command addressed to the server reaches no member of the room.
const arrived = this.messages.filter((message) =>
    message.command.typeId === command.typeId && message.submitted &&
    message.command.toPeer !== 'server'
);
```

    in `send` (`:251-285`) replace the `rejected` line with

```ts
// The lowered volatile bound refuses the third capacity send at admission (D78): no attempt, nothing delivered.
const capacityRefused = command.payload.marker === 'capacity' && command.payload.index === 3;
const rejected = command.payload.marker === 'bounded-rejection' || capacityRefused;
```

    add `failure: capacityRefused ? { kind: 'refused', reason: 'capacity' } : undefined,` and
    `carrierFallback: undefined` to the `message` literal, add a branch after the `handedOver` one:

```ts
else if (command.toPeer === 'server') {
    this.acknowledgeByServer(message);
}
```

    and make the returned `reason`
    `capacityRefused ? 'The volatile session bound refused the admission.' : rejected ? 'Payload exceeds fixture carrier limit' : undefined`.
    In `handOver` add `message.carrierFallback = { from: 'rtc', to: 'ws', reason: handedOver.fallbackReason };`
    after `message.attemptOutcomes = …`, add after `handOver`:

```ts
/** The server keeps a command addressed to itself and answers it with its own ACK; no member receives it. */
private acknowledgeByServer(message: PortMessage): void {
    message.submitted = true;
    message.state = 'acknowledged';
}
```

    and add after the class:

```ts
/** An addressed send's receipt names its one addressee: the server itself, or the receiver's stored session. */
function toAddresseeReceipt(toPeer: 'server' | 'receiver') {
    const addressee = toPeer === 'server' ? 'server-peer' : 'receiver-stored-session';
    return {
        receiptMode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: [addressee],
        confirmedRecipientPeerIds: [addressee],
        unconfirmedRecipientPeerIds: []
    };
}
```

    `ws-unicast-receipt` now pins its receipt roles in manifest 18, so the hosted rollup joins them: the fixture's
    receiver connects as `receiver-stored-session` (`:120`, `:124-126`), which the receipt names, and the case still
    ends `passed` for a fresh document and `failed` (the document identity) otherwise.

- [ ] **Step 24: Regenerate manifest 18.** Run (unsandboxed: the generator writes JSON)
      `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`, then
      `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`.
      `git status --short apps/rallar-black-box/manifests` must list only `18-alm-conformance-2-agent.json`. Read its
      metadata: 17 scenario ids, `recommendedTerminalTimeoutSeconds` 1200; and count 78 `barrier` commands per role
      (`jq '[.recipes[0].recipe.commands[] | select(.kind == "barrier")] | length'
      apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json` prints 78; before this task, 62).

- [ ] **Step 25: GREEN.** Run the Step 18 command, then:

```bash
npx vitest run packages/tests/shared-test packages/shared-rtc-bench/tests \
  packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts \
  packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts \
  packages/tests/rallar-black-box/alm-reload-manifest.test.ts \
  packages/tests/rallar-black-box/live-rtc-control-client.test.ts \
  packages/tests/rallar-black-box/browser-rallar-runtime.test.ts \
  packages/tests/shared-web/composition packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts
(cd apps/rallar-black-box-control-server && deno task check && deno task test test/control-generated-alm-reload.test.ts test/control-alm-evidence.test.ts)
```

    Expected: every Vitest file passes (read the summary line) and both Deno files pass. Drop the
    `packages/shared-rtc-bench/tests` path if Vitest reports no test in it for this filter; it is there so the sweep
    is not the `packages/tests/`-only subset.

- [ ] **Step 26: The lane spec reads identity evidence from the scenario, not from a list of ids, and runs the
      addressed family on its own.** In
      `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts` add after the
      `assessAlmConformanceIdentity` import (`:21`):

```ts
import { readAlmReceiptRolesEntries } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
```

    and replace `hasIdentityEvidence` (`:254-257`):

```ts
/** Lifecycle and reload join message identities; a scenario that pins its receipt's roles joins recipient sessions. */
function hasIdentityEvidence(scenario: AlmConformanceScenario): boolean {
    return scenario.scenarioId === 'delivery-lifecycle' ||
        scenario.scenarioId === 'delivery-reload' ||
        readAlmReceiptRolesEntries(scenario.sender).length > 0;
}
```

    Every `receipted-audience` key declares `toReceiptRoles`, so the three-agent family is assessed as before, and
    `ws-unicast-receipt` joins the addressed family's assessment.

    The four addressed scenarios run as their own two-agent family (R-S3c-ii-5), so the baseline two-agent test's
    wall time does not grow: `ScenarioFamily` (`:56`) becomes `'two-agent' | 'addressed' | 'three-agent'`;
    `selectScenarios` (`:305-320`) puts a two-role scenario whose `scenarioId` is `ws-unicast-receipt`,
    `unicast-fallback`, `server-command` or `capacity` in `'addressed'` and every other two-role scenario in
    `'two-agent'`; `runAlmConformanceScenarios` (`:183-186`) takes the family it runs, and the baseline test passes
    `'two-agent'`; and a third ``test(`addressed family over ${carrier} (${scope})`, …)`` beside the baseline one runs
    `'addressed'` on its own `createTwoAgentRun` (run id `` `alm-${carrier}-addressed-${uniqueSuffix()}` ``) with
    `test.setTimeout(CARRIER_TEST_TIMEOUT_MS)`, skipped like the three-agent test when it selects nothing (every smoke
    scope), and records its observation with `family: 'addressed'` (`toObservationFileName`, `:457-460`, suffixes
    every family but `two-agent`). No scenario is added to the smoke scope.

- [ ] **Step 27: Docs.** In `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`, "## ALM Commands":
  - make the optional list of `messages.send` (`:152-154`) end `` `minSnapshotVersion`, `qos` and `toPeer`. ``;
  - replace "Supersedence (`key`) and unicast targeting (`toPeerId`) are not part of this release; naming either one
    fails recipe validation." (`:160-162`) with:

```markdown
Supersedence (`key`) is not part of this release, and neither is a literal peer id (`toPeerId`), which no recipe
knows when it is written; naming either one fails recipe validation. `toPeer` addresses one peer by its lane role
instead: `server` is the id the WS server answers as (`serverPeerId()`, learned from `/api/config`), and `receiver`
is the one other live session of the connection's room, read from the page's cached roster with the page's own
session left out. The page resolves the role at send time and hands the product's typed send `{ peerId }` on a channel
opened with purpose `command`, the purpose a product addresses one peer with; the recipe's own `ack` still wins. A
role the page cannot resolve (no server id, or a roster without exactly one other live session) fails the command
with `RALLAR_BLACK_BOX_ALM_PEER_UNRESOLVED` and opens no handle. The roster names no role, so a room with two
recipients has no resolvable `receiver`, and the three-agent family addresses no peer. The server is no RTC peer:
`toPeer: 'server'` on `rtc` or `rtc-with-ws-fallback` is refused before admission.
```

- add `toPeer` to the fields a replay refuses (`:186-190`: "…`minSnapshotVersion`, `qos` and `toPeer` are each
  refused beside it…");
- in the observation paragraph (`:343-346`) add `carrierFallback` after `relayRejection` in the field list, and
  after the `failure` paragraph Task 1 inserted after the sentence on `relayRejection` (before
  `` `backpressured` is true when a carrier ``):

```markdown
`carrierFallback` is present once the strategy handed an admitted message to its second carrier (D56):
`{ from, to, reason, atMs, detail }`, with `reason` one of `not-ready`, `not-yet-in-sync-exhausted` and
`receipt-exhausted`. A refusal at admission, such as the volatile bound's `capacity`, is no hand-over, so it
leaves `carrierFallback` absent and `attempts` at 0.
```

- after the fallback-family paragraph (`:320-332`) add:

```markdown
The addressed family runs on two agents, in the full scope (C11). `ws-unicast-receipt` runs over every carrier: the
sender sends a `command` to `toPeer: 'receiver'` and observes `acknowledged` under the `receiver` mode with one
expected and one confirmed recipient; its recipe metadata `almReceiptRoles` pins the receipt to the `receiver` role,
which the identity assessment joins to the receiver's session after the run. `unicast-fallback` (`rtc-with-ws-fallback`)
drops the sender's own RTC frames of the unicast until the third `not-ready` attempt hands it to WS; the sender reads
`attemptCarriers` containing `rtc` and `ws` and `carrierFallback` `{ from: 'rtc', to: 'ws', reason: 'not-ready' }`,
and the receiver receives the copy and reads its `admission-outcome` `committed`/`admitted` on carrier `ws`.
`server-command` (`ws` only) sends a `command` to `toPeer: 'server'` and observes `acknowledged` on the server's own
ACK, while the receiver proves for the whole window that nothing reaches it. `capacity` runs over every carrier: the
sender closes, reconnects with `rallar.almVolatileLimits` `{ maxAdmissions: 1000, maxBytes: 131072 }`, sends two
≈45 KB messages that are admitted and acknowledged, and a third that ends `rejected` with
`failure: { kind: 'refused', reason: 'capacity' }` and `attempts` 0, so no fallback; then it closes and reconnects
without the field, restoring the constants. Its receiver waits for the two arrivals with one more readiness budget,
since the sender reconnects before it sends.
```

- after "### The `messages.ws` Connect Transport" (`:436-442` on main, about `:442-448` after Task 1) add:

```markdown
### The lane-only `rallar.almVolatileLimits` connect field

`rtc.connect.rallar.almVolatileLimits` is `{ maxAdmissions, maxBytes }`, each a positive integer, and nothing else;
any other shape fails the connect. It lowers the ALM volatile bound (D74) of the session this connect initialises: the
page holds it and hands the browser session a read port that the session reads once, when it initialises. It is a
harness capability, never a `rallar.connect` option. A facade that is already connected keeps the bound its session
read, so a recipe closes the connection before a connect that names the field, and closes and reconnects without it
to restore the constants (`AL_VOLATILE_SESSION_MAX_ADMISSIONS`, `AL_VOLATILE_SESSION_MAX_BYTES`).
```

- [ ] **Step 28: The gates.**

```bash
npm run test:unit
npm run typecheck
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
npx dprint check <every file this task touched, listed explicitly>
(cd apps/api-v1 && deno task check)
(cd apps/rallar-black-box-control-server && deno task check)
(cd apps/relic-hunter-server-v1 && deno task check)
npm run test:deno
npm run test:repo-governance
```

    Expected: each passes; read the Vitest and Deno summary lines, not the exit codes. `npm run typecheck` includes
    `typecheck:tests` (the `packages/tests` ratchet), which is where the typed fixtures of Step 23 are checked. If
    the coupling check names a new candidate in a touched test file, commit its registry entry in
    `docs/test-structure-coupling-exceptions.md` first, as that document's instructions say. If the style check
    reports `browser-rallar-runtime-composition.ts` or `browser-adapter-alm-commands.ts` worse, move the new lines
    into a file beside the owner rather than registering an exception.

- [ ] **Step 29: The bundles.** The page runtime ships in the headless app bundle.

```bash
npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
  packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts \
  packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
```

    Expected: the snapshots and the facade budget do not move (no `@shared-web` export changes). If the headless
    measure crosses the ceiling it asserts (`expect(result.brotliKiB).toBeLessThan(N)`,
    `headless-bundle-boundary.test.ts:83`), raise `N` to the next whole KiB and append to the comment above it
    "The S3c-ii lane peer role and volatile-limits read port measure <figure> KiB here. The next whole-KiB ceiling is
    <N>."; state the figure in the commit body.

- [ ] **Step 30: The lanes.** Unsandboxed, one lane runner at a time on ports 18080/5180, no edits while it runs; read
      the Playwright summary and each test's duration.
  - `RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm` — every smoke cell as before
    (no new smoke scenario).
  - `RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=ws npm run -s test:rallar:full-stack:memory:alm`,
    then the same with `rtc`, then with `rtc-with-ws-fallback` — `ws-unicast-receipt`, `server-command` (ws),
    `unicast-fallback` (fallback) and `capacity` green, the identity assessment of `ws-unicast-receipt` clean, and
    every earlier cell as before.

    Record in the commit body, per carrier, the baseline two-agent test's duration beside its duration before this
    task (the spec's comment records 7.0–7.1 min for the fallback cell; the split of Step 26 leaves it unchanged) and
    the new addressed test's duration. **Stop rules**, each brought to the controller with the evidence, no
    expectation edited and no harness budget widened: either two-agent test of the fallback cell above 465 s (within
    15 s of the fixed `CARRIER_TEST_TIMEOUT_MS`); `capacity` refusing its first or second send (the
    session received more than ≈39 KB of other volatile data while the bound was low — read the sender's `failure`
    and the page diagnostics' inbound admissions); `ws-unicast-receipt` failing with
    `RALLAR_BLACK_BOX_ALM_PEER_UNRESOLVED` (the sender's cached roster did not hold exactly one other live session;
    the failure message states the count).

- [ ] **Step 31: Commit and push.**

```bash
git add packages/shared-test/rallar-bb-test packages/shared-test/black-box-runner/browser/rallar-browser-runtime \
  packages/tests/shared-test packages/tests/shared-web/composition/browser-runtime-construction.test.ts \
  packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts \
  packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/rallar-black-box/live-rtc-control-client.test.ts \
  packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts \
  packages/tests/rallar-black-box/alm-reload-manifest.test.ts \
  apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts \
  apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json \
  apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts \
  apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts \
  tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts
git status --short   # also stage headless-bundle-boundary.test.ts or docs/test-structure-coupling-exceptions.md if Steps 28-29 changed them
git commit -m "test(alm): the addressed-send lane -- a command to a peer by its role, its unicast fallback, a command to the server, and the volatile bound (C11)"
git push origin HEAD:codex/queuebox-persistence-qos-product-plan
```

    The commit body lists the lane durations (Step 30), manifest 18's new floor and terminal budget (530 s, 1 200
    s), and the headless figure when Step 29 moved it.

**Corrections found while writing:**

1. **The roster cannot name `recipient-b`** (C11's third value). `GroupPresenceSession`
   (`packages/shared/api/group-types.ts:209-236`) carries a session id, a principal, a generation and timestamps, no
   role; the lane starts a three-agent run's two recipients in parallel (`full-stack-three-agent-run.ts:70-73`), so
   join order is no signal; and hosted agents may all log in as one user (`09-start-headless-workers.sh:121-124`), so
   the principal is none either. `toPeer` is `'server' | 'receiver'`, `receiver` resolves only while exactly one other
   live session is in the room, and all four scenarios run on two agents. R-S3c-ii-2 amends C11 and the
   ledger's "`toPeer: 'server' | 'receiver' | 'recipient-b'`"; a three-agent addressed scenario would need an observed
   peer id (a `{resultCache…senderId}` token, as `messages.control.toPeerId` takes), which is a later decision.
2. **The connect config's `rallar.peerIds` cannot serve as the page's source** (task brief's first option): a recipe
   is written before any session exists, so the page resolves from the room roster
   (`rooms/room-state-store.ts:146-153`), keyed by session id.
3. **The black-box observation has no `carrierFallback` today** (`black-box-rallar-operation-contracts.ts:361-376`,
   `black-box-rallar-delivery-ledger.ts:43-68`), though `ALDeliveryEvidence` has one (`al-delivery-lifecycle.ts:279`);
   this task adds it to the observation, the result value, its decoder and the capability text.
4. **The limits reader cannot read the runtime's connection state**: the connect operation records the state only
   after `rallar.connect` returns (`black-box-rallar-connect-operation.ts:133-142` against `:185`), and a CRDT live
   connect also initialises the session (`black-box-rallar-crdt-live-connection.ts:63-74`). Both run
   `configureBlackBoxRallarConnection` first, so that is where the read port's value is set.
5. **A session reads its limits once and the facade reuses its middleware across connects**
   (`session/session-connection-lifecycle.ts:80-84`), so lowering the bound in the lane needs `close` and a reconnect,
   and restoring it needs a second pair (`capacity` is the only scenario that does this).
6. **Manifest 18's 300 s never held**: its 31 blocks hold 513 s of absence windows, and the figure is also the
   combined roots' execution budget (`distributed-run-commands.ts:82-95`, pinned at 300 000 ms by
   `control-alm-evidence.test.ts:87-88,120-127` and at 300 by `alm-reload-manifest.test.ts:20`), so the root times out
   at 300 s. Raised to 1 200 s with the arithmetic in Step 21.
7. **C4 counts received data admissions, so a count bound is not a lane control**: every WS inbox message the session
   receives is admitted through the inbound lane (`ws-queue-box-client-service.ts:660-663`,
   `websocket/browser-websocket-inbox.ts:30-45`), so the lowered bound is a byte bound with ≈39 KB of headroom and the
   count bound keeps its constant. Task 3 exempts only messages that name no deadline, so a server event with a
   deadline counts against that headroom.
8. **"The strict recipe preflight" for these recipes is the schema and control-protocol validation**
   (`alm-conformance-recipe-validation.test.ts:88-140`) plus the manifest `--check` and the manifest schema test;
   `scenario-black-box.ts --validate --strict` covers black-box-runner JSON recipes, which this task does not touch.
9. **`control-generated-alm-reload.test.ts` executes every command of manifest 18 through fixture ports** and throws
   on an unknown kind (`:192-193`), so `close`, the addressed sends, the refusal and the hand-over evidence need
   fixture answers (Step 23); survey F1 names only its `:48-51` map.
10. **Survey F1's list misses four pins that move**: `alm-reload-manifest.test.ts:20`,
    `control-alm-evidence.test.ts`'s root budget, the typed observation fixtures (`live-rtc-control-client.test.ts`,
    `alm-lifecycle-recipes.test.ts:116`, `control-alm-evidence.test.ts:408`), and the ledger fixture in
    `rtc-authority-recovery.test.ts:555-575`.

---

### Task 7: Docs, the gates, the PR

**Files:**

- Modify: `packages/shared/alm/outbound/README.md`, `packages/shared/alm/inbound/README.md` (Task 2 wrote the
  relay-row figure; this task adds the rest), `playground/alm/alm-complete-product-description.md` ("### Unicast"
  `:197-206`, "## QoS negotiation" `:335-338`, "### At-least-once" `:372-376`, "## Congestion and RTC flow control"
  `:485-508`, "## Resource and abuse limits" `:679-700`, "## Observability and privacy"),
  `playground/alm/alm-improvement-plan.md` (rows D59, D60, D74, D78; new rows D91–D94, D93 recording D75; the S3 bullet `:855-864`;
  matrix rows F1 `:990`, F4 `:993`, F5 `:994`; "Consumer proofs in the games" `:965-975`; the revision history),
  `playground/alm/alm-s3-design-proposal.md` (§2.3; a new §11), `playground/alm/alm-qos-product-plan.md` (the header's
  "Reviewed source", §6, §10.3).
- Delete: `plans/active/alm-s3c-ii-director-command-and-volatile-bound.md` (Step 9, the last commit).

Line numbers are on `d5d9ac16c`; re-read each anchor before editing. Every decision-table row is exactly 516
characters wide (count characters, not bytes); a row that does not fit is split into a continuation row, and no blank
line may stand inside the table.

**Interfaces:**

- Consumes: every name Tasks 1–6 produced, and the figures they measured (the bundle figures, the relay-row figure,
  the storage counts).
- Produces: nothing a later task relies on.

- [ ] **Step 1: The outbound README.** Directly before the heading `### Grouped control sends` (the end of "### Server
      receipts on WS"), with one blank line on each side, add:

```md
### Addressed sends on RTC

Since S3c-ii a typed send names one peer on every strategy but `ws-then-rtc`: `send(payload, { peerId })`. The
envelope is one unicast that names its room (`targets.groupRef`, `route.contextId` the room id), built by
[`createBrowserUnicastMessage`](../../../shared-web/browser/messages/create-browser-unicast-message.ts). The RTC
carrier plans it to the addressee directly and never relays it. Its receipt is the addressee's own ACK. On
`rtc-with-ws-fallback` the same envelope is re-admitted on WS when the RTC leg states a retryable outcome inside the
deadline (D63): the addressee is not in the ready set (`no-route`), the addressee is connected but is not the
origin's overlay next hop (three `not-ready` attempts), or the receipt ran out. On WS the room's router delivers it
and the server aggregates the one-member receipt (D71). A peer send to the server id is refused `unsupported` on an
RTC strategy: the server is addressed over WS (D76). A peer send whose `contextId` names another room than its own is
refused at the sender.

### The volatile bound

The volatile pairs keep their owner and sent-message rows until the message deadline plus the receipt grace
([`resolveALReceiptRetentionExpiryMs`](../delivery/resolve-al-receipt-retention-expiry-ms.ts)), not for an hour. One budget per
session ([`ALVolatileSessionBudget`](../volatile-budget/al-volatile-session-budget.ts)) counts the data admissions the
session originates and receives on its volatile pairs, by message and by envelope bytes, and releases each at its own
deadline. Controls, receipts, acknowledgements, repairs, retransmissions and relay forwards are not counted. Over
`AL_VOLATILE_SESSION_MAX_ADMISSIONS` (1 000) or `AL_VOLATILE_SESSION_MAX_BYTES` (4 MiB) an outbound data admission is
refused `capacity`: the handle ends `rejected` with `evidence.failure` `{ kind: 'refused', reason: 'capacity' }`, and
no fallback is tried, because the other carrier shares the budget. An inbound admission is counted and never refused,
and it counts toward the same limits as the session's own sends: a session whose volatile traffic in and out stays
above about 33 messages a second (at the 30 s default deadline) has its own volatile sends refused. A message that
names no deadline (RTC signalling) is not counted.
While the budget is at or over a limit the session's QoS provider reports `overloaded`; under the default policy that
drops best-effort RTC sends at the origin and best-effort arrivals on both carriers (each answered with a NACK
`overloaded`), never an at-least-once message, and the WS outbound path does not consult it (V1).
```

- [ ] **Step 2: The inbound README.** After the relay-row figure Task 2 recorded, add: "An inbound data admission on
      the volatile pair is recorded in the session's volatile budget and released at the message deadline; it is never
      refused for capacity (D74, D78)."

- [ ] **Step 3: The product description.**
  - "### Unicast": replace the sentence "The RTC unicast and the unicast fallback are S3c-ii's." with
    "**CURRENT — S3c-ii, addressed sends on every carrier:** a typed send names one peer with `{ peerId }`; on RTC the
    unicast travels directly to its addressee and is never relayed, and on `rtc-with-ws-fallback` it is handed to WS
    inside the deadline (D75). `ws-then-rtc` does not take a peer (V1)."
  - "## QoS negotiation": replace the paragraph "**PLANNED — S3c and V1, live providers:** ... V1's." with
    "**PARTIAL — S3c-ii, the first live provider:** the browser installs a per-session QoS provider that reports
    `overloaded` while the session's volatile budget is at or over a limit (D78). Under the default policy that drops
    best-effort RTC sends and best-effort arrivals on both carriers, never an at-least-once message. Transport-aware
    authorization, the other budgets and fairness are V1's."
  - "### At-least-once": in the paragraph beginning "The default is receipted." (`:373-380`; the phrase spans
    `:375-376`, wrapping after "and the", so re-flow with dprint after the edit), replace "because the director relay's
    WS unicast fallback and the receipt-less RTC carry rely on explicit shapes (S3a ruling 6)" with "because the
    receipt-less RTC carry relies on an explicit shape (S3a ruling 6; the director relay's WS unicast is gone since
    S3c-ii)", and append to that paragraph "A director command can reach the director twice after a fallback, because
    AL dedup is per carrier lane: relay commands are at-least-once, and the game's sequence tracker refuses the copy
    (S3c-ii, R-S3c-ii-4)."
  - "## Congestion and RTC flow control": replace the paragraph "**PLANNED — S3, integration:** ..." with
    "**PARTIAL — S3c-ii:** the caller sees the lifecycle (S1) and the session's volatile budget is the first
    `overloaded` producer (D78). Channel backpressure as a policy input is V1's."
  - "## Resource and abuse limits": after the paragraph ending "... not current guarantees." add
    "**CURRENT — S3c-ii, the volatile bound:** one session holds at most 1 000 volatile messages and 4 MiB of
    envelopes at a time, sent and received together, each counted until its deadline; over the bound the next send
    is refused `capacity`, and a received message is counted, never refused (D74, D78)."
  - "## Observability and privacy": append to the "**PARTIAL:**" paragraph, after "(S3c-i, D61, D73).", "A failed
    delivery states a typed `evidence.failure` beside its prose
    reason: the refusal reason, the unroutable reason, or whether a receipt ran out of budget or was refused by a hop
    (S3c-ii, D75)."

- [ ] **Step 4: The roadmap.** In `alm-improvement-plan.md`:
  - D59: append " **Delivered by S3c-ii (PR #606):** D74, D78, D91, D92.";
  - D60: append " **As applied (S3c-ii, PR #606):** D75, D93 — match start never travelled; two typed channels.";
  - D74, D78: append " **Delivered by S3c-ii (PR #606).**" (D78 also: " As applied: D91."); D75 has no padding left, so
    D93 records its delivery;
  - add, after the last decision row (D90), four rows, each padded to 516 characters:
    - `D91`: "S3c-ii: a send over the volatile bound ends `rejected` through the admission `refused` verdict with
      `evidence.failure` `{ kind: 'refused', reason: 'capacity' }`; `carrier-refused` stays evidence of a hand-over and
      never an end. `evidence.failure` is a discriminated union set by the reducer, and `receipt-exhausted` states its
      cause (`budget` or `hop-refused`) at its producers (2026-09-28)."
    - `D92`: "S3c-ii: the volatile budget is one ledger per session, created beside the three volatile pairs. It counts
      the data admissions the session originates or receives, releases each at its own deadline, and refuses only an
      outbound admission; controls, receipts, ACKs, repairs, retransmissions and relay forwards are exempt.
      `overloaded` is true at or over a limit and, under default QoS, drops best-effort RTC sends and best-effort
      arrivals on both carriers (2026-09-28)."
    - `D93`: "S3c-ii, delivering D75: a typed send takes `{ peerId }` on `ws`, `rtc` and `rtc-with-ws-fallback`; a
      peer send to the server id is refused on an RTC strategy; a peer send whose `contextId` names another room is refused at the
      sender. The director accepts client intents out of order (an equal sequence is a duplicate), since a retry or a
      fallback leg reorders them; intents and sync requests use two typed `command` channels (2026-09-28)."
    - `D94`: "S3c-ii: the conformance lane names a peer by role (`toPeer`: `server` or `receiver`) and lowers the
      volatile bound through a lane-only connect field, never a public connect option; manifest 18's terminal timeout
      is 1 200 s, since its absence windows alone take 513 s (2026-09-29)."
  - matrix row F1: replace "the RTC unicast is S3c-ii's." with "the RTC unicast and the unicast fallback (S3c-ii,
    PR #606).";
  - matrix row F4: append " A peer-addressed send falls back the same way (S3c-ii).";
  - matrix row F5: replace the state with "Resolved for the bound: volatile default and the memory lanes (S3a); the
    retention, the per-session bound, `refused/capacity` and the first `overloaded` producer (S3c-ii, PR #606); the
    other budgets are V1's.";
  - the S3 bullet, after the S3c-i sentence: "S3c-ii delivered by PR #606 (branch
    `codex/queuebox-persistence-qos-product-plan`): the RTC unicast and the unicast fallback, the director command for
    AR Eye Hunter's intents, the volatile retention and the per-session bound with `refused/capacity`, the typed
    `evidence.failure`, and the lane's addressed-send scenarios; its rulings are in proposal §11.";
  - "Consumer proofs in the games", row `3 S3`, AR Eye Hunter cell: replace "Match commands become a `command` channel
    with a real director receipt, volatile, zero IndexedDB proven." with "Pickup, the two combat intents and sync
    requests travel two `command` channels to the director with the director's receipt, volatile, zero IndexedDB
    proven (S3c-ii, PR #606).";
  - revision history: "- 2026-09-DD: S3c-ii delivered by PR #606: D59, D60 as applied (D74, D75, D78, D91–D94); matrix
    rows F1, F4, F5 moved." with the commit's date.

- [ ] **Step 5: The proposal.** In `alm-s3-design-proposal.md`:
  - §2.3, after the S3c-i "As applied" bullet: "**As applied (S3c-ii, PR #606):** the RTC unicast is a sender path
    over the existing direct plan; the fallback leg re-admits the same room-naming envelope; `capacity` ends
    `rejected`; the director accepts intents out of order.";
  - add "## 11. S3c-ii execution choices and rulings (2026-09-28)" holding, verbatim from this plan: the fourteen
    corrections, the table of choices C1–C17, "Alignment with the QoS plan", and every entry of "Rulings during
    execution". This section is where the rulings live after Step 9 deletes this plan file.

- [ ] **Step 6: The QoS plan.** In `alm-qos-product-plan.md`:
  - the header line "Reviewed source" (`:4`, before its trailing `\`): append "; S3c-ii (this PR) delivers the
    volatile bound its section 6 and
    hypothesis H4 name";
  - §6, after "the volatile bound (D74)": add "(delivered by S3c-ii as `ALVolatileSessionLimits`, D92)";
  - §10.3, replace the first reason "S3c-ii rewrites the layer these slices change: ..." with "S3c-ii rewrote the
    layer these slices change, the per-runtime memory and IndexedDB pairs and the per-session bound (D74, D92); P1 and
    I2a start from `main` after it."

- [ ] **Step 7: Validate the docs and commit.**

```bash
npx dprint fmt packages/shared/alm/outbound/README.md packages/shared/alm/inbound/README.md \
  playground/alm/alm-complete-product-description.md playground/alm/alm-improvement-plan.md \
  playground/alm/alm-s3-design-proposal.md playground/alm/alm-qos-product-plan.md
npx dprint check packages/shared/alm/outbound/README.md packages/shared/alm/inbound/README.md \
  playground/alm/alm-complete-product-description.md playground/alm/alm-improvement-plan.md \
  playground/alm/alm-s3-design-proposal.md playground/alm/alm-qos-product-plan.md
python3 - <<'PY'
import re
rows=[l for l in open('playground/alm/alm-improvement-plan.md',encoding='utf-8').read().split('\n') if re.match(r'^\| D\d+ ',l)]
assert {len(r) for r in rows}=={516}, sorted({len(r) for r in rows})
ids=[r.split('|')[1].strip() for r in rows]
assert len(ids)==len(set(ids)), 'duplicate decision id'
print(len(rows),'decision rows, all 516 characters')
PY
npm run test:repo-governance
npm run check:repo-style:changed -- origin/main HEAD
git add packages/shared/alm playground/alm
git commit -m "docs(alm): S3c-ii -- the director command, the volatile bound and the typed failure"
git push origin HEAD:codex/queuebox-persistence-qos-product-plan
```

Expected: dprint prints nothing, the script prints `94 decision rows, all 516 characters`, governance and the
changed-style gate pass.

- [ ] **Step 8: The push-time gate list.** On the final tree, record passed / failed / skipped for each (grep every
      summary line, never the exit code):
  - `npm run test:unit` (both Vitest roots);
  - `npm run test:deno`; `cd apps/api-v1 && deno task check`; `cd apps/rallar-black-box-control-server && deno task check`;
    `cd apps/relic-hunter-server-v1 && deno task check`;
  - `npm run typecheck`; `npm run build`; `npm --workspace relic-hunters-v1 run test`;
  - `npm run check:repo-style:changed -- origin/main HEAD`;
    `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`;
  - `npm run test:repo-governance`;
  - the public API and both bundle tests, `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
  - `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`;
  - unsandboxed: `npm run test:api-v1:black-box:memory`;
  - unsandboxed: `npm run test:e2e`, `npm run test:full-stack:memory`, `npm run test:playwright:relic`,
    `npm run test:playwright:relic:full-stack`, the ALM smoke lane, and the full lane
    (`RALLAR_BLACK_BOX_ALM_SCOPE=full npm run -s test:rallar:full-stack:memory:alm`: the baseline, addressed and
    three-agent families) on every carrier on normal pages (one lane runner at a time; the known `not-yet-in-sync-delivered-after-refresh received-1`
    red is reported, not repaired);
  - the medium-scale gate only if `packages/shared/services/ws-queue-box-server/**` changed (Q13): unsandboxed, the
    Postgres container `ar-eye-hunter-postgres` up (`docker start` it if it stopped; never `db:down`, never
    `db:test:up` from another worktree), `npm run test:api-v1:black-box:postgres:medium-scale`, its summary line
    recorded. A red is diagnosed against `main` before it is blamed on the branch.

- [ ] **Step 9: The PR, the hosted reads and the plan file.** Update PR #606 with
      `gh pr edit 606 --title "ALM S3c-ii: the director command and the volatile bound; the QoS plan (D83-D94)" --body-file <file>`
      (unsandboxed). Body sections: the QoS plan (kept from the PR's earlier body, with D83–D90); the decisions applied
      (D60, D74, D75, D78; Q9–Q13) and the choices C1–C17 as ruled, each marked as the plan's choice for the maintainer
      to confirm or overturn; the fourteen corrections; the typed failure; the retention and the bound with the
      measured relay-row figure; the RTC unicast and its fallback outcomes; the director command (what changed in the
      game: intents are accepted out of order at the director, C10); every moved or replaced pin by task; the bundle
      figures and the storage figures side by side (D87); the schema id unchanged (C16) and the deploy note (web and
      API deploy together; an old director does not subscribe the intent type ids on the ALM RTC inbox, so a new
      client's RTC command to an old director is acknowledged and parked until it expires — name it); the PR #566
      analysis (duplications, contradictions, the split, the recommendation); the gate list from Step 8; the carried
      lists; and, last, the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
      Hosted: manifest 18 changed (22 did not: every addressed scenario runs on two agents, R-S3c-ii-2), so dispatch
      the recipe workflow from the PR branch
      (`gh workflow run hetzner-distributed-recipe.yml --ref codex/queuebox-persistence-qos-product-plan -f ref=codex/queuebox-persistence-qos-product-plan -f manifest_path=apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`,
      never from `main`); the hosted smoke on both-normal runners; the hosted full read with
      `RALLAR_BLACK_BOX_ALM_SCOPE=full` set before the read and deleted after the observation job completes, at most
      twice (D51), reported under the two-regime rule and never a blocker; poll with foreground `gh run list`.
      Wait for the Branch Release Gate on the final code commit. Then, as the last commit before the maintainer's
      review, delete this plan file (`plans/README.md`: the pull request that finishes a written plan deletes it):

```bash
git rm plans/active/alm-s3c-ii-director-command-and-volatile-bound.md
git commit -m "docs(plans): S3c-ii is delivered; its rulings live in proposal section 11"
git push origin HEAD:codex/queuebox-persistence-qos-product-plan
```

    Do not run `pr:delivery -- ready` or enable auto-merge: the maintainer lands the PR. After the merge, the plan is
    complete only once **Run Hetzner Supported Distributed Manifests** passes on the resulting default-branch commit;
    record its run id in the closing report.

## Command Path

```text
typed channel send(payload, { peerId })                                   [browser, Task 4]
  -> validateBrowserPeerInput / validateBrowserPeerServer                 refused at the sender: contextId, server id
  -> createBrowserUnicastMessage                                          one unicast, groupRef + contextId = room
  -> BrowserRallarMessageDispatch (carrier rtc, canFallback)              [S3b, unchanged]
       -> outbound admission on the volatile pair
            -> ALVolatileSessionBudget.tryAdmit                           [Task 3] over the bound: refused capacity
                 -> handle rejected, evidence.failure refused/capacity    [Task 1] no fallback
       -> RTC carrier plans the direct unicast                            [unchanged]
            -> addressee ACK -> acknowledgement settlement -> acknowledged
            -> no-route | not-ready x3 | receipt-exhausted                [S3b triggers]
                 -> handOver (settlement-free) -> WS re-admits the same envelope
                      -> router delivers on the room topic, one-member receipt   [S3c-i]
director relay sendIntent / requestSync                                   [Task 5]
  -> messages.room<Envelope>({ purpose: 'command', typeId }).send(envelope, { peerId: director, strategy })
director: messages.rtc.onMessage(intent | sync-request type id) + messages.ws.onMessage(topic)
  -> game sequence tracker (intent: duplicates refused, order free)       [C10]
  -> onIntent / onSyncRequest
```

## Rulings during execution

- **R-S3c-ii-0 (pre-execution, 2026-09-28).** D60, D70, D74, D75 and D78 stand as decided. The eleven questions the
  post-S3c-i survey found open are answered by C1–C17, each the survey's recommended option, without a question round:
  the maintainer asked for the plan to be written and executed on PR #606, and had taken the recommended option on all
  twenty-five earlier S3b and S3c questions. Cost if wrong: the maintainer overturns a choice in review and the task
  that applied it is reworked; C10 (the director accepts intents out of order) and C1 (D78 as applied) are the two
  that change stated behaviour, and the PR body leads with them.

- **R-S3c-ii-1 (plan writing, 2026-09-29).** D74's retention covers every row of the volatile pair that carries a
  message deadline: the owner and sent-message rows, the inbound owner row, the outbound control-history rows, a
  completed receipt row and the relay's inbound ACK-history row. Two rows keep their lifetime, and Task 2 says why: the
  per-origin version row (one row per origin, it fences every commit of that origin, shortening it allows ABA) and the
  ACK-history row of a relay row whose message named no deadline. Cost if wrong: a late control inside the old window
  and outside the new one is dropped as unknown instead of answered.
- **R-S3c-ii-2 (plan writing, 2026-09-29).** C11 is amended: `toPeer` is `'server' | 'receiver'`. The room roster
  carries no role, the three-agent lane starts both recipients in parallel and hosted agents may share one user, so
  nothing in the page tells the two recipients apart; the four scenarios run on two agents and manifest 22 does not
  change. Manifest 18's `recommendedTerminalTimeoutSeconds` rises from 300 to 1 200: its absence windows alone take
  513 s, so 300 s never held (the concern PR #604 carried). Cost if wrong: a hosted run that hangs is cut off later.
- **R-S3c-ii-3 (plan writing, 2026-09-29).** Inbound data counts toward the same session limit as outbound data (C4,
  C6), so a busy receiver can have its own volatile sends refused `capacity`: at the 30 s default deadline that starts
  above about 33 messages a second, in and out combined. A counted send whose commit admits nothing stays counted until
  its deadline (the ledger has no release call). A message without a deadline (RTC signalling) is not counted. The RTC
  circuit breaker does not count a `capacity` refusal as a failure, or repeated refusals would open it and leak
  over-bound sends to WS as `circuit-open`. Cost if wrong: the limits are named constants behind
  `ALVolatileSessionLimits`; raising them is one line.
- **R-S3c-ii-4 (plan writing, 2026-09-29).** The director relay reports `sent` only when the director's receipt
  arrives (it waits for `acknowledged`, at most 30 s); that is the only reading under which a refused command stops
  reading `sent`. The arena-join sync request, the one awaited caller, becomes a best-effort task so a slow receipt
  does not hold the join. Call signalling, the second caller of `sendWsUnicast`, moves to
  `messages.ws.send({ scope: 'all', peerId, contextId: callId, reliability: 'best-effort' })`. AL dedup is per carrier
  lane, so a relay command can arrive twice after a fallback: relay commands are at-least-once and the game's sequence
  tracker refuses the duplicate. Cost if wrong: intents report later than today; the wait bound is one constant.
- **R-S3c-ii-5 (pre-flight scan, 2026-09-29).** The four addressed scenarios run as their own two-agent family in the
  Playwright lane, one test per carrier under the fixed `CARRIER_TEST_TIMEOUT_MS`. Added to the baseline family they
  bring the `rtc-with-ws-fallback` cell to about 465 s of 480 s, which leaves no margin on a slow page. Cost if wrong:
  the full scope runs three more tests, and the hosted observation job, whose 30-minute timeout already does not fit
  the full scope on slow runners, takes longer still.
- **R-S3c-ii-6 (Task 3 review, 2026-09-29).** An inbound admission is counted until the earlier of its deadline and
  30 s after its arrival (`AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS`); an outbound admission keeps its own
  deadline. The inbound deadline is the sender's clock and the sender's choice, so a peer whose clock runs ahead, or who
  names a far deadline, must not keep this session's own sends refused `capacity`; the envelope is delivered at once
  and only small rows stay. Cost if wrong: long-lived inbound messages are undercounted, and they are never refused
  anyway (C6).

## Self-review

Pre-flight scan applied 2026-09-29 from `pre-flight-scan-cross-task.md` (F1-F12, N1-N11),
`pre-flight-scan-tasks-1-3.md` (T1-T3) and `pre-flight-scan-tasks-4-7.md` (T4-T7), with the controller's rulings
R-a to R-h; each finding's outcome is in `pre-flight-applied.md` beside the scans.

- BLOCKING: 10 of 10 applied (F1 with T3-3 and F2 with T3-2 each applied once, R-b).
- ADJUST: 40 of 41 applied, 10 of them with adaptation (the helper path of R-a, the unconditional `addressed` family
  of R-c as ruling R-S3c-ii-5, and duplicates covered by an earlier finding).
- NOTE: 40 of 53 applied, 7 of them with adaptation; the other 13 carry no edit.
- Code fragments that dprint had turned into labelled statements (T2-1, T2-2, T3-1, T6-F53) are fenced as `text`;
  T6-F1 shows its whole object literal.
- Not applied: T7-F1, superseded by F12, which moved the same Task 7 Step 1 anchor first (directly before
  `### Grouped control sends`). Partly applied: T6-F58 Edit 1 (R-e: T7-F4's C11 text is used); T7-F10's second
  dispatch for manifest 22 (F8: manifest 22 is unchanged); N2's line counts (the source gives 59 and 58, as T6-F15
  says).
