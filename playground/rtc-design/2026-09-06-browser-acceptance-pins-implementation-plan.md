# Browser Acceptance Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the five acceptance scenarios of the group-activation product plan that only a real
browser can exercise — `discovery-holds-dials` end to end, `member-progress`'s monotonic fraction,
`status-on-connect`'s readiness barrier, `reset-tears-down` and `reset-no-stale-hydration` — so the
coverage table in `docs/rallar-group-formation-architecture.md` names an executable pin for each.

**Architecture:** The browser agents that the three-browser Playwright matrix drives gain two
commands, `formation.command` and `formation.readiness`, that speak to the shipped
`rallar.rooms.formation(room)` handle and to `rallar.rtc.waitForRoom` through the same runtime the
`rtc.connect` command uses. Everything a pin observes is evidence the runtime already knows how to
record: the `health` command reports a `formation` summary, the formation handle's changes and the
room's RTC transport status are forwarded as diagnostics beside the existing
`rallar.browser.rtc.lifecycle` stream, and the recipe primitives `wait`, `assert` and `rtc.connect`
without readiness do the rest. The pins are one Playwright spec under
`playwright.full-stack.config.ts` against the in-memory API. No server code changes; no new
transport; the SPA's operator panels are untouched, though `apps/rallar-black-box/src/flow-builder.ts`
gains a case per command kind or the app stops type-checking.

**Tech Stack:** TypeScript under `packages/shared-test` (the `rallar-bb-test` control protocol and
browser adapter, the `black-box-runner/browser` Rallar runtime), Playwright under
`tests/playwright/rallar-black-box/`, Vitest under `packages/tests/`, dprint formatting.

**Spec:** `playground/rtc-design/2026-08-22-group-activation-product-plan.md` ("The browser
contract", "The observed connectivity status", "Progress and continuous updates", decisions 30 and
40, and the "Named acceptance scenarios" table), read together with the coverage table in
`docs/rallar-group-formation-architecture.md` ("Acceptance scenarios"). The browser surface it
drives is `docs/rallar-api-reference.md` ("Room formation") as delivered by
`2026-09-05-browser-lifecycle-command-surface-implementation-plan.md`; that plan's settled question
Q8 is the mandate for this one.

Status: **slice 1 delivered on `codex/browser-acceptance-pins`; slice 2 written, with one of its
five scenarios green and the reopen-based ones open on L7. The five
review questions were settled with the maintainer on 2026-09-06.** Written 2026-09-06 against `main` @ `9b3bea7e0`, with the stale-epoch conflict PR #533
and the connect-fence recipe PR #535 open; nothing here depends on either. Amended the same day after
a max-effort review of the first draft (the review moved the read side onto the runtime's evidence
roots, corrected the RTC status source to `rtc.roomStatus`, rewrote the scenario windows, and took the
Hetzner manifest out of scope), and amended again after the question round, in which each question was
researched against the code and then adversarially challenged before it was answered. Four questions
took the recommended answer and Q5 did not; the round also corrected several claims this plan carried,
and those corrections are folded into the sections they belong to rather than left in the question
table. "Questions settled in review" records every answer beside the alternatives it was decided
against. Amended once more on 2026-09-06 before slice 1 started, after a mapping pass read every
file the slice touches: it found the plan named a type that does not exist, a decoder idiom the
named sibling does not use, a barrier condition that resolves vacuously, and a status stream that
never wakes on the event the barrier waits for. "Repairs before slice 1" lists what changed.

## Global Constraints

- The code standard is `.agents/skills/rallar-code-writing/references/repo-code-style.md`; every
  touched file enters touched-file standards closure (see `AGENTS.md`). `AGENTS.md` routes written
  and multi-slice plans to `adaptive-plan-execution`; the header's sub-skill line is the shared
  plan template and does not replace that routing.
- `room` is the browser term, `group-state` the server term. Recipe commands use the browser
  vocabulary (`formation`, `room`); the HTTP steps they sit beside keep the group-state routes.
- `unknown` stays at the boundary, twice: the browser runtime decodes a command's JSON input with a
  named `decodeXxx(value: unknown): Either<...>` before the controller sees it, and the Playwright
  helpers decode a control result's JSON value with a named decoder before a test asserts on it.
  No bare `as` casts on either side.
- Required fields by default; absence is `T | undefined`, never `null`. A JSON result omits an
  undefined field, and a recipe asserts absence with the `exists` operator.
- A `formation.*` command names its room the way `rtc.connect` does: an exact `roomRef`, or
  `applicationId` plus `roomId` with `workspaceId` defaulting to `default`. That default lives in
  `blackBoxRallarRoomRefOf` inside the browser runtime, not in the connection-config decoder and not
  in the control protocol, which applies no default at all.
- The runtime directory's five existing `decode-*` decoders throw `TypeError`; no file in it imports
  `Either`. The formation decoder follows the code standard and this plan's boundary rule instead and
  returns an `Either`, which makes it the first in that directory. Converting the five siblings is a
  named follow-up, not this plan's work.
- At most three positional parameters; `interface` for object contracts, `type` for unions; one
  canonical name per type; kebab-case filenames matching the primary export. Runtime controllers are
  classes named `BlackBoxRallarXxxController` in `xxx-controller.ts`, like their siblings.
- Comments only for a non-obvious invariant or deliberate tradeoff; none in tests beyond intent.
- Tests live under `packages/tests/**` mirroring the production path: the browser runtime's tests
  are `packages/tests/shared-test/rallar-browser-runtime/*.test.ts`, the control protocol's is
  `packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`. Playwright specs live under
  `tests/playwright/rallar-black-box/`, are catalogued in
  `apps/rallar-black-box/src/full-stack-qa-matrix.ts` (pinned by
  `packages/tests/rallar-black-box/full-stack-qa-matrix.test.ts`), and are type-checked by no tsc
  project (`apps/rallar-black-box/tsconfig.json` includes `src`, `scripts` and `rallar-bb-test`
  only): a spec's type safety is the spec run.
- A new command kind lands in one task in all of: `RALLAR_BLACK_BOX_TEST_COMMAND_KINDS` and the
  `RallarBlackBoxTestCommand` union (`packages/shared-test/rallar-bb-test/types.ts`), the control
  validation and the adapter dispatch (`control-protocol.ts`, `browser-adapter.ts`), the published
  schema (`schema.ts`: the `COMMAND_SCHEMAS` record behind `RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA`,
  which the compiler proves total over the kinds, and the per-kind
  `RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` catalogue, which
  `packages/tests/shared-test/rallar-bb-test-schema.test.ts` keeps in lockstep with the kinds, plus
  the golden corpus under `fixtures/schema/v1/`), `apps/rallar-black-box/src/flow-builder.ts` (whose
  exhaustive switch fails `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit` with `TS2366`
  when a kind has no case), `packages/tests/shared-test/rallar-companion-coverage.test.ts` (an
  exhaustive literal array of the kinds), and `docs/schema-and-capabilities.md`. Two sites the first
  draft listed are **not** gates and are design choices here: `distributed-run-monitor.ts`'s
  `commandSummary` has a `default:` branch and derives `COMMAND_CAPABILITY_BY_KIND` from the schema
  catalogue, and `RallarBlackBoxControlAgentCapabilities` (`distributed-run.ts`) carries only `crdt`
  and `assertions` blocks, with no per-kind list.
  `black-box-runner-adapter.ts` is the black-box-runner's RTC client shim (`rtc.connect`,
  `rtc.send`, `close` only) and takes no per-kind dispatch.
- `packages/shared-test/rallar-bb-test/browser-adapter.ts` is 3,083 lines and carries a registered
  style exception (`docs/repo-code-style-exceptions.md`) whose review condition is "review it again
  if the file exceeds 3,100 physical lines". Two dispatch branches plus a shared `executeFormation`
  cross that line, so slice 1 owes an exceptions-document update rather than a silent overrun.
- Identifier discipline for browser recipes is the one `2026-09-05-black-box-coverage-plan.md`
  records: every identifier carries the Playwright run's `suffix`, request ids are 20–128
  characters, and a scenario is re-runnable against a dirty server.
- Absence of an event is never claimed with `wait` `absent: true` after the same event legitimately
  happened earlier in the run: that wait scans the whole buffer, so past events violate it by
  design. Absence after a positive occurrence is pinned as an unchanged count over a held window,
  paired with a positive control that makes the count move.
- Timeouts are never widened to make a scenario pass; a flaky scenario is diagnosed against `main`
  first (`live-rtc-local-matrix-environmental-failure` in the repository memory records that the
  local live matrix can fail identically on pristine `main`).
- Commits are plain imperative sentence-case subjects, no prefix, no trailers. Settled Q5: both
  slices ride one `codex/browser-acceptance-pins` branch as two commits in one pull request,
  reviewed once and squashed once, so `main` receives a single commit. Nothing lands on `main`
  without the `AGENTS.md` per-operation approval.
- No REST behaviour changes and no mutation-path changes: the medium-scale and state-write gates are
  not local requirements. The distributed-risk selection
  (`scripts/distributed-validation-risk/distributed-validation-risk.mjs`) treats
  `packages/shared-test/rallar-bb-test` and `packages/shared-test/black-box-runner/browser` as
  risk paths. Both slices select that run, not only slice 1: slice 2 edits the root `package.json`,
  which the same script matches as a risk path. Because settled Q5 gives `main` one commit, Run
  Hetzner Supported Distributed Manifests fires once, on that commit, and is part of the plan's
  completion evidence.

---

## Design

### What exists and what is missing

