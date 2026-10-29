# ALM publication QoS Slice 1 design proposal: bounded publication pacing (S1-i, S1-ii)

Release 9, Slice 1 of the [publication QoS and pub/sub addendum](alm-publication-qos-addendum.md) §7, the
first slice after Release 8 closed the [roadmap](alm-improvement-plan.md)'s release map. Written from three
read-only surveys of `main` at `cfcc9a6c7` (the send path and QoS vocabulary; scheduling, timers and bounded
collections; typed channels, consumers, the conformance lane and the harness) and the maintainer's rulings
R1–R5 of 2026-10-29, each taken on its recommended option. Slice 1 lands as two pull requests (R4): **S1-i**,
the paced lane, and **S1-ii**, its bounds, fairness, consumer proof and hosted placement. R6 approved the
S1-i plan as written, and R7 gave retention and the cadence shared owners (D475). Decisions are D465–D475
in the roadmap's decision record; "As applied" notes are added at each close. This file is deleted
with S1-ii's close.

## 1. The problem

The addendum's Slice 1 asks for publication pacing as ALM QoS: a send cadence, newest-N retention per stream
key and a drain budget per opportunity, with immutable staging, expiry before dispatch, typed incompatible
policies and a browser consumer. Replaceable live state has two homes today, and neither paces:

- `rallar.realtime.room<T>` is a raw RTC data-channel lane, `overflow: 'replace-by-key'` with 64 queued
  items and a per-send `maxAgeMs` (`packages/shared-web/browser/rallar-realtime-facade.ts:18-33`,
  `packages/shared/webrtc/rtc-data-channel-send-queue.ts`). It has no ALM identity, no deadline on the
  handle, no WS route, no frozen audience. The games pace at the call site with
  `packages/shared/rallar-motion/send-gate.ts` (Relic 33 ms, AR Eye 50 ms) and keep doing so (R3).
- ALM's `supersedence: 'latest-wins'` conflates by `supersedenceKey`, but only after the replacement is
  admitted: the observation runs inside the admission commit
  (`packages/shared/alm/outbound/admission/al-outbound-admission-reads.ts`) and the predecessor is settled
  `superseded` by `toALOutboundCommitSettlements` (`compute-al-outbound-dispatch.ts:375`). Nothing holds a
  value back, so a 120 Hz host sends 120 envelopes a second whatever the receivers need.

The typed channel declares `purpose: 'command' | 'notification'`, both at-least-once, receipted, 30 s
(`packages/shared/al-contracts/resolve-al-channel-send-defaults.ts`); D52 refuses `realtime` there. No
channel field names a cadence, a retention depth or a drain budget. The harness `messages.send` opens the
channel as `notification` or `command` by `toPeer` and waits for `AL_DELIVERY_ADMITTED_STATES` before it
returns (`black-box-rallar-delivery-ledger.ts:105-144`), so a staged value that is displaced before any
admission would hang the command today.

## 2. What exists and is reused (facts, with the survey's locations)

- The engine schedules by task: `InboxOutboxEngine.wakeAt(taskId, readyAtMs)` reschedules its one timer to
  the earliest ready time (`packages/shared/services/inbox-outbox-engine.ts:136-152, 309-324`); a task is
  `includeTask(id, { maxConcurrency, isWork, runnable, ongoingTasks })` (:92-104); the browser's engine is
  `ApiMiddleware.middleware.qboxEngine`. `ALWorkHandler` runs on it the same way (`al-work-handler.ts:242-259`).
- Every ALM clock is an injected epoch `nowMs` (`ALOutboundMessageRuntime.Clock`, :459-461;
  `create-default-al-outbound-message-runtime.ts:101`); no monotonic clock exists (R5).
