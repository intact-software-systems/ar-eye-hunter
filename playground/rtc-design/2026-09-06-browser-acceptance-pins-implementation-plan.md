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
transport; the SPA's operator panels are untouched.

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

Status: **planned, not started.** Written 2026-09-06 against `main` @ `9b3bea7e0`, with the stale-epoch
conflict PR #533 and the connect-fence recipe PR #535 open; nothing here depends on either. Amended
the same day after a max-effort review of the first draft (the review moved the read side onto the
runtime's evidence roots, corrected the RTC status source to `rtc.roomStatus`, rewrote the scenario
windows, and took the Hetzner manifest out of scope). The plan owner is whoever owns the
three-browser matrix (settled Q8); the review questions at the end are the decisions that owner
takes before slice 1 starts.

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
- A `formation.*` command names its room the way `rtc.connect` does (an exact `roomRef`, or
  `applicationId` plus `roomId` with `workspaceId` defaulting to `default`), decoded by the same
  connection-config decoder.
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
  schema (`schema.ts`: the `COMMAND_SCHEMAS` record behind `RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA`
  and the per-kind `RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` catalogue, which
  `packages/tests/shared-test/rallar-bb-test-schema.test.ts` keeps in lockstep with the kinds, plus
  the golden corpus under `fixtures/schema/v1/`), the agent capability contract
  (`RallarBlackBoxControlAgentCapabilities` in `distributed-run.ts`, built by
  `distributed/control-agent-capabilities.ts` and parsed back by `parseControlAgentCapabilities`,
  which drops fields it does not know), the coordinator's kind check in
  `distributed-run-monitor.ts`, and `docs/schema-and-capabilities.md`.
  `black-box-runner-adapter.ts` is the black-box-runner's RTC client shim (`rtc.connect`,
  `rtc.send`, `close` only) and takes no per-kind dispatch.
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
- Commits are plain imperative sentence-case subjects, no prefix, no trailers, on a
  `codex/browser-acceptance-pins` branch per slice; nothing lands on `main` without the `AGENTS.md`
  per-operation approval.
- No REST behaviour changes and no mutation-path changes: the medium-scale and state-write gates are
  not local requirements. The distributed-risk selection
  (`scripts/distributed-validation-risk/distributed-validation-risk.mjs`) treats
  `packages/shared-test/rallar-bb-test` and `packages/shared-test/black-box-runner/browser` as
  risk paths, so slice 1 triggers Run Hetzner Supported Distributed Manifests on the default-branch
  commit; that run is part of the slice's completion evidence.

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