| Exists today                                                                                                                                                                                                                                                                                                                   | Missing for the pins                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rallar.rooms.formation(room)`: the eight commands, `status()`, `waitForStage`, `waitForLayout`, `waitForCondition`, `onChange`, `onLayout`, `readView()`, `toRoomFormationDenial`; `rallar.rtc.roomStatus(room)` and `rallar.rtc.waitForRoom(room)` (`docs/rallar-api-reference.md`, `rallar-rtc-facade.ts`)                  | Nothing in the black-box runtime calls them; a browser agent reaches the lifecycle only through `http.request` to the group-state routes, which observes the server, not the browser     |
| The browser Rallar runtime `window.__blackBoxRallar` (`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/`) with `authenticate`, `connect`, `send`, `sendWs`, `refreshRoom`, `readRtcMessageNacks`, `crdt`, `director`, `close`, `health`, and the diagnostics it forwards (`rallar.browser.rtc.lifecycle`) | A `formation` controller beside `director`, a `formation` block on the `health` diagnostics, and the handle's changes and the room transport status forwarded as diagnostics             |
| The control protocol's commands: `configure`, `parallel`, `loop`, `wait` (positive, and `absent: true` over the whole buffer), `assert` (dot-path operators over the evidence roots), `rtc.connect` (readiness optional), `rtc.send`, `rtc.stream`, `ws.*`, `http.request`, `director.*`, `stats`                              | `formation.command` and `formation.readiness`, validated, schema-published and capability-advertised like the others                                                                     |
| The Playwright three-browser matrix (`full-stack-live-rtc-three-browser-matrix.spec.ts`) with `LiveRtcControlClient`, `openLiveRtcBrowserAgent`, `createLiveRtcDeliveryOperations` and the `GroupFormationLifecycleDriver` (`create-group-formation-lifecycle-driver.ts`), whose membership setup hard-codes one policy        | A lifecycle acceptance spec that reuses the client and the agents, a policy input on the membership setup, a reopen-without-readiness step, its npm scripts and its row in the QA matrix |
| The coverage table and its documentation test (`packages/tests/repo/rallar-group-documentation.test.ts`), which count the unpinned scenarios                                                                                                                                                                                   | Rows that name the executable pins, and the count paragraph updated by the same edit                                                                                                     |

### Decisions taken at planning

| #  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 | **The pins drive the shipped browser handle, not HTTP.** Every scenario here is about what the browser does — dials, readiness, the local fraction, hydration after reset. Driving the server routes from the agent would observe the server twice and the browser never. So the agents get a `formation` controller that calls `rallar.rooms.formation(room)`, and the recipes read the runtime's evidence about it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| P2 | **Two write-side commands, and the read side is evidence the runtime already records.** `formation.command` issues one of the eight commands; `formation.readiness` awaits the browser's own room readiness. Everything else reuses primitives: presence without readiness is `rtc.connect` with no `readiness` block (the adapter skips the wait when the block is absent); the status projection rides on `health`; stage changes, layout events and the room transport status are diagnostics that `wait`, `assert` and the run snapshot expose. _Rejected:_ `formation.attach`, `formation.status`, `formation.wait` and `formation.progress` as commands — each duplicated a primitive or a diagnostic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P3 | **Evidence is the status projection, and the room block is a named projection of it.** The `health` block and the change diagnostic carry `RallarRoomFormationStatus` minus `snapshot`, with `causalRevision` lifted from it, plus six fields selected from the `rtc` member of `rallar.rtc.roomStatus(room)`: `state`, `acceptedLayoutIdentity`, `desiredPeerIds`, `readyPeerIds`, `activePeerIds`, `failedPeerIds`. That member is wider than those six — it also carries `knownPeerIds`, a full `peers` array, `desired`, `mode`, `laneId`, `reason` and `lastChangedAtEpochMs`, which is the clock read at projection time and which no pin may assert on — so the selection is deliberate, not a pass-through. Absent values stay absent; nothing else is derived for the recipe. The block is flat: pins read `health.formation.stage` and `health.formation.dialing`, never a nested `status` member.                                                                                                                                                                                                                                                                                                                                   |
| P4 | **The member-progress series is the recorded `rallar.browser.formation.room-status` diagnostics of a member that reopens against an active group.** Hydration delivers the accepted layout first (`desiredPeerIds` full, `readyPeerIds` empty), then lanes open while no group write happens, which is the window decision 40 describes; the test computes `ready / desired` per sample and asserts monotonicity within one `acceptedLayoutIdentity`, the end value `1`, and an unchanged `groupRevision` across the increases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| P5 | **Dials are counted, not waited on.** The dial witness is the existing `rallar.browser.rtc.lifecycle` diagnostic with payload `kind: 'peer-created'`. Holding a lobby proves zero such events over a window on an agent that has never dialed; teardown after `reset` proves the per-agent count unchanged over a window, because the buffer already holds the pre-reset dials and `wait` `absent: true` would violate on them by design. The same buffer scan makes a positive `wait` after `reset` unsound (a pre-reset sample satisfies it in the first tick), so slice 1 adds an optional since-cursor to the `wait` primitive and every post-reset wait carries it. It is not one edit: `wait-for-event.ts` calls `findWaitEvent` at three sites (the immediate scan, the subscription re-evaluation, and the absence scan), and `findWaitEvent` iterates backwards and returns the newest match, so the cursor filters the event list rather than testing the event it returns. A new field on `wait` is also refused by three gates the first draft did not name: the `validateKeys` allow-list in `control-protocol.ts`, and both `strictCommandSchema` and `waitMatchSchema` in `schema.ts`, which set `additionalProperties: false`. |
| P6 | **The readiness barrier is observed by the browser itself, in one command, and it observes only.** Settled Q3: `formation.readiness` polls the room-status projection until `state` is `'open'` **and `desiredPeerIds` is non-empty**, and in the same tick that condition first holds it captures the `health` block and emits `rallar.browser.formation.ready`. The second half of that condition is not decoration: `resolveRtcRoomTransportState` returns `'open'` when `desiredPeerCount === 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| P7 | **Both reset scenarios are pinned in the live three-browser lane; the Hetzner lane is out of scope.** Control agents are long-lived pages with no reopen command, so a manifest cannot express `reset-no-stale-hydration` at all, and the product plan's "live-RTC" is the Playwright lane. Reopen is not a registry entry that someone could add: the recipe executes inside the agent's own page, so a reload destroys the program that would observe the result, and the headless worker opens each page once and thereafter only polls control HTTP. It needs a new protocol participant. `reset-tears-down` needs no reopen and is a separate decision (settled Q2: deferred on cost and fidelity, not on capability).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P8 | **Every scenario's group is `preset: 'managed'` with both triggers manual** (the literal the driver already hard-codes), which is the phased family the product plan means by a "`phased` group" holding in `forming`: the repository memory `phased-group-triggers-behavioural-in-recipes` records that a `managed` group with the default `immediate` connect trigger dials itself on publication, so the manual connect trigger is what keeps the lobby and every later `connect` under the test's control.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Ownership map

| Concern                                                                   | Owner (new files in bold)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The browser-side formation controller, its input decoder and its summary  | **`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/formation-controller.ts`**, **`decode-black-box-rallar-formation-input.ts`**, contracts in `black-box-rallar-operation-contracts.ts` and `black-box-rallar-runtime-contract.ts`; the facade seams (`rooms.formation`, `rtc.roomStatus`, `rtc.waitForRoom`, `rtc.onStatus`) widened in `browser-rallar-runtime-composition.ts`; construction in `black-box-rallar-runtime.ts` (`#createProductControllers`, `installation()`) |
| The `health` block and the three diagnostics                              | `black-box-rallar-health-reader.ts`, `black-box-rallar-runtime.ts` (the subscriptions installed beside `rtc.onLifecycle`)                                                                                                                                                                                                                                                                                                                                                                            |
| The bridge from the agent adapter to the runtime                          | `packages/shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts`, `browser-adapter.ts` (`RallarBlackBoxBrowserRallarRuntime.formation`)                                                                                                                                                                                                                                                                                                                                                        |
| The two commands: types, validation, dispatch, schema, capabilities, docs | `packages/shared-test/rallar-bb-test/types.ts`, `control-protocol.ts`, `browser-adapter.ts`, `schema.ts` (`COMMAND_SCHEMAS`, `RALLAR_BLACK_BOX_COMMAND_CAPABILITIES`), `fixtures/schema/v1/golden-compatibility-corpus.json`, `distributed-run.ts`, `distributed/control-agent-capabilities.ts`, `distributed-run-monitor.ts`, `docs/schema-and-capabilities.md`, `docs/runtime-diagnostic-contract.md` (both under `packages/shared-test/rallar-bb-test/`)                                          |
| The Playwright lifecycle acceptance spec and its operations               | **`tests/playwright/rallar-black-box/full-stack-live-rtc-lifecycle-acceptance.spec.ts`**, **`live-rtc-formation-operations.ts`**, `live-rtc-control-client.ts`, `create-group-formation-lifecycle-driver.ts`, `live-rtc-browser-agents.ts`                                                                                                                                                                                                                                                           |
| The npm scripts and the QA matrix row                                     | `package.json`, `apps/rallar-black-box/src/full-stack-qa-matrix.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Documentation closure                                                     | `docs/rallar-group-formation-architecture.md` (coverage table, count paragraph, the lanes paragraph), `playground/rtc-design/README.md`                                                                                                                                                                                                                                                                                                                                                              |

### The scenarios as executable statements

Each row is the statement the test asserts, in the vocabulary of the `health` block (P3) and the
diagnostics (P4–P6). "Reopen" means: close the agent's page, open it again with the restored
session (`openLiveRtcBrowserAgent`), and issue `rtc.connect` with no `readiness` block, so the
browser connects, joins and hydrates on its own with no harness refresh.

| Scenario                   | Executable statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `discovery-holds-dials`    | Three agents connect (no readiness) to a `managed` group with both triggers manual, holding in `forming`: after a 5 s hold every agent's `peer-created` count is `0` and its `health.formation` reads `stage: 'forming'`, `dialing: 'none'`; then the manager's `plan` and `connect` followed by `formation.readiness` on all three make every agent's `peer-created` count at least `1` — the positive control for the hold.                                                                                                                                                                                                        |
| `member-progress`          | After activation, agent C reopens; its `rallar.browser.formation.room-status` diagnostics from the reopen to its `formation.readiness`: samples with `desiredPeerIds` empty carry no fraction (the pre-hydration ones), every later sample carries the same `acceptedLayoutIdentity`, the fraction `readyPeerIds.length / desiredPeerIds.length` never decreases, the last is `1`, and the `groupRevision` stamped on the samples is the same from the first `desiredPeerIds`-full sample to the last.                                                                                                                               |
| `status-on-connect`        | After activation, agent B reopens and runs `formation.readiness`: the `rallar.browser.formation.ready` diagnostic's `atEpochMs` is at or after the `atEpochMs` of B's last `rallar.browser.formation.changed` diagnostic carrying `accepted.identity` and of its `rallar.browser.formation.layout` diagnostic with `kind: 'layoutAccepted'`; the captured block reads `stage: 'active'`, `accepted.identity` equal to `room.acceptedLayoutIdentity`, and equal to the `accepted.identity` agents A and C report on `health`.                                                                                                         |
| `reset-tears-down`         | After the manager's `reset` on the active group, every agent's `wait` for a `rallar.browser.formation.changed` diagnostic with `payloadPath: 'data.stage'`, `equals: 'dormant'` resolves; its `health` then reads `rtcStatus.activePeerIds`, `knownPeerIds` and `readyPeerIds` empty (the facade-level lanes, which the room block would report empty by construction), `formation.dialing: 'none'`, `accepted` and `planned` absent; each agent's `peer-created` count is unchanged over a 5 s hold; the manager's `start`, `plan`, `connect` and `formation.readiness` on all three then raise every count — the positive control. |
| `reset-no-stale-hydration` | After the reset and before `start`, agent C reopens: its first `health` after `rtc.connect` (hydration only, no refresh) reads `formation.stage: 'dormant'`, `planned` absent, `accepted` absent, `coverageRate` absent, and `rtcStatus.readyPeerIds` empty; a `refreshRoom` (`refreshLiveRtcBrowserRoom`) followed by a second `health` reads the same values.                                                                                                                                                                                                                                                                      |

---

## Slice 1 — The formation commands and their evidence

Delivers the two commands, the `health` block and the three diagnostics end to end in the browser
runtime, the adapter, the control protocol and the published schema, with unit coverage; no
scenario yet. Slice 2 consumes it unchanged.

### Task 1.1: The formation controller, its evidence and the runtime contract

**Files:**

- Create: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/formation-controller.ts`
- Create: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-formation-input.ts`
- Modify: `black-box-rallar-operation-contracts.ts`, `black-box-rallar-runtime-contract.ts`,
  `black-box-rallar-health-reader.ts`, `black-box-rallar-runtime.ts` (`#createProductControllers`
  builds the product controllers and `installation()` exposes them),
  `browser-rallar-runtime-composition.ts` (`BlackBoxBrowserRallarRuntimeDependency` and
  `toBlackBoxBrowserRuntimeDependency`, whose `rooms` seam is `{ join, leave, refresh }` and whose
  `rtc` seam is `Pick<RallarRtcFacade, 'status' | 'diagnostics' | 'onLifecycle'>` today)