- The handle: `ALDeliveryState` and the settlement kinds in
  `packages/shared/alm/delivery/al-delivery-lifecycle.ts`; `superseded` carries `replacementMsgId`;
  `expired` and `cancelled` exist; `AL_DELIVERY_ADMITTED_STATES` is every state but `submitted`.
  The registry (`browser-rallar-delivery-registry.ts`) opens the handle before admission (:106) and the
  dispatch's `readAdmissionRefusal` (`browser-rallar-message-dispatch.ts:247-270`) is the one pre-ALM
  settlement site.
- Bytes: `computeALMessageEnvelopeBytes` (`al-contracts/al-message-resource-limits.ts:102`), the figure the
  volatile ledger charges. Payload limit 64 KiB (`api/rallar-validation.ts:5`).
- Bounded collections: `LatestRepository.maxEntries` keeps one value per key (no per-key history);
  the motion buffer keeps N samples per entity but is receive-side; no generic bounded FIFO exists (D118).
  The stage's per-stream array of at most `retainNewest` values is the third keyless candidate the backlog
  names; it stays a private array until a generic owner is selected (D8, no library for one user).
  **As applied (S1-i):** R7 selected the owner, `retainNewest` in `packages/shared/cache`, which the motion
  buffer shares (D475).
- Harness: `loop` {count, intervalMs, commands[]} with `{loop.index}` substitution
  (`rallar-black-box-test-contracts.ts:226-239`, `scenarios/fairness/to-send-loop-command.ts`);
  `messages.observe` decodes states from `AL_DELIVERY_STATES`; `messages.received` returns the arrivals in
  order; `stats` carries `rallar.alm` and `rallar.congestion`.

