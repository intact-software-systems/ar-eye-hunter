# ALM I2a-ii: one durable owner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One browser tab drains a session's durable ALM work. Each connect requests a per-session Web Lock (a second name on the one shared lock port). A tab that does not hold it still admits and commits, but its durable lanes run no work task: its commits wake the owner over a per-session `BroadcastChannel`, and the owner's durable-lane settlements reach the admitting tab's handles over the same channel. When the owner's lock is released, the next tab takes over and its bootstrap batch reports `restored`. Prove the takeover in the Playwright lane with a `durable-takeover` scenario of two pages of one browser context, and move Relic Hunters' commands to `local-outbox`.

**Architecture:** `ALOutboundMessageRuntime.BrowserLocks` moves to `ALBrowserLocks` in `packages/shared/alm/storage/al-browser-locks.ts`, widened by `signal` (Task 1). `ALDurableWorkOwnership` enters both runtimes' `Resources`, defaulted to `ALWAYS_OWNED_AL_DURABLE_WORK` (the server, Node and every fixture keep today's behaviour). A durable lane's `ALWorkHandler` joins the `InboxOutboxEngine` through `ALWorkEngineMembership` only while it owns the work. A non-owner's `committed(rows)` only announces `{ workType, rows }`, and each durable lane gains `applyForeignCommit` (Task 2). The browser composition builds one `BrowserALDurableWorkClaim` per connect, which requests `rallar:al-durable-owner:<applicationId>:<workspaceId>:<sessionId>` with the connect's own `AbortSignal` and releases it in `BrowserTransportRuntime.shutdown` (Task 3). One `BrowserALSessionChannel` per connect carries a waiting tab's commit to the owner's lane of the same work type and relays a durable lane's settlement to the tab that holds the handle. The outbound runtime stamps the lane that stated each settlement (Task 4). The harness gains a `successor` role and a `same-context` lane family. The Hetzner entries select by family (Task 5). `durable-takeover` runs on every carrier in the local full lane (Task 6). Relic's command channel declares `local-outbox` and `onStorageUnavailable: 'refuse'` (Task 7).

**Tech Stack:** TypeScript, Vitest (fake-indexeddb, `FakeBroadcastChannel`, Web Locks fakes), the Web Locks API and `BroadcastChannel`, Playwright (Chromium, two pages of one browser context), Deno (the control server's generated-recipe fixture), dprint.

**Spec:** `playground/alm/alm-i2a-design-proposal.md` §3.f (the durable owner), §3.g (cross-tab wake), §3.h (recovery outcomes, owner-counted), §3.j (`durable-takeover`, the two-pages-one-context capability, hosted entries skip the family), §3.k (Relic to `local-outbox`), §4 decisions 5, 6, 8, 11 and 12, §5 (the I2a-ii evidence), §6 (the seven I2a-ii tasks). Decisions D119, D123, D124, D126 and D128 in `playground/alm/alm-improvement-plan.md`. QoS plan §4 "One writer" and §8 "One durable owner per session store" in `playground/alm/alm-qos-product-plan.md`. Base commit `ee510bbb0` (main after PR #629, I2a-i) on branch `claude/alm-i2a-ii-durable-owner`.

## Global Constraints

- **The maintainer's notes, verbatim: "no migration code, avoid duplications, reuse existing repo patterns, use repo guidance."** There is no compatibility path: wherever the Locks API exists, the per-session claim replaces "every tab drains".
- **D8 reuse first.**
  - The existing lock port is widened (by `signal`) and moved to one shared module, not duplicated.
  - The engine's own task registration (`includeTask`/`excludeTask`) is the gate. There is no new scheduler.
  - The work handler's own `committed(rows)` path carries the cross-tab wake, never `wakeAfterExternalWrite`, which makes every lane probe.
  - The `BroadcastChannel` follows the naming and the missing-API guard of the `rallar-data:` and `rallar-crdt:` channels.
  - Keyed and latest state uses `packages/shared/cache`. Expected failure is an `Either`.
  - Every task carries a D8 reuse inspection paragraph, and its commit message carries one `D8 reuse:` line.
- **No guarantee weakens.**
  - The D17 fence, supersedence, settlement, expiry, the group commit path and the volatile lanes (the D55 zero pin) are untouched.
  - A row the old owner held is recovered at its lease end plus at most 19.1 s (D113), and no new mechanism recovers it sooner. A released lock proves nothing about an in-flight batch; this is a carry.
- **Pins only fall.** These stay unedited:
  - the warm durable send ledger: chain 6, total 8, 37 requests, 10 `al-admission` plus 5 `al-work`;
  - the cold pin: 10 plus 9;
  - inbound: chain 9/11, total 11/13, `al-work` 5/7;
  - the storage snapshot.

  The lock is taken per connect, never per send, and a single-runtime fixture has no Locks API.
- **The server and the Node tests keep today's behaviour.** They pass the always-owned ownership value, and the PostgreSQL lane never takes a lock or a channel. There is no schema id bump, no new dependency and no new timer.
- **Bundle budgets** live in `packages/shared-web/bundle-budgets.json` (`browser/rallar.ts` 234 KiB, 232.975 measured at I2a-i's close) and `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (298 KiB, 297.686). A crossed budget is raised to the next whole KiB, with the measured figure in the commit message and the PR body. This plan raises:
  - the headless budget 298 → 299 in Task 2 (298.196 measured);
  - `browser/rallar.ts` 234 → 235 in Task 4 (234.219 measured on the assembled tree).

  These are R-I2a-ii-27 and R-I2a-ii-47.
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`):
  - Use the canonical verbs. Functions are at most 40 lines, with at most 3 positional parameters.
  - Use `interface` for object contracts. Fields are required by default; a field is optional only where absence has domain meaning, stated in its doc line.
  - File names are kebab-case and named after the primary export. No role folders.
  - No comments except an essential invariant, an external constraint or a tradeoff. Test-intent comments in tests are fine. No `// packages/...` path headers, and no doc comments that restate the code.
  - No plan, decision, task or PR id in code or tests.
  - Cognitive-load tiers: warn at 50, review at 110, and 330 or more needs a registered exception. Twelve or more runtime exports prompts a split review. The 1,200-line backstop applies.
  - A widened union's consumers are swept by enumeration (callers, `.entries`/`.verdict` reads, void switches), not by switches alone.
- **Formatting:** dprint runs only on touched files (`npx dprint fmt <file> <file>`), never on a glob.
- **Per-task checks:**
  - the focused Vitest files;
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`;
  - `npm --workspace @ar-eye-hunter/shared-web run typecheck` and `npm --workspace @ar-eye-hunter/shared-server run typecheck`;
  - `cd apps/api-v1 && deno task check`, then delete `apps/api-v1/node_modules/.deno` if it is left behind (it breaks the next check);
  - `node scripts/check-tests-typecheck.mjs`;
  - the three pins;
  - the bundle checks after any `packages/shared` or `shared-web` change;
  - before the commit, `npm run check:repo-style:changed -- origin/main HEAD` and `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`;
  - `npm run check:test-reachability` when a test file is added or deleted;
  - `npm run test:postgres:integration` for any change under `packages/shared/alm/inbound/**` or `alm/work/**`. It uses the shared container `ar-eye-hunter-postgres`: `docker start` it only if it is stopped, and never run `db:test:up` or `db:down`;
  - for a public shared-web surface change, `shared-web-public-api-snapshots.test.ts` and `shared-web-browser-bundle-boundaries.test.ts`;
  - for the harness tasks, a typecheck of `tests/playwright/**` with a scratch tsconfig (no tsconfig covers it; this is the I2a-i lesson), and the control server's `deno task check && deno task test`.
- **Navigation maps** are updated in the task that changes what they describe:
  - `packages/shared/alm/outbound/README.md` and `packages/shared/alm/inbound/README.md`;
  - `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` and `schema-and-capabilities.md`;
  - the shared-web browser README;
  - `docs/rallar-api-reference.md`.
- **Git:**
  - The implementer makes one commit per task, with one `D8 reuse:` line and no attribution lines.
  - The controller pushes after review.
  - Never `git stash`, never push, never merge, never run `pr:delivery ready`.

## File structure

| Area                   | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                | Responsibility                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Lock port (1, 3)       | `packages/shared/alm/storage/al-browser-locks.ts` (new); `al-outbound-message-runtime.ts`, `al-outbound-dispatch-admission.ts`, `lane/al-outbound-store-lane.ts`, `create-default-al-outbound-message-runtime.ts` under `packages/shared/alm/outbound/`                                                                                                                                                                                              | `ALBrowserLocks` with `signal`, `readALBrowserLocks()`, the commit lock name, and (Task 3) the owner lock name          |
| Ownership and gate (2) | `packages/shared/alm/work/al-durable-work-ownership.ts`, `al-work-engine-membership.ts` (new); `al-work-handler.ts`; both runtimes, both default compositions and both durable lanes under `alm/outbound/**` and `alm/inbound/**`; the pass-through inputs in `packages/shared/services/ws-queue-box-client-service.ts`, `web-rtc-rx-streamer-service.ts` and the browser WS, RTC and middleware composition                                         | One ownership value per runtime; the handler joins the engine only while it owns; `applyForeignCommit` per durable lane |
| Claim (3)              | `packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts` (new); `connection/browser-transport-runtime.ts`, `connection/initialise-browser-middleware.ts`                                                                                                                                                                                                                                                                            | One claim per connect, released after the runtimes stop; the no-Locks path owns                                         |
| Session channel (4)    | `packages/shared-web/browser/al-runtime/browser-al-session-channel.ts` (new); the claim, `browser-delivery-settlements.ts`, `browser-session-deliveries.ts`, `session-connection-lifecycle.ts`, the transport runtime; `packages/shared/alm/delivery/al-delivery-lifecycle.ts` and the outbound runtime (the `lane` stamp)                                                                                                                           | The commit wake into the owner's lane; the durable-lane settlement relay; one channel per connect                       |
| Harness (5, 6)         | `packages/shared-test/rallar-bb-test/conformance/alm/**` (roles, family, session commands, receipt commands, `scenarios/durable-takeover.ts` (new), `delivery-reload.ts`); `tests/playwright/rallar-black-box/full-stack-helpers.ts`, `full-stack-same-context-run.ts` (new), `full-stack-alm-conformance.spec.ts`; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`; the control server's `control-generated-alm-reload.test.ts` | The `successor` role, the `same-context` family, the family-based hosted filter, `durable-takeover`                     |
| Relic (7)              | `apps/relic-hunters-v1/src/game/send-relic-ws-command.ts`, its test, `docs/runtime-data-flow.md`                                                                                                                                                                                                                                                                                                                                                     | `local-outbox` with `onStorageUnavailable: 'refuse'`                                                                    |
| Tests                  | `packages/tests/shared/alm/**`, `packages/tests/shared-web/**`, `packages/tests/shared-test/**`, `packages/tests/rallar-black-box/**`, the Relic test                                                                                                                                                                                                                                                                                                | Red first per task; the pins unedited                                                                                   |
| Docs and budgets       | the navigation maps above; `packages/shared-web/bundle-budgets.json` (Task 4), `headless-bundle-budget.json` (Task 2); `playground/alm/alm-qos-product-plan.md` §8 (Task 8)                                                                                                                                                                                                                                                                          | Maps true to the code; budgets raised where crossed                                                                     |

## Task order

1 (lock port) → 2 (ownership and gate) → 3 (claim) → 4 (session channel) → 5 (two pages, family) → 6 (`durable-takeover`) → 7 (Relic) → 8 (close).

- Task 2 consumes nothing of Task 1's code, but its browser inputs carry the value that Task 3's claim fills.
- Task 3 consumes Task 1's `ALBrowserLocks` with `signal`, and Task 2's ownership value and gated handler.
- Task 4 consumes Task 3's claim (it holds the channel) and Task 2's `announceCommit`/`onForeignCommit`/`applyForeignCommit`.
- Tasks 5–6 consume no product code: the scenario reads the existing `recovery` event. They run after Task 4 because Task 8's local lane needs Tasks 3–4's behaviour.
- Task 7 is independent and runs last before the close.

Each task's patch was prototyped on `ee510bbb0` (Tasks 4 and 6 on their predecessors). The chain composes in this order on the assembled scratch tree: every task's typechecks, focused tests and pins are green at its own commit (figures per task below).

---

## Rulings made while writing the plan

Each ruling is a choice the spec does not settle. R-I2a-ii-1..12 come from the controller's fact sheet. R-I2a-ii-13..47 come from the controller's review of the writers' prototypes, and they override a task text that differs. R-I2a-ii-48..51 come from this plan's assembly. The maintainer can undo any of them; the cost column says what a wrong ruling costs. In the copied rulings, W-A, W-B, W-C and W-D name the writers who prototyped Tasks 1–3, 4, 5–6 and 7, and "Qn" names one of their open questions.

| Id          | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                            | Cost if wrong                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-I2a-ii-1  | (Headless worker) D124 governs: the two-page capability and the `same-context` family live in the Playwright helpers only (`tests/playwright/rallar-black-box/**`); `apps/rallar-black-box/scripts/headless-worker.ts` is untouched; §3.j/§6's "and the headless worker" is corrected below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | D124 declined multi-page agents in the headless worker.                                                                                                                                                                                                                                                                                        | A hosted takeover later needs the worker change.                                                                                                               |
| R-I2a-ii-2  | (Hetzner filter) `toAlmConformanceScenariosForAllCarriers` (`hetzner-alm-manifest-entries.ts:143-161`) selects by `isThreeAgentScenario`, not `laneFamily`; it becomes family-based (`two-agent` + `addressed` for manifest 18, `three-agent` for 22, never `same-context`), pinned by `hetzner-alm-manifest-entries.test.ts`; manifests 18 and 22 regenerate byte-identical (`--check` and a diff).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Decision 6; one selector.                                                                                                                                                                                                                                                                                                                      | None.                                                                                                                                                          |
| R-I2a-ii-3  | (The gate's seam) The ownership gate is one seam in `ALWorkHandler`: `includeTask`/`includeWakeListener` (constructor, `al-work-handler.ts:181-193`), `ready()`'s bootstrap (`:196-205`) and `committed()`'s direct batch (`:223-232`) defer while `isOwned()` is false and run when ownership turns true (register the task, run the bootstrap batch once, which reports `restored`). The always-owned default keeps construction-time registration exactly as today, so every existing fixture (`outbound-runtime-test-fixture.ts:105-135`) is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                     | One seam; no new scheduler.                                                                                                                                                                                                                                                                                                                    | None.                                                                                                                                                          |
| R-I2a-ii-4  | (Where the value enters) `ALOutboundMessageRuntime.Resources` and `ALInboundMessageRuntime.Resources` gain `durableWorkOwnership: ALDurableWorkOwnership`, defaulted to `ALWAYS_OWNED_AL_DURABLE_WORK` in both `createDefault…RuntimeResources`; the runtimes hand it to the durable lane only; the browser passes its per-connect value through `CreateBrowserWebSocketQueueBox.Input`, `WsQueueBoxClientService.Input`, `InitialiseRtcOverlayMulticastManagerInput` and `InitialiseRtcRxStreamerInput`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The server and Node keep today's behaviour by default.                                                                                                                                                                                                                                                                                         | None.                                                                                                                                                          |
| R-I2a-ii-5  | (The claim's lifetime and place) No per-connect lifetime signal exists: the browser composition owns a new `AbortController` per connect; the owner lock is requested from the composition, never from `createDefaultALOutboundRuntimeResources`, so the exact lock-count tests (`ws-rtc-control-handoff-latency.test.ts:300,315`, `outbound-control-handoff.test.ts:342`) stay as they are. Refined by R-I2a-ii-24.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The composition owns the connect.                                                                                                                                                                                                                                                                                                              | None.                                                                                                                                                          |
| R-I2a-ii-6  | (Foreign commit entry) Each durable lane gains one public method for the owner to apply a foreign commit: outbound `applyForeignCommit(rows)` → `work.committed(rows)`; inbound `applyForeignCommit()` → `workSelector.requestHeadRead()` then `work.committed(AL_WORK_UNDESCRIBED_COMMIT)`. The commit is routed by the lane's work type (R-I2a-ii-19).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | D112's restore holds; the inbound rotation reads from the head.                                                                                                                                                                                                                                                                                | None.                                                                                                                                                          |
| R-I2a-ii-7  | (Channel construction) Node's global `BroadcastChannel` is real, so the session channel is created through an injected port factory defaulting to the global behind the `rallar-crdt` guard; unit tests use `FakeBroadcastChannel` (`rallar-data-test-runtime.ts:10-43`). Messages are `{ version: 1, sessionKey, instanceId, kind, … }` with the `instanceId` echo filter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | No unit test may touch a real channel (R-I2a-ii-45).                                                                                                                                                                                                                                                                                           | None.                                                                                                                                                          |
| R-I2a-ii-8  | (The relay's rule) Every tab, not only the owner, relays a settlement it records for a msgId it holds no handle for (`registry.getHandle(msgId)` undefined): `acknowledgement` and `relay-rejected` come from whichever tab admitted the control. The receiving tab applies it through its own observers (which ignore unknown msgIds), once: settlements are not idempotent. The tap is the epoch sink in `BrowserDeliverySettlements.open`. Narrowed by R-I2a-ii-44.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Decision 11.                                                                                                                                                                                                                                                                                                                                   | None.                                                                                                                                                          |
| R-I2a-ii-9  | (Cancel) A non-owner's `handle.cancel()` reaches only its own runtimes; the owner keeps dispatching. Not in I2a-ii: a carry (Limits, PR body), the next lifecycle slice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Scope.                                                                                                                                                                                                                                                                                                                                         | A cancel from a waiting tab does not stop the owner's dispatch.                                                                                                |
| R-I2a-ii-10 | (Two sockets, one session) Whether the server keeps two WS sockets per session was unverified; W-C verified it first. Settled by R-I2a-ii-31.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                              | —                                                                                                                                                              |
| R-I2a-ii-11 | (Second page login) The second page skips the unconditional Sign-in wait (`full-stack-helpers.ts:600-602`): a context-taking opener signs in only if the login gate shows, with its own `agentId` and control registration; no `reset` command is issued in a shared context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Shared `auth.session` in localStorage.                                                                                                                                                                                                                                                                                                         | None.                                                                                                                                                          |
| R-I2a-ii-12 | (Relic) `durability: 'local-outbox'` and `onStorageUnavailable: 'refuse'` explicitly; the deep-equality pin at `send-relic-ws-command.test.ts:50-55` is updated as the intended pin; the non-idempotent command kinds are stated in Limits as covered only by msgId dedup within deadline + grace (D126).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The refusal must not depend on a default.                                                                                                                                                                                                                                                                                                      | None.                                                                                                                                                          |
| R-I2a-ii-13 | The Relic docs line goes in `apps/relic-hunters-v1/docs/runtime-data-flow.md` "Command Path" only; `current-state.md` names the channel without describing it and is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | One owner for the description.                                                                                                                                                                                                                                                                                                                 | None.                                                                                                                                                          |
| R-I2a-ii-14 | The docs paragraph states that the server re-acknowledges a resumed repeat within deadline + grace without applying it (I2a-i's dedup, proposal §3.k); the close task's PR body cites the I2a-i replay tests as the proof, not a Relic-specific run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The claim rests on Task 7 of I2a-i (memory, IndexedDB, PGlite replay tests).                                                                                                                                                                                                                                                                   | One sentence to soften if the Relic server path differs.                                                                                                       |
| R-I2a-ii-15 | With `onStorageUnavailable: 'refuse'`, an unavailable store now reports `failed` and sends nothing where the command used to be sent unstored; the Relic UI already shows `failed`, and there is no REST fallback after a WS attempt. Stated in the plan's Limits and the PR body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | A truthful outcome replaces a silent unstored send (D122).                                                                                                                                                                                                                                                                                     | A Relic player on a browser without IndexedDB cannot send commands over WS until the storage is back; the UI says so.                                          |
| R-I2a-ii-16 | The doc comment on `sendRelicWsCommand` is unchanged; nothing else in the sender changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The frame.                                                                                                                                                                                                                                                                                                                                     | None.                                                                                                                                                          |
| R-I2a-ii-17 | No browser proof of a reloaded Relic command in I2a-ii (the Relic Playwright suites are manual); I2b's consumer proof carries it (D126).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Scope.                                                                                                                                                                                                                                                                                                                                         | None.                                                                                                                                                          |
| R-I2a-ii-18 | The lock port is `ALBrowserLocks` in `packages/shared/alm/storage/al-browser-locks.ts` beside `readALBrowserLocks()` and both lock-name builders; `ALOutboundMessageRuntime.BrowserLocks` is removed with no alias.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `alm/` holds 20 files (a 21st trips the density check); both locks guard the durable store.                                                                                                                                                                                                                                                    | A file move.                                                                                                                                                   |
| R-I2a-ii-19 | `announceCommit({ workType, rows })` and `onForeignCommit(workType, listener)` are keyed by the lane's work type (the same in every runtime of the session; worker ids are random); this is R-I2a-ii-6's "store namespace and lane". BINDING on Task 4's channel message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | One ownership value serves the session's four durable lanes.                                                                                                                                                                                                                                                                                   | None.                                                                                                                                                          |
| R-I2a-ii-20 | The gate is one seam in `ALWorkHandler`, implemented in a new `ALWorkEngineMembership` module (handler cognitive load 44 with it, 50 inline; the module 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The warn tier.                                                                                                                                                                                                                                                                                                                                 | One more file in `work/`.                                                                                                                                      |
| R-I2a-ii-21 | `ALWorkHandlerDependencies.durableOwnership?` is optional: absent = owned from construction (today's behaviour); volatile lanes pass `undefined`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The 35 direct `new ALWorkHandler` test sites, three in the pin file, stay unedited; absence has domain meaning (no ownership gate on this lane).                                                                                                                                                                                               | None.                                                                                                                                                          |
| R-I2a-ii-22 | A non-owner's `committed()` only announces (no memory suspend, no wake, no batch) and its `ready()` runs no bootstrap; `onForeignCommit` is heard only while this runtime owns the work. BINDING on Task 4 (deliver only to an owner).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Otherwise two waiting tabs re-announce each other's commits forever.                                                                                                                                                                                                                                                                           | None.                                                                                                                                                          |
| R-I2a-ii-23 | The ownership value is optional on `WsQueueBoxClientService.Input` and `WebRtcRxStreamerService.Input` (a fifth pass-through R-I2a-ii-4 did not list) and required on the four browser inputs; Task 2's middleware passes `ALWAYS_OWNED_AL_DURABLE_WORK` until Task 3 wires the claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The browser composition decides.                                                                                                                                                                                                                                                                                                               | 16 literal inputs in five shared-web test files gained one line.                                                                                               |
| R-I2a-ii-24 | (Refines R-I2a-ii-5) The claim is released in `BrowserTransportRuntime.shutdown()` after `shutdownMiddleware`, and in `init`'s `.catch` (a failed or cancelled connect), not inside `shutdownMiddleware` (which only receives the public middleware); releasing after the runtimes stop means the next owner never overlaps this one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Same coverage, no overlap.                                                                                                                                                                                                                                                                                                                     | None observed.                                                                                                                                                 |
| R-I2a-ii-25 | A lock request that fails for any reason other than the connect's own release makes that connect own its work (zero owners would strand the rows; every tab draining is today's behaviour).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Liveness over exclusivity.                                                                                                                                                                                                                                                                                                                     | Two owners, as today.                                                                                                                                          |
| R-I2a-ii-26 | The claim reaches `initialiseMiddleware` as `BrowserConnectOptions extends MiddlewareInitOptions`, following the `deliverySettlements` per-connect pattern (three positional parameters kept).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Existing pattern.                                                                                                                                                                                                                                                                                                                              | Two exact-options tests each gained one key.                                                                                                                   |
| R-I2a-ii-27 | Headless budget 298 → 299 KiB in Task 2 (298.196 measured); `browser/rallar.ts` 233.792 of 234 after Task 3, so Task 4 raises it to 235 if crossed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Global Constraints.                                                                                                                                                                                                                                                                                                                            | None.                                                                                                                                                          |
| R-I2a-ii-28 | New test support module `packages/tests/shared/alm/session-outbound-test-runtime.ts` for Tasks 2–3 (the existing fixture throws for a runtime that registers no task at construction, which is the non-owner).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The non-owner needs its own fixture.                                                                                                                                                                                                                                                                                                           | One support file.                                                                                                                                              |
| R-I2a-ii-29 | The takeover's observable fact is the new owner's `recovery` event `restored {claimed ≥ 1}` on the store that held the row (outbound: the store id; inbound: `<store id>/ws`); a waiting tab emits no `recovery`. BINDING on Task 6's waits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Task 3's behaviour (Q3).                                                                                                                                                                                                                                                                                                                       | None.                                                                                                                                                          |
| R-I2a-ii-30 | The takeover bootstrap runs from the handler, not through `ALStorageReadiness` (IndexedDB opens lazily); if the store cannot open, that batch records failing health and the next batch reports the recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Q5.                                                                                                                                                                                                                                                                                                                                            | Stated in Limits.                                                                                                                                              |
| R-I2a-ii-31 | (Settles R-I2a-ii-10) The server keeps ONE WebSocket per auth session: a second upgrade replaces the first and closes it with `1000 'connection-replaced'` (`json-web-socket-server.ts:116-124`, `ws-routes.ts:60-62`); the replaced page reconnects and evicts the other, so two connected pages of one session loop, and session-addressed sends reach only the newest socket (probe 2/2). Consequence: a takeover while the owner page is alive cannot run in the lane (carried limit, covered by Task 3's unit test); the scenario's successor page opens and registers while the owner lives but connects only after the owner page is closed, and its lock is granted at once. The plan's corrections and the PR body state that D123's two-tab story is bounded by this server rule: the lock's value in practice is the orderly hand-over on close or reload and the single drainer when two tabs are open on one session (one of which has no socket). | Server fact.                                                                                                                                                                                                                                                                                                                                   | None; stated.                                                                                                                                                  |
| R-I2a-ii-32 | The successor waits one lease (10 s) plus 1 s after the owner's close before connecting, then asserts `restored {claimed > 0}`: a held claim stays reserved until its lease ends and a closed page writes no release, so an immediate takeover would read `claimed: 0`. Cost: 11 s per carrier cell in a `full`-tag scenario; the "lease end + ≤ 19.1 s" bound stays pinned by the lease-recovery unit tests, not by the lane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The scenario exists to prove the held row is reclaimed by the new owner.                                                                                                                                                                                                                                                                       | The alternative (assert `restored` only) proves less.                                                                                                          |
| R-I2a-ii-33 | No page-close command: Playwright's `page.close()` suffices (the owner's result is recorded first; the control server marks the agent disconnected).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Smallest change.                                                                                                                                                                                                                                                                                                                               | None.                                                                                                                                                          |
| R-I2a-ii-34 | The "`pages: 2` option" is a `successor` role plus `openBrowserControlAgentInContext` (signs in only when the login gate shows) in a new `full-stack-same-context-run.ts` beside the three-agent run; `openBrowserControlAgent` delegates to it and keeps its signature for its four callers; the headless worker is untouched (R-I2a-ii-1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Role-shaped like `recipient-b`.                                                                                                                                                                                                                                                                                                                | None.                                                                                                                                                          |
| R-I2a-ii-35 | Hosted entries select by `laneFamily` (manifest 18: `two-agent` + `addressed`; 22: `three-agent`; never `same-context`), pinned by a new test; `isThreeAgentScenario` is removed; manifests 18 and 22 pass `--check` and regenerate byte-identical.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | R-I2a-ii-2.                                                                                                                                                                                                                                                                                                                                    | None.                                                                                                                                                          |
| R-I2a-ii-36 | The successor's connect counts as one peer with the sender and uses the sender's connection label; the shared session is restored through a `RESTORED_SESSION_RALLAR` constant that `delivery-reload`'s reconnect also uses (output identical).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | One restore shape.                                                                                                                                                                                                                                                                                                                             | None.                                                                                                                                                          |
| R-I2a-ii-37 | Two helper moves keep `conformance/alm` and `scenarios` at 20 files: the store-recovery helpers move from `delivery-reload` into the session-commands module; `to-addressed-send-commands.ts` moves into the receipt-commands module (the message-commands module would hit 12 runtime exports).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The changed-style gate (density, prefix cluster, export count).                                                                                                                                                                                                                                                                                | None.                                                                                                                                                          |
| R-I2a-ii-38 | Scenario budgets: the original's `ttlMs` 77 s (above lease + 19.1 s + a whole successor connect); the receiver's arrival wait 122 s; a second copy ruled out by a `count: 2` absent window of 17 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Deterministic under the lease wait.                                                                                                                                                                                                                                                                                                            | A slow regime may need the arrival wait raised; recorded.                                                                                                      |
| R-I2a-ii-39 | The takeover joins no post-run identity assessment; the reload assessment is untouched (a successor that signed in afresh would never deliver, so the receiver's wait catches it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Minimal.                                                                                                                                                                                                                                                                                                                                       | None.                                                                                                                                                          |
| R-I2a-ii-40 | The Deno fixture models a successor page redelivering held originals with claimed counts, one takeover test per carrier (192 → 195).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Fixture truth.                                                                                                                                                                                                                                                                                                                                 | None.                                                                                                                                                          |
| R-I2a-ii-41 | The transport runtime builds the session channel and passes it to the claim as a required `sessionChannel`; `release()` closes it; the settlement epoch reaches it through a getter on the claim; the channel factory is a required `BrowserTransportRuntime` constructor input (tests pass `() => undefined` or `FakeBroadcastChannel`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | R-I2a-ii-7 and W-A's claim.                                                                                                                                                                                                                                                                                                                    | None.                                                                                                                                                          |
| R-I2a-ii-42 | The owner check for foreign commits sits in the claim's `onForeignCommit` wrapper (R-I2a-ii-22); the `committed` message carries `workType` + `rows`; every message is `{ version: 1, sessionKey, instanceId, kind, … }` read as `rallar-crdt` reads its messages; without `BroadcastChannel` a waiting tab's row waits for the owner's age-bound probe (README).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | W-A's shapes.                                                                                                                                                                                                                                                                                                                                  | None.                                                                                                                                                          |
| R-I2a-ii-43 | The relay is applied when each tab's epoch opens: `open(observers, relay)` with `holds(msgId)` from `sessionDeliveries.observers`; a received settlement goes to the tab's own observers and is never relayed again; `BrowserTransportInitOptions` carries it (21 one-line test edits).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | R-I2a-ii-8.                                                                                                                                                                                                                                                                                                                                    | None.                                                                                                                                                          |
| R-I2a-ii-44 | (Narrows R-I2a-ii-8; W-B's Q1) The relay posts only settlements of DURABLE sends: the outbound runtime stamps the emitting lane on the settlement envelope (`lane: 'durable' \| 'volatile'`, known at `emitSettlement`), and the relay skips volatile ones, so signaling, overlay forwarding and volatile ACK controls never cross tabs. The widened envelope's consumers are swept by enumeration (the lifecycle computer, the registry, the harness decoders and projections, the server publish status). Lands in Task 4.                                                                                                                                                                                                                                                                                                                                                                                                                                    | Relay volume; only durable lanes have an owner.                                                                                                                                                                                                                                                                                                | A field on every settlement; the harness decoders follow.                                                                                                      |
| R-I2a-ii-45 | (W-B's Q2) No real Node `BroadcastChannel` opens in unit tests: the shared-web composition/facade test runtime installs `FakeBroadcastChannel` per test (as the rallar-data tests do) or passes a `() => undefined` factory where no tab sync is under test; a test counts zero real channels in the composition suite. Lands in Task 4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | R-I2a-ii-7's letter.                                                                                                                                                                                                                                                                                                                           | None.                                                                                                                                                          |
| R-I2a-ii-46 | (W-B's Q3) Duplicate ACK relays from two sockets of one session are moot: the server keeps one socket per session (R-I2a-ii-31); a replaced tab receives nothing. Stated in Limits as resting on that server rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Server fact.                                                                                                                                                                                                                                                                                                                                   | None.                                                                                                                                                          |
| R-I2a-ii-47 | Budgets at Task 4: `browser/rallar.ts` 234 → 235 (234.193 measured); headless 298.813 of 299.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Global Constraints.                                                                                                                                                                                                                                                                                                                            | None.                                                                                                                                                          |
| R-I2a-ii-48 | (Assembly; refines R-I2a-ii-44) `lane` on `ALDeliverySettlement` is optional: the existing union becomes the private `ALDeliverySettlementStatement` and `ALDeliverySettlement` is that union with `Readonly<{ lane?: ALStoreDurability }>`. Every settlement an outbound lane states carries `lane: 'durable' \| 'volatile'` (R-I2a-ii-44's letter). Absent means no lane stated it: the browser sender's own admission, refusal, fallback, downgrade and exhausted facts, the registry's cancel, and the runtime's lifetime-wide `cancel`.                                                                                                                                                                                                                                                                                                                                                                                                                    | Those facts have no lane, and a required field would force a made-up lane on about ten construction sites. Absence has a domain meaning: such a settlement is recorded by the tab that holds the handle and is never relayed.                                                                                                                  | A future reader of `lane` must handle its absence; today only the relay reads it.                                                                              |
| R-I2a-ii-49 | (Assembly; realises R-I2a-ii-45) `installFakeBroadcastChannelPerTest()` and `FakeBroadcastChannel.openNames()` join the reused fake in `packages/tests/shared-web/data/rallar-data-test-runtime.ts`. The helper is called once in each of the 33 shared-web test files that connect through the composition's transport-runtime singleton. A composition test proves that a connect opens exactly one `rallar-alm:` channel on the fake and that the disconnect closes it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | To find the files, the port factory was instrumented over the whole unit project: 205 real channels opened, all in these 33 files, all under `packages/tests/shared-web/`, and none elsewhere. No shared composition runtime exists among them. This is R-I2a-ii-45's per-test letter, not global setup. With it, the instrumented count is 0. | 33 two-line edits. A future test file that connects through the singleton without the helper opens a real channel, and no permanent guard catches it (Limits). |
| R-I2a-ii-50 | (Assembly) The relay test's non-idempotency case uses a terminal durable `expired` and two late durable settlements (`lateSettlementCount: 2`) instead of a relayed `carrier-refused`. A new case pins that a volatile lane's settlement, and one no lane stated, is never relayed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Under R-I2a-ii-44 a `carrier-refused` is never relayed: the browser sender states it, with no lane, in the tab that holds the handle.                                                                                                                                                                                                          | None.                                                                                                                                                          |
| R-I2a-ii-51 | (W-B's R-B-8) Task 3's claim tests give each claim a channel that reaches no tab (`openPort: () => undefined`), so their takeover proofs still prove the takeover. The commit wake is proved by `browser-al-session-commit-wake.test.ts` with real claims: the owner has no Locks API, and the waiting tab requests a lock held elsewhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Both proofs are kept.                                                                                                                                                                                                                                                                                                                          | None.                                                                                                                                                          |

## Corrections to the proposal and the roadmap

Task 8's PR body carries these corrections. The proposal and the roadmap are left as written; they are design records.

1. **No headless worker change** (R-I2a-ii-1, D124). Proposal §3.j and §6 task 5 say "a `pages: 2` agent option in the Playwright helpers and the headless worker". The two-page capability lives in the Playwright helpers only, and the headless worker is untouched.
2. **The hosted filter becomes family-based** (R-I2a-ii-2, -35). §3.j says "the Hetzner entries pick families explicitly". Today they select by `isThreeAgentScenario`. Task 5 makes the selection read `laneFamily` (`two-agent` + `addressed` → 18, `three-agent` → 22) and removes `isThreeAgentScenario`. Manifests 18 and 22 regenerate byte-identical.
3. **One socket per session** (R-I2a-ii-31, -46). D123's two-tab story is bounded by a server rule: the server keeps one WebSocket per auth session (`json-web-socket-server.ts:116-124`). A second socket of the same session replaces the first (`1000 'connection-replaced'`), and two connected pages of one session evict each other in a loop. In practice, then, the lock gives two things:
   - the orderly hand-over on close or reload;
   - the single drainer when two tabs are open on one session, one of which has no socket.

   A takeover while the owner page is alive cannot run in the lane. It is covered by Task 3's lock-queue unit test (Limits).
4. **The `successor` role, not a `pages: 2` option** (R-I2a-ii-34). The frame's two-page option is the `successor` role plus `openBrowserControlAgentInContext`, which signs in only when the login gate shows, in `tests/playwright/rallar-black-box/full-stack-same-context-run.ts`. `openBrowserControlAgent` delegates to it and keeps its signature. There is no page-close command: Playwright's `page.close()` suffices (R-I2a-ii-33).
5. **The lease wait** (R-I2a-ii-32). §3.j's "page two takes over (the lock callback)" runs in the lane as a lock granted at once after the owner page's close. A held claim stays reserved until its lease ends, and a closed page writes no release. The successor therefore waits one lease (10 s) plus 1 s before it connects, and asserts `restored { claimed > 0 }`. The "lease end + at most 19.1 s" bound stays pinned by the lease-recovery unit tests, not by the lane.
6. **Every tab relays, durable lanes only** (R-I2a-ii-8, -44, -48). Decision 11 says "the owner relays settlements of messages it holds no handle for". Every tab relays: an acknowledgement comes from whichever tab admitted the control. Only a durable lane's settlement is relayed, by the `lane` the outbound runtime stamps on it.
7. **The ownership shape** (R-I2a-ii-19). §3.f's `announceCommit(rows)` and `onForeignCommit(listener)` are `announceCommit({ workType, rows })` and `onForeignCommit(workType, listener)`. They are keyed by the lane's work type, so one ownership value serves the session's four durable lanes.
8. **The port's name and place** (R-I2a-ii-18). §3.f's "`BrowserLocks` moves … into one shared module" is `ALBrowserLocks` in `packages/shared/alm/storage/al-browser-locks.ts`. `ALOutboundMessageRuntime.BrowserLocks` is removed with no alias.
9. **Relic declares the refusal too** (R-I2a-ii-12, -15). §3.k says `local-outbox` "and nothing else"; the channel also declares `onStorageUnavailable: 'refuse'` explicitly.

## Limits (carried; Task 8 states them in the PR body)

- **No takeover while the owner page is alive, in the lane** (R-I2a-ii-31). One auth session keeps one server socket, so the queued-callback path is covered only by Task 3's lock-queue unit test. Duplicate ACK relays from two sockets of one session cannot happen, by the same server rule (R-I2a-ii-46).
- **No takeover before the owner's lease ends, in the lane** (R-I2a-ii-32). Recovery at the lease end plus at most 19.1 s is pinned by `al-work-lease-recovery.test.ts`. A released lock proves nothing about an in-flight batch, so the lease rule and D113's bound stand (proposal §8, "a lock-proven early reclaim").
- **Cancel from a waiting tab** reaches only that tab's runtimes, and the owner keeps dispatching (R-I2a-ii-9).
- **Without `BroadcastChannel`** but with Web Locks (no known browser):
  - a waiting tab's row waits for the owner's age-bound probe (D112, at most 6.6 s);
  - the owner's settlements never reach the waiting tab's handle (R-I2a-ii-42).
- **A takeover whose store cannot open** records failing health in that batch, and the next batch reports the recovery (R-I2a-ii-30).
- **The session channel's guard is per test** (R-I2a-ii-49). A new unit test that connects through the composition singleton without `installFakeBroadcastChannelPerTest()` opens a real Node channel, and no gate catches it.
- **`lane` is optional on `ALDeliverySettlement`** (R-I2a-ii-48). A settlement no lane stated is never relayed.
- **Relic** (R-I2a-ii-12, -15, -17, Task 7):
  - The non-idempotent command kinds (`start-expedition`, `continue-review`, `force-resolve-round`, `pickup-relic`, `submit-action`) are covered only by msgId dedup within the deadline plus grace (D126).
  - An unavailable store now reports `failed` and sends nothing.
  - A reloaded Relic command has no browser proof here; that is I2b's.
- **Hosted takeover evidence** is a carry (D124, decision 6). Manifests 18 and 22 do not run `durable-takeover`.

---

### Task 1: The shared Web Locks port (`ALBrowserLocks`) with `signal`; the commit lock moved onto it

Prototyped in scratch as commit `3e931f558` on `ee510bbb0` (red then green; scratch `816276026` on the
assembled tree). Decision D123 ("a second lock name on the shared BrowserLocks port"), proposal §3.f "The port", fact
sheet item 1. Rulings: R-I2a-ii-5 (the default composition still injects the lock manager and requests no owner
lock), R-I2a-ii-18 (the module's folder and name).

**Files**

- Create: `packages/shared/alm/storage/al-browser-locks.ts` (23 lines) — `ALBrowserLockOptions`
  (`mode: 'exclusive'`, `signal?: AbortSignal`), `ALBrowserLocks` (the port, unchanged method shape),
  `readALBrowserLocks()` (the one `navigator.locks` read), `toALOutboundCommitLockName(senderId)`.
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` — delete the namespace member
  `ALOutboundMessageRuntime.BrowserLocks` (`:333-336` at base); `Resources.browserLocks` (`:355`) becomes
  `ALBrowserLocks | undefined`; one type import after `:21`.
- Modify: `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts` — `Dependencies.browserLocks`
  (`:91`) takes `ALBrowserLocks`; the lock name at `:585` comes from `toALOutboundCommitLockName(senderId)`;
  import after `:9`. Behaviour and the `browser-lock-wait`/`browser-lock-hold` diagnostics (`:580-632`) are
  unchanged.
- Modify: `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts` — `Input.browserLocks` (`:62`) takes
  `ALBrowserLocks`; import after `:8`.
- Modify: `packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts` — `browserLocks`
  (`:124-126`) becomes `readALBrowserLocks()`; import after `:8`.
- Modify: `packages/shared/alm/outbound/README.md` (`:6-7`) — the navigation line names the shared port.
- Test (create): `packages/tests/shared/alm/storage/al-browser-locks.test.ts` (38 lines), beside
  `al-storage-readiness.test.ts`.
- Not touched: every existing lock fake (`al-outbound-message-runtime.test.ts:380-461`,
  `al-outbound-control-handoff-two-tabs.test.ts:216-235`, `outbound-control-handoff.test.ts:342-354`,
  `ws-rtc-control-handoff-latency.test.ts:91-130`) and the hand-built `browserLocks: undefined` objects: they
  stub `navigator.locks` or pass `undefined`, both of which the moved port accepts as before, and the exact
  lock-count assertions (`ws-rtc-control-handoff-latency.test.ts:300,315`, `outbound-control-handoff.test.ts:68-217`)
  are unchanged because no new lock is requested here.

**Interfaces**

- Consumes: nothing new.
- Produces (`packages/shared/alm/storage/al-browser-locks.ts`):

  <!-- dprint-ignore -->
  ```ts
  export interface ALBrowserLockOptions {
      readonly mode: 'exclusive';
      /** Abandons the request while it still waits; absent, the request waits until it is granted. */
      readonly signal?: AbortSignal;
  }
  export interface ALBrowserLocks {
      request<T>(name: string, options: ALBrowserLockOptions, callback: () => Promise<T>): Promise<T>;
  }
  export function readALBrowserLocks(): ALBrowserLocks | undefined;
  export function toALOutboundCommitLockName(senderId: string): string;   // `rallar:al-outbound-commit:${senderId}`
  ```
  `ALOutboundMessageRuntime.BrowserLocks` is removed, not aliased (one canonical name per type); its four
  consumers (`Resources.browserLocks`, `ALOutboundStoreLane.Input.browserLocks`,
  `ALOutboundDispatchAdmission.Dependencies.browserLocks`, the default composition) name `ALBrowserLocks`.
  `signal` is optional because the commit lock never passes one (it waits until granted); Task 3's owner
  claim passes the connect's signal. `navigator.locks` (`LockManager`) stays assignable: `LockOptions`
  carries `mode` and `signal`.

**D8 reuse inspection.** The existing port (`ALOutboundMessageRuntime.BrowserLocks`, the only lock port in the
repo, fact sheet item 10) is moved and widened, not duplicated; the `navigator.locks` feature test the default
composition already made (`create-default-al-outbound-message-runtime.ts:124-126`) moves verbatim into
`readALBrowserLocks()`, so Task 3's composition reads the browser through the same function. The lock-name
builder sits beside the port so every Web Lock name ALM takes is in one module (Task 3 adds the second).
`packages/shared/cache` and `packages/shared/resilience` hold no lock, lease or leader primitive (none exists in
the repo); nothing new is introduced. The folder is `packages/shared/alm/storage/` (6 files): `alm/` itself holds
20 direct files, and a 21st trips `layout.directory-density` (threshold > 20); both locks guard the durable
store across browsing contexts, which is the storage folder's concern (R-I2a-ii-18).

- [ ] **Step 1: Write the failing test.** Create `packages/tests/shared/alm/storage/al-browser-locks.test.ts`:

<!-- dprint-ignore -->
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultALOutboundRuntimeResources } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { readALBrowserLocks, toALOutboundCommitLockName } from '@shared/alm/storage/al-browser-locks.ts';

import { decodeOutboundTestPayload } from '../outbound-test-payload.ts';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('ALBrowserLocks', () => {
    it('reads the browser lock manager where the Locks API exists', () => {
        const locks = { request: vi.fn() };
        vi.stubGlobal('navigator', { locks });

        expect(readALBrowserLocks()).toBe(locks);
    });

    it('reads no lock manager where the Locks API is missing', () => {
        vi.stubGlobal('navigator', {});

        expect(readALBrowserLocks()).toBeUndefined();
    });

    it('names the commit lock by its sender', () => {
        expect(toALOutboundCommitLockName('self')).toBe('rallar:al-outbound-commit:self');
    });

    it('hands the default outbound resources the browser lock manager', () => {
        const locks = { request: vi.fn() };
        vi.stubGlobal('navigator', { locks });

        const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeOutboundTestPayload });

        expect(resources.browserLocks).toBe(locks);
    });
});
```

- [ ] **Step 2: Run it and see it fail.**

```sh
npx vitest run packages/tests/shared/alm/storage/al-browser-locks.test.ts
```

Expected (measured at `ee510bbb0`): `Error: Cannot find package '@shared/alm/storage/al-browser-locks.ts'`,
`Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 3: Create the port module** `packages/shared/alm/storage/al-browser-locks.ts`:

<!-- dprint-ignore -->
```ts
export interface ALBrowserLockOptions {
    readonly mode: 'exclusive';
    /** Abandons the request while it still waits; absent, the request waits until it is granted. */
    readonly signal?: AbortSignal;
}

/**
 * The Web Locks port every cross-context lock of ALM is a name on. The browser injects
 * `navigator.locks`; a runtime without the API (the server, Node, a browser without it) has none.
 */
export interface ALBrowserLocks {
    /** Holds the named exclusive lock until the single callback invocation settles. */
    request<T>(name: string, options: ALBrowserLockOptions, callback: () => Promise<T>): Promise<T>;
}

export function readALBrowserLocks(): ALBrowserLocks | undefined {
    return typeof globalThis.navigator?.locks?.request === 'function' ? globalThis.navigator.locks : undefined;
}

/** Serializes one sender's IndexedDB commits across the tabs of a browser. */
export function toALOutboundCommitLockName(senderId: string): string {
    return `rallar:al-outbound-commit:${senderId}`;
}
```

- [ ] **Step 4: Move the runtime's port onto it.** `packages/shared/alm/outbound/al-outbound-message-runtime.ts`
      (the namespace member goes; `Resources.browserLocks` names the shared port):

```diff
--- a/packages/shared/alm/outbound/al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
@@ -19,6 +19,7 @@ import type {
     ALDeliverySettlementSink
 } from '../delivery/al-delivery-lifecycle.ts';
 import type { ALStorageResetListeners } from '../open-indexed-db-admission-database.ts';
+import type { ALBrowserLocks } from '../storage/al-browser-locks.ts';
 import type { ALStorageHealth } from '../storage/al-storage-health.ts';
 import type { ALStorageReadiness } from '../storage/al-storage-readiness.ts';
 import type { ALStorageRecoveryReporter } from '../storage/al-storage-recovery-reporter.ts';
@@ -330,11 +331,6 @@ export namespace ALOutboundMessageRuntime {
         nowMs(): number;
     }
 
-    export interface BrowserLocks {
-        /** Holds the named exclusive lock until the single callback invocation settles. */
-        request<T>(name: string, options: Readonly<{ mode: 'exclusive'; }>, callback: () => Promise<T>): Promise<T>;
-    }
-
     export interface Resources<TPrepared> {
         /** The durable pair, and the only one of a runtime without `volatileStores`. */
         readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
@@ -352,7 +348,7 @@ export namespace ALOutboundMessageRuntime {
         readonly random: () => number;
         readonly queueEngine: InboxOutboxEngine;
         readonly ownsQueueEngine: boolean;
-        readonly browserLocks: BrowserLocks | undefined;
+        readonly browserLocks: ALBrowserLocks | undefined;
     }
 
     export interface DequeueSource {
```

- [ ] **Step 5: Commit lock on the shared port.** `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts`
      (only the type and the name builder change; `withCrossContextCommitLock`/`withHeldCommitLock` and their
      diagnostics are untouched):

```diff
--- a/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts
+++ b/packages/shared/alm/outbound/al-outbound-dispatch-admission.ts
@@ -6,6 +6,7 @@ import { toError } from '../../resilience/to-error.ts';
 import { RetryableConflictError } from '../../resilience/TryWith.ts';
 import type { ALStoreDurability } from '../al-runtime-stores.ts';
 import type { ALDeliveryAdmissionVerdict } from '../delivery/al-delivery-lifecycle.ts';
+import { toALOutboundCommitLockName, type ALBrowserLocks } from '../storage/al-browser-locks.ts';
 import { toALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
 import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
 import type {
@@ -88,7 +89,7 @@ export namespace ALOutboundDispatchAdmission {
         readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
         readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
         readonly clock: ALOutboundMessageRuntime.Clock;
-        readonly browserLocks: ALOutboundMessageRuntime.BrowserLocks | undefined;
+        readonly browserLocks: ALBrowserLocks | undefined;
         readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
         readonly settlements: ALOutboundSettlementEmitter;
     }
@@ -582,7 +583,7 @@ export class ALOutboundDispatchAdmission<TPrepared> {
         origin: ALOutboundCommitOrigin,
         task: () => Promise<T>
     ): Promise<T> {
-        const lockName = `rallar:al-outbound-commit:${senderId}`;
+        const lockName = toALOutboundCommitLockName(senderId);
         const locks = this.dependencies.browserLocks;
         if (!locks) {
             this.emitDiagnostics({
```

- [ ] **Step 6: The lane input and the default composition.**

```diff
--- a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
+++ b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
@@ -5,6 +5,7 @@ import { toKeyAsString, type ResourceEntry } from '../../../queuebox/ResourceEnt
 import type { ALStoreDurability } from '../../al-runtime-stores.ts';
 import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '../../ALStoreRetention.ts';
 import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
+import type { ALBrowserLocks } from '../../storage/al-browser-locks.ts';
 import { ALStorageReadiness } from '../../storage/al-storage-readiness.ts';
 import {
     AL_WORK_READINESS_MEMORY_MS,
@@ -59,7 +60,7 @@ export namespace ALOutboundStoreLane {
         readonly workerId: string;
         /** Foreign queue rows only the durable lane admits; the volatile lane names none. */
         readonly dequeueTypes: ReadonlySet<string>;
-        readonly browserLocks: ALOutboundMessageRuntime.BrowserLocks | undefined;
+        readonly browserLocks: ALBrowserLocks | undefined;
         /** The memory pair's sweep; undefined for a lane over a durable pair. */
         readonly evictExpired: (() => void) | undefined;
         /** What this lane's commits hand its own claims; the memory pair's lane reads memory and has none. */
```

```diff
--- a/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
@@ -6,6 +6,7 @@ import { CircuitBreakerPolicy } from '../../resilience/circuit-breaker.ts';
 import { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
 import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../al-admission-backend.ts';
 import { createDefaultInMemoryALOutboundRuntimeStores } from '../al-runtime-stores.ts';
+import { readALBrowserLocks } from '../storage/al-browser-locks.ts';
 import type { ALOutboundPreparedMessageDecoder } from './admission/al-outbound-admission-store.ts';
 import {
     ALOutboundMessageRuntime,
@@ -121,8 +122,6 @@ export function createDefaultALOutboundRuntimeResources<TPrepared>(
         random: input.random ?? Math.random,
         queueEngine: input.queueEngine ?? new InboxOutboxEngine(),
         ownsQueueEngine: input.queueEngine === undefined,
-        browserLocks: typeof globalThis.navigator?.locks?.request === 'function'
-            ? globalThis.navigator.locks
-            : undefined
+        browserLocks: readALBrowserLocks()
     };
 }
```

- [ ] **Step 7: Navigation map.** `packages/shared/alm/outbound/README.md`:

```diff
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -4,7 +4,10 @@
 lifecycle boundary: it enqueues, accepts control messages, claims work, and routes
 each claimed durable effect to the owner that runs it. It never sends or mutates
 admission state itself. [`ALOutboundDispatchAdmission`](./al-outbound-dispatch-admission.ts)
-owns sender serialization, browser locking, and optimistic read/compute/commit.
+owns sender serialization, browser locking, and optimistic read/compute/commit. Its cross-tab commit
+lock, `rallar:al-outbound-commit:<senderId>`, is a name on the shared Web Locks port
+[`ALBrowserLocks`](../storage/al-browser-locks.ts), which the default composition fills with
+`navigator.locks` where the API exists.
 [`ALOutboundRepairAdmission`](./al-outbound-repair-admission.ts) owns control
 acceptance, the ACK-timeout schedule, and the not-yet-in-sync retry schedule; it
 commits new bundles and never sends.
```

- [ ] **Step 8: Format the touched files only.**

```sh
npx dprint fmt packages/shared/alm/storage/al-browser-locks.ts packages/tests/shared/alm/storage/al-browser-locks.test.ts \
  packages/shared/alm/outbound/al-outbound-message-runtime.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts \
  packages/shared/alm/outbound/al-outbound-dispatch-admission.ts \
  packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts packages/shared/alm/outbound/README.md
```

- [ ] **Step 9: Run the new test and every existing lock test.**

```sh
npx vitest run packages/tests/shared/alm/storage/al-browser-locks.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/alm/outbound/al-outbound-control-handoff-two-tabs.test.ts packages/tests/shared/alm/outbound-control-handoff.test.ts \
  packages/tests/shared/webrtc/ws-rtc-control-handoff-latency.test.ts
```

Expected (measured): `Test Files  5 passed (5)`, `Tests  48 passed (48)`; the commit-lock name
`'rallar:al-outbound-commit:self'` pin (`al-outbound-message-runtime.test.ts:380`) and the exact lock counts
(`ws-rtc-control-handoff-latency.test.ts:300,315`, `outbound-control-handoff.test.ts:342`) pass unedited.

- [ ] **Step 10: Per-task checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
(cd apps/api-v1 && deno task check)
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
npm run check:test-reachability
```

Expected (measured): no `tsc` output; both workspace typechecks and `deno task check` exit 0;
`check-tests-typecheck: 1427 test files enforced ... PASS: no new type errors`; the three pins
`Test Files  3 passed (3)`, `Tests  25 passed (25)`, unedited; `browser/rallar.ts` 233.065 KiB (233.1 in the
table, budget 234, `Bundle budget check passed.`); headless 297.773 KiB (budget 298, `Tests  1 passed (1)`);
`Test reachability: 1729 test files, 1723 reached by CI, 6 manual.` Base figures for comparison: 232.975 and
297.686 KiB.

- [ ] **Step 11: Commit, then run the changed-range gates.**

```sh
git add packages/shared/alm/storage/al-browser-locks.ts packages/tests/shared/alm/storage/al-browser-locks.test.ts \
  packages/shared/alm/outbound/al-outbound-message-runtime.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts \
  packages/shared/alm/outbound/al-outbound-dispatch-admission.ts \
  packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts packages/shared/alm/outbound/README.md
git commit -F - <<'EOF'
Move the Web Locks port into one shared ALM module

ALBrowserLocks leaves ALOutboundMessageRuntime's namespace for
packages/shared/alm/storage/al-browser-locks.ts, widened by an optional
signal on the request options. The commit lock keeps its name, its
behaviour and its browser-lock-wait/-hold diagnostics; its name builder
and the navigator.locks read live beside the port, and the default
outbound composition injects the lock manager through it.

D8 reuse: the existing ALOutboundMessageRuntime.BrowserLocks port is moved and widened, not duplicated; packages/shared/cache and packages/shared/resilience offer no lock primitive, and no new coordination primitive is added.
EOF
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured): `PASS: no new repository style findings`; `PASS: no current structure-coupled test
candidates`, `PASS: changed-range structure-coupling review has complete individual classifications`.

---

### Task 2: `ALDurableWorkOwnership` and the gated durable work tasks

Prototyped in scratch as commit `932e9cf2d` on Task 1's `3e931f558` (red then green; scratch `610829c28` on
the assembled tree). Decisions
D123 (non-owners commit but run no durable work task; takeover runs the bootstrap) and D113 (the recovery
bound the takeover inherits); proposal §3.f, §3.h; fact sheet items 2, 3, 6, 9, 11. Rulings: R-I2a-ii-3 (the
gate is one seam in `ALWorkHandler`), R-I2a-ii-4 (where the value enters), R-I2a-ii-6 (the lanes'
`applyForeignCommit`), R-I2a-ii-19..R-I2a-ii-23, R-I2a-ii-27, R-I2a-ii-28.

**Files**

- Create: `packages/shared/alm/work/al-durable-work-ownership.ts` (51 lines) — `ALDurableWorkCommit`,
  `ALDurableWorkOwnership`, `ALDurableWorkLaneOwnership`, `ALWAYS_OWNED_AL_DURABLE_WORK`,
  `toALDurableWorkLaneOwnership`.
- Create: `packages/shared/alm/work/al-work-engine-membership.ts` (77 lines) — `ALWorkEngineMembership`: the
  handler's task on the engine, which follows the ownership (cognitive load 7).
- Modify: `packages/shared/alm/work/al-work-handler.ts` — `ALWorkHandlerDependencies.durableOwnership?`
  (after `storageHealth`, `:75`); the constructor's `includeTask`/`includeWakeListener` (`:181-193`) become one
  `ALWorkEngineMembership`; `ready()` (`:196-205`) returns early while not owned; `dispose()` (`:207-214`)
  disposes the membership; `committed()` (`:223-232`) announces instead of running while not owned. File
  cognitive load 43 → 44 (inline it scored 50, the warn tier: R-I2a-ii-20).
- Modify: `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts` — `Input.durableWorkOwnership`
  (after `:62`); the handler built by a new private `createWorkHandler(workPort, workType)` (moved from the
  constructor, `:104-117`, so the constructor stays at 35 lines); the foreign-commit listener; public
  `applyForeignCommit(rows)`; `dispose()` removes the listener. Load 49 → 49.
- Modify: `packages/shared/alm/inbound/lane/al-inbound-store-lane.ts` — the same shape: `Input.durableWorkOwnership`
  (after `:64`), `workType` computed once (`:102-105` already computed it for the recovery reporter), a private
  `createWorkHandler` (moved from `:111-127`), the listener, public `applyForeignCommit()` = `commitWork()`
  (`:215-218`). Load 33 → 33.
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (`Resources` `:337-356`, lanes
  `:431-461`), `packages/shared/alm/inbound/al-inbound-message-runtime.ts` (`Resources` `:93-109`, lanes
  `:189-202`) — the required `durableWorkOwnership` resource, handed to the durable lane, `undefined` to the
  volatile one.
- Modify: `packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts` (`:36-45`, `:93-128`),
  `packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts` (`:15-25`, `:40-65`) — optional
  input, defaulted to `ALWAYS_OWNED_AL_DURABLE_WORK`.
- Modify (pass-through, R-I2a-ii-4): `packages/shared/services/ws-queue-box-client-service.ts`
  (`Input` `:115-139`, `createDefaultWsQueueBoxClientService` `:598-627`),
  `packages/shared/services/web-rtc-rx-streamer-service.ts` (`Input` `:62-72`, factory `:530-549`),
  `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts` (`Input` `:34-52`, `:72-108`),
  `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts` (`:52-59`, `:72-80`, `:92-117`),
  `packages/shared-web/browser/connection/initialise-browser-middleware.ts` (`InitialiseBrowserTransportInput`
  `:184-192`, `createBrowserTransportInput` `:262-276`, `toBrowserWebSocketQueueBoxInput` `:315-330`,
  `initialiseRtcRxStreamer` call `:383-393`, `toRtcOverlayMulticastManagerInput` `:413-419`). Until Task 3 the
  middleware passes `ALWAYS_OWNED_AL_DURABLE_WORK`, today's behaviour.
- Modify: `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` — 298 → 299 (crossed:
  298.196 KiB measured).
- Test (create): `packages/tests/shared/alm/work/al-durable-work-ownership.test.ts` (247 lines);
  `packages/tests/shared/alm/session-outbound-test-runtime.ts` (93 lines, a test support module Task 3's test
  reuses).
- Test (modify): `packages/tests/shared/alm/inbound-runtime-test-fixture.ts` (`CreateInboundTestRuntimeInput`
  `:131-152` gains optional `durableWorkOwnership`, passed at `:160-166`; every existing caller unchanged);
  `packages/tests/shared-web/connection/initialise-browser-middleware.test.ts` (one new case); the two hand-built
  `Resources`/`Dependencies` literals (`al-outbound-message-runtime.test.ts:55-71`,
  `al-inbound-admission-preparation.test.ts:570-589`) gain the field; 16 literal carrier inputs in five
  shared-web test files gain it (Step 10).
- Docs: `packages/shared/alm/outbound/README.md` ("Construction and registration", after `:40`),
  `packages/shared/alm/inbound/README.md` (after `:61`).
- Not touched: `outbound-runtime-test-fixture.ts:105-135` (`captureOutboundWorkRunnable`,
  `createOutboundRuntimeWithWorkTask` still see construction-time registration under the default), the ledger,
  cold, inbound and storage-snapshot pins, every `new ALWorkHandler` site in the tests (35; the field is
  optional), `InboxOutboxEngine.ts`, the server's runtime composition (`ws-queue-box-server-service.ts:602-632`
  takes the default through `createDefault…RuntimeResources`).

**Interfaces**

- Consumes: Task 1 nothing; `ObservableLatestValue`/`ObservableValue`/`Unsubscribe` from
  `packages/shared/cache`; `ALWorkCommittedRows` (`al-work-readiness-memory.ts:14-25`); `LoopsTaskDto`
  (`packages/shared/resilience/ComputeAsyncTask.ts:205-212`).
- Produces (`packages/shared/alm/work/al-durable-work-ownership.ts`):

  <!-- dprint-ignore -->
  ```ts
  export interface ALDurableWorkCommit {
      readonly workType: string;              // toALOutboundWorkType(namespace) | toALInboundWorkType(namespace, carrier)
      readonly rows: ALWorkCommittedRows;
  }
  export interface ALDurableWorkOwnership {
      readonly owned: ObservableValue<boolean>; // turns true at most once, never back
      isOwned(): boolean;
      announceCommit(commit: ALDurableWorkCommit): void;
      /** Heard only while this runtime owns the work, so no commit is announced twice. */
      onForeignCommit(workType: string, listener: (rows: ALWorkCommittedRows) => void): () => void;
  }
  export interface ALDurableWorkLaneOwnership { readonly ownership: ALDurableWorkOwnership; readonly workType: string; }
  export const ALWAYS_OWNED_AL_DURABLE_WORK: ALDurableWorkOwnership;
  export function toALDurableWorkLaneOwnership(
      ownership: ALDurableWorkOwnership | undefined, workType: string
  ): ALDurableWorkLaneOwnership | undefined;
  ```
  `packages/shared/alm/work/al-work-engine-membership.ts`: `class ALWorkEngineMembership { constructor(input:
  ALWorkEngineMembership.Input); isOwned(): boolean; announceUnlessOwned(rows): boolean; dispose(): void }`.
  `ALWorkHandlerDependencies.durableOwnership?: ALDurableWorkLaneOwnership`;
  `ALOutboundStoreLane.applyForeignCommit(rows: ALWorkCommittedRows): void`;
  `ALInboundStoreLane.applyForeignCommit(): void`;
  `ALOutboundMessageRuntime.Resources.durableWorkOwnership` and `ALInboundMessageRuntime.Resources.durableWorkOwnership`
  (required); optional `durableWorkOwnership` on `DefaultALOutboundRuntimeResourceInput`,
  `DefaultALInboundRuntimeResourceInput`, `WsQueueBoxClientService.Input`, `WebRtcRxStreamerService.Input`;
  required on `CreateBrowserWebSocketQueueBox.Input`, `InitialiseRtcOverlayMulticastManagerInput`,
  `InitialiseRtcRxStreamerInput`, `InitialiseBrowserTransportInput`.
- Refinements of the decided shape (R-I2a-ii-19): `announceCommit` takes `{ workType, rows }` and `onForeignCommit` is
  keyed by `workType`, because one ownership value serves the session's four durable lanes (WS and RTC outbound,
  WS and RTC inbound) and the owner must route a commit to the lane of its work type (R-I2a-ii-6); the work type is
  the routing key because it is deterministic per store namespace and carrier in every runtime of the session,
  where worker ids are random per runtime. `owned` is typed `ObservableValue<boolean>` (the cache's read-side
  interface) so no consumer can write it.
- Behaviour: an absent `durableOwnership`, and the always-owned value, include the task and the wake listener at
  construction exactly as today. A handler whose ownership is false at construction includes nothing, its
  `ready()` runs no bootstrap, and `committed(rows)` calls `announceCommit({ workType, rows })` and returns
  (nothing suspended, no wake, no batch); the engine never asks it `isWork`, so it reads no storage. On the
  `owned` value's change to true it includes the task and the wake listener once and runs `ready()` (the
  bootstrap batch) once, whose `work-batch` diagnostic makes the lane's recovery reporter state the takeover's
  outcome (`restored` for an existing database). Disposed first, it takes nothing over. A row the previous owner
  held is claimed by a later batch's lease sweep (D113): nothing in the takeover reads a lease.

**D8 reuse inspection.** The gate is the engine's own registration (`includeTask`/`excludeTask`,
`includeWakeListener`/`excludeWakeListener`, `InboxOutboxEngine.ts:52-74`): a task included after `start()` is
picked up on the next pass (`:225`), and `wakeAt` for an unregistered id is a no-op (`:81-83`), so no scheduler,
timer or wake path is added. The announce and the owner's apply reuse the handler's `committed(rows)` path and
`ALWorkCommittedRows` (already serialisable, `al-work-readiness-memory.ts:14-25`), never
`wakeAfterExternalWrite` (§3.g). The owned flag is an `ObservableLatestValue<boolean>` from
`packages/shared/cache`, as `ALStorageHealth` keeps its state (`al-storage-health.ts:18`). The takeover's recovery
outcome is the I2a-i reporter (`al-storage-recovery-reporter.ts:40-58`), unchanged: a non-owner runs no batch, so
its reporter stays armed. The two lanes' handler construction moves into one private method each rather than a
shared helper (their inputs differ: probe memory, selector, diagnostics). `packages/shared/resilience` holds no
ownership primitive. The test support module is new because Task 3 runs the same two-runtime session over the
same IndexedDB pair; `outbound-runtime-test-fixture.ts`'s `createOutboundRuntimeWithWorkTask` throws for a runtime
that registers no task at construction, which is exactly the non-owner, so it is not reused there.

- [ ] **Step 1: Write the failing test and its support module.** Create
      `packages/tests/shared/alm/session-outbound-test-runtime.ts`:

<!-- dprint-ignore -->
```ts
import '../../setup-browser-indexeddb.ts';

import { onTestFinished } from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultIndexedDbALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createVolatileOutboundTestStores } from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

/** One browser session's IndexedDB outbound store, which every runtime of the session opens, as tabs do. */
export interface OutboundTestSession {
    readonly dbName: string;
    readonly namespace: string;
    /** The storage events every runtime's store stated, in the order they were stated. */
    readonly storage: ALStorageEvent[];
}

export interface SessionOutboundTestRuntime<TOwnership extends ALDurableWorkOwnership> {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly engine: InboxOutboxEngine;
    readonly ownership: TOwnership;
    /** The resource id of every message this runtime's carrier sent, in send order. */
    readonly sent: readonly string[];
    /** The admission namespace whose work type the session's runtimes share. */
    readonly namespace: string;
    readDurableProbes(): readonly ALOutboundRuntimeDiagnosticsEvent[];
}

export function createOutboundTestSession(): OutboundTestSession {
    return { dbName: `session-outbound-${crypto.randomUUID()}`, namespace: 'session-outbound', storage: [] };
}

/**
 * One runtime of the session on an engine of its own: a message whose resource id starts with
 * `durable` goes to the IndexedDB lane, any other to the runtime's memory lane.
 */
export function createSessionOutboundTestRuntime<TOwnership extends ALDurableWorkOwnership>(
    session: OutboundTestSession,
    ownership: TOwnership
): SessionOutboundTestRuntime<TOwnership> {
    const engine = new InboxOutboxEngine();
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const sent: string[] = [];
    const stores = createDefaultIndexedDbALOutboundRuntimeStores<OutboundTestPayload>({
        dbName: session.dbName,
        namespace: session.namespace,
        decodePrepared: decodeOutboundTestPayload,
        storageHealth: new ALStorageHealth({ storeId: session.namespace, storage: (event) => session.storage.push(event) })
    });
    const runtime = createDefaultALOutboundMessageRuntime<OutboundTestPayload>({
        decodePreparedMessage: decodeOutboundTestPayload,
        queueEngine: engine,
        outbox: new InMemoryQueueBox(new Map()),
        stores,
        volatileStores: createVolatileOutboundTestStores(),
        durableWorkOwnership: ownership,
        carrier: 'ws',
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: msg.route.resourceId.startsWith('durable'),
            preparedMessages: [{ peer: 'receiver' }]
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage.route.resourceId);
            return { status: 'sent', submissionAttempted: true };
        },
        diagnostics: (event) => diagnostics.push(event)
    });
    onTestFinished(() => runtime.dispose());
    return {
        runtime,
        engine,
        ownership,
        sent,
        namespace: stores.admissionStore.namespace,
        readDurableProbes: () => diagnostics.filter((event) => event.kind === 'readiness-probe' && event.lane === 'durable')
    };
}
```

Give the inbound fixture its optional ownership input
(`packages/tests/shared/alm/inbound-runtime-test-fixture.ts`):

```diff
--- a/packages/tests/shared/alm/inbound-runtime-test-fixture.ts
+++ b/packages/tests/shared/alm/inbound-runtime-test-fixture.ts
@@ -37,6 +37,7 @@ import {
 } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
 import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
 import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
+import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
 import type { IndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
 import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
 import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
@@ -147,6 +148,8 @@ export interface CreateInboundTestRuntimeInput {
     readonly gateDispatch?: (msg: ALMessage) => Promise<void>;
     /** Absent sends every control; a call carrying a message this names throws, the way a transport refusal does. */
     readonly failControlSend?: (msg: ALMessage) => boolean;
+    /** Absent leaves the runtime owning its durable work, as every runtime without a session claim does. */
+    readonly durableWorkOwnership?: ALDurableWorkOwnership;
 }
 
 /** The runtime never owns its engine here: a test drives every round it runs beyond a commit's own. */
@@ -162,7 +165,8 @@ export function createInboundTestRuntime(input: CreateInboundTestRuntimeInput):
             stores: input.stores,
             volatileStores: input.volatileStores,
             queueEngine,
-            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
+            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox'),
+            durableWorkOwnership: input.durableWorkOwnership
         }),
         carrier: input.carrier,
         planIncomingMessage: (msg, source, observations) => {
```

Create `packages/tests/shared/alm/work/al-durable-work-ownership.test.ts`:

<!-- dprint-ignore -->
```ts
import '../../../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createDefaultIndexedDbALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    ALWAYS_OWNED_AL_DURABLE_WORK,
    type ALDurableWorkCommit,
    type ALDurableWorkOwnership
} from '@shared/alm/work/al-durable-work-ownership.ts';
import {
    AL_WORK_READINESS_MEMORY_MS,
    ALWorkHandler,
    type ALWorkDiagnostics,
    type ALWorkReadinessProbeDiagnostics
} from '@shared/alm/work/al-work-handler.ts';
import type { ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE
} from '../inbound-runtime-test-fixture.ts';
import { createOutboundMessage } from '../outbound-runtime-test-fixture.ts';
import { createOutboundTestSession, createSessionOutboundTestRuntime } from '../session-outbound-test-runtime.ts';
import { collectProbe, fakePort, toFakeALWorkKey, toTestALWorkReadySelection } from './al-work-test-entries.ts';

const WORK_TYPE = 'AL_TEST';
const COMMITTED_W1: ALWorkCommittedRows = { dueByMs: 1_000, writtenKeys: [toFakeALWorkKey('w-1')] };

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ALWorkHandler under a session ownership', () => {
    it('registers no engine task, runs no batch and announces its commits while another runtime owns the work', async () => {
        const fixture = createOwnedHandler(createTestDurableWorkOwnership(false));

        await fixture.handler.ready();
        fixture.handler.committed(COMMITTED_W1);
        fixture.engine.wakeAfterExternalWrite();
        await fixture.engine.executeOnce();

        expect(fixture.released).toEqual([]);
        expect(fixture.probes).toEqual([]);
        expect(fixture.ownership.announced).toEqual([{ workType: WORK_TYPE, rows: COMMITTED_W1 }]);
    });

    it('registers its task and runs the bootstrap batch once when ownership turns true', async () => {
        const fixture = createOwnedHandler(createTestDurableWorkOwnership(false));
        await fixture.handler.ready();

        fixture.ownership.take();

        await vi.waitFor(() => expect(fixture.released).toEqual(['w-1:completed']));
        await fixture.handler.ready();
        expect(fixture.batchCount()).toBe(1);
        // The task now answers the engine's rounds, and an external write reaches its memory.
        await fixture.engine.executeOnce();
        fixture.engine.wakeAfterExternalWrite();
        await fixture.engine.executeOnce();
        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'external-wake']);
        // An owner runs its own commits and announces none.
        fixture.handler.committed(COMMITTED_W1);
        expect(fixture.ownership.announced).toEqual([]);
    });

    it('takes nothing over once disposed', async () => {
        const fixture = createOwnedHandler(createTestDurableWorkOwnership(false));

        fixture.handler.dispose();
        fixture.ownership.take();
        await fixture.ownership.owned.whenIdle();
        await fixture.engine.executeOnce();

        expect(fixture.released).toEqual([]);
        expect(fixture.probes).toEqual([]);
    });

    it('owns its work from construction under the always-owned value, as without one', async () => {
        const fixture = createOwnedHandler(ALWAYS_OWNED_AL_DURABLE_WORK);

        await fixture.engine.executeOnce();

        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory']);
    });
});

describe('two outbound runtimes of one session store', () => {
    it('admits a durable send where the work is not owned, and the owner sends it once on the announced commit', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));

        const admitted = await other.runtime.enqueueIfAbsent(createOutboundMessage('durable-1'));
        await other.engine.executeOnce();

        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(other.sent).toEqual([]);
        expect(other.readDurableProbes()).toEqual([]);
        expect(other.ownership.announced).toEqual([
            {
                workType: toALOutboundWorkType(other.namespace),
                rows: { dueByMs: expect.any(Number), writtenKeys: [expect.any(String)] }
            }
        ]);

        // The session channel relays the announcement; here it is handed to the owner directly.
        other.ownership.announced.forEach((commit) => owner.ownership.deliver(commit));

        await vi.waitFor(() => expect(owner.sent).toEqual(['durable-1']));
        expect(other.sent).toEqual([]);
    });

    it('takes over: registers the durable task, and its bootstrap sends the row and reports restored', async () => {
        const session = createOutboundTestSession();
        const previous = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        await previous.runtime.ready();
        previous.runtime.dispose();
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));
        await other.runtime.enqueueIfAbsent(createOutboundMessage('durable-1'));

        other.ownership.take();

        await vi.waitFor(() => expect(other.sent).toEqual(['durable-1']));
        await other.engine.executeOnce();
        expect(other.readDurableProbes()).not.toEqual([]);
        expect(session.storage.filter((event) => event.kind === 'recovery')).toEqual([
            { kind: 'recovery', storeId: session.namespace, outcome: { kind: 'storage-created' } },
            { kind: 'recovery', storeId: session.namespace, outcome: { kind: 'restored', claimed: 1, expired: 0 } }
        ]);
    });

    it('sends a volatile message from its own memory lane while the durable work is owned elsewhere', async () => {
        const session = createOutboundTestSession();
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));

        await other.runtime.enqueueIfAbsent(createOutboundMessage('volatile-1'));

        await vi.waitFor(() => expect(other.sent).toEqual(['volatile-1']));
        expect(other.ownership.announced).toEqual([]);
    });
});

describe('two inbound runtimes of one session store', () => {
    it('admits a durable message where the work is not owned, and the owner delivers it on the announced commit', async () => {
        const namespace = `owned-inbound-${crypto.randomUUID()}`;
        const owner = createInboundSessionRuntime(namespace, createTestDurableWorkOwnership(true));
        const other = createInboundSessionRuntime(namespace, createTestDurableWorkOwnership(false));
        const message = createInboundTestMessage({ msgId: 'inbox-1', durability: 'local-inbox' });

        expect((await other.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        await other.fixture.queueEngine.executeOnce();

        expect(other.fixture.delivered).toEqual([]);
        expect(other.ownership.announced.map((commit) => commit.workType)).toEqual([
            toALInboundWorkType(other.fixture.stores.admissionStore.namespace, 'ws')
        ]);

        other.ownership.announced.forEach((commit) => owner.ownership.deliver(commit));

        await vi.waitFor(() => expect(owner.fixture.delivered).toEqual(['dispatched']));
        expect(other.fixture.delivered).toEqual([]);
    });
});

interface TestDurableWorkOwnership extends ALDurableWorkOwnership {
    readonly owned: ObservableLatestValue<boolean>;
    readonly announced: readonly ALDurableWorkCommit[];
    take(): void;
    /** Hands an announced commit to the lanes listening for its work type, as the session channel does for an owner. */
    deliver(commit: ALDurableWorkCommit): void;
}

function createTestDurableWorkOwnership(owned: boolean): TestDurableWorkOwnership {
    const value = new ObservableLatestValue<boolean>().set(owned);
    const announced: ALDurableWorkCommit[] = [];
    const listeners = new Map<string, Set<(rows: ALWorkCommittedRows) => void>>();
    return {
        owned: value,
        announced,
        isOwned: () => value.peek() === true,
        take: () => value.accept(true),
        announceCommit: (commit) => announced.push(commit),
        onForeignCommit: (workType, listener) => {
            const forType = listeners.get(workType) ?? new Set();
            listeners.set(workType, forType.add(listener));
            return () => forType.delete(listener);
        },
        deliver: (commit) => {
            if (value.peek() === true) {
                listeners.get(commit.workType)?.forEach((listener) => listener(commit.rows));
            }
        }
    };
}

function createOwnedHandler<TOwnership extends ALDurableWorkOwnership>(ownership: TOwnership) {
    const engine = new InboxOutboxEngine();
    const released: string[] = [];
    const diagnostics: ALWorkDiagnostics[] = [];
    const probes: ALWorkReadinessProbeDiagnostics[] = [];
    const handler = new ALWorkHandler({
        workerId: 'owned-worker',
        port: fakePort({
            claims: ['w-1'],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        }),
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: () => 1_000 },
        pageSize: 16,
        readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (port, size) => toTestALWorkReadySelection(await port.claim({ maxCount: size, observedEntries: undefined })),
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: (event) => {
            diagnostics.push(event);
            collectProbe(probes, event);
        },
        durableOwnership: { ownership, workType: WORK_TYPE }
    });
    onTestFinished(() => handler.dispose());
    return {
        handler,
        engine,
        ownership,
        released,
        probes,
        batchCount: () => diagnostics.filter((event) => event.kind === 'work-batch').length
    };
}

function createInboundSessionRuntime(namespace: string, ownership: TestDurableWorkOwnership) {
    const fixture = createInboundTestRuntime({
        stores: createDefaultIndexedDbALInboundRuntimeStores({ dbName: namespace, namespace }),
        carrier: 'ws',
        effectWorkerId: `al-inbound:${crypto.randomUUID()}`,
        durableWorkOwnership: ownership
    });
    return { fixture, ownership };
}
```

- [ ] **Step 2: Run it and see it fail.**

```sh
npx vitest run packages/tests/shared/alm/work/al-durable-work-ownership.test.ts
```

Expected (measured at `3e931f558`): `Error: Cannot find package '@shared/alm/work/al-durable-work-ownership.ts'`,
`Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 3: Create the ownership contract** `packages/shared/alm/work/al-durable-work-ownership.ts`:

<!-- dprint-ignore -->
```ts
import { ObservableLatestValue } from '../../cache/ObservableLatestValue.ts';
import type { ObservableValue } from '../../cache/RepositoryInterfaces.ts';
import type { ALWorkCommittedRows } from './al-work-readiness-memory.ts';

/** The rows one runtime of a session committed to a durable work type, for the runtime that drains it. */
export interface ALDurableWorkCommit {
    /** One store namespace and carrier name the same work type in every runtime of the session. */
    readonly workType: string;
    readonly rows: ALWorkCommittedRows;
}

/**
 * Which runtime of a session drains the session's durable work. Every runtime admits; only the owner
 * runs work batches, and a runtime that is not the owner announces each commit to the one that is.
 */
export interface ALDurableWorkOwnership {
    /** Turns true at most once and never back: an owner keeps the work until its runtimes are disposed. */
    readonly owned: ObservableValue<boolean>;
    isOwned(): boolean;
    announceCommit(commit: ALDurableWorkCommit): void;
    /**
     * The owner's lane of `workType` hears every commit another runtime announced for it. A runtime
     * hears nothing while it does not own the work, so no commit is announced twice.
     */
    onForeignCommit(workType: string, listener: (rows: ALWorkCommittedRows) => void): () => void;
}

/** One durable lane's place in its session's ownership: the work type its commits are announced under. */
export interface ALDurableWorkLaneOwnership {
    readonly ownership: ALDurableWorkOwnership;
    readonly workType: string;
}

/**
 * The ownership of a runtime whose durable store no other runtime drains: the server's, Node's, and a
 * browser's without the Locks API. It owns its work from construction, so nothing is ever announced.
 */
export const ALWAYS_OWNED_AL_DURABLE_WORK: ALDurableWorkOwnership = {
    owned: new ObservableLatestValue<boolean>().set(true),
    isOwned: () => true,
    announceCommit: () => undefined,
    onForeignCommit: () => () => undefined
};

/** A lane without a session ownership (a memory lane) owns its work from construction. */
export function toALDurableWorkLaneOwnership(
    ownership: ALDurableWorkOwnership | undefined,
    workType: string
): ALDurableWorkLaneOwnership | undefined {
    return ownership === undefined ? undefined : { ownership, workType };
}
```

Run Step 2's command again. Expected (measured): `Tests  4 failed | 4 passed (8)`: the non-owner case, the
outbound announce-and-apply case, the takeover case and the inbound case fail (the handler ignores the ownership:
the non-owner sends and announces nothing); the takeover-once, disposed, always-owned and volatile cases pass
because today's handler already registers at construction.

- [ ] **Step 4: The engine membership** `packages/shared/alm/work/al-work-engine-membership.ts`:

<!-- dprint-ignore -->
```ts
import type { Unsubscribe } from '../../cache/RepositoryInterfaces.ts';
import type { LoopsTaskDto } from '../../resilience/ComputeAsyncTask.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import type { ALDurableWorkLaneOwnership } from './al-durable-work-ownership.ts';
import type { ALWorkCommittedRows } from './al-work-readiness-memory.ts';

export namespace ALWorkEngineMembership {
    export interface Input {
        readonly queueEngine: InboxOutboxEngine;
        readonly workerId: string;
        readonly task: LoopsTaskDto;
        readonly onExternalWake: () => void;
        /** Absent on a lane no other runtime drains: the task joins the engine at construction. */
        readonly durableOwnership: ALDurableWorkLaneOwnership | undefined;
        /** Runs once, when ownership turns true after construction: the new owner's bootstrap. */
        readonly takeOver: () => void;
    }
}

/**
 * A work owner's task on the engine, which follows its session's ownership. An owner's task joins at
 * construction; a runtime that does not own the work keeps it out, announces each commit to the owner
 * instead, and joins when ownership turns true. A row the previous owner held under its lease is left
 * to the lease sweep of a later batch: a released ownership proves nothing about a batch still running.
 */
export class ALWorkEngineMembership {
    private readonly input: ALWorkEngineMembership.Input;
    private included = false;
    private disposed = false;
    private readonly ownershipListener: Unsubscribe | undefined;

    constructor(input: ALWorkEngineMembership.Input) {
        this.input = input;
        if (this.isOwned()) {
            this.include();
        }
        else {
            this.ownershipListener = input.durableOwnership?.ownership.owned.onChangeDo(() => this.takeOver());
        }
    }

    isOwned(): boolean {
        return this.input.durableOwnership?.ownership.isOwned() ?? true;
    }

    /** Whether the commit went to the owner; false when this runtime owns the work and runs it itself. */
    announceUnlessOwned(rows: ALWorkCommittedRows): boolean {
        const durable = this.input.durableOwnership;
        if (durable === undefined || durable.ownership.isOwned()) {
            return false;
        }
        durable.ownership.announceCommit({ workType: durable.workType, rows });
        return true;
    }

    dispose(): void {
        this.disposed = true;
        this.ownershipListener?.unsubscribe();
        this.input.queueEngine.excludeWakeListener(this.input.workerId);
        this.input.queueEngine.excludeTask(this.input.workerId);
    }

    private include(): void {
        const { queueEngine, workerId } = this.input;
        this.included = true;
        queueEngine.includeTask(workerId, this.input.task);
        queueEngine.includeWakeListener(workerId, this.input.onExternalWake);
    }

    private takeOver(): void {
        if (this.included || this.disposed || !this.isOwned()) {
            return;
        }
        this.include();
        this.input.takeOver();
    }
}
```

- [ ] **Step 5: The handler takes the ownership through it** (`packages/shared/alm/work/al-work-handler.ts`):

```diff
--- a/packages/shared/alm/work/al-work-handler.ts
+++ b/packages/shared/alm/work/al-work-handler.ts
@@ -5,6 +5,8 @@ import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS, type InboxOutboxEngine } from '../../s
 import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
 import type { ALStorageHealth } from '../storage/al-storage-health.ts';
 import { toALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
+import type { ALDurableWorkLaneOwnership } from './al-durable-work-ownership.ts';
+import { ALWorkEngineMembership } from './al-work-engine-membership.ts';
 import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort, ALWorkRelease } from './al-work-queue-port.ts';
 import {
     ALWorkReadinessMemory,
@@ -73,6 +75,12 @@ export interface ALWorkHandlerDependencies {
      * reporter, so their batch failures are logged; the browser's durable lanes pass it.
      */
     readonly storageHealth?: ALStorageHealth;
+    /**
+     * The session ownership a durable lane's work runs under. While another runtime owns it, this
+     * handler joins no engine round, runs no batch and announces its commits instead. Absent on a lane
+     * no other runtime drains (the server's, a memory lane's), which owns its work from construction.
+     */
+    readonly durableOwnership?: ALDurableWorkLaneOwnership;
 }
 
 export type ALWorkDiagnostics = ALWorkBatchDiagnostics | ALWorkReadinessProbeDiagnostics;
@@ -174,27 +182,31 @@ export class ALWorkHandler {
     /** Set when committed() lands while a batch is running; drained by one follow-up batch at that batch's end. */
     private commitPending = false;
     private readonly shutdown = new AbortController();
+    private readonly engine: ALWorkEngineMembership;
 
     constructor(dependencies: ALWorkHandlerDependencies) {
         this.dependencies = dependencies;
         this.readiness = new ALWorkReadinessMemory(dependencies.readinessMemoryMs);
-        dependencies.queueEngine.includeTask(dependencies.workerId, {
-            name: dependencies.workerId,
-            maxConcurrency: () => 1,
-            isWork: () => this.hasReadyWork(),
-            runnable: () => this.runBatch().catch((error) => this.reportBatchFailure(toError(error))),
-            ongoingTasks: []
+        this.engine = new ALWorkEngineMembership({
+            queueEngine: dependencies.queueEngine,
+            workerId: dependencies.workerId,
+            task: {
+                name: dependencies.workerId,
+                maxConcurrency: () => 1,
+                isWork: () => this.hasReadyWork(),
+                runnable: () => this.runBatch().catch((error) => this.reportBatchFailure(toError(error))),
+                ongoingTasks: []
+            },
+            // Only the server announces a write this engine did not make; a row another tab or a reload
+            // wrote is found when the remembered answer reaches its age bound.
+            onExternalWake: () => this.readiness.forget('external-wake'),
+            durableOwnership: dependencies.durableOwnership,
+            takeOver: () => void this.ready().catch((error) => this.reportBatchFailure(toError(error)))
         });
-        // Only the server announces a write this engine did not make; a row another tab or a reload
-        // wrote is found when the remembered answer reaches its age bound.
-        dependencies.queueEngine.includeWakeListener(
-            dependencies.workerId,
-            () => this.readiness.forget('external-wake')
-        );
     }
 
     async ready(): Promise<void> {
-        if (this.bootstrapped || this.shutdown.signal.aborted) {
+        if (this.bootstrapped || this.shutdown.signal.aborted || !this.engine.isOwned()) {
             return;
         }
         await this.runBatch();
@@ -206,8 +218,7 @@ export class ALWorkHandler {
 
     dispose(): void {
         this.shutdown.abort();
-        this.dependencies.queueEngine.excludeWakeListener(this.dependencies.workerId);
-        this.dependencies.queueEngine.excludeTask(this.dependencies.workerId);
+        this.engine.dispose();
         if (this.dependencies.ownsQueueEngine) {
             this.dependencies.queueEngine.stop();
         }
@@ -218,9 +229,13 @@ export class ALWorkHandler {
      * unrelated work. It is also the invalidation an owner owes for any write of its own rows it
      * made outside `runBatch`. `written` says when the last row the commit wrote becomes claimable
      * and which rows it wrote: only a batch that starts at or after then, and completes a claim of
-     * each, can have claimed every one of them.
+     * each, can have claimed every one of them. While another runtime owns the work, the commit is
+     * announced to that owner and runs nothing here.
      */
     committed(written: ALWorkCommittedRows): void {
+        if (this.engine.announceUnlessOwned(written)) {
+            return;
+        }
         this.readiness.suspend(written);
         this.dependencies.queueEngine.wake();
         if (this.batch === undefined) {
```

- [ ] **Step 6: The durable lanes take the ownership, listen for foreign commits, and apply them.**

```diff
--- a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
+++ b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
@@ -7,6 +7,10 @@ import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '../../ALStoreRetention.t
 import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
 import type { ALBrowserLocks } from '../../storage/al-browser-locks.ts';
 import { ALStorageReadiness } from '../../storage/al-storage-readiness.ts';
+import {
+    toALDurableWorkLaneOwnership,
+    type ALDurableWorkOwnership
+} from '../../work/al-durable-work-ownership.ts';
 import {
     AL_WORK_READINESS_MEMORY_MS,
     ALWorkHandler,
@@ -61,6 +65,8 @@ export namespace ALOutboundStoreLane {
         /** Foreign queue rows only the durable lane admits; the volatile lane names none. */
         readonly dequeueTypes: ReadonlySet<string>;
         readonly browserLocks: ALBrowserLocks | undefined;
+        /** The session ownership the durable lane's work runs under; undefined for the volatile lane, which owns its memory pair. */
+        readonly durableWorkOwnership: ALDurableWorkOwnership | undefined;
         /** The memory pair's sweep; undefined for a lane over a durable pair. */
         readonly evictExpired: (() => void) | undefined;
         /** What this lane's commits hand its own claims; the memory pair's lane reads memory and has none. */
@@ -88,6 +94,7 @@ export class ALOutboundStoreLane<TPrepared> {
     private readonly leaseRecovery: ALWorkLeaseRecovery;
     private readonly effects: ALOutboundMessageEffects<TPrepared>;
     private readonly removeStorageResetListener: (() => void) | undefined;
+    private readonly removeForeignCommitListener: (() => void) | undefined;
     private nextEvictionAtMs = Number.NEGATIVE_INFINITY;
     private disposed = false;
 
@@ -102,20 +109,12 @@ export class ALOutboundStoreLane<TPrepared> {
         this.repairAdmission = admissions.repairAdmission;
         this.receiptAdmission = admissions.receiptAdmission;
         this.repairRetransmission = admissions.repairRetransmission;
-        this.work = new ALWorkHandler({
-            workerId: input.workerId,
-            port: workPort,
-            queueEngine: runtime.queueEngine,
-            ownsQueueEngine: runtime.ownsQueueEngine,
-            clock: runtime.clock,
-            pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
-            readNextReadyAtMs: (port) => this.readiness.readOpenedStore(() => this.readNextReadyAtMs(port), undefined),
-            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
-            selectReady: (port, pageSize) => this.selectOutboundWork(port, pageSize),
-            runClaim: (claim) => this.runOutboundClaim(claim),
-            diagnostics: (event) => this.recordWorkDiagnostics(event),
-            storageHealth: stores.storageHealth
-        });
+        const workType = toALOutboundWorkType(stores.admissionStore.namespace);
+        this.work = this.createWorkHandler(workPort, workType);
+        this.removeForeignCommitListener = input.durableWorkOwnership?.onForeignCommit(
+            workType,
+            (rows) => this.applyForeignCommit(rows)
+        );
         this.readiness = new ALStorageReadiness({
             openStores: () => stores.admissionStore.ready(),
             startWork: () => this.work.ready(),
@@ -144,9 +143,15 @@ export class ALOutboundStoreLane<TPrepared> {
         this.work.dispose();
         this.dispatchAdmission.dispose();
         this.removeStorageResetListener?.();
+        this.removeForeignCommitListener?.();
         this.input.canonicalHandoff?.clear();
     }
 
+    /** Rows another runtime of the session committed to this lane's work type, for this owner to run. */
+    applyForeignCommit(rows: ALWorkCommittedRows): void {
+        this.work.committed(rows);
+    }
+
     /** A memory read on the volatile lane: whether this lane admitted the message. */
     async ownsMessage(msgId: string): Promise<boolean> {
         return await this.input.stores.admissionStore.hasSentMessageAdmission(msgId);
@@ -486,6 +491,25 @@ export class ALOutboundStoreLane<TPrepared> {
         });
     }
 
+    private createWorkHandler(workPort: ALWorkQueuePort, workType: string): ALWorkHandler {
+        const { stores, runtime } = this.input;
+        return new ALWorkHandler({
+            workerId: this.input.workerId,
+            port: workPort,
+            queueEngine: runtime.queueEngine,
+            ownsQueueEngine: runtime.ownsQueueEngine,
+            clock: runtime.clock,
+            pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
+            readNextReadyAtMs: (port) => this.readiness.readOpenedStore(() => this.readNextReadyAtMs(port), undefined),
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            selectReady: (port, pageSize) => this.selectOutboundWork(port, pageSize),
+            runClaim: (claim) => this.runOutboundClaim(claim),
+            diagnostics: (event) => this.recordWorkDiagnostics(event),
+            storageHealth: stores.storageHealth,
+            durableOwnership: toALDurableWorkLaneOwnership(this.input.durableWorkOwnership, workType)
+        });
+    }
+
     private readNowMs(): number {
         return this.input.runtime.clock.nowMs();
     }
```

```diff
--- a/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
+++ b/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
@@ -6,6 +6,10 @@ import type { ALStoreDurability } from '../../al-runtime-stores.ts';
 import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '../../ALStoreRetention.ts';
 import { ALStorageReadiness } from '../../storage/al-storage-readiness.ts';
 import type { ALStorageRecoveryReporter } from '../../storage/al-storage-recovery-reporter.ts';
+import {
+    toALDurableWorkLaneOwnership,
+    type ALDurableWorkOwnership
+} from '../../work/al-durable-work-ownership.ts';
 import {
     AL_WORK_PROBE_EVERY_ROUND,
     ALWorkHandler,
@@ -62,6 +66,8 @@ export namespace ALInboundStoreLane {
         readonly workerId: string;
         /** The memory pair's sweep; undefined for a lane over a durable pair. */
         readonly evictExpired: (() => void) | undefined;
+        /** The session ownership the durable lane's work runs under; undefined for the volatile lane, which owns its memory pair. */
+        readonly durableWorkOwnership: ALDurableWorkOwnership | undefined;
         readonly runtime: ALInboundMessageRuntime.Dependencies;
     }
 }
@@ -81,6 +87,7 @@ export class ALInboundStoreLane {
     private readonly workSelector: ALInboundWorkSelector;
     private readonly work: ALWorkHandler;
     private readonly storageRecovery: ALStorageRecoveryReporter | undefined;
+    private readonly removeForeignCommitListener: (() => void) | undefined;
     private nextEvictionAtMs = Number.NEGATIVE_INFINITY;
     private emptyRoundCount = 0;
     private emptyRoundsFromMs: number | undefined;
@@ -99,32 +106,21 @@ export class ALInboundStoreLane {
         this.admission = new ALInboundMessageAdmission({ ...this.dependencies, workPort });
         this.controlAdmission = createALInboundLaneControlAdmission(this.dependencies, workPort);
         this.delivery = new ALInboundAdmittedDelivery(this.dependencies);
+        const workType = toALInboundWorkType(input.stores.admissionStore.namespace, input.runtime.carrier);
         this.storageRecovery = input.stores.createStorageRecovery?.({
             name: input.runtime.carrier,
-            workTypeId: toALInboundWorkType(input.stores.admissionStore.namespace, input.runtime.carrier)
+            workTypeId: workType
         });
         this.workSelector = createALInboundWorkSelector({
             delivery: this.delivery,
             namespace: input.stores.admissionStore.namespace,
             nowMs: () => this.readNowMs()
         });
-        this.work = new ALWorkHandler({
-            workerId: input.workerId,
-            port: workPort,
-            queueEngine: this.dependencies.queueEngine,
-            ownsQueueEngine: this.dependencies.ownsQueueEngine,
-            clock: this.dependencies.clock,
-            pageSize: AL_INBOUND_WORK_PAGE_SIZE,
-            // The rotation answers readiness: work the eligibility rules defer must not report as due.
-            readNextReadyAtMs: (port) =>
-                this.readiness.readOpenedStore(() => this.workSelector.readNextReadyAtMs(port), undefined),
-            // The rotation advances one status per probe, so an answer of its own never stands.
-            readinessMemoryMs: AL_WORK_PROBE_EVERY_ROUND,
-            selectReady: (port, pageSize) => this.selectInboundWork(port, pageSize),
-            runClaim: (claim, batchStartedAtMs) => this.runInboundClaim(claim, batchStartedAtMs),
-            diagnostics: (event) => this.recordWorkDiagnostics(event),
-            storageHealth: input.stores.storageHealth
-        });
+        this.work = this.createWorkHandler(workPort, workType);
+        this.removeForeignCommitListener = input.durableWorkOwnership?.onForeignCommit(
+            workType,
+            () => this.applyForeignCommit()
+        );
         this.readiness = new ALStorageReadiness({
             openStores: () => input.stores.admissionStore.ready(),
             startWork: () => this.work.ready(),
@@ -138,11 +134,17 @@ export class ALInboundStoreLane {
 
     dispose(): void {
         this.disposed = true;
+        this.removeForeignCommitListener?.();
         this.admission.dispose();
         this.work.dispose();
         this.delivery.dispose();
     }
 
+    /** Another runtime of the session admitted to this lane's work type; inbound commits name no rows. */
+    applyForeignCommit(): void {
+        this.commitWork();
+    }
+
     /** A message its store cannot persist is not admitted: it wrote nothing, and its sender's receipt retries it. */
     async admitData(
         msg: ALMessage,
@@ -450,6 +452,28 @@ export class ALInboundStoreLane {
         return handedOver?.kind === 'storage-unavailable' ? { status: 'retry' } : replayed.outcome;
     }
 
+    private createWorkHandler(workPort: ALWorkQueuePort, workType: string): ALWorkHandler {
+        const { input, dependencies } = this;
+        return new ALWorkHandler({
+            workerId: input.workerId,
+            port: workPort,
+            queueEngine: dependencies.queueEngine,
+            ownsQueueEngine: dependencies.ownsQueueEngine,
+            clock: dependencies.clock,
+            pageSize: AL_INBOUND_WORK_PAGE_SIZE,
+            // The rotation answers readiness: work the eligibility rules defer must not report as due.
+            readNextReadyAtMs: (port) =>
+                this.readiness.readOpenedStore(() => this.workSelector.readNextReadyAtMs(port), undefined),
+            // The rotation advances one status per probe, so an answer of its own never stands.
+            readinessMemoryMs: AL_WORK_PROBE_EVERY_ROUND,
+            selectReady: (port, pageSize) => this.selectInboundWork(port, pageSize),
+            runClaim: (claim, batchStartedAtMs) => this.runInboundClaim(claim, batchStartedAtMs),
+            diagnostics: (event) => this.recordWorkDiagnostics(event),
+            storageHealth: input.stores.storageHealth,
+            durableOwnership: toALDurableWorkLaneOwnership(input.durableWorkOwnership, workType)
+        });
+    }
+
     private readNowMs(): number {
         return this.dependencies.clock.nowMs();
     }
```

- [ ] **Step 7: The resource on both runtimes, defaulted in both compositions; the durable lane only.**

```diff
--- a/packages/shared/alm/outbound/al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
@@ -24,6 +24,7 @@ import type { ALStorageHealth } from '../storage/al-storage-health.ts';
 import type { ALStorageReadiness } from '../storage/al-storage-readiness.ts';
 import type { ALStorageRecoveryReporter } from '../storage/al-storage-recovery-reporter.ts';
 import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
+import type { ALDurableWorkOwnership } from '../work/al-durable-work-ownership.ts';
 import type { ALWorkReadinessProbeCause } from '../work/al-work-readiness-memory.ts';
 import type {
     ALOutboundAdmissionStore,
@@ -349,6 +350,8 @@ export namespace ALOutboundMessageRuntime {
         readonly queueEngine: InboxOutboxEngine;
         readonly ownsQueueEngine: boolean;
         readonly browserLocks: ALBrowserLocks | undefined;
+        /** Which runtime of the session drains the durable pair; only the durable lane takes it. */
+        readonly durableWorkOwnership: ALDurableWorkOwnership;
     }
 
     export interface DequeueSource {
@@ -433,6 +436,7 @@ export class ALOutboundMessageRuntime<TPrepared> {
             workerId: dependencies.effectWorkerId,
             dequeueTypes: dependencies.dequeue.types,
             browserLocks: dependencies.browserLocks,
+            durableWorkOwnership: dependencies.durableWorkOwnership,
             evictExpired: undefined,
             canonicalHandoff: new ALOutboundCanonicalHandoff({
                 namespace: dependencies.admissionStore.namespace,
@@ -448,6 +452,7 @@ export class ALOutboundMessageRuntime<TPrepared> {
             workerId: `${dependencies.effectWorkerId}/volatile`,
             dequeueTypes: new Set<string>(),
             browserLocks: undefined,
+            durableWorkOwnership: undefined,
             evictExpired: dependencies.volatileStores.evictExpired,
             canonicalHandoff: undefined,
             runtime: dependencies,
```

```diff
--- a/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts
@@ -7,6 +7,7 @@ import { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
 import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../al-admission-backend.ts';
 import { createDefaultInMemoryALOutboundRuntimeStores } from '../al-runtime-stores.ts';
 import { readALBrowserLocks } from '../storage/al-browser-locks.ts';
+import { ALWAYS_OWNED_AL_DURABLE_WORK, type ALDurableWorkOwnership } from '../work/al-durable-work-ownership.ts';
 import type { ALOutboundPreparedMessageDecoder } from './admission/al-outbound-admission-store.ts';
 import {
     ALOutboundMessageRuntime,
@@ -43,6 +44,8 @@ export interface DefaultALOutboundRuntimeResourceInput<TPrepared> {
     readonly nowMs?: () => number;
     readonly random?: () => number;
     readonly queueEngine?: InboxOutboxEngine;
+    /** The browser's per-connect session claim; absent, the runtime owns its durable work. */
+    readonly durableWorkOwnership?: ALDurableWorkOwnership;
 }
 
 export interface CreateDefaultALOutboundMessageRuntimeDependencies<TPrepared>
@@ -122,6 +125,7 @@ export function createDefaultALOutboundRuntimeResources<TPrepared>(
         random: input.random ?? Math.random,
         queueEngine: input.queueEngine ?? new InboxOutboxEngine(),
         ownsQueueEngine: input.queueEngine === undefined,
-        browserLocks: readALBrowserLocks()
+        browserLocks: readALBrowserLocks(),
+        durableWorkOwnership: input.durableWorkOwnership ?? ALWAYS_OWNED_AL_DURABLE_WORK
     };
 }
```

```diff
--- a/packages/shared/alm/inbound/al-inbound-message-runtime.ts
+++ b/packages/shared/alm/inbound/al-inbound-message-runtime.ts
@@ -14,6 +14,7 @@ import type { ALStorageReadiness } from '../storage/al-storage-readiness.ts';
 import type { ALStorageRecoveryLane, ALStorageRecoveryReporter } from '../storage/al-storage-recovery-reporter.ts';
 import type { ALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
 import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
+import type { ALDurableWorkOwnership } from '../work/al-durable-work-ownership.ts';
 import type { ALInboundAdmissionStore, ALInboundPlanner } from './al-inbound-admission-store.ts';
 import {
     toALInboundAdmissionDiagnostics,
@@ -106,6 +107,8 @@ export namespace ALInboundMessageRuntime {
         readonly random: () => number;
         readonly queueEngine: InboxOutboxEngine;
         readonly ownsQueueEngine: boolean;
+        /** Which runtime of the session drains the durable pair; only the durable lane takes it. */
+        readonly durableWorkOwnership: ALDurableWorkOwnership;
     }
 
     /** A retried copy of an admitted message, owed to these child hops only, sent as its own attempt. */
@@ -191,6 +194,7 @@ export class ALInboundMessageRuntime {
             stores: dependencies,
             workerId: dependencies.effectWorkerId,
             evictExpired: undefined,
+            durableWorkOwnership: dependencies.durableWorkOwnership,
             runtime: dependencies
         });
         this.volatile = dependencies.volatileStores === undefined ? undefined : new ALInboundStoreLane({
@@ -198,6 +202,7 @@ export class ALInboundMessageRuntime {
             stores: dependencies.volatileStores,
             workerId: `${dependencies.effectWorkerId}/volatile`,
             evictExpired: dependencies.volatileStores.evictExpired,
+            durableWorkOwnership: undefined,
             runtime: dependencies
         });
         if (dependencies.ownsQueueEngine) {
```

```diff
--- a/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts
+++ b/packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts
@@ -5,6 +5,7 @@ import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
 import { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
 import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../al-admission-backend.ts';
 import { normalizeALRuntimeStoreRetention } from '../ALStoreRetention.ts';
+import { ALWAYS_OWNED_AL_DURABLE_WORK, type ALDurableWorkOwnership } from '../work/al-durable-work-ownership.ts';
 import { createALInboundAdmissionStore } from './al-inbound-admission-store.ts';
 import {
     ALInboundMessageRuntime,
@@ -22,6 +23,8 @@ export interface DefaultALInboundRuntimeResourceInput {
     /** Absent keeps one backend for every message, as the server and a standalone runtime do. */
     readonly volatileStores?: ALVolatileInboundRuntimeStores;
     readonly queueEngine?: InboxOutboxEngine;
+    /** The browser's per-connect session claim; absent, the runtime owns its durable work. */
+    readonly durableWorkOwnership?: ALDurableWorkOwnership;
 }
 
 export interface CreateDefaultALInboundMessageRuntimeDependencies
@@ -59,7 +62,8 @@ export function createDefaultALInboundRuntimeResources(
         clock: { nowMs },
         random: input.random ?? Math.random,
         queueEngine: input.queueEngine ?? new InboxOutboxEngine(),
-        ownsQueueEngine: input.queueEngine === undefined
+        ownsQueueEngine: input.queueEngine === undefined,
+        durableWorkOwnership: input.durableWorkOwnership ?? ALWAYS_OWNED_AL_DURABLE_WORK
     };
 }
```

Run Step 2's command. Expected (measured): `Tests  8 passed (8)` (three further runs: 8/8 each).

- [ ] **Step 8: The browser pass-through (R-I2a-ii-4).** The WS client and the RTC receiver take an optional
      value (absent: the default resources' always-owned value); the browser inputs require it; the middleware
      passes `ALWAYS_OWNED_AL_DURABLE_WORK` until Task 3 hands it the connect's claim.

```diff
--- a/packages/shared/services/ws-queue-box-client-service.ts
+++ b/packages/shared/services/ws-queue-box-client-service.ts
@@ -45,6 +45,7 @@ import {
     createDefaultALOutboundDequeueResilience,
     createDefaultALOutboundRuntimeResources
 } from '../alm/outbound/create-default-al-outbound-message-runtime.ts';
+import type { ALDurableWorkOwnership } from '../alm/work/al-durable-work-ownership.ts';
 import { EnqueuedType } from '../api/api-config.ts';
 import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
 import { NonRetryableException } from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
@@ -136,6 +137,8 @@ export namespace WsQueueBoxClientService {
         readonly dequeueResilience?: ResourceInboxResilience;
         readonly newConnectionRequestId?: () => string;
         readonly reconnect?: ReconnectOptions;
+        /** The browser's per-connect session claim; absent, this client's runtimes own their durable work. */
+        readonly durableWorkOwnership?: ALDurableWorkOwnership;
     }
 
     export interface Dependencies {
@@ -607,14 +610,16 @@ export function createDefaultWsQueueBoxClientService(input: WsQueueBoxClientServ
             volatileStores: input.inboundVolatileStores,
             queueEngine: input.queueEngine,
             selfPeerId: input.sessionId,
-            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_INBOX)
+            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_INBOX),
+            durableWorkOwnership: input.durableWorkOwnership
         }),
         outboundRuntime: createDefaultALOutboundRuntimeResources({
             decodePrepared: decodeALOutboundTransportMessage,
             canonicalQueue: input.outbox,
             stores: input.outboundStores,
             volatileStores: input.outboundVolatileStores,
-            queueEngine: input.queueEngine
+            queueEngine: input.queueEngine,
+            durableWorkOwnership: input.durableWorkOwnership
         }),
         dequeueResilience: input.dequeueResilience ?? createDefaultALOutboundDequeueResilience(),
         outboundDiagnostics: input.outboundDiagnostics,
```

```diff
--- a/packages/shared/services/web-rtc-rx-streamer-service.ts
+++ b/packages/shared/services/web-rtc-rx-streamer-service.ts
@@ -15,6 +15,7 @@ import { toALRtcPeerSource } from '../alm/inbound/al-inbound-source-validation.t
 import { createDefaultALInboundRuntimeResources } from '../alm/inbound/create-default-al-inbound-message-runtime.ts';
 import type { ALOutboundCancelOutcome } from '../alm/outbound/al-outbound-message-runtime.ts';
 import type { ALOutboundEnqueueResult } from '../alm/outbound/al-outbound-message-runtime.ts';
+import type { ALDurableWorkOwnership } from '../alm/work/al-durable-work-ownership.ts';
 import {
     EnqueuedType,
     type PeerId,
@@ -69,6 +70,8 @@ export namespace WebRtcRxStreamerService {
         readonly heartbeat?: Pick<WebRtcHeartbeatService.InputDto, 'maxMissedPings' | 'pingFrequencyMsecs'>;
         readonly roomAuthorityRefresh?: RoomAuthorityRefresh;
         readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
+        /** The browser's per-connect session claim; absent, this receiver's inbound runtime owns its durable work. */
+        readonly durableWorkOwnership?: ALDurableWorkOwnership;
     }
 
     export interface Dependencies {
@@ -536,7 +539,8 @@ export function createDefaultWebRtcRxStreamerService(input: WebRtcRxStreamerServ
             volatileStores: input.inboundVolatileStores,
             queueEngine: input.queueEngine,
             selfPeerId: input.sessionId,
-            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.RTC_INBOX)
+            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.RTC_INBOX),
+            durableWorkOwnership: input.durableWorkOwnership
         }),
         epochNow: input.nowEpochMs ?? Date.now,
         heartbeat: input.heartbeat ?? {
```

```diff
--- a/packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts
+++ b/packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts
@@ -13,6 +13,7 @@ import type {
 import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
 import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
 import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
+import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
 import type { ClientInfo } from '@shared/api/api-config.ts';
 import { readSession } from '@shared/api/auth.ts';
 import { Command } from '@shared/cache/Command.ts';
@@ -44,6 +45,8 @@ export namespace CreateBrowserWebSocketQueueBox {
         /** The session's inbound memory pair, the same one the RTC receiver holds. */
         readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;
         readonly volatileBudget: ALVolatileSessionBudget;
+        /** The connect's claim on its session's durable work, which only the durable lanes take. */
+        readonly durableWorkOwnership: ALDurableWorkOwnership;
         readonly signal?: AbortSignal;
         readonly connectTimeoutMs: number;
         readonly newConnectionRequestId: (() => string) | undefined;
@@ -100,6 +103,7 @@ function createBrowserWebSocketQueueBoxService(
         outboundDiagnostics: input.outboundDiagnostics,
         outboundSettlements: input.outboundSettlements,
         inboundDiagnostics: input.inboundDiagnostics,
+        durableWorkOwnership: input.durableWorkOwnership,
         newConnectionRequestId: input.newConnectionRequestId,
         reconnect: {
             ...DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS,
```

```diff
--- a/packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts
+++ b/packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts
@@ -21,6 +21,7 @@ import {
     createDefaultALOutboundRuntimeResources
 } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
 import type { ALVolatileSessionBudget } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
+import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
 import type {
     ClientInfo,
     IceConfig,
@@ -55,6 +56,8 @@ export interface InitialiseRtcOverlayMulticastManagerInput {
     readonly outboundSettlements: ALDeliverySettlementSink;
     readonly webRtcConnectionService: WebRtcConnectionService;
     readonly qboxEngine: InboxOutboxEngine;
+    /** The connect's claim on its session's durable work, which only the durable lanes take. */
+    readonly durableWorkOwnership: ALDurableWorkOwnership;
     readonly outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
 }
 
@@ -76,7 +79,8 @@ export function initialiseRtcOverlayMulticastManager(
             volatileStores: createBrowserALVolatileOutboundRuntimeStores(
                 toBrowserRtcOverlayALRuntimeStoreId(webRtcConnectionService.input.sessionId),
                 input.volatileBudget
-            )
+            ),
+            durableWorkOwnership: input.durableWorkOwnership
         }),
         dequeueResilience: createDefaultALOutboundDequeueResilience(),
         outboundDiagnostics: input.outboundDiagnostics,
@@ -96,6 +100,8 @@ export interface InitialiseRtcRxStreamerInput {
     readonly inboundStores: ALInboundRuntimeStores;
     /** The session's inbound memory pair, the same one the WS client holds. */
     readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;
+    /** The connect's claim on its session's durable work, which only the durable lanes take. */
+    readonly durableWorkOwnership: ALDurableWorkOwnership;
     readonly roomAuthorityRefresh?: WebRtcRxStreamerService.Input['roomAuthorityRefresh'];
     readonly inboundDiagnostics?: ALInboundRuntimeDiagnosticsSink;
 }
@@ -113,7 +119,8 @@ export function initialiseRtcRxStreamer(
         nowEpochMs: Date.now,
         heartbeat: { maxMissedPings: defaultMaxMissedPings, pingFrequencyMsecs: defaultPingFrequencyMsecs },
         roomAuthorityRefresh: input.roomAuthorityRefresh,
-        inboundDiagnostics: input.inboundDiagnostics
+        inboundDiagnostics: input.inboundDiagnostics,
+        durableWorkOwnership: input.durableWorkOwnership
     });
 }
```

```diff
--- a/packages/shared-web/browser/connection/initialise-browser-middleware.ts
+++ b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
@@ -5,6 +5,10 @@ import type {
     ALVolatileInboundRuntimeStores
 } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
 import type { ALVolatileSessionLimits } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
+import {
+    ALWAYS_OWNED_AL_DURABLE_WORK,
+    type ALDurableWorkOwnership
+} from '@shared/alm/work/al-durable-work-ownership.ts';
 import type {
     ApiConfig,
     AuthSession,
@@ -188,6 +192,8 @@ export interface InitialiseBrowserTransportInput {
     readonly inboundStores: ALInboundRuntimeStores;
     readonly inboundVolatileStores: ALVolatileInboundRuntimeStores;
     readonly volatileBound: BrowserSessionVolatileBound;
+    /** The connect's claim on its session's durable work, handed to every carrier's durable lanes. */
+    readonly durableWorkOwnership: ALDurableWorkOwnership;
     readonly options: MiddlewareInitOptions;
 }
 
@@ -268,6 +274,7 @@ export function createBrowserTransportInput(
             volatileBound.budget
         ),
         volatileBound,
+        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
         options,
         creation: {
             createMessage: newALUntargetedMessage,
@@ -320,6 +327,7 @@ export function toBrowserWebSocketQueueBoxInput(
         clientData: input.clientData,
         inboundStores: input.inboundStores,
         inboundVolatileStores: input.inboundVolatileStores,
+        durableWorkOwnership: input.durableWorkOwnership,
         signal: input.options.signal,
         connectTimeoutMs: input.options.timeoutMs ??
             DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS.connectTimeoutMsecs,
@@ -387,6 +395,7 @@ async function initialiseBrowserRtcTransport(
             clientData: input.clientData,
             inboundStores: input.inboundStores,
             inboundVolatileStores: input.inboundVolatileStores,
+            durableWorkOwnership: input.durableWorkOwnership,
             roomAuthorityRefresh: createBrowserRtcGroupSnapshotRefresh(input),
             inboundDiagnostics: input.options.diagnosticsPorts.inboundDiagnostics
         }
@@ -414,6 +423,7 @@ export function toRtcOverlayMulticastManagerInput(
         ...carrier,
         qosProvider: input.volatileBound.qosProvider,
         volatileBudget: input.volatileBound.budget,
+        durableWorkOwnership: input.durableWorkOwnership,
         outboundDiagnostics: input.options.diagnosticsPorts.outboundDiagnostics,
         outboundSettlements: input.options.deliverySettlements.rtc
     };
```

Add the composition case to `packages/tests/shared-web/connection/initialise-browser-middleware.test.ts`:

```diff
--- a/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
+++ b/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
@@ -71,6 +71,28 @@ describe('the one volatile bound a browser session hands its carriers (D74)', ()
     });
 });
 
+describe('the durable work ownership a connect hands its carriers', () => {
+    it('gives the WS client and the RTC overlay the ownership of the transport input', () => {
+        configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
+        const qboxEngine = new InboxOutboxEngine();
+        onTestFinished(() => qboxEngine.stop());
+        const input = createBrowserTransportInput(SESSION, OPTIONS);
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
+        expect(ws.durableWorkOwnership).toBe(input.durableWorkOwnership);
+        expect(rtc.durableWorkOwnership).toBe(input.durableWorkOwnership);
+    });
+});
+
 function createConnectionService(): WebRtcConnectionService {
     return new WebRtcConnectionService({
         send: async () => undefined,
```

- [ ] **Step 9: The two hand-built resource literals** name the default explicitly:

```diff
--- a/packages/tests/shared/al-outbound-message-runtime.test.ts
+++ b/packages/tests/shared/al-outbound-message-runtime.test.ts
@@ -15,6 +15,7 @@ import type {
     ALOutboundSettledSendResult
 } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
 import { createDefaultALOutboundDequeueResilience } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
+import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
 import {
     ALOutboundMessageRuntime,
     EntityStatus,
@@ -68,6 +69,7 @@ describe('ALOutboundMessageRuntime', () => {
             queueEngine,
             ownsQueueEngine: false,
             browserLocks: undefined,
+            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
             random: () => 0,
             diagnostics: undefined,
             toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
```

```diff
--- a/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts
+++ b/packages/tests/shared/alm/al-inbound-admission-preparation.test.ts
@@ -25,6 +25,7 @@ import {
     type ALInboundEffectFacts,
     type ALInboundEffectPreparationDependencies
 } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
+import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
 import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
 import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
 import {
@@ -585,6 +586,7 @@ function createRuntimeDependencies(stores: ALInboundRuntimeStores): ALInboundMes
         random: () => 0.5,
         queueEngine: new InboxOutboxEngine(),
         ownsQueueEngine: true,
+        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
         diagnostics: undefined
     };
 }
```

- [ ] **Step 10: The literal browser carrier inputs in five test files** (`node scripts/check-tests-typecheck.mjs`
      names them: 16 call sites, each an object literal passed to `createBrowserWebSocketQueueBox`,
      `initialiseRtcOverlayMulticastManager` or `initialiseRtcRxStreamer`). In each, add
      `durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,` as the literal's first property and
      `import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';` in import
      order. The sites (the literal's opening line at `3e931f558`):

  - `packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts`: 275, 282, 352
  - `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts`: 190, 267, 346
  - `packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts`: 63, 118, 161, 218, 276
  - `packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts`: 85, 133, 459
  - `packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts`: 69, 151

For example (`initialise-browser-rtc-runtime.test.ts`):

```diff
--- a/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts
+++ b/packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts
@@ -33,6 +33,7 @@ import {
     AL_VOLATILE_SESSION_MAX_BYTES,
     ALVolatileSessionBudget
 } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
+import { ALWAYS_OWNED_AL_DURABLE_WORK } from '@shared/alm/work/al-durable-work-ownership.ts';
 import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
 import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
 import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
@@ -188,6 +189,7 @@ describe('browser RTC runtime composition', () => {
         const drain = captureOutboundWorkRunnable(qboxEngine);
         const registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, maxEntries: 10, retainTerminalMs: 60_000, cancel: () => {} });
         const manager = initialiseRtcOverlayMulticastManager({
+            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
             qosProvider: { defaultsForMessage: computeAlmConformanceQosDefaults },
             volatileBudget: createDefaultVolatileSessionBudget(),
             outboundSettlements: (event) => registry.record(event),
@@ -265,6 +267,7 @@ describe('browser RTC runtime composition', () => {
         const qboxEngine = new InboxOutboxEngine();
         const drainOnce = captureOutboundWorkRunnable(qboxEngine);
         const manager = initialiseRtcOverlayMulticastManager({
+            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
             qosProvider: undefined,
             volatileBudget: createDefaultVolatileSessionBudget(),
             outboundSettlements: () => {},
@@ -344,6 +347,7 @@ describe('browser RTC runtime composition', () => {
             maxBytes: AL_VOLATILE_SESSION_MAX_BYTES
         });
         const manager = initialiseRtcOverlayMulticastManager({
+            durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
             qosProvider: undefined,
             volatileBudget: budget,
             outboundSettlements: () => {},
```

- [ ] **Step 11: Navigation maps.**

```diff
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -42,6 +42,22 @@ items; the same abort signal is what the effect owner reads as "disposed". A sup
 engine remains available to its other tasks; a runtime-owned engine stops. An
 interrupted durable claim remains recoverable after its lease expires.
 
+**One durable owner per session.** The resources carry `durableWorkOwnership`
+([`ALDurableWorkOwnership`](../work/al-durable-work-ownership.ts)), and only the durable lane takes
+it; the memory lane always owns its pair. The default, `ALWAYS_OWNED_AL_DURABLE_WORK`, is the
+server's, Node's and every runtime's whose durable store no other runtime drains, and keeps the
+handler's construction-time registration. While another runtime of the session owns the work, the
+durable lane's [`ALWorkHandler`](../work/al-work-handler.ts) joins no engine round, its `ready()`
+runs no bootstrap batch, and a commit runs no batch: it is announced (`announceCommit`) under the
+lane's work type, `toALOutboundWorkType(namespace)`, which every runtime of the session shares. The
+lane still admits under the commit lock. When ownership turns true (once, never back) the handler
+registers its task and runs the bootstrap batch once; that batch's first-batch report is the
+takeover's recovery outcome. A row the previous owner held is recovered by the lease sweep of a later
+batch, at its lease end plus at most 19.1 s, never sooner. The owner's lane hears every commit another
+runtime announced for its work type (`onForeignCommit`) and runs it through `applyForeignCommit(rows)`,
+the same `committed(rows)` its own commits take. The browser hands its per-connect value through the
+WS client's and the RTC overlay's carrier inputs.
+
 The transport decoding owners are
 [`decodeALOutboundPreparedMessage`](./al-outbound-effect-validation.ts) for WS
 client and RTC envelopes, and
```

```diff
--- a/packages/shared/alm/inbound/README.md
+++ b/packages/shared/alm/inbound/README.md
@@ -60,6 +60,13 @@ its first work batch reports the lane's one recovery outcome of the connect thro
 health, under the store id followed by the carrier (`<store id>/ws`, `<store id>/rtc`), with that
 lane's own claims and the expired rows of its own work type.
 
+The durable lane takes the session's `durableWorkOwnership` as the outbound one does (see the
+outbound README): while another runtime owns the work it admits and runs no batch, announcing each
+commit under its work type `toALInboundWorkType(namespace, carrier)`, and its first batch after
+ownership turns true reports the lane's recovery. Inbound commits name no rows, so the owner's lane
+applies a foreign one (`applyForeignCommit()`) as its own: a head read and an undescribed commit. The
+WS server and Node keep the always-owned default.
+
 - **The durability is the sender's, carried on the envelope.** A data message goes to
   the lane [`resolveALInboundStoreDurability`](./lane/resolve-al-inbound-store-durability.ts)
   names from the envelope's normalized `qos.durability`: the IndexedDB lane exactly when
```

- [ ] **Step 12: Format the touched files only.**

```sh
npx dprint fmt packages/shared/alm/work/al-durable-work-ownership.ts packages/shared/alm/work/al-work-engine-membership.ts \
  packages/shared/alm/work/al-work-handler.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts \
  packages/shared/alm/inbound/lane/al-inbound-store-lane.ts packages/shared/alm/outbound/al-outbound-message-runtime.ts \
  packages/shared/alm/inbound/al-inbound-message-runtime.ts packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts \
  packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts packages/shared/services/ws-queue-box-client-service.ts \
  packages/shared/services/web-rtc-rx-streamer-service.ts packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts \
  packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts packages/shared-web/browser/connection/initialise-browser-middleware.ts \
  packages/shared/alm/outbound/README.md packages/shared/alm/inbound/README.md \
  packages/tests/shared/alm/work/al-durable-work-ownership.test.ts packages/tests/shared/alm/session-outbound-test-runtime.ts \
  packages/tests/shared/alm/inbound-runtime-test-fixture.ts packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/alm/al-inbound-admission-preparation.test.ts packages/tests/shared-web/connection/initialise-browser-middleware.test.ts \
  packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts \
  packages/tests/shared-web/websocket/create-browser-web-socket-queue-box.test.ts packages/tests/shared-web/websocket/ws-durable-owner-recovery.test.ts \
  packages/tests/shared-web/websocket/ws-retained-work-fault.test.ts
```

- [ ] **Step 13: Focused tests.**

```sh
npx vitest run packages/tests/shared/alm packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/webrtc \
  packages/tests/shared/al-durable-runtime.test.ts packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared-web/connection
npx vitest run packages/tests/shared-web/websocket packages/tests/shared-web/rtc packages/tests/shared-web/messages \
  packages/tests/shared-web/al-runtime packages/tests/shared-web/shared-web-public-api-snapshots.test.ts \
  packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
```

Expected (measured): the first `Test Files  134 passed (134)`, `Tests  1582 passed (1582)` — the ledger, cold,
inbound and storage-snapshot pins (`al-indexeddb-transaction-ledger.test.ts`, `al-indexeddb-operation-counts.test.ts`,
`al-storage-snapshot.test.ts`), the readiness and handler suites (`al-work-handler.test.ts`,
`al-work-handler-readiness-restore.test.ts`, `outbound-readiness-probe-diagnostics.test.ts`), the two-tab hand-off
and both two-runtime claim tests (`al-indexeddb-runtime-stores.test.ts:640`, `al-durable-runtime.test.ts:242`) all
unedited and green. The second: `Test Files  48 passed`; run it with the sandbox disabled — sandboxed,
`browser-rtc-recovery-runtime.test.ts` and `browser-rallar-ws-controller.test.ts` time out at 5 s (both pass
unsandboxed, 17/17).

- [ ] **Step 14: Per-task checks, bundles and the PostgreSQL integration** (this task changes `alm/inbound/**`
      and `alm/work/**`).

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
(cd apps/api-v1 && deno task check)
node scripts/check-tests-typecheck.mjs
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
npm run check:test-reachability
docker ps --filter name=ar-eye-hunter-postgres --format '{{.Status}}'   # docker start ar-eye-hunter-postgres only if stopped
npm run test:postgres:integration
```

Expected (measured): no `tsc` output; typechecks and `deno task check` exit 0; `check-tests-typecheck: 1428 test
files enforced ... PASS`; `browser/rallar.ts` 233.577 KiB (233.6, under 234); the headless test FAILS with
`the headless agent measures 298.196 KiB against 298 ...; raise it to 299`: raise the budget (the standing ruling):

```diff
--- a/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
+++ b/packages/tests/rallar-black-box-headless/headless-bundle-budget.json
@@ -1,3 +1,3 @@
 {
-  "brotliBudgetKiB": 298
+  "brotliBudgetKiB": 299
 }
```

and the headless test passes (`Tests  1 passed (1)`). `Test reachability: 1730 test files, 1724 reached by CI,
6 manual.` PostgreSQL integration (shared container, unsandboxed): `Tests  1 failed | 83 passed (84)`; the
failure is `rtc-topology-replay-consumer.test.ts` "lets passive live C poll and drain independent A/B streams",
which reads publisher-stream rows other sessions left in the shared database (13 streams where it expects 3) and
touches no ALM code; every ALM PostgreSQL file passes. The implementer re-runs it and classifies before the
commit (fresh container state, or main at the same time).

- [ ] **Step 15: Commit, then run the changed-range gates.**

```sh
git add packages/shared packages/shared-web packages/tests
git commit -F - <<'EOF'
Gate a session's durable work on its owner

ALDurableWorkOwnership says which runtime of a session drains its
durable work. A durable lane's ALWorkHandler joins the engine through
ALWorkEngineMembership: an owner's task joins at construction as today;
a runtime that does not own the work keeps it out, runs no bootstrap
and no batch, and announces each commit under its lane's work type.
When ownership turns true the task joins and the bootstrap batch runs
once, which reports the takeover's recovery outcome. Each durable lane
gains applyForeignCommit for the owner to run another runtime's commit;
the volatile lanes take no ownership.

Both runtimes' resources carry the value, defaulted to
ALWAYS_OWNED_AL_DURABLE_WORK in both createDefault...RuntimeResources,
so the server, Node and every existing fixture keep today's behaviour.
The browser threads its per-connect value through the WS client and the
RTC overlay and receiver inputs (always owned until the session claim).

The headless bundle crosses its budget: 298.196 KiB measured, raised to
299 KiB.

D8 reuse: ObservableLatestValue (packages/shared/cache) carries the owned flag; the engine's own includeTask/excludeTask is the gate and committed(rows) the announce/apply path, no new scheduler; packages/shared/resilience has no ownership primitive to reuse.
EOF
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured): `PASS: no new repository style findings`; structure coupling `PASS` on all three lines (the
handler cases assert behaviour — probes, releases, announcements — not mock call counts; a first draft that pinned
`includeTask` call counts drew seven unclassified `mock-invocation-count-or-order` candidates).

---

### Task 3: The session claim in the browser composition; takeover and the no-Locks path

Prototyped in scratch as commit `7bb50639b` on Task 2's `932e9cf2d` (red then green; scratch `237181490` on
the assembled tree). Decision D123
("taken per connect … takeover on release runs the bootstrap … without Locks each tab owns"), proposal §3.f "The
claim", §3.h (owner-counted outcomes); fact sheet items 1, 2, 6. Rulings: R-I2a-ii-5 (the claim's lifetime and
place), R-I2a-ii-24..R-I2a-ii-26, R-I2a-ii-29, R-I2a-ii-30.

**Files**

- Create: `packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts` (79 lines) —
  `BrowserALDurableWorkClaim implements ALDurableWorkOwnership`: one connect's claim (cognitive load 3).
- Modify: `packages/shared/alm/storage/al-browser-locks.ts` — `toALDurableOwnerLockName(scope, sessionId)`, the
  port's second name; a type import of `StateScope`.
- Modify: `packages/shared-web/browser/connection/browser-transport-runtime.ts` — `activeDurableWork` beside
  `activeMiddleware` (`:24`); `init()` claims before `createMiddleware` (`:64-65`) and hands the claim in the
  connect's options; the claim is released in the failed-connect `.catch` (`:80-83`) and in `shutdown()` after
  `shutdownMiddleware` (`:94-104`); a private `claimDurableWork(session, options)`; `createMiddleware` takes
  `BrowserConnectOptions` (`:106-109`). Load 13 → 14.
- Modify: `packages/shared-web/browser/connection/initialise-browser-middleware.ts` — `BrowserConnectOptions extends
  MiddlewareInitOptions` with the required `durableWorkOwnership` (before `:96`); `initialiseMiddleware` (`:205-209`)
  and `createBrowserTransportInput` (`:248-251`) take it; `createBrowserTransportInput` passes
  `options.durableWorkOwnership` where Task 2 passed the always-owned value. `MiddlewareInitOptions` is unchanged,
  so `session-connection-lifecycle.ts` and every caller of `BrowserTransportRuntime.init` are unchanged.
- Test (create): `packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts` (132 lines).
- Test (modify): `packages/tests/shared-web/connection/browser-transport-cleanup.test.ts` (a new describe, 84
  lines), `packages/tests/shared-web/connection/initialise-browser-middleware.test.ts` (`OPTIONS` `:28-33` become
  `BrowserConnectOptions` with a claim; Task 2's case asserts the connect's claim), and the two exact-options pins
  `packages/tests/shared-web/rallar-facade-defaults.test.ts:274-298` and
  `packages/tests/shared-web/composition/browser-facade-behavior.test.ts:187-207` (one key added:
  `durableWorkOwnership: expect.any(BrowserALDurableWorkClaim)`).
- Docs: `packages/shared-web/browser/README.md` (before `:193`), `packages/shared/alm/outbound/README.md` (Task 2's
  paragraph), `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (`recovery`, before
  `:540`), `docs/rallar-api-reference.md` (before `:677`).
- Not touched: `create-default-al-outbound-message-runtime.ts` requests no owner lock (R-I2a-ii-5), so
  `ws-rtc-control-handoff-latency.test.ts:300,315` and `outbound-control-handoff.test.ts:342` keep their exact
  counts; `RallarBrowserMiddleware` and `ApiMiddleware` (public, and doubled by every middleware test fixture) do
  not change; no new diagnostics event (D123: the takeover's `recovery` outcome is the observable fact).

**Interfaces**

- Consumes: Task 1's `ALBrowserLocks`, `ALBrowserLockOptions.signal`, `readALBrowserLocks()`; Task 2's
  `ALDurableWorkOwnership`, the browser pass-through inputs, the gated handler and its takeover.
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // packages/shared/alm/storage/al-browser-locks.ts
  export function toALDurableOwnerLockName(scope: StateScope, sessionId: string): string;
  //   `rallar:al-durable-owner:${encodeURIComponent(applicationId)}:${encodeURIComponent(workspaceId)}:${sessionId}`

  // packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts
  export namespace BrowserALDurableWorkClaim {
      export interface Input {
          readonly scope: StateScope;
          readonly sessionId: string;
          readonly locks: ALBrowserLocks | undefined;   // undefined: every connect owns
      }
  }
  export class BrowserALDurableWorkClaim implements ALDurableWorkOwnership {
      constructor(input: BrowserALDurableWorkClaim.Input);   // owned = (locks === undefined); no side effect
      get owned(): ObservableValue<boolean>;
      request(): void;    // once per connect: the owner lock with the connect's signal; the callback is the takeover
      release(): void;    // aborts the connect's signal: a waiting request is abandoned, a held lock released
      isOwned(): boolean;
      announceCommit(): void;          // Task 4 relays it over the session channel
      onForeignCommit(): () => void;   // Task 4 feeds it from the session channel
  }

  // packages/shared-web/browser/connection/initialise-browser-middleware.ts
  export interface BrowserConnectOptions extends MiddlewareInitOptions {
      readonly durableWorkOwnership: ALDurableWorkOwnership;
  }
  ```
- Behaviour: `BrowserTransportRuntime.init` builds the claim for `options.scope ?? defaultStateScope()` and the
  session id, reads the lock manager per connect (`readALBrowserLocks()`), calls `request()` once, and passes the
  claim as `durableWorkOwnership`. The lock callback sets `owned` true (unless the connect already ended) and
  resolves when the connect's signal aborts, so the lock is held exactly as long as the connect; no `ifAvailable`.
  A request that rejects for any reason other than the connect's own release (a `SecurityError`, an inactive
  document) makes the connect own its work (R-I2a-ii-25). `shutdown()` stops the middleware first and then releases
  the claim (R-I2a-ii-24); a connect that fails or is cancelled releases its claim in the `.catch`. Until Task 4,
  `announceCommit` is a no-op: a non-owner's durable commit reaches the owner when the owner's readiness memory
  ages (D112's ≤ 6.6 s idle bound), and the claim's `onForeignCommit` registers nothing.

**D8 reuse inspection.** The owner claim is the second name on Task 1's port (D123), read through the same
`readALBrowserLocks()` the default runtime composition uses; the per-connect lifetime is one `AbortController`,
the standard `LockOptions.signal`, and the owned flag an `ObservableLatestValue<boolean>` from
`packages/shared/cache` (as Task 2). The claim follows `BrowserDeliverySettlements`' per-connect epoch pattern in
the same runtime (`browser-transport-runtime.ts:23`, `:64`, `:95`): opened in `init`, closed at shutdown and on a
failed connect. The lock name encodes the scope as `toBrowserALRuntimeDbName` does
(`browser-al-runtime-identity.ts:14-17`). No timer, no `ifAvailable`, no `steal`, no polling; no
`packages/shared/resilience` primitive applies. The tests reuse Task 2's session support module and the existing
`createDefaultApiMiddlewareTestDouble`/mock setup of `browser-transport-cleanup.test.ts`; the shared-lock fake
extends the two-tab test's FIFO fake (`al-outbound-control-handoff-two-tabs.test.ts:216-235`) with the `signal`
behaviour (an aborted waiter is never granted), and that existing fake is left as it is.

- [ ] **Step 1: Write the failing tests.** Create
      `packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts`:

<!-- dprint-ignore -->
```ts
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
import type { ALBrowserLockOptions, ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { createOutboundMessage } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import {
    createOutboundTestSession,
    createSessionOutboundTestRuntime
} from '../../shared/alm/session-outbound-test-runtime.ts';

const SCOPE: StateScope = { applicationId: 'app:one', workspaceId: 'work space' };
const SESSION_ID = 'session-1';
const OWNER_LOCK_NAME = 'rallar:al-durable-owner:app%3Aone:work%20space:session-1';

describe('BrowserALDurableWorkClaim', () => {
    it('owns the session\'s durable work from its lock\'s grant, and hands it to the next connect when released', async () => {
        const browser = createSharedWebLocks();
        const first = openClaim(browser.locks);
        const second = openClaim(browser.locks);

        await vi.waitFor(() => expect(first.isOwned()).toBe(true));
        expect(second.isOwned()).toBe(false);
        expect(browser.requests).toEqual([OWNER_LOCK_NAME, OWNER_LOCK_NAME]);

        first.release();

        await vi.waitFor(() => expect(second.isOwned()).toBe(true));
    });

    it('abandons a request still waiting when its connect ends', async () => {
        const browser = createSharedWebLocks();
        const first = openClaim(browser.locks);
        const second = openClaim(browser.locks);
        const third = openClaim(browser.locks);
        await vi.waitFor(() => expect(first.isOwned()).toBe(true));

        second.release();
        first.release();

        await vi.waitFor(() => expect(third.isOwned()).toBe(true));
        expect(second.isOwned()).toBe(false);
    });

    it('owns the work in every connect where the Locks API is missing', () => {
        const claim = openClaim(undefined);

        expect(claim.isOwned()).toBe(true);
    });

    // A tab that could not take part in the claim drains as every tab did before it.
    it('owns the work when its lock request fails for another reason than its own release', async () => {
        const claim = openClaim({ request: async () => await Promise.reject(new DOMException('opaque', 'SecurityError')) });

        await vi.waitFor(() => expect(claim.isOwned()).toBe(true));
    });
});

describe('two connects of one session over one durable store', () => {
    it('drains in the owner, and the next connect takes over on its release and sends each row once', async () => {
        const browser = createSharedWebLocks();
        const session = createOutboundTestSession();
        const first = createSessionOutboundTestRuntime(session, openClaim(browser.locks));
        const second = createSessionOutboundTestRuntime(session, openClaim(browser.locks));
        await vi.waitFor(() => expect(first.ownership.isOwned()).toBe(true));

        await first.runtime.enqueueIfAbsent(createOutboundMessage('durable-first'));
        await second.runtime.enqueueIfAbsent(createOutboundMessage('durable-second'));
        await vi.waitFor(() => expect(first.sent).toEqual(['durable-first']));
        expect(second.sent).toEqual([]);

        // The first tab closes: its runtimes end before its connect releases the claim.
        first.runtime.dispose();
        first.ownership.release();

        await vi.waitFor(() => expect(second.sent).toEqual(['durable-second']));
        expect(first.sent).toEqual(['durable-first']);
        expect(session.storage.filter((event) => event.kind === 'recovery')).toEqual([
            { kind: 'recovery', storeId: session.namespace, outcome: { kind: 'storage-created' } },
            { kind: 'recovery', storeId: session.namespace, outcome: { kind: 'restored', claimed: 1, expired: 0 } }
        ]);
    });

    it('drains in every connect without the Locks API, each row once', async () => {
        const session = createOutboundTestSession();
        const first = createSessionOutboundTestRuntime(session, openClaim(undefined));
        const second = createSessionOutboundTestRuntime(session, openClaim(undefined));

        await first.runtime.enqueueIfAbsent(createOutboundMessage('durable-first'));
        await second.runtime.enqueueIfAbsent(createOutboundMessage('durable-second'));

        expect(first.ownership.isOwned() && second.ownership.isOwned()).toBe(true);
        await vi.waitFor(() => expect([...first.sent, ...second.sent].toSorted()).toEqual(['durable-first', 'durable-second']));
    });
});

function openClaim(locks: ALBrowserLocks | undefined): BrowserALDurableWorkClaim {
    const claim = new BrowserALDurableWorkClaim({ scope: SCOPE, sessionId: SESSION_ID, locks });
    claim.request();
    onTestFinished(() => claim.release());
    return claim;
}

/**
 * One exclusive lock per name, shared by every tab of the browser, as the Web Locks API is: a request
 * waits its turn, and one its signal aborts while it waits is never granted.
 */
function createSharedWebLocks(): { readonly locks: ALBrowserLocks; readonly requests: readonly string[]; } {
    const tails = new Map<string, Promise<void>>();
    const requests: string[] = [];
    const request = async <T>(name: string, options: ALBrowserLockOptions, callback: () => Promise<T>): Promise<T> => {
        requests.push(name);
        const previous = tails.get(name) ?? Promise.resolve();
        const released = Promise.withResolvers<void>();
        tails.set(name, previous.then(() => released.promise));
        try {
            await waitUnlessAborted(previous, options.signal);
            return await callback();
        }
        finally {
            released.resolve();
        }
    };
    return { locks: { request }, requests };
}

async function waitUnlessAborted(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    const aborted = Promise.withResolvers<void>();
    signal?.addEventListener('abort', () => aborted.reject(new DOMException('aborted', 'AbortError')), { once: true });
    await Promise.race([previous, aborted.promise]);
}
```

Add the transport runtime's cases to `packages/tests/shared-web/connection/browser-transport-cleanup.test.ts`:

```diff
--- a/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts
+++ b/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts
@@ -1,5 +1,7 @@
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
 import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
+import type { MiddlewareInitOptions } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
 import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
@@ -7,6 +9,7 @@ import type { RallarBrowserMiddleware } from '@shared-web/browser/rallar-connect
 import { createRallarLifecycleCoordinator } from '@shared-web/browser/session/rallar-lifecycle-coordinator.ts';
 import { createRallarSessionController } from '@shared-web/browser/session/rallar-session-controller.ts';
 import { BrowserSessionConnectionLifecycle, type RallarSessionConnectionInput } from '@shared-web/browser/session/session-connection-lifecycle.ts';
+import { toALDurableOwnerLockName, type ALBrowserLockOptions } from '@shared/alm/storage/al-browser-locks.ts';
 import type { AuthSession } from '@shared/api/api-config.ts';
 import { describe, expect, it, onTestFinished, vi } from 'vitest';
 import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
@@ -467,6 +470,87 @@ describe('the session volatile limits seam', () => {
     });
 });
 
+describe('the session\'s durable work claim', () => {
+    it('requests the session\'s owner lock once per connect and releases it when the connect ends', async () => {
+        const browser = stubGrantedWebLocks();
+        const middleware = createDefaultApiMiddlewareTestDouble();
+        mocks.readSession.mockReturnValue(middleware.session);
+        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        const transportRuntime = new BrowserTransportRuntime();
+        onTestFinished(() => transportRuntime.shutdown());
+
+        await transportRuntime.init(toInitOptions());
+        const ownership = mocks.initialiseMiddleware.mock.calls.at(-1)?.[2].durableWorkOwnership;
+
+        await vi.waitFor(() => expect(ownership?.isOwned()).toBe(true));
+        expect(browser.names).toEqual([toALDurableOwnerLockName(defaultStateScope(), middleware.session.sessionId)]);
+        expect(browser.heldCount()).toBe(1);
+
+        transportRuntime.shutdown();
+
+        await vi.waitFor(() => expect(browser.heldCount()).toBe(0));
+    });
+
+    it('releases the claim of a connect whose transport failed', async () => {
+        const browser = stubGrantedWebLocks();
+        const middleware = createDefaultApiMiddlewareTestDouble();
+        mocks.readSession.mockReturnValue(middleware.session);
+        mocks.initialiseMiddleware.mockRejectedValue(new Error('network unavailable'));
+        const transportRuntime = new BrowserTransportRuntime();
+
+        await expect(transportRuntime.init(toInitOptions())).rejects.toThrow('network unavailable');
+
+        await vi.waitFor(() => expect(browser.heldCount()).toBe(0));
+        expect(browser.names).toHaveLength(1);
+    });
+
+    it('owns the session\'s durable work in every connect where the Locks API is missing', async () => {
+        vi.stubGlobal('navigator', {});
+        onTestFinished(() => {
+            vi.unstubAllGlobals();
+        });
+        const middleware = createDefaultApiMiddlewareTestDouble();
+        mocks.readSession.mockReturnValue(middleware.session);
+        mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
+        const transportRuntime = new BrowserTransportRuntime();
+        onTestFinished(() => transportRuntime.shutdown());
+
+        await transportRuntime.init(toInitOptions());
+
+        expect(mocks.initialiseMiddleware.mock.calls.at(-1)?.[2].durableWorkOwnership.isOwned()).toBe(true);
+    });
+});
+
+/** A browser whose every lock request is granted at once and held until its callback settles. */
+function stubGrantedWebLocks(): { readonly names: readonly string[]; heldCount(): number; } {
+    const names: string[] = [];
+    let held = 0;
+    const request = async <T>(name: string, _options: ALBrowserLockOptions, callback: () => Promise<T>): Promise<T> => {
+        names.push(name);
+        held += 1;
+        try {
+            return await callback();
+        }
+        finally {
+            held -= 1;
+        }
+    };
+    vi.stubGlobal('navigator', { locks: { request } });
+    onTestFinished(() => {
+        vi.unstubAllGlobals();
+    });
+    return { names, heldCount: () => held };
+}
+
+function toInitOptions(): MiddlewareInitOptions {
+    return {
+        qosProvider: undefined,
+        readVolatileSessionLimits: undefined,
+        deliverySettlements: { ws: () => {}, rtc: () => {} },
+        diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
+    };
+}
+
 function toConnectionInput(session: AuthSession): RallarSessionConnectionInput {
     return {
         session,
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts \
  packages/tests/shared-web/connection/browser-transport-cleanup.test.ts
```

Expected (measured at `932e9cf2d`): `Error: Cannot find package
'@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts'` for the claim file, and in the cleanup file the
three new cases fail (`expected undefined to be true`, `expected [] to have a length of 1 but got +0`,
`Cannot read properties of undefined (reading 'isOwned')`): `Test Files  2 failed (2)`,
`Tests  3 failed | 8 passed (11)`.

- [ ] **Step 3: The owner lock's name** (`packages/shared/alm/storage/al-browser-locks.ts`):

```diff
--- a/packages/shared/alm/storage/al-browser-locks.ts
+++ b/packages/shared/alm/storage/al-browser-locks.ts
@@ -1,3 +1,5 @@
+import type { StateScope } from '../../api/state-types.ts';
+
 export interface ALBrowserLockOptions {
     readonly mode: 'exclusive';
     /** Abandons the request while it still waits; absent, the request waits until it is granted. */
@@ -21,3 +23,12 @@ export function readALBrowserLocks(): ALBrowserLocks | undefined {
 export function toALOutboundCommitLockName(senderId: string): string {
     return `rallar:al-outbound-commit:${senderId}`;
 }
+
+/**
+ * Held by the one connect that drains its session's durable work in one scope. Each part of the scope
+ * is URI-encoded, as the scope's database name is, so an id with a colon cannot alias another scope.
+ */
+export function toALDurableOwnerLockName(scope: StateScope, sessionId: string): string {
+    const applicationId = encodeURIComponent(scope.applicationId);
+    return `rallar:al-durable-owner:${applicationId}:${encodeURIComponent(scope.workspaceId)}:${sessionId}`;
+}
```

- [ ] **Step 4: The claim** `packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts`:

<!-- dprint-ignore -->
```ts
import { toALDurableOwnerLockName, type ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';
import type { ObservableValue } from '@shared/cache/RepositoryInterfaces.ts';

export namespace BrowserALDurableWorkClaim {
    export interface Input {
        readonly scope: StateScope;
        readonly sessionId: string;
        /** `undefined` where the Locks API is missing: every connect owns its session's durable work. */
        readonly locks: ALBrowserLocks | undefined;
    }
}

/**
 * One connect's claim on its session's durable work in one scope. Every tab of the session requests the
 * owner lock once per connect; the connect it is granted to owns the work and holds the lock until
 * `release()`, and the request of the next tab is granted then. A connect whose request fails for any
 * reason but its own release owns the work, as every connect did before there was a claim.
 */
export class BrowserALDurableWorkClaim implements ALDurableWorkOwnership {
    private readonly ownedValue = new ObservableLatestValue<boolean>();
    private readonly lifetime = new AbortController();
    private readonly input: BrowserALDurableWorkClaim.Input;

    constructor(input: BrowserALDurableWorkClaim.Input) {
        this.input = input;
        this.ownedValue.accept(input.locks === undefined);
    }

    get owned(): ObservableValue<boolean> {
        return this.ownedValue;
    }

    /** Requests the owner lock once; its callback is the takeover. */
    request(): void {
        const { locks, scope, sessionId } = this.input;
        const { signal } = this.lifetime;
        void locks?.request(
            toALDurableOwnerLockName(scope, sessionId),
            { mode: 'exclusive', signal },
            async () => await this.holdUntilReleased()
        )
            .catch(() => this.takeOverUnlessReleased());
    }

    /** Ends the connect's claim: a request still waiting is abandoned, a held lock is released. */
    release(): void {
        this.lifetime.abort();
    }

    isOwned(): boolean {
        return this.ownedValue.peek() === true;
    }

    announceCommit(): void {}

    onForeignCommit(): () => void {
        return () => {};
    }

    private async holdUntilReleased(): Promise<void> {
        this.takeOverUnlessReleased();
        const { signal } = this.lifetime;
        await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
            if (signal.aborted) {
                resolve();
            }
        });
    }

    private takeOverUnlessReleased(): void {
        if (!this.lifetime.signal.aborted) {
            this.ownedValue.accept(true);
        }
    }
}
```

- [ ] **Step 5: One claim per connect in the transport runtime** (`browser-transport-runtime.ts`):

```diff
--- a/packages/shared-web/browser/connection/browser-transport-runtime.ts
+++ b/packages/shared-web/browser/connection/browser-transport-runtime.ts
@@ -1,9 +1,13 @@
+import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
+import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
 import {
     initialiseMiddleware,
+    type BrowserConnectOptions,
     type MiddlewareInitOptions
 } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import type { ApiMiddleware, RallarBrowserMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
+import { readALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
 import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
 import { readSession } from '@shared/api/auth.ts';
 
@@ -22,6 +26,7 @@ export interface BrowserTransportRuntimePort {
 export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
     readonly deliverySettlements = new BrowserDeliverySettlements();
     private activeMiddleware: ApiMiddleware | undefined;
+    private activeDurableWork: BrowserALDurableWorkClaim | undefined;
     private pendingMiddleware: Promise<ApiMiddleware> | undefined;
     private generation = 0;
 
@@ -62,7 +67,12 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
         }
 
         const epoch = this.deliverySettlements.open(options.deliverySettlements);
-        const pendingMiddleware = this.createMiddleware(session, { ...options, deliverySettlements: epoch.settlements })
+        const durableWork = this.claimDurableWork(session, options);
+        const pendingMiddleware = this.createMiddleware(session, {
+            ...options,
+            deliverySettlements: epoch.settlements,
+            durableWorkOwnership: durableWork
+        })
             .then((middleware) => {
                 const currentSession = readSession();
                 if (
@@ -75,10 +85,12 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
                 }
 
                 this.activeMiddleware = middleware;
+                this.activeDurableWork = durableWork;
                 return middleware;
             })
             .catch((error) => {
                 epoch.close();
+                durableWork.release();
                 throw error;
             })
             .finally(() => {
@@ -96,16 +108,31 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
         this.generation += 1;
         this.pendingMiddleware = undefined;
         const middleware = this.activeMiddleware;
+        const durableWork = this.activeDurableWork;
         this.activeMiddleware = undefined;
+        this.activeDurableWork = undefined;
 
         if (middleware) {
             this.shutdownMiddleware(middleware.middleware, reason);
         }
+        // Released after the runtimes stop, so the next owner's takeover never overlaps this connect's work.
+        durableWork?.release();
+    }
+
+    /** Requested once per connect, in the connect's scope; held until the connect ends. */
+    private claimDurableWork(session: AuthSession, options: MiddlewareInitOptions): BrowserALDurableWorkClaim {
+        const durableWork = new BrowserALDurableWorkClaim({
+            scope: options.scope ?? defaultStateScope(),
+            sessionId: session.sessionId,
+            locks: readALBrowserLocks()
+        });
+        durableWork.request();
+        return durableWork;
     }
 
     private async createMiddleware(
         session: AuthSession,
-        options: MiddlewareInitOptions
+        options: BrowserConnectOptions
     ): Promise<ApiMiddleware> {
         const authFetch: ApiMiddleware['authFetch'] = (input, init) => {
             const headers = new Headers(init?.headers);
```

- [ ] **Step 6: The middleware takes the connect's claim** (`initialise-browser-middleware.ts`):

```diff
--- a/packages/shared-web/browser/connection/initialise-browser-middleware.ts
+++ b/packages/shared-web/browser/connection/initialise-browser-middleware.ts
@@ -5,10 +5,7 @@ import type {
     ALVolatileInboundRuntimeStores
 } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
 import type { ALVolatileSessionLimits } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
-import {
-    ALWAYS_OWNED_AL_DURABLE_WORK,
-    type ALDurableWorkOwnership
-} from '@shared/alm/work/al-durable-work-ownership.ts';
+import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
 import type {
     ApiConfig,
     AuthSession,
@@ -97,6 +94,11 @@ export interface MiddlewareInitOptions {
     readonly onAuthInvalid?: (error: Error) => void | Promise<void>;
 }
 
+/** One connect's options: the caller's, and the connect's claim on its session's durable work. */
+export interface BrowserConnectOptions extends MiddlewareInitOptions {
+    readonly durableWorkOwnership: ALDurableWorkOwnership;
+}
+
 export interface ToCreateWsUrlInput {
     readonly apiConfig: ApiConfig;
     readonly session: AuthSession;
@@ -194,7 +196,7 @@ export interface InitialiseBrowserTransportInput {
     readonly volatileBound: BrowserSessionVolatileBound;
     /** The connect's claim on its session's durable work, handed to every carrier's durable lanes. */
     readonly durableWorkOwnership: ALDurableWorkOwnership;
-    readonly options: MiddlewareInitOptions;
+    readonly options: BrowserConnectOptions;
 }
 
 interface InitialiseBrowserRtcTransportInput extends InitialiseBrowserTransportInput {
@@ -211,7 +213,7 @@ interface InitialiseBrowserStateTransportInput extends InitialiseBrowserTranspor
 export async function initialiseMiddleware(
     session: AuthSession,
     rtcSignalingTopicId: string,
-    options: MiddlewareInitOptions
+    options: BrowserConnectOptions
 ): Promise<RallarBrowserMiddleware> {
     const storageAvailability = initialiseBrowserRuntimeStores(
         session.sessionId,
@@ -253,7 +255,7 @@ export async function initialiseMiddleware(
 
 export function createBrowserTransportInput(
     session: AuthSession,
-    options: MiddlewareInitOptions
+    options: BrowserConnectOptions
 ): InitialiseBrowserTransportInput {
     const clientData: ClientInfo = {
         clientId: session.clientId,
@@ -274,7 +276,7 @@ export function createBrowserTransportInput(
             volatileBound.budget
         ),
         volatileBound,
-        durableWorkOwnership: ALWAYS_OWNED_AL_DURABLE_WORK,
+        durableWorkOwnership: options.durableWorkOwnership,
         options,
         creation: {
             createMessage: newALUntargetedMessage,
```

- [ ] **Step 7: The tests that build or pin the connect's options.**

```diff
--- a/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
+++ b/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
@@ -1,12 +1,13 @@
 import { describe, expect, it, onTestFinished } from 'vitest';
 
+import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
 import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
 import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import {
     createBrowserTransportInput,
     toBrowserWebSocketQueueBoxInput,
     toRtcOverlayMulticastManagerInput,
-    type MiddlewareInitOptions
+    type BrowserConnectOptions
 } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import type { AuthSession } from '@shared/api/api-config.ts';
@@ -25,11 +26,16 @@ const SESSION: AuthSession = {
     expiresAtEpochMs: 60_000
 };
 
-const OPTIONS: MiddlewareInitOptions = {
+const OPTIONS: BrowserConnectOptions = {
     qosProvider: undefined,
     readVolatileSessionLimits: () => ({ maxAdmissions: 3, maxBytes: 4_096 }),
     deliverySettlements: { ws: () => {}, rtc: () => {} },
-    diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
+    diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
+    durableWorkOwnership: new BrowserALDurableWorkClaim({
+        scope: defaultStateScope(),
+        sessionId: SESSION.sessionId,
+        locks: undefined
+    })
 };
 
 describe('the one volatile bound a browser session hands its carriers (D74)', () => {
@@ -71,8 +77,8 @@ describe('the one volatile bound a browser session hands its carriers (D74)', ()
     });
 });
 
-describe('the durable work ownership a connect hands its carriers', () => {
-    it('gives the WS client and the RTC overlay the ownership of the transport input', () => {
+describe('the durable work claim a connect hands its carriers', () => {
+    it('gives the WS client and the RTC overlay the connect\'s claim', () => {
         configureBrowserALRuntimeStores(SESSION.sessionId, { scope: defaultStateScope(), diagnosticsPorts: OPTIONS.diagnosticsPorts });
         const qboxEngine = new InboxOutboxEngine();
         onTestFinished(() => qboxEngine.stop());
@@ -88,8 +94,9 @@ describe('the durable work ownership a connect hands its carriers', () => {
             webRtcConnectionService: createConnectionService()
         });
 
-        expect(ws.durableWorkOwnership).toBe(input.durableWorkOwnership);
-        expect(rtc.durableWorkOwnership).toBe(input.durableWorkOwnership);
+        expect(input.durableWorkOwnership).toBe(OPTIONS.durableWorkOwnership);
+        expect(ws.durableWorkOwnership).toBe(OPTIONS.durableWorkOwnership);
+        expect(rtc.durableWorkOwnership).toBe(OPTIONS.durableWorkOwnership);
     });
 });
```

```diff
--- a/packages/tests/shared-web/rallar-facade-defaults.test.ts
+++ b/packages/tests/shared-web/rallar-facade-defaults.test.ts
@@ -7,6 +7,7 @@ import {
     vi
 } from 'vitest';
 
+import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
 import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
 import type * as RefreshStateSnapshotsModule from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
@@ -294,7 +295,8 @@ describe('Rallar facade default scope behavior', () => {
                 timeoutMs: 321,
                 dataChannelLanes: lanes,
                 maxPeerConnections: 12,
-                rttReportingDegreeLimit: 3
+                rttReportingDegreeLimit: 3,
+                durableWorkOwnership: expect.any(BrowserALDurableWorkClaim)
             }
         );
         expect(mocks.refreshStateSnapshots).toHaveBeenCalledWith(
```

```diff
--- a/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
+++ b/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
@@ -1,3 +1,4 @@
+import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
 import { readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
 import { browserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
 import {
@@ -205,7 +206,8 @@ describe('browser facade restored-session setup', () => {
                     workspaceId: 'match'
                 },
                 timeoutMs: 123,
-                maxPeerConnections: 10
+                maxPeerConnections: 10,
+                durableWorkOwnership: expect.any(BrowserALDurableWorkClaim)
             }
         );
         expect(runtime.refreshStateSnapshots).toHaveBeenCalledWith(
```

- [ ] **Step 8: Navigation maps and the diagnostics contract.**

```diff
--- a/packages/shared-web/browser/README.md
+++ b/packages/shared-web/browser/README.md
@@ -190,6 +190,18 @@ The browser transport storage and WebSocket owners are feature-colocated:
   the others, and the first failure is rethrown after all were tried. The
   pre-scope database `ar-eye-hunter-al-runtime` is never opened or deleted; the
   browser evicts it.
+- [browser-al-durable-work-claim.ts](./al-runtime/browser-al-durable-work-claim.ts)
+  owns one connect's claim on its session's durable work in its scope: the Web
+  Lock `rallar:al-durable-owner:<applicationId>:<workspaceId>:<sessionId>` (the
+  scope's parts URI-encoded), requested once per connect by
+  [BrowserTransportRuntime.init](./connection/browser-transport-runtime.ts)
+  with the connect's own signal and released when the connect ends, after its
+  runtimes stop, or when the connect fails. The tab it is granted to drains the
+  session's durable lanes; every other tab admits and waits, and the next
+  tab's lock is granted when the owner's connect ends, whose bootstrap batch
+  takes over. Without the Locks API, or when the request fails, every connect
+  owns its work as before. The WS client, the RTC overlay and the RTC receiver
+  hand it to their durable lanes only.
 - [delete-ended-session-al-runtime-entries.ts](./session/delete-ended-session-al-runtime-entries.ts)
   purges an ended session's rows on logout, and a replaced session's rows after
   the disconnect on a login over it or a session switch in `connect`, when the
```

```diff
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -55,8 +55,11 @@ registers its task and runs the bootstrap batch once; that batch's first-batch r
 takeover's recovery outcome. A row the previous owner held is recovered by the lease sweep of a later
 batch, at its lease end plus at most 19.1 s, never sooner. The owner's lane hears every commit another
 runtime announced for its work type (`onForeignCommit`) and runs it through `applyForeignCommit(rows)`,
-the same `committed(rows)` its own commits take. The browser hands its per-connect value through the
-WS client's and the RTC overlay's carrier inputs.
+the same `committed(rows)` its own commits take. The browser's value is the connect's
+[`BrowserALDurableWorkClaim`](../../../shared-web/browser/al-runtime/browser-al-durable-work-claim.ts),
+the second name on the lock port: `rallar:al-durable-owner:<applicationId>:<workspaceId>:<sessionId>`,
+requested once per connect, never per send, and held until the connect ends; without the Locks API
+every connect owns its work, as before.
 
 The transport decoding owners are
 [`decodeALOutboundPreparedMessage`](./al-outbound-effect-validation.ts) for WS
```

```diff
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -537,6 +537,15 @@ names the lane after the store id (`browser-session-inbound:<sessionId>/ws`,
   `rtc-with-ws-fallback`, whose hold hands the original to WS before the
   reload.
 
+  Where the browser has the Locks API, only the tab that holds the session's
+  durable-owner lock runs its durable lanes' batches, so the outcomes are the
+  session's and come from that tab alone; another tab of the session reports
+  no `recovery` while it waits. When the owner's connect ends, the next tab's
+  lock is granted, and its first batch, the takeover's, reports `restored` with
+  the rows it claimed: a row the previous owner still held under its lease is
+  claimed by a later batch, at its lease end plus at most 19.1 s. Without the
+  Locks API every tab drains, and reports, as before.
+
 ## Compatibility
 
 Adding optional fields to diagnostic payloads is compatible.
```

```diff
--- a/docs/rallar-api-reference.md
+++ b/docs/rallar-api-reference.md
@@ -674,6 +674,13 @@ message. A lane send names no channel, so it always refuses. A WS send with
 scope `world` or `all`, and a `best-effort` send, ask for no receipt unless
 the send states `ack`.
 
+Two tabs of one session share its durable stores, and one of them drains them:
+where the browser has the Locks API, the tab holding the session's
+durable-owner lock sends every tab's durable messages, and when it disconnects
+or closes the next tab takes over and sends what it left; a message the closed
+tab was still sending is retried once its lease ends, at most 19.1 s after.
+Without the Locks API every tab sends its own, as before.
+
 A browser without IndexedDB has no durable storage and no memory stand-in:
 each connect decides that once, and its durable sends follow the same rule
 without reaching the carrier. Any other storage failure is tried again by the
```

- [ ] **Step 9: Format the touched files only.**

```sh
npx dprint fmt packages/shared/alm/storage/al-browser-locks.ts packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts \
  packages/shared-web/browser/connection/browser-transport-runtime.ts packages/shared-web/browser/connection/initialise-browser-middleware.ts \
  packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts packages/tests/shared-web/connection/browser-transport-cleanup.test.ts \
  packages/tests/shared-web/connection/initialise-browser-middleware.test.ts packages/tests/shared-web/rallar-facade-defaults.test.ts \
  packages/tests/shared-web/composition/browser-facade-behavior.test.ts packages/shared-web/browser/README.md \
  packages/shared/alm/outbound/README.md packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md docs/rallar-api-reference.md
```

- [ ] **Step 10: Focused tests.**

```sh
npx vitest run packages/tests/shared-web/al-runtime packages/tests/shared-web/connection
for i in 1 2 3 4 5; do npx vitest run packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts | grep 'Tests '; done
npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/alm/outbound/al-outbound-control-handoff-two-tabs.test.ts \
  packages/tests/shared/alm/outbound-control-handoff.test.ts packages/tests/shared/webrtc/ws-rtc-control-handoff-latency.test.ts
npx vitest run packages/tests/shared-web   # sandbox disabled
```

Expected (measured): `Test Files  15 passed (15)`, `Tests  136 passed (136)`; the claim file `Tests  6 passed (6)`
five times; the lock tests green with their exact counts unedited; the whole shared-web suite
`Test Files  161 passed (161)` (before Step 7's pin updates it reads `2 failed`: the two exact-options pins).

- [ ] **Step 11: Per-task checks and bundles.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
(cd apps/api-v1 && deno task check)
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts \
  packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts
npm run check:test-reachability
npm run test:unit:main   # sandbox disabled
```

Expected (measured): no `tsc` output; typechecks and `deno task check` exit 0; `check-tests-typecheck ... PASS`
(an `onTestFinished(() => vi.unstubAllGlobals())` arrow returns `VitestUtils` and fails it: use a block body); the
three pins unedited and green; `browser/rallar.ts` 233.792 KiB (233.8, under 234: `Bundle budget check passed.`);
headless 298.624 KiB (under Task 2's 299); `Tests  18 passed (18)`; `Test reachability: 1731 test files, 1725
reached by CI, 6 manual.`; `test:unit:main` `Test Files  1349 passed | 4 skipped (1353)`, `Tests  12573 passed |
12 skipped (12585)`. The rallar.ts bundle has 0.208 KiB left: Task 4's channel will likely cross 234 and raise it.

- [ ] **Step 12: Commit, then run the changed-range gates.**

```sh
git add packages/shared packages/shared-web packages/shared-test packages/tests docs/rallar-api-reference.md
git commit -F - <<'EOF'
Claim a session's durable work per connect with a Web Lock

BrowserALDurableWorkClaim is one connect's ALDurableWorkOwnership: the
Web Lock rallar:al-durable-owner:<applicationId>:<workspaceId>:<sessionId>
on the shared lock port, requested once per connect by
BrowserTransportRuntime.init with the connect's own abort signal and
held until the connect ends. The tab it is granted to drains the
session's durable lanes; the next tab's request is granted when that
connect ends, and its handlers take over with the bootstrap batch,
which reports restored through the recovery reporter. The claim is
released after the connect's runtimes stop, or when the connect fails.
Without the Locks API, or when the request fails, every connect owns
its work as before. initialiseMiddleware takes the claim beside the
caller's options and hands it to the WS client, the RTC overlay and the
RTC receiver.

D8 reuse: the shared ALBrowserLocks port carries the owner lock as its second name and ObservableLatestValue the owned flag; no new coordination primitive, and the default runtime composition still requests no lock.
EOF
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured): `PASS: no new repository style findings`; structure coupling `PASS` on all three lines.

---

### Task 4: The session channel: the commit wake and the durable-lane settlement relay

Prototyped in scratch as commit `5cfbf2147` on Task 3's prototype head `7bb50639b` (red then green). The plan's
assembly added R-I2a-ii-44 (the `lane` stamp on the settlement and the relay's durable-lane filter) and R-I2a-ii-45
(no real `BroadcastChannel` in a unit test), red then green, on the assembled tree (scratch `9ed59ed8d`, Tasks 1–3
applied first). Decisions D123 (the cross-tab wake and decision 11's relay), proposal §3.g; rulings R-I2a-ii-6, -7,
-8 (narrowed by -44), -9, -19, -22, -41 to -51. File:line anchors below are of Task 3's head; a file Tasks 1–3 did not
touch has the same lines at `ee510bbb0`.

**Files**

- Create: `packages/shared-web/browser/al-runtime/browser-al-session-channel.ts` (123 lines) —
  `BrowserALSessionChannel` (one `BroadcastChannel` per connect, `rallar-alm:<encoded applicationId>:<encoded
  workspaceId>:<sessionId>`), its message contract, `openBrowserALSessionChannelPort` (the global behind the
  `rallar-crdt` guard) and `toBrowserALSessionKey`.
- Modify: `packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts` — imports (`:1-5`), a
  required `sessionChannel` input (after `:12`), a `sessionChannel` getter (after `owned`, `:32-34`),
  `release()` closes the channel (`:49-51`), `announceCommit` posts on it and `onForeignCommit` listens on it
  only while owned (replacing the no-ops at `:57-61`).
- Modify: `packages/shared-web/browser/connection/browser-delivery-settlements.ts` — `Observers` (the
  carriers plus `holds(msgId)`) and `Relay`; `open(observers, relay)` relays a durable lane's settlement this
  tab holds no handle for (`:20-38`).
- Modify: `packages/shared/alm/delivery/al-delivery-lifecycle.ts` — the settlement union becomes the private
  `ALDeliverySettlementStatement` (`:96`) and `ALDeliverySettlement` is that union with an optional `lane`
  (before `:231`); a type import of `ALStoreDurability` (R-I2a-ii-44, -48).
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` — `ALOutboundUnstampedSettlement`
  omits `lane` too (`:288-290`); each lane's emitter states its lane (`:432`, `:447`, `:460`); the runtime's
  own `cancel` names none (`:490`); `emitSettlement(fact, lane)` stamps it (`:681-694`).
- Modify: `packages/shared-web/browser/messages/browser-session-deliveries.ts` — an `observers` field built
  in the constructor beside `settle` (`:12`, `:23`).
- Modify: `packages/shared-web/browser/session/session-connection-lifecycle.ts` — the pending options are
  `BrowserTransportInitOptions` (`:3`, `:36`) and the connect passes `sessionDeliveries.observers` (`:95`).
- Modify: `packages/shared-web/browser/connection/browser-transport-runtime.ts` — `BrowserTransportInitOptions`,
  a constructor input with the injected port factory (`BrowserTransportRuntime.Input`), `init` claims before
  opening the epoch and hands the epoch the claim's channel (`:69-70`), `claimDurableWork` builds the
  channel (`:122-131`), the singleton passes `openBrowserALSessionChannelPort` (`:176`).
- Modify: `packages/shared-web/bundle-budgets.json` — `browser/rallar.ts` 234 → 235 (234.219 KiB measured on
  the assembled tree; 234.193 on the prototype without R-I2a-ii-44).
- Modify (docs): `packages/shared-web/browser/README.md` (after `:204`, and `:234`),
  `packages/shared/alm/outbound/README.md` (`:58`, and the settlement paragraph `:741-742`),
  `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (`:189`), the two comments in
  `packages/shared/alm/work/al-work-handler.ts` that said another tab's row waits for the age bound
  (`:132`, `:200-201`).
- Test (create): `packages/tests/shared-web/al-runtime/browser-al-session-channel.test.ts` (7 tests),
  `packages/tests/shared-web/al-runtime/browser-al-session-commit-wake.test.ts` (3 tests),
  `packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts` (6 tests).
- Test (modify): `packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts` (Task 3's
  `openClaim` gives each claim a channel that reaches no tab, so its takeover proofs keep proving the
  takeover); `packages/tests/shared/alm/inbound-runtime-test-fixture.ts` (an optional shared `dbName`, as
  the outbound fixture's `createIndexedDbOutboundTestStores` has); 21 mechanical test edits (Step 10);
  `packages/tests/shared/alm/outbound-delivery-settlements.test.ts` (one new test, five expectations pin
  `lane: 'durable'`), `packages/tests/shared/alm/al-outbound-control-admission.test.ts` (one expectation),
  `packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts` (four expectations).
- Test (modify, R-I2a-ii-45): `packages/tests/shared-web/data/rallar-data-test-runtime.ts`
  (`installFakeBroadcastChannelPerTest()` and `FakeBroadcastChannel.openNames()`), the 33 shared-web test files
  that connect through the browser composition's transport runtime (Step 11's table), and
  `packages/tests/shared-web/composition/browser-facade-behavior.test.ts` (one composition test).
- Not touched: the lanes, `ALWorkHandler`'s gate, `ALWorkEngineMembership`, `ALDurableWorkOwnership`
  (Tasks 2–3 already route by work type: each durable lane subscribes `onForeignCommit(workType, …)` and
  applies it through its public `applyForeignCommit`, outbound `work.committed(rows)`, inbound
  `requestHeadRead()` then `committed(AL_WORK_UNDESCRIBED_COMMIT)`); no server or Node file; the volatile
  lanes; the pins.

**Interfaces**

- Consumes (Tasks 2–3, at `7bb50639b`): `ALDurableWorkOwnership` with `announceCommit({ workType, rows })`
  and `onForeignCommit(workType, listener)` keyed by the lane's work type (R-I2a-ii-19); a waiting runtime's
  `committed()` only announces (R-I2a-ii-22); `BrowserALDurableWorkClaim` (`request()`, `release()`,
  `isOwned()`, `owned`), created once per connect by `BrowserTransportRuntime.claimDurableWork` and released
  in `shutdown()` after the runtimes stop and in `init`'s `.catch` (R-I2a-ii-24); `BrowserConnectOptions`
  (R-I2a-ii-26).
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // browser-al-session-channel.ts
  export namespace BrowserALSessionChannel {
      export interface Port { onmessage: ((event: MessageEvent) => void) | null; postMessage(message: Message): void; close(): void; }
      export type OpenPort = (name: string) => Port | undefined;
      export interface Input { scope; sessionId; instanceId; openPort: OpenPort; applySettlement: ALDeliverySettlementSink; }
      export interface Envelope { version: 1; sessionKey: string; instanceId: string; }
      export interface CommittedBody { kind: 'committed'; workType: string; rows: ALWorkCommittedRows; }
      export interface SettlementBody { kind: 'settlement'; settlement: ALDeliverySettlement; }
      export type Body = CommittedBody | SettlementBody;
      export type Message = Envelope & Body;
  }
  export function openBrowserALSessionChannelPort(name: string): BrowserALSessionChannel.Port | undefined;
  export function toBrowserALSessionKey(scope: StateScope, sessionId: string): string;
  export class BrowserALSessionChannel {
      announceCommit(commit: ALDurableWorkCommit): void;
      onForeignCommit(workType: string, listener: (rows: ALWorkCommittedRows) => void): () => void;
      relaySettlement(settlement: ALDeliverySettlement): void;
      close(): void;
  }
  // browser-delivery-settlements.ts
  BrowserDeliverySettlements.Observers extends Carriers { holds(msgId: string): boolean; }
  BrowserDeliverySettlements.Relay { relaySettlement(settlement: ALDeliverySettlement): void; }
  open(observers: BrowserDeliverySettlements.Observers, relay: BrowserDeliverySettlements.Relay): Epoch;
  // browser-transport-runtime.ts
  export interface BrowserTransportInitOptions extends Omit<MiddlewareInitOptions, 'deliverySettlements'> {
      readonly deliverySettlements: BrowserDeliverySettlements.Observers;
  }
  BrowserTransportRuntimePort.init(options: BrowserTransportInitOptions): Promise<ApiMiddleware>;
  new BrowserTransportRuntime(input: { openSessionChannelPort: BrowserALSessionChannel.OpenPort });
  // browser-session-deliveries.ts
  BrowserSessionDeliveries.observers: BrowserDeliverySettlements.Observers;
  // packages/shared/alm/delivery/al-delivery-lifecycle.ts (R-I2a-ii-44, -48)
  export type ALDeliverySettlement = ALDeliverySettlementStatement & Readonly<{ lane?: ALStoreDurability; }>;
  // packages/tests/shared-web/data/rallar-data-test-runtime.ts (R-I2a-ii-45, -49)
  export function installFakeBroadcastChannelPerTest(): void;
  FakeBroadcastChannel.openNames(): readonly string[];
  // browser-al-durable-work-claim.ts
  BrowserALDurableWorkClaim.Input.sessionChannel: BrowserALSessionChannel;   // required; closed on release
  BrowserALDurableWorkClaim.sessionChannel: BrowserALSessionChannel;          // getter, for the epoch
  ```
  Behaviour. The channel is opened once per connect, with the claim, and closed by `claim.release()`. A
  message is `{ version: 1, sessionKey, instanceId, kind, … }`; a receiver drops a message of another
  version, of another session key (another session or scope, which the name already separates) and one
  carrying its own `instanceId` (its echo). `committed` carries the lane's work type and the
  `ALWorkCommittedRows` the waiting tab's commit computed; the claim hands it to the listener of that work
  type only while it owns the work, so the owner's lane runs it through `applyForeignCommit` (its own
  `committed()`, so the batch claims the rows and D112's restore holds) and a waiting tab never re-announces
  it. `settlement` carries one `ALDeliverySettlement`: every tab's epoch sink, after recording a settlement
  through its own observers, posts it once when a durable lane stated it (`lane === 'durable'`) and
  `holds(msgId)` is false (`registry.getHandle(msgId) === undefined`); a volatile lane's settlement, and one no
  lane stated (the browser sender's own facts, the runtime's cancel), is never posted, so signaling, overlay
  forwarding and the volatile ACK controls never cross tabs (R-I2a-ii-44); a receiving tab records it through its own observers (`sessionDeliveries.settle`, which
  ignore a msgId they never opened), never through an epoch, so it is never relayed again and each tab
  holding the handle applies it once. A `cancel()` reaches only its own tab's carriers (R-I2a-ii-9). Without
  `BroadcastChannel` the port factory answers `undefined` and the channel posts and hears nothing: a waiting
  tab's row then waits for the owner's age-bound probe, as after Task 3.

**D8 reuse inspection.** The channel follows the `rallar-crdt` tab sync (`browser-crdt-tab-sync.ts:15-65`):
the same missing-API guard, a `version` field, an `instanceId` echo filter, the cast of `event.data` to a
`Partial` of the message and a field check, and `close()`. The transport runtime injects the port factory
(R-I2a-ii-7) because Node's global `BroadcastChannel` is real; the unit tests pass
`FakeBroadcastChannel` from `packages/tests/shared-web/data/rallar-data-test-runtime.ts:10-43` (reused, not
copied). The commit wake reuses Tasks 2–3's lane entries (`applyForeignCommit`), keyed by the work type both
tabs compute (`toALOutboundWorkType`, `toALInboundWorkType`), and the claim's own lifetime; there is no
engine-wide `wakeAfterExternalWrite`, no new scheduler and no new timer. The relay reuses the registry's
`getHandle()` and `BrowserSessionDeliveries.settle`, and taps the one epoch sink both carriers already share.
The lane stamp reuses the runtime's existing stamping point (`emitSettlement` already stamps `carrier` and
`atMs` for every owner) and the lane identity the store lanes already carry (`ALStoreDurability`); no second
sink or settlement type. The R-I2a-ii-45 helper reuses the same `FakeBroadcastChannel` and the `vi.stubGlobal`
pattern the Rallar CRDT tests use for the global. `packages/shared/cache` was checked: its repositories hold latest
values, not a listener set keyed by work type, and the listener map is three lines inside the channel;
`packages/shared/resilience` is not involved.

**The lane's consumers, swept by enumeration (R-I2a-ii-44).** `ALDeliverySettlement` is read by
`compute-al-delivery-lifecycle.ts` and `resolve-al-delivery-fallback-trigger.ts` (by `kind` and its fields: the
optional `lane` is ignored), the registry (`browser-rallar-delivery-registry.ts`, `browser-message-fallback-controller.ts`,
`browser-rallar-message-dispatch.ts`: they record or build settlements with no lane, which is the "no lane
stated" meaning), the server's receipt status (`alm-receipt-diagnostics.ts` `toRallarAlmReceiptEntry`, by `kind`),
`AdminOperationsAlmReceiptEntry.lastSettlementKind` (the `kind` only), the harness's
`tests/playwright/alm/harness/durable-send-observation.ts` (`kind` and `complete`), and the session channel,
which carries the settlement as it is. No decoder parses a settlement field by field, so none changes; the
tests that pin a whole runtime-stated settlement with `toEqual` gain `lane: 'durable'` (Step 1(d)).

- [ ] **Step 1: Write the failing tests.** (a) Create `packages/tests/shared-web/al-runtime/browser-al-session-channel.test.ts`:

<!-- dprint-ignore -->
```ts
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserALSessionChannel } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { FakeBroadcastChannel } from '../data/rallar-data-test-runtime.ts';

const SCOPE: StateScope = { applicationId: 'app:one', workspaceId: 'work space' };
const ROWS: ALWorkCommittedRows = { dueByMs: 10, writtenKeys: ['row-a'] };
const SETTLEMENT: ALDeliverySettlement = {
    kind: 'attempt-started',
    msgId: 'message-1',
    carrier: 'ws',
    atMs: 1,
    attemptId: 'attempt-1'
};

afterEach(() => {
    FakeBroadcastChannel.clear();
});

describe('browser AL session channel', () => {
    it('names one channel per scope and session, each part of the scope encoded', () => {
        const opened: string[] = [];

        createTab({
            sessionId: 'session-1',
            openPort: (name) => {
                opened.push(name);
                return new FakeBroadcastChannel(name);
            }
        });

        expect(opened).toEqual(['rallar-alm:app%3Aone:work%20space:session-1']);
    });

    it('hands a foreign commit to the listener of its work type only', async () => {
        const owner = createTab({ sessionId: 'session-1' });
        const writer = createTab({ sessionId: 'session-1' });
        const heard: string[] = [];
        owner.channel.onForeignCommit('AL_OUTBOUND:a', () => heard.push('outbound'));
        owner.channel.onForeignCommit('AL_INBOUND:ws:a', () => heard.push('inbound'));

        writer.channel.announceCommit({ workType: 'AL_OUTBOUND:a', rows: ROWS });
        await flushChannel();

        expect(heard).toEqual(['outbound']);
    });

    it('stops handing commits to a listener that unsubscribed, and to a closed channel', async () => {
        const owner = createTab({ sessionId: 'session-1' });
        const writer = createTab({ sessionId: 'session-1' });
        const heard: string[] = [];
        const unsubscribe = owner.channel.onForeignCommit('AL_OUTBOUND:a', () => heard.push('unsubscribed'));
        const other = createTab({ sessionId: 'session-1' });
        other.channel.onForeignCommit('AL_OUTBOUND:a', () => heard.push('closed'));

        unsubscribe();
        other.channel.close();
        writer.channel.announceCommit({ workType: 'AL_OUTBOUND:a', rows: ROWS });
        await flushChannel();

        expect(heard).toEqual([]);
    });

    it('applies a relayed settlement through its own observers', async () => {
        const holder = createTab({ sessionId: 'session-1' });
        const relaying = createTab({ sessionId: 'session-1' });

        relaying.channel.relaySettlement(SETTLEMENT);
        await flushChannel();

        expect(holder.applied).toEqual([SETTLEMENT]);
        expect(relaying.applied).toEqual([]);
    });

    it('never crosses sessions or scopes', async () => {
        const otherSession = createTab({ sessionId: 'session-2' });
        const otherScope = createTab({ sessionId: 'session-1', scope: { ...SCOPE, workspaceId: 'other' } });
        const heard: string[] = [];
        otherSession.channel.onForeignCommit('AL_OUTBOUND:a', () => heard.push('other-session'));
        otherScope.channel.onForeignCommit('AL_OUTBOUND:a', () => heard.push('other-scope'));
        const writer = createTab({ sessionId: 'session-1' });

        writer.channel.announceCommit({ workType: 'AL_OUTBOUND:a', rows: ROWS });
        writer.channel.relaySettlement(SETTLEMENT);
        await flushChannel();

        expect(heard).toEqual([]);
        expect(otherSession.applied).toEqual([]);
        expect(otherScope.applied).toEqual([]);
    });

    // A second channel object of the same tab instance echoes what the first posted; the tab must not
    // apply its own relay or wake itself.
    it('ignores a message carrying its own instance id, another session key, or another version', async () => {
        const tab = createTab({ sessionId: 'session-1', instanceId: 'tab-a' });
        const heard: ALWorkCommittedRows[] = [];
        tab.channel.onForeignCommit('AL_OUTBOUND:a', (rows) => heard.push(rows));
        const raw = new FakeBroadcastChannel('rallar-alm:app%3Aone:work%20space:session-1');
        const envelope = { version: 1, sessionKey: 'app%3Aone:work%20space:session-1', instanceId: 'tab-b' };

        raw.postMessage({ ...envelope, instanceId: 'tab-a', kind: 'settlement', settlement: SETTLEMENT });
        raw.postMessage({ ...envelope, sessionKey: 'app%3Aone:work%20space:session-2', kind: 'settlement', settlement: SETTLEMENT });
        raw.postMessage({ ...envelope, version: 2, kind: 'committed', workType: 'AL_OUTBOUND:a', rows: ROWS });
        raw.postMessage({ ...envelope, kind: 'committed', workType: 'AL_OUTBOUND:a', rows: ROWS });
        await flushChannel();

        expect(tab.applied).toEqual([]);
        expect(heard).toEqual([ROWS]);
    });

    it('posts nothing and wakes nothing where the browser has no channel', () => {
        const tab = createTab({ sessionId: 'session-1', openPort: () => undefined });
        const heard: ALWorkCommittedRows[] = [];

        const unsubscribe = tab.channel.onForeignCommit('AL_OUTBOUND:a', (rows) => heard.push(rows));
        tab.channel.announceCommit({ workType: 'AL_OUTBOUND:a', rows: ROWS });
        tab.channel.relaySettlement(SETTLEMENT);
        unsubscribe();
        tab.channel.close();

        expect(heard).toEqual([]);
        expect(tab.applied).toEqual([]);
    });
});

interface SessionTab {
    readonly channel: BrowserALSessionChannel;
    /** Every settlement another tab relayed to this one, in arrival order. */
    readonly applied: readonly ALDeliverySettlement[];
}

interface SessionTabInput {
    readonly sessionId: string;
    readonly scope?: StateScope;
    readonly instanceId?: string;
    readonly openPort?: BrowserALSessionChannel.OpenPort;
}

function createTab(input: SessionTabInput): SessionTab {
    const applied: ALDeliverySettlement[] = [];
    const channel = new BrowserALSessionChannel({
        scope: input.scope ?? SCOPE,
        sessionId: input.sessionId,
        instanceId: input.instanceId ?? crypto.randomUUID(),
        openPort: input.openPort ?? ((name) => new FakeBroadcastChannel(name)),
        applySettlement: (settlement) => applied.push(settlement)
    });
    return { channel, applied };
}

/** The fake delivers on a microtask per receiver; one macrotask drains every delivery a post queued. */
async function flushChannel(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}
```

(b) Create `packages/tests/shared-web/al-runtime/browser-al-session-commit-wake.test.ts`:

<!-- dprint-ignore -->
```ts
import '../../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
import {
    BrowserALSessionChannel,
    toBrowserALSessionKey
} from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import type { ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from '../../shared/alm/inbound-runtime-test-fixture.ts';
import { createOutboundMessage, drainEngine } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import {
    createOutboundTestSession,
    createSessionOutboundTestRuntime
} from '../../shared/alm/session-outbound-test-runtime.ts';
import { FakeBroadcastChannel } from '../data/rallar-data-test-runtime.ts';

const SCOPE: StateScope = { applicationId: 'app', workspaceId: 'workspace' };
const SESSION_ID = 'session-1';
/** Far inside the remembered answer's age bound, so only an announced commit can reach the owner. */
const DELIVERY_WAIT = { timeout: 1_000, interval: 5 };
/** A lock some other tab holds for the whole test: a connect requesting it waits. */
const HELD_ELSEWHERE: ALBrowserLocks = { request: async () => await new Promise<never>(() => {}) };

afterEach(() => {
    FakeBroadcastChannel.clear();
});

describe('browser AL session commit wake', () => {
    it('sends a durable message a waiting tab committed from the owner, without waiting for the age bound', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, openTabClaim('owner'));
        const waiting = createSessionOutboundTestRuntime(session, openTabClaim('waiting'));
        await owner.runtime.ready();
        // The owner probes once and remembers that it has no work.
        await drainEngine(owner.engine);

        const admitted = await waiting.runtime.enqueueIfAbsent(createOutboundMessage('durable-foreign'));

        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: true });
        await vi.waitFor(() => expect(owner.sent).toEqual(['durable-foreign']), DELIVERY_WAIT);
        expect(waiting.sent).toEqual([]);
    });

    // A second waiting tab hears the announcement too; it neither sends the row nor announces it again,
    // so one commit costs one message.
    it('leaves a foreign commit to the owner in every waiting tab', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, openTabClaim('owner'));
        const waiting = createSessionOutboundTestRuntime(session, openTabClaim('waiting'));
        const bystander = createSessionOutboundTestRuntime(session, openTabClaim('waiting'));
        const wire = listenOnSessionChannel();

        await waiting.runtime.enqueueIfAbsent(createOutboundMessage('durable-once'));
        await vi.waitFor(() => expect(owner.sent).toEqual(['durable-once']), DELIVERY_WAIT);
        await drainEngine(bystander.engine);

        expect(wire.map((message) => message.kind)).toEqual(['committed']);
        expect(bystander.sent).toEqual([]);
        expect(waiting.sent).toEqual([]);
    });

    // The owner's rotation has moved past the head of NEW, so the foreign row is found within this one
    // batch only because the owner's lane answers the announcement with a read from the head.
    it('delivers a durable inbound message a waiting tab admitted from the owner, reading from the head', async () => {
        const dbName = `commit-wake-inbound-${crypto.randomUUID()}`;
        const owner = createInboundTab(dbName, 'owner');
        const waiting = createInboundTab(dbName, 'waiting');
        await Promise.all([owner.runtime.ready(), waiting.runtime.ready()]);
        await drainEngine(owner.queueEngine);

        const admitted = await waiting.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'foreign-inbound', durability: 'local-inbox' }),
            INBOUND_TEST_SOURCE
        );

        expect(admitted.right).toEqual({ kind: 'admitted' });
        await vi.waitFor(() => expect(owner.delivered).toEqual(['dispatched']), DELIVERY_WAIT);
        expect(waiting.delivered).toEqual([]);
    });
});

type TabRole = 'owner' | 'waiting';

/** One connect's claim: the owner's is granted at once (no Locks API), a waiting one is never granted. */
function openTabClaim(role: TabRole): BrowserALDurableWorkClaim {
    const claim = new BrowserALDurableWorkClaim({
        scope: SCOPE,
        sessionId: SESSION_ID,
        locks: role === 'owner' ? undefined : HELD_ELSEWHERE,
        sessionChannel: new BrowserALSessionChannel({
            scope: SCOPE,
            sessionId: SESSION_ID,
            instanceId: crypto.randomUUID(),
            openPort: (name) => new FakeBroadcastChannel(name),
            applySettlement: () => {}
        })
    });
    claim.request();
    onTestFinished(() => claim.release());
    return claim;
}

function createInboundTab(dbName: string, role: TabRole): InboundTestRuntime {
    const { stores } = createInboundTestBackendStores({
        namespace: 'commit-wake',
        storage: 'indexeddb',
        observer: createPassThroughIndexedDbOperationObserver(),
        dbName
    });
    return createInboundTestRuntime({
        stores,
        carrier: 'ws',
        effectWorkerId: `al-inbound:${role}`,
        durableWorkOwnership: openTabClaim(role)
    });
}

/** Every message another object posts on the session's channel, as a further tab would hear it. */
function listenOnSessionChannel(): readonly BrowserALSessionChannel.Message[] {
    const heard: BrowserALSessionChannel.Message[] = [];
    const listener = new FakeBroadcastChannel(`rallar-alm:${toBrowserALSessionKey(SCOPE, SESSION_ID)}`);
    listener.onmessage = (event) => heard.push(event.data as BrowserALSessionChannel.Message);
    return heard;
}
```

(c) Create `packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts` (R-I2a-ii-44: a volatile
lane's settlement and one no lane stated stay in their tab; the non-idempotency case uses a terminal `expired`
and two late settlements, since a `carrier-refused` is stated by the browser sender and never relayed, R-I2a-ii-50):

<!-- dprint-ignore -->
```ts
import { afterEach, describe, expect, it } from 'vitest';

import {
    BrowserALSessionChannel,
    toBrowserALSessionKey
} from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import { BROWSER_DELIVERY_RETENTION } from '@shared-web/browser/composition/browser-delivery-composition.ts';
import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { FakeBroadcastChannel } from '../data/rallar-data-test-runtime.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

afterEach(() => {
    FakeBroadcastChannel.clear();
});

describe('browser delivery settlement relay', () => {
    it('relays a settlement for a message it holds no handle for once, and the holding tab applies it once', async () => {
        const wire = listenOnSessionChannel('session-1');
        const sender = createTab('session-1');
        const owner = createTab('session-1');
        const bystander = createTab('session-1');
        const handle = sender.registry.open(createMessage('durable-send'), 'ws');

        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-1'));
        await flushChannel();

        expect(wire.map((message) => message.kind)).toEqual(['settlement']);
        expect(handle.lifecycle().evidence.attempts.map((attempt) => attempt.attemptId)).toEqual(['attempt-1']);
        expect(bystander.registry.getHandle(handle.msgId)).toBeUndefined();
    });

    // A volatile message's state lives in the tab that admitted it, and a settlement no lane stated is the
    // recording tab's own; neither reaches another tab.
    it('relays no settlement of a volatile lane and none that no lane stated', async () => {
        const wire = listenOnSessionChannel('session-1');
        const sender = createTab('session-1');
        const owner = createTab('session-1');
        const handle = sender.registry.open(createMessage('volatile-send'), 'ws');

        owner.epoch.settlements.ws({ ...toAttemptStarted(handle.msgId, 'attempt-1'), lane: 'volatile' });
        owner.epoch.settlements.ws({ kind: 'cancelled', msgId: handle.msgId, carrier: 'ws', atMs: 1 });
        await flushChannel();

        expect(wire).toEqual([]);
        expect(handle.lifecycle().state).toBe('submitted');
    });

    it('does not relay a settlement for a message it holds the handle of', async () => {
        const wire = listenOnSessionChannel('session-1');
        const sender = createTab('session-1');
        createTab('session-1');
        const handle = sender.registry.open(createMessage('own-send'), 'ws');

        sender.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-1'));
        await flushChannel();

        expect(wire).toEqual([]);
        expect(handle.lifecycle().evidence.attempts).toHaveLength(1);
    });

    it('never relays to another session', async () => {
        const otherSession = createTab('session-2');
        const owner = createTab('session-1');
        const handle = otherSession.registry.open(createMessage('same-id-elsewhere'), 'ws');

        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-1'));
        await flushChannel();

        expect(handle.lifecycle().evidence.attempts).toEqual([]);
    });

    it('stops relaying when the connect epoch closes', async () => {
        const sender = createTab('session-1');
        const owner = createTab('session-1');
        const handle = sender.registry.open(createMessage('after-close'), 'ws');

        owner.feed.close();
        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-1'));
        await flushChannel();

        expect(handle.lifecycle().evidence.attempts).toEqual([]);
    });

    // Settlements are not idempotent: every settlement after a terminal state counts as late, so two
    // receiving tabs and a relay must still apply each one once.
    it('applies a relayed terminal settlement and each late one once', async () => {
        const sender = createTab('session-1');
        const owner = createTab('session-1');
        createTab('session-1');
        const handle = sender.registry.open(createMessage('expired-then-late'), 'ws');

        owner.epoch.settlements.ws({
            kind: 'expired',
            msgId: handle.msgId,
            carrier: 'ws',
            atMs: 2,
            detail: 'deadline',
            lane: 'durable'
        });
        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-late'));
        owner.epoch.settlements.ws(toAttemptStarted(handle.msgId, 'attempt-later'));
        await flushChannel();

        expect(handle.lifecycle()).toMatchObject({ state: 'expired', lateSettlementCount: 2 });
    });
});

interface RelayTab {
    readonly registry: BrowserRallarDeliveryRegistry;
    readonly feed: BrowserDeliverySettlements;
    readonly epoch: BrowserDeliverySettlements.Epoch;
}

/** One tab of a session: its own registry and connect epoch, joined to the others only by the session channel. */
function createTab(sessionId: string): RelayTab {
    const registry = new BrowserRallarDeliveryRegistry({ nowMs: () => 0, ...BROWSER_DELIVERY_RETENTION, cancel: () => {} });
    const middleware = createDefaultApiMiddlewareTestDouble();
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(registry, { deliverySettlements: feed, readMiddleware: () => middleware });
    sessionDeliveries.beginSession(middleware.session);
    const observers = sessionDeliveries.observers;
    const channel = new BrowserALSessionChannel({
        scope: SCOPE,
        sessionId,
        instanceId: crypto.randomUUID(),
        openPort: (name) => new FakeBroadcastChannel(name),
        applySettlement: (settlement) => observers[settlement.carrier](settlement)
    });
    const epoch = feed.open(observers, channel);
    return { registry, feed, epoch };
}

function createMessage(msgId: string): ALMessage {
    const message = newALUnicastMessage(
        'sender-peer',
        { topicId: 'chat', resourceId: msgId, contextId: 'room' },
        'receiver-peer',
        'chat.private-text.v1',
        { text: msgId },
        { ttlMs: 60_000, qos: { ack: { algo: 'hop' } } }
    );
    return { ...message, id: { ...message.id, msgId } };
}

function toAttemptStarted(msgId: RallarMessageHandle['msgId'], attemptId: string): ALDeliverySettlement {
    return { kind: 'attempt-started', msgId, carrier: 'ws', atMs: 1, attemptId, lane: 'durable' };
}

/** The fake delivers on a microtask per receiver; one macrotask drains every delivery a post queued. */
async function flushChannel(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every message another object posts on the session's channel, as a further tab would hear it. */
function listenOnSessionChannel(sessionId: string): readonly BrowserALSessionChannel.Message[] {
    const heard: BrowserALSessionChannel.Message[] = [];
    const listener = new FakeBroadcastChannel(`rallar-alm:${toBrowserALSessionKey(SCOPE, sessionId)}`);
    listener.onmessage = (event) => heard.push(event.data as BrowserALSessionChannel.Message);
    return heard;
}
```

(d) The runtime states the lane (R-I2a-ii-44). In `packages/tests/shared/alm/outbound-delivery-settlements.test.ts`,
import `createVolatileOutboundTestStores` from the fixture, add the test, and pin `lane: 'durable'` in the five
whole-settlement expectations a durable lane states:

```diff
diff --git a/packages/tests/shared/alm/outbound-delivery-settlements.test.ts b/packages/tests/shared/alm/outbound-delivery-settlements.test.ts
index f4ddcdd83..8212e9cc4 100644
--- a/packages/tests/shared/alm/outbound-delivery-settlements.test.ts
+++ b/packages/tests/shared/alm/outbound-delivery-settlements.test.ts
@@ -29,6 +29,7 @@ import {
     computeOutboundTestAdmission,
     createDefaultOutboundTestRuntime,
     createOutboundMessage,
+    createVolatileOutboundTestStores,
     enqueueOutboundOrThrow,
     holdOutboundClaims,
     peekOutboundWorkReadyAt,
@@ -127,6 +128,32 @@ function toQueuedLifecycle(message: ALMessage): ALDeliveryLifecycle {
     );
 }
 
+// The browser relays a durable lane's settlement to the tab that holds the message; a volatile message's
+// state stays in the tab that admitted it, and a cancel is the runtime's own.
+it('stamps every settlement with the lane that stated it, and its own cancel with none', async () => {
+    const settlements: ALDeliverySettlement[] = [];
+    const runtime = createDefaultOutboundTestRuntime({
+        stores: createStores('memory'),
+        volatileStores: createVolatileOutboundTestStores(),
+        settlements: (settlement) => settlements.push(settlement),
+        planOutgoingMessage: (msg) => ({ ...planSend()(msg), persist: msg.route.resourceId === 'msg-durable-lane' }),
+        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
+    });
+    const durable = createOutboundMessage('msg-durable-lane');
+    const volatile = createOutboundMessage('msg-volatile-lane');
+
+    await enqueueOutboundOrThrow(runtime, durable);
+    await enqueueOutboundOrThrow(runtime, volatile);
+    runtime.cancel('msg-never-admitted');
+
+    const lanesOf = (msgId: string) => settlements.filter((settlement) => settlement.msgId === msgId).map(({ lane }) => lane);
+    expect(lanesOf(durable.id.msgId)).toEqual(['durable', 'durable']);
+    expect(lanesOf(volatile.id.msgId)).toEqual(['volatile', 'volatile']);
+    expect(settlements.filter((settlement) => settlement.msgId === 'msg-never-admitted')).toStrictEqual([
+        { kind: 'cancelled', msgId: 'msg-never-admitted', carrier: 'ws', atMs: expect.any(Number) }
+    ]);
+});
+
 it.each(BACKEND_KINDS)(
     'states the attempt it started and the outcome its carrier settled over %s',
     async (kind) => {
@@ -182,6 +209,7 @@ it.each(BACKEND_KINDS)('states that a not-ready attempt will be tried again over
         kind: 'attempt-settled',
         msgId: message.id.msgId,
         carrier: 'ws',
+        lane: 'durable',
         atMs: expect.any(Number),
         attemptId: firstAttemptId(message.id.msgId),
         outcome: 'not-ready',
@@ -241,6 +269,7 @@ it.each(BACKEND_KINDS)('states the peers an accepted acknowledgement confirms ov
             kind: 'acknowledgement',
             msgId: message.id.msgId,
             carrier: 'ws',
+            lane: 'durable',
             atMs: expect.any(Number),
             mode: 'hop',
             confirmedHopPeerIds: ['peer-1'],
@@ -254,6 +283,7 @@ it.each(BACKEND_KINDS)('states the peers an accepted acknowledgement confirms ov
             kind: 'acknowledgement',
             msgId: message.id.msgId,
             carrier: 'ws',
+            lane: 'durable',
             atMs: expect.any(Number),
             mode: 'hop',
             confirmedHopPeerIds: ['peer-1', 'peer-2'],
@@ -308,6 +338,7 @@ it.each(BACKEND_KINDS)(
             kind: 'relay-rejected',
             msgId: message.id.msgId,
             carrier: 'rtc',
+            lane: 'durable',
             atMs: expect.any(Number),
             relayRejection: { relay: 'peer', peerId: 'peer-1', reason: 'resync-required' },
             detail: 'Hop peer-1 refused the message: resync-required.'
@@ -349,6 +380,7 @@ it.each(BACKEND_KINDS)('states expiry for work claimed past its own deadline ove
         kind: 'expired',
         msgId: message.id.msgId,
         carrier: 'ws',
+        lane: 'durable',
         atMs: ownerNowMs,
         detail: expect.any(String)
     }]);
```

The three other whole-settlement pins of a durable lane:

```diff
diff --git a/packages/tests/shared/alm/al-outbound-control-admission.test.ts b/packages/tests/shared/alm/al-outbound-control-admission.test.ts
index 2bbd46114..8a3192b7b 100644
--- a/packages/tests/shared/alm/al-outbound-control-admission.test.ts
+++ b/packages/tests/shared/alm/al-outbound-control-admission.test.ts
@@ -540,6 +540,7 @@ describe('outbound control admission identity', () => {
                 kind: 'not-yet-in-sync-exhausted',
                 msgId: 'message',
                 carrier: 'rtc',
+                lane: 'durable',
                 atMs: expect.any(Number),
                 detail: 'The not-yet-in-sync retry budget of 2 ran out.'
             }]);
diff --git a/packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts b/packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts
index 66b218a7c..a0b1ba2ac 100644
--- a/packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts
+++ b/packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts
@@ -81,6 +81,7 @@ describe('a WS relay rejection at the origin (R-S2c-ii-5)', () => {
             kind: 'relay-rejected',
             msgId: 'ordered-gapped',
             carrier: 'ws',
+            lane: 'durable',
             atMs: expect.any(Number),
             relayRejection: { relay: 'trusted-server', reason: 'resync-required' },
             detail: 'The server relay refused the message: resync-required.'
@@ -123,6 +124,7 @@ describe('a WS relay rejection at the origin (R-S2c-ii-5)', () => {
                 kind: 'relay-rejected',
                 msgId: 'unicast-to-outsider',
                 carrier: 'ws',
+                lane: 'durable',
                 atMs: expect.any(Number),
                 relayRejection: { relay: 'trusted-server', reason: 'unauthorized' },
                 detail: 'The server refused the message: unauthorized.'
@@ -186,6 +188,7 @@ describe('a WS relay rejection at the origin (R-S2c-ii-5)', () => {
             kind: 'receipt-exhausted',
             msgId: 'hop-to-outsider',
             carrier: 'ws',
+            lane: 'durable',
             atMs: expect.any(Number),
             mode: 'hop',
             confirmedPeerIds: [],
```

(e) The per-test fake (R-I2a-ii-45). `packages/tests/shared-web/data/rallar-data-test-runtime.ts`:

```diff
diff --git a/packages/tests/shared-web/data/rallar-data-test-runtime.ts b/packages/tests/shared-web/data/rallar-data-test-runtime.ts
index 0e8eaab1e..6b4245fc0 100644
--- a/packages/tests/shared-web/data/rallar-data-test-runtime.ts
+++ b/packages/tests/shared-web/data/rallar-data-test-runtime.ts
@@ -1,3 +1,5 @@
+import { afterEach, beforeEach, vi } from 'vitest';
+
 import type { RallarDataScope } from '@shared-web/browser/rallar-data.ts';
 
 export type Todo = Readonly<{
@@ -40,6 +42,26 @@ export class FakeBroadcastChannel {
     public static clear(): void {
         FakeBroadcastChannel.channels.clear();
     }
+
+    /** The name of every channel open now, once per name. */
+    public static openNames(): readonly string[] {
+        return Array.from(FakeBroadcastChannel.channels)
+            .filter(([, channels]) => channels.size > 0)
+            .map(([name]) => name);
+    }
+}
+
+/**
+ * Node's global `BroadcastChannel` is real: a file whose tests connect through the browser composition installs
+ * the fake for each test, so no unit test opens a real channel.
+ */
+export function installFakeBroadcastChannelPerTest(): void {
+    beforeEach(() => {
+        vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
+    });
+    afterEach(() => {
+        FakeBroadcastChannel.clear();
+    });
 }
 
 export async function waitFor(predicate: () => boolean): Promise<void> {
```

(f) The composition test: a connect through the facade opens its session channel on the installed fake, never on
Node's real `BroadcastChannel`, and the disconnect closes it
(`packages/tests/shared-web/composition/browser-facade-behavior.test.ts`; this diff also installs the fake for the
file, so Step 11's first row is already done):

```diff
diff --git a/packages/tests/shared-web/composition/browser-facade-behavior.test.ts b/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
index 9abe7c387..eecc93b8e 100644
--- a/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
+++ b/packages/tests/shared-web/composition/browser-facade-behavior.test.ts
@@ -10,6 +10,8 @@ import {
     vi
 } from 'vitest';
 
+import { FakeBroadcastChannel, installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
+
 type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
 type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
 type AuthModule = typeof import('@shared/api/auth.ts');
@@ -87,6 +89,8 @@ vi.mock(
     })
 );
 
+installFakeBroadcastChannelPerTest();
+
 beforeEach(() => {
     browserTransportRuntime.shutdown('test-reset');
     vi.clearAllMocks();
@@ -127,6 +131,22 @@ describe('browser facade transport ownership', () => {
     });
 });
 
+// Node's BroadcastChannel is real; the connect's session channel must open on the installed fake.
+describe('browser facade session channel', () => {
+    it('opens one session channel per connect on the fake and closes it on disconnect', async () => {
+        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
+        const facade = createRallarFacade();
+        onTestFinished(() => facade.disconnect());
+        const sessionChannels = () => FakeBroadcastChannel.openNames().filter((name) => name.startsWith('rallar-alm:'));
+
+        await facade.connect();
+        expect(sessionChannels()).toHaveLength(1);
+
+        await facade.disconnect();
+        expect(sessionChannels()).toEqual([]);
+    });
+});
+
 describe('browser facade setup without startup work', () => {
     it('configures defaults and honors explicitly disabled setup startup work', async () => {
         const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
```

- [ ] **Step 2: Let the inbound fixture share a database and give Task 3's claim test a channel.**

```diff
diff --git a/packages/tests/shared/alm/inbound-runtime-test-fixture.ts b/packages/tests/shared/alm/inbound-runtime-test-fixture.ts
index 88d1d5c2a..1dd9e7f23 100644
--- a/packages/tests/shared/alm/inbound-runtime-test-fixture.ts
+++ b/packages/tests/shared/alm/inbound-runtime-test-fixture.ts
@@ -75,6 +75,8 @@ export interface CreateInboundTestStoresInput {
     readonly storage: InboundTestStorage;
     /** The IndexedDB backend's observer; a memory store has no operations to observe. */
     readonly observer: IndexedDbOperationObserver;
+    /** A database another pair shares, as a second tab would; absent, the pair opens one of its own. */
+    readonly dbName?: string;
 }
 
 export interface InboundTestBackendStores {
@@ -88,7 +90,7 @@ export function createInboundTestBackendStores(input: CreateInboundTestStoresInp
         : new IndexedDbAdmissionBackend({
             schemaId: AL_ADMISSION_SCHEMA_ID,
             onStorageReset: () => {},
-            dbName: `${input.namespace}-${crypto.randomUUID()}`,
+            dbName: input.dbName ?? `${input.namespace}-${crypto.randomUUID()}`,
             storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
             nowMs: Date.now,
             newWriteToken: crypto.randomUUID.bind(crypto),
```

```diff
diff --git a/packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts b/packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts
index 732a0b375..fbf8928d5 100644
--- a/packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts
+++ b/packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts
@@ -1,6 +1,7 @@
 import { describe, expect, it, onTestFinished, vi } from 'vitest';
 
 import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
+import { BrowserALSessionChannel } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
 import type { ALBrowserLockOptions, ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
 import type { StateScope } from '@shared/api/state-types.ts';
 
@@ -96,7 +97,15 @@ describe('two connects of one session over one durable store', () => {
 });
 
 function openClaim(locks: ALBrowserLocks | undefined): BrowserALDurableWorkClaim {
-    const claim = new BrowserALDurableWorkClaim({ scope: SCOPE, sessionId: SESSION_ID, locks });
+    // No other tab hears this connect, so a waiting tab's row waits for the takeover these tests prove.
+    const sessionChannel = new BrowserALSessionChannel({
+        scope: SCOPE,
+        sessionId: SESSION_ID,
+        instanceId: crypto.randomUUID(),
+        openPort: () => undefined,
+        applySettlement: () => {}
+    });
+    const claim = new BrowserALDurableWorkClaim({ scope: SCOPE, sessionId: SESSION_ID, locks, sessionChannel });
     claim.request();
     onTestFinished(() => claim.release());
     return claim;
```

- [ ] **Step 3: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared-web/al-runtime/browser-al-session-channel.test.ts packages/tests/shared-web/al-runtime/browser-al-session-commit-wake.test.ts packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts
npx vitest run packages/tests/shared/alm/outbound-delivery-settlements.test.ts packages/tests/shared/alm/al-outbound-control-admission.test.ts packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts
npx vitest run packages/tests/shared-web/composition/browser-facade-behavior.test.ts
```

Expected (measured at Task 3's head): the first `Test Files  4 failed (4)`, `Tests  no tests`, each with
`Error: Cannot find package '@shared-web/browser/al-runtime/browser-al-session-channel.ts'`; the second
`Test Files  3 failed (3)`, `Tests  14 failed | 66 passed (80)` (the new stamp test and every `lane: 'durable'`
pin: `+ "lane": "durable"` is missing from the received settlement); the third `Tests  1 failed | 4 passed (5)`:
no `rallar-alm:` channel opens before Step 8 (`expected [] to have a length of 1 but got +0`). Measured on the assembled tree with Steps 4–8 applied and only the stamp left out, the
relay test's `relays no settlement of a volatile lane and none that no lane stated` fails too (the relay posts
the volatile settlement).

- [ ] **Step 4: Create `packages/shared-web/browser/al-runtime/browser-al-session-channel.ts`.**

<!-- dprint-ignore -->
```ts
import type { ALDeliverySettlement, ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALDurableWorkCommit } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import type { StateScope } from '@shared/api/state-types.ts';

export namespace BrowserALSessionChannel {
    /** The part of `BroadcastChannel` the session channel uses. */
    export interface Port {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage(message: Message): void;
        close(): void;
    }

    /** Undefined where the browser has no `BroadcastChannel`: the tab then reaches no other tab. */
    export type OpenPort = (name: string) => Port | undefined;

    export interface Input {
        readonly scope: StateScope;
        readonly sessionId: string;
        /** Distinct per channel object: a message carrying it is this object's own echo. */
        readonly instanceId: string;
        readonly openPort: OpenPort;
        /** This tab's own observers; they ignore a msgId this tab holds no handle for. */
        readonly applySettlement: ALDeliverySettlementSink;
    }

    export interface Envelope {
        readonly version: 1;
        readonly sessionKey: string;
        /** The posting channel object's, so it can recognise its own echo. */
        readonly instanceId: string;
    }

    export interface CommittedBody {
        readonly kind: 'committed';
        readonly workType: string;
        readonly rows: ALWorkCommittedRows;
    }

    export interface SettlementBody {
        readonly kind: 'settlement';
        readonly settlement: ALDeliverySettlement;
    }

    export type Body = CommittedBody | SettlementBody;

    export type Message = Envelope & Body;
}

/** The global `BroadcastChannel`, behind the same missing-API guard as the Rallar Data and CRDT channels. */
export function openBrowserALSessionChannelPort(name: string): BrowserALSessionChannel.Port | undefined {
    return typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(name);
}

/** Each part of the scope is URI-encoded, as the scope's database name is, so a colon cannot alias another scope. */
export function toBrowserALSessionKey(scope: StateScope, sessionId: string): string {
    return `${encodeURIComponent(scope.applicationId)}:${encodeURIComponent(scope.workspaceId)}:${sessionId}`;
}

/**
 * The tabs of one session and scope, for one connect: a commit a tab that does not own the session's
 * durable work announces to the lane of the same work type in the tab that does, and a settlement a tab
 * records for a message it holds no handle for, relayed to the tab that holds it.
 */
export class BrowserALSessionChannel {
    private readonly input: BrowserALSessionChannel.Input;
    private readonly sessionKey: string;
    private readonly port: BrowserALSessionChannel.Port | undefined;
    private readonly commitListeners = new Map<string, Set<(rows: ALWorkCommittedRows) => void>>();

    constructor(input: BrowserALSessionChannel.Input) {
        this.input = input;
        this.sessionKey = toBrowserALSessionKey(input.scope, input.sessionId);
        this.port = input.openPort(`rallar-alm:${this.sessionKey}`);
        if (this.port !== undefined) {
            this.port.onmessage = (event) => this.receive(event.data as Partial<BrowserALSessionChannel.Message>);
        }
    }

    announceCommit(commit: ALDurableWorkCommit): void {
        this.post({ kind: 'committed', workType: commit.workType, rows: commit.rows });
    }

    onForeignCommit(workType: string, listener: (rows: ALWorkCommittedRows) => void): () => void {
        const listeners = this.commitListeners.get(workType) ?? new Set();
        listeners.add(listener);
        this.commitListeners.set(workType, listeners);
        return () => {
            listeners.delete(listener);
        };
    }

    relaySettlement(settlement: ALDeliverySettlement): void {
        this.post({ kind: 'settlement', settlement });
    }

    close(): void {
        this.port?.close();
        this.commitListeners.clear();
    }

    private post(body: BrowserALSessionChannel.Body): void {
        this.port?.postMessage({ version: 1, sessionKey: this.sessionKey, instanceId: this.input.instanceId, ...body });
    }

    private receive(message: Partial<BrowserALSessionChannel.Message>): void {
        if (
            message.version !== 1 ||
            message.sessionKey !== this.sessionKey ||
            message.instanceId === this.input.instanceId
        ) {
            return;
        }
        if (message.kind === 'committed' && message.workType !== undefined && message.rows !== undefined) {
            for (const listener of this.commitListeners.get(message.workType) ?? []) {
                listener(message.rows);
            }
        }
        else if (message.kind === 'settlement' && message.settlement !== undefined) {
            this.input.applySettlement(message.settlement);
        }
    }
}
```

- [ ] **Step 5: Carry the commits on the channel in the claim.**

```diff
diff --git a/packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts b/packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts
index 29a99487f..434b7e8be 100644
--- a/packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts
+++ b/packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts
@@ -1,5 +1,7 @@
+import type { BrowserALSessionChannel } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
 import { toALDurableOwnerLockName, type ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
-import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
+import type { ALDurableWorkCommit, ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
+import type { ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
 import type { StateScope } from '@shared/api/state-types.ts';
 import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';
 import type { ObservableValue } from '@shared/cache/RepositoryInterfaces.ts';
@@ -10,6 +12,8 @@ export namespace BrowserALDurableWorkClaim {
         readonly sessionId: string;
         /** `undefined` where the Locks API is missing: every connect owns its session's durable work. */
         readonly locks: ALBrowserLocks | undefined;
+        /** The connect's channel to the session's other tabs, which carries the commits; closed on release. */
+        readonly sessionChannel: BrowserALSessionChannel;
     }
 }
 
@@ -33,6 +37,10 @@ export class BrowserALDurableWorkClaim implements ALDurableWorkOwnership {
         return this.ownedValue;
     }
 
+    get sessionChannel(): BrowserALSessionChannel {
+        return this.input.sessionChannel;
+    }
+
     /** Requests the owner lock once; its callback is the takeover. */
     request(): void {
         const { locks, scope, sessionId } = this.input;
@@ -48,16 +56,24 @@ export class BrowserALDurableWorkClaim implements ALDurableWorkOwnership {
     /** Ends the connect's claim: a request still waiting is abandoned, a held lock is released. */
     release(): void {
         this.lifetime.abort();
+        this.input.sessionChannel.close();
     }
 
     isOwned(): boolean {
         return this.ownedValue.peek() === true;
     }
 
-    announceCommit(): void {}
+    announceCommit(commit: ALDurableWorkCommit): void {
+        this.input.sessionChannel.announceCommit(commit);
+    }
 
-    onForeignCommit(): () => void {
-        return () => {};
+    /** Heard only while this connect owns the work, so a waiting tab never announces another's commit again. */
+    onForeignCommit(workType: string, listener: (rows: ALWorkCommittedRows) => void): () => void {
+        return this.input.sessionChannel.onForeignCommit(workType, (rows) => {
+            if (this.isOwned()) {
+                listener(rows);
+            }
+        });
     }
 
     private async holdUntilReleased(): Promise<void> {
```

- [ ] **Step 6: Relay a durable lane's settlement in the epoch sink.**

```diff
diff --git a/packages/shared-web/browser/connection/browser-delivery-settlements.ts b/packages/shared-web/browser/connection/browser-delivery-settlements.ts
index 712454817..0e460c160 100644
--- a/packages/shared-web/browser/connection/browser-delivery-settlements.ts
+++ b/packages/shared-web/browser/connection/browser-delivery-settlements.ts
@@ -1,4 +1,4 @@
-import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
+import type { ALDeliverySettlement, ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
 
 export namespace BrowserDeliverySettlements {
     export interface Carriers {
@@ -6,6 +6,17 @@ export namespace BrowserDeliverySettlements {
         readonly rtc: ALDeliverySettlementSink;
     }
 
+    /** This tab's observers of the settlements its carriers state. */
+    export interface Observers extends Carriers {
+        /** Whether this tab holds the handle of the message a settlement reports on. */
+        holds(msgId: string): boolean;
+    }
+
+    /** The session's other tabs, for one connect. */
+    export interface Relay {
+        relaySettlement(settlement: ALDeliverySettlement): void;
+    }
+
     export interface Epoch {
         readonly settlements: Carriers;
         isOpen(): boolean;
@@ -17,7 +28,17 @@ export namespace BrowserDeliverySettlements {
 export class BrowserDeliverySettlements {
     private current: BrowserDeliverySettlements.Epoch | undefined;
 
-    open(observers: BrowserDeliverySettlements.Carriers): BrowserDeliverySettlements.Epoch {
+    /**
+     * Another tab of the session may hold the handle of a durable message this tab's carriers settle: the
+     * owner tab dispatches every tab's durable sends, and any tab may admit the control that acknowledges
+     * one. A durable lane's settlement this tab holds no handle for is relayed once; the receiving tab
+     * records it through its own observers, never through an epoch, so it is not relayed again. A volatile
+     * lane's settlement stays in the tab that admitted the message, so none is relayed.
+     */
+    open(
+        observers: BrowserDeliverySettlements.Observers,
+        relay: BrowserDeliverySettlements.Relay
+    ): BrowserDeliverySettlements.Epoch {
         this.close();
         let open = true;
         const sink: ALDeliverySettlementSink = (event) => {
@@ -25,6 +46,9 @@ export class BrowserDeliverySettlements {
                 return;
             }
             observers[event.carrier](event);
+            if (event.lane === 'durable' && !observers.holds(event.msgId)) {
+                relay.relaySettlement(event);
+            }
         };
         const epoch: BrowserDeliverySettlements.Epoch = {
             settlements: { ws: sink, rtc: sink },
```

```diff
diff --git a/packages/shared-web/browser/messages/browser-session-deliveries.ts b/packages/shared-web/browser/messages/browser-session-deliveries.ts
index 01e9af8a1..83dd72018 100644
--- a/packages/shared-web/browser/messages/browser-session-deliveries.ts
+++ b/packages/shared-web/browser/messages/browser-session-deliveries.ts
@@ -10,6 +10,8 @@ import type { BrowserRallarDeliveryRegistry } from './browser-rallar-delivery-re
 /** Owns volatile delivery observation for the browser's shared authenticated session. */
 export class BrowserSessionDeliveries {
     readonly settle: ALDeliverySettlementSink;
+    /** What each connect's epoch reports to: both carriers settle here, and the epoch relays what this tab does not hold. */
+    readonly observers: BrowserDeliverySettlements.Observers;
     private sessionKey: string | undefined;
     private readonly deliveries: BrowserRallarDeliveryRegistry;
     private readonly transport: Pick<BrowserTransportRuntimePort, 'deliverySettlements' | 'readMiddleware'>;
@@ -21,6 +23,11 @@ export class BrowserSessionDeliveries {
         this.deliveries = deliveries;
         this.transport = transport;
         this.settle = (event) => deliveries.record(event);
+        this.observers = {
+            ws: this.settle,
+            rtc: this.settle,
+            holds: (msgId) => deliveries.getHandle(msgId) !== undefined
+        };
     }
 
     beginSession(session: AuthSession): void {
```

```diff
diff --git a/packages/shared-web/browser/session/session-connection-lifecycle.ts b/packages/shared-web/browser/session/session-connection-lifecycle.ts
index 1a522712d..9a4cb629a 100644
--- a/packages/shared-web/browser/session/session-connection-lifecycle.ts
+++ b/packages/shared-web/browser/session/session-connection-lifecycle.ts
@@ -1,6 +1,9 @@
 import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
 import type { RallarConnectionRuntimePort } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
-import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
+import type {
+    BrowserTransportInitOptions,
+    BrowserTransportRuntimePort
+} from '@shared-web/browser/connection/browser-transport-runtime.ts';
 import type { MiddlewareInitOptions } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
 import type { RallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import type { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
@@ -33,7 +36,7 @@ export interface RallarSessionConnectionLifecycle {
 }
 
 interface PendingSessionConnection {
-    readonly middlewareOptions: MiddlewareInitOptions;
+    readonly middlewareOptions: BrowserTransportInitOptions;
     readonly generation: number;
 }
 
@@ -92,7 +95,7 @@ export class BrowserSessionConnectionLifecycle implements RallarSessionConnectio
             ...toMiddlewareOptions(input),
             qosProvider: this.input.qosProvider,
             readVolatileSessionLimits: this.input.readVolatileSessionLimits,
-            deliverySettlements: { ws: this.input.sessionDeliveries.settle, rtc: this.input.sessionDeliveries.settle }
+            deliverySettlements: this.input.sessionDeliveries.observers
         };
         const generation = this.connectionGeneration;
         this.lifecycleIsDisconnected = false;
```

- [ ] **Step 7: Stamp the lane that stated each settlement (R-I2a-ii-44, -48).** The settlement union keeps its
      variants and gains one optional field; the runtime stamps it beside `carrier` and `atMs`:

```diff
diff --git a/packages/shared/alm/delivery/al-delivery-lifecycle.ts b/packages/shared/alm/delivery/al-delivery-lifecycle.ts
index 2ea2cb647..a3c0e1e1b 100644
--- a/packages/shared/alm/delivery/al-delivery-lifecycle.ts
+++ b/packages/shared/alm/delivery/al-delivery-lifecycle.ts
@@ -1,5 +1,6 @@
 import type { ALAckMode } from '../../al-contracts/al-contract.ts';
 import type { ALAckAlgo, ALDurabilityAlgo, ALReceiptMode } from '../../al-contracts/al-policy.ts';
+import type { ALStoreDurability } from '../al-runtime-stores.ts';
 import type { ALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
 import type { ALDeliveryFailure, ALDeliveryReceiptExhaustion } from './al-delivery-failure.ts';
 
@@ -93,7 +94,8 @@ export type ALDeliveryAdmissionVerdict =
     | (Readonly<{ kind: 'storage-unavailable'; }> & ALStorageUnavailable)
     | Readonly<{ kind: 'failed'; detail: string; }>;
 
-export type ALDeliverySettlement =
+/** What one settlement states, before the outbound runtime stamps the lane that stated it. */
+type ALDeliverySettlementStatement =
     | Readonly<{
         kind: 'admission';
         msgId: string;
@@ -228,6 +230,16 @@ export type ALDeliverySettlement =
     }>
     | Readonly<{ kind: 'cancelled'; msgId: string; carrier: ALDeliveryCarrier; atMs: number; }>;
 
+export type ALDeliverySettlement =
+    & ALDeliverySettlementStatement
+    & Readonly<{
+        /**
+         * The outbound lane that stated it. Absent on a settlement no lane stated: the browser sender's own
+         * admission, refusal and fallback facts, and a cancel the runtime states for its whole lifetime.
+         */
+        lane?: ALStoreDurability;
+    }>;
+
 export type ALDeliverySettlementSink = (settlement: ALDeliverySettlement) => void;
 
 export interface ALDeliveryAttempt {
diff --git a/packages/shared/alm/outbound/al-outbound-message-runtime.ts b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
index 6eaffd469..e2538c03d 100644
--- a/packages/shared/alm/outbound/al-outbound-message-runtime.ts
+++ b/packages/shared/alm/outbound/al-outbound-message-runtime.ts
@@ -284,9 +284,9 @@ export type ALOutboundRuntimeDiagnosticsSink = (
     event: ALOutboundRuntimeDiagnosticsEvent
 ) => void;
 
-/** Every settlement variant without the two fields the runtime stamps for its owners. */
+/** Every settlement variant without the three fields the runtime stamps for its owners. */
 type ALOutboundUnstampedSettlement<TSettlement> = TSettlement extends ALDeliverySettlement ?
-    Omit<TSettlement, 'carrier' | 'atMs'> :
+    Omit<TSettlement, 'carrier' | 'atMs' | 'lane'> :
     never;
 
 /** One delivery fact as the owner that observed it states it, before the runtime stamps it. */
@@ -429,7 +429,6 @@ export class ALOutboundMessageRuntime<TPrepared> {
 
     constructor(dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>) {
         this.dependencies = dependencies;
-        const settlements: ALOutboundSettlementEmitter = (fact) => this.emitSettlement(fact);
         this.durable = new ALOutboundStoreLane({
             lane: 'durable',
             stores: dependencies,
@@ -444,7 +443,7 @@ export class ALOutboundMessageRuntime<TPrepared> {
             }),
             runtime: dependencies,
             sendControls: this.sendControls,
-            settlements
+            settlements: (fact) => this.emitSettlement(fact, 'durable')
         });
         this.volatile = dependencies.volatileStores === undefined ? undefined : new ALOutboundStoreLane({
             lane: 'volatile',
@@ -457,7 +456,7 @@ export class ALOutboundMessageRuntime<TPrepared> {
             canonicalHandoff: undefined,
             runtime: dependencies,
             sendControls: this.sendControls,
-            settlements
+            settlements: (fact) => this.emitSettlement(fact, 'volatile')
         });
     }
 
@@ -487,7 +486,7 @@ export class ALOutboundMessageRuntime<TPrepared> {
     cancel(msgId: string): ALOutboundCancelOutcome {
         const outcome = this.sendControls.cancel(msgId);
         if (outcome === 'cancelled') {
-            this.emitSettlement({ kind: 'cancelled', msgId });
+            this.emitSettlement({ kind: 'cancelled', msgId }, undefined);
         }
         return outcome;
     }
@@ -678,13 +677,17 @@ export class ALOutboundMessageRuntime<TPrepared> {
         };
     }
 
-    /** The one guard over every settlement this owner states: a throwing sink changes no work. */
-    private emitSettlement(fact: ALOutboundSettlementFact): void {
+    /**
+     * The one guard over every settlement this owner states: a throwing sink changes no work. `lane` is the
+     * lane that stated it; a cancel is the runtime's own, for every lane, and names none.
+     */
+    private emitSettlement(fact: ALOutboundSettlementFact, lane: ALStoreDurability | undefined): void {
         try {
             this.dependencies.settlements?.({
                 ...fact,
                 carrier: this.dependencies.carrier,
-                atMs: this.dependencies.clock.nowMs()
+                atMs: this.dependencies.clock.nowMs(),
+                ...(lane === undefined ? {} : { lane })
             });
         }
         catch (error) {
```

- [ ] **Step 8: Open the channel with the claim and hand it to the epoch.**

```diff
diff --git a/packages/shared-web/browser/connection/browser-transport-runtime.ts b/packages/shared-web/browser/connection/browser-transport-runtime.ts
index 5101b44b8..c4e981856 100644
--- a/packages/shared-web/browser/connection/browser-transport-runtime.ts
+++ b/packages/shared-web/browser/connection/browser-transport-runtime.ts
@@ -1,4 +1,8 @@
 import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
+import {
+    BrowserALSessionChannel,
+    openBrowserALSessionChannelPort
+} from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
 import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
 import {
@@ -13,23 +17,40 @@ import { readSession } from '@shared/api/auth.ts';
 
 import { BrowserDeliverySettlements } from './browser-delivery-settlements.ts';
 
+/** The middleware's options with this tab's delivery observers, which the transport fences per connect. */
+export interface BrowserTransportInitOptions extends Omit<MiddlewareInitOptions, 'deliverySettlements'> {
+    readonly deliverySettlements: BrowserDeliverySettlements.Observers;
+}
+
 export interface BrowserTransportRuntimePort {
     readonly deliverySettlements: BrowserDeliverySettlements;
     readMiddleware(): ApiMiddleware | undefined;
     requireMiddleware(): ApiMiddleware;
     isReady(): boolean;
     isInitializing(): boolean;
-    init(options: MiddlewareInitOptions): Promise<ApiMiddleware>;
+    init(options: BrowserTransportInitOptions): Promise<ApiMiddleware>;
     shutdown(reason?: string): void;
 }
 
+export namespace BrowserTransportRuntime {
+    export interface Input {
+        /** Opens each connect's session channel to the session's other tabs. */
+        readonly openSessionChannelPort: BrowserALSessionChannel.OpenPort;
+    }
+}
+
 export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
     readonly deliverySettlements = new BrowserDeliverySettlements();
+    private readonly input: BrowserTransportRuntime.Input;
     private activeMiddleware: ApiMiddleware | undefined;
     private activeDurableWork: BrowserALDurableWorkClaim | undefined;
     private pendingMiddleware: Promise<ApiMiddleware> | undefined;
     private generation = 0;
 
+    constructor(input: BrowserTransportRuntime.Input) {
+        this.input = input;
+    }
+
     public readMiddleware(): ApiMiddleware | undefined {
         return this.activeMiddleware;
     }
@@ -51,7 +72,7 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
         return this.pendingMiddleware !== undefined;
     }
 
-    public init(options: MiddlewareInitOptions): Promise<ApiMiddleware> {
+    public init(options: BrowserTransportInitOptions): Promise<ApiMiddleware> {
         if (this.activeMiddleware) {
             return Promise.resolve(this.activeMiddleware);
         }
@@ -66,8 +87,8 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
             return Promise.reject(new Error('Cannot init middleware: no auth session.'));
         }
 
-        const epoch = this.deliverySettlements.open(options.deliverySettlements);
         const durableWork = this.claimDurableWork(session, options);
+        const epoch = this.deliverySettlements.open(options.deliverySettlements, durableWork.sessionChannel);
         const pendingMiddleware = this.createMiddleware(session, {
             ...options,
             deliverySettlements: epoch.settlements,
@@ -119,12 +140,21 @@ export class BrowserTransportRuntime implements BrowserTransportRuntimePort {
         durableWork?.release();
     }
 
-    /** Requested once per connect, in the connect's scope; held until the connect ends. */
-    private claimDurableWork(session: AuthSession, options: MiddlewareInitOptions): BrowserALDurableWorkClaim {
+    /** Requested once per connect, in the connect's scope; held, with the connect's session channel, until the connect ends. */
+    private claimDurableWork(session: AuthSession, options: BrowserTransportInitOptions): BrowserALDurableWorkClaim {
+        const scope = options.scope ?? defaultStateScope();
+        const observers = options.deliverySettlements;
         const durableWork = new BrowserALDurableWorkClaim({
-            scope: options.scope ?? defaultStateScope(),
+            scope,
             sessionId: session.sessionId,
-            locks: readALBrowserLocks()
+            locks: readALBrowserLocks(),
+            sessionChannel: new BrowserALSessionChannel({
+                scope,
+                sessionId: session.sessionId,
+                instanceId: crypto.randomUUID(),
+                openPort: this.input.openSessionChannelPort,
+                applySettlement: (settlement) => observers[settlement.carrier](settlement)
+            })
         });
         durableWork.request();
         return durableWork;
@@ -173,4 +203,6 @@ function runShutdownStep(step: () => void): void {
     }
 }
 
-export const browserTransportRuntime = new BrowserTransportRuntime();
+export const browserTransportRuntime = new BrowserTransportRuntime({
+    openSessionChannelPort: openBrowserALSessionChannelPort
+});
```

- [ ] **Step 9: Run the focused tests green.**

```sh
npx vitest run packages/tests/shared-web/al-runtime/browser-al-session-channel.test.ts packages/tests/shared-web/al-runtime/browser-al-session-commit-wake.test.ts packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts
```

Then the lane and the fake:

```sh
npx vitest run packages/tests/shared/alm/outbound-delivery-settlements.test.ts packages/tests/shared/alm/al-outbound-control-admission.test.ts packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts packages/tests/shared-web/composition/browser-facade-behavior.test.ts
```

Expected (measured on the assembled tree): `Test Files  4 passed (4)`, `Tests  22 passed (22)` for the first
run; `Test Files  4 passed (4)`, `Tests  85 passed (85)` for the second (`browser-facade-behavior` `Tests  5 passed (5)`; with its
`installFakeBroadcastChannelPerTest()` line removed the new test fails `expected [] to have a length of 1 but
got +0`: the connect opened a real channel). Mutation checks run on the prototype:
without the claim's `isOwned()` gate in `onForeignCommit`, two waiting tabs re-announce each other's commit
until the Vitest worker dies of heap exhaustion (the bystander test); with `announceCommit` a no-op, all
three commit-wake tests fail at their 1 s wait; with the inbound lane's foreign commit taking no head read,
the inbound test fails (its owner's rotation has moved to RETRY).

- [ ] **Step 10: Update the tests the new signatures reach (mechanical).** `open(observers, relay)` needs
      `sessionDeliveries.observers` and a relay (a single-tab test passes `{ relaySettlement: () => {} }`);
      `new BrowserTransportRuntime(...)` needs its port factory (a test passes `() => undefined`, the no-API
      path); an `init` options literal needs `holds`; a test that types its mocked `initialiseMiddleware` with
      `BrowserTransportRuntimePort['init']` types it with the middleware's own options instead; Task 3's
      middleware test gives its claim a channel.

```diff
diff --git a/packages/tests/shared-web/composition/browser-facade-runtime-state.test.ts b/packages/tests/shared-web/composition/browser-facade-runtime-state.test.ts
index 707cf4bdb..5655ecc2d 100644
--- a/packages/tests/shared-web/composition/browser-facade-runtime-state.test.ts
+++ b/packages/tests/shared-web/composition/browser-facade-runtime-state.test.ts
@@ -19,7 +19,7 @@ describe('Browser facade runtime state', () => {
         const lanes: readonly RtcDataChannelLaneConfig[] = [
             { id: 'motion', label: 'rtc-motion' }
         ];
-        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
+        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
 
         context.setDefaults({
             applicationId: 'app-1',
@@ -90,8 +90,8 @@ describe('Browser facade runtime state', () => {
     });
 
     it('keeps current room and connection state isolated per context', () => {
-        const first = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
-        const second = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
+        const first = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
+        const second = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
 
         first.setCurrentRoom(createGroupSnapshot('room-1'));
         first.setConnectState('connected');
@@ -110,7 +110,7 @@ describe('Browser facade runtime state', () => {
     });
 
     it('reports missing middleware through its transport runtime', () => {
-        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
+        const context = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
 
         expect(context.readMiddleware()).toBeUndefined();
         expect(() => context.requireMiddleware()).toThrow(
diff --git a/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts b/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts
index d5bd8fc60..cfb2c36bc 100644
--- a/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts
+++ b/packages/tests/shared-web/connection/browser-transport-cleanup.test.ts
@@ -1,7 +1,9 @@
 import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
-import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
-import type { MiddlewareInitOptions } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
+import {
+    BrowserTransportRuntime,
+    type BrowserTransportInitOptions
+} from '@shared-web/browser/connection/browser-transport-runtime.ts';
 import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
 import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
 import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
@@ -43,7 +45,7 @@ describe('Browser transport cleanup', () => {
         });
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
         const lifecycle = createRallarLifecycleCoordinator();
@@ -93,7 +95,7 @@ describe('Browser transport cleanup', () => {
         });
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
         const lifecycle = createRallarLifecycleCoordinator();
@@ -146,7 +148,7 @@ describe('Browser transport cleanup', () => {
         });
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
         const lifecycle = createRallarLifecycleCoordinator();
@@ -209,7 +211,7 @@ describe('Browser transport cleanup', () => {
             });
         });
         mocks.readSession.mockReturnValue(first.session);
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
         const connection = new BrowserSessionConnectionLifecycle({
@@ -265,14 +267,14 @@ describe('Browser transport cleanup', () => {
                 resolveMiddleware = resolve;
             })
         );
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
 
         const pending = transportRuntime.init({
             qosProvider: undefined,
             readVolatileSessionLimits: undefined,
             diagnosticsPorts: toRallarDiagnosticsPorts(undefined),
-            deliverySettlements: { ws: () => {}, rtc: () => {} }
+            deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false }
         });
         transportRuntime.shutdown();
         resolveMiddleware?.(middleware.middleware);
@@ -328,7 +330,7 @@ describe('Browser transport cleanup', () => {
 
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
         const lifecycle = createRallarLifecycleCoordinator();
@@ -391,7 +393,7 @@ describe('Browser transport cleanup', () => {
                 resolveMiddleware = resolve;
             })
         );
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const runtime = new BrowserFacadeRuntimeState(transportRuntime);
         const lifecycle = createRallarLifecycleCoordinator();
@@ -450,7 +452,7 @@ describe('the session volatile limits seam', () => {
         const middleware = createDefaultApiMiddlewareTestDouble();
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
         const readVolatileSessionLimits = () => ({ maxAdmissions: 3, maxBytes: 4_096 });
         const connection = new BrowserSessionConnectionLifecycle({
@@ -476,7 +478,7 @@ describe('the session\'s durable work claim', () => {
         const middleware = createDefaultApiMiddlewareTestDouble();
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
 
         await transportRuntime.init(toInitOptions());
@@ -496,7 +498,7 @@ describe('the session\'s durable work claim', () => {
         const middleware = createDefaultApiMiddlewareTestDouble();
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockRejectedValue(new Error('network unavailable'));
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
 
         await expect(transportRuntime.init(toInitOptions())).rejects.toThrow('network unavailable');
 
@@ -512,7 +514,7 @@ describe('the session\'s durable work claim', () => {
         const middleware = createDefaultApiMiddlewareTestDouble();
         mocks.readSession.mockReturnValue(middleware.session);
         mocks.initialiseMiddleware.mockResolvedValue(middleware.middleware);
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         onTestFinished(() => transportRuntime.shutdown());
 
         await transportRuntime.init(toInitOptions());
@@ -542,11 +544,11 @@ function stubGrantedWebLocks(): { readonly names: readonly string[]; heldCount()
     return { names, heldCount: () => held };
 }
 
-function toInitOptions(): MiddlewareInitOptions {
+function toInitOptions(): BrowserTransportInitOptions {
     return {
         qosProvider: undefined,
         readVolatileSessionLimits: undefined,
-        deliverySettlements: { ws: () => {}, rtc: () => {} },
+        deliverySettlements: { ws: () => {}, rtc: () => {}, holds: () => false },
         diagnosticsPorts: toRallarDiagnosticsPorts(undefined)
     };
 }
diff --git a/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts b/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
index e09dade29..00f72fc07 100644
--- a/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
+++ b/packages/tests/shared-web/connection/initialise-browser-middleware.test.ts
@@ -2,6 +2,7 @@ import { describe, expect, it, onTestFinished } from 'vitest';
 
 import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
 import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
+import { BrowserALSessionChannel } from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
 import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
 import {
     createBrowserTransportInput,
@@ -34,7 +35,14 @@ const OPTIONS: BrowserConnectOptions = {
     durableWorkOwnership: new BrowserALDurableWorkClaim({
         scope: defaultStateScope(),
         sessionId: SESSION.sessionId,
-        locks: undefined
+        locks: undefined,
+        sessionChannel: new BrowserALSessionChannel({
+            scope: defaultStateScope(),
+            sessionId: SESSION.sessionId,
+            instanceId: 'session-channel',
+            openPort: () => undefined,
+            applySettlement: () => {}
+        })
     })
 };
 
diff --git a/packages/tests/shared-web/messages/browser-delivery-observation.test.ts b/packages/tests/shared-web/messages/browser-delivery-observation.test.ts
index 198e5c59c..86ee04e87 100644
--- a/packages/tests/shared-web/messages/browser-delivery-observation.test.ts
+++ b/packages/tests/shared-web/messages/browser-delivery-observation.test.ts
@@ -15,9 +15,9 @@ describe('browser session delivery observation', () => {
         const fixture = createObservation();
         const handle = fixture.registry.open(createMessage('retained'), 'ws');
         const waiting = handle.wait();
-        const oldEpoch = fixture.feed.open({ ws: fixture.owner.settle, rtc: fixture.owner.settle });
+        const oldEpoch = fixture.feed.open(fixture.owner.observers, { relaySettlement: () => {} });
         fixture.feed.close();
-        const nextEpoch = fixture.feed.open({ ws: fixture.owner.settle, rtc: fixture.owner.settle });
+        const nextEpoch = fixture.feed.open(fixture.owner.observers, { relaySettlement: () => {} });
         oldEpoch.settlements.ws({ kind: 'cancelled', msgId: handle.msgId, carrier: 'ws', atMs: 0 });
         expect(handle.lifecycle().state).toBe('submitted');
         nextEpoch.settlements.ws({
diff --git a/packages/tests/shared-web/messages/browser-message-carrier-gap-hand-over.test.ts b/packages/tests/shared-web/messages/browser-message-carrier-gap-hand-over.test.ts
index 24fbbd798..af2354f43 100644
--- a/packages/tests/shared-web/messages/browser-message-carrier-gap-hand-over.test.ts
+++ b/packages/tests/shared-web/messages/browser-message-carrier-gap-hand-over.test.ts
@@ -127,7 +127,7 @@ function createCarrierGapFixture(gap: CarrierGap): CarrierGapFixture {
         readMiddleware: () => context
     });
     sessionDeliveries.beginSession(context.session);
-    feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
+    feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
     const dispatch = new BrowserRallarMessageDispatch({
         deliveries,
         sessionDeliveries,
diff --git a/packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts b/packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts
index 3e9279f38..730ae63b2 100644
--- a/packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts
+++ b/packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts
@@ -91,7 +91,7 @@ function createFallbackFixture(
         readMiddleware: () => context
     });
     sessionDeliveries.beginSession(context.session);
-    const epoch = feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
+    const epoch = feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
     const dispatch = new BrowserRallarMessageDispatch({
         deliveries,
         sessionDeliveries,
diff --git a/packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts b/packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts
index eb957f25e..d6b1aa96e 100644
--- a/packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts
+++ b/packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts
@@ -367,7 +367,7 @@ function createChannel(input: ChannelInput): ChannelFixture {
     const feed = new BrowserDeliverySettlements();
     const sessionDeliveries = new BrowserSessionDeliveries(deliveries, { deliverySettlements: feed, readMiddleware: () => context });
     sessionDeliveries.beginSession(context.session);
-    const epoch = feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
+    const epoch = feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
     const sender = new BrowserRallarMessageSender({
         creation: {
             createUnicast: newALUnicastMessage,
diff --git a/packages/tests/shared-web/messages/browser-message-sender-fixture.ts b/packages/tests/shared-web/messages/browser-message-sender-fixture.ts
index 38872f6e1..089dc65f7 100644
--- a/packages/tests/shared-web/messages/browser-message-sender-fixture.ts
+++ b/packages/tests/shared-web/messages/browser-message-sender-fixture.ts
@@ -29,7 +29,7 @@ export function createBrowserMessageSenderFixture(
     const feed = new BrowserDeliverySettlements();
     const sessionDeliveries = new BrowserSessionDeliveries(registry, { deliverySettlements: feed, readMiddleware: () => activeMiddleware });
     sessionDeliveries.beginSession(middleware.session);
-    feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
+    feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
     const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
     const connect = vi.fn<() => Promise<ApiMiddleware>>().mockResolvedValue(middleware);
     const sender = new BrowserRallarMessageSender({
@@ -58,7 +58,7 @@ export function createBrowserMessageSenderFixture(
         replaceTransport: () => {
             activeMiddleware = createDefaultApiMiddlewareTestDouble();
             feed.close();
-            feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
+            feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
         }
     };
 }
diff --git a/packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts b/packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts
index eddbd7745..81a38f86a 100644
--- a/packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts
+++ b/packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts
@@ -260,7 +260,7 @@ function createDispatchHarness(
     const feed = new BrowserDeliverySettlements();
     const sessionDeliveries = new BrowserSessionDeliveries(registry, { deliverySettlements: feed, readMiddleware: () => middleware });
     sessionDeliveries.beginSession(middleware.session);
-    feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
+    feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
     const dispatch = new BrowserRallarMessageDispatch({ deliveries: registry, sessionDeliveries, nowMs: Date.now });
     const canFallback = admits.ws !== undefined && admits.rtc !== undefined;
     return {
diff --git a/packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts b/packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts
index 589f4a5a0..bf6aa22c7 100644
--- a/packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts
+++ b/packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts
@@ -425,7 +425,7 @@ function createPeerFallbackFixture(rtcVerdict: ALDeliveryAdmissionVerdict): Peer
         readMiddleware: () => context
     });
     sessionDeliveries.beginSession(context.session);
-    const epoch = feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
+    const epoch = feed.open(sessionDeliveries.observers, { relaySettlement: () => {} });
     const sender = new BrowserRallarMessageSender({
         creation: {
             createUnicast: newALUnicastMessage,
diff --git a/packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts b/packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts
index b196e6826..23b1b07d5 100644
--- a/packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts
+++ b/packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts
@@ -1,5 +1,5 @@
-import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
 import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
+import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
 import type * as AuthModule from '@shared/api/auth.ts';
 import type * as ClientStateSnapshotsRepositoryModule from '@shared/repository/client-state-snapshots-repository.ts';
@@ -19,7 +19,7 @@ const mocks = await vi.hoisted(async () => {
     return {
         ctx,
         hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(async () => {}),
-        initialiseApiMiddleware: vi.fn<BrowserTransportRuntimePort['init']>(async () => ctx),
+        initialiseApiMiddleware: vi.fn<(options: MiddlewareModule.MiddlewareInitOptions) => Promise<ApiMiddleware>>(async () => ctx),
         onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
         readSession: vi.fn<typeof AuthModule.readSession>(() => ctx.session),
         findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(),
diff --git a/packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts b/packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts
index 7ff34b938..714526dd3 100644
--- a/packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts
+++ b/packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts
@@ -7,8 +7,9 @@ import {
     vi
 } from 'vitest';
 
-import { browserTransportRuntime, type BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
+import { browserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
 import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
+import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type { RallarRealtimeHandler, RallarRealtimeMessage } from '@shared-web/browser/rallar-realtime-facade.ts';
 import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
 import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
@@ -28,7 +29,7 @@ const mocks = await vi.hoisted(async () => {
         context,
         findAcceptedOverlayById: vi.fn<typeof OverlaysRepositoryModule.findAcceptedOverlayById>(),
         hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(async () => {}),
-        initialiseApiMiddleware: vi.fn<BrowserTransportRuntimePort['init']>(async () => context),
+        initialiseApiMiddleware: vi.fn<(options: MiddlewareModule.MiddlewareInitOptions) => Promise<ApiMiddleware>>(async () => context),
         onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
         readSession: vi.fn<typeof AuthModule.readSession>(() => context.session),
         findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(),
diff --git a/packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts b/packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts
index 4edc03e96..4cd105a4e 100644
--- a/packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts
+++ b/packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts
@@ -7,8 +7,9 @@ import {
     vi
 } from 'vitest';
 
-import { browserTransportRuntime, type BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
+import { browserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
 import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
+import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
 import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
 import type * as AuthModule from '@shared/api/auth.ts';
@@ -27,7 +28,7 @@ const mocks = await vi.hoisted(async () => {
         context,
         findAcceptedOverlayById: vi.fn<typeof OverlaysRepositoryModule.findAcceptedOverlayById>(),
         hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(async () => {}),
-        initialiseApiMiddleware: vi.fn<BrowserTransportRuntimePort['init']>(async () => context),
+        initialiseApiMiddleware: vi.fn<(options: MiddlewareModule.MiddlewareInitOptions) => Promise<ApiMiddleware>>(async () => context),
         onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
         readSession: vi.fn<typeof AuthModule.readSession>(() => context.session),
         findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(),
diff --git a/packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts b/packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts
index 93b061d17..33df51570 100644
--- a/packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts
+++ b/packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts
@@ -7,8 +7,9 @@ import {
     vi
 } from 'vitest';
 
-import { browserTransportRuntime, type BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
+import { browserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
 import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
+import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type * as StateCacheLifecycleModule from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
 import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
 import type * as AuthModule from '@shared/api/auth.ts';
@@ -27,7 +28,7 @@ const mocks = await vi.hoisted(async () => {
         context,
         findAcceptedOverlayById: vi.fn<typeof OverlaysRepositoryModule.findAcceptedOverlayById>(),
         hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(async () => {}),
-        initialiseApiMiddleware: vi.fn<BrowserTransportRuntimePort['init']>(async () => context),
+        initialiseApiMiddleware: vi.fn<(options: MiddlewareModule.MiddlewareInitOptions) => Promise<ApiMiddleware>>(async () => context),
         onCacheChange: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.onChange>(() => vi.fn()),
         readSession: vi.fn<typeof AuthModule.readSession>(() => context.session),
         findClientStateSnapshotByPrincipalId: vi.fn<typeof ClientStateSnapshotsRepositoryModule.findClientStateSnapshotByPrincipalId>(),
diff --git a/packages/tests/shared-web/rooms/room-state-store-current-room.test.ts b/packages/tests/shared-web/rooms/room-state-store-current-room.test.ts
index 491f1ec4a..ded6bebdf 100644
--- a/packages/tests/shared-web/rooms/room-state-store-current-room.test.ts
+++ b/packages/tests/shared-web/rooms/room-state-store-current-room.test.ts
@@ -124,7 +124,7 @@ describe('room state store current-room projection', () => {
     });
 
     it('uses the highest-revision principal snapshot before accepting the default scope', () => {
-        const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
+        const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
         const current = createMemberRoomSnapshot();
         const lowerRevisionDefaultAlice = createClient('alice', 'Default Alice');
         const higherRevisionOtherScopeAlice = createClient('alice', 'Other Alice', {
@@ -177,7 +177,7 @@ describe('room state store current-room projection', () => {
     });
 
     it('preserves the selected current room when defaults move to another scope', () => {
-        const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
+        const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
         const current = createRoomSnapshot({ groupId: 'scope-a-room', displayName: 'Scope A Room' });
         const visible = createRoomSnapshot({
             groupId: 'scope-b-room',
@@ -209,7 +209,7 @@ describe('room state store current-room projection', () => {
     });
 
     it('selects the session room when the canonical current room ref is absent', () => {
-        const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
+        const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
         const sessionRoom = createRoomSnapshot({ groupId: 'session-room', displayName: 'Session Room' });
         stateMocks.groups.push(sessionRoom);
         stateMocks.repositoriesConfigured = true;
diff --git a/packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts b/packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts
index c91824180..bd826ab84 100644
--- a/packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts
+++ b/packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts
@@ -7,8 +7,8 @@ import {
 } from 'vitest';
 
 import type * as AuthApiModule from '@shared-web/browser/auth/session-http-api.ts';
-import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
 import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
+import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type { RallarRtcLifecycleEvent, RallarRtcStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
 import type * as RoomMutationWorkflowsModule from '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts';
 import type * as RoomGroupStateWorkflowsModule from '@shared-web/browser/rooms/room-group-state-workflows.ts';
@@ -47,7 +47,7 @@ const mocks = await vi.hoisted(async () => {
         webSocketClient: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
         clearSession: vi.fn<typeof AuthModule.clearSession>(),
         hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle['hydrate']>(() => Promise.resolve()),
-        initialiseApiMiddleware: vi.fn<BrowserTransportRuntimePort['init']>(() => Promise.resolve(ctx)),
+        initialiseApiMiddleware: vi.fn<(options: MiddlewareModule.MiddlewareInitOptions) => Promise<ApiMiddleware>>(() => Promise.resolve(ctx)),
         createAndJoinStateGroup: vi.fn<typeof RoomGroupStateWorkflowsModule.createAndJoinStateGroup>(
             () => Promise.reject(new Error('create not mocked'))
         ),
diff --git a/packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts b/packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts
index d5b0822b9..ed4398a37 100644
--- a/packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts
+++ b/packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts
@@ -1,5 +1,7 @@
 import { vi } from 'vitest';
 
+import type { MiddlewareInitOptions } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
+import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type { OverlayInfo } from '@shared/api/api-config.ts';
 import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
 import type { GroupSnapshot } from '@shared/api/group-types.ts';
@@ -42,7 +44,7 @@ const mocks = await vi.hoisted(async () => {
         webSocketClient: vi.mocked(ctx.middleware.webSocketQueueBox.socket),
         clearSession: vi.fn<ContractModules.Auth['clearSession']>(),
         hydrateStateCache: vi.fn<ContractModules.StateCacheLifecycle['browserStateCacheLifecycle']['hydrate']>(() => Promise.resolve()),
-        initialiseApiMiddleware: vi.fn<ContractModules.BrowserTransportRuntimePort['init']>(() => Promise.resolve(ctx)),
+        initialiseApiMiddleware: vi.fn<(options: MiddlewareInitOptions) => Promise<ApiMiddleware>>(() => Promise.resolve(ctx)),
         createAndJoinStateGroup: vi.fn<ContractModules.RoomGroupStateWorkflows['createAndJoinStateGroup']>(
             () => Promise.reject(new Error('create not mocked'))
         ),
diff --git a/packages/tests/shared-web/session/browser-auth-session-teardown-notification.test.ts b/packages/tests/shared-web/session/browser-auth-session-teardown-notification.test.ts
index 2639b40e6..dd7648af6 100644
--- a/packages/tests/shared-web/session/browser-auth-session-teardown-notification.test.ts
+++ b/packages/tests/shared-web/session/browser-auth-session-teardown-notification.test.ts
@@ -148,7 +148,7 @@ describe('Rallar auth session teardown notification', () => {
 });
 
 function createDefaultAuthFixture(emitState: () => void): AuthFixture {
-    const transportRuntime = new BrowserTransportRuntime();
+    const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
     const runtime = new BrowserFacadeRuntimeState(transportRuntime);
     onTestFinished(() => runtime.clearAuthExpiryTimer());
     const middleware = createDefaultApiMiddlewareTestDouble();
diff --git a/packages/tests/shared-web/session/session-connection-operations-server-peer.test.ts b/packages/tests/shared-web/session/session-connection-operations-server-peer.test.ts
index 8be0dcbf2..9999c208a 100644
--- a/packages/tests/shared-web/session/session-connection-operations-server-peer.test.ts
+++ b/packages/tests/shared-web/session/session-connection-operations-server-peer.test.ts
@@ -9,7 +9,7 @@ import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-dou
 
 describe('the WS server peer id on the connection operations (D57 as applied)', () => {
     it('reads the id the connected WS client learned, and nothing before a connection', () => {
-        const transportRuntime = new BrowserTransportRuntime();
+        const transportRuntime = new BrowserTransportRuntime({ openSessionChannelPort: () => undefined });
         const operations = createRallarSessionConnectionOperations({
             connectionRuntime: new BrowserFacadeRuntimeState(transportRuntime),
             transportRuntime,
diff --git a/packages/tests/shared-web/state-cache/rallar-state-store.test.ts b/packages/tests/shared-web/state-cache/rallar-state-store.test.ts
index 0c5717949..ece01e4c5 100644
--- a/packages/tests/shared-web/state-cache/rallar-state-store.test.ts
+++ b/packages/tests/shared-web/state-cache/rallar-state-store.test.ts
@@ -77,7 +77,7 @@ interface StateStoreFixture {
 function createStateStoreFixture(
     cacheOverrides: Partial<RallarStateCacheReadPort> = {}
 ): StateStoreFixture {
-    const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime());
+    const runtime = new BrowserFacadeRuntimeState(new BrowserTransportRuntime({ openSessionChannelPort: () => undefined }));
     const stateCache: RallarStateCacheReadPort = {
         ...createRallarStateCacheReadPort(),
         ...cacheOverrides
diff --git a/packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts b/packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts
index d3550ee6f..8eda401b9 100644
--- a/packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts
+++ b/packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts
@@ -7,8 +7,8 @@ import {
 } from 'vitest';
 
 import type * as AuthApiModule from '@shared-web/browser/auth/session-http-api.ts';
-import type { BrowserTransportRuntimePort } from '@shared-web/browser/connection/browser-transport-runtime.ts';
 import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
+import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
 import type { RallarWsLifecycleEvent, RallarWsStatus } from '@shared-web/browser/rallar-realtime-facade.ts';
 import type * as RoomMutationWorkflowsModule from '@shared-web/browser/rooms/room-group-state-mutation-workflows.ts';
 import type * as RoomGroupStateWorkflowsModule from '@shared-web/browser/rooms/room-group-state-workflows.ts';
@@ -60,7 +60,7 @@ const mocks = await vi.hoisted(async () => {
         hydrateStateCache: vi.fn<typeof StateCacheLifecycleModule.browserStateCacheLifecycle.hydrate>(
             () => Promise.resolve()
         ),
-        initialiseApiMiddleware: vi.fn<BrowserTransportRuntimePort['init']>(() => Promise.resolve(ctx)),
+        initialiseApiMiddleware: vi.fn<(options: MiddlewareModule.MiddlewareInitOptions) => Promise<ApiMiddleware>>(() => Promise.resolve(ctx)),
         joinStateGroup: vi.fn<typeof RoomGroupStateWorkflowsModule.joinStateGroup>(() => Promise.reject(new Error('join not mocked'))),
         leaveStateGroup: vi.fn<typeof RoomGroupStateWorkflowsModule.leaveStateGroup>(() => Promise.reject(new Error('leave not mocked'))),
         listStateClientEventPage: vi.fn<typeof StateEventHttpApiModule.listStateClientEventPage>(() =>
```

- [ ] **Step 11: Install the fake channel in every test file that connects through the composition
      (R-I2a-ii-45, -49).** The transport runtime singleton opens each connect's channel through
      `openBrowserALSessionChannelPort`, which reaches Node's real global `BroadcastChannel`. Measured on the
      assembled tree by instrumenting that factory over the whole unit project: 205 real channels in exactly these
      33 files, all under `packages/tests/shared-web/`, none elsewhere. In each, import the helper beside the file's
      other relative imports (dprint orders them) and call it once at the top level, on its own line before the
      file's first top-level `describe`, `it`, `beforeEach` or `afterEach`:

<!-- dprint-ignore -->
```ts
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';

installFakeBroadcastChannelPerTest();
```

The specifier is `'../data/rallar-data-test-runtime.ts'` in 29 of the files; the table gives each file's own.

| File (under `packages/tests/shared-web/`)                 | Import specifier                           |
| --------------------------------------------------------- | ------------------------------------------ |
| `calls/rallar-calls.test.ts`                              | `'../data/rallar-data-test-runtime.ts'`    |
| `composition/browser-facade-behavior.test.ts`             | `'../data/rallar-data-test-runtime.ts'`    |
| `composition/browser-runtime-construction.test.ts`        | `'../data/rallar-data-test-runtime.ts'`    |
| `director/browser-director-relay-runtime.test.ts`         | `'../data/rallar-data-test-runtime.ts'`    |
| `media/browser-media-sources.test.ts`                     | `'../data/rallar-data-test-runtime.ts'`    |
| `messages/browser-rallar-message-sender.test.ts`          | `'../data/rallar-data-test-runtime.ts'`    |
| `messages/browser-typed-message-channels.test.ts`         | `'../data/rallar-data-test-runtime.ts'`    |
| `people/people-events.test.ts`                            | `'../data/rallar-data-test-runtime.ts'`    |
| `rallar-facade-defaults.test.ts`                          | `'./data/rallar-data-test-runtime.ts'`     |
| `rallar-startup-lifecycle.test.ts`                        | `'./data/rallar-data-test-runtime.ts'`     |
| `realtime/browser-realtime-json-lane.test.ts`             | `'../data/rallar-data-test-runtime.ts'`    |
| `realtime/browser-realtime-send-receive.test.ts`          | `'../data/rallar-data-test-runtime.ts'`    |
| `realtime/browser-room-realtime-runtime.test.ts`          | `'../data/rallar-data-test-runtime.ts'`    |
| `realtime/browser-targeted-realtime-runtime.test.ts`      | `'../data/rallar-data-test-runtime.ts'`    |
| `rooms/create-and-join-room.test.ts`                      | `'../data/rallar-data-test-runtime.ts'`    |
| `rooms/formation/create-room-formation.test.ts`           | `'../../data/rallar-data-test-runtime.ts'` |
| `rooms/formation/read-room-formation-view.test.ts`        | `'../../data/rallar-data-test-runtime.ts'` |
| `rooms/join-room.test.ts`                                 | `'../data/rallar-data-test-runtime.ts'`    |
| `rooms/leave-room.test.ts`                                | `'../data/rallar-data-test-runtime.ts'`    |
| `rooms/room-events-replay.test.ts`                        | `'../data/rallar-data-test-runtime.ts'`    |
| `rooms/room-events-subscription.test.ts`                  | `'../data/rallar-data-test-runtime.ts'`    |
| `rooms/room-membership.test.ts`                           | `'../data/rallar-data-test-runtime.ts'`    |
| `rooms/room-session.test.ts`                              | `'../data/rallar-data-test-runtime.ts'`    |
| `rooms/update-room.test.ts`                               | `'../data/rallar-data-test-runtime.ts'`    |
| `rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts` | `'../data/rallar-data-test-runtime.ts'`    |
| `rtc/browser-rtc-recovery-runtime.test.ts`                | `'../data/rallar-data-test-runtime.ts'`    |
| `rtc/browser-rtc-room-authority.test.ts`                  | `'../data/rallar-data-test-runtime.ts'`    |
| `rtc/browser-rtc-room-runtime.test.ts`                    | `'../data/rallar-data-test-runtime.ts'`    |
| `rtc/browser-rtc-wait-runtime.test.ts`                    | `'../data/rallar-data-test-runtime.ts'`    |
| `session/browser-auth-session-cleanup.test.ts`            | `'../data/rallar-data-test-runtime.ts'`    |
| `session/browser-auth-session-contract.test.ts`           | `'../data/rallar-data-test-runtime.ts'`    |
| `state-read/rtc-authority-recovery.test.ts`               | `'../data/rallar-data-test-runtime.ts'`    |
| `websocket/browser-rallar-ws-controller.test.ts`          | `'../data/rallar-data-test-runtime.ts'`    |

Two of the 33 as they land after `npx dprint fmt`:

```diff
diff --git a/packages/tests/shared-web/rooms/room-session.test.ts b/packages/tests/shared-web/rooms/room-session.test.ts
index ec65a72c9..179f46311 100644
--- a/packages/tests/shared-web/rooms/room-session.test.ts
+++ b/packages/tests/shared-web/rooms/room-session.test.ts
@@ -23,6 +23,7 @@ import {
 import { configureOverlayRepositories } from '@shared/repository/overlays-repository.ts';
 import { toError } from '@shared/resilience/to-error.ts';
 
+import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
 import {
     createRoomSnapshot,
     readRoomWorkflowMocks,
@@ -30,6 +31,8 @@ import {
     seedRoomSnapshots
 } from './room-workflow-test-runtime.ts';
 
+installFakeBroadcastChannelPerTest();
+
 beforeEach(() => {
     resetRoomWorkflowTestRuntime();
     configureOverlayRepositories({
diff --git a/packages/tests/shared-web/rtc/browser-rtc-room-runtime.test.ts b/packages/tests/shared-web/rtc/browser-rtc-room-runtime.test.ts
index 0fe308290..fe4671f68 100644
--- a/packages/tests/shared-web/rtc/browser-rtc-room-runtime.test.ts
+++ b/packages/tests/shared-web/rtc/browser-rtc-room-runtime.test.ts
@@ -7,6 +7,7 @@ import {
     type WebRtcConnectionService
 } from '@shared/services/web-rtc-connection-service.ts';
 
+import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
 import { createBrowserRtcPeerTestDouble } from './browser-rtc-peer-test-double.ts';
 import {
     createAcceptedOverlay,
@@ -44,6 +45,8 @@ function withPreviousAcceptedPresenceRevision(
     };
 }
 
+installFakeBroadcastChannelPerTest();
+
 describe('Rallar RTC room wait', () => {
     beforeEach(resetRtcWaitTestRuntime);
```

`composition/browser-facade-behavior.test.ts` already has both lines from Step 1(f) (it also imports
`FakeBroadcastChannel`); the other 32 need exactly these two lines, and the fake's `clear()` after each test keeps
channel state from leaking between tests.

- [ ] **Step 12: Raise the facade budget it crosses.**

```diff
diff --git a/packages/shared-web/bundle-budgets.json b/packages/shared-web/bundle-budgets.json
index afcbe583c..bbe7d0e68 100644
--- a/packages/shared-web/bundle-budgets.json
+++ b/packages/shared-web/bundle-budgets.json
@@ -1,5 +1,5 @@
 {
-  "browser/rallar.ts": 234,
+  "browser/rallar.ts": 235,
   "browser/rallar-core.ts": 100,
   "browser/rallar-realtime.ts": 100,
   "browser/rallar-data.ts": 20,
```

- [ ] **Step 13: Navigation maps and the two stale comments.**

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
index 222c99a39..ee3dbe151 100644
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -186,7 +186,9 @@ every session the page opens. The event's `data` is the event itself:
   one event for every storage read an owner spends deciding whether it has work,
   which is the read the page's `work-page` counter charges.
   `cause` is why the owner had no remembered answer to give -- `own-commit`,
-  `batch` and `retained-release` are this owner's own progress, `external-wake`
+  `batch` and `retained-release` are this owner's own progress (a commit
+  another browser tab of the session announced reaches the owning tab's lane
+  as that lane's own commit, so it reads `own-commit` there), `external-wake`
   is the announcement another writer made to every owner on the engine,
   `age-bound` is the memory reaching `AL_WORK_READINESS_MEMORY_MS`, and
   `no-memory` is an owner with no answer that has not probed yet, or whose last
diff --git a/packages/shared-web/browser/README.md b/packages/shared-web/browser/README.md
index d270fa87e..edeee4708 100644
--- a/packages/shared-web/browser/README.md
+++ b/packages/shared-web/browser/README.md
@@ -202,6 +202,19 @@ The browser transport storage and WebSocket owners are feature-colocated:
   takes over. Without the Locks API, or when the request fails, every connect
   owns its work as before. The WS client, the RTC overlay and the RTC receiver
   hand it to their durable lanes only.
+- [browser-al-session-channel.ts](./al-runtime/browser-al-session-channel.ts)
+  owns one `BroadcastChannel` per connect,
+  `rallar-alm:<applicationId>:<workspaceId>:<sessionId>` with the scope parts
+  URI-encoded, opened through the transport runtime's injected port factory
+  behind the same missing-API guard as the Rallar Data and CRDT channels. The
+  connect's durable work claim holds it and closes it on release. It carries
+  two messages, each filtered by version, session key and the posting
+  instance's echo: `committed`, the commit a waiting tab announced under a lane
+  work type, which the claim hands to its lane of that work type only while it
+  owns the work, so nothing is announced twice; and `settlement`, a durable
+  lane's settlement a tab recorded for a message it holds no handle for, recorded once
+  by the tab that holds it. Without `BroadcastChannel` a tab reaches no other
+  tab, and a waiting tab's row waits for the owner's age-bound probe.
 - [delete-ended-session-al-runtime-entries.ts](./session/delete-ended-session-al-runtime-entries.ts)
   purges an ended session's rows on logout, and a replaced session's rows after
   the disconnect on a login over it or a session switch in `connect`, when the
@@ -231,7 +244,13 @@ Message ownership is concentrated under [`messages/`](./messages/):
 - [BrowserRallarMessageSender](./messages/browser-rallar-message-sender.ts)
   owns RTC/WS envelope construction and scoped targets, returning a `RallarMessageHandle`
   immediately after submission. Consumers await admission with `handle.wait(...)` and inspect
-  its lifecycle; the delivery registry observes carrier settlements in memory.
+  its lifecycle; the delivery registry observes carrier settlements in memory. Each connect's
+  settlement epoch ([`BrowserDeliverySettlements`](./connection/browser-delivery-settlements.ts))
+  relays once, on the session channel, a durable lane's settlement for a msgId this tab holds no
+  handle for: the owner tab sends every tab's durable messages, and any tab may admit the
+  acknowledgement of one. A volatile lane's settlement, and one no lane stated, stays in its tab.
+  The receiving tab records it through its own observers, which ignore a msgId they never opened,
+  and never relays it again. A handle's `cancel()` reaches only its own tab's carriers.
 - [BrowserTypedMessageChannels](./messages/browser-typed-message-channels.ts)
   owns typed channels and the current RTC-with-WS and WS-then-RTC policies.
 - [BrowserRallarMessageSubscriptions](./messages/browser-rallar-message-subscriptions.ts)
diff --git a/packages/shared/alm/outbound/README.md b/packages/shared/alm/outbound/README.md
index 2bebf48b9..bb1a07e38 100644
--- a/packages/shared/alm/outbound/README.md
+++ b/packages/shared/alm/outbound/README.md
@@ -55,7 +55,10 @@ registers its task and runs the bootstrap batch once; that batch's first-batch r
 takeover's recovery outcome. A row the previous owner held is recovered by the lease sweep of a later
 batch, at its lease end plus at most 19.1 s, never sooner. The owner's lane hears every commit another
 runtime announced for its work type (`onForeignCommit`) and runs it through `applyForeignCommit(rows)`,
-the same `committed(rows)` its own commits take. The browser's value is the connect's
+the same `committed(rows)` its own commits take, so its batch claims the rows at once instead of at
+its remembered answer's age bound; in the browser the announcement travels on the connect's session
+channel ([`BrowserALSessionChannel`](../../../shared-web/browser/al-runtime/browser-al-session-channel.ts)),
+which the claim hands to its lanes only while it owns the work. The browser's value is the connect's
 [`BrowserALDurableWorkClaim`](../../../shared-web/browser/al-runtime/browser-al-durable-work-claim.ts),
 the second name on the lock port: `rallar:al-durable-owner:<applicationId>:<workspaceId>:<sessionId>`,
 requested once per connect, never per send, and held until the connect ends; without the Locks API
@@ -738,8 +741,9 @@ states nothing at all; see [Receipt ends and the hand-over](#receipt-ends-and-th
 
 Every settlement in this section is a per-message `ALOutboundSettlementFact` stated
 through this owner's [`ALOutboundSettlementEmitter`](./al-outbound-message-runtime.ts):
-the runtime's private `emitSettlement` stamps the fact with its own `carrier` and the
-current `atMs` into the `ALDeliverySettlement` the sink receives, and guards that call
+the runtime's private `emitSettlement` stamps the fact with its own `carrier`, the
+current `atMs` and the `lane` that stated it (`durable` or `volatile`; a runtime-wide
+`cancel` names none) into the `ALDeliverySettlement` the sink receives, and guards that call
 so a throwing sink logs and returns rather than changing dispatch, retry, or claim
 behaviour. The browser's sink for these settlements is the in-memory delivery registry,
 [`BrowserRallarDeliveryRegistry`](../../../shared-web/browser/messages/browser-rallar-delivery-registry.ts)
diff --git a/packages/shared/alm/work/al-work-handler.ts b/packages/shared/alm/work/al-work-handler.ts
index 3b89dabd3..1a9cb1cd8 100644
--- a/packages/shared/alm/work/al-work-handler.ts
+++ b/packages/shared/alm/work/al-work-handler.ts
@@ -129,8 +129,8 @@ export interface ALWorkReadinessProbeDiagnostics {
 
 /**
  * How long one probe's answer stands, counted from that probe whatever batches ran since. It is the
- * engine's own idle ceiling, derived from it so the two cannot drift apart: work another tab wrote,
- * or a row a crashed owner's lease still holds, is discovered on that idle cadence instead of
+ * engine's own idle ceiling, derived from it so the two cannot drift apart: work another tab wrote
+ * unannounced, or a row a crashed owner's lease still holds, is discovered on that idle cadence instead of
  * costing a storage read on every engine round.
  */
 export const AL_WORK_READINESS_MEMORY_MS = INBOX_OUTBOX_ENGINE_MAX_IDLE_MS;
@@ -197,8 +197,8 @@ export class ALWorkHandler {
                 runnable: () => this.runBatch().catch((error) => this.reportBatchFailure(toError(error))),
                 ongoingTasks: []
             },
-            // Only the server announces a write this engine did not make; a row another tab or a reload
-            // wrote is found when the remembered answer reaches its age bound.
+            // Only the server announces a write this engine did not make; another tab's commit reaches
+            // the owner's lane as its own, and a row a reload wrote is found at the age bound.
             onExternalWake: () => this.readiness.forget('external-wake'),
             durableOwnership: dependencies.durableOwnership,
             takeOver: () => void this.ready().catch((error) => this.reportBatchFailure(toError(error)))
```

- [ ] **Step 14: Checks.**

```sh
npx dprint fmt packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md \
  packages/shared-web/browser/README.md \
  packages/shared-web/browser/al-runtime/browser-al-durable-work-claim.ts \
  packages/shared-web/browser/al-runtime/browser-al-session-channel.ts \
  packages/shared-web/browser/connection/browser-delivery-settlements.ts \
  packages/shared-web/browser/connection/browser-transport-runtime.ts \
  packages/shared-web/browser/messages/browser-session-deliveries.ts \
  packages/shared-web/browser/session/session-connection-lifecycle.ts \
  packages/shared/alm/delivery/al-delivery-lifecycle.ts \
  packages/shared/alm/outbound/README.md \
  packages/shared/alm/outbound/al-outbound-message-runtime.ts \
  packages/shared/alm/work/al-work-handler.ts \
  packages/tests/shared-web/al-runtime/browser-al-durable-work-claim.test.ts \
  packages/tests/shared-web/al-runtime/browser-al-session-channel.test.ts \
  packages/tests/shared-web/al-runtime/browser-al-session-commit-wake.test.ts \
  packages/tests/shared-web/calls/rallar-calls.test.ts \
  packages/tests/shared-web/composition/browser-facade-behavior.test.ts \
  packages/tests/shared-web/composition/browser-facade-runtime-state.test.ts \
  packages/tests/shared-web/composition/browser-runtime-construction.test.ts \
  packages/tests/shared-web/connection/browser-transport-cleanup.test.ts \
  packages/tests/shared-web/connection/initialise-browser-middleware.test.ts \
  packages/tests/shared-web/data/rallar-data-test-runtime.ts \
  packages/tests/shared-web/director/browser-director-relay-runtime.test.ts \
  packages/tests/shared-web/media/browser-media-sources.test.ts \
  packages/tests/shared-web/messages/browser-delivery-observation.test.ts \
  packages/tests/shared-web/messages/browser-delivery-settlement-relay.test.ts \
  packages/tests/shared-web/messages/browser-message-carrier-gap-hand-over.test.ts \
  packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts \
  packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts \
  packages/tests/shared-web/messages/browser-message-sender-fixture.ts \
  packages/tests/shared-web/messages/browser-message-tracked-receipt.test.ts \
  packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts \
  packages/tests/shared-web/messages/browser-rtc-peer-send.test.ts \
  packages/tests/shared-web/messages/browser-typed-message-channels.test.ts \
  packages/tests/shared-web/people/people-events.test.ts \
  packages/tests/shared-web/rallar-facade-defaults.test.ts \
  packages/tests/shared-web/rallar-startup-lifecycle.test.ts \
  packages/tests/shared-web/realtime/browser-realtime-json-lane.test.ts \
  packages/tests/shared-web/realtime/browser-realtime-send-receive.test.ts \
  packages/tests/shared-web/realtime/browser-room-realtime-runtime.test.ts \
  packages/tests/shared-web/realtime/browser-targeted-realtime-runtime.test.ts \
  packages/tests/shared-web/rooms/create-and-join-room.test.ts \
  packages/tests/shared-web/rooms/formation/create-room-formation.test.ts \
  packages/tests/shared-web/rooms/formation/read-room-formation-view.test.ts \
  packages/tests/shared-web/rooms/join-room.test.ts \
  packages/tests/shared-web/rooms/leave-room.test.ts \
  packages/tests/shared-web/rooms/room-events-replay.test.ts \
  packages/tests/shared-web/rooms/room-events-subscription.test.ts \
  packages/tests/shared-web/rooms/room-membership.test.ts \
  packages/tests/shared-web/rooms/room-session.test.ts \
  packages/tests/shared-web/rooms/room-state-store-current-room.test.ts \
  packages/tests/shared-web/rooms/update-room.test.ts \
  packages/tests/shared-web/rtc-diagnostics/browser-rtc-diagnostics-runtime.test.ts \
  packages/tests/shared-web/rtc/browser-rtc-recovery-runtime.test.ts \
  packages/tests/shared-web/rtc/browser-rtc-room-authority.test.ts \
  packages/tests/shared-web/rtc/browser-rtc-room-runtime.test.ts \
  packages/tests/shared-web/rtc/browser-rtc-wait-runtime.test.ts \
  packages/tests/shared-web/rtc/browser-rtc-wait-test-runtime.ts \
  packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts \
  packages/tests/shared-web/session/browser-auth-session-contract.test.ts \
  packages/tests/shared-web/session/browser-auth-session-teardown-notification.test.ts \
  packages/tests/shared-web/session/session-connection-operations-server-peer.test.ts \
  packages/tests/shared-web/state-cache/rallar-state-store.test.ts \
  packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts \
  packages/tests/shared-web/websocket/browser-rallar-ws-controller.test.ts \
  packages/tests/shared/alm/al-outbound-control-admission.test.ts \
  packages/tests/shared/alm/inbound-runtime-test-fixture.ts \
  packages/tests/shared/alm/outbound-delivery-settlements.test.ts \
  packages/tests/shared/services/ws-queue-box-client-relay-rejection.test.ts \
  packages/shared-web/bundle-budgets.json
npx tsc -p packages/shared/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-web run typecheck
npm --workspace @ar-eye-hunter/shared-server run typecheck
(cd apps/api-v1 && deno task check)
node scripts/check-tests-typecheck.mjs
npx vitest run packages/tests/shared-web packages/tests/shared/alm packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/al-durable-runtime.test.ts packages/tests/shared/webrtc packages/tests/shared/services packages/tests/shared/multicast packages/tests/shared/browser-outbound-cancellation.test.ts packages/tests/shared-server/rallar-system/observability packages/tests/rallar-black-box-headless   # sandbox disabled
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npx vitest run packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/rallar-black-box-headless
npm run check:test-reachability
npm run test:postgres:integration
```

Expected (measured on the assembled tree at this task, scratch `9ed59ed8d`): every typecheck clean; tests
typecheck `check-tests-typecheck: 1432 test files enforced, 0 files carrying known debt (0 errors)`, `PASS`; the broad
run `Test Files  339 passed (339)`, `Tests  3343 passed (3343)`; the three pin files `Tests  25 passed (25)`,
unedited; `browser/rallar.ts` 234.219 KiB `< 235.0 KiB ok` (233.792 after Task 3) and the headless agent
298.756 KiB against 299 (298.624 after Task 3); boundaries, public API snapshot and headless green; reachability
one more file than Task 3's count per new test file (three); repo style `PASS: no new repository style findings`;
coupling `PASS` (no candidate: the new tests read effect logs, the channel's wire and settlement lists, never a
mock's call count); Postgres integration as Task 2 classified it (on the prototype `24 passed | 2 failed (26)`,
both topology files: `rtc-topology-replay-consumer`, red at `ee510bbb0` too, and `topology-app-outbox-concurrency`,
which passed alone on a rerun; no ALM file involved). `deno task check` leaves `apps/api-v1/node_modules/.deno`
behind in a fresh worktree, which then breaks the tests typecheck (pglite types twice); delete it before
`check-tests-typecheck`.

- [ ] **Step 15: Commit.**

```sh
git add packages/shared-web packages/shared/alm/delivery/al-delivery-lifecycle.ts packages/shared/alm/outbound/al-outbound-message-runtime.ts packages/shared/alm/outbound/README.md packages/shared/alm/work/al-work-handler.ts packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md packages/tests
git commit -F - <<'EOF'
Carry a session's commit wake and settlement relay on one channel per connect

One BroadcastChannel per connect, rallar-alm:<applicationId>:<workspaceId>:<sessionId>
with the scope parts URI-encoded, opened through the transport runtime's injected port
factory behind the rallar-data/rallar-crdt missing-API guard. The connect's durable
work claim holds it and closes it on release. Every message carries version, session
key and the posting instance's id; a receiver drops another version, another session
key and its own echo.

The claim's announceCommit posts a waiting tab's commit under the lane's work type;
its onForeignCommit hands a posted commit to the lane of that work type only while
the claim owns the work, so the owner's lane runs it as its own commit and a waiting
tab never announces it again.

Every tab's settlement epoch relays once a durable lane's settlement for a msgId it
holds no handle for; the receiving tab records it through its own observers, which
ignore unknown msgIds, and never relays it again. The outbound runtime stamps the
lane that stated each settlement beside its carrier and time, so a volatile lane's
settlement (signaling, overlay forwarding, volatile ACK controls) never crosses tabs.
Cancel from a waiting tab stays in that tab. Every unit test that connects through
the composition installs the fake channel, so none opens a real Node channel.

browser/rallar.ts measures 234.219 KiB, so its budget rises 234 -> 235 KiB; the
headless agent measures 298.756 KiB against 299.

D8 reuse: the rallar-crdt channel pattern (guard, version, instanceId echo filter, close), the Rallar Data tests' FakeBroadcastChannel (now installed per test), Task 3's claim as the channel's owner and lifetime, the lanes' existing applyForeignCommit, the runtime's emitSettlement stamping point, the registry's getHandle() and BrowserSessionDeliveries' sink; no new scheduler, no wakeAfterExternalWrite, and nothing in packages/shared/cache or resilience models a per-work-type listener set.
EOF
```

Then the changed-range gates, which need the commit:

```sh
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
```

Expected (measured at the assembled head): `PASS: no new repository style findings`; the coupling check lists the
touched file's existing candidate `al-outbound-control-admission.test.ts:503:9` (`mock-invocation-count-or-order`,
already classified in the registry) and prints `PASS: all N current structure-coupling candidates are individually
classified` (19 at the assembled head), `PASS: changed-range structure-coupling review has complete individual classifications`,
`PASS: registry entries are complete and current`.

---

### Task 5: Two pages of one browser context: the `successor` role, the `same-context` family, the family-based hosted selection

Prototyped in scratch as commit `adebf04aa` (its diff applies to `ee510bbb0` unchanged; a scratch-only probe commit
below it, `packages/tests/shared/services/ws-session-two-sockets-probe.test.ts`, is not part of this task). Red then
green; scratch `0be0531ba` on the assembled tree. Rulings R-I2a-ii-1, R-I2a-ii-2, R-I2a-ii-10 (settled as
R-I2a-ii-31), R-I2a-ii-11, R-I2a-ii-33..R-I2a-ii-36; proposal §3.j, decision 6 (D124).

**The finding this task is shaped by (R-I2a-ii-10, settled as R-I2a-ii-31).** The server keeps ONE WebSocket per auth session: the api-v1
upgrade registers the connection under `authSession.sessionId` (`apps/api-v1/src/routes/ws-routes.ts:60-62`), and
`JsonWebSocketServer.addConnection` replaces an existing context of that id and closes it with
`1000 'connection-replaced'` (`packages/shared/websocket/json-web-socket-server.ts:116-124`, pinned by
`packages/tests/shared/websocket/json-web-socket-server.test.ts:131-166`). Every session-addressed send resolves
`connections.get(connectionId)`, the newest socket only (`ws-queue-box-server-live-delivery.ts:160-222`). The browser
reconnects on any close while reconnect is enabled and `readSession()?.sessionId` is unchanged
(`ws-client-reconnect.ts:56`, `create-browser-web-socket-queue-box.ts:104-107`), which both pages of one context
satisfy. A scratch probe (two cases, both green on `ee510bbb0`) shows the server keeping only the newest socket and a
replaced client reconnecting at once. So two connected pages of one session evict each other in a loop, with ACKs and
controls landing on whichever socket is current. The lane therefore never connects both pages at once: the owner page
runs its recipe and is closed from Playwright, and only then does the successor page run (and connect). The
successor page is opened and control-registered before the owner closes (it connects to the control server only, not
to the API: `autoConnect` is the control connection, `LoginScreen` opens no WebSocket); its Web Lock request is
granted at once because the owner's document is gone, which is the takeover callback. The queued-callback path (an
owner alive, a non-owner waiting) is Task 3's unit evidence only; no lane can show it while one auth session keeps
one socket.

**Files**

- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts` — `successor` joins
  `ALM_CONFORMANCE_ROLES` (`:1-2`); the doc line says what it is (no decision id).
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts` —
  `AlmConformanceLaneFamily` gains `'same-context'` (`:54-55`); the `roles`/`laneFamily` docs (`:62`, `:64`) and a doc
  on `toSenderCommands` (`:66`), which is now called for the sender and for the successor.
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts` —
  `AlmConformanceScenario.successor` (`:60`); `isThreeAgentScenario` removed (`:118-121`, its one production caller
  becomes family-based); `toRoleRecipe` routes `successor` to `toSenderCommands` (`:142`); the scenario's `successor`
  recipe (`:154`).
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts` —
  `RESTORED_SESSION_RALLAR` (new, after `:23`); the successor's connect restores the session (`:93`); the ready-peer
  count leaves the successor out (`:97`, new `toPeerCount` after `:113`).
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts` —
  `toConnectionName` gives the successor the sender's connection label (`:21-23`).
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts` — the reconnect spreads
  `RESTORED_SESSION_RALLAR` (`:25`, `:111`); byte-identical output (manifest 18 `--check`).
- Modify: `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts` — `HOSTED_ALM_LANE_FAMILIES` (after
  `:142`) and the family-based filter (`:153`); `isThreeAgentScenario` import dropped (`:11`).
- Modify: `tests/playwright/rallar-black-box/full-stack-helpers.ts` — `BrowserControlAgentInput`,
  `OpenedBrowserControlAgent`, `openBrowserControlAgentInContext` (conditional sign-in), `toBrowserControlAgentQuery`,
  `signInIfLoginGateIsVisible`; `openBrowserControlAgent` (`:554-616`) delegates with a fresh context and keeps its
  signature (its four callers are unchanged).
- Create: `tests/playwright/rallar-black-box/full-stack-same-context-run.ts` (82 lines) — `openSuccessorPage`,
  `runRecipeTrioOnSameContext`, beside `full-stack-three-agent-run.ts` (the template, R-I2a-ii-1).
- Modify: `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts` — the `same-context family over
  <carrier>` test and `runSameContextScenarios` (after `:189` and `:265`); `TwoAgentScenarioFamily` excludes the new
  family (`:58`).
- Modify: `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md` — one paragraph after the addressed
  family's (`:380`), the navigation map for lane families.
- Test (create): `packages/tests/rallar-black-box/full-stack-same-context-run.test.ts` (110 lines).
- Test (modify): `packages/tests/shared-test/alm-conformance-recipes.test.ts` (`:14`, `:172`, `:180`, `:209-213`,
  after `:235`, `:811`), `packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts` (`:10`, `:125-155`),
  `packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts` (`:10-13`, `:76`).
- Not touched: `apps/rallar-black-box/scripts/headless-worker.ts` (R-I2a-ii-1: D124 declined multi-page agents in
  the headless worker; the plan's corrections list amends §3.j/§6), the control client and its command set (no
  page-close command: see below), the identity assessments, manifests 18 and 22 (byte-identical).

**Interfaces**

- Consumes: nothing from Tasks 1–4 (the harness change is product-independent).
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // alm-conformance-roles.ts
  export const ALM_CONFORMANCE_ROLES = ['sender', 'receiver', 'recipient-b', 'successor'] as const;
  // alm-conformance-scenario-definition.ts
  export type AlmConformanceLaneFamily = 'two-agent' | 'addressed' | 'three-agent' | 'same-context';
  // create-alm-conformance-recipes.ts (AlmConformanceScenario)
  readonly successor: RallarBlackBoxTestRecipe | undefined; // undefined exactly when roles lack 'successor'
  // alm-conformance-session-commands.ts
  export const RESTORED_SESSION_RALLAR = { username: '', password: '', restoreSession: true } as const;
  // full-stack-helpers.ts
  export interface BrowserControlAgentInput { config; user; runId; agentId; groupId; connection?; diagnosticsRole? }
  export interface OpenedBrowserControlAgent { context; page; session; diagnostics? }
  export async function openBrowserControlAgentInContext(context: BrowserContext, agent: BrowserControlAgentInput): Promise<OpenedBrowserControlAgent>;
  // full-stack-same-context-run.ts
  export interface SameContextPages { owner: TwoAgentRunParticipant; successor: TwoAgentRunParticipant }
  export interface SameContextRecipes extends RecipePair { successor: RallarBlackBoxTestRecipe }
  export interface SameContextOutcome extends RecipePairOutcome { successor: RecipeRunOutcome }
  export async function openSuccessorPage(input: { testInfo; run: TwoAgentRun; owner: TwoAgentRunParticipant }): Promise<TwoAgentRunParticipant>;
  export async function runRecipeTrioOnSameContext(run: TwoAgentRun, pages: SameContextPages, recipes: SameContextRecipes): Promise<SameContextOutcome>;
  ```
  Removed: `isThreeAgentScenario` (callers: the Hetzner filter and three tests, all moved to `laneFamily`).
  Refinements of the frame's decided shape: the frame's two-page agent option is a role (`successor`) plus a
  context-taking opener, since a page of a shared context is a separate control agent with its own recipe, not an
  option of one agent; the family is named `same-context` as decided.

**No page-close command.** Closing the owner page from Playwright (`pages.owner.page.close()`) is enough: the owner's
recipe has returned its result (`runRecipeOnAgent` waits for it), Web Locks and the WebSocket end with the document,
the control server only marks the agent disconnected (`control-service.ts:514-526`, no run-level effect), and no
command of that agent follows. A control command would need a schema entry, a control-client interception like
`agent.reload` (`control-client.ts:351-377`), a validator and its tests, for no evidence the Playwright close lacks.
The hosted manifests cannot use the family anyway (D124).

**D8 reuse inspection.** Reused: `openBrowserControlAgent`'s page flow, factored into one context-taking opener that
both the fresh-context path and the successor use (no second copy of the query or the registration waits); the
headless worker's conditional sign-in pattern (`headless-worker.ts:144-157`), written with `locator.or` so it waits
for either screen rather than racing `isVisible`; `startRecipientRecipeRun`/`runRecipeOnAgent`/
`waitForControlRunAgent` and the three-agent run's module shape and unit-test double; the existing `laneFamily` as the
one selector (the hosted filter, the spec and the tests read it, so `isThreeAgentScenario`, which re-derived the
family from the roles, is removed); the reload reconnect's restored-session fields, now one constant both connects
spread. Not added: a page-close control command, a headless-worker option, a new scenario-definition hook (the
successor reuses `toSenderCommands`, dispatching on `step.role` as `toRecipientCommands` already does for two
recipients), a mutable "pages: n" run option.

- [ ] **Step 1: Write the failing tests.**

  (a) Create `packages/tests/rallar-black-box/full-stack-same-context-run.test.ts` (the Task 5 version; Task 6 adds
  one selection test to it):

<!-- dprint-ignore -->
```ts
import * as Playwright from '@playwright/test';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import type { TwoAgentRun, TwoAgentRunParticipant } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';
import { runRecipeTrioOnSameContext } from '../../../tests/playwright/rallar-black-box/full-stack-same-context-run.ts';

const group = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

function toAcceptedResponse(url: string): Playwright.APIResponse {
    return {
        url: () => url,
        ok: () => true,
        status: () => 202,
        statusText: () => 'Accepted',
        headers: () => ({}),
        headersArray: () => [],
        securityDetails: async () => null,
        serverAddr: async () => null,
        body: async () => Buffer.from('{}'),
        text: async () => '{}',
        json: async () => ({}),
        dispose: async () => {},
        [Symbol.asyncDispose]: async () => {}
    };
}

function toParticipant(agentId: string, page: Playwright.Page | undefined): TwoAgentRunParticipant {
    return {
        agentId,
        actor: agentId,
        connection: agentId,
        get context(): Playwright.BrowserContext {
            throw new Error('Enqueue must not create a browser context.');
        },
        get page(): Playwright.Page {
            if (page === undefined) {
                throw new Error('Only the owner page is closed.');
            }
            return page;
        }
    };
}

describe('same-context ALM run', () => {
    // One auth session keeps one server socket: the successor connects only once the owner page is gone.
    it('runs the owner\'s recipe, closes the owner page, then runs the successor, the receiver started first', async () => {
        const baseline = createAlmConformanceRecipes({
            group,
            carrier: 'ws',
            typeId: 'probe',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000
        }).find((scenario) => scenario.scenarioId === 'delivery-baseline')!;
        const successor = { ...baseline.sender, recipeId: `${baseline.sender.recipeId}-successor` };
        const order: string[] = [];
        const ownerPage = { close: async () => void order.push('close-owner') } as Partial<Playwright.Page> as Playwright.Page;
        const request = await Playwright.request.newContext();
        vi.spyOn(request, 'post').mockImplementation(async (url, options) => {
            const data = options?.data;
            if (!isJsonRecordValue(data) || typeof data.commandId !== 'string') {
                throw new Error('Expected the actual control HTTP command body.');
            }
            order.push(data.commandId);
            return toAcceptedResponse(url);
        });
        const run: TwoAgentRun = {
            request,
            runId: 'same-context-run',
            group,
            sender: toParticipant('owner-agent', ownerPage),
            receiver: toParticipant('receiver-agent', undefined),
            readSnapshot: async () => ({ results: order.map((commandId) => ({ commandId, ok: true })) }),
            close: async () => {
                throw new Error('Enqueue must not close the run.');
            }
        };
        try {
            const outcome = await runRecipeTrioOnSameContext(
                run,
                { owner: run.sender, successor: toParticipant('successor-agent', undefined) },
                { sender: baseline.sender, receiver: baseline.receiver, successor }
            );

            expect(order).toEqual([
                `${baseline.receiver.recipeId}-run`,
                `${baseline.sender.recipeId}-run`,
                'close-owner',
                `${successor.recipeId}-run`
            ]);
            expect(outcome).toEqual({
                sender: { commandId: `${baseline.sender.recipeId}-run`, ok: true, summary: 'ok' },
                receiver: { commandId: `${baseline.receiver.recipeId}-run`, ok: true, summary: 'ok' },
                successor: { commandId: `${successor.recipeId}-run`, ok: true, summary: 'ok' }
            });
        }
        finally {
            vi.restoreAllMocks();
            await request.dispose();
        }
    });
});
```

(b) In `packages/tests/shared-test/alm-conformance-recipes.test.ts`: drop the `isThreeAgentScenario` import; list
the successor in `toAllRoleRecipes`; pin both role-derived families; pin `toAlmConformanceRoleRecipe(scenario,
  'successor')` and `scenario.successor` (undefined until Task 6); add the readiness and restored-connect cases; read
`laneFamily` at `:811`:

```diff
diff --git a/packages/tests/shared-test/alm-conformance-recipes.test.ts b/packages/tests/shared-test/alm-conformance-recipes.test.ts
index d1708f02c..d6ee243e0 100644
--- a/packages/tests/shared-test/alm-conformance-recipes.test.ts
+++ b/packages/tests/shared-test/alm-conformance-recipes.test.ts
@@ -11,7 +11,6 @@ import type { CreateAlmConformanceRecipesInput } from '@shared-test/rallar-bb-te
 import { toConnectCommand } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts';
 import {
     createAlmConformanceRecipes,
-    isThreeAgentScenario,
     toAlmConformanceRoleRecipe,
     type AlmConformanceScenario
 } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
@@ -169,7 +168,12 @@ const SCENARIO_KEYS_BY_CARRIER = {
 } as const;
 
 function toAllRoleRecipes(scenarios: readonly AlmConformanceScenario[]): readonly RallarBlackBoxTestRecipe[] {
-    return scenarios.flatMap((scenario) => [scenario.sender, scenario.receiver, ...(scenario.recipientB ? [scenario.recipientB] : [])]);
+    return scenarios.flatMap((scenario) => [
+        scenario.sender,
+        scenario.receiver,
+        ...(scenario.recipientB ? [scenario.recipientB] : []),
+        ...(scenario.successor ? [scenario.successor] : [])
+    ]);
 }
 
 describe('alm-conformance recipe family', () => {
@@ -177,7 +181,8 @@ describe('alm-conformance recipe family', () => {
         const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
 
         for (const scenario of scenarios) {
-            expect(scenario.laneFamily === 'three-agent', scenario.scenarioKey).toBe(isThreeAgentScenario(scenario));
+            expect(scenario.laneFamily === 'three-agent', scenario.scenarioKey).toBe(scenario.roles.includes('recipient-b'));
+            expect(scenario.laneFamily === 'same-context', scenario.scenarioKey).toBe(scenario.roles.includes('successor'));
         }
         expect(scenarios.filter((scenario) => scenario.laneFamily === 'addressed').map(({ scenarioId }) => scenarioId))
             .toEqual(
@@ -206,11 +211,13 @@ describe('alm-conformance recipe family', () => {
             for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                 const threeRoles = scenario.scenarioId === 'receipted-audience';
                 expect(scenario.roles, scenario.scenarioKey).toEqual(threeRoles ? ['sender', 'receiver', 'recipient-b'] : ['sender', 'receiver']);
-                expect(isThreeAgentScenario(scenario), scenario.scenarioKey).toBe(threeRoles);
+                expect(scenario.laneFamily === 'three-agent', scenario.scenarioKey).toBe(threeRoles);
                 expect(toAlmConformanceRoleRecipe(scenario, 'sender')).toBe(scenario.sender);
                 expect(toAlmConformanceRoleRecipe(scenario, 'receiver')).toBe(scenario.receiver);
                 expect(toAlmConformanceRoleRecipe(scenario, 'recipient-b')).toBe(scenario.recipientB);
+                expect(toAlmConformanceRoleRecipe(scenario, 'successor')).toBe(scenario.successor);
                 expect(scenario.recipientB?.recipeId).toBe(threeRoles ? `alm-${carrier}-${scenario.scenarioKey}-recipient-b` : undefined);
+                expect(scenario.successor).toBeUndefined();
             }
         }
     });
@@ -233,6 +240,39 @@ describe('alm-conformance recipe family', () => {
         ).toBeUndefined();
     });
 
+    // The successor is the sender's own session on a second page, so it is never a peer to wait for.
+    it('counts one ready peer for every page of a same-context scenario', () => {
+        const sameContext = ['sender', 'receiver', 'successor'] as const;
+
+        for (const role of sameContext) {
+            expect(
+                toConnectCommand({ input: toConformanceInput('rtc'), scenarioId: 'delivery-baseline', scenarioKey: 'probe', role, roles: sameContext })
+                    .readiness?.minReadyPeers,
+                role
+            ).toBe(1);
+        }
+    });
+
+    it('connects the successor on the sender\'s connection and restores the session the shared context holds', () => {
+        const connect = toConnectCommand({
+            input: toConformanceInput('ws'),
+            scenarioId: 'delivery-baseline',
+            scenarioKey: 'probe',
+            role: 'successor',
+            roles: ['sender', 'receiver', 'successor']
+        });
+
+        expect(connect.commandId).toBe('alm-ws-probe-successor-connect');
+        expect(connect.connection).toBe('sender');
+        expect(connect.rallar).toEqual({
+            typeId: 'alm.conformance.ws.probe',
+            topicId: CONFORMANCE_TOPIC_ID,
+            username: '',
+            password: '',
+            restoreSession: true
+        });
+    });
+
     it('connects both roles on the carrier transport that subscribes the typed inbound channel', () => {
         for (const carrier of ALM_CONFORMANCE_CARRIERS) {
             const scenarios = createAlmConformanceRecipes(toConformanceInput(carrier));
@@ -808,7 +848,7 @@ describe('alm-conformance recipe family', () => {
                 let sawAcknowledged = false;
                 for (const carrier of ALM_CONFORMANCE_CARRIERS) {
                     for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
-                        if (!isThreeAgentScenario(scenario)) {
+                        if (scenario.laneFamily !== 'three-agent') {
                             continue;
                         }
                         const endingAssert = scenario.sender.commands.find((command) =>
```

(c) In `packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts`, the family pin (R-I2a-ii-2): the
2-agent entry's cells are exactly the `two-agent` + `addressed` cells minus the withheld two, the 3-agent entry's
exactly the `three-agent` cells, and no hosted cell is a `same-context` cell:

```diff
diff --git a/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts b/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
index cd83748a6..229841973 100644
--- a/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
+++ b/packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts
@@ -5,9 +5,9 @@ import {
 } from 'vitest';
 
 import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
+import type { AlmConformanceLaneFamily } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
 import {
     createAlmConformanceRecipes,
-    isThreeAgentScenario,
     type AlmConformanceScenario
 } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
 import type {
@@ -122,27 +122,37 @@ describe('ALM conformance combined recipe', () => {
     });
 });
 
-describe('ALM conformance 2-agent hosted withholdings', () => {
+/** Every `alm-<carrier>-<scenarioKey>` cell the catalog defines in the named lane families. */
+function toFamilyCells(families: readonly AlmConformanceLaneFamily[]): readonly string[] {
+    return ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
+        createAlmConformanceRecipes({
+            group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
+            carrier,
+            typeId: 'alm.conformance',
+            senderConnection: 'sender',
+            receiverConnection: 'receiver',
+            deadlineMs: 18_000
+        }).filter((scenario) => families.includes(scenario.laneFamily))
+            .map((scenario) => `alm-${carrier}-${scenario.scenarioKey}`)
+    );
+}
+
+function toStartedCells(entry: ReturnType<typeof createAlmConformance2AgentEntry>): readonly string[] {
+    const sender = entry.manifest.recipes
+        .find((selection) => selection.role === 'sender')!.recipe as RallarBlackBoxTestRecipe;
+    return toBarrierIds(sender).filter((id) => id.endsWith('-start')).map((id) => id.replace(/-start$/, ''));
+}
+
+describe('ALM conformance hosted lane families', () => {
     it('withholds exactly the named cells: the refresh variant over rtc and rtc-with-ws-fallback', () => {
-        const defined = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
-            createAlmConformanceRecipes({
-                group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
-                carrier,
-                typeId: 'alm.conformance',
-                senderConnection: 'sender',
-                receiverConnection: 'receiver',
-                deadlineMs: 18_000
-            }).filter((scenario) => !isThreeAgentScenario(scenario)).map((scenario) => `alm-${carrier}-${scenario.scenarioKey}`)
-        );
+        const defined = toFamilyCells(['two-agent', 'addressed']);
         // Removing a withheld cell from hosted manifest 18 is a deliberate act: no plain-member write advances the
         // snapshot version for the refresh variant.
         const withheld = [
             'alm-rtc-not-yet-in-sync-delivered-after-refresh',
             'alm-rtc-with-ws-fallback-not-yet-in-sync-delivered-after-refresh'
         ];
-        const sender = createAlmConformance2AgentEntry().manifest.recipes
-            .find((selection) => selection.role === 'sender')!.recipe as RallarBlackBoxTestRecipe;
-        const cells = toBarrierIds(sender).filter((id) => id.endsWith('-start')).map((id) => id.replace(/-start$/, ''));
+        const cells = toStartedCells(createAlmConformance2AgentEntry());
 
         expect(defined).toEqual(expect.arrayContaining(withheld));
         expect(new Set(cells)).toEqual(new Set(defined.filter((cell) => !withheld.includes(cell))));
@@ -152,6 +162,17 @@ describe('ALM conformance 2-agent hosted withholdings', () => {
             'alm-rtc-with-ws-fallback-delivery-reload'
         ]);
     });
+
+    it('carries the three-agent family in the 3-agent entry', () => {
+        expect(new Set(toStartedCells(createAlmConformance3AgentEntry()))).toEqual(new Set(toFamilyCells(['three-agent'])));
+    });
+
+    // A same-context scenario needs two pages of one browser context, which no hosted agent has.
+    it('leaves the same-context family out of every hosted entry', () => {
+        const hosted = [createAlmConformance2AgentEntry(), createAlmConformance3AgentEntry()].flatMap(toStartedCells);
+
+        expect(toFamilyCells(['same-context']).filter((cell) => hosted.includes(cell))).toEqual([]);
+    });
 });
 
 describe('ALM combined recipient-b ACK-hold ordering', () => {
```

(d) `packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts` reads the family:

```diff
diff --git a/packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts b/packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts
index a615d6ab4..fe9e4af07 100644
--- a/packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts
+++ b/packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts
@@ -7,10 +7,7 @@ import {
 } from 'vitest';
 
 import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
-import {
-    createAlmConformanceRecipes,
-    isThreeAgentScenario
-} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
+import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
 import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
 
 import type { TwoAgentRunParticipant } from '../../../tests/playwright/rallar-black-box/full-stack-helpers.ts';
@@ -73,7 +70,7 @@ describe('three-agent ALM run', () => {
             'rtc-with-ws-fallback': rtcScenarioKeys
         };
         for (const carrier of ALM_CONFORMANCE_CARRIERS) {
-            const threeAgent = toScenarios(carrier).filter(isThreeAgentScenario);
+            const threeAgent = toScenarios(carrier).filter((scenario) => scenario.laneFamily === 'three-agent');
             expect(threeAgent.map((scenario) => scenario.scenarioKey), carrier).toEqual(expectedKeys[carrier]);
             expect(threeAgent.every((scenario) => scenario.recipientB !== undefined), carrier).toBe(true);
         }
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts \
  packages/tests/rallar-black-box/full-stack-same-context-run.test.ts \
  packages/tests/shared-test/alm-conformance-recipes.test.ts \
  packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts
# FAIL full-stack-same-context-run.test.ts: Cannot find module '…/full-stack-same-context-run.ts'
# × counts one ready peer for every page of a same-context scenario   (sender: expected 2 to be 1)
# × connects the successor on the sender's connection and restores the session …   (expected 'receiver' to be 'sender')
# Test Files  2 failed | 2 passed (4)   Tests  2 failed | 50 passed (52)
```

- [ ] **Step 3: The role, the family and the successor recipe.**

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts
index 425d145cb..85dd1a494 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts
@@ -1,5 +1,8 @@
-/** `recipient-b` is the second, distinguishable recipient of a three-agent scenario (D45). */
-export const ALM_CONFORMANCE_ROLES = ['sender', 'receiver', 'recipient-b'] as const;
+/**
+ * `recipient-b` is the second, distinguishable recipient of a three-agent scenario. `successor` is a second page
+ * in the sender's own browser context: the same storage and auth session under an agent of its own.
+ */
+export const ALM_CONFORMANCE_ROLES = ['sender', 'receiver', 'recipient-b', 'successor'] as const;
 
 export type AlmConformanceRole = typeof ALM_CONFORMANCE_ROLES[number];
 
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
index c532f745e..a6db36ef2 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
@@ -51,18 +51,28 @@ export interface AlmConformanceMessageStepInput extends AlmConformanceStepInput
     readonly index: number;
 }
 
-/** The addressed sends run on their own two agents, so the baseline cell keeps its wall time. */
-export type AlmConformanceLaneFamily = 'two-agent' | 'addressed' | 'three-agent';
+/**
+ * The addressed sends run on their own two agents, so the baseline cell keeps its wall time. A `same-context`
+ * scenario runs its sender and its successor as two pages of one browser context, which only the Playwright lane has.
+ */
+export type AlmConformanceLaneFamily = 'two-agent' | 'addressed' | 'three-agent' | 'same-context';
 
 export interface AlmConformanceScenarioDefinition {
     readonly scenarioId: AlmConformanceScenarioId;
     readonly scenarioKey: string;
     readonly tags: readonly AlmConformanceTag[];
     readonly carriers: readonly AlmConformanceCarrier[];
-    /** Every scenario declares the sender and the receiver; a three-agent scenario adds `recipient-b` (D45). */
+    /**
+     * Every scenario declares the sender and the receiver; a three-agent scenario adds `recipient-b`, a same-context
+     * scenario adds `successor`.
+     */
     readonly roles: readonly AlmConformanceRole[];
-    /** The lane test that runs it: `three-agent` exactly when `roles` declares `recipient-b`. */
+    /**
+     * The lane test that runs it: `three-agent` exactly when `roles` declares `recipient-b`, `same-context` exactly
+     * when it declares `successor`.
+     */
     readonly laneFamily: AlmConformanceLaneFamily;
+    /** Called once per page of the sender's session: the sender, and the successor a scenario declares. */
     readonly toSenderCommands: (sender: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
     /** Called once per recipient role the scenario declares; the step's role tells the recipients apart. */
     readonly toRecipientCommands: (recipient: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts b/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
index ec7c527fd..e872d86ec 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
@@ -58,6 +58,8 @@ export interface AlmConformanceScenario {
     readonly receiver: RallarBlackBoxTestRecipe;
     /** The second recipient's recipe; undefined exactly when `roles` does not declare `recipient-b`. */
     readonly recipientB: RallarBlackBoxTestRecipe | undefined;
+    /** The sender's second page's recipe; undefined exactly when `roles` does not declare `successor`. */
+    readonly successor: RallarBlackBoxTestRecipe | undefined;
     readonly tags: readonly AlmConformanceTag[];
 }
 
@@ -115,11 +117,6 @@ export function createAlmConformanceRecipes(
         .map((definition) => toAlmConformanceScenario(input, definition));
 }
 
-/** Three agents run only the scenarios that declare `recipient-b`; every other scenario runs on two (D45). */
-export function isThreeAgentScenario(scenario: AlmConformanceScenario): boolean {
-    return scenario.roles.includes('recipient-b');
-}
-
 export function toAlmConformanceRoleRecipe(
     scenario: AlmConformanceScenario,
     role: AlmConformanceRole
@@ -139,7 +136,9 @@ function toAlmConformanceScenario(
             role,
             roles: definition.roles
         };
-        const commands = role === 'sender' ? definition.toSenderCommands(step) : definition.toRecipientCommands(step);
+        const commands = role === 'sender' || role === 'successor'
+            ? definition.toSenderCommands(step)
+            : definition.toRecipientCommands(step);
         const receiptRoles = role === 'sender' ? definition.toReceiptRoles?.(input.carrier) : undefined;
         return toAlmConformanceRecipe({ ...step, commands, receiptRoles });
     };
@@ -151,7 +150,8 @@ function toAlmConformanceScenario(
         tags: definition.tags,
         sender: toRoleRecipe('sender'),
         receiver: toRoleRecipe('receiver'),
-        recipientB: definition.roles.includes('recipient-b') ? toRoleRecipe('recipient-b') : undefined
+        recipientB: definition.roles.includes('recipient-b') ? toRoleRecipe('recipient-b') : undefined,
+        successor: definition.roles.includes('successor') ? toRoleRecipe('successor') : undefined
     };
 }
```

- [ ] **Step 4: The successor's connect: the sender's connection, the restored session, one peer with the sender.**
      `delivery-reload`'s reconnect spreads the same constant (output unchanged, proven by manifest 18's `--check`).

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts
index 5f8db4507..3fde283da 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts
@@ -10,6 +10,7 @@ import {
     STATS_TIMEOUT_MS,
     toBudgetMs
 } from './alm-conformance-budgets.ts';
+import type { AlmConformanceRole } from './alm-conformance-roles.ts';
 import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
 import {
     ALM_CONFORMANCE_TOPIC_ID,
@@ -22,6 +23,9 @@ import {
 const ENSURE_TIMEOUT_MS = 5_000;
 const CONNECT_READINESS_INTERVAL_MS = 100;
 
+/** A connect that keeps the auth session its document already holds: no credentials, so it never signs in afresh. */
+export const RESTORED_SESSION_RALLAR = { username: '', password: '', restoreSession: true } as const;
+
 export function toEnsureGroupCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
     const group = step.input.group;
     return {
@@ -90,11 +94,13 @@ export function toConnectCommand(step: AlmConformanceStepInput): RallarBlackBoxT
         workspaceId: input.group.workspaceId,
         roomRef: toRoomRef(input.group),
         transport: input.carrier === 'ws' ? 'messages.ws' : 'messages.rtc',
-        rallar: { typeId, topicId: ALM_CONFORMANCE_TOPIC_ID },
+        rallar: step.role === 'successor'
+            ? { typeId, topicId: ALM_CONFORMANCE_TOPIC_ID, ...RESTORED_SESSION_RALLAR }
+            : { typeId, topicId: ALM_CONFORMANCE_TOPIC_ID },
         timeoutMs: CONNECT_TIMEOUT_MS,
         ...(input.carrier === 'ws' || !waitsForReadyPeers(step) ? {} : {
             readiness: {
-                minReadyPeers: step.roles.length - 1,
+                minReadyPeers: toPeerCount(step.roles) - 1,
                 timeoutMs: CONNECT_READINESS_TIMEOUT_MS,
                 intervalMs: CONNECT_READINESS_INTERVAL_MS
             }
@@ -111,6 +117,11 @@ function waitsForReadyPeers(step: AlmConformanceStepInput): boolean {
     return step.role === 'sender' || !step.roles.includes('recipient-b');
 }
 
+/** The successor is a second page of the sender's session, so the two are one peer. */
+function toPeerCount(roles: readonly AlmConformanceRole[]): number {
+    return roles.filter((role) => role !== 'successor').length;
+}
+
 export function toStatsCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
     return {
         kind: 'stats',
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts
index 7d64bffcb..de2217c31 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts
@@ -19,7 +19,9 @@ export function toSendHandleId(step: AlmConformanceMessageStepInput): string {
 }
 
 export function toConnectionName(step: AlmConformanceStepInput): string {
-    return step.role === 'sender' ? step.input.senderConnection : step.input.receiverConnection;
+    return step.role === 'sender' || step.role === 'successor'
+        ? step.input.senderConnection
+        : step.input.receiverConnection;
 }
 
 export function toRoomRef(group: RallarBlackBoxDistributedGroupRef): RallarBlackBoxTestRecord {
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
index 44e107996..9445c807e 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
@@ -22,7 +22,7 @@ import {
     type AlmConformanceScenarioDefinition,
     type AlmConformanceStepInput
 } from '../alm-conformance-scenario-definition.ts';
-import { toConnectCommand } from '../alm-conformance-session-commands.ts';
+import { RESTORED_SESSION_RALLAR, toConnectCommand } from '../alm-conformance-session-commands.ts';
 import { toCommandId } from '../alm-conformance-step-identities.ts';
 import type { AlmReloadCheckpoint } from '../alm-reload-pair.ts';
 
@@ -108,7 +108,7 @@ function toDeliveryReloadSenderCommands(sender: AlmConformanceStepInput): readon
         {
             ...reconnect,
             commandId: toCommandId(sender, 'reconnect'),
-            rallar: { ...reconnect.rallar, username: '', password: '', restoreSession: true }
+            rallar: { ...reconnect.rallar, ...RESTORED_SESSION_RALLAR }
         },
         toObserveCommand({ ...sender, index: 1, state: 'unobservable' }),
         toResultAssertion({
```

- [ ] **Step 5: The hosted entries select by lane family (R-I2a-ii-2).**

```diff
diff --git a/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts b/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts
index 8be5b0606..834f5adc3 100644
--- a/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts
+++ b/apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts
@@ -4,11 +4,11 @@ import {
     type AlmConformanceCarrier
 } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
 import type { AlmConformanceRole } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts';
+import type { AlmConformanceLaneFamily } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
 import { toAlmReloadCheckpoints } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
 import { readAlmReceiptRolesEntries } from '@shared-test/rallar-bb-test/conformance/alm/assess-alm-receipt-role-identity.ts';
 import {
     createAlmConformanceRecipes,
-    isThreeAgentScenario,
     toAlmConformanceRoleRecipe,
     type AlmConformanceScenario
 } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
@@ -137,9 +137,18 @@ export function createAlmConformance3AgentEntry(): HetznerDistributedManifestEnt
     });
 }
 
-/** A three-role scenario runs on its own three agents (D45), so each family combines into its own recipes. */
+/** A three-role scenario runs on its own three agents, so each hosted entry combines into its own recipes. */
 type AlmConformanceFamily = 'two-agent' | 'three-agent';
 
+/**
+ * The lane families each hosted entry carries. The addressed sends ride the 2-agent entry; a same-context scenario
+ * needs two pages of one browser context, which no hosted agent has, so no entry carries it.
+ */
+const HOSTED_ALM_LANE_FAMILIES: Readonly<Record<AlmConformanceFamily, readonly AlmConformanceLaneFamily[]>> = {
+    'two-agent': ['two-agent', 'addressed'],
+    'three-agent': ['three-agent']
+};
+
 function toAlmConformanceScenariosForAllCarriers(family: AlmConformanceFamily): readonly AlmConformanceScenario[] {
     const scenarios = ALM_CONFORMANCE_CARRIERS.flatMap((carrier) =>
         createAlmConformanceRecipes({
@@ -150,7 +159,7 @@ function toAlmConformanceScenariosForAllCarriers(family: AlmConformanceFamily):
             receiverConnection: ALM_CONFORMANCE_RECEIVER_CONNECTION,
             deadlineMs: ALM_CONFORMANCE_DEADLINE_MS
         }).filter((scenario) => !isHetznerWithheldAlmScenario(scenario.scenarioKey, carrier))
-    ).filter((scenario) => isThreeAgentScenario(scenario) === (family === 'three-agent'));
+    ).filter((scenario) => HOSTED_ALM_LANE_FAMILIES[family].includes(scenario.laneFamily));
     // Receiver absence windows in ordinary scenarios must not consume the later reload specimen's TTL, and a
     // capacity block closes and reconnects its sender, so nothing but another capacity block follows it.
     const isHoisted = (scenario: AlmConformanceScenario) =>
```

- [ ] **Step 6: The context-taking opener with a conditional sign-in (R-I2a-ii-11).** `openBrowserControlAgent` keeps
      its signature for its four callers (`full-stack-three-agent-run.ts:86`, `full-stack-director-orchestration.spec.ts:192`,
      `exhaustive-control-distributed.spec.ts:34,39,44`) and delegates with a fresh context, whose gate always shows, so
      their behaviour is unchanged.

```diff
diff --git a/tests/playwright/rallar-black-box/full-stack-helpers.ts b/tests/playwright/rallar-black-box/full-stack-helpers.ts
index 5fa72dc3c..9a181a4f3 100644
--- a/tests/playwright/rallar-black-box/full-stack-helpers.ts
+++ b/tests/playwright/rallar-black-box/full-stack-helpers.ts
@@ -551,54 +551,45 @@ export async function exportControlRunArtifacts(
     return await response.json() as Readonly<Record<string, unknown>>;
 }
 
+export interface BrowserControlAgentInput {
+    readonly config: FullStackConfig;
+    readonly user: FullStackUser;
+    readonly runId: string;
+    readonly agentId: string;
+    readonly groupId: string;
+    readonly connection?: string;
+    /** Requests page-diagnostics capture from page creation; omitted for callers that don't read it. */
+    readonly diagnosticsRole?: AlmConformanceRole;
+}
+
+export interface OpenedBrowserControlAgent {
+    readonly context: BrowserContext;
+    readonly page: Page;
+    readonly session: BrowserAuthSession;
+    readonly diagnostics?: PageDiagnosticsCapture;
+}
+
 export async function openBrowserControlAgent(
     browser: Browser,
     config: FullStackConfig,
     user: FullStackUser,
-    input: Readonly<{
-        runId: string;
-        agentId: string;
-        groupId: string;
-        connection?: string;
-        /** Requests page-diagnostics capture from page creation; omitted for callers that don't read it. */
-        diagnosticsRole?: AlmConformanceRole;
-    }>
-): Promise<
-    Readonly<{
-        context: BrowserContext;
-        page: Page;
-        session: BrowserAuthSession;
-        diagnostics?: PageDiagnosticsCapture;
-    }>
-> {
-    const context = await browser.newContext();
-    const page = await context.newPage();
-    const diagnostics = toPageDiagnosticsCapture(page, input);
-    const query = new URLSearchParams({
-        mode: 'control',
-        workspace: 'black-box-runner',
-        tab: 'local-workbench',
-        provider: 'browser-rallar',
-        autoConnect: '1',
-        controlUrl: FULL_STACK_CONTROL_WS_URL,
-        runId: input.runId,
-        agentId: input.agentId,
-        apiBaseUrl: config.apiBaseUrl,
-        applicationId: config.applicationId,
-        workspaceId: config.workspaceId,
-        roomId: input.groupId,
-        actor: user.actor,
-        sessionId: `${input.agentId}-session`,
-        heartbeatIntervalMs: '250',
-        statsIntervalMs: '1000',
-        rallarLeaveRoomOnClose: '0',
-        rallarUsername: user.username,
-        rallarPassword: user.password
-    });
+    input: Omit<BrowserControlAgentInput, 'config' | 'user'>
+): Promise<OpenedBrowserControlAgent> {
+    return await openBrowserControlAgentInContext(await browser.newContext(), { ...input, config, user });
+}
 
-    await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${query.toString()}`);
-    await expect(page.getByRole('heading', { name: 'Rallar Server Login' })).toBeVisible();
-    await page.getByRole('button', { name: 'Sign in' }).click();
+/**
+ * Opens a control agent page in a context that may already hold an auth session: a page of a context another agent
+ * signed in skips the login screen, so it signs in only when the gate shows.
+ */
+export async function openBrowserControlAgentInContext(
+    context: BrowserContext,
+    agent: BrowserControlAgentInput
+): Promise<OpenedBrowserControlAgent> {
+    const page = await context.newPage();
+    const diagnostics = toPageDiagnosticsCapture(page, agent);
+    await page.goto(`${FULL_STACK_SPA_ORIGIN}/?${toBrowserControlAgentQuery(agent).toString()}`);
+    await signInIfLoginGateIsVisible(page);
     await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveAttribute(
         'aria-selected',
         'true',
@@ -615,6 +606,40 @@ export async function openBrowserControlAgent(
     };
 }
 
+function toBrowserControlAgentQuery(agent: BrowserControlAgentInput): URLSearchParams {
+    return new URLSearchParams({
+        mode: 'control',
+        workspace: 'black-box-runner',
+        tab: 'local-workbench',
+        provider: 'browser-rallar',
+        autoConnect: '1',
+        controlUrl: FULL_STACK_CONTROL_WS_URL,
+        runId: agent.runId,
+        agentId: agent.agentId,
+        apiBaseUrl: agent.config.apiBaseUrl,
+        applicationId: agent.config.applicationId,
+        workspaceId: agent.config.workspaceId,
+        roomId: agent.groupId,
+        actor: agent.user.actor,
+        sessionId: `${agent.agentId}-session`,
+        heartbeatIntervalMs: '250',
+        statsIntervalMs: '1000',
+        rallarLeaveRoomOnClose: '0',
+        rallarUsername: agent.user.username,
+        rallarPassword: agent.user.password
+    });
+}
+
+/** Either screen settles first; the workbench of a signed-in context never shows the gate. */
+async function signInIfLoginGateIsVisible(page: Page): Promise<void> {
+    const loginGate = page.getByRole('heading', { name: 'Rallar Server Login' });
+    const workbench = page.getByRole('tab', { name: 'Advanced' });
+    await expect(loginGate.or(workbench).first()).toBeVisible({ timeout: 30_000 });
+    if (await loginGate.isVisible()) {
+        await page.getByRole('button', { name: 'Sign in' }).click();
+    }
+}
+
 function toPageDiagnosticsCapture(
     page: Page,
     input: Readonly<{ agentId: string; diagnosticsRole?: AlmConformanceRole; }>
```

- [ ] **Step 7: The same-context run.** Create `tests/playwright/rallar-black-box/full-stack-same-context-run.ts`:

<!-- dprint-ignore -->
```ts
import type { TestInfo } from '@playwright/test';

import type { RallarBlackBoxTestRecipe } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    openBrowserControlAgentInContext,
    readFullStackConfig,
    runRecipeOnAgent,
    startRecipientRecipeRun,
    uniqueAgentId,
    waitForControlRunAgent,
    type RecipePair,
    type RecipePairOutcome,
    type RecipeRunOutcome,
    type TwoAgentRun,
    type TwoAgentRunParticipant
} from './full-stack-helpers.ts';

/** The page that owns the sender's session for one scenario, and the page of the same context that follows it. */
export interface SameContextPages {
    readonly owner: TwoAgentRunParticipant;
    readonly successor: TwoAgentRunParticipant;
}

export interface SameContextRecipes extends RecipePair {
    readonly successor: RallarBlackBoxTestRecipe;
}

export interface SameContextOutcome extends RecipePairOutcome {
    readonly successor: RecipeRunOutcome;
}

interface OpenSuccessorPageInput {
    readonly testInfo: TestInfo;
    readonly run: TwoAgentRun;
    readonly owner: TwoAgentRunParticipant;
}

/**
 * A second page of the owner's browser context: the same storage and auth session, an agent of its own. The owner is
 * a two-agent run's sender, user A, whose credentials the page uses only if its login gate shows.
 */
export async function openSuccessorPage(input: OpenSuccessorPageInput): Promise<TwoAgentRunParticipant> {
    const config = readFullStackConfig();
    const agentId = uniqueAgentId(input.testInfo, 'alm-successor');
    const opened = await openBrowserControlAgentInContext(input.owner.context, {
        config,
        user: config.userA,
        runId: input.run.runId,
        agentId,
        groupId: input.run.group.groupId,
        connection: input.owner.connection,
        diagnosticsRole: 'successor'
    });
    await waitForControlRunAgent(input.run.request, input.run.runId, agentId);
    return {
        agentId,
        actor: input.owner.actor,
        connection: input.owner.connection,
        context: input.owner.context,
        page: opened.page,
        diagnostics: opened.diagnostics
    };
}

/**
 * The server keeps one socket per auth session and a second one replaces the first, which reconnects in turn, so the
 * two pages never connect at once: the owner runs the sender recipe and closes, and only then does the successor run.
 */
export async function runRecipeTrioOnSameContext(
    run: TwoAgentRun,
    pages: SameContextPages,
    recipes: SameContextRecipes
): Promise<SameContextOutcome> {
    const receiverRun = await startRecipientRecipeRun(run, run.receiver, recipes.receiver);
    const sender = await runRecipeOnAgent(run, pages.owner, recipes.sender);
    await pages.owner.page.close();
    const [successor, receiver] = await Promise.all([
        runRecipeOnAgent(run, pages.successor, recipes.successor),
        receiverRun.outcome
    ]);
    return { sender, receiver, successor };
}
```

- [ ] **Step 8: The lane test for the family.** Each scenario opens its own successor page, which owns the session for
      the next scenario; the observation records every page that ran.

```diff
diff --git a/tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts b/tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts
index 10109123a..b4675ba04 100644
--- a/tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts
+++ b/tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts
@@ -47,6 +47,7 @@ import {
     type TwoAgentRun,
     type TwoAgentRunParticipant
 } from './full-stack-helpers.ts';
+import { openSuccessorPage, runRecipeTrioOnSameContext } from './full-stack-same-context-run.ts';
 import {
     createThreeAgentRun,
     runRecipeTrioOnThreeAgents,
@@ -55,7 +56,7 @@ import {
 import type { PageDiagnosticsCapture } from './start-page-diagnostics-capture.ts';
 import { toPageDiagnosticsFile, type PageDiagnosticsFile } from './to-page-diagnostics-file.ts';
 
-type TwoAgentScenarioFamily = Exclude<AlmConformanceLaneFamily, 'three-agent'>;
+type TwoAgentScenarioFamily = Exclude<AlmConformanceLaneFamily, 'three-agent' | 'same-context'>;
 
 interface ObservationCell {
     readonly run: TwoAgentRun;
@@ -187,6 +188,41 @@ test.describe('ALM conformance lane', () => {
                 await run.close();
             }
         });
+
+        test(`same-context family over ${carrier} (${scope})`, async ({ browser, request }, testInfo) => {
+            test.skip(
+                selectScenarios(toPlanningSelection(), carrier, 'same-context').length === 0,
+                `no ${scope} ALM scenario over ${carrier} runs on two pages of one context`
+            );
+            test.setTimeout(CARRIER_TEST_TIMEOUT_MS);
+
+            const run = await createTwoAgentRun({
+                browser,
+                request,
+                testInfo,
+                runId: `alm-${carrier}-same-context-${uniqueSuffix()}`
+            });
+            const participants: TwoAgentRunParticipant[] = [run.sender, run.receiver];
+            let scenarioFailed = false;
+            try {
+                await runSameContextScenarios({ run, carrier, testInfo, participants });
+            }
+            catch (scenarioError) {
+                scenarioFailed = true;
+                throw scenarioError;
+            }
+            finally {
+                await recordObservation({
+                    run,
+                    family: 'same-context',
+                    participants,
+                    testInfo,
+                    carrier,
+                    cellOutcome: toCellOutcome(testInfo, scenarioFailed)
+                });
+                await run.close();
+            }
+        });
     }
 });
 
@@ -263,6 +299,35 @@ async function runThreeAgentScenarios(
     }
 }
 
+interface SameContextCell {
+    readonly run: TwoAgentRun;
+    readonly carrier: AlmConformanceCarrier;
+    readonly testInfo: TestInfo;
+    /** The cell's pages; each scenario's successor joins them, so the observation reads every page that ran. */
+    readonly participants: TwoAgentRunParticipant[];
+}
+
+/** Each scenario closes the page that owns the sender's session, so its successor owns the session for the next one. */
+async function runSameContextScenarios(cell: SameContextCell): Promise<void> {
+    const { run, carrier, testInfo, participants } = cell;
+    let owner = run.sender;
+    for (const scenario of selectScenarios(toRunSelection(run), carrier, 'same-context')) {
+        if (scenario.successor === undefined) {
+            throw new Error(`${scenario.scenarioKey} runs on one context without a successor recipe.`);
+        }
+        const successor = await openSuccessorPage({ testInfo, run, owner });
+        participants.push(successor);
+        const outcome = await runRecipeTrioOnSameContext(run, { owner, successor }, {
+            ...scenario,
+            successor: scenario.successor
+        });
+        for (const role of ['receiver', 'sender', 'successor'] as const) {
+            expect.soft(outcome[role].ok, `${scenario.scenarioKey} ${role}: ${outcome[role].summary}`).toBe(true);
+        }
+        owner = successor;
+    }
+}
+
 /** Lifecycle and reload join message identities; a scenario that pins its receipt's roles joins recipient sessions. */
 function hasIdentityEvidence(scenario: AlmConformanceScenario): boolean {
     return scenario.scenarioId === 'delivery-lifecycle' ||
```

- [ ] **Step 9: The navigation map.** `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`, after the
      addressed family's paragraph:

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
index 0464deb3e..93c1f1d73 100644
--- a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
+++ b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
@@ -378,6 +378,20 @@ send (R-S3c-ii-9). The limit is three fillers, so the two counted sends alone re
 at least 9 180 bytes of headroom. Its receiver's window adds one readiness budget and the 31 s wait, since the sender
 reconnects and waits before it sends. In manifest 18 the three `capacity` blocks run after every other block.
 
+The same-context family runs, in the full scope, as the `same-context family over <carrier>` Playwright test. Its
+scenarios declare a fourth role, `successor`: a second page opened in the sender's own browser context, so it shares
+the sender's IndexedDB and the `auth.session` in `localStorage`, under a control agent of its own. That page skips the
+login screen, and its recipe connects with `rallar` `{ username: '', password: '', restoreSession: true }`, so it
+restores the sender's session rather than signing in afresh. Its connect waits for one ready peer, as the sender's and
+the receiver's do, since both pages are one session and so one peer. The two pages are never connected at once: the
+server keeps one WebSocket per auth session and a second upgrade closes the first with `connection-replaced`, after
+which the first page reconnects and replaces the second. The lane therefore starts the receiver, runs the sender's
+recipe, closes the sender's page from Playwright, and only then runs the successor's recipe; no control command closes
+a page. No `reset` runs on a successor page, since it would clear the storage both pages share. Each scenario opens its
+own successor, which owns the session for the next one. The Hetzner entries select their scenarios by lane family
+(`two-agent` and `addressed` for manifest 18, `three-agent` for manifest 22), so neither carries this family: a
+hosted agent has no second page in its context.
+
 `messages.observe` waits on the in-page message handle; `messages.receipts` reads
 its current lifecycle without waiting. The shared states are `submitted`,
 `rejected`, `pending-authority`, `accepted`, `queued`, `transport-accepted`,
```

- [ ] **Step 10: Format the touched files only, then run the focused tests green.**

```sh
npx dprint fmt apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts \
  packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md \
  packages/tests/rallar-black-box/full-stack-same-context-run.test.ts \
  packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts \
  packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts \
  packages/tests/shared-test/alm-conformance-recipes.test.ts \
  tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts \
  tests/playwright/rallar-black-box/full-stack-helpers.ts \
  tests/playwright/rallar-black-box/full-stack-same-context-run.ts
npx vitest run packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts \
  packages/tests/rallar-black-box/full-stack-same-context-run.test.ts \
  packages/tests/shared-test/alm-conformance-recipes.test.ts \
  packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts
# Test Files  4 passed (4)   Tests  53 passed (53)
```

- [ ] **Step 11: The task's checks.** Measured on `adebf04aa` (sandbox off for the port-binding suites, the tsx
      pipe and Deno):

```sh
npx vitest run packages/tests/shared-test packages/tests/rallar-black-box
# Test Files  370 passed (371)   (the path also picks up packages/tests/rallar-black-box-headless; its
#   headless-bundle-boundary test timed out at 6.1 s once under the full run and passes alone: contention, unrelated)
npx tsc -p packages/shared-test/tsconfig.json --noEmit                 # exit 0
(cd apps/rallar-black-box && npx tsc --noEmit)                         # exit 0
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1428 test files enforced, 0 files carrying known debt (0 errors).  PASS
WT=/Users/knuthelge/ProjectLocker/github/ar-eye-hunter/.claude/worktrees/alm-i2a-ii
cat > $TMPDIR/tsconfig.playwright.json <<EOF
{ "extends": "$WT/packages/tests/tsconfig.json",
  "compilerOptions": { "noEmit": true, "typeRoots": ["$WT/node_modules/@types"], "types": ["node"] },
  "include": ["$WT/tests/playwright/rallar-black-box/**/*.ts"] }
EOF
npx tsc -p $TMPDIR/tsconfig.playwright.json   # the scratch tsconfig: no tsconfig covers tests/playwright/**
# 28 errors, the same 28 as on ee510bbb0 (none in a touched file): recipe-console-*, tabbed-navigation,
#   exhaustive-control-distributed, full-stack-live-rtc-lifecycle-acceptance, full-stack-director-orchestration and
#   the environmental @js-temporal/polyfill lib error
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
# checked 67 Hetzner distributed manifest(s)
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts && git diff --quiet -- apps/rallar-black-box/manifests
# wrote … 18-alm-conformance-2-agent.json … 22-alm-conformance-3-agent.json; git diff empty (byte-identical)
(cd apps/rallar-black-box-control-server && deno task check && deno task test)
# check exit 0; ok | 192 passed | 0 failed
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS ×3 (no candidates; classifications complete; registry current)
npm run check:test-reachability
# Test reachability: 1730 test files, 1724 reached by CI, 6 manual.   (one test file added)
```

The scratch tsconfig is written by the heredoc above; no tsconfig covers `tests/playwright/**` (the I2a-i lesson).

Bundles: nothing under `packages/shared` or `packages/shared-web` changes; measured `browser/rallar.ts` 232.975 KiB
and headless 297.686 KiB at both `ee510bbb0` and this commit on its own, and 234.219 / 298.756 KiB on the
assembled tree after Task 4 (unchanged by this task; brotli q11). The lane is not run
here (ports off limits); the family has no scenario until Task 6, so its test skips.

- [ ] **Step 12: Commit.**

```sh
git add apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-roles.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-step-identities.ts packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md packages/tests/rallar-black-box/full-stack-same-context-run.test.ts packages/tests/rallar-black-box/full-stack-three-agent-run.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts tests/playwright/rallar-black-box/full-stack-helpers.ts tests/playwright/rallar-black-box/full-stack-same-context-run.ts
git commit -F - <<'MSG'
Two pages of one browser context in the ALM lane: the successor role and the same-context family

A same-context scenario declares a fourth role, `successor`: a second page opened in the
sender's own Playwright browser context, so it shares the sender's IndexedDB and auth session
under a control agent of its own. Its connect restores that session and counts the two pages
as one peer. The server keeps one WebSocket per auth session, so the lane runs the sender's
recipe, closes its page, and only then runs the successor's. The Hetzner entries now select
scenarios by lane family, so neither hosted manifest carries the new family; manifests 18
and 22 regenerate byte-identical.

D8 reuse: the successor page reuses openBrowserControlAgent's page flow (now one context-taking opener with a conditional sign-in), startRecipientRecipeRun/runRecipeOnAgent and the three-agent run's shape; the restored-session connect fields are one constant delivery-reload's reconnect shares; the hosted selection reads the existing laneFamily and isThreeAgentScenario goes away.

MSG
```

---

### Task 6: The `durable-takeover` scenario

Prototyped in scratch as commit `64a2276a6` on Task 5's `adebf04aa`. Red then green (each red recorded below);
scratch `de632511a` on the assembled tree, after Tasks 1–5. Rulings R-I2a-ii-2, R-I2a-ii-10 (settled as R-I2a-ii-31),
R-I2a-ii-22, R-I2a-ii-24, R-I2a-ii-29, R-I2a-ii-32, R-I2a-ii-37..R-I2a-ii-40; proposal §3.j, decisions 6 and 12
(D124, D128). It needs none of Tasks 1–4's code: the scenario reads the existing `recovery` event
(`{ kind, storeId, outcome }`, key order unchanged by Tasks 1–4).

**D123's two-tab story, bounded (R-I2a-ii-31).** The server keeps one WebSocket per auth session: a second upgrade of
the same session replaces the first and closes it `1000 'connection-replaced'`, and the replaced page reconnects and
evicts the other, so two connected pages of one session loop. The lock's value in practice is the orderly hand-over on
close or reload and the single drainer while two tabs are open on one session (one of which then has no socket). A
takeover while the owner page is alive cannot run in the lane; it is a carried limit covered by Task 3's lock-queue
unit test. This scenario proves the hand-over on close.

**Shape (R-I2a-ii-31, R-I2a-ii-32 and R-I2a-ii-29 together).** One auth session keeps one server socket (Task 5's finding), so the
successor page cannot connect while the owner page lives; it connects after the owner page's close and its claim's
callback fires at once (a closed document's Web Lock is released by the browser, R-I2a-ii-24). The owner page is the
session's first page, so it owns the work when it admits the held send (R-I2a-ii-22). R-I2a-ii-29 binds the takeover's
fact to the new owner's `recovery` reading `restored {claimed ≥ 1}` on the store that held the row. Under the WS hold
that row is NOT free when the owner page closes: `readALOutboundDequeueWait` (`lane/read-al-outbound-dequeue-wait.ts:31-79`)
keeps a held claim reserved and re-reads the authority in memory until the lease ends, then the next batch re-claims
it, so at any instant the row is leased for up to `AL_OUTBOUND_WORK_LEASE_MS` (10 s); a closed page writes no release.
A successor whose first batch ran before that lease ended would claim nothing (`restored {claimed: 0}`) and recover the
row in a later batch that reports nothing (the reporter reports the first batch only,
`al-storage-recovery-reporter.ts:43-58`). Task 3's unit evidence for R-I2a-ii-29 (its claim test "drains in the owner, and
the next connect takes over") reads `claimed: 1` from the second tab's OWN unleased commit, not from a row the first
tab held. So the successor's prologue waits out one lease plus `RESPONSE_MARGIN_MS` before its connect (an absent wait
on a topic nothing emits, the delay pattern `capacity`'s `rejoin-settles` uses); a fresh owner's first batch sweeps
(`createLimitedALWorkLeaseRecovery`, "a fresh pair holds both allowances, so the owner's first batch sweeps",
`al-work-lease-recovery.ts:32-44`), so the takeover's bootstrap claims the lapsed reservation and reports
`restored {claimed ≥ 1}`, which the successor asserts. Carried limit: the lane does not run a takeover while the
owner's lease still stands (recovered at the lease end plus at most 19.1 s by an unreported batch) nor a takeover
while the owner page is alive; the first is pinned by the lease-recovery unit tests (`al-work-lease-recovery.test.ts`),
the second by Task 3's lock-queue unit test.

**Files**

- Create: `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/durable-takeover.ts` (89 lines).
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts` — `'durable-takeover'`
  joins `AlmConformanceScenarioId` (after `:26`).
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts` — the import (`:38`),
  the catalog entry after `...receiptedAudience` (`:101`), the successor's lease-lapse wait in the prologue (`:179`).
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts` — receives
  `RECOVERED_STORE_PREFIXES`, the recovery margin, `toRecoveryTtlMs`, `toOriginalStorePrefix`, `toStoreRecoveryWait`
  (moved from `delivery-reload.ts:29-47,184-212`, output unchanged) and the new `toOwnerLeaseLapseWait`.
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts` — imports the moved
  helpers (`:7`, `:25`); its own copies go (`:29-47`, `:135-149`, `:165`, `:184-212`).
- Move: `scenarios/to-addressed-send-commands.ts` (30 lines, deleted) → `alm-conformance-receipt-commands.ts` (after
  `:34`, verbatim); the three addressed scenarios' imports (`server-command.ts:4,12`, `unicast-fallback.ts:6-17`,
  `ws-unicast-receipt.ts:4-16`). Why: the changed-style gate's `layout.directory-density` (review threshold > 20) fires
  for `conformance/alm/` and `conformance/alm/scenarios/` at 21 files each (and `layout.feature-prefix-cluster` on
  `assess-*` with it); both directories stay at 20. `alm-conformance-message-commands.ts` was tried first for the
  helper and trips `file.responsibility-count` (12 runtime exports); the receipt commands (4 → 5) already own the
  receipted audience send, its sibling.
- Modify: `apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts` — the fixture's ports model
  the catalog's held originals for a successor page as for a reloaded document (`isHeldOriginal`, `:290-299`), an
  outbound store's restored recovery claims the originals the last page held (`:308-338`), and one Deno test per
  carrier runs the lane's three recipes in the lane's order.
- Modify: `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md` — the `durable-takeover` paragraph after
  `storage-unavailable`'s (`:534`) and one clause in Task 5's family paragraph (the lease wait).
- Test (create): `packages/tests/shared-test/alm-conformance-durable-takeover.test.ts` (177 lines).
- Test (modify): `packages/tests/shared-test/alm-conformance-recipes.test.ts` (`:204-220` roles, `:395`, `:428`, `:448`
  pins), `packages/tests/shared-test/alm-conformance-recipe-validation.test.ts` (catalog ids, every role's recipe,
  the takeover sender's hold that ends with its page), `packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts`
  (the moved prefixes), `packages/tests/rallar-black-box/full-stack-same-context-run.test.ts` (the family selects
  exactly `durable-takeover`).
- Not touched: the identity assessments (`assess-alm-*`; the takeover joins no message identity after the run: the
  receiver's single carrier-tagged arrival and the successor's restored-store wait, scoped to the session its own
  connect restored, are the evidence, and a successor that signed in afresh would own a different session's rows and
  never deliver), `hasIdentityEvidence` in the spec, the hosted entries and manifests 18/22 (byte-identical), the
  observation regime (the successor resolves `unattributed`, as `recipient-b` does).

**Interfaces**

- Consumes: Task 5's `successor` role, `same-context` family, `RESTORED_SESSION_RALLAR`, the lane test; Task 3's
  takeover behaviour only through the browser (no import).
- Produces:

  <!-- dprint-ignore -->
  ```ts
  // scenarios/durable-takeover.ts
  export const durableTakeover: AlmConformanceScenarioDefinition; // same-context, every carrier, FULL_TAGS,
                                                                  // roles ['sender', 'receiver', 'successor']
  // alm-conformance-session-commands.ts (moved; delivery-reload and durable-takeover share them)
  export const RECOVERED_STORE_PREFIXES: { sessionInbound; ws; rtc };
  export interface AlmConformanceRecoveredStore { name; storeIdPrefix; lane: '' | '/ws'; connectName; timeoutMs }
  export function toRecoveryTtlMs(deadlineMs: number): number;              // deadline − 1 s + 60 s = 77 s at 18 s
  export function toOriginalStorePrefix(carrier: AlmConformanceCarrier): string; // rtc → overlay, else ws client
  export function toStoreRecoveryWait(step, store: AlmConformanceRecoveredStore): RallarBlackBoxTestCommand;
  export function toOwnerLeaseLapseWait(step: AlmConformanceStepInput): RallarBlackBoxTestCommand; // 10 s + 1 s
  // alm-conformance-receipt-commands.ts (moved verbatim)
  export function toAddressedSendCommands(sender, toPeer): readonly RallarBlackBoxTestCommand[];
  ```
  Removed: `RELOAD_RECOVERED_STORE_PREFIXES` (renamed on its move; its one consumer is a test), the module
  `scenarios/to-addressed-send-commands.ts`.

  Recipes per carrier (`<p>` = `alm-<carrier>-durable-takeover`):
  - sender: ensure-group, ensure-member, connect, storage-counters-connected, the hold (`hold-ws` / `hold-rtc`, both
    on the fallback carrier, `until-cleared`), `send-1` (`local-outbox`, `ack: 'receiver'`, `ttlMs` 77 000, command
    budget 10 000, payload `{ marker: 'durable-takeover', carrier }`), `observe-admitted-1` and its four asserts
    (admitted, `enqueued` true, retained `accepted|queued`, `submitted` false), stats.
  - successor: ensure-group, ensure-member, `owner-lease-lapses` (absent wait, 11 000 ms), connect (sender's
    connection, `restoreSession`), `recovered-original-store` (`"kind":"recovery","storeId":"<prefix>:{resultCache.<p>-successor-connect.value.sessionId}","outcome":{"kind":"restored"`),
    `assert-recovered-claimed` (`…value.event.payload.data.outcome.claimed` `gt` 0), stats.
  - receiver: ensure-group, ensure-member, connect, `receive-original` (payload wait, 45 000 + 77 000 ms: it starts
    before the sender's connect), `received-1` (`count: 2`, `absent`, window 17 000: no second copy), stats.

**D8 reuse inspection.** Reused as they are: `toHeldFaultCommands` (the native hold `delivery-reload` uses),
`toSendCommand`, `toRetainedEvidenceCommands`, `toPayloadWait`, `toReceivedCommand` (the single-arrival pattern of
`toSingleArrivalReceiverCommands`), `toResultAssertion` on a wait's `value.event` (the path `receipted-audience` reads),
capacity's absent wait on a topic nothing emits as the delay, `RESTORED_SESSION_RALLAR`, and the Deno fixture's
`GeneratedAlmPorts` (its held-original redelivery generalised from the reload marker to the takeover's). Moved, not
copied: the store-recovery wait, the original-store choice and the recovery lifetime, so `delivery-reload` and
`durable-takeover` share one implementation. Not added: a delay command kind, a page-close command, a new identity
assessment, a new fixture.

- [ ] **Step 1: Write the failing tests.** Create `packages/tests/shared-test/alm-conformance-durable-takeover.test.ts`:

<!-- dprint-ignore -->
```ts
import { describe, expect, it } from 'vitest';

import { toBrowserRtcOverlayALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';

import { CONNECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodePayloadPathValue } from '@shared-test/rallar-bb-test/wait/wait-event-match.ts';

import { OUTBOUND_LEASE_RECOVERY_BOUND_MS } from '../shared/alm/outbound-runtime-test-fixture.ts';
import { toConformanceInput } from './alm-conformance-test-input.ts';

const STORAGE_TOPIC = 'rallar.browser.alm.storage';

type Carrier = (typeof ALM_CONFORMANCE_CARRIERS)[number];

function findTakeover(carrier: Carrier): AlmConformanceScenario & { readonly successor: RallarBlackBoxTestRecipe; } {
    const scenario = createAlmConformanceRecipes(toConformanceInput(carrier))
        .find((candidate) => candidate.scenarioId === 'durable-takeover');
    if (scenario?.successor === undefined) {
        throw new Error(`Missing durable-takeover with a successor over ${carrier}.`);
    }
    return { ...scenario, successor: scenario.successor };
}

/** The scenario's own commands, past the connect prologue and before the trailing stats. */
function toScenarioCommands(commands: readonly RallarBlackBoxTestCommand[]): readonly RallarBlackBoxTestCommand[] {
    return commands.filter((command) => !['http.request', 'rtc.connect', 'storage.counters', 'stats'].includes(command.kind));
}

function toShape(command: RallarBlackBoxTestCommand): string {
    switch (command.kind) {
        case 'fault.inject':
            return `fault.inject:${command.carrier}:${String(command.remaining)}`;
        case 'messages.send':
            return 'replayOnCarrier' in command ? 'replay' : `send:${command.durability ?? 'volatile'}:${command.ack ?? 'none'}`;
        case 'messages.observe':
            return `observe:${command.state.length === 1 ? command.state[0] : 'admitted'}`;
        case 'messages.received':
            return `received:${command.count}${command.absent === true ? ':absent' : ''}`;
        case 'wait':
            return `wait:${command.match.kind}${command.absent === true ? ':absent' : ''}`;
        default:
            return command.kind;
    }
}

function findSend(scenario: AlmConformanceScenario) {
    const send = scenario.sender.commands.find((command) => command.kind === 'messages.send');
    if (send?.kind !== 'messages.send' || 'replayOnCarrier' in send) {
        throw new Error(`${scenario.scenarioKey} sends nothing.`);
    }
    return send;
}

describe('durable-takeover conformance scenario', () => {
    it.each(ALM_CONFORMANCE_CARRIERS)('runs over %s on two pages of the sender\'s context, in the full tag only', (carrier) => {
        const scenario = findTakeover(carrier);

        expect(scenario.laneFamily).toBe('same-context');
        expect(scenario.roles).toEqual(['sender', 'receiver', 'successor']);
        expect(scenario.tags).toEqual(['full']);
        expect(scenario.recipientB).toBeUndefined();
        expect(scenario.successor.recipeId).toBe(`alm-${carrier}-durable-takeover-successor`);
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('has the %s owner admit and retain one durable send under a held carrier', (carrier) => {
        const holds = carrier === 'rtc-with-ws-fallback'
            ? ['fault.inject:rtc:until-cleared', 'fault.inject:ws:until-cleared']
            : [`fault.inject:${carrier}:until-cleared`];

        expect(toScenarioCommands(findTakeover(carrier).sender.commands).map(toShape)).toEqual([
            ...holds,
            'send:local-outbox:receiver',
            'observe:admitted',
            'assert',
            'assert',
            'assert',
            'assert'
        ]);
    });

    // The owner's page closes with its row held: the successor takes it over, at once or after one lease and a sweep.
    it.each(ALM_CONFORMANCE_CARRIERS)('lets the %s original outlive one lease, the recovery bound and a successor connect', (carrier) => {
        const send = findSend(findTakeover(carrier));

        expect(send.payload).toEqual({ marker: 'durable-takeover', carrier });
        expect(send.ttlMs).toBeGreaterThan(AL_OUTBOUND_WORK_LEASE_MS + OUTBOUND_LEASE_RECOVERY_BOUND_MS + CONNECT_TIMEOUT_MS);
    });

    // A held claim stays reserved until its lease ends, so the successor connects only once the owner's lease has lapsed.
    it.each(
        [
            ['ws', 'browser-ws-client'],
            ['rtc', 'browser-rtc-overlay'],
            ['rtc-with-ws-fallback', 'browser-ws-client']
        ] as const
    )('has the %s successor wait out the owner\'s lease, restore its session and read %s restored with a claim', (carrier, originalStore) => {
        const { successor } = findTakeover(carrier);
        const prefix = `alm-${carrier}-durable-takeover-successor`;
        const [, , lapse, connect, recovery, claimed] = successor.commands;

        expect(successor.commands.map((command) => command.commandId)).toEqual([
            `${prefix}-ensure-group`,
            `${prefix}-ensure-member`,
            `${prefix}-owner-lease-lapses`,
            `${prefix}-connect`,
            `${prefix}-recovered-original-store`,
            `${prefix}-assert-recovered-claimed`,
            `${prefix}-stats`
        ]);
        expect(lapse?.kind === 'wait' && lapse.absent === true).toBe(true);
        expect(lapse?.timeoutMs).toBeGreaterThan(AL_OUTBOUND_WORK_LEASE_MS);
        expect(connect?.kind === 'rtc.connect' ? connect.rallar : undefined).toMatchObject({
            username: '',
            password: '',
            restoreSession: true
        });
        expect(recovery?.kind === 'wait' ? recovery.match : undefined).toEqual({
            kind: 'diagnostic',
            topic: STORAGE_TOPIC,
            payloadPath: 'data',
            contains: `"kind":"recovery","storeId":"${originalStore}:{resultCache.${prefix}-connect.value.sessionId}",` +
                '"outcome":{"kind":"restored"'
        });
        expect(claimed).toMatchObject({
            kind: 'assert',
            source: `resultCache.${prefix}-recovered-original-store.value.event.payload.data.outcome.claimed`,
            operator: 'gt',
            expected: 0
        });
    });

    it('reads the claim from the restored recovery a store records, as the runtime keeps the matched event', () => {
        const events: ALStorageEvent[] = [];
        new ALStorageHealth({ storeId: toBrowserRtcOverlayALRuntimeStoreId('s'), storage: (event) => events.push(event) })
            .recordRecovery({ kind: 'restored', claimed: 1, expired: 0 }, undefined);
        const { successor } = findTakeover('rtc');
        const recovery = successor.commands.find((command) => command.commandId?.endsWith('-recovered-original-store'));
        const claimed = successor.commands.find((command) => command.commandId?.endsWith('-assert-recovered-claimed'));
        const contains = recovery?.kind === 'wait' ? recovery.match.contains ?? '' : '';
        const source = claimed?.kind === 'assert' ? claimed.source : '';

        expect(JSON.stringify(events[0]))
            .toContain(contains.replace('{resultCache.alm-rtc-durable-takeover-successor-connect.value.sessionId}', 's'));
        expect(decodePayloadPathValue({ event: { payload: { data: events[0] } } }, source.split('.value.')[1]))
            .toEqual({ exists: true, value: 1 });
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('has the %s receiver get the carrier\'s original once', (carrier) => {
        const scenario = findTakeover(carrier);
        const receiverCommands = toScenarioCommands(scenario.receiver.commands);
        const arrival = receiverCommands[0];

        expect(receiverCommands.map(toShape)).toEqual(['wait:message', 'received:2:absent']);
        expect(arrival?.kind === 'wait' ? arrival.match.equals : undefined).toEqual(findSend(scenario).payload);
        expect(arrival?.timeoutMs).toBe(CONNECT_TIMEOUT_MS + (findSend(scenario).ttlMs ?? 0));
    });

    it.each(ALM_CONFORMANCE_CARRIERS)('gives every %s command of the three pages its own id the control validator accepts', (carrier) => {
        const scenario = findTakeover(carrier);
        const commands = [...scenario.sender.commands, ...scenario.receiver.commands, ...scenario.successor.commands];

        expect(new Set(commands.map((command) => command.commandId)).size).toBe(commands.length);
        for (const command of commands) {
            expect(validateRallarBlackBoxTestCommand(command), command.commandId).toEqual({ ok: true });
        }
    });
});
```

The catalog pins (`alm-conformance-recipes.test.ts`, `alm-conformance-recipe-validation.test.ts`,
`full-stack-same-context-run.test.ts`):

```diff
diff --git a/packages/tests/rallar-black-box/full-stack-same-context-run.test.ts b/packages/tests/rallar-black-box/full-stack-same-context-run.test.ts
index 1798c7462..947c42c19 100644
--- a/packages/tests/rallar-black-box/full-stack-same-context-run.test.ts
+++ b/packages/tests/rallar-black-box/full-stack-same-context-run.test.ts
@@ -6,6 +6,7 @@ import {
     vi
 } from 'vitest';
 
+import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
 import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
 import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
 
@@ -50,6 +51,22 @@ function toParticipant(agentId: string, page: Playwright.Page | undefined): TwoA
 }
 
 describe('same-context ALM run', () => {
+    it('selects exactly durable-takeover for the same-context family on every carrier', () => {
+        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
+            const sameContext = createAlmConformanceRecipes({
+                group,
+                carrier,
+                typeId: 'probe',
+                senderConnection: 'sender',
+                receiverConnection: 'receiver',
+                deadlineMs: 18_000
+            }).filter((scenario) => scenario.laneFamily === 'same-context');
+
+            expect(sameContext.map((scenario) => scenario.scenarioKey), carrier).toEqual(['durable-takeover']);
+            expect(sameContext.every((scenario) => scenario.successor !== undefined), carrier).toBe(true);
+        }
+    });
+
     // One auth session keeps one server socket: the successor connects only once the owner page is gone.
     it('runs the owner\'s recipe, closes the owner page, then runs the successor, the receiver started first', async () => {
         const baseline = createAlmConformanceRecipes({
diff --git a/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts b/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
index 47321a845..1ebe43a8c 100644
--- a/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
+++ b/packages/tests/shared-test/alm-conformance-recipe-validation.test.ts
@@ -40,7 +40,8 @@ const CARRIER_SCENARIO_IDS = {
         'ws-unicast-receipt',
         'server-command',
         'capacity',
-        ...Array.from({ length: 3 }, () => 'receipted-audience' as const)
+        ...Array.from({ length: 3 }, () => 'receipted-audience' as const),
+        'durable-takeover'
     ],
     rtc: [
         'volatile-default',
@@ -56,7 +57,8 @@ const CARRIER_SCENARIO_IDS = {
         'not-yet-in-sync',
         'ws-unicast-receipt',
         'capacity',
-        ...Array.from({ length: 4 }, () => 'receipted-audience' as const)
+        ...Array.from({ length: 4 }, () => 'receipted-audience' as const),
+        'durable-takeover'
     ],
     'rtc-with-ws-fallback': [
         'volatile-default',
@@ -78,7 +80,8 @@ const CARRIER_SCENARIO_IDS = {
         'ws-unicast-receipt',
         'unicast-fallback',
         'capacity',
-        ...Array.from({ length: 4 }, () => 'receipted-audience' as const)
+        ...Array.from({ length: 4 }, () => 'receipted-audience' as const),
+        'durable-takeover'
     ]
 } as const;
 
@@ -96,7 +99,10 @@ function toConformanceInput(
 }
 
 function toRecipes(scenarios: readonly AlmConformanceScenario[]): readonly RallarBlackBoxTestRecipe[] {
-    return scenarios.flatMap((scenario) => [scenario.sender, scenario.receiver]);
+    return scenarios.flatMap((scenario) =>
+        [scenario.sender, scenario.receiver, scenario.recipientB, scenario.successor]
+            .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined)
+    );
 }
 
 const ALM_CONFORMANCE_SCOPES: readonly AlmConformanceTag[] = ['smoke', 'full'];
@@ -104,8 +110,9 @@ const ALM_CONFORMANCE_SCOPES: readonly AlmConformanceTag[] = ['smoke', 'full'];
 /**
  * Recipe ids whose hold stays until the page ends. Recipient-b of the frozen audience withholds its ACK,
  * leaves and rejoins past the expiry; the hold matches only that scenario's type id, so no later block sees it.
+ * The takeover's sender holds its carrier until the lane closes its page, which no later block shares.
  */
-const HELD_UNTIL_PAGE_ENDS_RECIPE_SUFFIXES = ['-frozen-audience-membership-recipient-b'];
+const HELD_UNTIL_PAGE_ENDS_RECIPE_SUFFIXES = ['-frozen-audience-membership-recipient-b', '-durable-takeover-sender'];
 
 /**
  * A counted fault runs out after a number of frames, not after a time: a quick retry loop spends it before
@@ -191,8 +198,8 @@ describe('ALM conformance recipe validation', () => {
             ALM_CONFORMANCE_SCOPES.flatMap((scope) =>
                 createAlmConformanceRecipes(toConformanceInput(carrier))
                     .filter((scenario) => scenario.tags.includes(scope))
-                    .flatMap((scenario) => [scenario.sender, scenario.receiver, scenario.recipientB])
-                    .flatMap((recipe) => recipe === undefined ? [] : toUnreleasedFaults(recipe))
+                    .flatMap((scenario) => toRecipes([scenario]))
+                    .flatMap(toUnreleasedFaults)
                     .map((finding) => `${scope}: ${finding}`)
             )
         );
diff --git a/packages/tests/shared-test/alm-conformance-recipes.test.ts b/packages/tests/shared-test/alm-conformance-recipes.test.ts
index d6ee243e0..615fe95a2 100644
--- a/packages/tests/shared-test/alm-conformance-recipes.test.ts
+++ b/packages/tests/shared-test/alm-conformance-recipes.test.ts
@@ -201,23 +201,31 @@ describe('alm-conformance recipe family', () => {
                     ...SCENARIO_KEYS_BY_CARRIER[carrier].flatMap((key) => [`alm-${carrier}-${key}-sender`, `alm-${carrier}-${key}-receiver`]),
                     ...RECEIPTED_AUDIENCE_KEYS_BY_CARRIER[carrier].flatMap((key) =>
                         ['sender', 'receiver', 'recipient-b'].map((role) => `alm-${carrier}-${key}-${role}`)
-                    )
+                    ),
+                    ...['sender', 'receiver', 'successor'].map((role) => `alm-${carrier}-durable-takeover-${role}`)
                 ]);
         }
     });
 
-    it('declares recipient-b on the receipted-audience scenarios only; every other scenario keeps one sender and one receiver (D45)', () => {
+    it('declares recipient-b on the receipted-audience scenarios and successor on durable-takeover only; every other scenario keeps one sender and one receiver', () => {
         for (const carrier of ALM_CONFORMANCE_CARRIERS) {
             for (const scenario of createAlmConformanceRecipes(toConformanceInput(carrier))) {
                 const threeRoles = scenario.scenarioId === 'receipted-audience';
-                expect(scenario.roles, scenario.scenarioKey).toEqual(threeRoles ? ['sender', 'receiver', 'recipient-b'] : ['sender', 'receiver']);
+                const twoPages = scenario.scenarioId === 'durable-takeover';
+                expect(scenario.roles, scenario.scenarioKey).toEqual(
+                    threeRoles
+                        ? ['sender', 'receiver', 'recipient-b']
+                        : twoPages
+                        ? ['sender', 'receiver', 'successor']
+                        : ['sender', 'receiver']
+                );
                 expect(scenario.laneFamily === 'three-agent', scenario.scenarioKey).toBe(threeRoles);
                 expect(toAlmConformanceRoleRecipe(scenario, 'sender')).toBe(scenario.sender);
                 expect(toAlmConformanceRoleRecipe(scenario, 'receiver')).toBe(scenario.receiver);
                 expect(toAlmConformanceRoleRecipe(scenario, 'recipient-b')).toBe(scenario.recipientB);
                 expect(toAlmConformanceRoleRecipe(scenario, 'successor')).toBe(scenario.successor);
                 expect(scenario.recipientB?.recipeId).toBe(threeRoles ? `alm-${carrier}-${scenario.scenarioKey}-recipient-b` : undefined);
-                expect(scenario.successor).toBeUndefined();
+                expect(scenario.successor?.recipeId).toBe(twoPages ? `alm-${carrier}-${scenario.scenarioKey}-successor` : undefined);
             }
         }
     });
@@ -392,7 +400,7 @@ describe('alm-conformance recipe family', () => {
         }
     });
 
-    it('keeps reload, storage-unavailable and ordering-resync full-only while preserving the smoke scenarios', () => {
+    it('keeps reload, storage-unavailable, ordering-resync and the takeover full-only while preserving the smoke scenarios', () => {
         expect(
             createAlmConformanceRecipes(toConformanceInput('ws'))
                 .filter((scenario) => scenario.tags.includes('smoke'))
@@ -425,7 +433,8 @@ describe('alm-conformance recipe family', () => {
             'receipted-audience',
             'receipted-audience',
             'receipted-audience',
-            'receipted-audience'
+            'receipted-audience',
+            'durable-takeover'
         ]);
         expect(
             createAlmConformanceRecipes(toConformanceInput('rtc')).map((scenario) => scenario.tags)
@@ -446,6 +455,7 @@ describe('alm-conformance recipe family', () => {
             ['full'],
             ['full'],
             ['full'],
+            ['full'],
             ['full']
         ]);
     });
```

- [ ] **Step 2: Run them and see them fail.**

```sh
npx vitest run packages/tests/shared-test/alm-conformance-durable-takeover.test.ts \
  packages/tests/shared-test/alm-conformance-recipes.test.ts \
  packages/tests/shared-test/alm-conformance-recipe-validation.test.ts \
  packages/tests/rallar-black-box/full-stack-same-context-run.test.ts
# Error: Missing durable-takeover with a successor over ws.   (every takeover case)
# × generates the pinned recipe list for every carrier, in scenario order
# × produces carrier-scoped scenarios with distinct command ids and valid schemas
# × selects exactly durable-takeover for the same-context family on every carrier
```

- [ ] **Step 3: Move the shared recovery helpers into the session commands, and the addressed-send helper into the
      receipt commands (both directories stay at 20 files).**

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts
index 3fde283da..764e01edd 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts
@@ -1,3 +1,5 @@
+import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';
+
 import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
 import type {
     RallarBlackBoxTestCommand,
@@ -7,9 +9,11 @@ import type {
 import {
     CONNECT_READINESS_TIMEOUT_MS,
     CONNECT_TIMEOUT_MS,
+    RESPONSE_MARGIN_MS,
     STATS_TIMEOUT_MS,
     toBudgetMs
 } from './alm-conformance-budgets.ts';
+import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';
 import type { AlmConformanceRole } from './alm-conformance-roles.ts';
 import type { AlmConformanceStepInput } from './alm-conformance-scenario-definition.ts';
 import {
@@ -22,10 +26,31 @@ import {
 
 const ENSURE_TIMEOUT_MS = 5_000;
 const CONNECT_READINESS_INTERVAL_MS = 100;
+const STORAGE_TOPIC = 'rallar.browser.alm.storage';
+const OWNER_LEASE_LAPSE_TOPIC = 'rallar.black-box.alm.owner-lease-lapsed';
 
 /** A connect that keeps the auth session its document already holds: no credentials, so it never signs in afresh. */
 export const RESTORED_SESSION_RALLAR = { username: '', password: '', restoreSession: true } as const;
 
+/**
+ * The browser fills an omitted TTL with 30 seconds. The absence proof, the end of the old document, and one
+ * reserved-work lease consume that before the next owner can submit, so an original that must survive its document
+ * states a longer lifetime.
+ */
+const RECOVERY_MARGIN_MS = 60_000;
+
+/**
+ * The browser's store ids, `<prefix>:<sessionId>` (`browser-al-runtime-identity.ts`, which this Deno-loaded catalog
+ * cannot import). The session inbound store batches every engine round. An outbound store reports when its first work
+ * batch runs, which for a store without work can be long after the connect or never before the document ends, so a
+ * wait names the store that holds the original.
+ */
+export const RECOVERED_STORE_PREFIXES = {
+    sessionInbound: 'browser-session-inbound',
+    ws: 'browser-ws-client',
+    rtc: 'browser-rtc-overlay'
+} as const;
+
 export function toEnsureGroupCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
     const group = step.input.group;
     return {
@@ -122,6 +147,21 @@ function toPeerCount(roles: readonly AlmConformanceRole[]): number {
     return roles.filter((role) => role !== 'successor').length;
 }
 
+/**
+ * Holds a successor's connect until the closed owner page's last work lease has lapsed. A held claim stays reserved
+ * until its lease ends, so a takeover before then finds the row leased and its first batch claims nothing; after it,
+ * that batch claims the row. Nothing emits the topic, so the wait only lets the lease run out.
+ */
+export function toOwnerLeaseLapseWait(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
+    return {
+        kind: 'wait',
+        commandId: toCommandId(step, 'owner-lease-lapses'),
+        match: { kind: 'diagnostic', topic: OWNER_LEASE_LAPSE_TOPIC },
+        absent: true,
+        timeoutMs: AL_OUTBOUND_WORK_LEASE_MS + RESPONSE_MARGIN_MS
+    };
+}
+
 export function toStatsCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
     return {
         kind: 'stats',
@@ -141,3 +181,46 @@ function toEnsureRequestId(
 function toStatePrefix(group: RallarBlackBoxDistributedGroupRef): string {
     return `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}`;
 }
+
+export interface AlmConformanceRecoveredStore {
+    readonly name: string;
+    readonly storeIdPrefix: string;
+    readonly lane: '' | '/ws';
+    /** The connect whose result names the session the store id embeds. */
+    readonly connectName: string;
+    readonly timeoutMs: number;
+}
+
+/** The absence window plus the time the next owner of the original needs before it can submit. */
+export function toRecoveryTtlMs(deadlineMs: number): number {
+    return deadlineMs - RESPONSE_MARGIN_MS + RECOVERY_MARGIN_MS;
+}
+
+/** The fallback carrier's hold hands the original to WS before its page ends, so only `rtc` leaves it in the overlay. */
+export function toOriginalStorePrefix(carrier: AlmConformanceCarrier): string {
+    return carrier === 'rtc' ? RECOVERED_STORE_PREFIXES.rtc : RECOVERED_STORE_PREFIXES.ws;
+}
+
+/**
+ * The one `recovery` a durable store, or one lane of a shared store, reports after its first work batch, matched in
+ * its emitted key order (`kind`, `storeId`, `outcome`). The store id embeds the session the named connect restored,
+ * read from that connect's result, and a shared store's lane follows it.
+ */
+export function toStoreRecoveryWait(
+    step: AlmConformanceStepInput,
+    store: AlmConformanceRecoveredStore
+): RallarBlackBoxTestCommand {
+    const sessionId = `{resultCache.${toCommandId(step, store.connectName)}.value.sessionId}`;
+    return {
+        kind: 'wait',
+        commandId: toCommandId(step, store.name),
+        match: {
+            kind: 'diagnostic',
+            topic: STORAGE_TOPIC,
+            payloadPath: 'data',
+            contains:
+                `"kind":"recovery","storeId":"${store.storeIdPrefix}:${sessionId}${store.lane}","outcome":{"kind":"restored"`
+        },
+        timeoutMs: store.timeoutMs
+    };
+}
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
index 9445c807e..e6ca8fe12 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts
@@ -4,7 +4,6 @@ import {
     CONNECT_READINESS_TIMEOUT_MS,
     CONNECT_TIMEOUT_MS,
     NON_EXPIRING_SEND_TIMEOUT_MS,
-    RESPONSE_MARGIN_MS,
     STATS_TIMEOUT_MS
 } from '../alm-conformance-budgets.ts';
 import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
@@ -22,31 +21,17 @@ import {
     type AlmConformanceScenarioDefinition,
     type AlmConformanceStepInput
 } from '../alm-conformance-scenario-definition.ts';
-import { RESTORED_SESSION_RALLAR, toConnectCommand } from '../alm-conformance-session-commands.ts';
+import {
+    RECOVERED_STORE_PREFIXES,
+    RESTORED_SESSION_RALLAR,
+    toConnectCommand,
+    toOriginalStorePrefix,
+    toRecoveryTtlMs,
+    toStoreRecoveryWait
+} from '../alm-conformance-session-commands.ts';
 import { toCommandId } from '../alm-conformance-step-identities.ts';
 import type { AlmReloadCheckpoint } from '../alm-reload-pair.ts';
 
-/**
- * The browser fills an omitted TTL with 30 seconds. The absence proof, the
- * document replacement, and one reserved-work lease consume that before the
- * fresh runtime can submit, so the reload original states a longer lifetime.
- */
-const RELOAD_RECOVERY_MARGIN_MS = 60_000;
-
-const STORAGE_TOPIC = 'rallar.browser.alm.storage';
-
-/**
- * The browser's store ids, `<prefix>:<sessionId>` (`browser-al-runtime-identity.ts`, which this Deno-loaded catalog
- * cannot import). The session inbound store batches every engine round. An outbound store reports when its first work
- * batch runs, which for a store without work can be long after the connect or never before the document ends, so the
- * wait names the store that holds the original.
- */
-export const RELOAD_RECOVERED_STORE_PREFIXES = {
-    sessionInbound: 'browser-session-inbound',
-    ws: 'browser-ws-client',
-    rtc: 'browser-rtc-overlay'
-} as const;
-
 export const deliveryReload: AlmConformanceScenarioDefinition = {
     scenarioId: 'delivery-reload',
     scenarioKey: 'delivery-reload',
@@ -132,21 +117,18 @@ function toDeliveryReloadSenderCommands(sender: AlmConformanceStepInput): readon
  * reporting once.
  */
 function toRecoveredStoreWaits(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
-    const originalStore = sender.input.carrier === 'rtc'
-        ? RELOAD_RECOVERED_STORE_PREFIXES.rtc
-        : RELOAD_RECOVERED_STORE_PREFIXES.ws;
-    const timeoutMs = toReloadSurvivalTtlMs(sender.input.deadlineMs);
+    const timeoutMs = toRecoveryTtlMs(sender.input.deadlineMs);
     return [
         toStoreRecoveryWait(sender, {
             name: 'recovered-session-inbound',
-            storeIdPrefix: RELOAD_RECOVERED_STORE_PREFIXES.sessionInbound,
+            storeIdPrefix: RECOVERED_STORE_PREFIXES.sessionInbound,
             lane: '/ws',
             connectName: 'reconnect',
             timeoutMs
         }),
         toStoreRecoveryWait(sender, {
             name: 'recovered-original-store',
-            storeIdPrefix: originalStore,
+            storeIdPrefix: toOriginalStorePrefix(sender.input.carrier),
             lane: '',
             connectName: 'reconnect',
             timeoutMs
@@ -162,7 +144,7 @@ function toReloadOriginalSend(sender: AlmConformanceStepInput): RallarBlackBoxTe
         delivery: {
             ack: 'receiver',
             durability: 'local-outbox',
-            ttlMs: toReloadSurvivalTtlMs(sender.input.deadlineMs),
+            ttlMs: toRecoveryTtlMs(sender.input.deadlineMs),
             commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
         }
     });
@@ -181,32 +163,3 @@ function toDeliveryReloadReceiverCommands(receiver: AlmConformanceStepInput): re
 function toReloadHealthCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
     return { kind: 'health', commandId: toCommandId(step, name), timeoutMs: STATS_TIMEOUT_MS };
 }
-
-/** The absence window plus the time a reloaded owner needs before it can submit. */
-function toReloadSurvivalTtlMs(deadlineMs: number): number {
-    return deadlineMs - RESPONSE_MARGIN_MS + RELOAD_RECOVERY_MARGIN_MS;
-}
-
-/**
- * The one `recovery` a durable store, or one lane of a shared store, reports after its first work batch, matched in
- * its emitted key order (`kind`, `storeId`, `outcome`). The store id embeds the session the reconnect restored, read
- * from that connect's result, and a shared store's lane follows it.
- */
-function toStoreRecoveryWait(
-    step: AlmConformanceStepInput,
-    store: Readonly<{ name: string; storeIdPrefix: string; lane: '' | '/ws'; connectName: string; timeoutMs: number; }>
-): RallarBlackBoxTestCommand {
-    const sessionId = `{resultCache.${toCommandId(step, store.connectName)}.value.sessionId}`;
-    return {
-        kind: 'wait',
-        commandId: toCommandId(step, store.name),
-        match: {
-            kind: 'diagnostic',
-            topic: STORAGE_TOPIC,
-            payloadPath: 'data',
-            contains:
-                `"kind":"recovery","storeId":"${store.storeIdPrefix}:${sessionId}${store.lane}","outcome":{"kind":"restored"`
-        },
-        timeoutMs: store.timeoutMs
-    };
-}
diff --git a/packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts b/packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts
index 7d9f9e727..77f179ba2 100644
--- a/packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts
+++ b/packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts
@@ -6,11 +6,11 @@ import { toALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailab
 import { createScriptedStorageFaultPort } from '@shared/persistence/storage-fault-port.ts';
 
 import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
+import { RECOVERED_STORE_PREFIXES } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts';
 import {
     createAlmConformanceRecipes,
     type AlmConformanceScenario
 } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
-import { RELOAD_RECOVERED_STORE_PREFIXES } from '@shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts';
 import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
 import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
 import {
@@ -258,10 +258,10 @@ describe('delivery-reload recovery reads', () => {
             .recordRecovery({ kind: 'restored', claimed: 0, expired: 0 }, 'ws');
 
         expect(events.map((event) => event.kind === 'recovery' ? event.storeId : event.kind)).toEqual([
-            `${RELOAD_RECOVERED_STORE_PREFIXES.sessionInbound}:s/ws`
+            `${RECOVERED_STORE_PREFIXES.sessionInbound}:s/ws`
         ]);
-        expect(`${RELOAD_RECOVERED_STORE_PREFIXES.sessionInbound}:s`).toBe(String(toBrowserSessionALInboundRuntimeStoreId('s')));
-        expect(`${RELOAD_RECOVERED_STORE_PREFIXES.ws}:s`).toBe(String(toBrowserWsClientALRuntimeStoreId('s')));
-        expect(`${RELOAD_RECOVERED_STORE_PREFIXES.rtc}:s`).toBe(String(toBrowserRtcOverlayALRuntimeStoreId('s')));
+        expect(`${RECOVERED_STORE_PREFIXES.sessionInbound}:s`).toBe(String(toBrowserSessionALInboundRuntimeStoreId('s')));
+        expect(`${RECOVERED_STORE_PREFIXES.ws}:s`).toBe(String(toBrowserWsClientALRuntimeStoreId('s')));
+        expect(`${RECOVERED_STORE_PREFIXES.rtc}:s`).toBe(String(toBrowserRtcOverlayALRuntimeStoreId('s')));
     });
 });
```

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-receipt-commands.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-receipt-commands.ts
index 2371998e9..2002fab70 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-receipt-commands.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-receipt-commands.ts
@@ -1,15 +1,20 @@
 import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
 
-import type { RallarBlackBoxTestCommand } from '../../rallar-black-box-test-contracts.ts';
+import type {
+    RallarBlackBoxTestCommand,
+    RallarBlackBoxTestMessagesSendCommand
+} from '../../rallar-black-box-test-contracts.ts';
 
 import {
     NON_EXPIRING_SEND_TIMEOUT_MS,
+    NON_EXPIRING_TTL_MS,
     RESPONSE_MARGIN_MS,
     toBudgetMs
 } from './alm-conformance-budgets.ts';
 import { FAULT_TIMEOUT_MS } from './alm-conformance-fault-commands.ts';
 import {
     toAdmissionCommands,
+    toObserveCommand,
     toReceiptsCommand,
     toResultAssertion,
     toSendCommand
@@ -32,6 +37,28 @@ interface AlmConformanceAudienceSendInput {
     readonly ttlMs: number;
 }
 
+/** The first send of an addressed scenario, admitted and observed until its addressee acknowledges it. */
+export function toAddressedSendCommands(
+    sender: AlmConformanceStepInput,
+    toPeer: NonNullable<RallarBlackBoxTestMessagesSendCommand['toPeer']>
+): readonly RallarBlackBoxTestCommand[] {
+    return [
+        toSendCommand({
+            ...sender,
+            index: 1,
+            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
+            delivery: {
+                toPeer,
+                ack: 'receiver',
+                ttlMs: NON_EXPIRING_TTL_MS,
+                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
+            }
+        }),
+        ...toAdmissionCommands({ ...sender, index: 1 }),
+        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' })
+    ];
+}
+
 /**
  * One room send that asks for every logical recipient of the audience frozen at its admission (D41): the request
  * name maps to `receiver`, so the receipt of the origin expects that audience minus itself.
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/server-command.ts b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/server-command.ts
index 890391395..b68459d1e 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/server-command.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/server-command.ts
@@ -2,6 +2,7 @@ import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-c
 
 import type { AlmConformanceCarrier } from '../alm-conformance-carriers.ts';
 import { toAddresseeReceiptAssertions } from '../alm-conformance-message-commands.ts';
+import { toAddressedSendCommands } from '../alm-conformance-receipt-commands.ts';
 import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
 import {
     FULL_TAGS,
@@ -9,8 +10,6 @@ import {
     type AlmConformanceStepInput
 } from '../alm-conformance-scenario-definition.ts';
 
-import { toAddressedSendCommands } from './to-addressed-send-commands.ts';
-
 /** The server is no RTC peer: an RTC strategy refuses a send addressed to it before admission. */
 const SERVER_COMMAND_CARRIERS: readonly AlmConformanceCarrier[] = ['ws'];
 
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/to-addressed-send-commands.ts b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/to-addressed-send-commands.ts
deleted file mode 100644
index 1c7ac7273..000000000
--- a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/to-addressed-send-commands.ts
+++ /dev/null
@@ -1,30 +0,0 @@
-import type {
-    RallarBlackBoxTestCommand,
-    RallarBlackBoxTestMessagesSendCommand
-} from '../../../rallar-black-box-test-contracts.ts';
-
-import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../alm-conformance-budgets.ts';
-import { toAdmissionCommands, toObserveCommand, toSendCommand } from '../alm-conformance-message-commands.ts';
-import type { AlmConformanceStepInput } from '../alm-conformance-scenario-definition.ts';
-
-/** The first send of an addressed scenario, admitted and observed until its addressee acknowledges it. */
-export function toAddressedSendCommands(
-    sender: AlmConformanceStepInput,
-    toPeer: NonNullable<RallarBlackBoxTestMessagesSendCommand['toPeer']>
-): readonly RallarBlackBoxTestCommand[] {
-    return [
-        toSendCommand({
-            ...sender,
-            index: 1,
-            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
-            delivery: {
-                toPeer,
-                ack: 'receiver',
-                ttlMs: NON_EXPIRING_TTL_MS,
-                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
-            }
-        }),
-        ...toAdmissionCommands({ ...sender, index: 1 }),
-        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' })
-    ];
-}
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/unicast-fallback.ts b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/unicast-fallback.ts
index fe01f1784..e0d8a866c 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/unicast-fallback.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/unicast-fallback.ts
@@ -3,10 +3,8 @@ import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-c
 import { MESSAGE_CONTROL_TIMEOUT_MS, toBudgetMs } from '../alm-conformance-budgets.ts';
 import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';
 import { toRtcDropFaultCommand } from '../alm-conformance-fault-commands.ts';
-import {
-    toHandedOverAssertions,
-    toResultAssertion
-} from '../alm-conformance-message-commands.ts';
+import { toHandedOverAssertions, toResultAssertion } from '../alm-conformance-message-commands.ts';
+import { toAddressedSendCommands } from '../alm-conformance-receipt-commands.ts';
 import { toAdmissionOutcomeWait, toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
 import {
     FULL_TAGS,
@@ -14,8 +12,6 @@ import {
     type AlmConformanceStepInput
 } from '../alm-conformance-scenario-definition.ts';
 
-import { toAddressedSendCommands } from './to-addressed-send-commands.ts';
-
 const HAND_OVER = [['from', 'rtc'], ['to', 'ws'], ['reason', 'not-ready']] as const;
 
 /**
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/ws-unicast-receipt.ts b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/ws-unicast-receipt.ts
index 29711f572..bf1be1575 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/ws-unicast-receipt.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/scenarios/ws-unicast-receipt.ts
@@ -1,11 +1,8 @@
 import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';
 
 import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
-import {
-    toAddresseeReceiptAssertions,
-    toReceiptsCommand
-} from '../alm-conformance-message-commands.ts';
-import type { AlmConformanceReceiptRoles } from '../alm-conformance-receipt-commands.ts';
+import { toAddresseeReceiptAssertions, toReceiptsCommand } from '../alm-conformance-message-commands.ts';
+import { toAddressedSendCommands, type AlmConformanceReceiptRoles } from '../alm-conformance-receipt-commands.ts';
 import { toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
 import {
     FULL_TAGS,
@@ -13,8 +10,6 @@ import {
     type AlmConformanceStepInput
 } from '../alm-conformance-scenario-definition.ts';
 
-import { toAddressedSendCommands } from './to-addressed-send-commands.ts';
-
 const RECEIVER_CONFIRMED: AlmConformanceReceiptRoles = { confirmed: ['receiver'], unconfirmed: [] };
 
 /**
```

- [ ] **Step 4: The scenario.** Create `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/durable-takeover.ts`:

<!-- dprint-ignore -->
```ts
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { CONNECT_TIMEOUT_MS, NON_EXPIRING_SEND_TIMEOUT_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../alm-conformance-carriers.ts';
import { toHeldFaultCommands } from '../alm-conformance-fault-commands.ts';
import { toResultAssertion, toRetainedEvidenceCommands, toSendCommand } from '../alm-conformance-message-commands.ts';
import { toPayloadWait, toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';
import { toOriginalStorePrefix, toRecoveryTtlMs, toStoreRecoveryWait } from '../alm-conformance-session-commands.ts';

/**
 * One durable owner per session: the sender's page admits a durable send it cannot deliver and closes, and the
 * successor, a second page of the same browser context and session, connects once that page's lease has lapsed, takes
 * the session's durable work over, reports the original's store restored with the row claimed, and delivers the
 * original once.
 */
export const durableTakeover: AlmConformanceScenarioDefinition = {
    scenarioId: 'durable-takeover',
    scenarioKey: 'durable-takeover',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver', 'successor'],
    laneFamily: 'same-context',
    toSenderCommands: (page) => page.role === 'successor' ? toSuccessorCommands(page) : toOwnerCommands(page),
    toRecipientCommands: toDurableTakeoverReceiverCommands
};

/** The native hold ends only with the owner's page, so no attempt of the owner ever leaves it. */
function toOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldFaultCommands(owner, 'takeover-hold', 'until-cleared'),
        toSendCommand({
            ...owner,
            index: 1,
            payload: toPayload(owner),
            delivery: {
                ack: 'receiver',
                durability: 'local-outbox',
                ttlMs: toRecoveryTtlMs(owner.input.deadlineMs),
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toRetainedEvidenceCommands({ ...owner, index: 1 }, true)
    ];
}

/** The takeover's first batch claims the original from the store that held it; the recovery it reports says so. */
function toSuccessorCommands(successor: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toStoreRecoveryWait(successor, {
            name: 'recovered-original-store',
            storeIdPrefix: toOriginalStorePrefix(successor.input.carrier),
            lane: '',
            connectName: 'connect',
            timeoutMs: toRecoveryTtlMs(successor.input.deadlineMs)
        }),
        toResultAssertion({
            step: successor,
            name: 'assert-recovered-claimed',
            resultName: 'recovered-original-store',
            field: 'event.payload.data.outcome.claimed',
            operator: 'gt',
            expected: 0
        })
    ];
}

/**
 * The arrival wait starts before the sender connects, so it covers that connect and the original's whole lifetime;
 * the trailing window proves no second copy follows the first.
 */
function toDurableTakeoverReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
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

Register it, and give every successor the lease-lapse wait before its connect:

```diff
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
index a6db36ef2..1bae63f75 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts
@@ -24,6 +24,7 @@ export type AlmConformanceScenarioId =
     | 'delivery-lifecycle'
     | 'delivery-reload'
     | 'durable-opt-in'
+    | 'durable-takeover'
     | 'fallback-within-deadline'
     | 'no-fallback-after-deadline'
     | 'not-yet-in-sync'
diff --git a/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts b/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
index e872d86ec..2459b6db9 100644
--- a/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
+++ b/packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts
@@ -25,6 +25,7 @@ import {
     toConnectCommand,
     toEnsureGroupCommand,
     toEnsureMemberCommand,
+    toOwnerLeaseLapseWait,
     toStatsCommand
 } from './alm-conformance-session-commands.ts';
 import { toRoomRef, toSendHandleId } from './alm-conformance-step-identities.ts';
@@ -36,6 +37,7 @@ import { deliveryBaseline } from './scenarios/delivery-baseline.ts';
 import { deliveryLifecycle } from './scenarios/delivery-lifecycle.ts';
 import { deliveryReload, toReloadCheckpoint } from './scenarios/delivery-reload.ts';
 import { durableOptIn } from './scenarios/durable-opt-in.ts';
+import { durableTakeover } from './scenarios/durable-takeover.ts';
 import { fallbackWithinDeadline } from './scenarios/fallback-within-deadline.ts';
 import { noFallbackAfterDeadline } from './scenarios/no-fallback-after-deadline.ts';
 import { notYetInSync } from './scenarios/not-yet-in-sync.ts';
@@ -100,7 +102,8 @@ const ALM_CONFORMANCE_SCENARIOS: readonly AlmConformanceScenarioDefinition[] = [
     unicastFallback,
     serverCommand,
     capacity,
-    ...receiptedAudience
+    ...receiptedAudience,
+    durableTakeover
 ];
 
 export function createAlmConformanceRecipes(
@@ -177,6 +180,7 @@ function toAlmConformanceRecipe(recipe: AlmConformanceRecipeInput): RallarBlackB
         commands: [
             toEnsureGroupCommand(recipe),
             toEnsureMemberCommand(recipe),
+            ...(recipe.role === 'successor' ? [toOwnerLeaseLapseWait(recipe)] : []),
             toConnectCommand(recipe),
             ...toConnectedStorageCountersCommands(recipe),
             ...recipe.commands,
```

- [ ] **Step 5: The Deno control fixture models the takeover (red first).** Add the per-carrier test and the
      `isHeldOriginal` model:

```diff
diff --git a/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts b/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
index 973f9f636..e2f724b2c 100644
--- a/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
+++ b/apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts
@@ -1,7 +1,9 @@
 import { assert, assertEquals } from '@std/assert';
 
 import { toAgentReloadResult } from '@shared-test/rallar-bb-test/alm/browser-control-agent-resume.ts';
+import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
 import { toAlmReloadPair } from '@shared-test/rallar-bb-test/conformance/alm/alm-reload-pair.ts';
+import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
 import type { ControlCommandEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
 import type {
     RallarBlackBoxTestCommand,
@@ -9,6 +11,7 @@ import type {
     RallarBlackBoxTestFaultInjectCommand,
     RallarBlackBoxTestMessagesReplayCommand,
     RallarBlackBoxTestMessagesSendCommand,
+    RallarBlackBoxTestRecipe,
     RallarBlackBoxTestResult,
     RallarBlackBoxTestRuntime
 } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
@@ -297,32 +300,32 @@ class GeneratedAlmPorts {
         };
     }
 
+    /** The next page of the sender's session, a reloaded document or a successor page, sends what the last one held. */
     private deliverRecoveredOriginals(role: 'sender' | 'receiver'): void {
         if (role !== 'sender') {
             return;
         }
-        for (const message of this.messages) {
-            if (isJsonRecordValue(message.command.payload) && message.command.payload.marker === 'delivery-reload' && !message.submitted) {
-                this.deliver(message);
-            }
+        for (const message of this.messages.filter(isHeldOriginal)) {
+            this.deliver(message);
         }
     }
 
     /**
      * Every durable store of the page reports what it restored once its first batch ran, the session inbound store once
-     * per carrier lane; the fixture runs it at connect.
+     * per carrier lane; the fixture runs it at connect. An outbound store claims the originals the last page held in it.
      */
     private reportStoreRecoveries(role: 'sender' | 'receiver', sessionId: string): void {
         if (role !== 'sender') {
             return;
         }
-        const storeIds = [
-            `browser-session-inbound:${sessionId}/ws`,
-            `browser-session-inbound:${sessionId}/rtc`,
-            `browser-ws-client:${sessionId}`,
-            `browser-rtc-overlay:${sessionId}`
+        const held = this.messages.filter((message) => isHeldOriginal(message));
+        const stores = [
+            { storeId: `browser-session-inbound:${sessionId}/ws`, claimed: 0 },
+            { storeId: `browser-session-inbound:${sessionId}/rtc`, claimed: 0 },
+            { storeId: `browser-ws-client:${sessionId}`, claimed: held.filter((message) => message.command.carrier !== 'rtc').length },
+            { storeId: `browser-rtc-overlay:${sessionId}`, claimed: held.filter((message) => message.command.carrier === 'rtc').length }
         ];
-        for (const storeId of storeIds) {
+        for (const { storeId, claimed } of stores) {
             this.sender.recordEvent({
                 kind: 'diagnostic',
                 topic: 'rallar.browser.alm.storage',
@@ -330,7 +333,7 @@ class GeneratedAlmPorts {
                     data: {
                         kind: 'recovery',
                         storeId,
-                        outcome: { kind: 'restored', claimed: 0, expired: 0 }
+                        outcome: { kind: 'restored', claimed, expired: 0 }
                     }
                 }
             });
@@ -773,6 +776,43 @@ for (const replacesDocument of [true, false]) {
     });
 }
 
+/** A durable original a page held when it ended: a reloaded document's or a closed owner page's. */
+function isHeldOriginal(message: PortMessage): boolean {
+    const marker = isJsonRecordValue(message.command.payload) ? message.command.payload.marker : undefined;
+    return (marker === 'delivery-reload' || marker === 'durable-takeover') && !message.submitted;
+}
+
+for (const carrier of ALM_CONFORMANCE_CARRIERS) {
+    Deno.test(`the lane's ${carrier} takeover hands the closed owner's held original to its successor, delivered once`, async () => {
+        const scenario = createAlmConformanceRecipes({
+            group: { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
+            carrier,
+            typeId: 'alm.conformance',
+            senderConnection: 'almConformanceSender',
+            receiverConnection: 'almConformanceReceiver',
+            deadlineMs: 18_000
+        }).find((candidate) => candidate.scenarioId === 'durable-takeover');
+        assert(scenario?.successor);
+        const ports = new GeneratedAlmPorts(true);
+
+        const owner = await ports.sender.execute(toRecipeRun(scenario.sender));
+        const held = ports.messages.filter((message) => isJsonRecordValue(message.command.payload) && message.command.payload.marker === 'durable-takeover');
+        assertEquals(held.map((message) => message.submitted), [false], 'the owner\'s hold keeps its original from the carrier');
+        ports.replaceSenderDocument();
+        const successor = await ports.sender.execute(toRecipeRun(scenario.successor));
+        const receiver = await ports.receiver.execute(toRecipeRun(scenario.receiver));
+
+        for (const [role, result] of [['owner', owner], ['successor', successor], ['receiver', receiver]] as const) {
+            assertEquals(result.ok, true, `${role}: ${JSON.stringify(result)}`);
+        }
+        assertEquals(held.map((message) => message.submitted), [true], 'the successor sends the original once');
+    });
+}
+
+function toRecipeRun(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestCommand {
+    return { kind: 'recipe.run', commandId: `${recipe.recipeId}-run`, recipe };
+}
+
 async function executeSegment(service: RallarBlackBoxControlService, runtime: RallarBlackBoxTestRuntime, envelope: ControlCommandEnvelope): Promise<void> {
     assert(envelope, 'expected an actual control dispatch');
     const result = await runtime.execute({ ...envelope.command, deadlineEpochMs: envelope.deadlineEpochMs });
```

Red, recorded: with `deliverRecoveredOriginals` still matching only `delivery-reload`, each takeover test fails at
`alm-<carrier>-durable-takeover-receiver-receive-original` (`RALLAR_BLACK_BOX_WAIT_TIMEOUT`, `timeoutMs` 122000; the
wait times out on the real clock, 2 min 2 s per carrier); with every store's `claimed` kept at 0, each fails at
`…-successor-assert-recovered-claimed` (`actual: 0`). The two hosted-manifest tests stay green throughout.

- [ ] **Step 6: The navigation map.**

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
index 93c1f1d73..33b190fb9 100644
--- a/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
+++ b/packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
@@ -386,11 +386,11 @@ restores the sender's session rather than signing in afresh. Its connect waits f
 the receiver's do, since both pages are one session and so one peer. The two pages are never connected at once: the
 server keeps one WebSocket per auth session and a second upgrade closes the first with `connection-replaced`, after
 which the first page reconnects and replaces the second. The lane therefore starts the receiver, runs the sender's
-recipe, closes the sender's page from Playwright, and only then runs the successor's recipe; no control command closes
-a page. No `reset` runs on a successor page, since it would clear the storage both pages share. Each scenario opens its
-own successor, which owns the session for the next one. The Hetzner entries select their scenarios by lane family
-(`two-agent` and `addressed` for manifest 18, `three-agent` for manifest 22), so neither carries this family: a
-hosted agent has no second page in its context.
+recipe, closes the sender's page from Playwright, and only then runs the successor's recipe, whose prologue waits out
+the owner page's last work lease before its connect; no control command closes a page. No `reset` runs on a successor
+page, since it would clear the storage both pages share. Each scenario opens its own successor, which owns the session
+for the next one. The Hetzner entries select their scenarios by lane family (`two-agent` and `addressed` for manifest
+18, `three-agent` for manifest 22), so neither carries this family: a hosted agent has no second page in its context.
 
 `messages.observe` waits on the in-page message handle; `messages.receipts` reads
 its current lifecycle without waiting. The shared states are `submitted`,
@@ -532,6 +532,20 @@ the waits are tied to the cell, not to a store: they cannot show which store tur
 healthy. And the healthy wait proves only that some store recovered after the release: a release of an earlier cell's
 leftover rows can read it healthy, so the third send's own commit is proven by `assert-enqueued-3`, not by the wait.
 
+`durable-takeover` runs over every carrier in the same-context family. The sender's page holds its carrier with the
+same native hold as `delivery-reload`, sends one durable original with `ack: 'receiver'` and a `ttlMs` of the
+absence window plus 60 s (above one 10 s lease, the 19.1 s recovery bound and a whole successor connect), and proves
+it admitted, enqueued, retained and unsubmitted. The lane then closes that page. Under the hold the row stays
+reserved until its lease ends, so a successor's prologue first waits out one lease and a margin (an absent wait on a
+topic nothing emits) before it connects: its takeover's first batch then claims the row rather than finding it leased.
+The successor connects with the restored session, waits for the one `recovery` of the store that held the original
+(`browser-rtc-overlay` over `rtc`, `browser-ws-client` otherwise) reading `restored`, the store id embedding the
+session its own connect restored, and asserts that outcome's `claimed` above 0. The receiver waits for the
+carrier-tagged original over the sender's connect plus the original's lifetime, then proves for an absence window
+that no second copy arrives. A takeover while the owner's lease still stands, recovered by a later batch at the lease
+end plus at most 19.1 s, is not run by the lane: that path claims in a batch that reports nothing, and the server
+keeps one socket per auth session, so the successor cannot connect before the owner's page is gone.
+
 `agent.reload` asks the control agent to reload its page and resume the run. The
 agent records the run id, its agent id and the command ids it already completed
 in `localStorage` under `rallar-bb-agent-resume`, replays that record on
```

- [ ] **Step 7: Format the touched files only; run the focused tests green.**

```sh
npx dprint fmt apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-receipt-commands.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/scenarios/durable-takeover.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/scenarios/server-command.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/scenarios/unicast-fallback.ts \
  packages/shared-test/rallar-bb-test/conformance/alm/scenarios/ws-unicast-receipt.ts \
  packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md \
  packages/tests/rallar-black-box/full-stack-same-context-run.test.ts \
  packages/tests/shared-test/alm-conformance-durable-takeover.test.ts \
  packages/tests/shared-test/alm-conformance-recipe-validation.test.ts \
  packages/tests/shared-test/alm-conformance-recipes.test.ts \
  packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts
npx vitest run packages/tests/shared-test/alm-conformance-durable-takeover.test.ts
# Tests  19 passed (19)
```

- [ ] **Step 8: The task's checks.** Measured on `64a2276a6` (sandbox off for the port-binding suites, tsx and Deno):

```sh
npx vitest run packages/tests/shared-test packages/tests/rallar-black-box
# Test Files  372 passed (372)   Tests  4010 passed (4010)
npx tsc -p packages/shared-test/tsconfig.json --noEmit                 # exit 0
(cd apps/rallar-black-box && npx tsc --noEmit)                         # exit 0
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1429 test files enforced, 0 files carrying known debt (0 errors).  PASS
WT=/Users/knuthelge/ProjectLocker/github/ar-eye-hunter/.claude/worktrees/alm-i2a-ii
cat > $TMPDIR/tsconfig.playwright.json <<EOF
{ "extends": "$WT/packages/tests/tsconfig.json",
  "compilerOptions": { "noEmit": true, "typeRoots": ["$WT/node_modules/@types"], "types": ["node"] },
  "include": ["$WT/tests/playwright/rallar-black-box/**/*.ts"] }
EOF
npx tsc -p $TMPDIR/tsconfig.playwright.json   # Task 5's scratch tsconfig
# the same 28 errors as on ee510bbb0, none in a touched file
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
# checked 67 Hetzner distributed manifest(s)
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts && git diff --quiet -- apps/rallar-black-box/manifests
# byte-identical (manifests 18 and 22 carry no takeover cell; delivery-reload's moved helpers emit the same JSON)
(cd apps/rallar-black-box-control-server && deno task check && deno task test)
# check exit 0; ok | 195 passed | 0 failed   (192 + the three takeover tests)
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS ×3
npm run check:test-reachability
# Test reachability: 1731 test files, 1725 reached by CI, 6 manual.
```

Bundles: `browser/rallar.ts` 232.975 KiB and headless 297.686 KiB, identical to `ee510bbb0` (brotli q11): the
catalog is not in either bundle. On the assembled tree after Tasks 1–5 it stays 234.219 and 298.756 KiB (budgets 235
and 299): this task adds nothing. On the assembled tree the control server reads `ok | 195 passed | 0 failed` and the
focused run `Test Files  372 passed (372)`, `Tests  4010 passed (4010)`. The lane
is not run here (ports off limits); Task 8 runs the `same-context family over <carrier>` test on every carrier in
the full scope (`RALLAR_BLACK_BOX_ALM_SCOPE=full`). Expected cost per carrier cell: two connects, the 11 s lease wait,
the successor's connect and the 17 s absence window, about 40 s, well inside `CARRIER_TEST_TIMEOUT_MS` (480 s).

- [ ] **Step 9: Commit.**

```sh
git add apps/rallar-black-box-control-server/test/control-generated-alm-reload.test.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-receipt-commands.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-reload.ts packages/shared-test/rallar-bb-test/conformance/alm/scenarios/durable-takeover.ts packages/shared-test/rallar-bb-test/conformance/alm/scenarios/server-command.ts packages/shared-test/rallar-bb-test/conformance/alm/scenarios/to-addressed-send-commands.ts packages/shared-test/rallar-bb-test/conformance/alm/scenarios/unicast-fallback.ts packages/shared-test/rallar-bb-test/conformance/alm/scenarios/ws-unicast-receipt.ts packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md packages/tests/rallar-black-box/full-stack-same-context-run.test.ts packages/tests/shared-test/alm-conformance-durable-takeover.test.ts packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-conformance-storage-unavailable.test.ts
git commit -F - <<'MSG'
The durable-takeover scenario: a successor page takes over the session's held original

A same-context scenario over every carrier, in the full scope. The sender's page holds its
carrier, admits one durable original with ack 'receiver' and a lifetime above one lease, the
lease-recovery bound and a whole successor connect, proves it retained and unsubmitted, and is
closed by the lane. A held claim stays reserved until its lease ends, so the successor, a
second page of the same context and session, waits out that lease before it connects; its
takeover's first batch then claims the row, and it reads the original's store restored with
claimed above 0. The receiver gets the carrier-tagged original once. The hosted manifests are
unchanged (the family is Playwright-only) and regenerate byte-identical; the Deno control
fixture models the takeover.

D8 reuse: the store-recovery wait, the original-store choice and the recovery lifetime move out of delivery-reload into the session commands beside the restored-session connect, unchanged in output, and the addressed-send helper joins the receipt commands so neither directory grows; the hold, send, retained-evidence, payload-wait, received and assert commands, capacity's absent-wait delay and the control fixture's ports are reused as they are.

MSG
```

---

### Task 7: Relic Hunters' server commands move to `local-outbox`

Prototyped in scratch as commit `a75d8784e` on `ee510bbb0` (red then green; scratch `f819991ff` on the
assembled tree). Proposal §3.k, decision 8
(D126), R-I2a-ii-12.

**Files**

- Modify: `apps/relic-hunters-v1/src/game/send-relic-ws-command.ts` (`:28-33`) — the room channel definition gains
  `durability: 'local-outbox'` and `onStorageUnavailable: 'refuse'`. Nothing else in the sender changes.
- Modify: `apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts` (`:50-55`) — the deep-equality pin on the
  definition is updated to the intended definition.
- Modify: `apps/relic-hunters-v1/docs/runtime-data-flow.md` (the "Command Path" section, `:46-50`) — one paragraph
  states the durability, the refusal and what stops a repeat. `apps/relic-hunters-v1/docs/current-state.md` names the
  channel without describing it and needs no edit.
- Not touched: `relic-hunters-runtime.ts`, `to-relic-command-phase.ts` (a `failed` delivery already reads as
  `The server did not confirm the command (failed): storage-unavailable` and does not fall back to REST: the
  runtime sends over REST only when `sendRelicWsCommand` returns undefined, before a server id is known),
  `packages/shared-web` (the definition fields exist at `browser/messages/rallar-message-contracts.ts:111-123`, the
  default is `'refuse'` at `browser-typed-message-channels.ts:46`, and the policy validator accepts any purpose with
  `local-outbox`, `validate-rallar-typed-channel-policy.ts:17-56`), the server (`relic-game-service.ts:156-191`,
  `apply-relic-ws-command.ts`), the Relic model (no command id).

**Interfaces**

- Consumes: `RallarTypedMessageChannelDefinition.durability` and `.onStorageUnavailable` (existing).
- Produces: nothing new. The command channel is `{ topicId, typeId, purpose: 'command', roomId, durability:
  'local-outbox', onStorageUnavailable: 'refuse' }`. `refuse` is the library default; it is written explicitly so the
  Relic command channel's refusal does not depend on a default (R-I2a-ii-12).

**D8 reuse inspection.** Reused: the channel definition's own `durability` and `onStorageUnavailable` fields, the
I2a-i storage-truth path (a failed store reads `failed` with `storage-unavailable`), the ALM msgId dedup that the
server's inbound path already applies within deadline plus grace (I2a-i), the existing receipt wait and
`toRelicCommandPhase`. Not added: no idempotency key and no command id in the Relic model (D126, I2b's Relic
Playwright proof decides), no REST fallback after a refused store, no shared-web change, no new test file.

**Limits (state these in the PR body and in the plan's Limits).**

- A command resumed after a reload keeps its msgId and deadline. The 30 s command deadline plus grace sits inside the
  60 s dedup floor, so the server re-acknowledges a repeat of an admitted command within deadline plus grace without
  applying it, and drops one past its deadline as `expired`.
- Beyond that window there is no protection: the Relic model has no command id, so nothing but ALM msgId dedup stops a
  repeat. What a repeat that does reach `applyRelicCommand` does, per kind (`packages/relic-hunters/src/rules.ts:180-310`):

  | Command kind          | Lines              | Effect of a repeat                                                    |
  | --------------------- | ------------------ | --------------------------------------------------------------------- |
  | `join-expedition`     | `:196-201`         | Idempotent (`ensurePlayer`)                                           |
  | `start-expedition`    | `:203-224`         | Phase unchanged, but appends another "started" event                  |
  | `set-round-limit`     | `:226-237`         | Idempotent for the same value                                         |
  | `continue-review`     | `:248-260`         | Not idempotent: throws, or advances a later review                    |
  | `force-resolve-round` | `:271-280`         | Not idempotent if the timer expired again                             |
  | `pickup-relic`        | `:282-287`, `:596` | Throws "Relic has already been claimed."                              |
  | `submit-action`       | `:289-310`         | Overwrites the pending action; lands in a later round if one resolved |

  These kinds are covered only by msgId dedup within deadline plus grace (D126, no idempotency key). A server-side
  rule error on the WS path is logged there and not shown in the browser (the stated reply-channel regression), as today.
- A browser whose storage is unavailable now reports the command `failed` (`storage-unavailable`) and sends nothing;
  before this task it sent unstored. The UI shows the existing "did not confirm" text; the command is not retried over REST.
- Relic's Playwright suites stay manual (`tests/manual-suites.json`); no spec in this task reloads mid-command. The
  durable resume of a Relic command is proved by the shared ALM conformance scenarios, not by a Relic spec (I2b).

- [ ] **Step 1: Update the pin (red).** In `apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts` replace

<!-- dprint-ignore -->
```ts
        expect(roomDefinitions).toEqual([{
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            purpose: 'command',
            roomId: 'room-42'
        }]);
```

with

<!-- dprint-ignore -->
```ts
        expect(roomDefinitions).toEqual([{
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            purpose: 'command',
            roomId: 'room-42',
            durability: 'local-outbox',
            onStorageUnavailable: 'refuse'
        }]);
```

- [ ] **Step 2: Run it and see it fail.**

```sh
npx vitest run apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts 2>&1 | tail -6
# the diff shows the two missing fields:  - "durability": "local-outbox",  - "onStorageUnavailable": "refuse",
#  Test Files  1 failed (1)
#       Tests  1 failed | 1 passed (2)
```

- [ ] **Step 3: Change the channel definition.** In `apps/relic-hunters-v1/src/game/send-relic-ws-command.ts` replace

<!-- dprint-ignore -->
```ts
            purpose: 'command',
            roomId
        })
```

with

<!-- dprint-ignore -->
```ts
            purpose: 'command',
            roomId,
            durability: 'local-outbox',
            onStorageUnavailable: 'refuse'
        })
```

- [ ] **Step 4: Run it green, then the Relic roots and the workspace typecheck.**

```sh
npx vitest run apps/relic-hunters-v1/tests packages/tests/relic-hunters 2>&1 | tail -6
#  Test Files  31 passed (31)
#       Tests  187 passed (187)
npm --workspace relic-hunters-v1 run typecheck 2>&1 | tail -3     # tsc --noEmit, exit 0
```

(The Vitest roots are `apps/relic-hunters-v1/tests/**/*.test.ts` and `packages/tests/**`, `vitest.config.ts` `SUITE_TESTS`.)

- [ ] **Step 5: The docs paragraph.** In `apps/relic-hunters-v1/docs/runtime-data-flow.md`, "Command Path", end the first
      paragraph with a full stop instead of a colon (`through the outbox with receipts.`) and insert, before the
      `` ```text `` block:

```md
The command channel is `local-outbox` with `onStorageUnavailable: 'refuse'`: the command is stored before it leaves, so
a reload resumes it under the same message id and deadline (30 s), and a browser whose storage is unavailable reports
the command failed instead of sending it unstored. There is no command id in the model, so only the ALM message-id dedup
within the deadline plus grace stops a repeat: the server re-acknowledges a resumed command it already admitted without
applying it again, and drops one past its deadline as expired.
```

- [ ] **Step 6: Format and check.**

```sh
npx dprint fmt apps/relic-hunters-v1/src/game/send-relic-ws-command.ts apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts apps/relic-hunters-v1/docs/runtime-data-flow.md
npx dprint check apps/relic-hunters-v1/src/game/send-relic-ws-command.ts apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts apps/relic-hunters-v1/docs/runtime-data-flow.md   # exit 0
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1426 test files enforced, 0 files carrying known debt (0 errors).
# PASS: no new type errors in the maintained test project
```

- [ ] **Step 7: Commit.**

```sh
git add apps/relic-hunters-v1/src/game/send-relic-ws-command.ts apps/relic-hunters-v1/tests/send-relic-ws-command.test.ts apps/relic-hunters-v1/docs/runtime-data-flow.md
git commit -m "Send Relic commands through the local outbox

The command channel stores a command before it leaves and refuses it when
storage is unavailable, so a reload resumes it under the same message id and
deadline. D8 reuse: the existing channel durability and onStorageUnavailable
fields; no idempotency key."
```

- [ ] **Step 8: Changed-range gates (need the commit).**

```sh
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings (… -> HEAD).
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: no current structure-coupled test candidates
# PASS: changed-range structure-coupling review has complete individual classifications
# PASS: registry entries are complete and current
```

No bundle measurement: nothing under `packages/shared` or `packages/shared-web` changes (the Relic app is not one of
the two budgeted bundles). `npm run check:test-reachability` is not needed (no test file added or deleted); no
black-box recipe changes (no REST or server change).

**Measured.** Red then green as above; 31 Relic-root files, 187 tests pass; the workspace typecheck, the tests
typecheck, dprint, the changed-style and the coupling gates pass.

---

### Task 8: Close: pins, gates, hosted proofs, the PR body and the plan file

Runs after tasks 1–7 are committed, reviewed and pushed. It confirms the pins did not move, runs the local merge bar,
runs one final whole-branch review with one fix wave, takes the branch through the Branch Release Gate, the hosted
ALM manifests and the ALM observation (the `durable-takeover` scenario runs in the local full lane only: D124, R-I2a-ii-1, -2, -35), publishes
the PR title and body, and deletes this plan file in its last commit. It never merges and never takes the PR out of
draft on its own.

**Files**

- Modify: `playground/alm/alm-qos-product-plan.md` §8 (the "One durable owner per session store" bullet reading "Delivered
  (I2a-ii, <H1>)"), `packages/shared-web/bundle-budgets.json` and
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` only if a budget is crossed.
- Modify (fix wave only): the files the final review's Critical and Important findings name.
- Delete (last commit): `plans/active/alm-i2a-ii-one-durable-owner-implementation-plan.md`.
- Create (never committed): `tmp/i2a-ii-task8/**` (logs, artifacts, `pr-body.md`, `hosted.md`).
- Test: the local merge bar (steps 3–7); no new test file.

**Interfaces**

- Consumes: tasks 1–7 pushed; the ledger and cold pins at their P1b figures (chain 6, total 8, 37 requests,
  `al-admission` 10, `al-work` 5; cold 10 + 9; inbound 9/11, 11/13, 5/7); the `durable-takeover` scenario (Task 6)
  in the `same-context` family with the `full` tag.
- Produces: code head `H1` (reviewed and gated), final head `H2` (H1 plus the last commit), the PR title and body.

Throughout: `WT=/Users/knuthelge/ProjectLocker/github/ar-eye-hunter/.claude/worktrees/alm-i2a-ii`,
`R=intact-software-systems/ar-eye-hunter`, `B=claude/alm-i2a-ii-durable-owner`, `T=$WT/tmp/i2a-ii-task8`. Every
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
gh pr view 630 -R $R --json mergeable,mergeStateStatus --jq '[.mergeable, .mergeStateStatus] | @tsv'
```

Expected: no status output; the two hashes equal; `0` variables; `MERGEABLE`. If main moved (the `wc -l` is not
`0`) or the PR reads `CONFLICTING`, merge main first: `git -C $WT merge --no-ff origin/main -m "Merge origin/main
into $B"`, resolve keeping both sides' behaviour and tests, `npm ci` if `package-lock.json` changed, then
`npm run typecheck 2>&1 | tail -3` and `node scripts/check-test-reachability.mjs` before step 2.

- [ ] **Step 2: Pins and bundle figures**

```sh
cd $WT && npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts 2>&1 | grep -E "✓|✗|Tests  "
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles | grep -E "browser/rallar(-core|-realtime|-data|-crdt)?\.ts "
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts 2>&1 | grep -E "KiB|Tests  "
```

Expected: both pin files pass with the P1b figures (chain `6`, total `8`, `al-admission` `10`, `al-work` `5`; cold
`10` + `9`; inbound unchanged): I2a-ii adds no IndexedDB operation to a send (the owner lock is taken per connect, the
channel is a browser API, the gate defers tasks and never adds a probe). Bundles as measured on the assembled tree:
`browser/rallar.ts` 234.219 KiB against 235 (raised in Task 4, R-I2a-ii-47) and the headless agent 298.756 KiB
against 299 (raised in Task 2, R-I2a-ii-27); per task 233.065 / 297.773 (Task 1), 233.577 / 298.196 (Task 2),
233.792 / 298.624 (Task 3), 234.219 / 298.756 (Tasks 4–7).
Record the bundle lines and the headless figure in `$T/figures.md`. If `browser/rallar.ts` or the headless bundle
exceeds its budget, set the budget to the next whole KiB above the measured figure in the data file (never higher),
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
pass with the snapshot unedited: the claim, the channel and the lane stamp add no public shared-web export
(`BrowserALDurableWorkClaim` and `BrowserALSessionChannel` are internal to the composition).

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
run (standard and cluster) included. Tasks 1, 2 and 4 change server-shared ALM code (the lock port's module, the work
handler's membership seam and both runtimes' `Resources` with the always-owned default, the settlement's `lane` stamp
the server's receipt status reads), so the cluster profile and the medium-scale gate ARE required; the medium-scale
gate's constants, operation matrix and assertions are unchanged.

- [ ] **Step 6: Local merge bar, the full ALM lane**

```sh
cd $WT && rm -rf apps/rallar-black-box/test-results
RALLAR_BLACK_BOX_ALM_SCOPE=full npm run -s test:rallar:full-stack:memory:alm 2>&1 | tee $T/alm-full.log | grep -E "family over|passed|failed|flaky|skipped"
for F in apps/rallar-black-box/test-results/alm-observation/*-full*.json; do case $F in *-snapshot.json|*-page-diagnostics.json) ;; *) printf '%s ' $F; jq -r '.cellOutcome + " " + .regime' $F;; esac; done
grep -h -o '"recipeId":"alm-[a-z-]*durable-takeover[a-z-]*"[^}]*"outcome":"[a-z-]*"' apps/rallar-black-box/test-results/alm-observation/*-full*.json | sort | uniq -c
```

Expected: every `baseline`, `addressed` and `three-agent` family over `ws`, `rtc` and `rtc-with-ws-fallback` in
`(full)` passes, and the new `same-context` family passes over `ws`, `rtc` and `rtc-with-ws-fallback` with
`durable-takeover` outcome `completed` (the successor waits one lease plus 1 s after the owner page's close, then
reports `restored {claimed > 0}`, and the receiver gets the message once: R-I2a-ii-32; about 40 s per carrier cell);
`delivery-reload` reads one `recovery` event per durable store; the summary shows `N passed` and no `failed` or
`flaky`; every cell file reads `passed`. Harness budgets unchanged (`git diff origin/main --
packages/shared-test/rallar-bb-test/conformance` touches no timeout constant).

- [ ] **Step 7: Final whole-branch review, three seats, and one fix wave**

Per the subagent-driven-development skill's final review: dispatch the reviewer on the most capable model with the
whole-branch diff (`git diff origin/main...HEAD`, packaged to a file), the spec (`playground/alm/alm-i2a-design-proposal.md`
§3.f–3.k, §4 decisions 5, 6, 8, 11 and 12, §5's I2a-ii rows), this plan's Rulings, Corrections and Limits, and the
Global Constraints, in three seats: product (no guarantee weakens: the D17 fence, supersedence, settlement, expiry and
the volatile lanes are untouched; one drainer per session wherever the Locks API exists, every tab without it; a
takeover recovers a held row at its lease end plus at most 19.1 s and no sooner; a waiting tab's commit reaches the
owner's lane of its work type and is never announced twice; only a durable lane's settlement is relayed, once, and
applied once; the server and Node keep the always-owned default), harness (the successor shares the owner's context
and session and connects only after the owner page closes; the lease wait and the `claimed > 0` assertion prove a
held row is reclaimed; the hosted filter is family-based and manifests 18 and 22 are byte-identical; the Deno fixture
models what the lane does), and code quality (repo style, sizes, names, READMEs true, the public snapshot unedited,
no real `BroadcastChannel` in a unit test). ONE fix dispatch for every Critical and Important finding, one scoped
re-review, residual minors adjudicated in the ledger. Each fix is a TDD commit. Then repeat steps 2, 3 and the focused
tests the fixes touched; steps 4–6 are repeated only if a fix touched product code.

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
outcome, recorded (the 30-minute job timeout cuts them); `durable-takeover` does not run hosted (its family is
Playwright-lane only, D124), so its hosted column reads "not run, by design". If a read ends with the API's
"stopping API process" line (the RTC topology lease-lost self-stop, pre-existing since #566), classify it so from the
job log and state which cells have no hosted read. Any WS red, or an
RTC red at another step, is not accepted: download the artifact and diagnose before a second read.

- [ ] **Step 11: The last commit: the delivered lines and the plan file**

In `playground/alm/alm-qos-product-plan.md` §8, the "One durable owner per session store" bullet gains "Delivered (I2a-ii, <H1>)"; QoS §4's "One writer" sentence
stays as it is (the checkpoint is I2b's). Then delete this plan file:

```sh
cd $WT && git rm plans/active/alm-i2a-ii-one-durable-owner-implementation-plan.md
npx dprint fmt playground/alm/alm-qos-product-plan.md
git add playground/alm/alm-qos-product-plan.md
git commit -m "Record I2a-ii as delivered and close its plan"
git push origin HEAD:$B && git rev-parse HEAD > $T/H2
```

Expected: the commit contains only the two paths; the Branch Release Gate runs again on H2 and is read as in step 8
(docs-only, so the earlier hosted and observation reads on H1 stand; the PR body names both heads).

- [ ] **Step 12: The PR title and body**

Title: `ALM Release 4, I2a-ii: one durable owner (D119, D123, D124, D126, D128)`. Body sections in this order:

- Goal.
- Changes (one bullet per task).
- Public surface: `ALBrowserLocks` in `packages/shared/alm/storage/al-browser-locks.ts` with its `signal` option,
  `readALBrowserLocks()` and the two lock-name builders (`ALOutboundMessageRuntime.BrowserLocks` removed);
  `ALDurableWorkOwnership`, `ALDurableWorkCommit` and `ALWAYS_OWNED_AL_DURABLE_WORK` on both runtimes' `Resources`;
  the durable lanes' `applyForeignCommit`; the optional `lane` on `ALDeliverySettlement`; the browser inputs carrying
  the ownership value, `BrowserConnectOptions`, `BrowserTransportInitOptions` and the transport runtime's
  session-channel port factory (`BrowserALDurableWorkClaim` and `BrowserALSessionChannel` stay internal to the
  composition); the `same-context` lane family, the `successor` role and `openBrowserControlAgentInContext`
  (Playwright helpers only); Relic's command channel now `local-outbox` with `onStorageUnavailable: 'refuse'`; the
  family-based Hetzner filter (`isThreeAgentScenario` removed); the shared-web public API snapshot, unedited.
- Acceptance: the pins unchanged, with their figures; the bundle figures and the two budget raises (headless 298 →
  299 at 298.196 KiB in Task 2, `browser/rallar.ts` 234 → 235 at 234.219 KiB in Task 4, and step 2's final reading);
  the ALM lane full read cell by cell, with `durable-takeover` as "not run hosted, by design" and its local full-lane
  outcome per carrier; manifests 18 and 22, with run ids.
- Validation: steps 3–6 and 8–10, with counts and run ids, measured on H1; the H2 gate; every red named with its
  classification and evidence, never softened.
- Rulings: every `R-I2a-ii-N` of this plan and every `Ruling:` line from the SDD ledger, each with what it costs if
  wrong.
- Corrections: this plan's list, which records what the proposal and the roadmap say differently.
- Limits: this plan's list, which says what the evidence cannot show. That covers no takeover while the owner page
  is alive in the lane (the server's one socket per session), no takeover before the owner's lease ends in the lane,
  cancel from a waiting tab, a browser without `BroadcastChannel`, a takeover whose store cannot open, the per-test
  fake-channel guard, the optional `lane`, Relic's non-idempotent kinds and the refusal, and no hosted takeover.
- Risk and rollback: revert the merge commit. No schema id change and no data migration. A revert returns every tab
  to draining its own rows, as before.
- Follow-up: I2b (`local-checkpoint`, owned by the durable owner); cancel across tabs (R-I2a-ii-9); a lock-proven
  early reclaim; hosted takeover evidence (a headless-worker change, D124); and, carried from I2a-i, the control
  replay hand-over gap, `tests/playwright` typecheck coverage, the API's lease-lost self-stop and the parked minors.
- The attribution line.

Publish with `gh pr edit 630 -R $R --title "..." --body-file $T/pr-body.md`. Leave the PR in draft; the maintainer
reviews and merges. Then write `Task 8: complete` and `PLAN COMPLETE <date>: PR #630 at <H2>` in the ledger.

- [ ] **Step 13: After the maintainer merges**

Watch main's `Push on main`, `Deploy Web + API` and `Run Hetzner Supported Distributed Manifests` on the merge commit
(`gh api repos/$R/actions/runs?head_sha=<merge sha>`), report them, and record I2a-ii as delivered in memory. I2b's
plan (`local-checkpoint`, unconditional per D115) is written next on a new branch from main.

---

## Self-review

**Composition evidence.** All seven task patches were applied in plan order, with `git apply --3way` and no
conflict, to a scratch tree from `ee510bbb0`. R-I2a-ii-44 and R-I2a-ii-45 were implemented red first inside Task 4.
The scratch commits are evidence only: Task 1 `816276026`, Task 2 `610829c28`, Task 3 `237181490`, Task 4
`9ed59ed8d`, Task 5 `0be0531ba`, Task 6 `de632511a`, and Task 7 `f819991ff` (the head).

At every commit these pass:

- `npx tsc -p packages/shared/tsconfig.json --noEmit`;
- the shared-web, shared-server and shared-test typechecks;
- `check-tests-typecheck` (1427 → 1428 → 1429 → 1432 → 1433 → 1434 → 1434 files, 0 errors);
- the task's focused Vitest files (5/48, 176/2072, 165/1357, 339/3343, 371/3990, 372/4010 and 31/187, as files/tests);
- the three pins (`Tests  25 passed (25)`, unedited).

The head also passes:

- `check:browser-bundles`: `browser/rallar.ts` 234.2 KiB `< 235.0 KiB ok`;
- the headless boundary, the public API snapshot and the bundle-boundary tests (`Tests  21 passed (21)`);
- the api-v1 `deno task check` (exit 0);
- the control server's `deno task check && deno task test` (`ok | 195 passed | 0 failed`);
- the manifests `--check` ("checked 67 Hetzner distributed manifest(s)") and a regenerate that is byte-identical;
- `npm run check:repo-style:changed -- origin/main HEAD` (`PASS: no new repository style findings`);
- the coupling check (PASS: the touched `al-outbound-control-admission.test.ts:503` candidate is already classified);
- `npm run check:test-reachability` (`1736 test files, 1730 reached by CI, 6 manual`);
- the Relic and black-box app typechecks;
- the scratch Playwright typecheck: the same 28 errors as at `ee510bbb0`, none in a touched file, and the
  `tests/playwright/alm` harness clean except the environmental Temporal lib error;
- `npm run -s test:unit:main`, sandbox off: `Test Files  1354 passed | 4 skipped (1358)`,
  `Tests  12616 passed | 12 skipped (12628)`.

Per-task bundles (brotli q11), as `browser/rallar.ts` / headless:

| After     | `browser/rallar.ts`    | Headless               |
| --------- | ---------------------- | ---------------------- |
| Base      | 232.975                | 297.686                |
| Task 1    | 233.065                | 297.773                |
| Task 2    | 233.577                | 298.196 (budget → 299) |
| Task 3    | 233.792                | 298.624                |
| Tasks 4–7 | 234.219 (budget → 235) | 298.756                |

**(a) Spec coverage.**

- §3.f:
  - the port is Task 1;
  - the gate per durable task, a non-owner's commit and the takeover bootstrap are Task 2;
  - the claim with the connect's signal, release at disconnect, no `ifAvailable`, and every tab owning without the Locks API are Task 3;
  - a non-owner's handles (decision 11) are Task 4;
  - inbound is Task 2: the inbound lane's `applyForeignCommit` with the head read, proved in Task 4's commit-wake test;
  - the pins are unedited in every task;
  - the evidence is Task 3's two-connect claim tests on a lock fake that adds `signal` to the two-tab test's FIFO fake (that fake is left as it is), and Task 2's ownership tests.
- §3.g: Task 4. One channel per session and scope after the `rallar-data:`/`rallar-crdt:` guard; the rows go into the owner's `work.committed(rows)` through `applyForeignCommit`; no `wakeAfterExternalWrite`; no IndexedDB operation (pins). The evidence is the commit-wake unit test with `FakeBroadcastChannel`.
- §3.h (owner-counted): Tasks 2–3. A non-owner runs no batch, so its reporter stays armed; the takeover's bootstrap reports `restored`. The contract docs are in Task 3, and Task 6 asserts `restored {claimed > 0}`.
- §3.j:
  - `durable-takeover` on every carrier with the `full` tag: Task 6;
  - the deadline above the lease plus 19.1 s: Task 6 (`ttlMs` 77 s);
  - the `same-context` family and the hosted entries skipping it: Task 5.
- §3.k: Task 7.
- Decisions:
  - 5 → Task 4;
  - 6 → Tasks 5–6;
  - 8 → Task 7;
  - 11 → Task 4 (R-I2a-ii-8, -44);
  - 12 → no AR Eye Hunter change; `durable-takeover` and Relic's move are the I2a proof.
- §5 I2a-ii rows:
  - one of two runtimes drains and the other takes over on dispose, each row sent once: Tasks 2–3;
  - without the Locks API every runtime drains: Task 3;
  - a foreign commit reaches the owner within one pass: Task 4;
  - a relayed settlement reaches the sending tab's handle: Task 4;
  - takeover reports `restored`: Tasks 2–3;
  - `durable-takeover` in the Playwright lane, and every I2a-i scenario still green: Task 8 step 6;
  - the Relic pin: Task 7;
  - the "both PRs" rows (D8 inspection, pins, ALM lane with observation smoke and full reads, cluster profile and medium-scale, hosted 18 and 22, bundle figures, storage snapshot): Task 8.
- §6: tasks 1–7 map one to one, with task 5 in the Playwright helpers only. The proposal's task 7 ("pins, gates, manifests, bundle, PR body") is Task 8.
- Gaps, each a stated carry:
  - the headless worker is not changed (R-I2a-ii-1, correction 1);
  - the lane cannot show a takeover while the owner page is alive, nor one before the owner's lease ends (R-I2a-ii-31, -32; unit evidence only);
  - hosted takeover is not run (D124);
  - cancel does not cross tabs (R-I2a-ii-9).

**(b) Placeholder scan.** No `TBD`, `TODO`, "implement later" or "similar to Task N" remains. The angle-bracket
tokens that remain are deliberate:

- `630` in Task 8: the controller fills it after the draft PR opens.
- Values read while running Task 8: `<H1>`, `<RUN>`, `<GATE_RUN>`, `<OBS_JOB>`, `<k>`, `<date>`, `<entry>`, `<N>`, `<x.xx>`, `<sha>` and `<alm-conformance-lane artifact>`.
- Name patterns in prose and lock or channel names: `<carrier>`, `<applicationId>`, `<workspaceId>`, `<sessionId>`, `<senderId>` and `<p>`.

**(c) Type consistency** (each cross-task name, its defining task and its consumers; the assembled tree typechecks
at every task commit):

- `ALBrowserLocks`, `ALBrowserLockOptions` (with `signal?`), `readALBrowserLocks()`, `toALOutboundCommitLockName` (Task 1) → Task 3 (the claim, the transport runtime) and Task 4's tests.
- `toALDurableOwnerLockName(scope, sessionId)` (Task 3).
- `ALDurableWorkOwnership`, `ALDurableWorkCommit`, `ALDurableWorkLaneOwnership`, `ALWAYS_OWNED_AL_DURABLE_WORK`, `toALDurableWorkLaneOwnership`, `ALWorkEngineMembership` (Task 2) → Task 3 (`BrowserALDurableWorkClaim implements ALDurableWorkOwnership`) and Task 4 (`BrowserALSessionChannel.announceCommit(commit: ALDurableWorkCommit)`).
- `ALOutboundStoreLane.applyForeignCommit(rows)`, `ALInboundStoreLane.applyForeignCommit()` (Task 2) → Task 4 (the channel's listeners reach them through `onForeignCommit(workType, …)`).
- `durableWorkOwnership` on both `Resources`, both default inputs and the five browser and service inputs (Task 2) → Task 3 (`BrowserConnectOptions.durableWorkOwnership`).
- `BrowserALDurableWorkClaim` (Task 3, `Input { scope, sessionId, locks }`) → Task 4 (`Input.sessionChannel`, the `sessionChannel` getter).
- `BrowserConnectOptions extends MiddlewareInitOptions` (Task 3; what `createMiddleware` receives) and `BrowserTransportInitOptions extends Omit<MiddlewareInitOptions, 'deliverySettlements'>` (Task 4; what `BrowserTransportRuntimePort.init` receives). Two distinct contracts, no alias.
- `BrowserALSessionChannel`, `openBrowserALSessionChannelPort`, `toBrowserALSessionKey`, `BrowserDeliverySettlements.Observers`/`Relay`, `BrowserSessionDeliveries.observers`, `BrowserTransportRuntime.Input.openSessionChannelPort`, `ALDeliverySettlement.lane?` (Task 4).
- `createOutboundTestSession`, `createSessionOutboundTestRuntime` (Task 2's `session-outbound-test-runtime.ts`) → Tasks 3–4.
- The inbound fixture's `durableWorkOwnership` (Task 2) and `dbName` (Task 4).
- `installFakeBroadcastChannelPerTest`, `FakeBroadcastChannel.openNames` (Task 4).
- `ALM_CONFORMANCE_ROLES` with `successor`, `AlmConformanceLaneFamily` with `same-context`, `AlmConformanceScenario.successor`, `RESTORED_SESSION_RALLAR`, `openBrowserControlAgentInContext`, `openSuccessorPage`, `runRecipeTrioOnSameContext`, `HOSTED_ALM_LANE_FAMILIES` (Task 5) → Task 6.
- `durableTakeover`, `toOwnerLeaseLapseWait`, `RECOVERED_STORE_PREFIXES`, `toRecoveryTtlMs`, `toOriginalStorePrefix`, `toStoreRecoveryWait`, and the moved `toAddressedSendCommands` (Task 6).
- The `recovery` event `{ kind: 'restored', claimed, expired }` (I2a-i), stated by Tasks 2–3's takeover and read by Task 6.

**(d) Files touched by two or more tasks** (their edits land in this order):

| File                                                                                                                                                                                                                         | Tasks         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `packages/shared/alm/outbound/README.md`                                                                                                                                                                                     | 1 → 2 → 3 → 4 |
| `packages/shared/alm/outbound/al-outbound-message-runtime.ts`                                                                                                                                                                | 1 → 2 → 4     |
| `packages/tests/shared-web/connection/initialise-browser-middleware.test.ts`                                                                                                                                                 | 2 → 3 → 4     |
| `packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts`, `alm/outbound/lane/al-outbound-store-lane.ts`                                                                                                  | 1 → 2         |
| `packages/shared/alm/storage/al-browser-locks.ts`                                                                                                                                                                            | 1 → 3         |
| `packages/shared/alm/work/al-work-handler.ts`, `packages/tests/shared/alm/inbound-runtime-test-fixture.ts`                                                                                                                   | 2 → 4         |
| `packages/shared-web/browser/connection/initialise-browser-middleware.ts`                                                                                                                                                    | 2 → 3         |
| `packages/shared-web/browser/README.md`, `browser/al-runtime/browser-al-durable-work-claim.ts`, `browser/connection/browser-transport-runtime.ts`, `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` | 3 → 4         |
| Tests: `browser-al-durable-work-claim.test.ts`, `browser-facade-behavior.test.ts`, `browser-transport-cleanup.test.ts`, `rallar-facade-defaults.test.ts`                                                                     | 3 → 4         |
| Conformance: `alm-conformance-scenario-definition.ts`, `alm-conformance-session-commands.ts`, `create-alm-conformance-recipes.ts`, `scenarios/delivery-reload.ts`                                                            | 5 → 6         |
| `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`                                                                                                                                                        | 5 → 6         |
| `packages/tests/rallar-black-box/full-stack-same-context-run.test.ts`, `packages/tests/shared-test/alm-conformance-recipes.test.ts`                                                                                          | 5 → 6         |

Each later task's anchors are of its predecessor's head (Task 4 says so). Tasks 5–6 never touch a Task 1–4 file, and
Task 7 touches only Relic.

**(e) Corrections the plan implies for the proposal and the roadmap** (listed in full under "Corrections to the
proposal and the roadmap" above; Task 8's PR body carries them):

- The headless worker is not in scope: the two-page capability lives in the Playwright helpers only (§3.j, §6; D124).
- The Hetzner filter becomes family-based (§3.j's "pick families explicitly" was not yet true).
- One socket per session bounds D123's two-tab story: an orderly hand-over on close or reload, and a single drainer.
- The `successor` role and `openBrowserControlAgentInContext` replace the "`pages: 2` agent option".
- The lease wait: the successor connects one lease plus 1 s after the owner's close and asserts `claimed > 0`.

Also: every tab relays, durable lanes only; the ownership is keyed by work type; the port is `ALBrowserLocks` in
`alm/storage/`; Relic also declares `onStorageUnavailable: 'refuse'`.