| #  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 | **The pins drive the shipped browser handle, not HTTP.** Every scenario here is about what the browser does — dials, readiness, the local fraction, hydration after reset. Driving the server routes from the agent would observe the server twice and the browser never. So the agents get a `formation` controller that calls `rallar.rooms.formation(room)`, and the recipes read the runtime's evidence about it.                                                                                                                                                                                                                                                                                        |
| P2 | **Two write-side commands, and the read side is evidence the runtime already records.** `formation.command` issues one of the eight commands; `formation.readiness` awaits the browser's own room readiness. Everything else reuses primitives: presence without readiness is `rtc.connect` with no `readiness` block (the adapter skips the wait when the block is absent); the status projection rides on `health`; stage changes, layout events and the room transport status are diagnostics that `wait`, `assert` and the run snapshot expose. _Rejected:_ `formation.attach`, `formation.status`, `formation.wait` and `formation.progress` as commands — each duplicated a primitive or a diagnostic. |
| P3 | **Evidence is the status projection, verbatim.** The `health` block and the change diagnostic carry `RallarRoomFormationStatus` minus `snapshot`, with `causalRevision` lifted from it, plus the `rtc` member of `rallar.rtc.roomStatus(room)` (`RallarRtcRoomTransportStatus`: `state`, `acceptedLayoutIdentity`, `desiredPeerIds`, `readyPeerIds`, `activePeerIds`, `failedPeerIds`). Absent values stay absent; nothing is derived for the recipe.                                                                                                                                                                                                                                                        |
| P4 | **The member-progress series is the recorded `rallar.browser.formation.room-status` diagnostics of a member that reopens against an active group.** Hydration delivers the accepted layout first (`desiredPeerIds` full, `readyPeerIds` empty), then lanes open while no group write happens, which is the window decision 40 describes; the test computes `ready / desired` per sample and asserts monotonicity within one `acceptedLayoutIdentity`, the end value `1`, and an unchanged `groupRevision` across the increases.                                                                                                                                                                              |
| P5 | **Dials are counted, not waited on.** The dial witness is the existing `rallar.browser.rtc.lifecycle` diagnostic with payload `kind: 'peer-created'`. Holding a lobby proves zero such events over a window on an agent that has never dialed; teardown after `reset` proves the per-agent count unchanged over a window, because the buffer already holds the pre-reset dials and `wait` `absent: true` would violate on them by design.                                                                                                                                                                                                                                                                    |
| P6 | **The readiness barrier is observed by the browser itself, in one command.** `formation.readiness` awaits `rallar.rtc.waitForRoom(room)` and, in the same tick it resolves, captures the `health` block and emits `rallar.browser.formation.ready`. The harness never calls `refreshRoom` on that agent (the client's `waitForPeerReadiness` does, which is why it cannot be the observer), so the ordering of `ready` after the change diagnostic that carried the accepted layout and after the `layoutAccepted` diagnostic is the browser's fence, not the test's point read. _Rejected:_ injecting a stale accepted layout from the test — it tests the fixture.                                         |
| P7 | **Both reset scenarios are pinned in the live three-browser lane; the Hetzner lane is out of scope.** Control agents are long-lived pages with no reopen command, so a manifest cannot express `reset-no-stale-hydration` at all, and the product plan's "live-RTC" is the Playwright lane. A `reset-tears-down` manifest for the fleet is a separate decision (Q2).                                                                                                                                                                                                                                                                                                                                         |
| P8 | **Every scenario's group is `preset: 'managed'` with both triggers manual** (the literal the driver already hard-codes), which is the phased family the product plan means by a "`phased` group" holding in `forming`: the repository memory `phased-group-triggers-behavioural-in-recipes` records that a `managed` group with the default `immediate` connect trigger dials itself on publication, so the manual connect trigger is what keeps the lobby and every later `connect` under the test's control.                                                                                                                                                                                               |

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

| Scenario                   | Executable statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery-holds-dials`    | Three agents connect (no readiness) to a `managed` group with both triggers manual, holding in `forming`: after a 5 s hold every agent's `peer-created` count is `0` and its `health.formation.status` reads `stage: 'forming'`, `dialing: 'none'`; then the manager's `plan` and `connect` followed by `formation.readiness` on all three make every agent's `peer-created` count at least `1` — the positive control for the hold.                                                                                                                                                                                                   |
| `member-progress`          | After activation, agent C reopens; its `rallar.browser.formation.room-status` diagnostics from the reopen to its `formation.readiness`: samples with `desiredPeerIds` empty carry no fraction (the pre-hydration ones), every later sample carries the same `acceptedLayoutIdentity`, the fraction `readyPeerIds.length / desiredPeerIds.length` never decreases, the last is `1`, and the `groupRevision` stamped on the samples is the same from the first `desiredPeerIds`-full sample to the last.                                                                                                                                 |
| `status-on-connect`        | After activation, agent B reopens and runs `formation.readiness`: the `rallar.browser.formation.ready` diagnostic's `atEpochMs` is at or after the `atEpochMs` of B's last `rallar.browser.formation.changed` diagnostic carrying `accepted.identity` and of its `rallar.browser.formation.layout` diagnostic with `kind: 'layoutAccepted'`; the captured block reads `stage: 'active'`, `accepted.identity` equal to `room.acceptedLayoutIdentity`, and equal to the `accepted.identity` agents A and C report on `health`.                                                                                                           |
| `reset-tears-down`         | After the manager's `reset` on the active group, every agent's `wait` for a `rallar.browser.formation.changed` diagnostic with `payloadPath: 'stage'`, `equals: 'dormant'` resolves; its `health` then reads `rtcStatus.activePeerIds`, `knownPeerIds` and `readyPeerIds` empty (the facade-level lanes, which the room block would report empty by construction), `formation.status.dialing: 'none'`, `accepted` and `planned` absent; each agent's `peer-created` count is unchanged over a 5 s hold; the manager's `start`, `plan`, `connect` and `formation.readiness` on all three then raise every count — the positive control. |
| `reset-no-stale-hydration` | After the reset and before `start`, agent C reopens: its first `health` after `rtc.connect` (hydration only, no refresh) reads `formation.status.stage: 'dormant'`, `planned` absent, `accepted` absent, `coverageRate` absent, and `rtcStatus.readyPeerIds` empty; a `refreshRoom` (`refreshLiveRtcBrowserRoom`) followed by a second `health` reads the same values.                                                                                                                                                                                                                                                                 |

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

- [ ] **Step 1: Declare the contracts** in `black-box-rallar-operation-contracts.ts`:

```ts
export interface BlackBoxRallarFormationRoomInput {
    readonly roomRef: GroupRef;
    readonly timeoutMs: number;
}

export type BlackBoxRallarFormationCommandInput =
    | Readonly<{ command: 'connect'; layout?: GroupLayoutIdentity; }>
    | Readonly<{ command: 'reconfigure'; landing: GroupTopologyReconfigureLanding; }>
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

- [ ] **Step 2: Write the failing decoder test** in `formation.test.ts`:

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

- [ ] **Step 3: Run the test** — `npx vitest run packages/tests/shared-test/rallar-browser-runtime/formation.test.ts`. Expected: FAIL, the decoder does not exist.

- [ ] **Step 4: Write `decode-black-box-rallar-formation-input.ts`** following
      `decode-black-box-rallar-crdt-input.ts`: `decodeBlackBoxRallarFormationCommandInput(value: unknown)`
      returns `Either<readonly BlackBoxRallarFormationInputIssue[], BlackBoxRallarFormationCommandInput>`,
      checks `command` against the eight names, requires `landing` for `reconfigure` and refuses
      `landing` and `layout` on the commands that do not take them, and decodes `layout` with the
      `GroupLayoutIdentity` shape check the connect fence already uses in `packages/shared/api`.

- [ ] **Step 5: Write the failing controller test** (same file), driving a fake
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

- [ ] **Step 6: Run it** — expected: FAIL, `formation-controller.ts` does not exist.

- [ ] **Step 7: Implement `formation-controller.ts`** as a class mirroring `director-controller.ts`:

```ts
export interface BlackBoxRallarFormationControllerDependencies {
    readonly formation: (roomRef: GroupRef) => RallarRoomFormation;
    readonly rtc: Pick<RallarRtcFacade, 'roomStatus' | 'waitForRoom' | 'onStatus'>;
    readonly stateStore: Pick<RallarRoomStateStorePort, 'findGroupSnapshot'>;
    readonly diagnostics: BlackBoxRallarRuntimeDiagnosticsPort;
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
receipt was accepted. `readiness` awaits `rtc.waitForRoom(roomRef, { timeoutMs })`, then captures
`summary(roomRef)` and `now()` before any `await`, emits `rallar.browser.formation.ready` with the
captured record, and returns it; a `waitForRoom` that resolves without readiness (`status` not
`ready`) fails the command with `RALLAR_BLACK_BOX_FORMATION_NOT_READY` carrying the status.
`summary` reads `formation.status()` and `rtc.roomStatus(roomRef).rtc` and translates them with the
pure `toBlackBoxRallarFormationSummary(status, room)`; it returns `undefined` when `status()` is
undefined (the room is not held), and `command`/`readiness` turn that into
`RALLAR_BLACK_BOX_FORMATION_ROOM_NOT_HELD`. `installDiagnostics` subscribes `formation.onChange`
(emit `rallar.browser.formation.changed` with the summary), `formation.onLayout` (emit
`rallar.browser.formation.layout` with `{ kind, identity }`) and `rtc.onStatus` (emit
`rallar.browser.formation.room-status` with the `room` block and the cached snapshot's
`causalRevision.groupRevision` as `groupRevision`), and returns one unsubscribe.

- [ ] **Step 8: Wire it.** Widen the composition's seams: `rooms` gains `formation`
      (`rallar.rooms.formation`) and `rtc` gains `roomStatus`, `waitForRoom` and `onStatus` in
      `BlackBoxBrowserRallarRuntimeDependency` and `toBlackBoxBrowserRuntimeDependency`. Construct the
      controller in `black-box-rallar-runtime.ts`'s `#createProductControllers` beside the director
      controller and expose it from `installation()`; install the diagnostics where `rtc.onLifecycle` is
      installed (line 355) whenever the connection config resolves a room, and tear them down where that
      subscription is torn down; extend `black-box-rallar-health-reader.ts` to attach
      `formation: controller.summary(roomRef)` when a room is configured. Add
      `readonly formation: BlackBoxRallarFormationRuntime` to `BlackBoxRallarRuntime`.

- [ ] **Step 9: Run** `npx vitest run packages/tests/shared-test/rallar-browser-runtime` — expected:
      PASS (the composition and lifecycle tests there cover the new subscription's teardown); then
      `npm run typecheck`.

- [ ] **Step 10: Commit** — `Add the formation controller to the browser black-box Rallar runtime`.

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

- [ ] **Step 1: Write the failing validation tests** in `rallar-bb-test-control-protocol.test.ts`:

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

- [ ] **Step 2: Run** — expected: FAIL (unknown kind).

- [ ] **Step 3: Add the two kinds** to `RALLAR_BLACK_BOX_TEST_COMMAND_KINDS`, the two interfaces
      to the union, and the `case 'formation.command':` /
      `case 'formation.readiness':` branches in `control-protocol.ts` beside `case 'rtc.connect':`
      (`validateKeys` over the allowed keys, `validateStringField` for `command` against the eight names,
      the room identity check `rtc.connect` runs, and `fail('formation.command plan does not take landing.')`
      in the existing message style for the cross-field rules).

- [ ] **Step 4: Dispatch** — the bridge exposes `formation` (one-line delegations to
      `resolveBrowserRallarRuntime()).formation`, failing with
      `browser-rallar provider did not expose formation commands.` like the director resolver), the
      adapter adds the two branches (the `director` family is the template), decoding the command's
      input with `decodeBlackBoxRallarFormationCommandInput` at the adapter boundary and recording the
      `BlackBoxRallarFormationCommandDiagnostics` / `BlackBoxRallarFormationReadinessDiagnostics` as the
      result value. Write the adapter test: a fake runtime whose `formation.command` throws an
      `ApiHttpError` carrying `group-connect-planned-layout-superseded` yields
      `RALLAR_BLACK_BOX_FORMATION_DENIED` with `details.denial.kind === 'layout'`.

- [ ] **Step 5: Publish the schema** — one `COMMAND_SCHEMAS` entry per kind mirroring the
      validation, one `RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` entry per kind (title, required and
      optional fields, `supportedProviderModes` naming `browser-rallar` only, runtime surfaces, live
      service requirements, artifact expectations, an example), and one instance of each kind in the
      golden corpus; `rallar-bb-test-schema.test.ts` must accept both, keep its kinds-versus-catalogue
      lockstep, and reject `formation.command` without `command`.

- [ ] **Step 6: Capabilities** — `RallarBlackBoxControlAgentCapabilities` (`distributed-run.ts`,
      today `{ crdt?, assertions? }`) gains `formation?: { supported: boolean; }`;
      `toControlAgentCapabilities` sets `formation: { supported: providerMode === 'browser-rallar' }` and
      `parseControlAgentCapabilities` rebuilds it (it rebuilds the object field by field, so an
      unlisted field is dropped before the coordinator sees it); `distributed-run-monitor.ts` gains
      `requiresFormationRuntime(recipe)` beside `requiresCrdtRuntime` and the coordinator's capability
      check refuses to target a `formation.*` command at an agent that does not advertise it. Extend the
      monitor test that covers `requiresCrdtRuntime` with the formation twin.

- [ ] **Step 7: Document** the family in `docs/schema-and-capabilities.md` ("Formation Commands":
      the two kinds, their fields, the failure codes, the `health.formation` block) and the four
      diagnostics in `docs/runtime-diagnostic-contract.md` (topic, payload shape, producer).

- [ ] **Step 8: Run** `npx vitest run packages/tests/shared-test packages/tests/rallar-black-box`
      outside the sandbox (three suites bind loopback ports), then `npm run typecheck`. Commit —
      `Add the formation commands to the black-box control protocol`.

### Task 1.3: Slice 1 closure

- [ ] `npm run test:unit`, `npm run build`, `npm run check:repo-style:changed -- origin/main HEAD`,
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`, `npm run format:check`,
      `npm run test:repo-governance` (the schema docs are governed), and
      `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` — the headless agent
      bundles the browser runtime, so the controller moves its budget; raise it per the Q6 convention of
      the browser surface plan (smallest whole KiB above the measurement, recorded beside the budget and
      in the PR).
- [ ] PR with the standard body; `npm run pr:delivery -- status`; the Branch Release Gate on the
      final feature-branch commit and Run Hetzner Supported Distributed Manifests on the resulting
      default-branch commit (the slice touches a distributed-risk path, so the run is not a no-op).

---

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
      `{ kind: 'wait', match: { kind: 'diagnostic', topic: 'rallar.browser.formation.changed', payloadPath: 'stage', equals: stage }, timeoutMs }`.
      `countPeerCreated` counts the agent's `rallar.browser.rtc.lifecycle` diagnostics with payload
      `kind: 'peer-created'`. `reopen` closes the agent's context, reopens it with
      `openLiveRtcBrowserAgent` (restored session), issues `rtc.connect` with no `readiness` block, and
      returns the new agent handle.

- [ ] **Step 3: The policy input** — add `lifecyclePolicy` to `SetupGroupMembershipInput` and
      thread it into `toGroupCreationCommand`, with the driver's current hard-coded literal
      (`preset: 'managed'`, both triggers manual) exported as `MANUAL_TRIGGER_POLICY` so the matrix keeps
      its behaviour and the acceptance spec names the same literal.

- [ ] **Step 4: Run the existing matrix once** — `npm run test:rallar:full-stack:memory:live-rtc-3`
      — to prove the driver change broke nothing; the Playwright tree has no tsc project, so this run is
      also its type check. Commit — `Add formation operations to the live RTC control client`.

### Task 2.2: The acceptance spec

**Files:**

- Create: `tests/playwright/rallar-black-box/full-stack-live-rtc-lifecycle-acceptance.spec.ts`
- Modify: `package.json` (scripts), `apps/rallar-black-box/src/full-stack-qa-matrix.ts`
- Test: `packages/tests/rallar-black-box/full-stack-qa-matrix.test.ts` (existing; the row is pinned)

- [ ] **Step 1: Scripts and the row** — add `test:rallar:full-stack:memory:live-rtc-3:lifecycle`
      and `test:rallar:full-stack:postgres:live-rtc-3:lifecycle` with the same environment as their
      matrix siblings and the new spec path, plus the `test:e2e:rallar-black-box:full-stack:*` aliases the
      matrix has. Add the QA matrix row in the existing `rtc` area (`FullStackQaArea` is a closed union
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

## Questions for review

| #  | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Recommended answer                                                                                                                                                                                                                                   |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 | Whether the new spec runs under `test:rallar:full-stack:memory:live-rtc-3` (the matrix script widened to both files) or under its own script.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Its own script, wired into the same `test:e2e:*` aliases. The matrix spec's default test takes six minutes; keeping the lifecycle spec separately addressable keeps failure attribution clean, and CI's optional live job lists both.                |
| Q2 | Whether a `reset-tears-down` Hetzner manifest (three agents, roughly a minute per distributed-risk push) is added to the supported matrix now, as a follow-up, or not at all. It cannot pin `reset-no-stale-hydration`, since control agents have no reopen command; it would be generated from the catalog in `apps/rallar-black-box/src/hetzner-distributed-manifests.ts` (pinned byte for byte by `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`), issue the single-issuer commands through `targetPolicy.mode: 'role-map'`, and join both the workflow matrix and the preflight list that `packages/tests/repo/distributed-validation-risk/distributed-validation-risk-workflow.test.ts` pins. | A follow-up after slice 2 lands and the fleet lane gains a reopen command; until then the live three-browser lane is the pin, and the coverage table says so.                                                                                        |
| Q3 | Whether `formation.readiness` stays a distinct command or becomes a `readiness.mode: 'room'` option on `rtc.connect`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A distinct command. `rtc.connect`'s readiness is the harness poller that refreshes the room when peers are missing; the barrier pin needs the browser's own `waitForRoom` with no refresh, and mixing the two under one field invites the wrong one. |
| Q4 | Whether the `health.formation` block is present whenever a room is configured (absent only when the room is not held), or opt-in through a `health` input flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Present whenever a room is configured. The block is one in-memory projection; every scenario reads it, and an opt-in flag would be one more thing a recipe forgets.                                                                                  |
| Q5 | Whether slice 1 lands before the three-browser-matrix owner reviews slice 2's spec, or the plan waits for one review of both slices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Land slice 1 first. It is a runtime and protocol change with unit coverage and no scenario; slice 2 is where the owner's judgement is needed and it reads better on top of a merged slice 1.                                                         |

## Validation summary

| Gate                                                                                                               | Slice 1 | Slice 2 |
| ------------------------------------------------------------------------------------------------------------------ | ------- | ------- |
| Focused Vitest (`packages/tests/shared-test`, `packages/tests/rallar-black-box`, the headless boundary test)       | yes     | yes     |
| `npm run typecheck` (includes `typecheck:tests`)                                                                   | yes     | yes     |
| `npm run check:repo-style:changed -- origin/main HEAD`, `node scripts/check-test-structure-coupling.mjs --changed` | yes     | yes     |
| `npm run format:check`, `npm run test:repo-governance`                                                             | yes     | yes     |
| `npm run test:unit`, `npm run build`                                                                               | yes     | yes     |
| `npm run test:rallar:full-stack:memory:live-rtc-3` (the existing matrix, unchanged)                                | —       | yes     |
| `npm run test:rallar:full-stack:memory:live-rtc-3:lifecycle` (new)                                                 | —       | yes     |
| Group documentation test (`packages/tests/repo/rallar-group-documentation.test.ts`)                                | —       | yes     |
| Branch Release Gate (CI) on the final feature-branch commit                                                        | yes     | yes     |
| Run Hetzner Supported Distributed Manifests on the default-branch commit (slice 1 touches a risk path)             | yes     | —       |
| `npm run pr:delivery -- status` before broad validation, `-- ready` once at handoff                                | yes     | yes     |

Not required by this plan: medium-scale, state-write, topology-replay and formation-large. No
mutation path, OpenAPI block or server behaviour changes; no api-v1 recipe changes.

## Not in this plan

- A Hetzner lifecycle manifest (Q2): control agents cannot reopen, so the fleet lane can pin
  `reset-tears-down` only, and the live three-browser lane already is the product plan's
  "live-RTC". Q2 records what adding one takes.
- `pacing-sweep` (the headless parallelism sweep over `maxConcurrentEdgeSetups`), which is a
  performance harness, not an acceptance pin, and belongs with the RTC benchmark workstream.
- `apply-landing`'s restart-convergence leg, which needs a server restart inside a recipe run and is
  recorded in the coverage table as honest residue.
- A `formation` operator panel in the black-box SPA: no pin uses the SPA's direct operations, and
  the panel would be a fourth path to the same facade.
- Typed WS NACK reasons and the other items the architecture document lists as deliberately not
  built.