## 3. Decisions

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D465 | **R1, the home.** Pacing is a stage inside the ALM outbound lifecycle, before per-envelope admission: `ALOutboundPublicationStage` under `packages/shared/alm/outbound/publication/`. A staged value keeps the `msgId`, `traceId` and deadline minted at construction; at an opportunity the selected values enter today's carrier admission unchanged, so the frozen audience, fallback, supersedence and receipts apply as to any send. The raw RTC realtime lane and the games' motion gates are untouched (2026-10-29).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D466 | **R2, the channel.** `ALChannelPurpose` gains `'live'`. A live channel declares a required `publication: ALPublicationPolicy` = `{ cadenceMs, retainNewest, drain: { messages, bytes } }`, every field a positive safe integer within `AL_PUBLICATION_POLICY_LIMITS` (cadence ≤ 60 000 ms, retainNewest ≤ 64, drain.messages ≤ 64, drain.bytes ≤ 4 MiB); there is no product default for any of them, and tests declare every value. The purpose's send defaults are best-effort, `ack: 'none'`, `volatile`, `AL_LIVE_CHANNEL_TTL_MS` = 1 000 ms. `publication` on a `command` or `notification` channel, a missing `publication` on a live channel, or a live channel with a durability other than `volatile`, is a channel-definition validation issue (`$.publication` `missing-publication` / `unsupported`; `$.durability` `invalid-durability`). `command` and `notification` never pace. **As applied (S1-i):** `decodeALPublicationPolicy(value: unknown): Either<readonly RallarValidationIssue[], ALPublicationPolicy>` is the one unknown boundary, and `validateALPublicationPolicy(policy: ALPublicationPolicy)` checks the typed shape's ranges and integrality. The issue codes are `invalid-publication`, `invalid-cadence-ms`, `invalid-retain-newest`, `invalid-drain-messages` and `invalid-drain-bytes`.                                                                                                                          |
| D467 | **The live send.** A live send names `resourceId`: it is the application stream key, and a live send without one is refused `$.resourceId` `missing-resource-id` (the product would mint a fresh resource per send and nothing would conflate). A live send that asks `reliability: 'at-least-once'`, an `ack` other than `'none'`, `seq` or `orderingKey`, `ownership: 'exclusive'` or a non-volatile `qos.durability` is refused `unsupported` at input validation, before a handle opens, as a `toPeer: 'server'` RTC send is today. The sender stamps `qos.supersedence = { algo: 'latest-wins', opts: { supersedenceKey: streamKey } }` on the built envelope so a late copy is conflated at admission and on receipt as well. The stream key is `toALPublicationStreamKey(msg)`: `JSON.stringify` of `[senderId, targets.mode, applicationId, workspaceId, groupId, scope, principalRef, toPeerId, sorted recipientPeerIds, topicId, contextId, typeId, resourceId]` with absent fields as `null`, so absent values and delimiter look-alikes never collide. The lane key is `topicId/typeId` (the channel). **As applied (S1-i):** the key adds the sorted `exceptPeerIds`; the snapshot and roster versions stay out; a multicast's `recipientPeerIds` is fixed at staging. One stream's values share the key, so two admitted at one opportunity may conflate at admission under backpressure: the drain bounds work, not delivered history. |
| D468 | **The `staged` state.** `ALDeliveryState` gains `'staged'` between `submitted` and `rejected`, with the settlement `{ kind: 'staged', msgId, traceId, carrier, atMs }`; it is the first verdict of a live send, so a wait on `AL_DELIVERY_ADMITTED_STATES` resolves on it (the harness send returns once staged). A displaced value settles `superseded` with `replacementMsgId` the newest value's; a value whose deadline passes before selection settles `expired`; a value heavier than `drain.bytes` is refused `oversized` at staging; disposal settles `skipped`/`disposed`. The lifecycle moves `submitted → staged`, then `staged → accepted/queued …` through today's admission settlement, or to one of the terminals above; no other state reaches `staged`. **As applied (S1-i):** the `staged` settlement is inline in the settlement union, as its 17 siblings are, with `traceId` from the shared settlement intersection, so there is no `ALDeliveryStagedSettlement`. `isALDeliveryAdmitted` stays false for `staged`, and the AR Eye director attempt mapping reads `staged` as pending.                                                                                                                                                                                                                                                                                                                                           |
| D469 | **Opportunities, retention, selection.** One stage per connected session holds one lane per channel route (`laneKey`), each with its policy, its streams (`streamKey → oldest-first values`) and its next opportunity. Staging on an idle lane (no next opportunity) runs an opportunity at once; otherwise the value waits for the lane's next boundary. The next boundary after an opportunity at `t` is `t + cadenceMs`; when the engine runs late by more than a cadence the lane runs one bounded opportunity now and the next is `now + cadenceMs` (no catch-up burst, `computeNextCadenceAtMs`). Retention: staging the `retainNewest + 1`th value of a stream displaces its oldest staged value (`retainNewest`). Selection (`computeALPublicationSelection`): expired values settle first; then streams in their first-staged order, each oldest first, until the next value would pass `drain.messages` or `drain.bytes` (the first value of an opportunity always fits, by D468's refusal); the rest wait. Fairness across streams and groups, byte bounds per key and per session, cancellation and reconfiguration are S1-ii (D473). **As applied (S1-i):** both helpers are D475's shared owners. A selection leaves its streams before `submit` resolves. A later `stage()` with another policy keeps the lane's first (reconfiguration is S1-ii).                                                                                     |
| D470 | **R5, scheduling and clock.** The stage registers one engine task (`al-outbound-publication-stage`) on the session's `InboxOutboxEngine`: `isWork` is "a lane is due", the runnable runs every due lane's opportunity and then calls `wakeAt(taskId, earliest next opportunity)`; an idle stage calls `wakeAt(taskId, undefined)` and the engine does no pacing work. The stage reads the outbound runtime's injected `Clock { nowMs() }` for both the schedule and expiry; no monotonic clock is introduced. Each opportunity writes one payload-free `publication-opportunity` diagnostic `{ laneKey, atMs, selected, deferred, expired, bytes }` on the outbound diagnostics port. **As applied (S1-i):** a due lane with nothing staged is no opportunity: it goes idle and writes no diagnostic. A value without a deadline never expires on the stage; one already expired settles `expired` at the next opportunity. The first value on an idle lane is admitted at the engine's next pass, so under N=1 a value staged before that pass displaces it, and the cells send a lead value first. `stage()` after `dispose()` throws, a programmer invariant. The `publication-opportunity` diagnostic carries no `traceId`: it covers several messages, as `effect-drain` does.                                                                                                                                                                   |
| D471 | **The browser wiring.** `BrowserRallarMessageDispatch.Delivery` gains `publication: { policy, laneKey, streamKey } \| undefined`; `send()` keeps `readAdmissionRefusal` first (oversized, malformed, already expired), then stages a live delivery with its captured settlement epoch instead of writing a leg. `BrowserPublicationStages` owns one `ALOutboundPublicationStage` per `ApiMiddleware` (its `qboxEngine`), constructed on the first live send of that connect and disposed when the session ends; its `submit` port writes the selected deliveries through the dispatch's existing leg path. Until S1-ii adds `cancel` on the stage, a cancel of a staged value is recorded by the registry and the value is still admitted at its opportunity; the proposal names this limit and S1-ii removes it. **As applied (S1-i):** `validateBrowserLiveSend` in `messages/publication/` refuses in the typed channel before connect and before a handle opens, and refuses `$.qos.delivery`, `$.qos.ack` and `$.qos.supersedence` `unsupported` too. `BrowserPublicationStages` keeps one stage per connect, on its `qboxEngine` and outbound diagnostics, and stops it when that connect's settlement epoch closes (shutdown, a failed connect, the next connect), settling its values `skipped`/`disposed` under the epoch; it reads `readLane(context, laneKey)`. The `rallar.ts` budget is 276 KiB (275.45 measured).                       |
| D472 | **The harness.** `messages.send` gains `purpose` (`command`, `notification`, `live`; absent keeps the `toPeer` rule) and `publication` (required with `live`, refused otherwise), in the command contract, the field whitelist, the page decoder (`decodeALPublicationPolicy`) and the schema docs; the ledger opens the channel with them and keeps its admitted-states wait. `messages.observe` reads `staged` through `AL_DELIVERY_STATES`. The S1-i cells are `paced-latest`, `paced-newest-n` and `paced-expiry` (two-agent, smoke, three carriers), driven by a `loop` at 10 ms against cadences of 500 ms or more, and are withheld from the hosted manifests until S1-ii places them. **As applied (S1-i):** each cell sends a lead value, waits for its `transport-accepted`, then loops at 10 ms, the sends numbered from 0; only the staged sends carry the cell's `ttlMs` (1 500 ms in `paced-newest-n`, 100 ms in `paced-expiry`), and send 0 keeps the live channel's own lifetime. `messages.observe` exposes no `replacementMsgId`, which the lifecycle does not keep. The lane ran locally without `RALLAR_ICE_MODE=metered`. The generated hosted manifests 18 and 22 changed only by `staged` in their observe lists, and the headless agent budget is 368 KiB (367.20 measured).                                                                                                                                                  |
| D473 | **R3 and R4, proof and split.** S1-i: D466–D472, unit tests at every owner, the public API snapshots and budgets, the three smoke cells. S1-ii: per-key and per-session byte and key bounds with `refused`/`capacity` naming the limit, fair selection across streams and groups, `cancel` and reconfiguration on the stage, stream-key isolation cells (two groups, two entities, two fixed audiences), the WS live-only fanout refusal (a live send to a topic declared `outbox` is refused typed), staging metrics on `readUsage`/`stats.rallar.alm`, the `examples/room-live-channel/README.md` example, a visible Recipe Console flow pinned by Playwright, and the hosted manifest placement. No game feed moves in Slice 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D474 | **Validation.** Focused: `packages/tests/shared/alm/outbound/publication/**`, `packages/tests/shared/al-contracts/**` for the policy and key, `packages/tests/shared-web/messages/**`, `packages/tests/shared-test/**` for the decoder, recipes and pins, the Deno `deno task check` of api-v1 (shared types reach it). Gates: `test:unit`, `typecheck`, `typecheck:tests`, the public API snapshots and `check:browser-bundles` (a crossed `rallar.ts` budget is raised to the next KiB with the figure recorded), `check-changed-repo-style`, the ALM smoke lane locally over the three carriers, the Branch Release Gate. No api-v1 mutation path changes, so no medium-scale or state-write gate is selected. **As applied (S1-i):** the gates ran per task, as the pull request records, and the Branch Release Gate runs at handoff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D475 | **R7, shared primitives.** Retention and the cadence have shared owners. `retainNewest(values, limit)` (`packages/shared/cache/retain-newest.ts`) keeps the newest `limit` values and returns the displaced ones oldest first, for the publication stage and the motion buffer (`packages/shared/rallar-motion/buffer.ts`). `computeCadenceBoundaryAtMs`, `computeNextCadenceAtMs` and `isCadenceDue` (`packages/shared/resilience/cadence.ts`) give one cadence after the last, the next opportunity with no catch-up burst (the boundary or now, whichever is later; now when there was no last) and whether a boundary is due, for the stage and the motion send gate (`packages/shared/rallar-motion/send-gate.ts`). The ALM-private `computeALPublicationRetention` and `computeALPublicationNextOpportunityAtMs` are deleted, and the backlog's bounded-FIFO line (D118) is closed (2026-10-29).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 4. Contracts (S1-i)