- Test: `packages/tests/shared-test/rallar-browser-runtime/formation.test.ts` (new, beside
  `director.test.ts`), `health.test.ts` if the health reader has one (else `diagnostics.test.ts`)

**Interfaces:**

- Consumes: `rallar.rooms.formation(room)` (`RallarRoomFormation`), `rallar.rtc.roomStatus(room)`,
  `rallar.rtc.waitForRoom(room, options)`, `rallar.rtc.onStatus`, the runtime's room resolution
  from the connection config (`decode-black-box-rallar-connection-config.ts`), the runtime
  diagnostics emitter used at `black-box-rallar-runtime.ts` line 355 for `rallar.browser.rtc.lifecycle`.
- Produces: `BlackBoxRallarFormationRuntime` on `BlackBoxRallarRuntime.formation`; the
  `formation` block on `BlackBoxRallarHealthDiagnostics`; the diagnostics
  `rallar.browser.formation.changed`, `rallar.browser.formation.layout`,
  `rallar.browser.formation.room-status`, `rallar.browser.formation.ready`.

- [x] **Step 1: Declare the contracts** in `black-box-rallar-operation-contracts.ts`:

```ts
export interface BlackBoxRallarFormationRoomInput {
    readonly roomRef: GroupRef;
    readonly timeoutMs: number;
}

export type BlackBoxRallarFormationCommandInput =
    | Readonly<{ command: 'connect'; layout?: GroupLayoutIdentity; }>
    | Readonly<{ command: 'reconfigure'; landing?: GroupTopologyReconfigureLanding; }>
    | Readonly<{ command: 'plan' | 'activate' | 'pause' | 'resume' | 'reset' | 'start'; }>;

export interface BlackBoxRallarFormationCommandRequest extends BlackBoxRallarFormationRoomInput {
    readonly input: BlackBoxRallarFormationCommandInput;
    readonly reason?: string;
}

export interface BlackBoxRallarFormationSummary {
    readonly roomRef: GroupRef;
    readonly stage: GroupLifecycleState;
    readonly formationEpoch: number;
    readonly formationAttemptCount: number;
    readonly lastFormationOutcome?: GroupFormationOutcome;
    readonly causalRevision: GroupStateCausalRevision;
    readonly transportState: GroupTransportState;
    readonly dialing: GroupDialLayoutRoles;
    readonly memberPolicy: GroupMemberPolicy;
    readonly accepted?: RallarRoomLayout;
    readonly planned?: RallarRoomLayout;
    readonly condition?: GroupActivationCondition;
    readonly coverageRate?: number;
    readonly room: RallarRtcRoomTransportStatus;
}

export interface BlackBoxRallarFormationCommandDiagnostics {
    readonly receipt: GroupSnapshot;
    readonly formation: BlackBoxRallarFormationSummary;
}

export interface BlackBoxRallarFormationReadinessDiagnostics {
    readonly readyAtEpochMs: number;
    readonly formation: BlackBoxRallarFormationSummary;
}

export interface BlackBoxRallarFormationRuntime {
    command(
        request: BlackBoxRallarFormationCommandRequest
    ): Promise<BlackBoxRallarFormationCommandDiagnostics>;
    readiness(
        room: BlackBoxRallarFormationRoomInput
    ): Promise<BlackBoxRallarFormationReadinessDiagnostics>;
}
```

`BlackBoxRallarFormationSummary` is `RallarRoomFormationStatus` without `snapshot`, plus the
`causalRevision` lifted from it and the `rtc` member of `rallar.rtc.roomStatus(room)` as `room`. Its
optional fields are the status's own (`accepted`, `planned`, `condition`, `coverageRate`,
`lastFormationOutcome` are `T | undefined` there), so a JSON result omits them and a recipe reads
absence with `exists`. `BlackBoxRallarHealthDiagnostics` gains
`readonly formation?: BlackBoxRallarFormationSummary`, present when the runtime is connected with a
room configured and the room is held in the state cache; absent otherwise, which is the same
"no room" meaning `roomRef?` on that record already carries.

- [x] **Step 2: Write the failing decoder test** in `formation.test.ts`:

```ts
it.each([
    { value: { command: 'plan' }, expected: { command: 'plan' } },
    {
        value: { command: 'connect', layout: PLANNED },
        expected: { command: 'connect', layout: PLANNED }
    },
    {
        value: { command: 'reconfigure', landing: 'hold' },
        expected: { command: 'reconfigure', landing: 'hold' }
    }
])('decodes $value.command', ({ value, expected }) => {
    expect(decodeBlackBoxRallarFormationCommandInput(value)).toEqual(Either.ofRight(expected));
});

it.each([
    { command: 'explode' },
    { command: 'reconfigure' },
    { command: 'plan', layout: PLANNED },
    { command: 'connect', layout: { groupRevision: 1 } }
])('refuses %o', (value) => {
    expect(decodeBlackBoxRallarFormationCommandInput(value).isLeft()).toBe(true);
});
```

