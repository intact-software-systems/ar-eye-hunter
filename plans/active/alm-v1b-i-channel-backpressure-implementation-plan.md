# ALM V1b-i: channel backpressure as a congestion policy input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development with test-driven development:
> one implementer per task, the failing tests first, the controller reviews and commits, one commit
> per task, a three-seat final review with one fix wave before the close. Steps use checkbox
> (`- [ ]`) syntax for tracking. The tasks run in the order 1 → 2 → 3 → 4 → 5 → 6.

**Goal:** Deliver Release 7, V1b-i (D184 to D188, `playground/alm/alm-v1b-i-design-proposal.md`). Each carrier reads
its own channel when it plans one of the session's own new data sends: the RTC overlay reports `backpressured` when
every ready next hop's reliable channel holds at least its high watermark, the WS client when its socket's
`bufferedAmount` is at least `AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES` (256 KiB). The congestion policy answers
`overloaded` or `backpressured` and names its cause: a backpressure drop is the drop code and refusal reason
`congested`, a fallback trigger, so a best-effort RTC send under `rtc-with-ws-fallback` is handed to WS at admission
and one on a single carrier ends `rejected`/`congested` with no attempt; a kept send settles `not-ready` with a 50 ms
retry on both carriers. Every decision is a `congestion` outbound diagnostic, counted by the black-box page as
`stats.rallar.congestion { dropped, deferred, handedOver }` and folded by the lane observation; the scripted
transport fault port gains a `backpressure` action, and three two-agent lane cells prove it end to end; the docs
state all of it.

**Architecture:** `al-policy.ts`'s three contexts gain `backpressured?` beside `overloaded`; the planner resolves a
`cause` (`overloaded` first) and `planCongestion` applies to either; `resolveCongestionDrop` names the drop code
(`capacity`'s `overloaded`, or `congested`). The outbound runtime states a planner's drop once at admission through
`ALOutboundDispatchPlan.congestionDrop` and `writeALOutboundCongestionDiagnostic`; the delivery refusal reason
`congested` joins `AL_DELIVERY_FALLBACK_REFUSAL_REASONS`, so the browser dispatch's existing admission hand-over
(`computeFallbackDisposition`) moves a congested RTC leg to WS and writes the `hand-over` diagnostic. The RTC overlay
plans a new admission once and re-plans with `live.backpressured: true` when `computeRtcBackpressure` holds over the
plan's ready next hops (or the fault port says so); its submission defers on a `dropped` result at the watermark. The
WS client runs `planALMessageHandling` with `backpressured: true` when its socket is full (it never reads
`overloaded`: its ledger refuses those with a `limit`) and defers a full-socket submission. The scripted
`TransportFaultPort.decideBackpressure(carrier, message)` is consulted at both points. The browser middleware carries
the connect's `outboundDiagnostics`; the black-box page counts `congestion` diagnostics per connection
(`readCongestionCounters()`), the `stats` result reads them, and the observation folds them into a `congestion`
regime beside `ledger`.

**Tech Stack:** TypeScript on Node (Vitest, Playwright, esbuild bundle budgets) and Deno (api-v1, the control
server: `deno test`, `deno check`); dprint.

**Spec:** `playground/alm/alm-v1b-i-design-proposal.md`; decisions D184–D188 in
`playground/alm/alm-improvement-plan.md` (decision table and the "Release 7, V1b-i design" section), as amended by
the rulings below; survey `.superpowers/sdd/v1b-survey/facts.md`.

## Global constraints

- **The maintainer's notes stand: "no legacy, avoid duplication, no migration code, keep repo consistent, prefer
  existing patterns."** No wire or schema bump: the inbound plan decoder reads a stored plan without `cause`
  (R-V1b-2); `stats.rallar.congestion` is optional exactly where `rallar.alm` is.
- **The live flag and its readers (D184):** `backpressured?` on `ALQosNormalizationInput.live`,
  `ALQosMessageContext` and `ALMessagePlanningContext`, absent when the carrier read no channel. The RTC overlay sets
  it on a new admission's plan (`authority === undefined`) of the session's own data room send, when every ready next
  hop's reliable channel holds `bufferedAmount >= flowControl.highWatermarkBytes` (`computeRtcBackpressure`, 64 KiB
  by default) or the scripted fault port reports `backpressure` for the message; the WS client sets it on a new
  admission of its own data when `socket.bufferedAmount >= AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES` (256 KiB) or the
  port says so. Controls, receipts, relay forwards, dequeue re-plans, repairs, retransmissions, inbound and carrier-gap
  plans never read it (R-V1b-7); RTC unicasts and unaddressed sends read neither congestion input (R-V1b-15);
  `overloaded` keeps its meaning (the session's count or byte bound) and the WS client never reads it (R-V1b-4).
- **The per-cause outcomes and the fallback rule (D185):** the congestion policy applies to `overloaded ||
  backpressured`; `overloaded` names the cause when both hold. `drop-low` (default) drops priority ≤ 0, `reject` every
  send, `defer` none at planning. An `overloaded` drop stays `capacity` (RTC only, limit-less, R-V1b-4); a backpressure
  drop is the drop code, outbound drop code and delivery refusal reason `congested` (`'Carrier backpressure dropped
  the send'`), no NACK. `AL_DELIVERY_FALLBACK_REFUSAL_REASONS` is `['unsupported', 'congested']`: under
  `rtc-with-ws-fallback` a congested RTC leg is handed to WS at admission — a `refused` RTC attempt row with
  `refusalReason: 'congested'` before the WS attempt, and no `carrierFallback` (R-V1b-1); without a fallback the
  handle ends `rejected` with `{ kind: 'refused', reason: 'congested' }` and no attempt. A kept send that meets a full
  channel or socket at submission settles `not-ready` with `retryAfterMs: AL_SUBMISSION_NOT_READY_RETRY_MS` (50); every
  WS `not-ready` names it; three consecutive RTC `not-ready`s hand a fallback send to WS (D56, unchanged).
- **The diagnostic and counters (D186):** `ALOutboundCongestionDiagnostic { kind: 'congestion'; carrier; cause:
  'overloaded' | 'backpressured'; action: 'drop' | 'defer' | 'hand-over'; priority; msgId }`, written by the outbound
  admission (`drop`, keyed on `plan.congestionDrop`; a ledger `capacity` refusal writes none), the RTC and WS
  submissions (`defer`) and the browser message dispatch (`hand-over`, R-V1b-17), each through
  `writeALOutboundCongestionDiagnostic` (a throwing sink changes nothing). `ALCongestionCounters { dropped, deferred,
  handedOver }` counted per connection by the black-box page (reset at `close`, R-V1b-21), read by
  `readCongestionCounters()` and the `stats` result as `rallar.congestion` (R-V1b-20), folded by the observation as
  each page's largest count summed over the cell's pages (R-V1b-22). A handed-over send counts in both `dropped` and
  `handedOver`. No facade method reads them; channel health stays on `rallar.rtc.status()`.
- **The proof (D187):** unit pins per cause and priority, per hop set and per socket fill; facade proofs on the real
  overlay and WS client (room sends, explicit `reliability`); the `fault.inject` `backpressure` action on both
  transport carriers; three cells `backpressure-hands-over`, `backpressure-refused`, `backpressure-deferred` in the
  two-agent family (`scenarios/congestion/`), withheld from hosted manifests 18 and 22, which stay byte-identical.
- **D3:** no compatibility window. A changed contract changes everywhere in the same task (the overlay's `faultPort`
  is required, R-V1b-13; `attemptRefusalReasons` is required, R-V1b-29; `RallarBrowserMiddleware.outboundDiagnostics`
  is required, R-V1b-18). Optional only where absence means something: `backpressured?` (no channel read),
  `congestionDrop?` (no congestion drop), `congestion?` on the stats block (not connected).
- **D8 reuse first.** Search `packages/**` for an existing pattern before writing one; delete what becomes unused in
  the same task; no raw Maps where `packages/shared/cache` repositories fit. Every task carries a D8 reuse inspection
  paragraph and its commit one `D8 reuse:` line.
- **No ids in code, tests or docs:** no plan, task, PR or ruling id in code, tests or commit messages; decision ids
  (D184 …) only in docs and source doc comments; the docs name release slices as the repo's docs already do
  (R-V1b-33).
- **No guarantee weakens.** The four pins (`al-indexeddb-transaction-ledger`, `al-indexeddb-operation-counts`,
  `al-storage-snapshot`, `al-indexeddb-empty-audience-counts`) are untouched; the public API snapshot is unchanged (no
  new export name); hosted manifests 18 and 22 stay byte-identical.
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical verbs; functions
  ≤40 lines; ≤3 positional parameters for a new function; `interface` for object contracts; required fields by
  default; `Either` for expected failure; kebab-case filenames after the primary export; no role folders; no narration
  comments; one canonical name per type. `al-policy.ts` stays at 11 runtime exports and `al-contracts/` (20 files),
  `alm/outbound/` (22) and `conformance/alm/scenarios/` (19) gain no direct file (R-V1b-3). Tests live under
  `packages/tests/**` mirroring the source.
- **Formatting:** `npx dprint fmt <explicit file list>` on touched files only (pipe a list through `xargs`; zsh does
  not split `$(...)`).
- **Per-task checks:** the focused Vitest files; `npx tsc -p
  packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json --noEmit`; `deno check` from the repo root on
  every changed `packages/shared/**` file; `cd apps/api-v1 && deno task check` when a type a Deno app consumes
  changes, then `rm -rf apps/api-v1/node_modules/.deno`; `node scripts/check-tests-typecheck.mjs`; the four pins; the
  bundle checks with a private `TMPDIR` (`mktemp -d /tmp/claude-501/b.XXXX`) after any `packages/shared`,
  `shared-web` or `shared-test` change (`npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` and
  `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`; budgets `browser/rallar.ts` 243 and
  headless 309 until Task 3 raises them to 244 and 310, R-V1b-25); for a shared-web change
  `shared-web-public-api-snapshots.test.ts` and `shared-web-browser-bundle-boundaries.test.ts`; after the commit `npm
  run check:repo-style:changed -- 0d8e3f9ab HEAD` (read the verdict line: the script exits 0 on FAIL), `node
  scripts/check-test-structure-coupling.mjs --changed 0d8e3f9ab HEAD` and, when a test file is added or deleted, `npm
  run check:test-reachability`.
- **Sandbox notes.** Loopback binds fail (`listen EPERM`): name those suites as sandbox reds
  (`api-v1-rtc-rtt-recipe-semantics` 5, `api-v1-state-write-convergence-recipe` 4, `local-websocket-session` 1,
  `live-rtc-control-client` 13, `headless-worker-script` 2); pglite and CLI-subprocess 5 s timeouts under load pass
  alone (`inbound-admission-diagnostics` "…over indexeddb", `scenario-black-box-config`); `npx tsx` fails on its IPC
  pipe (use `node --import tsx`); `git fetch`, `gh` and the Playwright lane need the sandbox off. The api-v1 and
  control-server `node_modules` are shared across worktrees: remove `.deno` after a Deno run, only when no other Deno
  suite runs. Do not run `npm run test:unit` per task.
- **Git.** One commit per task with one `D8 reuse:` line and no attribution lines; the controller commits and pushes
  after review; never `git stash`; the PR body is written at the close.
- **Task order:** 1 → 2 → 3 → 4 → 5 → 6.

## File structure

| Area                              | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts, cause, `congested` (1) | `packages/shared/al-contracts/al-policy.ts`; `packages/shared/alm/outbound/{al-outbound-message-runtime,compute-al-outbound-dispatch}.ts`; `packages/shared/alm/delivery/{al-delivery-lifecycle,resolve-al-delivery-fallback-trigger}.ts`; `packages/shared/alm/inbound/decode-al-inbound-plan.ts`; `packages/shared/multicast/{web-rtc-overlay-multicast-manager,rtc-outbound-submission}.ts`; `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts`; two new and six edited test files (17 files)                                                                                                                                                                                                                 |
| Channel reads (2)                 | `packages/shared/transport-faults/transport-fault-port.ts`; `packages/shared/multicast/{compute-rtc-backpressure (new),web-rtc-overlay-multicast-manager,rtc-outbound-submission}.ts`; `al-outbound-message-runtime.ts`; `packages/shared/websocket/json-web-socket-client.ts`; `packages/shared/services/ws-queue-box-client-service.ts`, `ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts`; `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts`, `connection/initialise-browser-middleware.ts`; three new and 23 edited test files (36 files)                                                                                                                                                            |
| Hand-over, proofs, harness (3)    | `packages/shared-web/browser/{rallar-connection-facade,connection/initialise-browser-middleware,messages/browser-rallar-message-dispatch}.ts`; `packages/shared-web/bundle-budgets.json`; the black-box runtime's `black-box-rallar-congestion-counters.ts` (new), diagnostics, runtime contract, composition, close and connection operations, messaging decoder; `rallar-bb-test/alm/{decode-al-congestion-counters (new),rallar-black-box-alm-command-capabilities,validate-alm-control-command}.ts`; the bridge, command contracts, contracts, schema, test runtimes; `conformance/alm/{alm-observation-snapshot,compute-alm-observation-regime}.ts`; `headless-bundle-budget.json`; four new and ten edited test files (37 files) |
| Lane cells (4)                    | `rallar-bb-test/conformance/alm/scenarios/congestion/{congestion-commands,backpressure-hands-over,backpressure-refused,backpressure-deferred}.ts` (new); `conformance/alm/{alm-conformance-fault-commands,alm-conformance-message-commands,alm-conformance-scenario-definition,create-alm-conformance-recipes}.ts`; `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`; `attemptRefusalReasons` through the operation contracts, delivery ledger, result values, decoders and capability text; one new and nine edited test files (25 files)                                                                                                                                                                          |
| Docs (5)                          | `docs/{rallar-api-reference,rallar-hetzner-distributed-recipes}.md`; `packages/shared/alm/{inbound,outbound}/README.md`; `packages/shared-test/rallar-bb-test/docs/{schema-and-capabilities,schema-compatibility-guide,alm-observation-artifact}.md`; `playground/alm/alm-complete-product-description.md` (8 files)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Close (6)                         | the pins, the gates, the lane run, the review, the PR body, the roadmap's delivered lines and as-applied notes, the audit's F5 row, the requirement matrix's PC8 row, this file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Task order

1 (contracts, the planner's cause, the `congested` outcome, the diagnostic) → 2 (the RTC overlay and the WS client
read their channels; the fault port's `backpressure`) → 3 (the browser hand-over diagnostic, facade proofs, the
`fault.inject` action, the counters and the fold) → 4 (the lane cells, `attemptRefusalReasons`) → 5 (docs) → 6
(close). Task 2 consumes Task 1's live flag, `toALOutboundCongestionDrop`, `congestionDrop`, the writer and the retry
constant; Task 3 consumes Tasks 1 and 2 (`decideBackpressure(carrier, message)`, the required overlay `faultPort`,
`TestWebSocket.bufferedAmount`); Task 4 consumes Task 3's wire action and `stats.rallar.congestion`; Task 5 states
what Tasks 1–4 built and is checked against them (it owns every doc wording, R-V1b-32).

The composed commits (scratch tree `scratch/v1b-assemble`, each `git am -3`-able on its predecessor from the design
head `0d8e3f9ab`): `final-patch-task-1.patch` … `final-patch-task-5.patch` under `.superpowers/sdd/v1b-plan/` —
`e1fb00f33`, `76a6d8b49`, `78fedc1bd`, `a059bf7c2`, `78830f699`. Tasks 1–4 are tree-identical to the writers'
prototypes (`cc3053a1f`, `9aac21167`, `347b42138`, `2c4b09fe0`); Task 5 carries three doc corrections (R-V1b-36..38).
Files touched by two tasks: `al-outbound-message-runtime.ts`, `web-rtc-overlay-multicast-manager.ts`,
`rtc-outbound-submission.ts` (Tasks 1, 2); `rtc-origin-overlay-fixture.ts` (Tasks 1, 2, 3);
`initialise-browser-middleware.ts` and its test (Tasks 2, 3); `rallar-black-box-alm-command-capabilities.ts` and
`rallar-bb-test-alm-commands.test.ts` (Tasks 3, 4); `decode-alm-delivery-failure.ts` and its test (Tasks 1, 4). Each
task's anchors are at its own parent commit.

## Rulings

- **R-V1b-1:** an admission hand-over writes no `carrierFallback` evidence: a congested RTC leg is a refused attempt
  row with `refusalReason: 'congested'` (as `unsupported`/`rate-limited` hand over today); the handle ends
  `acknowledged` with `attemptOutcomes ['refused','sent']` and `attemptCarriers ['rtc','ws']` (amended by R-V1b-29:
  the lane reads the reason through `attemptRefusalReasons`). _Cost if wrong:_ `ALDeliveryFallbackReason` gains
  `congested`, the dispatch states a `carrier-fallback` at admission and the existing evidence diverges — about one
  task.
- **R-V1b-2:** `plan.congestion.overloaded` stays beside the new `cause` (the strict stored-plan decoder rejects
  unknown fields); `cause` is required-but-undefinable on the plan and optional in the stored decoder. _Cost if
  wrong:_ one redundant boolean; removal later needs a tolerant decoder.
- **R-V1b-3:** no new file and no new `al-policy.ts` export (11 runtime exports; `al-contracts/` 20 files,
  `alm/outbound/` 22 files, all at the density caps): `ALOutboundCongestionDrop`, `toALOutboundCongestionDrop`,
  `writeALOutboundCongestionDiagnostic` and `AL_SUBMISSION_NOT_READY_RETRY_MS` live in
  `al-outbound-message-runtime.ts`; the `drop` diagnostic is emitted in `planAdmission` keyed on `plan.congestionDrop`;
  forwards never emit; a ledger `capacity` refusal is not a congestion decision; the constant replaces the RTC
  submission's four `not-ready` literals and the overlay's held-authority one (the `failed` retry, the
  pending-authority `not-ready` and the two `NotReadyException(50)` keep their literal). _Cost if wrong:_ a later move
  of a few functions.
- **R-V1b-4:** the WS client reads `backpressured` only, not `overloaded`: the planner runs before the ledger, and a WS
  best-effort send at the bound must keep the ledger's `capacity` with `limit` (D179). D185's "applies to overloaded
  or backpressured" is amended at the close: backpressure on both carriers, `overloaded` as before on RTC only. Follow-up:
  on RTC the planner's overloaded drop still precedes the ledger (a limit-less `capacity`, R-V1a-1). _Cost if wrong:_ a
  documented carrier asymmetry.
- **R-V1b-5:** the fault port gets `decideBackpressure(carrier, message: ALMessage): boolean`, matched by the existing
  frame-facts decoder, one count per `true`; the frame's `decideBackpressure(match)` is withdrawn. _Cost if wrong:_
  one signature.
- **R-V1b-6:** "every ready next hop backpressured" = the open-channel hops of the plan made without the flag; the
  overlay plans once and re-plans with `live.backpressured: true` only when every such hop is at or above its
  watermark; no ready hop, an already-dropped plan or nothing to send is not backpressured and the fault port is not
  consulted. _Cost if wrong:_ one extra plan per full admission.
- **R-V1b-7:** only a new admission's plan (`authority === undefined`) reads backpressure; dequeue re-plans, repairs,
  retransmissions, relay forwards, inbound and carrier-gap plans and controls never do. _Cost if wrong:_ a queued
  best-effort send defers at submission rather than being refused at dequeue.
- **R-V1b-8:** `readOutgoingQosPolicy` gets no `backpressured` (normalization never reads it). _Cost if wrong:_ none.
- **R-V1b-9:** the RTC submission defers on a scripted `rtc` fault before `sendJson`, or on a `dropped` result at the
  watermark; queue lanes keep queueing; a "Queue full" drop counts as a deferral. _Cost if wrong:_ a pre-send health
  check would break the queue-overflow lanes.
- **R-V1b-10:** the submission's diagnostics port is the carrier's existing `outboundDiagnostics` sink;
  `RtcOutboundSubmission` takes a `Dependencies` object; the `defer` priority is the effective congestion priority
  normalized through the carrier's QoS provider. _Cost if wrong:_ one constructor shape.
- **R-V1b-11:** WS backpressure at submission (socket ≥ 256 KiB or a `ws` fault) applies to every message, controls
  included, as the RTC channel's own overflow does; the planning-time read covers data admissions only. _Cost if
  wrong:_ an ACK waits 50 ms on a full socket.
- **R-V1b-12:** the WS client calls `planALMessageHandling(msg, { nowMs, selfPeerId, overloaded: false,
  backpressured: true }, …)` only when backpressured and refuses only when `toALOutboundCongestionDrop` names a drop;
  the dispatch context gains required `nowMs` and `backpressured`. _Cost if wrong:_ one planner call per full
  admission.
- **R-V1b-13:** the overlay's `faultPort` dependency and the matching input to `initialiseRtcOverlayMulticastManager`
  are required, wired from `diagnosticsPorts.transportFaultPort` (39 mechanical test edits; two facade-default pins
  gain `decideBackpressure`). _Cost if wrong:_ an optional port would hide a miswired composition.
- **R-V1b-14:** the WS watermark comparison lives in `WsQueueBoxClientService` beside
  `AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES`; `JsonWebSocketClient` only exposes `decideBackpressureFault(message)`.
  _Cost if wrong:_ one method's home.
- **R-V1b-15 (carry):** RTC unicast sends (planned with direction `inbound`) and unaddressed sends stay outside both
  congestion inputs this slice, the same gap V1a carried for `overloaded`; recorded at the close as a D188 carry for
  V1b-ii. Facade proofs and cells use room sends. _Cost if wrong:_ a best-effort unicast under backpressure defers,
  expires or hands over after three `not-ready`s instead of being refused `congested`.
- **R-V1b-16 (amended by R-V1b-28):** an RTC send consumes one fault count at its admission plan and one per
  submission; under `rtc-with-ws-fallback` three `not-ready`s hand the send to WS (D56), so `backpressure-deferred`
  runs on `rtc` and `ws` only. Its `remaining: 40` is withdrawn. _Cost if wrong:_ a cell carrier list.
- **R-V1b-17:** the `hand-over` diagnostic is written by `BrowserRallarMessageDispatch` (`computeFallbackDisposition`
  decides the admission hand-over); `browser-message-fallback-controller.ts` only watches admitted RTC legs and stays
  untouched. _Cost if wrong:_ one function's home.
- **R-V1b-18:** the sink reaches the dispatch through a new required member
  `RallarBrowserMiddleware.outboundDiagnostics`, set in `toBrowserMiddleware` from `diagnosticsPorts.outboundDiagnostics`
  (no new export name). _Cost if wrong:_ one middleware member.
- **R-V1b-19:** the hand-over's priority is `normalizeALQosPolicy(message).effective.congestion.opts.priority` (the
  dispatch holds no QoS provider). _Cost if wrong:_ a provider-overridden priority differs from the carrier's `drop`;
  the fix would carry the congestion drop on the refused verdict (a Task 1 contract change) — for the final review.