As applied (S1-i): the contracts as they landed, with the shared primitives of D475.

```ts
// packages/shared/al-contracts/publication/al-publication-policy.ts
export interface ALPublicationDrainBudget { readonly messages: number; readonly bytes: number; }
export interface ALPublicationPolicy {
    readonly cadenceMs: number;
    readonly retainNewest: number;
    readonly drain: ALPublicationDrainBudget;
}
export const AL_PUBLICATION_POLICY_LIMITS = { maxCadenceMs: 60_000, maxRetainNewest: 64, maxDrainMessages: 64, maxDrainBytes: 4 * 1024 * 1024 } as const;
export function validateALPublicationPolicy(policy: ALPublicationPolicy): readonly RallarValidationIssue[]; // ranges and integrality, paths `$.publication.*`
export function decodeALPublicationPolicy(value: unknown): Either<readonly RallarValidationIssue[], ALPublicationPolicy>; // the one unknown boundary

// packages/shared/al-contracts/publication/to-al-publication-stream-key.ts
export function toALPublicationStreamKey(msg: ALMessage): string;
export function toALPublicationLaneKey(msg: ALMessage): string; // `${topicId}/${typeId}`

// packages/shared/al-contracts/resolve-al-channel-send-defaults.ts
export type ALChannelPurpose = 'command' | 'notification' | 'live';
export const AL_LIVE_CHANNEL_TTL_MS = 1_000;
export interface ALChannelSendDefaults { readonly reliability: 'best-effort' | 'at-least-once'; ... }

// packages/shared/alm/delivery/al-delivery-lifecycle.ts
export type ALDeliveryState = 'submitted' | 'staged' | 'rejected' | ...;
// ALDeliverySettlement gains one member inline, beside its siblings, with `traceId` from the shared intersection:
//     | Readonly<{ kind: 'staged'; msgId: string; carrier: ALDeliveryCarrier; atMs: number; }>

// packages/shared/alm/outbound/publication/al-outbound-staged-publication.ts
export interface ALOutboundStagedPublication<TContext> {
    readonly msg: ALMessage; readonly msgId: string; readonly traceId: string; readonly carrier: ALDeliveryCarrier;
    readonly laneKey: string; readonly streamKey: string; readonly bytes: number; readonly expiresAtMs: number;
    readonly stagedAtMs: number; readonly context: TContext;
}

// packages/shared/alm/outbound/publication/al-outbound-publication-stage.ts
export interface ALOutboundPublicationLaneReport {
    readonly laneKey: string; readonly policy: ALPublicationPolicy;
    readonly nextOpportunityAtMs: number | undefined; readonly staged: number; readonly streams: number;
}
export namespace ALOutboundPublicationStage {
    export interface Input<TContext> {
        readonly taskId: string;
        readonly queueEngine: InboxOutboxEngine;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly submit: (selected: readonly ALOutboundStagedPublication<TContext>[]) => Promise<void>;
        readonly settle: ALDeliverySettlementSink;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink;
    }
    export interface StageInput<TContext> { readonly msg: ALMessage; readonly carrier: ALDeliveryCarrier; readonly policy: ALPublicationPolicy; readonly bytes: number; readonly context: TContext; }
    export type StageResult = Readonly<{ kind: 'staged'; displacedMsgId: string | undefined; }> | Readonly<{ kind: 'refused'; reason: 'oversized'; detail: string; }>;
}
export class ALOutboundPublicationStage<TContext> {
    constructor(input: ALOutboundPublicationStage.Input<TContext>);
    stage(input: ALOutboundPublicationStage.StageInput<TContext>): ALOutboundPublicationStage.StageResult; // settles `staged` and `superseded` (displaced); returns `refused` for the caller to settle; throws once disposed
    readLane(laneKey: string): ALOutboundPublicationLaneReport | undefined;
    dispose(): void; // settles every staged value `skipped`/`disposed`, excludes the task
}
// pure: compute-al-publication-selection.ts; retention is `retainNewest`, the next opportunity `computeNextCadenceAtMs`

// packages/shared/cache/retain-newest.ts
export interface RetainNewestResult<T> { readonly retained: readonly T[]; readonly displaced: readonly T[]; }
export function retainNewest<T>(values: readonly T[], limit: number): RetainNewestResult<T>; // `values` oldest first

// packages/shared/resilience/cadence.ts
export function computeCadenceBoundaryAtMs(input: CadenceBoundaryInput): number; // lastAtMs + cadenceMs
export function computeNextCadenceAtMs(input: CadenceInput): number; // the boundary or now, whichever is later; now with no last
export function isCadenceDue(input: CadenceDueInput): boolean; // a cadence of zero or less, or now at the boundary

// packages/shared-web/browser/messages/publication/
export function validateBrowserLiveSend(send: BrowserLiveSendOptions): readonly RallarValidationIssue[];
export function toBrowserPublicationDelivery(message: ALMessage, channel: BrowserTypedChannelPolicy | undefined): Pick<BrowserRallarMessageDispatch.Delivery, 'message' | 'publication'>;
export class BrowserPublicationStages {
    constructor(input: BrowserPublicationStages.Input); // { nowMs, submit(delivery, epoch) }
    stage(delivery: BrowserPublicationStages.LiveDelivery, epoch: BrowserDeliverySettlements.Epoch): void;
    readLane(context: ApiMiddleware, laneKey: string): ALOutboundPublicationLaneReport | undefined;
    stopStage(): void;
}
```