`PLANNED` is a literal `GroupLayoutIdentity`. The `Either` API is the one in
`packages/shared/resilience/Either.ts`; read its accessor names (`isLeft`, `fold`, or the
repository's equivalent) before writing the assertion.

- [x] **Step 3: Run the test** — `npx vitest run packages/tests/shared-test/rallar-browser-runtime/formation.test.ts`. Expected: FAIL, the decoder does not exist.

- [x] **Step 4: Write `decode-black-box-rallar-formation-input.ts`** following
      `decode-black-box-rallar-crdt-input.ts`: `decodeBlackBoxRallarFormationCommandInput(value: unknown)`
      returns `Either<readonly BlackBoxRallarFormationInputIssue[], BlackBoxRallarFormationCommandInput>`,
      checks `command` against the eight names, accepts an optional `landing` on `reconfigure`
      (optional because the shipped handle declares it optional, where absent means the stored
      policy's own landing, and a required field would make the command less expressive than the
      handle it wraps) and refuses
      `landing` and `layout` on the commands that do not take them, and decodes `layout` with the
      `GroupLayoutIdentity` shape check the connect fence already uses in `packages/shared/api`.

- [x] **Step 5: Write the failing controller test** (same file), driving a fake
      `RallarRoomFormation` (an object literal with `status`, the eight command methods, `onChange`,
      `onLayout`) and a fake RTC port (`roomStatus`, `waitForRoom`, `onStatus`) through
      `BlackBoxRallarFormationController`:

```ts
it('issues the command and reports the receipt beside the summary', async () => {
    const { controller, formation } = createFormationHarness({
        stage: 'planned',
        formationEpoch: 1
    });

    const diagnostics = await controller.command({
        roomRef,
        timeoutMs: 5_000,
        input: { command: 'plan' }
    });

    expect(formation.calls).toEqual([['plan', { reason: undefined }]]);
    expect(diagnostics.formation).toMatchObject({
        stage: 'planned',
        formationEpoch: 1,
        dialing: 'none'
    });
    expect(JSON.parse(JSON.stringify(diagnostics.formation))).toEqual(diagnostics.formation);
});

it('captures the summary in the tick the room readiness resolves and emits the ready diagnostic', async () => {
    const { controller, rtc, diagnostics } = createFormationHarness({
        stage: 'active',
        formationEpoch: 3
    });
    const readiness = controller.readiness({ roomRef, timeoutMs: 5_000 });
    rtc.resolveRoomReady({ readyPeerIds: ['b', 'c'], desiredPeerIds: ['b', 'c'] });

    const result = await readiness;

    expect(result.formation.room.readyPeerIds).toEqual(['b', 'c']);
    expect(diagnostics.emitted.map((event) => event.topic)).toContain(
        'rallar.browser.formation.ready'
    );
});

it('forwards changes, layout events and room status as diagnostics', () => {
    const { formation, rtc, diagnostics } = createFormationHarness({
        stage: 'planned',
        formationEpoch: 1
    });
    formation.emitChange({ stage: 'connecting' });
    formation.emitLayout({ kind: 'layoutAccepted' });
    rtc.emitStatus({ readyPeerIds: ['b'] });

    expect(diagnostics.emitted.map((event) => event.topic)).toEqual([
        'rallar.browser.formation.changed',
        'rallar.browser.formation.layout',
        'rallar.browser.formation.room-status'
    ]);
});
```

- [x] **Step 6: Run it** — expected: FAIL, `formation-controller.ts` does not exist.

- [x] **Step 7: Implement `formation-controller.ts`** as a class mirroring `director-controller.ts`:

```ts
export interface BlackBoxRallarFormationControllerDependencies {
    readonly formation: (roomRef: GroupRef) => RallarRoomFormation;
    readonly rtc: Pick<RallarRtcFacade, 'roomStatus' | 'onStatus'>;
    emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
    readonly emitError: BlackBoxRallarRuntimeDiagnostics['emitError'];
    readonly now: () => number;
}

export class BlackBoxRallarFormationController implements BlackBoxRallarFormationRuntime {
    constructor(private readonly dependencies: BlackBoxRallarFormationControllerDependencies) {}

    async command(request: BlackBoxRallarFormationCommandRequest): Promise<BlackBoxRallarFormationCommandDiagnostics> { ... }
    async readiness(room: BlackBoxRallarFormationRoomInput): Promise<BlackBoxRallarFormationReadinessDiagnostics> { ... }
    summary(roomRef: GroupRef): BlackBoxRallarFormationSummary | undefined { ... }
    installDiagnostics(roomRef: GroupRef): RallarUnsubscribe { ... }
}
```

`command` switches on `request.input.command` and calls the handle method by name (`connect` with
`{ layout }` when given, `reconfigure` with `{ landing }`, every command with `{ reason }`); the
receipt is the returned `GroupSnapshot` and the summary is `this.summary(roomRef)` read after the
receipt was accepted. `readiness` (settled Q3) polls `rtc.roomStatus(roomRef).rtc` until its `state`
is `'open'` **and its `desiredPeerIds` is non-empty**, waking on both `rtc.onStatus` and
`formation.onChange` rather than sleeping, and never calls `rtc.waitForRoom`, whose `connect` option
defaults to `true` and would open lanes from inside the measurement. Both halves of the condition and
both wake sources are load-bearing; P6 records why. In the same tick the condition first holds it captures `summary(roomRef)` and `now()`
before any `await`, emits `rallar.browser.formation.ready` with the captured record, and returns it;
exhausting `timeoutMs` fails the command with `RALLAR_BLACK_BOX_FORMATION_NOT_READY` carrying the
last observed room block.
`summary` reads `formation.status()` and `rtc.roomStatus(roomRef).rtc` and translates them with the
pure `toBlackBoxRallarFormationSummary(status, room)`, which lifts `causalRevision` from
`status.snapshot.causalRevision` — the status carries no `causalRevision` of its own, so no state-store
seam is needed — and builds the summary field by field rather than spreading the status, because the
status declares its absent-capable fields as required-with-`undefined` and a spread would carry
explicit `undefined` keys into the block. The room block is the six fields P3 names; `knownPeerIds`,
the `peers` array, `desired`, `mode`, `laneId`, `reason` and the read-time `lastChangedAtEpochMs` are
dropped deliberately; it returns `undefined` when `status()` is
undefined (the room is not held), and `command`/`readiness` turn that into
`RALLAR_BLACK_BOX_FORMATION_ROOM_NOT_HELD`. `installDiagnostics` subscribes `formation.onChange`
(emit `rallar.browser.formation.changed` with the summary), `formation.onLayout` (emit
`rallar.browser.formation.layout` with `{ kind, identity }`) and `rtc.onStatus` (emit
`rallar.browser.formation.room-status` with the `room` block and the cached snapshot's
`causalRevision.groupRevision` as `groupRevision`), and returns one unsubscribe.

- [x] **Step 8: Wire it.** Widen the composition's seams: `rooms` gains `formation`
      (`rallar.rooms.formation`) and `rtc` gains `roomStatus`, `waitForRoom` and `onStatus` in
      `BlackBoxBrowserRallarRuntimeDependency` and `toBlackBoxBrowserRuntimeDependency`. Construct the
      controller in `black-box-rallar-runtime.ts`'s `#createProductControllers` beside the director
      controller and expose it from `installation()`; install the diagnostics where `rtc.onLifecycle` is
      installed (line 355) whenever the connection config resolves a room, and tear them down where that
      subscription is torn down. That teardown is four sites, not one: `#cleanupRuntimeSubscriptions`,
      which also increments the `unsubscribed` counter, moving it to `4` for a connection that resolves a room
      ref and leaving it at `3` for one that does not, both pinned in `formation.test.ts`; the `#connectEffect` catch block; the
      `RuntimeConnectionAttempt.lifecycleSubscriptions` `Pick`; and the
      `BlackBoxRallarConnectionState.Value` record. Then attach the health block: the reader holds no
      controller and does not import `blackBoxRallarRoomRefOf`, so the block rides
      `BlackBoxRallarHealthReader.Read` exactly as `crdt` and `director` do, resolved in
      `installation()` and passed in, and is present whenever the resolved room ref is present
      (settled Q4: always present, no input flag). Two guards are part of the decision and must
      not be left to the implementer. The reader passes that resolved `GroupRef` object and never a
      room-id string, because `rallar.rooms.formation(room)` raises `missing-room-ref` on an
      unresolvable string and `health()` runs on two hot internal paths — the `rtc.connect` readiness
      poll and `{{rtcReadyPeers}}` resolution — where a throw would be reported as an RTC failure in
      every existing recipe. And the block's absence is never silent: `reset-tears-down` and
      `reset-no-stale-hydration` assert that fields are absent, so a dropped block would read as
      green, which Task 2.1's decoder is required to prevent. Add
      `readonly formation: BlackBoxRallarFormationRuntime` to `BlackBoxRallarRuntime`.

- [x] **Step 9: Run** `npx vitest run packages/tests/shared-test/rallar-browser-runtime` — expected:
      PASS (the composition and lifecycle tests there cover the new subscription's teardown); then
      `npm run typecheck`.

- [x] **Step 10: Commit** — `Add the formation controller to the browser black-box Rallar runtime`.

### Task 1.2: The two commands in the control protocol and the adapters

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/types.ts`, `control-protocol.ts`, `browser-adapter.ts`,
  `browser-rallar-runtime-bridge.ts`, `schema.ts`,
  `fixtures/schema/v1/golden-compatibility-corpus.json`, `distributed-run.ts`,
  `distributed/control-agent-capabilities.ts`, `distributed-run-monitor.ts`,
  `docs/schema-and-capabilities.md`, `docs/runtime-diagnostic-contract.md`
- Test: `packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`,
  `packages/tests/shared-test/rallar-bb-test-schema.test.ts`, the browser adapter test beside them
  (`rallar-bb-test-browser-adapter.test.ts` or the file that drives `director.*` through the
  adapter — find it with `grep -rl "director.appoint" packages/tests/shared-test`), and the
  distributed run monitor test that covers `requiresCrdtRuntime`

**Interfaces:**

- Consumes: Task 1.1's `BlackBoxRallarFormationRuntime`.
- Produces: `RallarBlackBoxTestFormationCommandCommand` and
  `RallarBlackBoxTestFormationReadinessCommand` in the `RallarBlackBoxTestCommand` union
  (`kind: 'formation.command' | 'formation.readiness'`, the base command fields, the room identity
  fields `rtc.connect` declares, and for `formation.command` the fields `command`, `layout?`,
  `landing?`, `reason?`); `RallarBlackBoxBrowserRallarRuntime.formation?` (optional because the
  simulated providers have no facade, the same meaning `crdt?` and `director?` carry); the
  capability `formation: { supported: boolean }`; the failure codes
  `RALLAR_BLACK_BOX_FORMATION_ROOM_NOT_HELD`, `RALLAR_BLACK_BOX_FORMATION_NOT_READY` and
  `RALLAR_BLACK_BOX_FORMATION_DENIED` (the last carrying `toRoomFormationDenial(error)` in
  `details.denial` when it classifies).

- [x] **Step 1: Write the failing validation tests** in `rallar-bb-test-control-protocol.test.ts`:

```ts
it.each([
    {
        kind: 'formation.command',
        commandId: 'formation-plan-1',
        command: 'plan',
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 5_000
    },
    {
        kind: 'formation.command',
        commandId: 'formation-reconfigure-1',
        command: 'reconfigure',
        landing: 'hold',
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 5_000
    },
    {
        kind: 'formation.readiness',
        commandId: 'formation-ready-1',
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 30_000
    }
])('accepts a well-formed $kind $commandId', (command) => {
    expect(validateRallarBlackBoxTestCommand(command)).toEqual({ ok: true });
});

it.each([
    {
        kind: 'formation.command',
        commandId: 'formation-bad-1',
        command: 'explode',
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 5_000
    },
    {
        kind: 'formation.command',
        commandId: 'formation-bad-2',
        command: 'plan',
        landing: 'hold',
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 5_000
    },
    { kind: 'formation.readiness', commandId: 'formation-bad-3', timeoutMs: 5_000 }
])('rejects $commandId', (command) => {
    expect(validateRallarBlackBoxTestCommand(command).ok).toBe(false);
});
```

- [x] **Step 2: Run** — expected: FAIL (unknown kind).

- [x] **Step 3: Add the two kinds** to `RALLAR_BLACK_BOX_TEST_COMMAND_KINDS`, the two interfaces
      to the union, and the `case 'formation.command':` /
      `case 'formation.readiness':` branches in `control-protocol.ts` beside `case 'rtc.connect':`
      (`validateKeys` over the allowed keys, `validateStringField` for `command` against the eight names,
      and `fail('formation.command plan does not take landing.')` in the existing message style for the
      cross-field rules). The room identity rule has to be **written**, not reused: `validateRtcCommand`
      treats `roomRef`, `roomId`, `applicationId` and the rest as independently optional with no
      cross-field rule, so an `rtc.connect` naming no room validates today. The new rule is what makes
      the third rejection case above fail.

- [x] **Step 4: Dispatch** — the bridge exposes `formation` (one-line delegations to
      `resolveBrowserRallarRuntime()).formation`, failing with
      `browser-rallar provider did not expose formation runtime commands.`, the wording the director
      resolver uses), the adapter adds the two branches (the `director` family is the template). The
      decode runs **at the bridge, not in the adapter**: `browser-adapter.ts` imports nothing from
      `@shared-test/black-box-runner/**` today, and decoding there would introduce the first such import
      and move the boundary that the headless bundle test pins. For the same reason the
      `RallarBlackBoxBrowserRallarRuntime.formation?` seam stays `unknown`-shaped like its `crdt?` and
      `director?` siblings, and the diagnostics types are named at the bridge. The adapter records the
      `BlackBoxRallarFormationCommandDiagnostics` / `BlackBoxRallarFormationReadinessDiagnostics` as the
      result value. Write the adapter test: a fake runtime whose `formation.command` throws an
      `ApiHttpError` carrying `group-connect-planned-layout-superseded` yields
      `RALLAR_BLACK_BOX_FORMATION_DENIED` with `details.denial.kind === 'layout'`.

- [x] **Step 5: Publish the schema** — one `COMMAND_SCHEMAS` entry per kind mirroring the
      validation, one `RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` entry per kind (title, required and
      optional fields, `supportedProviderModes` naming `browser-rallar` only, runtime surfaces, live
      service requirements, artifact expectations, an example), and one instance of each kind in the
      golden corpus; `rallar-bb-test-schema.test.ts` must accept both, keep its kinds-versus-catalogue
      lockstep, and reject `formation.command` without `command`.

- [x] **Step 6: Capabilities** — `RallarBlackBoxControlAgentCapabilities` (`distributed-run.ts`,
      today `{ crdt?, assertions? }`) gains `formation?: { supported: boolean; }`;
      `toControlAgentCapabilities` sets `formation: { supported: providerMode === 'browser-rallar' }` and
      `parseControlAgentCapabilities` rebuilds it (it rebuilds the object field by field, so an
      unlisted field is dropped before the coordinator sees it); `distributed-run-monitor.ts` gains
      `requiresFormationRuntime(recipe)` beside `requiresCrdtRuntime` and the coordinator's capability
      check refuses to target a `formation.*` command at an agent that does not advertise it. Extend the
      monitor test that covers `requiresCrdtRuntime` with the formation twin.

- [x] **Step 7: Document** the family in `docs/schema-and-capabilities.md` ("Formation Commands":
      the two kinds, their fields, the failure codes, the `health.formation` block) and the four
      diagnostics in `docs/runtime-diagnostic-contract.md` (topic, payload shape, producer).

- [x] **Step 8: Run** `npx vitest run packages/tests/shared-test packages/tests/rallar-black-box`
      outside the sandbox (three suites bind loopback ports), then `npm run typecheck`. Commit —
      `Add the formation commands to the black-box control protocol`.

### Task 1.3: Slice 1 closure

- [x] `npm run test:unit`, `npm run build`, `npm run check:repo-style:changed -- origin/main HEAD`,
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`, `npm run format:check`,
      `npm run test:repo-governance` (the schema docs are governed), and
      `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` — the headless agent
      bundles the browser runtime, so the controller moves its budget; raise it per the Q6 convention of
      the browser surface plan (smallest whole KiB above the measurement, recorded beside the budget and
      in the PR).
- [x] PR with the standard body; `npm run pr:delivery -- status`; the Branch Release Gate on the
      final feature-branch commit and Run Hetzner Supported Distributed Manifests on the resulting
      default-branch commit (the slice touches a distributed-risk path, so the run is not a no-op).

---

## Deviations recorded during delivery (slice 1)

- The two new files live in
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/formation/`, not directly in
  `rallar-browser-runtime/` as the ownership map wrote. That directory already held twenty-one direct
  production files against a review threshold of twenty, so two more worsened the changed-style gate's
  density finding; the subdirectory is the feature grouping the gate asks for rather than a
  pass-through, and it returns the parent to its `main` baseline.
- Three names lost a `director` prefix they had outgrown, because the formation family shares them
  verbatim: `RallarBlackBoxTestDirectorRoomFields` is `RallarBlackBoxTestRoomFields`,
  `directorRoomProperties` is `commandRoomProperties`, and `toDirectorRuntimeInput` is
  `toRoomScopedRuntimeInput`. No behaviour changed; the alternative was a second copy of each.
- Two repeated shapes became one named type each, which is what kept the boundary rule satisfied
  while the family grew: `RallarBlackBoxBrowserRallarRuntimeMethod` replaces twenty-one identical
  `(input: unknown) => Promise<unknown>` members in `browser-adapter.ts`, and
  `RallarBlackBoxTestRecord` replaces twenty-five inline `Readonly<Record<string, unknown>>` in
  `types.ts`.
- The headless bundle budget moved from 224 to 226 KiB, measured at 225.107421875 KiB, under the
  maintainer's standing ruling that a crossed budget rises to the next whole KiB with the measurement
  recorded. The growth is the bridge's decode of the command input and the room it addresses.
- The `wait` since-cursor P5 calls for was missed by slice 1's task list and landed afterwards, on
  this branch, as `wait.match.sinceEpochMs`. It is one predicate check rather than the three
  call-site edits R12 describes, because all three scans route through the same matcher; the two
  schema gates and the control validation took the field as R12 said they must.
- `formation.readiness` resolves against the room-status projection reached through both wake
  sources, as repairs R1 and R2 specify. `formation.test.ts` pins the vacuous-resolve guard and the
  formation-change wake directly, and pins that the diagnostics install only for a connection that
  resolves a room ref, which is why the runtime's unsubscribe count reads four there and three in
  `runtime-lifecycle.test.ts`.

## Slice 2 — The local lane: the lifecycle acceptance spec

Pins the five scenarios in one Playwright spec that runs under the same configuration and
environment gates as the three-browser matrix.

### Task 2.1: The formation operations, the policy input and the reopen step

**Files:**

- Create: `tests/playwright/rallar-black-box/live-rtc-formation-operations.ts`
- Modify: `tests/playwright/rallar-black-box/live-rtc-control-client.ts`,
  `create-group-formation-lifecycle-driver.ts`, `live-rtc-browser-agents.ts`

**Interfaces:**

- Consumes: `LiveRtcControlClient` (`executeOk`, `resultValue`, `fetchRun`),
  `GroupFormationLifecycleDriver.setupGroupMembership`, `openLiveRtcBrowserAgent`,
  `refreshLiveRtcBrowserRoom`, the Task 1.2 commands and diagnostics.
- Produces:

```ts
export interface LiveRtcFormationOperations {
    command(input: FormationCommandInput): Promise<BlackBoxRallarFormationSummary>;
    readiness(input: FormationAgentInput): Promise<BlackBoxRallarFormationReadinessDiagnostics>;
    health(input: FormationAgentInput): Promise<FormationHealth>;
    waitForStage(input: FormationStageWaitInput): Promise<void>;
    countPeerCreated(input: FormationAgentInput): Promise<number>;
    readFormationDiagnostics(
        input: FormationDiagnosticsInput
    ): Promise<readonly FormationDiagnosticEvent[]>;
    reopen(input: FormationReopenInput): Promise<LiveRtcControlClient.Agent>;
}

interface FormationAgentInput {
    readonly control: LiveRtcControlClient;
    readonly runId: string;
    readonly agent: LiveRtcControlClient.Agent;
    readonly groupId: string;
    readonly suffix: string;
}

interface FormationCommandInput extends FormationAgentInput {
    readonly input: BlackBoxRallarFormationCommandInput;
}

interface FormationStageWaitInput extends FormationAgentInput {
    readonly stage: GroupLifecycleState;
    readonly timeoutMs: number;
}

interface FormationHealth {
    readonly formation: BlackBoxRallarFormationSummary | undefined;
    readonly rtcStatus: Readonly<{
        knownPeerIds: readonly string[];
        activePeerIds: readonly string[];
        readyPeerIds: readonly string[];
    }>;
}

interface FormationDiagnosticsInput extends FormationAgentInput {
    readonly topic:
        | 'rallar.browser.formation.changed'
        | 'rallar.browser.formation.layout'
        | 'rallar.browser.formation.room-status'
        | 'rallar.browser.formation.ready';
    readonly sinceEpochMs: number;
}
```

- [ ] **Step 1: Confirm the run snapshot's event shape** — `control.fetchRun(runId)` returns the
      control server's run snapshot; read `LiveRtcControlClient.RunSnapshot` and the control server's
      event records to find where an agent's diagnostics (topic, payload, `atEpochMs`, agent id) sit.
      `countPeerCreated` and `readFormationDiagnostics` read that list; if the snapshot carries only
      recent events, use the `stats`/`report` retention the matrix's `captureDiagnostics` relies on and
      record the chosen source in the operations file's doc comment.

- [ ] **Step 2: Write the operations file.** `command` and `readiness` issue one control command
      each (`executeOk`) under `${prefix}-formation-${name}-${suffix}` and decode the result value with
      `decodeFormationSummary(value: unknown)` / `decodeFormationReadiness(value: unknown)` — named
      decoders in this file that check the fields the tests read and fail with the raw value in the
      message otherwise. `health` issues the runtime's `health` command and decodes `formation` and the
      facade-level `rtcStatus` lists. `waitForStage` issues
      `{ kind: 'wait', match: { kind: 'diagnostic', topic: 'rallar.browser.formation.changed', payloadPath: 'data.stage', equals: stage, sinceEpochMs }, timeoutMs }`
      (S2 for the path; the cursor is what keeps a post-reset wait from matching history).
      `countPeerCreated` counts the agent's `rallar.browser.rtc.lifecycle` diagnostics with payload
      `kind: 'peer-created'`. That `health` decoder **fails when `formation` is absent**, with the raw
      value in the message, rather than returning `undefined`: two scenarios assert absence inside the
      block, so a decoder that tolerates a missing block makes them unfalsifiable (settled Q4).
      `reopen` closes the agent's context, reopens it with
      `openLiveRtcBrowserAgent`, and issues `rtc.connect`. The restore is S1's: read `auth.session` out
      of the page with `page.evaluate` BEFORE closing it and pass `{ kind: 'restore', session }`, because
      the harness otherwise re-logs in and mints a new session id, which moves the peer identity the
      accepted layout names. Returns the new agent handle.

- [ ] **Step 3: The policy input** — add `lifecyclePolicy` to `SetupGroupMembershipInput` and
      thread it into `toGroupCreationCommand`, with the driver's current hard-coded literal
      exported WHOLE as `MANUAL_TRIGGER_POLICY` — all four keys, not just the preset and the triggers
      (S6) — so the matrix keeps its behaviour and the acceptance spec names the same literal. Export
      `SetupGroupMembershipInput` in the same edit (S7).

- [ ] **Step 4: Run the existing matrix once** — `npm run test:rallar:full-stack:memory:live-rtc-3`
      — to prove the driver change broke nothing; the Playwright tree has no tsc project, so this run is
      also its type check. Commit — `Add formation operations to the live RTC control client`.

### Task 2.2: The acceptance spec

**Files:**

- Create: `tests/playwright/rallar-black-box/full-stack-live-rtc-lifecycle-acceptance.spec.ts`
- Modify: `package.json` (scripts), `apps/rallar-black-box/src/full-stack-qa-matrix.ts`
- Test: `packages/tests/rallar-black-box/full-stack-qa-matrix.test.ts` (existing; the row is pinned)

- [ ] **Step 1: Scripts, their gate, and the row** — settled Q1: the spec gets its own script pair
      and the matrix scripts stay byte-identical, because `test:rallar:full-stack:memory:live-rtc-3` is
      the producer the RTC-B06 performance observation shells out to, recording that script's exit
      status per attempt, and the workload catalog declares the matrix spec as the case's entire source
      provenance. A second spec inside it would let an acceptance failure redden a performance capture
      and would leave the recorded provenance describing something other than what ran. So add
      `test:rallar:full-stack:memory:live-rtc-3:lifecycle` and
      `test:rallar:full-stack:postgres:live-rtc-3:lifecycle` with the same environment as their matrix
      siblings and the new spec path, plus the `test:e2e:rallar-black-box:full-stack:*` aliases the
      matrix has. Then **widen `packages/tests/rallar-black-box/live-rtc-three-browser-script-gates.test.ts`**:
      its `it.each` table hard-codes the two matrix script names and asserts a single hard-coded spec
      path, so the new scripts are otherwise unpinned — and an unpinned agent-credential default makes
      the whole acceptance suite self-skip and still exit `0`. Parameterize the table over script and
      spec and add both new rows. Two things this step is **not**: the QA-matrix row carries no script
      (`FullStackQaCase` has `testFile` and a free-text `skipGate` only), and the new spec file is
      already discovered by `playwright.full-stack.config.ts`'s `testDir` plus
      `testMatch: /full-stack-.*\.spec\.ts/`, so it also joins the unfiltered `test:rallar:full-stack`
      scripts and is inert there only because of the `RALLAR_BLACK_BOX_LIVE_RTC_MATRIX` gate. Record in
      the commit message that `apps/rallar-black-box/src/live-rtc-three-browser-coverage.ts`, the
      percentage-based second coverage registry, is deliberately left alone. Add the QA matrix row in the existing `rtc` area (`FullStackQaArea` is a closed union
      mirrored by the `AREAS` array; a new area would need both widened): `id: 'rtc-lifecycle-acceptance'`,
      `area: 'rtc'`, `intent: 'Three browsers pin the formation lifecycle acceptance scenarios: held
dials, member progress, the readiness barrier, reset teardown and reset hydration.'`,
      `polarity: 'cross-check'`, `testFile: 'full-stack-live-rtc-lifecycle-acceptance.spec.ts'`,
      `skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1'`, the five
      scenario names in `evidence`, `liveProvider: true`; make `full-stack-qa-matrix.test.ts` pass.

- [ ] **Step 2: The spec** mirrors the matrix's setup (the same env gates and `test.skip` message,
      `LiveRtcControlClient`, `openAgentTrio`, `retireAgents`, diagnostics capture) with one `test` per
      row of "The scenarios as executable statements", each written from the row verbatim. The first:

```ts
test(
    'holds every dial while a managed lobby discovers itself, then dials on connect',
    async ({ browser, request }, testInfo) => {
        test.setTimeout(180_000);
        const agents = await openAgents('discovery');
        await deliveryOperations.setupGroupMembership({
            ...membership,
            lifecyclePolicy: MANUAL_TRIGGER_POLICY
        });
        for (const agent of agents) {
            await control.executeOk(agent, rtcConnectWithoutReadiness(agent));
        }
        await holdFor(5_000);
        for (const agent of agents) {
            expect(await formation.countPeerCreated({ ...ids, agent })).toBe(0);
            const health = await formation.health({ ...ids, agent });
            expect(health.formation).toMatchObject({ stage: 'forming', dialing: 'none' });
        }

        await formation.command({ ...ids, agent: agents[0], input: { command: 'plan' } });
        await formation.command({ ...ids, agent: agents[0], input: { command: 'connect' } });
        await Promise.all(agents.map((agent) => formation.readiness({ ...ids, agent })));
        for (const agent of agents) {
            expect(await formation.countPeerCreated({ ...ids, agent })).toBeGreaterThanOrEqual(1);
        }
    }
);
```

`rtcConnectWithoutReadiness(agent)` is the literal `rtc.connect` command the matrix's driver sends,
minus its `readiness` block; `holdFor` is `page.waitForTimeout` on the first agent's page (a plain
timer, not a Playwright expectation). The `member-progress` test reopens C after activation, awaits
its readiness, reads its `rallar.browser.formation.room-status` diagnostics since the reopen and
checks them with a pure `validateProgressSeries(samples): readonly ProgressSeriesIssue[]` in the
spec file, asserted `toEqual([])`; the `status-on-connect` test reopens B, awaits its readiness and
compares the three timestamps and the three agents' `accepted.identity`; the reset test issues
`reset` from A, waits `dormant` on all three, asserts the empty facade-level lanes and the absent
layouts, holds 5 s and compares the per-agent `peer-created` counts, reopens C for the hydration
statement (first `health` before any refresh, then `refreshLiveRtcBrowserRoom`, then `health`
again), then `start`, `plan`, `connect` and readiness on all three as the positive control.

- [ ] **Step 3: Run locally** — `npm run test:rallar:full-stack:memory:live-rtc-3:lifecycle`. The
      first run calibrates the readiness and wait budgets against the in-memory API; a scenario that fails
      is diagnosed with the diagnostics artifact before any budget moves, and a budget that must move is
      recorded in the spec beside the number with the measured figure.

- [ ] **Step 4: Commit** — `Pin the browser acceptance scenarios in a live RTC lifecycle spec`.

### Task 2.3: Documentation closure

- [ ] Update the five coverage table rows to name the spec and its test titles, update the "N
      scenarios are unpinned" paragraph (the documentation test checks the count against the table; after
      this slice only `pacing-sweep` remains, and the `apply-landing` residue sentence stays) and the
      `reset-tears-down` / `reset-no-stale-hydration` wording that referred to the distributed lane, and
      describe the lifecycle spec in the lanes paragraph of "Recipes and profiles". Run
      `npx vitest run packages/tests/repo/rallar-group-documentation.test.ts`.
- [ ] `playground/rtc-design/README.md`: this plan's row reads as landed.
- [ ] Slice closure as in Task 1.3, plus the spec's own gate command in the PR body.

---

## Repairs before slice 2

The same mapping pass read the Playwright harness before slice 2 was written. The plan's slice 1
repairs are above; these are its slice 2 ones, and four of them change what the tasks build.

| #   | What the plan said                                                                                                                                 | What the code says                                                                                                                                                                                                                                                                                                                    | Where the repair landed                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `reopen` opens the agent again "with the restored session".                                                                                        | Nothing reads a live page's session back out, and both live scripts supply a username and password, so `resolveLiveRtcBrowserAgentAuth` returns `kind: 'login'`. Reopening re-logs in and mints a new session id, which changes the peer identity the accepted layout names.                                                          | Task 2.1 Step 2: `reopen` reads `auth.session` out of the page before closing it and passes `{ kind: 'restore', session }`, the pattern `full-stack-auth-multi-session.spec.ts` already uses. |
| S2  | `waitForStage` matches `payloadPath: 'stage'`.                                                                                                     | The matcher resolves the path against the event's `payload`, and the controller emits the summary under `data`. The shipped precedent is `payloadPath: 'data.topic'`.                                                                                                                                                                 | Task 2.1 Step 2 and the `reset-tears-down` row: the path is `data.stage`.                                                                                                                     |
| S3  | The operations file sends `input: { command: 'plan' }` and `command()` returns a summary.                                                          | On the wire the command is flat — `command`, `layout`, `landing` and `reason` sit directly on it, and the bridge lifts them — and `formation.command` resolves to `{ receipt, formation }`.                                                                                                                                           | Task 2.1: the operations file flattens before sending and unwraps `.formation` after.                                                                                                         |
| S4  | Recorded diagnostics come from the run snapshot, with `captureDiagnostics` as the fallback.                                                        | The control service keeps a newest-first tail of 2 000 events across all agents in a run, so a long three-browser test can evict the early dial events two scenarios count; and `captureDiagnostics` relies on no retention at all, since it issues `health` and decodes the result. The durable source is the run's artifact bundle. | Task 2.1 Step 1: read the snapshot, and fall back to the artifact bundle's `events.jsonl` rather than to `captureDiagnostics`.                                                                |
| S5  | `rtcConnectWithoutReadiness` is the driver's connect "minus its `readiness` block".                                                                | The driver's connect carries no readiness block; the field exists only on the type. The matrix's readiness comes from the client's own refresh-and-health poll.                                                                                                                                                                       | Task 2.2 Step 2: the helper is a straight copy, with nothing removed.                                                                                                                         |
| S6  | The membership policy is "`preset: 'managed'`, both triggers manual".                                                                              | The literal carries four keys: the preset, `admission`, `activation` and `establishment`. Extracting only the two named parts would change the matrix's admission and activation behaviour.                                                                                                                                           | Task 2.1 Step 3 and P8: `MANUAL_TRIGGER_POLICY` is the whole literal.                                                                                                                         |
| S7  | The spec names `SetupGroupMembershipInput` and reuses `openAgentTrio`, `retireAgents` and `runGroupFormation`.                                     | The first is module-private, the next two are spec-private closures, and the last does not exist — the driver member is `run`.                                                                                                                                                                                                        | Task 2.1 Step 3 exports the input type; Task 2.2 Step 2 lifts the two helpers rather than importing them.                                                                                     |
| S8  | `readFormationDiagnostics` and `countPeerCreated` take the driver's control port.                                                                  | `LiveRtcControlPort` has no `fetchRun`, and the snapshot decoder drops the envelope's own `atEpochMs`; topic and timestamp survive inside `payload`.                                                                                                                                                                                  | Task 2.1: the operations take the concrete client and read `payload.topic` and `payload.atEpochMs`.                                                                                           |
| S9  | The member-progress samples carry `desiredPeerIds`, `readyPeerIds` and `groupRevision` at the top level, and `health` reports `rtcStatus`.         | On the room-status diagnostic they sit at `data.room.*` and `data.groupRevision`. The summary's own projection is named `room`; `rtcStatus` is the separate facade-level block on `health`.                                                                                                                                           | P4 and the `member-progress` row.                                                                                                                                                             |
| S10 | Task 2.2 adds "the `test:e2e:*` aliases the matrix has" and gives both scripts "the same environment as their matrix siblings".                    | The matrix has three aliases and no memory `:all`, so exactly two are needed and the Postgres one lives in the `real:` namespace. The two siblings do not share an environment: each sets variables the other omits.                                                                                                                  | Task 2.2 Step 1: two aliases, each script copying its own sibling.                                                                                                                            |
| S11 | Task 2.3 updates the "N scenarios are unpinned" paragraph.                                                                                         | The documentation test matches a literal regex, and after slice 2 the count reaches one, so the sentence has to read `**1 scenarios are unpinned**` or the regex has to be widened.                                                                                                                                                   | Task 2.3, which widens the regex rather than shipping the ungrammatical sentence.                                                                                                             |
| S12 | Task 2.2 says to "make `full-stack-qa-matrix.test.ts` pass" and Task 2.2 Step 1 leaves the second coverage registry alone with only a commit note. | That suite asserts coverage percentages only, so a well-formed row needs no test edit and a wrong `testFile` would go undetected. The second registry's test pins its optional-id list exactly, so adding a row there reddens it.                                                                                                     | Task 2.2 Step 1, which now says why the second registry must not gain a row.                                                                                                                  |
| S13 | Task 2.3 runs the documentation test after the edit.                                                                                               | That test resolves citations against the tracked file list, so a new spec cited before it is staged fails on an unresolved citation.                                                                                                                                                                                                  | Task 2.3: stage the spec before running it.                                                                                                                                                   |

## What running slice 2 established

Slice 2's spec was run against three real browsers before it was finished, and the runs answered
questions no reading of the code had settled. `discovery-holds-dials` passes end to end in about
thirty-five seconds; the four scenarios that follow are not yet green. Each item below cost a run,
so it is recorded whether or not the scenario it belongs to is finished.

| #  | What the runs showed                                                                                                                                                                                                                                                                                                                             | Consequence                                                                                                                                                                                                                             |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 | `formation.readiness` cannot resolve before activation. The room's transport state is derived from the ACCEPTED layout, which only the promotion at `activate` creates, so a room in `connecting` reads `idle` and the barrier never fires.                                                                                                      | The plan's scenario table used readiness as the positive control after `connect` in two scenarios. Those controls now assert the dial count instead, which is what they actually claim. Readiness is used only against an active group. |
| L2 | A `connect` issued straight after `plan` is refused for naming no planned layout. The receipt does not mean the layout exists; the topology worker publishes it.                                                                                                                                                                                 | Every connect retries on exactly that refusal, which is what the quickstart tells an application to do. The first passing run had merely won the race.                                                                                  |
| L3 | The browser's own cached planned slot is not a usable gate for that race. It arrives on its own schedule, and the manager agent that issues the commands may never hold it.                                                                                                                                                                      | The retry is on the refusal, not on a poll of the browser's view.                                                                                                                                                                       |
| L4 | Planning before presence has propagated yields a cycle with nothing to publish, and the group then never gains a planned layout at all.                                                                                                                                                                                                          | The activation path settles presence before planning. This is a product-level caution, not only a test one: an application that plans the moment its members arrive can strand its own group.                                           |
| L5 | A member that reopens returns to a mesh whose surviving peers still hold the lane it left with, and nothing dials it until they look again.                                                                                                                                                                                                      | The two survivors are refreshed after a reopen. The reopened agent is never refreshed, because it is the observer whose own fence the pin is reading.                                                                                   |
| L6 | A command's `timeoutMs` served as both the adapter's deadline and the in-browser wait's budget, so they expired together and the adapter's generic timeout replaced the wait's diagnosis.                                                                                                                                                        | The in-browser wait now expires first by a margin, and reports which state the room was in. Every readiness timeout was previously undiagnosable.                                                                                       |
| L7 | **Open.** After a reopen with a restored session, the returning page holds no room at all: `rooms.formation(room).status()` is undefined for the full wait, so readiness fails with "no room held" rather than with a state. A freshly opened agent that runs the same `rtc.connect` does hold the room, so the difference is the reopen itself. | This blocks `member-progress`, `status-on-connect` and `reset-no-stale-hydration`. It is the next thing to settle, and it may be a finding about the runtime rather than about the spec.                                                |

## Questions settled in review (2026-09-06)

All five were settled with the maintainer on 2026-09-06, after each was researched against the
repository and then adversarially challenged. Q1 through Q4 took the recommended answer; Q5 did not.
The table keeps each question beside the alternatives it was decided against, because that record is
the only durable explanation of why the code will look as it does. Where the round corrected a claim
the first draft made, the correction is folded into the section that carried it and named here.

| #  | Question and alternatives                                                                                                                                                                                                                                                                                                                                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 | Whether the new spec runs under `test:rallar:full-stack:memory:live-rtc-3` (the matrix script widened to both files) or under its own script. Also weighed: a memory-only script deferring the Postgres sibling, and Playwright's own `--grep`, which already gives per-spec addressability, so "separate script or no addressability" was a false dichotomy. | **Its own script pair**, memory and Postgres, wired into the same `test:e2e:*` aliases, with the matrix scripts left byte-identical. The reason is not duration or CI cost: the first draft's "six minutes" was a `test.setTimeout` ceiling whose only recorded measurement is 33.5 s, and no workflow runs any live-RTC script, so neither option costs a CI minute. It is that `test:rallar:full-stack:memory:live-rtc-3` is the producer the RTC-B06 performance observation shells out to, recording that script's exit status per attempt, while the workload catalog declares the matrix spec as the case's entire source provenance. A second spec inside it would let an acceptance failure redden a performance capture and leave the recorded provenance describing something other than what ran. Task 2.2 Step 1 carries the consequence the draft missed: the new scripts must join the `it.each` table of `live-rtc-three-browser-script-gates.test.ts`, or a dropped credential default makes the whole suite self-skip and still exit `0`.                                                                                                                                                                                                     |
| Q2 | Whether a `reset-tears-down` Hetzner manifest is added to the supported matrix now, as a follow-up, or not at all. Also weighed: building it into the extended order as a dispatch-only manifest, with no recurring cost.                                                                                                                                     | **A follow-up, and not gated on what the draft said.** The Q2 cell claimed the fleet must first gain a reopen command; `reset-tears-down` needs no reopen, only `reset-no-stale-hydration` does, and reopen is structural rather than a missing registry entry, which P7 now states. The real reasons to defer are cost and fidelity. Cost is measured rather than estimated: the five current matrix entries took 81 to 99 seconds of job time each, serialized, on the check that gates plan completion. Fidelity decides it: the fleet's API is a single in-memory api-v1 behind Caddy, not a deployed multi-isolate service, and the supported workflow writes one shared credential, so three fleet agents are three sessions of one principal and the manager-and-member split this scenario needs is never exercised. What the fleet would add is public TLS and WSS; real TURN cannot be counted, since the deployment permits its secrets to be unset. Preconditions for taking it up: per-agent principals, a `managed` lifecycle policy on the ensure-group step (possible, because each run is materialized into a fresh isolated group), and a fleet API worth pinning against.                                                                   |
| Q3 | Whether `formation.readiness` stays a distinct command or becomes a `readiness.mode: 'room'` option on `rtc.connect`. Also weighed: dropping the command and matching the room-status diagnostic with the generic `wait` primitive.                                                                                                                           | **A distinct command, keeping its name, respecified as a passive poll.** The command-or-field half is settled by function, not taste: readiness runs only inside `rtc.connect` after the connect resolves, and two of the four barrier uses happen while the agent is already connected, so the field shape would force a second `rtc.connect` — allowed, not reused — which re-runs the join, restarts the hydration being measured, and briefly doubles the RTC lifecycle subscription; a no-refresh mode under that field would also falsify both static analyses in `rtc-readiness-warnings.ts`. The open half was how the command waits, and the draft's `rallar.rtc.waitForRoom(room)` was wrong for a barrier: its `connect` option defaults to `true`, so the measurement would open lanes itself. P6 and Task 1.1 now specify a poll of the room-status projection to `state === 'open'`, the same condition, which dials nothing and is correct whether or not a layout exists when the command is issued. Independent of this answer, P5 gains the `wait` since-cursor every post-reset wait needs.                                                                                                                                                 |
| Q4 | Whether the `health.formation` block is present whenever a room is configured, or opt-in through a `health` input flag. Also weighed: gating it at the four internal callers, invisible to recipes, and keeping the projection off `health` entirely.                                                                                                         | **Always present, with two guards the draft left implicit.** The flag was rejected on cost, not principle: a result-only block churns no schema, capability, corpus or upgrade note, because the compatibility corpus pins command shapes and not results, while the flag costs eight edit sites, two test files and a documented upgrade note. The hazard the question anticipated does not exist, since the three underlying reads all swallow the "Repository not found" error — but a real one it never named does: `health()` runs inside the `rtc.connect` readiness poll and on `{{rtcReadyPeers}}` resolution, so an uncaught throw there would surface as an RTC failure in every existing recipe. Hence guard one, the reader passes the resolved `GroupRef` object and never a room-id string, which makes the only throwing path unreachable. Guard two answers the reviewer: two scenarios assert that fields are absent, so Task 2.1's `health` decoder must fail when the block itself is missing, or those pins are unfalsifiable. Two supporting claims in the draft were also wrong and are struck: `member-progress` reads no `health` at all, and no JSON recipe here issues `health`, so "one more thing a recipe forgets" did not apply. |
| Q5 | Whether slice 1 lands before the matrix owner reviews slice 2's spec, or the plan waits for one review of both. Also weighed: stacking slice 2 on slice 1's open pull request, as the preceding sibling plan did.                                                                                                                                             | **Neither: one pull request carrying both slices as two commits, reviewed once and squashed once — the draft's recommended answer did not survive.** Slice 1's tests drive a facade test double, so the first evidence that the two command kinds have the right shape is slice 2's browser run. Merging slice 1 first would publish a versioned protocol surface before that evidence exists and turn any correction into a breaking change carrying a mandated upgrade note and a deliberate edit to a corpus a stability test governs. Two separate merges also buy two default-branch fleet runs, because slice 2 edits the root `package.json`, itself a risk path — a row the validation summary had marked as not applying. Stacking was the runner-up and stays available if the spec should be read as its own diff; it changes merge topology rather than the number of diffs reviewed, and its only clean saving is the single fleet run this answer already gets.                                                                                                                                                                                                                                                                                  |

## Repairs before slice 1

A mapping pass read every file slice 1 touches before any of it was written, and the plan did not
survive contact with three of them. Each repair is folded into the section that carried the mistake;
this list is the index, so a reader who remembers the merged text can find what moved.

| #   | What the plan said                                                                                               | What the code says                                                                                                                                                                                                                                      | Where the repair landed                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The readiness barrier waits for the room status to read `'open'`.                                                | `resolveRtcRoomTransportState` returns `'open'` when `desiredPeerCount === 0                                                                                                                                                                            |                                                                                                                                                                     |
| R2  | The poll subscribes through `rtc.onStatus`.                                                                      | `onStatus` is fed only by peer lifecycle and lane callbacks; it never fires on a snapshot or overlay-slot change, which is what supplies the accepted layout the barrier waits for.                                                                     | P6 and Task 1.1 Step 7: the poll wakes on `formation.onChange` as well.                                                                                             |
| R3  | The controller depends on `BlackBoxRallarRuntimeDiagnosticsPort`.                                                | No such type exists anywhere in the repository; the sibling controllers take `emit` and `emitError` individually.                                                                                                                                       | Task 1.1 Step 7's dependency block.                                                                                                                                 |
| R4  | The controller depends on a `stateStore` seam for the causal revision, and Step 8 widens only `rooms` and `rtc`. | `RallarRoomFormationStatus` carries the revision at `snapshot.causalRevision`, already in hand.                                                                                                                                                         | Task 1.1 Step 7: the seam is gone; the summary lifts the revision from the snapshot.                                                                                |
| R5  | The summary's absent-capable fields are "the status's own" optionals.                                            | They are required-with-`undefined` on the status, so a spread carries explicit `undefined` keys into the block the `exists` operator reads.                                                                                                             | Task 1.1 Step 7: the summary is built field by field, not spread.                                                                                                   |
| R6  | The diagnostics are torn down "where that subscription is torn down".                                            | The teardown is four sites, and one of them increments a counter `runtime-lifecycle.test.ts` asserts as `3` — which stays `3` there, because that connection names a bare room id and resolves no room ref, so the room-scoped stream installs nothing. | Task 1.1 Step 8, which now names all four and the moved assertion.                                                                                                  |
| R7  | The health reader attaches the block itself.                                                                     | The reader holds no controller and does not import the room-ref resolver; `crdt` and `director` reach it through `BlackBoxRallarHealthReader.Read`.                                                                                                     | Task 1.1 Step 8: the block rides the `Read` input.                                                                                                                  |
| R8  | The decoder follows `decode-black-box-rallar-crdt-input.ts` and returns an `Either`.                             | That sibling throws `TypeError`, and no file in the directory imports `Either`.                                                                                                                                                                         | Global Constraints: the formation decoder returns an `Either` per the code standard and is the first in the directory; converting the five siblings is a follow-up. |
| R9  | `landing` is required on `reconfigure`.                                                                          | The shipped handle declares it optional, where absent means the stored policy's landing.                                                                                                                                                                | Task 1.1 Step 1 and Step 4.                                                                                                                                         |
| R10 | Step 3 reuses "the room identity check `rtc.connect` runs".                                                      | `validateRtcCommand` treats every room field as independently optional with no cross-field rule, so an `rtc.connect` naming no room validates today.                                                                                                    | Task 1.2 Step 3: the rule is written, not reused.                                                                                                                   |
| R11 | The adapter decodes the command input.                                                                           | `browser-adapter.ts` imports nothing from the black-box runner package; decoding there would be the first such import and would move the boundary the headless bundle test pins.                                                                        | Task 1.2 Step 4: the decode runs at the bridge and the seam stays `unknown`-shaped.                                                                                 |
| R12 | The since-cursor is "one field plus one comparison" at one call site.                                            | `wait-for-event.ts` has three call sites, `findWaitEvent` returns the newest match so the cursor must filter the list, and three further gates refuse an unknown field.                                                                                 | P5.                                                                                                                                                                 |
| R13 | Nothing refreshes the room on the observing agent.                                                               | `formation.command` with `connect` reads the room through on an incoherent fence and again on a stale-epoch refusal.                                                                                                                                    | P6: only agents that never issue `connect` are clean observers.                                                                                                     |
| R14 | The workspace default is applied by the connection-config decoder.                                               | It lives in `blackBoxRallarRoomRefOf` in the browser runtime; the control protocol applies no default.                                                                                                                                                  | Global Constraints.                                                                                                                                                 |

Two facts found in the same pass are recorded without a repair, because they constrain use rather
than code. A readiness issued on a paused room runs to its timeout, since `'halted'` is resolved
before every other branch. And the layouts carried in the block bring `createdAtEpochMs`,
`updatedAtEpochMs` and `overlayVersion` with them, which no pin may assert on for the same reason as
the room block's read-time clock.

## Validation summary

| Gate                                                                                                                                                         | Slice 1 | Slice 2 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------- |
| Focused Vitest (`packages/tests/shared-test`, `packages/tests/rallar-black-box`, the headless boundary test)                                                 | yes     | yes     |
| `npm run typecheck` (includes `typecheck:tests`)                                                                                                             | yes     | yes     |
| `npm run check:repo-style:changed -- origin/main HEAD`, `node scripts/check-test-structure-coupling.mjs --changed`                                           | yes     | yes     |
| `npm run format:check`, `npm run test:repo-governance`                                                                                                       | yes     | yes     |
| `npm run test:unit`, `npm run build`                                                                                                                         | yes     | yes     |
| `npm run test:rallar:full-stack:memory:live-rtc-3` (the existing matrix, unchanged)                                                                          | —       | yes     |
| `npm run test:rallar:full-stack:memory:live-rtc-3:lifecycle` (new)                                                                                           | —       | yes     |
| Group documentation test (`packages/tests/repo/rallar-group-documentation.test.ts`)                                                                          | —       | yes     |
| Branch Release Gate (CI) on the final feature-branch commit                                                                                                  | yes     | yes     |
| Run Hetzner Supported Distributed Manifests on the default-branch commit (both slices touch risk paths; settled Q5 gives `main` one commit, so it runs once) | yes     | yes     |
| `npm run pr:delivery -- status` before broad validation, `-- ready` once at handoff                                                                          | yes     | yes     |

Not required by this plan: medium-scale, state-write, topology-replay and formation-large. No
mutation path, OpenAPI block or server behaviour changes; no api-v1 recipe changes.

## Not in this plan

- A Hetzner lifecycle manifest (settled Q2): the fleet lane could pin `reset-tears-down` only, since
  control agents cannot reopen, but it is deferred on cost and fidelity rather than on that
  limitation. The fleet's API is a single in-memory api-v1 and its three agents share one credential,
  so the pin would be weaker than the local lane everywhere except public TLS and WSS. The live
  three-browser lane is the product plan's "live-RTC"; Q2 records the preconditions for revisiting.
- `pacing-sweep` (the headless parallelism sweep over `maxConcurrentEdgeSetups`), which is a
  performance harness, not an acceptance pin, and belongs with the RTC benchmark workstream.
- `apply-landing`'s restart-convergence leg, which needs a server restart inside a recipe run and is
  recorded in the coverage table as honest residue.
- A `formation` operator panel in the black-box SPA: no pin uses the SPA's direct operations, and
  the panel would be a fourth path to the same facade.
- Typed WS NACK reasons and the other items the architecture document lists as deliberately not
  built.
- Converting the runtime directory's five existing `decode-*` decoders from `throw new TypeError` to
  `Either` (R8). The formation decoder follows the code standard on its own; bringing the siblings
  with it touches every one of their callers and belongs in its own change.