- **R-V1b-20:** the block is `stats.rallar.congestion` beside `alm` (design 2.c's `stats.rallar.alm.congestion`
  corrected; D186 "As applied" at the close). _Cost if wrong:_ one path.
- **R-V1b-21:** counters are per connection — reset at the harness `close`, `undefined` while disconnected. _Cost if
  wrong:_ a cell reading a previous connection's count.
- **R-V1b-22:** the observation fold sums, across the cell's pages, each page's largest reading of each count
  (unasserted). _Cost if wrong:_ an artifact figure.
- **R-V1b-23 (amended by R-V1b-37):** docs are Task 5's; Task 3 carries code, capability text and tests.
- **R-V1b-24:** the facade proofs use the real overlay (`createRtcOriginOverlayFixture`) and the real WS client
  (`createDefaultWsQueueBoxClientService`) with thin forwarders under the real dispatch, registry and session
  deliveries; no full `initialiseMiddleware` composition; the WS ACK goes through `ws.acceptIncomingMessage`. _Cost if
  wrong:_ a composition gap the lane cells cover.
- **R-V1b-25:** both budget raises (facade 244, headless 310) belong to Task 3. _Cost if wrong:_ none.
- **R-V1b-26:** Task 3's text keeps its exact values over the length target. _Cost if wrong:_ none.
- **R-V1b-27:** the deferred cell's witness is `stats.rallar.congestion.deferred > 0`, not a `not-ready` attempt
  outcome (a retried attempt's row is overwritten). _Cost if wrong:_ one assertion.
- **R-V1b-28:** every congestion hold is `until-cleared`, released by the same `faultId` with `remaining: 0`; the
  deferred hold is a 2 s absent-diagnostic wait (the recipe-validation test refuses counted faults). _Cost if wrong:_
  a hold left open across cells.
- **R-V1b-29 (amends R-V1b-1):** the observation gains a required `attemptRefusalReasons` (refused rows only, attempt
  order; contract, ledger, result, decoder `isAlmRefusalReason`, capability text), so the hands-over cell asserts
  `attemptRefusalReasons ['congested']` and `congestion.handedOver > 0`. _Cost if wrong:_ about ten files leave Task 4
  and the counter is the only witness.
- **R-V1b-30:** the congestion cells state `reliability` explicitly (both harness channel purposes default to
  at-least-once = priority 5, which `drop-low` never drops); verified at composition: the facade proofs send
  `best-effort` where a drop is expected and `at-least-once` where a deferral is. _Cost if wrong:_ a vacuous cell.
- **R-V1b-31:** the cells run last in the two-agent family and read their counters with `gt 0` (no earlier cell
  raises one). _Cost if wrong:_ vacuous if an earlier cell starts deferring.
- **R-V1b-32:** Task 5 owns every doc wording; it adds a schema-compatibility note and "nor `backpressured`" in the
  inbound README; the `fault.inject` paragraph now also lists `not-ready`. _Cost if wrong:_ none.
- **R-V1b-33:** the API reference names no release ids; the product description names V1b-i and V1b-ii; "RTC unicasts
  read no congestion" is a stated Limit carrying R-V1b-15. _Cost if wrong:_ doc wording.
- **R-V1b-34 (assembly):** commit messages carry no task id: Task 3's "(242.952 after Tasks 1 and 2)" reads "(242.952
  before this change)" and its D8 line drops "Task 1's"; Task 5's "fairness is V1b-ii's" reads "fairness comes in a
  later slice". _Cost if wrong:_ none.
- **R-V1b-35 (assembly):** Task 2's commit message gains the `D8 reuse:` line its prototype lacked (from its D8
  inspection paragraph), so every commit carries one. _Cost if wrong:_ one paragraph.
- **R-V1b-36 (assembly):** the outbound README named "the browser's fallback controller" as the `hand-over` writer;
  Task 5 now names the browser's message dispatch (R-V1b-17), and its "true of the code" list says so. _Cost if
  wrong:_ none — the code is the authority.
- **R-V1b-37 (assembly, amends R-V1b-23's wording):** `schema-and-capabilities.md`'s `fault.inject` paragraph says the
  carrier reads the `backpressure` fault "when it plans a matching origination and when it submits a matching frame;
  each such read consumes one of `remaining`" — the submissions consult it too (`rtc-outbound-submission.ts:65`,
  `ws-queue-box-client-service.ts:595`). _Cost if wrong:_ doc wording.
- **R-V1b-38 (assembly):** the API reference named an RTC unicast "(`toPeer`)", a control wire field; the facade's
  option is `peerId` (`rallar-message-contracts.ts:90`), so it reads "an RTC unicast (a send naming `peerId`)". _Cost if
  wrong:_ doc wording.
- **R-V1b-39 (assembly):** the cells are not a lane family of their own: they run in the two-agent family, whose
  Playwright title is `baseline family over <carrier> (<scope>)` (`full-stack-alm-conformance.spec.ts:131`), so Task 6
  filters with `-g "baseline family"`; D187's "`congestion` lane family" is recorded as applied (the `congestion`
  scenario subfolder of the two-agent family). _Cost if wrong:_ a lane filter.
- **R-V1b-40 (assembly):** at composition each task's focused files, typechecks and gates ran on its own commit; the
  broad sweeps ran on Task 3's commit and the final head; Tasks 1–4 are tree-identical to the writers' prototypes
  (only messages changed), so their figures carry. _Cost if wrong:_ an intermediate red invisible at Tasks 1, 2 or 4
  — the per-task SDD run reruns each task's own checks.

## Limits (carried; Task 6 states them in the PR body)

- RTC unicast sends (planned with direction `inbound`) and unaddressed sends read neither congestion input this
  slice: a best-effort unicast under backpressure defers, expires or hands over after three `not-ready`s (R-V1b-15; a
  D188 carry for V1b-ii). Facade proofs and cells use room sends only.