## 5. The S1-i cells

As applied (S1-i): each cell sends a lead value, send 0, and waits for its `transport-accepted` before the loop,
so the loop's values meet the lane's next boundary rather than its first opportunity. Send 0 keeps the live channel's
own lifetime; a cell's `ttlMs` is on its staged sends only. The opportunity rows state the stage's selection, not
delivered history: values of one stream share their latest-wins key, so under carrier backpressure a later sibling
admitted at the same opportunity can still conflate an earlier one.

| Cell             | Policy (cadence / N / drain)  | Sender                                                                | Expected                                                                                                                                                                                                    |
| ---------------- | ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paced-latest`   | 500 ms / 1 / 8 msgs, 64 KiB   | send 0, then sends 1–5 on one `resourceId` every 10 ms (loop)         | send 0 admitted at once (idle lane); sends 1–4 `superseded` with `attempts: 0`; send 5 `transport-accepted`; the receiver sees exactly 2 arrivals, seq 0 then 5, and none more within 3 s                   |
| `paced-newest-n` | 500 ms / 3 / 2 msgs, 64 KiB   | send 0, then sends 1–4 on one `resourceId` every 10 ms, `ttlMs: 1500` | 0 at once; 1 displaced by 4 (`superseded`, `attempts: 0`); opportunity 2 admits 2 and 3; opportunity 3 admits 4; the receiver sees 0, 2, 3, 4 in order and none more within 3 s; handle 4 observed `staged` |
| `paced-expiry`   | 1 000 ms / 1 / 8 msgs, 64 KiB | send 0, then send 1 with `ttlMs: 100`                                 | 0 at once; 1 `expired` with `failure.kind: 'expired'` and `attempts: 0`; the receiver sees one arrival and none within the next 1.5 s                                                                       |

Unit pins beyond the cells: a manual-clock opportunity run after a 10 × cadence gap runs once and schedules
`now + cadence`; a value heavier than `drain.bytes` is refused `oversized` before staging; a `command` channel
with `publication` and a live channel without one fail definition validation; a live send with
`reliability: 'at-least-once'` throws the `unsupported` issue before any handle; `toALPublicationStreamKey`
separates two groups, two resources and two fixed lists with equal type ids; `staged` is reached only from
`submitted` and `AL_DELIVERY_ADMITTED_STATES` contains it.

## 6. Owners touched (S1-i)

As applied (S1-i): `packages/shared/al-contracts/{publication/**, resolve-al-channel-send-defaults.ts}`;
`packages/shared/alm/delivery/{al-delivery-lifecycle.ts, compute-al-delivery-lifecycle.ts}`;
`packages/shared/alm/outbound/{publication/**, al-outbound-message-runtime.ts (diagnostic kind), README.md}`;
`packages/shared/cache/{retain-newest.ts, README.md}`, `packages/shared/resilience/cadence.ts` and
`packages/shared/rallar-motion/{buffer.ts, send-gate.ts}` (D475);
`packages/shared-web/browser/messages/{rallar-message-contracts.ts, validate-rallar-typed-channel-policy.ts,
to-browser-message-send-defaults.ts, browser-typed-message-channels.ts, browser-rallar-message-sender.ts,
browser-rallar-message-dispatch.ts, browser-session-deliveries.ts}`,
`packages/shared-web/browser/messages/publication/{browser-publication-stages.ts,
to-browser-publication-delivery.ts, validate-browser-live-send.ts}`,
`packages/shared-web/browser/connection/browser-delivery-settlements.ts` (the epoch's `onClose`),
`rallar-messages.ts`, `rallar-core.ts`, `rallar.ts` exports and the public API snapshots, `bundle-budgets.json`;
the AR Eye director attempt mapping (`apps/ar-eye-hunter-v1/src/game/arena-runtime/match/to-director-attempt-state.ts`);
`packages/shared-test/rallar-bb-test/{rallar-black-box-test-contracts.ts, schema.ts,
schema/rallar-black-box-command-fields.ts, alm/rallar-black-box-alm-command-capabilities.ts,
alm/validate-alm-control-command.ts, docs/schema-and-capabilities.md}`;
`packages/shared-test/rallar-bb-test/conformance/alm/{scenarios/publication/**, alm-conformance-scenario-definition.ts,
alm-conformance-receiver-commands.ts, alm-conformance-step-identities.ts, create-alm-conformance-recipes.ts}`;
`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/{black-box-rallar-operation-contracts.ts,
messaging/decode-black-box-rallar-message-send-input.ts, messaging/decode-black-box-rallar-message-channel.ts,
messaging/black-box-rallar-delivery-ledger.ts, messaging/black-box-rallar-typed-channels.ts}`;
`apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts` and the generated manifests 18 and 22;
`docs/test-structure-coupling-exceptions.md`; `plans/backlog.md` (D118's line closed); tests under
`packages/tests/{shared,shared-web,shared-test,rallar-black-box}/**`; docs `docs/rallar-api-reference.md`
(the purpose paragraphs and the `staged` state), the product description's channel purposes and congestion
limit, the roadmap (decision record, release map, "Release 9, Slice 1 design" section, the fresh-session
paragraph), the addendum §7 "As applied".