- The WS client reads `backpressured` only; on RTC the planner's overloaded drop still precedes the ledger, so an
  overloaded best-effort RTC send is a limit-less `capacity` (R-V1b-4; D185 amended at the close).
- A queued best-effort send defers at submission rather than being refused at dequeue: only a new admission's plan
  reads backpressure (R-V1b-7).
- WS submission backpressure applies to controls too: an ACK waits 50 ms on a full socket (R-V1b-11).
- The hand-over's priority comes from `normalizeALQosPolicy(message)`, not the carrier's QoS provider (R-V1b-19).
- The congestion counters reset at `close`; they are per connection, `undefined` while disconnected (R-V1b-21).
- A retried attempt's row is overwritten: `not-ready` is visible in the attempt evidence only while the hold lasts;
  the counter `deferred` is the durable witness (R-V1b-27).
- A handed-over send counts in both `dropped` and `handedOver` (the RTC admission's own `drop` comes first).
- The cells are local and the hosted full read's: hosted manifests 18 and 22 withhold all three and stay
  byte-identical (D187).
- Carried (design §5, D188): fairness under many tracks and churn (V1b-ii); `replace-latest` and bounded-queue
  policies on the reliable lane; relay fanout reduction and alternate routes; server-side WS backpressure; per-hop
  routing around one backpressured peer; a per-peer backpressure metric.

## Corrections and notes (Task 6 states them in the PR body's Corrections)

- **Design §2.c's `stats.rallar.alm.congestion`:** the block is `stats.rallar.congestion` beside `alm` (R-V1b-20).
- **Design §2.d and D187's hand-over "with `carrierFallback` evidence":** an admission hand-over writes a `refused`
  RTC row with `refusalReason: 'congested'` and no `carrierFallback` (R-V1b-1, R-V1b-29); the deferred cell's "at least
  one `not-ready` attempt" is witnessed by `deferred > 0` (R-V1b-27); D187's "`congestion` lane family" is three cells
  of the two-agent family (R-V1b-39).
- **D186's emitter list:** the `hand-over` diagnostic is the browser message dispatch's, not the fallback
  controller's (R-V1b-17, R-V1b-36).
- **The planning frame's `decideBackpressure(match)`** is `decideBackpressure(carrier, message)` (R-V1b-5);
  `readOutgoingQosPolicy` gains no `backpressured` (R-V1b-8); the frame's "the ledger refuses `capacity` before this
  runs" on WS was backwards — the planner runs first, hence R-V1b-4.
- **The survey's §1.3 UNVERIFIED derivation is confirmed by measurement:** a WS `not-ready` without `retryAfterMs`
  retries at once (201 attempts in 200 ms on fake timers); with the shared constant 3–5.
- **The harness field lists drifted:** the `fault.inject` paragraph never listed `not-ready` (fixed in Task 5), and the
  harness observation never projected `refusalReason` (fixed in Task 4 as `attemptRefusalReasons`).
- **The API reference's "best-effort fairness lane" (`:29-32`)** describes the ResourceInbox, not ALM (survey §7); it
  is V1b-ii's to restate, not this slice's.
- **The product description's scope list:** its congestion section becomes CURRENT for the live input, the per-cause
  outcomes and the counters; `replace-latest`, the bounded queue, fanout reduction and the rest stay PLANNED (Task 5).
- **The main worktree's `apps/api-v1/node_modules`** keeps `graphology`, `postgres` and `prisma` symlinked into
  `.deno` after any Deno run in a worktree that shares it; removing `.deno` leaves them dangling until the next Deno run
  or `npm install` repairs them.

## Tasks

### Task 1: The live backpressure flag, the congestion cause and the `congested` outcome (D184, D185, D186)

**Files** (anchors at the design head `0d8e3f9ab`, this task's parent; the composed commit is
`.superpowers/sdd/v1b-plan/final-patch-task-1.patch` (`e1fb00f33` on the scratch tree), `git am`-able there; 17 files,
+549/−61). Production:

- `packages/shared/al-contracts/al-policy.ts`: `ALQosNormalizationInput.live` (`:166`), `ALQosMessageContext` (`:181`) and
  `ALMessagePlanningContext` (`:227`) each gain, after `overloaded`, `/** The carrier's channel cannot take the send now
  (D184); absent when the carrier read no channel. */ readonly backpressured?: boolean;`. After `ALCongestionRuntimeAction`
  (`:231`): `/** Which live input the congestion policy answers: the session's own volatile bound, or its carrier's channel
  (D185). */ export type ALCongestionCause = 'overloaded' | 'backpressured';`. `ALMessageDropReasonCode` (`:240`) and
  `AL_MESSAGE_DROP_REASON_CODES` (`:253`) gain `'congested'` after `'overloaded'`. `ALMessageHandlingPlan.congestion`
  (`:304-308`) gains `/** The input the action answers, \`overloaded\` when both hold (D185); \`undefined\` exactly when the
  action is \`none\`. _/ readonly cause: ALCongestionCause | undefined;`(required;`overloaded`keeps its field, R-V1b-2).`computeMessageHandlingDecision`(`:467-478`):`const backpressured = context.backpressured ?? input.live?.backpressured ??
  false;`beside`overloaded`,`backpressured`joins the`live`handed to`normalizeALQosPolicy`, and`congestion:
  planCongestion(result.effective, resolveCongestionCause(overloaded, backpressured))`.`resolveMessageDrop`(`:517-528`) ends`return resolveCongestionDrop(congestion);`— new private`/_* \`reject\` drops every message and \`drop-low\` the lowest
  priority; the drop names its cause (D185). _/ resolveCongestionDrop(congestion: ALMessageHandlingPlan['congestion']):
  ALMessageDrop | undefined`: not dropped →`undefined`; cause`backpressured`→`{ code: 'congested', reason: 'Carrier
  backpressure dropped the send' }`; else the two`overloaded`drops with today's reasons. Before`planCongestion`(`:650`):
  private`/_* The session's own bound comes first: when it and the carrier's backpressure both hold, the cause is
  \`overloaded\`. */ resolveCongestionCause(overloaded: boolean, backpressured: boolean): ALCongestionCause | undefined`.`planCongestion(effective, cause: ALCongestionCause | undefined)`(rewritten,`:650-682`): destructure`{ algo, opts: {
  priority } }`,`overloaded = cause === 'overloaded'`;`cause === undefined`→`{ overloaded, action: 'none', priority, cause
  }`; else the switch returns`reject`/`defer`/`drop-low`with`{ overloaded, …, priority, cause }`.`planNack`is unchanged:
  no new NACK reason (an origination drop has no`fromPeerId`). No new export (the file stays at 11 runtime values).
- `packages/shared/alm/outbound/al-outbound-message-runtime.ts`: the `al-policy.ts` type import (`:3-8`) adds
  `ALCongestionCause`, `ALMessageHandlingPlan`. Before `ALOutboundSettledSendResult` (`:71`): `/** The delay a carrier names
  on a \`not-ready\` submission, on both carriers: a full channel or socket may drain within it (D185). _/ export const
  AL_SUBMISSION_NOT_READY_RETRY_MS = 50;`.`ALOutboundDropReasonCode`(`:142-152`) gains`'congested'`after`'capacity'`.`ALOutboundDispatchPlan`after`capacityLimit`(`:160`):`/_* The congestion decision behind a \`capacity\` or
  \`congested\` drop the planner made (D186); absent on every other plan. */ readonly congestionDrop?:
  ALOutboundCongestionDrop;`. After`ALCheckpointOutboundRuntimeStores`(`:215`), in order:`export interface
  ALOutboundCongestionDrop { readonly cause: ALCongestionCause; readonly priority: number; }`(doc "The congestion decision
  behind a drop: its cause and the message's priority (D186).");`export interface ALOutboundCongestionDiagnostic { readonly
  kind: 'congestion'; readonly carrier: ALDeliveryCarrier; readonly cause: ALCongestionCause; readonly action: 'drop' |
  'defer' | 'hand-over'; readonly priority: number; readonly msgId: string; }`(doc: one congestion decision on this
  session's own send —`drop`at its admission,`defer`at a submission its channel or socket could not take,`hand-over`by
  a fallback strategy that moved a congested leg);`export interface ALCongestionCounters { readonly dropped: number;
  readonly deferred: number; readonly handedOver: number; }`(doc "…counted from its \`congestion\` diagnostics by action
  (D186)."); `export function toALOutboundCongestionDrop(plan: Pick<ALMessageHandlingPlan, 'dropReasonCode' |
  'congestion'>): ALOutboundCongestionDrop | undefined` (`{ cause, priority }` when the code is `overloaded` or `congested`
  and the cause is defined); `export function writeALOutboundCongestionDiagnostic(diagnostics:
  ALOutboundRuntimeDiagnosticsSink | undefined, decision: ALOutboundCongestionDiagnostic): void` (doc "A throwing sink
  changes no admission, submission or hand-over: the decision is already made."; `try { diagnostics?.(decision); } catch
  (error) { console.error('AL outbound runtime diagnostics sink failed', error); }`). The diagnostics union (`:300`) ends
  `| ALOutboundCongestionDiagnostic`. `planAdmission` (`:647-661`): doc gains ", and states a congestion drop of that plan";
  after the planner's `try/catch`, `if (plan.congestionDrop !== undefined) { writeALOutboundCongestionDiagnostic(
  this.dependencies.diagnostics, { kind: 'congestion', carrier: this.dependencies.carrier, cause: plan.congestionDrop.cause,
  action: 'drop', priority: plan.congestionDrop.priority, msgId: msg.id.msgId }); }` — before the ledger, so a ledger
  `capacity` refusal states none (R-V1b-3). Both helpers live here, not in new files (R-V1b-3).
- `outbound/compute-al-outbound-dispatch.ts:289`: `case 'congested':` joins `unauthorized`/`unsupported`/`no-leader`.
- `alm/delivery/al-delivery-lifecycle.ts:60-67`: `ALDeliveryRefusalReason` gains `| 'congested'`; its doc becomes two
  lines (`no-leader` as today; "\`congested\`: the carrier's channel could not take the send and its congestion policy
  dropped it (D185)."). `resolve-al-delivery-fallback-trigger.ts:21-24`: `AL_DELIVERY_FALLBACK_REFUSAL_REASONS = ['unsupported',
  'congested']`, doc adds "; a carrier whose channel is congested hands the send to the other one (D185)".
- `alm/inbound/decode-al-inbound-plan.ts`: `assertSupersedenceAndCongestion` (`:140-176`) splits into
  `assertSupersedencePlan(value)`, `assertCongestionPlan(value)`, `assertOwnershipPlan(value)` (called at `:63` with
  `plan.supersedence`, `plan.congestion`, `plan.ownership`); the congestion fields allow `cause` (not required) and a defined
  cause must be `overloaded` or `backpressured`. A stored plan without `cause` decodes (no migration).
- `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`: import `AL_SUBMISSION_NOT_READY_RETRY_MS` and
  `toALOutboundCongestionDrop` (`:31-39`); the drop branch of `planOutboundDispatch` (`:704-712`) adds `congestionDrop:
  toALOutboundCongestionDrop(plan.handlingPlan)`; the held-authority `not-ready` (`:807`) uses the constant;
  `toALOutboundDropReasonCodeFromHandlingPlan` (`:982-1004`): doc "The six codes…", `case 'congested':` returns the code;
  `overloaded` stays `capacity`. `rtc-outbound-submission.ts`: value import of the constant; the four `not-ready`
  `retryAfterMs: 50` (`:36`, `:46`, `:107`, `:114`) use it; the `failed` one (`:111`) stays 50 (R-V1b-3).
- `packages/shared-test/rallar-bb-test/alm/decode-alm-delivery-failure.ts:29`: `ALM_REFUSAL_REASONS` gains `congested: true`.

Tests: `packages/tests/shared/al-policy.test.ts` (new describe at the end), `alm/outbound-admission-verdict.test.ts`
(before `:234`), `alm/delivery/resolve-al-delivery-fallback-trigger.test.ts` (`:82`, row after `:111`),
`alm/al-inbound-persistence-validation.test.ts` (row after `:444`), `shared-test/alm-delivery-failure-decoding.test.ts`
(rows after `:27` and `:62`), new `alm/outbound/al-outbound-congestion-diagnostic.test.ts`, new
`multicast/web-rtc-overlay-congestion.test.ts`; `multicast/rtc-origin-overlay-fixture.ts` gains `diagnostics: readonly
ALOutboundRuntimeDiagnosticsEvent[]` (the manager's `outboundDiagnostics` pushes into it).

**Interfaces produced** (W-B, W-C, W-D consume): `backpressured?` on the three contexts; `ALCongestionCause`;
`plan.congestion.cause`; drop code / outbound drop code / refusal reason `congested`; the two-entry fallback refusal list;
`AL_SUBMISSION_NOT_READY_RETRY_MS`; `ALOutboundDispatchPlan.congestionDrop` + `ALOutboundCongestionDrop`;
`toALOutboundCongestionDrop`; `ALOutboundCongestionDiagnostic` (union arm); `writeALOutboundCongestionDiagnostic`;
`ALCongestionCounters`. A WS planner that drops for congestion sets `congestionDrop` and the runtime states the `drop`.
Admission hand-over evidence: a `congested` leg is a `carrier-refused` attempt row (`outcome: 'refused'`, `refusalReason:
'congested'`), NOT `carrierFallback` (R-V1b-1). **Consumed**: nothing new.

**D8 reuse inspection.** The planner's congestion branch, drop code, refusal reason, fallback refusal list and the
outbound diagnostics sink carry the new cause; the guarded writer follows `writeALOutboundControlAdmissionDiagnostic`. No
cache, map or new file in a directory over the density threshold. Deleted: the inline congestion drops of
`resolveMessageDrop`, `assertSupersedenceAndCongestion`.

- [ ] **Step 1: Write the failing tests** (copy from `final-patch-task-1.patch`). Planner, describe "the congestion policy on a live cause"
      (`originate` = unicast `self`→`peer`; `planOrigination(message, live)`): "drops a best-effort origination as congested
      when its carrier reads backpressure" (code `congested`, reason `Carrier backpressure dropped the send`, congestion `{
      overloaded: false, action: 'drop-low', priority: 0, cause: 'backpressured' }`, nack disabled); "lets an at-least-once
      origination through backpressure under the default policy" (no code, priority 5); "refuses an origination of any
      priority as congested under the reject policy" (priority 9); "drops nothing at planning under the defer policy, which
      leaves the wait to submission"; "names the overloaded cause when the session bound and the carrier backpressure both
      hold" (code `overloaded`); "reads backpressure from the live input when the planning context names none"; "names no
      cause and takes no action when neither input holds" (`toStrictEqual` with `cause: undefined`). Verdict: "is refused as
      congested when the planner drops the message for carrier backpressure, and hands it over" (`toStrictEqual({ kind:
      'refused', reason: 'congested', detail })`, fallback verdict `true`). Trigger: list `['unsupported', 'congested']`; row
      `[{ kind: 'refused', reason: 'congested', detail: 'carrier backpressure' }, true]`. Inbound: row `{ congestion: {
      overloaded: true, action: 'drop-low', priority: 0, cause: 'busy' } }`. Decoder: `{ refused, congested }` round-trips;
      `{ refused, congested, limit: 'bytes' }` fails at `failure.limit`. Runtime ("the congestion decision of an outbound
      admission"): "states one congestion drop for an origination its planner dropped for carrier backpressure" (carrier
      `rtc`, `enqueueAllIfAbsent`, exact event); "states the overloaded cause for the capacity drop the planner made" (`ws`);
      "states no congestion decision for a refusal of the session volatile ledger" (`maxAdmissions: 1`, second send `limit:
      'admissions'`, no event); "keeps the verdict when its diagnostics sink throws" (console.error called). Overlay ("the RTC
      origin's congestion drop, by its cause", provider marking own outbound sends): "refuses a best-effort send its carrier
      reads as backpressured as congested, and sends nothing" (no `limit`, exact event); "admits an at-least-once send its
      carrier reads as backpressured and states no drop"; "keeps an overloaded send refused for capacity and states its cause
      overloaded".
- [ ] **Step 2: Run red.** `git show --name-only --format= HEAD | grep '\.test\.ts$' | xargs npx vitest run`: 7 files (6
      failed, 1 passed); 17 failed, 169 passed (186); e.g. `expected undefined to be 'congested'`, `expected [ 'unsupported' ]
      to deeply equal [ 'unsupported', 'congested' ]`, `expected [] to deeply equal [ ObjectContaining{…} ]`.
- [ ] **Step 3: Implement** as listed. Green: 7 files, 186 passed.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared/alm packages/tests/shared/multicast
      packages/tests/shared/al-policy.test.ts packages/tests/shared-test/alm-delivery-failure-decoding.test.ts
      packages/tests/shared-web/messages` (162 files, 2135 passed); the wider sweep `packages/tests/shared
      packages/tests/shared-web packages/tests/shared-test packages/tests/rallar-black-box packages/tests/rallar-black-box-headless`
      (1313 files) shows only the known sandbox reds (`live-rtc-control-client`, `local-websocket-session`,
      `api-v1-rtc-rtt-recipe-semantics`, `api-v1-state-write-convergence-recipe`, `headless-worker-script`; under load
      `inbound-admission-diagnostics` "…over indexeddb" can red and passes alone); the four IndexedDB pins pass unchanged.
      `npx tsc -p packages/shared/tsconfig.json --noEmit`, `npx tsc -p packages/shared-web/tsconfig.json --noEmit`, `npx tsc -p
      packages/shared-server/tsconfig.json --noEmit`, `npm --workspace @ar-eye-hunter/shared-test run typecheck`; `deno check`
      on the changed `packages/shared/**` files; `cd apps/api-v1 && deno task check` (and the control server's), then remove
      the two `node_modules/.deno` dirs; `node scripts/check-tests-typecheck.mjs` (PASS). With `TMPDIR=$(mktemp -d
      /tmp/claude-501/b.XXXX)`: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` (`browser/rallar.ts`
      242.459 KiB brotli, base 242.352, < 243: no raise), the bundle-boundary, public-API-snapshot and headless boundary
      tests (18 passed; headless 308.429 KiB, base 308.146, < 309). `npx dprint fmt` on the touched files through `xargs`.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 0d8e3f9ab HEAD` (`PASS: no new repository style
      findings`), `node scripts/check-test-structure-coupling.mjs --changed 0d8e3f9ab HEAD` (PASS), `npm run
      check:test-reachability` (1784 files, 1778 reached, 6 manual).

```text
Plan congestion on the carrier's backpressure and refuse a backpressure drop as congested

The QoS context, the live input and the planning context gain an optional backpressured flag beside
overloaded; absence means the carrier read no channel. The planner reads it as it reads overloaded
and applies the congestion policy when either holds. The handling plan's congestion names its cause,
overloaded when both hold, undefined when the action is none. A backpressure drop is the new drop
code congested ("Carrier backpressure dropped the send"); an overloaded drop keeps its code and its
reasons, and no new NACK reason exists, since an origination drop NACKs nobody. The persisted
inbound plan decoder admits the cause.

The outbound drop code, the delivery refusal reason and the fallback refusal list gain congested, so
a congested RTC leg hands over to WS at admission as unsupported does and a congested send without a
fallback ends rejected with failure { kind: 'refused', reason: 'congested' } and no attempt. The RTC
overlay maps congested to congested and keeps overloaded as capacity. The black-box failure decoder
reads the new reason.

The outbound diagnostics gain the congestion kind { carrier, cause, action, priority, msgId } and the
counters ALCongestionCounters { dropped, deferred, handedOver }. A planner states the decision behind
its drop as the plan's congestionDrop (toALOutboundCongestionDrop over the handling plan); the
outbound runtime states one congestion drop for it when it plans the admission, through
writeALOutboundCongestionDiagnostic, which a throwing sink cannot fail. A ledger capacity refusal is
no congestion decision and states none. AL_SUBMISSION_NOT_READY_RETRY_MS (50) replaces the RTC
submission's not-ready literals.

D8 reuse: the planner's congestion branch, the drop code, the refusal reason, the fallback refusal
list and the outbound diagnostics sink carry the new cause; the diagnostic writer follows the control
admission's guarded writer.
```

### Task 2: The RTC overlay and the WS client read their channels (D184, D185)

**Files** (anchors at Task 1's commit `e1fb00f33`, this task's parent; the composed commit is `final-patch-task-2.patch`
(`76a6d8b49`); 36 files, +915/−82; no new file under `packages/shared/alm/outbound` and no new `al-policy.ts` export, R-V1b-3)

- `packages/shared/transport-faults/transport-fault-port.ts`: `TransportFaultPort` (`:16-18`) gains
  `decideBackpressure(carrier: TransportFaultCarrier, message: ALMessage): boolean;` doc "Whether the carrier reports itself
  backpressured for this message, whatever its channel or socket holds." (type import `ALMessage` from `../al-contracts/al-contract.ts`);
  `ScriptedTransportFault.action` (`:35`) gains `'backpressure'`; `TransportFaultObservation.decision` (`:42`) gains `'backpressure'`;
  the pass-through (`:69`) returns `decideBackpressure: () => false`. In the scripted class a private
  `type TransportFaultStage = 'readiness' | 'frame' | 'backpressure'` and `toTransportFaultStage(action)` (`not-ready` → readiness,
  `backpressure` → backpressure, else frame) replace the `(fault.action === 'not-ready') === (stage === 'readiness')` test;
  `findMatchingFault(carrier, facts: SerializedFrameFacts | undefined, stage)` takes decoded facts (callers pass
  `toSerializedFrameFacts(serialized)`); `decideSend` narrows `fault?.action === 'drop'` first, then passes any string action;
  `decideBackpressure` matches `decodeSerializedFrameFacts(message)` at stage `backpressure` and consumes one count per `true`.
- Create `packages/shared/multicast/compute-rtc-backpressure.ts`: `computeRtcBackpressure(channelsOfReadyNextHops: readonly
  Pick<RtcDataChannelHealth, 'bufferedAmount' | 'flowControl'>[]): boolean` — non-empty and every `bufferedAmount >=
  flowControl.highWatermarkBytes`; doc states a message with no ready next hop is not backpressured.
- `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`: `Channel.readHealth()` (`:122`) widens to
  `Pick<RtcDataChannelHealth, 'readyState' | 'bufferedAmount' | 'flowControl'>`; `Dependencies` gains `readonly faultPort:
  TransportFaultPort;` after `rateLimiter` (`:147`); a file-private `type RtcOutgoingPlanStage = 'admission' | 'dequeue' | 'replan'`
  replaces `alreadyOwned` (`planDequeuedMessage` `:524` is deleted). The runtime wiring (`:198-199`):
  `planOutgoingMessage: (msg, authority) => this.planOutgoingMessage(msg, authority === undefined ? 'admission' : 'replan')`
  (one comment line: a plan without authority is a new admission's), `planDequeuedMessage: (msg) => this.planOutgoingMessage(msg,
  'dequeue')`; the two repair re-plans (`:929`, `:975`) pass `'replan'`; `planOriginatingDispatch` sets
  `const alreadyOwned = stage === 'dequeue'` and passes `stage` to `planOverlayDispatch` (`:597`), which resolves the qos input once,
  plans, and when `stage === 'admission' && this.readBackpressure(msg, plan)` plans again with `{ ...qos, live: { ...qos.live,
  backpressured: true } }`. Private `readBackpressure(msg, plan: OverlayMulticastDispatchPlan): boolean`: `false` for a control
  typeId, a plan with `dropReason` or no transport messages; else `this.faultPort.decideBackpressure('rtc', msg)` first, else
  `computeRtcBackpressure` over the plan's copies' next-hop channel healths whose `readyState === 'open'`. The submission is built
  with `new RtcOutboundSubmission({ connectionService, clock: this.clock, faultPort, qosProvider, diagnostics: outboundDiagnostics })`.
- `packages/shared/multicast/rtc-outbound-submission.ts`: `export namespace RtcOutboundSubmission { export interface Dependencies
  { connectionService; clock; faultPort: TransportFaultPort; qosProvider: ALQosInputProvider; diagnostics:
  ALOutboundRuntimeDiagnosticsSink | undefined } }` replaces the two positional parameters (`:16`). After the `readyState` check:
  `if (this.dependencies.faultPort.decideBackpressure('rtc', msg)) return this.deferBackpressuredSend(msg, peerId);`
  `submitPreparedMessage(hop: RtcSubmissionHop, msg, lifecycle)` (private `RtcSubmissionHop { peerId; channel; flowControl }`,
  `:51` passes `health.flowControl`); before the synchronous `toALOutboundRtcSettlement` (`:83`): `if (result.status === 'dropped' &&
  computeRtcBackpressure([{ ...result, flowControl: hop.flowControl }])) return this.deferBackpressuredSend(msg, hop.peerId);`.
  `deferBackpressuredSend` writes the deferral and returns `{ status: 'not-ready', submissionAttempted: false, reason: \`RTC channel
  for peer ${peerId} is backpressured\`, retryAfterMs: AL_SUBMISSION_NOT_READY_RETRY_MS }`. Do not pre-check health before`sendJson`: a queue-overflow lane must keep queueing (R-V1b-9).
- `packages/shared/alm/outbound/al-outbound-message-runtime.ts` after `writeALOutboundCongestionDiagnostic` (`:260`):
  `WriteALOutboundCongestionDeferralInput { diagnostics; carrier: ALDeliveryCarrier; message: ALMessage; selfPeerId: string;
  qosProvider: ALQosInputProvider }` and `writeALOutboundCongestionDeferral(input): void` — normalizes the message with
  `resolveALQosNormalizationInput(message, { direction: 'outbound', selfPeerId }, qosProvider)` and writes `{ kind: 'congestion',
  carrier, cause: 'backpressured', action: 'defer', priority: effective.congestion.opts.priority, msgId }`. The policy import
  becomes a value import of `normalizeALQosPolicy`, `resolveALQosNormalizationInput` with the types inline.
- `packages/shared/websocket/json-web-socket-client.ts` after `decideSubmissionReadiness` (`:228`):
  `decideBackpressureFault(message: ALMessage): boolean { return this.faultPort.decideBackpressure('ws', message); }`.
- `packages/shared/services/ws-queue-box-client-service.ts`: `export const AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES = 256 * 1024;`
  before `:72`; wiring (`:229-230`) as on RTC with stages `'admission' | 'replan'` (dequeue passes `'replan'`); `planOutgoingMessage`
  (`:278`) passes `nowMs: this.dependencies.outboundRuntime.clock.nowMs()` and `backpressured: readsBackpressure &&
  this.decideBackpressure(msg)` where `readsBackpressure = stage === 'admission' && !isALControlTypeId(msg.payload.typeId)`;
  private `decideBackpressure(message)` = `this.socket.decideBackpressureFault(message) || (this.socket.ws?.bufferedAmount ?? 0)
  > = AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES`. In`dispatchOutboxEntry`the`readSubmissionIneligibility`(`:566`) and readiness
  (`:570`)`not-ready`s and`readSendIneligibility`'s (`:600`) gain`retryAfterMs: AL_SUBMISSION_NOT_READY_RETRY_MS`; after the
  readiness check`if (this.decideBackpressure(lifecycle.canonicalMessage)) return this.deferBackpressuredSend(...)`(writes the`ws`deferral, returns`not-ready`, reason`'WS socket is backpressured'`, the retry constant).
- `packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts`: context (`:29`) gains `readonly nowMs:
  number;` and `readonly backpressured: boolean;` (doc: the client reads no `overloaded`, its ledger refuses those sends and names
  the limit, D179); a third `flatMap` after the ordering refusal (`:55`) calls private `computeCongestionRefusal(msg,
  normalizationInput, context)`: right when not backpressured; else `planALMessageHandling(msg, { nowMs, selfPeerId: sessionId,
  overloaded: false, backpressured: true }, normalizationInput)` and, when `toALOutboundCongestionDrop(handling)` names one, left
  `{ msg, dropReason: handling.dropReason, dropReasonCode: 'congested', congestionDrop, lane: 'volatile', preparedMessages: [] }`
  (R-V1b-3, R-V1b-4: no planner export, `overloaded` never read on WS; a WS send at the bound keeps the ledger's `capacity`+`limit`).
- `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts`: input (`:70`) gains `readonly faultPort: TransportFaultPort;`
  (doc "The session's transport faults, the same port its data channels decide their frames by."), passed at `:100`;
  `initialise-browser-middleware.ts:460` adds `faultPort: input.options.diagnosticsPorts.transportFaultPort`.
- Test wiring (mechanical, copy from `final-patch-task-2.patch`): `faultPort: createPassThroughTransportFaultPort()` after every `rateLimiter:` of a
  `WebRtcOverlayMulticastManager` construction (`webrtc-overlay-services.test.ts` ×18, `multicast-policy-integration.test.ts` ×10,
  eleven files ×1) and in the five `initialiseRtcOverlayMulticastManager({` calls (`acknowledgement-under-hold-fixture.ts` passes
  `runtime.faults`); `rtc-origin-overlay-fixture.ts` and `rtc-relay-overlay-fixture.ts` gain `faultPort?` input; the origin
  fixture's `sendJson` mock returns `{ status: 'dropped', reason: 'Back pressure', bufferedAmount }` at the high watermark, as the
  reliable lane's `drop-new` does; `TestWebSocket.bufferedAmount` becomes writable; the two facade-defaults expectations add
  `decideBackpressure: expect.any(Function)`; the two WS dispatch-plan `CONTEXT`s add `nowMs: Date.now(), backpressured: false`.

**Interfaces.** Consumes Task 1: `ALQosNormalizationInput.live.backpressured`, `ALMessagePlanningContext.backpressured`, the
`congested` drop code and its `capacity`/`congested` mapping in the overlay, `ALOutboundDispatchPlan.congestionDrop`,
`toALOutboundCongestionDrop`, `writeALOutboundCongestionDiagnostic`, `AL_SUBMISSION_NOT_READY_RETRY_MS`, the admission's `drop`
diagnostic. Produces for Task 3/4: `TransportFaultPort.decideBackpressure`, `ScriptedTransportFault.action 'backpressure'`, the
`defer` diagnostic on both carriers, `AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES`, `InitialiseRtcOverlayMulticastManagerInput.faultPort`.
The scripted fault is read once at an admission's plan and once per submission, each read consuming one count (R-V1b-16;
the lane holds `until-cleared`, R-V1b-28).

**D8 reuse inspection.** Reused: Task 1's planner via `planALMessageHandling` and `toALOutboundCongestionDrop`; the frame-facts
decoder for a message object; the channel's own health and send result; the session's existing transport fault port and outbound
diagnostics sink. Inspected, not reused: a pre-send health check (breaks queue-overflow lanes); the `'Back pressure'` reason string.

- [ ] **Step 1: Write the tests** (copy from `final-patch-task-2.patch`).
  - `packages/tests/shared/transport-faults/transport-fault-port.test.ts`: "passes everything through by default" gains the
    `decideBackpressure` line; "holds one carrier backpressured for a matching message, one decision per count"; "keeps a carrier
    backpressured until the fault is cleared".
  - `packages/tests/shared/multicast/compute-rtc-backpressure.test.ts` (4): every hop at/above, one hop below, all below, no hop.
  - `packages/tests/shared/multicast/web-rtc-overlay-backpressure.test.ts` (7): "refuses a best-effort room send as congested when
    every ready next hop is at its high watermark" (verdict `refused`/`congested`, one `drop` diagnostic, priority 0); "admits the
    send while one ready next hop can still take it, and sends on that hop"; "admits an at-least-once send through backpressure and
    defers its submission on each full hop" (two `defer` diagnostics, priority 5, a `not-ready` attempt with `willRetry: true`);
    "sends a deferred send once its hop drains, after the shared retry delay" (nothing at 49 ms, sent at 50); "holds the carrier
    backpressured for a message a scripted RTC fault matches, whatever its channels hold"; "reads no scripted fault of the WS
    carrier"; "forwards another session's best-effort message, leaving the full channel to its submission" (relay fixture,
    `remaining: 1`, exactly one `backpressure` observation).
  - `packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts`, `describe('the WS client's congestion decision
    on its own socket (D184, D185)')` (4): congested refusal with `congestionDrop { cause: 'backpressured', priority: 0 }`;
    at-least-once passes; `reject` priority 9 refused; a provider `overloaded: true` is left to the ledger (no drop).
  - `packages/tests/shared/services/ws-queue-box-client-backpressure.test.ts` (5): refused congested at the watermark with a `ws`
    `drop` diagnostic; admitted one byte below; at-least-once deferred then written when the socket drains (`defer`, priority 5);
    a scripted `ws` fault reads as a full socket; "retries a not-ready submission after the shared delay rather than at once"
    (fake timers, 200 ms → 3–5 attempts; without the delay it measures 201).
  - `packages/tests/shared-web/connection/initialise-browser-middleware.test.ts`: "gives the RTC overlay the session's transport
    fault port, which its data channels decide frames by".
- [ ] **Step 2: Run red.** `npx vitest run` on the eight files above plus `packages/tests/shared-web/rallar-facade-defaults.test.ts
  packages/tests/shared-web/composition/browser-facade-behavior.test.ts` → 8 files failed, 16 failed / 32 passed (and
      `compute-rtc-backpressure.test.ts` fails to import). **Step 3: Implement**; green → 8 files, 52 passed.
- [ ] **Step 4: Verify.** `npx vitest run packages/tests/shared/multicast packages/tests/shared/services
  packages/tests/shared/transport-faults packages/tests/shared/websocket packages/tests/shared/alm packages/tests/shared/al-policy.test.ts
  packages/tests/shared/multicast-policy-integration.test.ts packages/tests/shared/webrtc-overlay-services.test.ts
  packages/tests/shared/webrtc-rx-policy.test.ts packages/tests/shared/webrtc-rx-streamer-service.test.ts
  packages/tests/shared/webrtc-rtt-lifecycle.test.ts packages/tests/shared/browser-outbound-cancellation.test.ts
  packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared-web/connection
  packages/tests/shared-web/rtc packages/tests/shared-web/messages packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts`
      plus the two facade-defaults files → 224 files, 2723 passed. `npx tsc -p packages/{shared,shared-web,shared-server,shared-test}/tsconfig.json
  --noEmit`; `node scripts/check-tests-typecheck.mjs` (PASS); `deno check` on the changed `packages/shared/**` files; `cd apps/api-v1
  && deno task check` (no error), then remove `apps/api-v1/node_modules/.deno`; `npx dprint fmt` on the changed files via `xargs`.
      Bundles with a private `TMPDIR`: `check:browser-bundles` → `browser/rallar.ts` 242.95 KiB < 243 (no raise in this task);
      `shared-web-public-api-snapshots.test.ts`, `shared-web-browser-bundle-boundaries.test.ts`, `headless-bundle-boundary.test.ts` pass.
- [ ] **Step 5: Commit**, then `npm run check:repo-style:changed -- 0d8e3f9ab HEAD` (PASS), `node scripts/check-test-structure-coupling.mjs
  --changed 0d8e3f9ab HEAD` (PASS), `npm run check:test-reachability` (three files added; 1787 files, 1781 reached, 6 manual).

**True of the code after this task.** A best-effort room send whose every ready RTC next hop is full, or whose open WS socket holds
256 KiB, is refused `congested` at admission with a `drop` diagnostic; an at-least-once send is admitted and each full submission
is a `not-ready` with a 50 ms retry and a `defer` diagnostic; every WS `not-ready` names that retry; a scripted `backpressure` fault
holds one carrier full for matching messages; relay forwards, controls, dequeue re-plans and repairs never read backpressure.

```text
Read the RTC overlay's and the WS client's channels as the congestion policy's backpressure input

The RTC overlay's channel port widens to the reliable lane's buffered amount and
flow control. A new admission of the session's own data plans once; when its plan
has something to send and every ready next hop's channel holds at or above its
high watermark (computeRtcBackpressure), it plans again with the live
backpressured flag, so the congestion policy drops or refuses it as congested.
Relay forwards, controls, dequeue re-plans, repairs and inbound plans never read
it (D184). A submission whose channel drops it at the watermark answers
not-ready with the shared retry delay and reports a congestion defer.

The WS client reads its socket's bufferedAmount against
AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES (256 KiB) for a new admission of its own
data; when backpressured it runs planALMessageHandling on the send and refuses a
congestion drop congested with its congestionDrop. It reads no overloaded: its
session ledger refuses those sends and names the limit. Every WS not-ready now
carries AL_SUBMISSION_NOT_READY_RETRY_MS, and a full socket defers the attempt
(D185).

The scripted transport fault port gains the backpressure action and
decideBackpressure(carrier, message), which both carriers consult at planning and
submission; the browser composition hands the RTC overlay the session's transport
fault port. The facade bundle measures 242.95 KiB brotli (budget 243).

D8 reuse: the planner through planALMessageHandling and
toALOutboundCongestionDrop, the frame-facts decoder for a message object,
the channel's own health and send result, and the session's existing
transport fault port and outbound diagnostics sink; a pre-send health
check was inspected and refused, since a queue-overflow lane must keep
queueing.
```

### Task 3: The browser hand-over diagnostic, the facade proofs, the `fault.inject` backpressure action, `stats.rallar.congestion` and the observation fold (D185, D186, D187)

**Files** (anchors at Task 2's commit `76a6d8b49`, this task's parent; the composed commit is `final-patch-task-3.patch`
(`78fedc1bd`); 37 files, +1047/−39; no `packages/shared` source change)

- `packages/shared-web/browser/rallar-connection-facade.ts:53`: `RallarBrowserMiddleware` gains, after `volatileBudget`,
  `readonly outboundDiagnostics: ALOutboundRuntimeDiagnosticsSink;` doc "The connect's outbound diagnostics sink, which both
  carriers' runtimes report to; the dispatch reports its hand-overs there (D186)." (type import from
  `@shared/alm/outbound/al-outbound-message-runtime.ts`).
- `connection/initialise-browser-middleware.ts:275` `toBrowserMiddleware`: `carriers: Omit<RallarBrowserMiddleware,
  'volatileBudget' | 'outboundDiagnostics'>`, returns `{ ...carriers, volatileBudget: input.volatileBound.budget,
  outboundDiagnostics: input.options.diagnosticsPorts.outboundDiagnostics }` (doc: "...the one ledger the connect's carriers
  count against and reports to their one diagnostics sink.").
- `messages/browser-rallar-message-dispatch.ts`: in `writeCapturedMessage`, first line inside `if (admission.fallback ===
  'retry') {` (`:121`) is `writeCongestionHandOverDiagnostic(delivery, result);`. New private function before
  `toUnadmittedAdmission` (`:208`): returns unless `result.verdict.kind === 'refused' && result.verdict.reason === 'congested'`,
  then `writeALOutboundCongestionDiagnostic(delivery.context.middleware.outboundDiagnostics, { kind: 'congestion', carrier:
  delivery.carrier, cause: 'backpressured', action: 'hand-over', priority:
  normalizeALQosPolicy(result.message).effective.congestion.opts.priority, msgId: result.message.id.msgId })`; doc: a congested
  leg the strategy hands to its other carrier is a congestion decision of its own (D186); the carrier already reported its
  drop; the priority is the message's own effective one, since the dispatch holds no QoS provider. The admission hand-over is
  decided here (`computeFallbackDisposition`), NOT in `browser-message-fallback-controller.ts` (which only watches admitted RTC
  legs) — that file is untouched.
- `packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts:412`: transport `fault.inject`
  `action: ScriptedTransportFault['action'];` doc "`backpressure` holds the carrier at its high watermark for each matching
  origination it plans."; stats `rallar` block (`:1072`) gains `congestion?: ALCongestionCounters;` doc "The congestion decisions
  the page counted since its last `close`, read by the `stats` command (D186). Absent exactly where `alm` is."
- `schema.ts:447`: ws enum `['drop', 'not-ready', 'backpressure']`; add `const rtcFaultActionSchema: JsonSchema = { type:
  'string', enum: ['drop', 'backpressure'] };`; `:672` rtc branch uses it instead of `{ const: 'drop' }`.
- `alm/validate-alm-control-command.ts:321`: `'drop'` or `'backpressure'` pass; rtc message `${path} must be "drop" or
  "backpressure" on the rtc carrier.`; ws message `${path} must be "drop", "not-ready", "backpressure" or an object with delayMs.`
- `black-box-runner/.../messaging/decode-black-box-rallar-messaging-input.ts`: replace `FAULT_RTC_DELAY_UNSUPPORTED_MESSAGE`
  (`:31`) by `FAULT_RTC_ACTIONS: readonly ScriptedTransportFault['action'][] = ['drop', 'backpressure']` and
  `FAULT_RTC_ACTION_UNSUPPORTED_MESSAGE = 'fault.inject.action must be "drop" or "backpressure" on the rtc carrier.'`; `:91`
  tests `!FAULT_RTC_ACTIONS.includes(action)`; `decodeFaultAction` (`:152`) accepts `'backpressure'`, message `... "drop",
  "not-ready", "backpressure" or an object naming delayMs.`
- `alm/rallar-black-box-alm-command-capabilities.ts:141`: after the first sentence add "backpressure, on either carrier, makes
  the carrier read its channel as at its high watermark when it plans each matching origination, so the send meets its
  congestion policy: a best-effort send is refused congested or handed to WS under rtc-with-ws-fallback, an at-least-once send
  settles not-ready and retries."
- Create `black-box-runner/browser/rallar-browser-runtime/black-box-rallar-congestion-counters.ts`: interface
  `BlackBoxRallarCongestionCounters { observe(event: ALOutboundRuntimeDiagnosticsEvent): void; getCounters():
  ALCongestionCounters; reset(): void; }` and `createBlackBoxRallarCongestionCounters()` (the
  `createCountingIndexedDbOperationObserver` shape: a `let counters` starting `{ dropped: 0, deferred: 0, handedOver: 0 }`,
  `observe` folds only `kind === 'congestion'` through private `computeCongestionCounters(counters, action:
  ALOutboundCongestionDiagnostic['action'])`, a `switch` incrementing `dropped`/`deferred`/`handedOver`).
- `browser-rallar-runtime-composition.ts:151`: `BlackBoxBrowserDiagnosticsDependency` gains `readonly congestion:
  BlackBoxRallarCongestionCounters;`, created beside `storageFaults` and passed in `diagnostics: { faults, storage,
  storageFaults, congestion }`. `black-box-rallar-diagnostics.ts:122`: `outboundDiagnostics` calls
  `effects.congestion.observe(event)` before the existing emit. `connection/black-box-rallar-close-operation.ts:87`: the close
  `finally` also calls `this.#input.rallar.diagnostics.congestion.reset()`.
- `black-box-rallar-runtime-contract.ts:83`: `readCongestionCounters(): Promise<ALCongestionCounters | undefined>;` doc "The
  congestion decisions the page counted since its last `close`; `undefined` until the facade's connect completes."
  `connection/black-box-rallar-connection-runtime.ts:162`: `readCongestionCounters: async () => rallar.isConnected() ?
  rallar.diagnostics.congestion.getCounters() : undefined,`.
- `rallar-bb-test/browser/browser-command-contracts.ts:78`: `readCongestionCounters(): Promise<unknown>;`; the options `Omit`
  also omits `'readCongestionCounters'`. `browser-rallar-runtime-bridge.ts:37`: forward it as `readAlmUsage` is.
- `runtime/create-rallar-black-box-test-runtime.ts`: options gain `readonly readCongestionCounters?: () =>
  Promise<ALCongestionCounters | undefined>;` (doc as `readAlmUsage`), `Dependencies` the required `| undefined` member,
  `toRuntimeDependencies` passes it; `updateStats` (`:544`) reads `alm` then `congestion`, then `toStatsWithPageReadings(
  toRuntimeStats(...), alm, congestion)` — a private function that returns `stats` when both are `undefined`, else spreads
  `rallar: { ...stats.rallar, ...(alm === undefined ? {} : { alm }), ...(congestion === undefined ? {} : { congestion }) }`.
- `create-rallar-black-box-browser-test-runtime.ts:234`: `readCongestionCounters` decoded by private
  `decodeCongestionCountersResultValue(value: unknown)`: `undefined` passes; a left throws `TypeError("The page's congestion
  counters are not valid: " + issues.join('; '))`. Create `rallar-bb-test/alm/decode-al-congestion-counters.ts` exporting
  `decodeALCongestionCounters(value: unknown): Either<readonly string[], ALCongestionCounters>` over `decodeRecord` +
  `decodeNonNegativeInteger`; issues `dropped is not a count`, `deferred is not a count`, `handedOver is not a count`.
- `conformance/alm/alm-observation-snapshot.ts`: export `ALMObservationCongestionReading { atEpochMs; agentId; counters:
  ALCongestionCounters }`; `ALMObservationSnapshot.congestionReadings`; a private `ALMObservationStatsEvent { atEpochMs;
  agentId; rallar }` and `toStatsEvent(event)` (the `STATS_TOPIC` envelope decoding moved out of `toLedgerReading`, `:375`);
  `toLedgerReading(stats)` and `toCongestionReading(stats)` decode `stats.rallar.alm` / `.congestion` and skip a left (no
  `=== undefined` pre-check: it would push the file's cognitive load to 51, over the warn tier).
- `conformance/alm/compute-alm-observation-regime.ts`: type `ALMObservationCongestion = Readonly<{ outcome: 'measured';
  readingCount; dropped; deferred; handedOver }> | Readonly<{ outcome: 'no-readings' }>` after `ALMObservationLedger`; regime
  `congestion` after `ledger`; unreadable regime `{ outcome: 'no-readings' }`; private `computeCongestion` (per agent the largest
  of each count via `reduce` into a `Record<string, ALCongestionCounters>`, `computeLargestCounters`, then summed over pages).
- Budgets: `packages/shared-web/bundle-budgets.json` `browser/rallar.ts` 243 → 244;
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` 309 → 310.
- Test doubles: `api-middleware-test-double.ts` (`outboundDiagnostics` replaced whole like `volatileBudget`, default
  `createPassThroughALOutboundRuntimeDiagnosticsSink()`); `browser-rallar-required-methods-test-double.ts` and the
  `rallar-bb-test-alm-commands.test.ts` fake (`readCongestionCounters: async () => undefined`);
  `rallar-browser-runtime/browser-runtime-facade-test-double.ts` (a `congestion` getter, renewed on reset);
  `alm-cross-carrier-duplicate-outcome.test.ts` (`congestion: createBlackBoxRallarCongestionCounters()`);
  `shared/multicast/rtc-origin-overlay-fixture.ts:72` gains `readonly onSettlement?: (settlement: ALDeliverySettlement) =>
  void;` called after each recorded settlement.

**Interfaces.** Consumes Task 1: `ALOutboundCongestionDiagnostic`, `ALCongestionCounters`,
`writeALOutboundCongestionDiagnostic` (all in `al-outbound-message-runtime.ts`), refusal reason `congested` and its fallback
trigger. Consumes Task 2: `decideBackpressure(carrier, message)` on the fault port, the overlay's required `faultPort`,
`AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES`, the RTC/WS `defer` diagnostics, `TestWebSocket.bufferedAmount` writable. Produces
`RallarBrowserMiddleware.outboundDiagnostics`, the `hand-over` diagnostic, `readCongestionCounters`, `stats.rallar.congestion`,
`ALMObservationRegime.congestion`, the `backpressure` action on the `fault.inject` wire.

**D8 reuse inspection.** Reused Task 1's writer and counters, the existing outbound diagnostics relay, the counting-observer
shape, V1a's `readAlmUsage` page read and stats path, `decodeNonNegativeInteger`, the observation's stats decoding (now shared
by both readings), `normalizeALQosPolicy`. Inspected, not reused: V1a's private `isCount` (counts here are integers).

- [ ] **Step 1: Write the tests** (copy from `final-patch-task-3.patch`).
  - `shared-test/alm-backpressure-fault-contract.test.ts`, `describe('the fault.inject backpressure action')`: "admits a %s
    backpressure hold through schema, command validation and browser decoding" (ws, rtc); "keeps a finite backpressure count as
    the number of originations it holds"; "names backpressure among the rtc carrier's actions when it refuses a readiness fault
    there"; "names backpressure among the transport actions when an action is none of them".
  - `shared-test/rallar-browser-runtime/read-congestion-counters.test.ts`: "counts each congestion decision the page relays, by
    action, across both carriers" (`{ dropped: 1, deferred: 2, handedOver: 1 }`); "answers zero counts for a connected page that
    has decided nothing"; "answers undefined before the facade is connected"; "counts from zero again after the page closes and
    reconnects".
  - `rallar-bb-runtime/stats.test.ts`, `describe('the stats result rallar.congestion block')`: three titles in the patch
    (message `"The page's congestion counters are not valid: dropped is not a count; deferred is not a count"`);
    `rallar-bb-test-browser-rallar-runtime-bridge.test.ts`: two bridge titles.
  - `shared-test/alm-observation-congestion.test.ts`: decode; "sums each page's largest count across the cell's pages"
    (`{ outcome: 'measured', readingCount: 4, dropped: 1, deferred: 8, handedOver: 1 }`); no-readings.
  - `shared-web/messages/browser-message-handle-admission.test.ts`, `describe('a send its carrier refuses congested')`: four
    titles (priority 0 best-effort, 5 at-least-once; no hand-over on `rtc`; a throwing sink still hands over and logs
    `'AL outbound runtime diagnostics sink failed'`). No mock call-count pins (the coupling gate flags them).
  - `shared-web/messages/browser-message-congestion.test.ts` (facade proofs, room sends only): dispatch + registry + session
    deliveries over the real overlay (`createRtcOriginOverlayFixture`, next hops `b`, `c`) and `createDefaultWsQueueBoxClientService`
    on a `TestWebSocket`, one scripted port. Hand-over ends `acknowledged` (ACK admitted via `ws.acceptIncomingMessage`) with rows
    `[{rtc, refused, 'congested', false}, {ws, sent, undefined, true}]`, `carrierFallback` undefined, diagnostics `[drop,
    hand-over]`; `rtc` alone `rejected`/`congested`, attempts `[]`; WS above the watermark `rejected`/`congested`; at-least-once
    reads `not-ready` rows WHILE held (a retried attempt overwrites its row, so the final evidence shows only `sent`), then `sent`
    after `inject({...,remaining: 0})` / `bufferedAmount = 0`.
  - `connection/initialise-browser-middleware.test.ts`: "gives the middleware the connect's own sink, which its carriers report to".
- [ ] **Step 2: Run red.** `cat focused | xargs npx vitest run` over the nine files above plus
      `shared-web-public-api-snapshots.test.ts` → 21 failed, 53 passed (the four facade-only proofs already pass on Tasks 1+2).
      **Step 3: Implement**; green → 74 passed.
- [ ] **Step 4: Verify.** `npx tsc --noEmit` on shared, shared-web, shared-server, shared-test (clean);
      `node scripts/check-tests-typecheck.mjs` (PASS); `cd apps/rallar-black-box-control-server && deno task check` (no error), then
      `rm -rf apps/rallar-black-box-control-server/node_modules/.deno`; `npx dprint check` on the 37 files via `xargs`. Bundles
      (private `TMPDIR`): `check:browser-bundles` → `browser/rallar.ts` 243.092 KiB (242.952 on Tasks 1+2) → budget 244;
      `headless-bundle-boundary.test.ts` → 309.544 KiB (308.999 before) → 310; public API snapshot unchanged (no new export).
      `npx vitest run packages/tests/shared-web packages/tests/shared-test packages/tests/shared/alm packages/tests/shared/multicast
  packages/tests/shared/services packages/tests/shared/transport-faults` → `Test Files  3 failed | 538 passed (541)`, `Tests  10
  failed | 5875 passed (5885)`, the three reds sandbox loopback only (`api-v1-rtc-rtt-recipe-semantics` 5,
      `api-v1-state-write-convergence-recipe` 4, `local-websocket-session` 1). `packages/tests/rallar-black-box{,-headless} packages/tests/repo`
      → 3045 passed, 15 failed (`live-rtc-control-client` 13, `headless-worker-script` 2).
- [ ] **Step 5: Commit** (message below), then `npm run check:repo-style:changed -- 0d8e3f9ab HEAD` (PASS),
      `node scripts/check-test-structure-coupling.mjs --changed 0d8e3f9ab HEAD` (PASS), `npm run check:test-reachability`
      (1791 files, 1785 reached, 6 manual).

**True of the code after this task.** A congested RTC leg handed to WS is counted `handedOver`; every browser agent's `stats`
carries `rallar.congestion` once connected; the scripted port can hold either carrier at its watermark from a recipe; the lane
observation reports `congestion` totals unasserted. Docs for the action, the block and the fold are Task 5's.

```text
Count the congestion decisions: the browser hand-over, the fault.inject backpressure action, stats.rallar.congestion and the lane observation

A send whose RTC leg the carrier refuses congested under
rtc-with-ws-fallback is handed to WS at admission by the dispatch, as
rate-limited and unsupported are, and the dispatch now reports that
hand-over as a congestion diagnostic (action hand-over, cause
backpressured, the message's own effective priority) to the connect's
outbound diagnostics sink, which RallarBrowserMiddleware now carries
as outboundDiagnostics. A throwing sink changes nothing. The
admission hand-over writes no carrierFallback: its evidence is the
refused RTC row with refusalReason congested before the WS attempt.

Facade proofs run the dispatch, registry and session deliveries over
the real RTC overlay and WS client with one scripted fault port: a
best-effort room send held backpressured on RTC hands over and is
acknowledged on WS; on rtc alone it ends rejected congested with no
attempt; a WS send above the socket watermark is refused congested;
an at-least-once send settles not-ready while held and is sent once
the hold releases or the socket drains.

The harness fault.inject action gains backpressure on both transport
carriers through the contract, the schema, the control validator, the
page decoder and the capability text. The page counts every congestion
diagnostic it relays (dropped, deferred, handedOver), resets the count
at close, and answers it through readCongestionCounters(), undefined
before the facade connects. A stats result's rallar block gains
congestion beside alm, decoded at the page boundary; the ALM
observation folds the readings into the regime's congestion totals,
each page's largest count summed over the cell's pages.

Bundles: browser/rallar.ts measures 243.092 KiB (242.952 before
this change) and crossed 243, raised to 244; the headless agent measures
309.544 KiB (308.999 before) and crossed 309, raised to 310.

D8 reuse: writeALOutboundCongestionDiagnostic and
ALCongestionCounters, the existing outbound diagnostics relay, the
counting-observer shape of the IndexedDB counters, the readAlmUsage
page-read and stats path, decodeNonNegativeInteger and the
observation's stats-event decoding; normalizeALQosPolicy names the
hand-over's priority, since the dispatch holds no QoS provider.
```

### Task 4: The `congestion` cells of the two-agent family and `attemptRefusalReasons` (D187)

The composed commit is `.superpowers/sdd/v1b-plan/final-patch-task-4.patch` (`a059bf7c2` on Task 3's `78fedc1bd`, this
task's parent; 25 files, +626/−14). It is the exact text: apply with `git am -3` after Tasks 1–3; if a hunk no longer
applies, replay it by its text anchor (line numbers below are at `78fedc1bd`).
Rulings R-V1b-1 (an admission hand-over writes no `carrierFallback`; assert the refused row and its reason),
R-V1b-15 (room sends only), R-V1b-28 (every hold `until-cleared`, released by its `faultId` with `remaining: 0`;
the deferred cell on `rtc` and `ws` only, R-V1b-16), R-V1b-20/21 (`stats.rallar.congestion`, per
connection) bind this text.

**Files**

- Create `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/congestion/` (`scenarios/` holds 19 direct files,
  threshold 20, so the cells go in a subfolder): `congestion-commands.ts`, `backpressure-hands-over.ts`,
  `backpressure-refused.ts`, `backpressure-deferred.ts`.
- Modify `conformance/alm/alm-conformance-fault-commands.ts:24` (the private input's `action` gains `'backpressure'`)
  and add `toBackpressureFaultCommand` before the storage-quota doc comment (`:95`);
  `alm-conformance-message-commands.ts:32` (`reliability?: RallarBlackBoxTestMessagesSendCommand['reliability']`, doc
  "Absent, the channel's purpose decides: at-least-once for both.");
  `alm-conformance-scenario-definition.ts:26` (three ids first in the union: `'backpressure-deferred'`,
  `'backpressure-hands-over'`, `'backpressure-refused'`); `create-alm-conformance-recipes.ts:39` (three imports after
  `claim-refused-on-rtc`) and `:134` (`backpressureHandsOver, backpressureRefused, backpressureDeferred` right after
  `capacityTracks`, so they run last in the two-agent family).
- Modify `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:18` (three imports) and `:90` (after the
  `capacity-tracks` row: `// The congestion cells' lane evidence is local and the hosted full read's; manifest 18 stays
  as recorded.` and one `{ scenarioKey, carriers: <cell>.carriers }` row per cell).
- The refused row's reason in the harness observation (R-V1b-1 asks the cell to read it; the observation did not
  project it): `black-box-rallar-operation-contracts.ts:393` and `rallar-black-box-alm-result-values.ts:51` add
  `readonly attemptRefusalReasons: readonly ALDeliveryRefusalReason[]` after `attemptCarriers` (doc "The reason of every
  refused admission row, in attempt order: a leg the fallback carrier took over."); `black-box-rallar-delivery-ledger.ts:69`
  `attemptRefusalReasons: attempts.flatMap((attempt) => attempt.refusalReason ?? [])`, and `:75` `backpressured:
  attempts.some((attempt) => BACKPRESSURE_ADMISSION_REASONS.some((reason) => reason === attempt.unroutableReason))`
  (drops one `&&`: without it the file's cognitive load reaches the warn tier, 50); `decode-alm-delivery-failure.ts:33`
  exports `isAlmRefusalReason(value: string): value is ALDeliveryRefusalReason` over `ALM_REFUSAL_REASONS`;
  `decode-alm-runtime-result.ts:183` decodes it with a new `requireAlmAttemptRefusalReasonsField` before
  `requireAlmNumberField` (`:375`; error `${path}.attemptRefusalReasons`); `rallar-black-box-alm-command-capabilities.ts:53,107`
  name `attemptRefusalReasons` beside `attemptOutcomes`/`attemptCarriers`.
- Tests: new `packages/tests/shared-test/alm-conformance-congestion.test.ts`; `alm-conformance-recipes.test.ts:165,185,210,510,543`;
  `alm-conformance-recipe-validation.test.ts:50,84,120`; `packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts:150-160`;
  fixtures gain `attemptRefusalReasons` in `rallar-bb-test-alm-commands.test.ts:98,645,1129`,
  `rallar-browser-runtime/delivery.test.ts:88,155,282` (plus a new test), `alm-delivery-failure-decoding.test.ts:18`,
  `alm-lifecycle-recipes.test.ts:115`, `packages/tests/rallar-black-box/live-rtc-control-client.test.ts:211,326,440,510,709,777`,
  `apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts:407`.

**Interfaces consumed.** Task 1: `ALCongestionCounters` (`@shared/alm/outbound/al-outbound-message-runtime.ts`), the
refusal reason `congested` in `ALDeliveryRefusalReason` and `ALM_REFUSAL_REASONS`. Task 2: the fault port's
`backpressure` decision (`decideBackpressure(carrier, message)`, one count per `true`). Task 3: `fault.inject` `action:
'backpressure'` on both transport carriers through schema and control validator; `stats.rallar.congestion`.

**Interfaces produced**

- `toBackpressureFaultCommand(step, name, remaining: 'until-cleared' | 0)`: carrier `ws` for a `ws` cell, else `rtc` (the
  RTC leg under `rtc-with-ws-fallback`), `faultId` `backpressure-<carrier>-<typeId>`, `match: { typeId }`.
- `congestion-commands.ts`: `toBackpressuredSendCommands(sender, reliability: 'best-effort' | 'at-least-once')` = hold
  `hold-backpressure` (`until-cleared`) + `send-1` (payload `{ marker, carrier }`, `ack: 'receiver'`, the reliability,
  `ttlMs: NON_EXPIRING_TTL_MS`, `commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS`; a room send, R-V1b-15);
  `toBackpressureHoldWait(sender)` (`backpressure-held`, an absent `wait` on topic `rallar.black-box.alm.backpressure-held`,
  `timeoutMs` 2 000); `toBackpressureReleaseCommand(sender)` (`release-backpressure`, `remaining: 0`);
  `toCongestionCounterCommands(sender, counter: keyof ALCongestionCounters)` = `stats-congestion` + `assert-congestion-<dropped
  | deferred | handed-over>` on `rallar.congestion.<counter>` `gt` 0.
- `backpressureHandsOver` (`rtc-with-ws-fallback`): best-effort send; `toVerdictCommands(sender, 'acknowledged', …)` with
  `state` acknowledged, `attemptOutcomes.0` refused, `.1` sent, `attemptCarriers.0` rtc, `.1` ws, `attemptRefusalReasons.0`
  congested; counter `handedOver`; release. Receiver `toSingleArrivalReceiverCommands` + `ws-arrival` admission-outcome wait.
- `backpressureRefused` (`['rtc']`): best-effort send; `rejected` with `failure.kind` refused, `failure.reason` congested,
  `attempts` 0; counter `dropped`; release. Receiver `received-1` absent.
- `backpressureDeferred` (`ALM_CONFORMANCE_SINGLE_HOP_CARRIERS`): at-least-once send, `backpressure-held`, release, then
  `acknowledged`; counter `deferred`. Receiver `received-1`. All: `FULL_TAGS`, roles `['sender','receiver']`, `two-agent`.

**D8 reuse inspection.** `toFaultCommand`, `toSendCommand`, `toVerdictCommands`/`AlmConformanceVerdictFact`,
`toSingleArrivalReceiverCommands`, `toAdmissionOutcomeWait`, `toReceivedCommand`, `toStatsCommand` +
`toResultAssertion` (as `capacity-tracks`), the absent diagnostic wait as a timed hold (`capacity`'s rejoin wait), the
withheld rows; `ALM_REFUSAL_REASONS` for the new decoder guard. A counted fault (`remaining: 40`) was refused:
`alm-conformance-recipe-validation.test.ts` requires every hold to be released by its own recipe (R-V1b-28).

- [ ] **Step 1: Tests (red).** Copy the test edits. `npx vitest run packages/tests/shared-test/alm-conformance-congestion.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/shared-test/alm-delivery-failure-decoding.test.ts packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts packages/tests/shared-test/alm-lifecycle-recipes.test.ts`
      → `Test Files  6 failed | 3 passed (9)`, `Tests  20 failed | 239 passed (259)`.
- [ ] **Step 2: Implement.** Same command → `Test Files  9 passed (9)`, `Tests  259 passed (259)`. Wider:
      `ls packages/tests/shared-test/alm-*.test.ts packages/tests/shared-test/rallar-bb-test-*.test.ts packages/tests/rallar-black-box/hetzner-*.test.ts packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts | xargs npx vitest run`
      → `Test Files  72 passed (72)`, `Tests  1084 passed (1084)`; `node --import tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`
      → `checked 67 Hetzner distributed manifest(s)` and `git diff --stat 0d8e3f9ab HEAD -- apps/rallar-black-box/manifests` empty.
      `live-rtc-control-client.test.ts` binds loopback (sandbox `listen EPERM`); unsandboxed → `13 passed (13)`.
- [ ] **Step 3: Checks.** `printf '%s\n' <the 25 files> | xargs npx dprint fmt`; `npx tsc -p packages/shared-test/tsconfig.json --noEmit`
      and `cd apps/rallar-black-box && npx tsc --noEmit` → clean; `node scripts/check-tests-typecheck.mjs` → `PASS`;
      `cd apps/rallar-black-box-control-server && deno task check` → clean and `deno test --allow-run --allow-net --allow-env --allow-read --allow-write test/control-alm-evidence.test.ts test/control-generated-alm-reload.test.ts`
      → `41 passed | 0 failed`, then `rm -rf node_modules/.deno`. After the commit: `npm run check:repo-style:changed -- 0d8e3f9ab HEAD`
      → `PASS: no new repository style findings`; `node scripts/check-test-structure-coupling.mjs --changed 0d8e3f9ab HEAD`
      → three PASS lines; `npm run check:test-reachability` → `1792 test files, 1786 reached by CI, 6 manual`.
- [ ] **Step 4: Commit** with the message below.

```text
Prove channel backpressure in the ALM lane: the congestion cells

Three two-agent cells hold the sender's carrier at its high watermark
through the scripted transport fault port's backpressure action and
read what the congestion policy made of one room send (D185), then the
page's own congestion counter through stats (D186).

backpressure-hands-over (rtc-with-ws-fallback) holds the RTC leg: a
send that states best-effort (the harness's channel purposes default
to at-least-once, priority 5, which drop-low keeps) is refused
congested there and handed to WS at admission, so it is acknowledged
with the refused RTC row, its reason congested, before the sent WS row
and no carrierFallback; the handed-over counter is above zero, and the
receiver delivers the one copy WS carries. backpressure-refused (rtc)
ends the same send rejected, refused congested, no attempt, the dropped
counter above zero, and the receiver receives nothing.
backpressure-deferred (ws, rtc) holds the carrier for 2 s around an
at-least-once send, which waits through not-ready submissions, is
acknowledged after the release, and leaves the deferred counter above
zero. The cells live in conformance/alm/scenarios/congestion/, run
last in the two-agent family, full tag only, and are withheld from
hosted manifest 18, which stays byte-identical.

The harness's delivery observation gains attemptRefusalReasons, the
reason of every refused admission row in attempt order, decoded against
the refusal reasons, so a hand-over at admission names its cause.

D8 reuse: the fault command builder, toSendCommand, toVerdictCommands and the verdict-fact shape, toSingleArrivalReceiverCommands and toAdmissionOutcomeWait, toStatsCommand with toResultAssertion as capacity-tracks reads its ledger, the absent diagnostic wait as a timed hold, the withheld-manifest rows; the refused row's existing refusalReason projected beside attemptOutcomes and attemptCarriers, decoded with the failure decoder's refusal-reason table.
```

Lane (Task 6, unsandboxed, `RALLAR_BLACK_BOX_ALM_SCOPE=full`): the cells run in the two-agent family, whose Playwright
title is `baseline family over <carrier> (<scope>)` (`tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts:131`),
so the filter is `-g "baseline family"` (R-V1b-39). If `backpressure-hands-over` reads `attemptRefusalReasons` empty, the
RTC leg was not refused at admission: read the sender's `rallar.browser.alm.outbound_diagnostics` for the `congestion`
`drop` before changing the cell. If `backpressure-deferred` reads `deferred` 0 on `rtc`, the fault reached planning but no
submission: each submission read consumes a count (R-V1b-16), so check the hold was `until-cleared`.

### Task 5: Docs — backpressure as a congestion input, the `congested` refusal and the counters (D188)

The composed commit is `.superpowers/sdd/v1b-plan/final-patch-task-5.patch` (`78830f699` on Task 4's `a059bf7c2`, this
task's parent; 8 files, +203/−22, docs only; the writer's prototype plus R-V1b-36..38). It is the exact text: apply
with `git am -3` after Task 4. No earlier task touches a Markdown
file (checked: `git diff --stat 0d8e3f9ab a059bf7c2 -- '*.md'` is empty), so Task 5 owns every doc wording, including
the `stats.rallar.congestion` paragraph and the observation's `congestion` bullet (R-V1b-23). If a hunk no longer
applies, replay it by its text anchor (line numbers at `a059bf7c2`). Then run the "True of the code" checks, the only
part that can fail; a mismatch is fixed in the doc, never in the code. Decision ids only; the roadmap row, the audit's
F5 row and the requirement matrix are the close's.

**Files (text anchors)**

- `docs/rallar-api-reference.md`: `:690` the RTC congestion drop gains "(see Congestion below)"; after "returning to
  empty within the age limit." (`:733`) four paragraphs and a **Limit:**: **Congestion.** the `qos.congestion`
  request (`algo` `drop-low` default, `reject`, `defer`; priority 5 at-least-once, else 0; lane sends and both channel
  purposes are at-least-once unless `reliability: 'best-effort'`); the two inputs (`overloaded`; `backpressured`, D184:
  every ready RTC next hop's reliable channel at its high watermark, 64 KiB default; the WS socket at
  `AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES`, 256 KiB; WS reads `backpressured` alone, a WS send at the bound refused
  `capacity` first); what reads neither (controls, receipts, forwards, retransmissions, inbound plans; an RTC unicast);
  only a first admission plan reads backpressure (an RTC unicast is "a send naming `peerId`", R-V1b-38). The outcomes (D185): `drop-low`/`reject`/`defer`; `overloaded` →
  `capacity`; backpressure → `congested`, `overloaded` naming the cause when both hold; the fallback rule (a `refused`
  row with `refusalReason: 'congested'` before the WS attempt, no `carrierFallback`; alone → `rejected`,
  `{ kind: 'refused', reason: 'congested' }`, no attempt); kept sends `not-ready` every 50 ms
  (`AL_SUBMISSION_NOT_READY_RETRY_MS`) on both carriers, three RTC ones hand a fallback send to WS; a backpressured WS
  socket holds every message, controls included. The `congestion` diagnostic (D186), counted by the harness, no facade
  method; channel health on `rallar.rtc.status()` (`bufferedAmount`, `flowControl`, `queuedItemCount`, `counters`).
  **Limit:** no per-peer routing, fanout reduction, `replace-latest` or bounded queue; RTC unicasts read no congestion;
  no server-side WS backpressure.
- `packages/shared/alm/outbound/README.md`: `:185` "fairness is V1b-ii's"; `:810-813` the WS client runs the congestion
  planning on `backpressured` alone, plus a new paragraph on the backpressure input (D184), the per-cause outcomes
  (D185), `AL_DELIVERY_FALLBACK_REFUSAL_REASONS`, and the `congestion` diagnostic's three emitters (D186: the outbound admission,
  the submission, and the browser's message dispatch for `hand-over`, R-V1b-36); `:933`
  "backpressure rejection" → "backpressure", and after the paragraph a new one: every `not-ready` names
  `retryAfterMs` 50 ms; RTC's synchronous `dropped` at the watermark and the WS socket at its watermark are the
  backpressure deferrals, each a `defer` diagnostic.
- `packages/shared/alm/inbound/README.md:140`: "never reads `overloaded` (R-S3c-ii-8), nor `backpressured` (D184)".
- `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`: after the fallback family (`:497`) the
  congestion-cells paragraph; `:558-563` the `attemptRefusalReasons` observation field; `:585` `congested` among the
  refusal reasons; `:595` a `congested` hand-over leaves `carrierFallback` absent; `:599` `backpressured` counts
  admission refusals (`rate-limited`, `circuit-open`), not channel backpressure; `:628` the `not-ready` and
  `backpressure` actions (the carrier reads the fault when it plans a matching origination and when it submits a
  matching frame; each such read consumes one of `remaining`, R-V1b-37); after `:1079` the `stats.rallar.congestion` paragraph (per connection,
  reset at `close`, absent where `rallar.alm` is); `:1092` the stream's backpressure count is admission refusals.
- `packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md`: one note appended (Owner `ALM V1b-i`).
- `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md`: after the `ledger` bullet (`:185`) the
  `congestion` bullet.
- `docs/rallar-hetzner-distributed-recipes.md:385,396`: the stream backpressure count named as admission refusals.
- `playground/alm/alm-complete-product-description.md`: `:415` "channel backpressure joined in V1b-i (D184, below);
  fairness is V1b-ii's"; after `:669` **CURRENT — V1b-i, channel backpressure as a policy input** and **PLANNED:**
  (`replace-latest`, bounded queue, fanout reduction and alternate routes, per-peer routing, RTC unicast congestion,
  server-side WS backpressure, fairness under many tracks and churn, V1b-ii).

**True of the code (verify each against the landed code; fix the doc on a mismatch)**

- Task 1: `planCongestion` applies to `overloaded || backpressured`, `overloaded` names the cause when both hold;
  `drop-low` drops `priority <= 0`; defaults `drop-low`, priority 5 at-least-once else 0 (`normalize-al-qos-policy.ts`);
  drop code and refusal reason `congested`; `AL_DELIVERY_FALLBACK_REFUSAL_REASONS` = `['unsupported', 'congested']`; an
  admission hand-over writes a `refused` row with `refusalReason` and no `carrierFallback` (R-V1b-1);
  `AL_SUBMISSION_NOT_READY_RETRY_MS` 50; the `congestion` diagnostic `{ carrier, cause, action, priority, msgId }`.
- Task 2: `AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES` 256 KiB; WS plans read `backpressured` only, at `stage ===
  'admission'`, never for a control (R-V1b-4, R-V1b-7); every WS `not-ready` names `retryAfterMs`; a backpressured socket
  defers every message incl. controls (R-V1b-11); RTC reads it only in `planOverlayDispatch` (room sends; unicasts read
  neither, R-V1b-15) at admission, when every ready hop's channel is at `highWatermarkBytes` (`computeRtcBackpressure`);
  the RTC deferral keys on the synchronous `dropped` result (R-V1b-9); the reliable lane's default high watermark 64 KiB
  (`qrtc-data-channel.ts`); three consecutive RTC `not-ready` hand a fallback send over (D56, unchanged).
- Task 3: the browser message dispatch emits `hand-over` (R-V1b-17); the harness counts `drop`/`defer`/`hand-over` per
  connection, reset at `close`; `stats.rallar.congestion` beside `rallar.alm`, absent while disconnected (R-V1b-20/21);
  the fold sums each page's largest reading per count (R-V1b-22); a handed-over send counts in `dropped` and
  `handedOver` (W-C S2); the `fault.inject` `backpressure` action on both carriers.
- Task 4: the three cells, their carriers, best-effort/at-least-once, `until-cleared` holds with release, the 2 s hold,
  the counters read `gt` 0, `attemptRefusalReasons`, `conformance/alm/scenarios/congestion/`, withheld from manifest 18.

- [ ] **Step 1: Apply** the patch (or replay the hunks above). **Step 2: True-of-code checks** above.
- [ ] **Step 3: Format** `printf '%s\n' docs/rallar-api-reference.md docs/rallar-hetzner-distributed-recipes.md packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md packages/shared/alm/outbound/README.md packages/shared/alm/inbound/README.md playground/alm/alm-complete-product-description.md | xargs npx dprint fmt`,
      then the same list through `xargs npx dprint check` → exit 0.
- [ ] **Step 4: Checks.** `npx vitest run packages/tests/repo packages/tests/shared-web/rallar-group-public-contracts.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts`
      → `Test Files  93 passed (93)`, `Tests  1244 passed (1244)`; `cd apps/api-v1 && deno test --allow-all test/swagger-routes.test.ts`
      → `14 passed | 0 failed`, then `rm -rf apps/api-v1/node_modules/.deno`; after the commit
      `npm run check:repo-style:changed -- 0d8e3f9ab HEAD` → `PASS: no new repository style findings`.
- [ ] **Step 5: Commit** with the message below.

```text
Document channel backpressure as a congestion input, the congested refusal and the congestion counters

The API reference gains a congestion section beside the volatile bound:
the policy and its priority defaults, the two live inputs (overloaded,
and backpressured: every ready RTC next hop at its high watermark for a
room send, or the WS socket at 256 KiB, which the WS client reads
alone), what never reads them, the outcomes per carrier and strategy
(drop-low, reject, defer; the congested refusal, its hand-over at
admission under rtc-with-ws-fallback with a refused row and no
carrierFallback, its rejection otherwise; the 50 ms not-ready at
submission on both carriers), the congestion diagnostic, channel health
on rallar.rtc.status() and the limits. The outbound README states that
the WS client runs congestion planning on backpressured alone, the
backpressure input and the per-cause outcomes, and that every not-ready
names the 50 ms retry; the inbound README that an inbound plan reads no
backpressure; fairness comes in a later slice. The black-box docs state the
backpressure fault action, stats.rallar.congestion, the
attemptRefusalReasons observation, the congested failure, the congestion
cells and the observation's congestion fold, with a compatibility note,
and name the stream and observation "backpressure" counts as admission
refusals (rate-limited, circuit-open). The product description's
congestion section becomes current for the live input, the per-cause
outcomes and the counters; replace-latest, a bounded queue, relay
fanout reduction and the rest stay planned.

D8 reuse: the volatile bound, settlement, fault, stats, observation and congestion prose of each document, extended in place; one compatibility note in the existing template.
```

### Task 6: Close

Pins unchanged and bundles measured; the static merge bar; `npm run test:postgres:integration` (a regression read: no
V1b-i path touches the server); the conformance lane's two-agent family with the three `congestion` cells over `ws`,
`rtc` and `rtc-with-ws-fallback`; the three-seat final review BEFORE one fix wave; push; the Branch Release Gate green
on the code head; hosted manifests 18 and 22 dispatched from the branch; the PR body; the close commit with the
delivered lines; this plan file deleted.

- [ ] **Step 1: Pins and bundles.** `npx vitest run` the four pins (`al-indexeddb-transaction-ledger`,
      `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts` under
      `packages/tests/shared/alm/`) → all pass; `git diff --stat origin/main HEAD` lists none of them. Bundles with a
      private `TMPDIR`: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` (`browser/rallar.ts`
      243.092 KiB of 244 at composition) and `headless-bundle-boundary.test.ts` (309.538 KiB of 310 at composition); the
      public API snapshot and bundle-boundary tests pass unchanged; a crossed budget rises to the next whole KiB, named
      in the PR body.
- [ ] **Step 2: Static merge bar.** `npm run typecheck`; `npm run build`; `npm run check:repo-style:changed --
      origin/main HEAD` (read the verdict line) and `node scripts/check-test-structure-coupling.mjs --changed
      origin/main HEAD`; `npm run check:test-reachability` (`1792 test files, 1786 reached by CI, 6 manual` at
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
      RALLAR_BLACK_BOX_ALM_SCOPE=full npm run test:rallar:full-stack:memory:alm -- -g "baseline family"` (the two-agent
      family over all three carriers, R-V1b-39; `RALLAR_BLACK_BOX_ALM_CARRIERS=ws|rtc|rtc-with-ws-fallback` runs one).
      Expected: `baseline family over ws (full)`, `… over rtc (full)` and `… over rtc-with-ws-fallback (full)` pass, the
      congestion cells last: `backpressure-hands-over` on `rtc-with-ws-fallback` (`acknowledged`, `attemptOutcomes`
      `[refused, sent]`, `attemptCarriers` `[rtc, ws]`, `attemptRefusalReasons` `[congested]`,
      `rallar.congestion.handedOver` > 0, the receiver receives once); `backpressure-refused` on `rtc` (`rejected`,
      `failure.kind refused`, `failure.reason congested`, `attempts 0`, `dropped` > 0, the receiver receives nothing);
      `backpressure-deferred` on `ws` and `rtc` (held 2 s, released, `acknowledged`, `deferred` > 0). The lane's
      observation artifact carries `congestion: { outcome: 'measured', … }` per cell. Diagnose a red cell from its
      artifact (Task 4's lane note).
- [ ] **Step 5: Final review, then one fix wave.** Three seats (product: the live flag and its readers, the per-cause
      outcomes, the fallback rule and the hand-over evidence, the diagnostic and its three writers against D184–D187 and
      R-V1b-1, -4, -7, -15, -19; harness: the `fault.inject` action, `stats.rallar.congestion`, the page counters and
      their reset, the observation fold, `attemptRefusalReasons`, the three cells and the withheld manifests; code
      quality: the code standard, D3, D8, the density caps of R-V1b-3, the required `faultPort`, no ids) review the
      branch head before any fix; the controller rules on every finding and applies one fix wave; any fix reruns its
      task's checks and Steps 1–2.
- [ ] **Step 6: Push and gates.** Push the branch; the Branch Release Gate (`gh run list --branch
      claude/alm-v1b-fairness-backpressure`) green on the code head; rerun a known flake once with `--failed` before
      diagnosing it.
- [ ] **Step 7: Hosted manifests 18 and 22 from the branch.** `gh workflow run hetzner-distributed-recipe.yml --ref
      claude/alm-v1b-fairness-backpressure -f ref=claude/alm-v1b-fairness-backpressure -f rollout_before_run=true -f
      manifest_path=apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`, and the same with
      `22-alm-conformance-3-agent.json`; both are regression reads (the three cells are withheld) and now record
      `rallar.congestion` in every browser agent's `stats`; diagnose a red from its artifacts.
- [ ] **Step 8: PR body.** Goal; Changes per task; Public surface (`backpressured?` on the three QoS contexts,
      `ALCongestionCause`, `plan.congestion.cause`, the drop code / outbound drop code / refusal reason `congested`,
      `AL_DELIVERY_FALLBACK_REFUSAL_REASONS` `['unsupported', 'congested']`, `AL_SUBMISSION_NOT_READY_RETRY_MS`,
      `ALOutboundDispatchPlan.congestionDrop`, `ALOutboundCongestionDrop`, `toALOutboundCongestionDrop`,
      `ALOutboundCongestionDiagnostic`, `writeALOutboundCongestionDiagnostic`, `writeALOutboundCongestionDeferral`,
      `ALCongestionCounters`, `computeRtcBackpressure`, `AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES`,
      `TransportFaultPort.decideBackpressure` and the `backpressure` fault action, the overlay's required `faultPort`,
      `RtcOutboundSubmission.Dependencies`, `RallarBrowserMiddleware.outboundDiagnostics`, the `fault.inject`
      `backpressure` action, `stats.rallar.congestion`, the page method `readCongestionCounters()`, the observation's
      `congestionReadings` and `congestion` regime, `attemptRefusalReasons`, the budgets 243 → 244 and 309 → 310);
      Acceptance; Validation with every red named; Rulings R-V1b-1 to R-V1b-40 and any the review adds; Corrections
      (this plan's list); Limits (this plan's list); Risk and rollback; Follow-ups (V1b-ii fairness under many tracks and
      churn, and the RTC unicast congestion input, R-V1b-15; the RTC ledger-before-planner order, R-V1b-4; V1c, V1d). End
      the body with the Claude Code attribution line.
- [ ] **Step 9: The close commit.** In `playground/alm/alm-improvement-plan.md`: the D184, D185, D186 and D187 rows
      each gain an "**As applied (V1b-i):**" sentence: D184 "only a new admission's plan reads the flag (R-V1b-7); RTC
      unicasts and unaddressed sends read neither input (R-V1b-15); the scripted fault port's `backpressure` action is
      read at planning and at each submission."; D185 "backpressure applies on both carriers, `overloaded` as before on
      RTC only — the WS client reads `backpressured` alone and its ledger refuses at the bound with a `limit`
      (R-V1b-4); a congested RTC leg handed over at admission leaves a `refused` row with `refusalReason` and no
      `carrierFallback` (R-V1b-1)."; D186 "the block is `stats.rallar.congestion` beside `alm`, per connection (R-V1b-20,
      R-V1b-21); the `hand-over` diagnostic is the browser message dispatch's."; D187 "the three cells run last in the
      two-agent family (`scenarios/congestion/`), every hold `until-cleared` and released; the deferred cell's witness is
      `deferred > 0`; the observation gains `attemptRefusalReasons` (R-V1b-27..R-V1b-29, R-V1b-39)."; D188's carries
      gain "RTC unicast and unaddressed sends as congestion inputs (R-V1b-15)". The "Releases 4 to 8" map row `| 7 V1
      |` replaces "Delivered (V1a, `c37bda7`; #649); V1b, V1c, V1d open." with "Delivered (V1a, `c37bda7`; #649).
      Delivered (V1b-i, `<head>`; #<pr>); V1b-ii, V1c, V1d open."; the fresh-session paragraph replaces "V1b-i is the
      active slice, designed in [alm-v1b-i-design-proposal.md](alm-v1b-i-design-proposal.md) (D184–D188) with its plan
      under `plans/active/`: channel backpressure as a policy input; V1b-ii (fairness under many tracks and churn), V1c
      and V1d follow." with "Release 7 V1b-i is delivered (#<pr> as `<head>`, from
      [alm-v1b-i-design-proposal.md](alm-v1b-i-design-proposal.md), decisions D184–D188 with their "As applied" notes;
      its plan file is deleted with the close). V1b-ii (fairness under many tracks and churn) is the next slice; V1c and
      V1d follow."; the revision
      history gains "<merge date> (V1b-i delivered): #<pr> as `<head>`; the V1 map row, the F5/PC8 rows, the D184–D187
      "As applied" notes, D188's carries and the fresh-session paragraph record it; V1b-ii is next."; the requirement
      matrix's `| PC8 bounded protocol work |` row reads "Partial: the session ledger's four bounds and bounded
      retention (V1a, #649); channel backpressure as a congestion input with typed outcomes and counters (V1b-i,
      #<pr>); fairness and the scale runs open." with its owner column unchanged. In `playground/alm/alm-static-audit.md`
      the status table's `| F5 |` line reads "Partly closed: the volatile default and the per-session bound (S3), the
      age and track bounds and the usage metric (V1a), channel backpressure as a congestion input (V1b-i); fairness open
      (V1b-ii)." with owner `S3, V1`. In `playground/alm/alm-v1b-i-design-proposal.md` add "## 6. As applied (V1b-i
      delivered)" with the four as-applied sentences above. Delete this plan file in the same commit. Never a blank line
      inside a table; `npx dprint fmt` the three files.
