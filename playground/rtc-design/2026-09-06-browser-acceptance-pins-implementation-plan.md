# Browser Acceptance Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the five acceptance scenarios of the group-activation product plan that only a real
browser can exercise — `discovery-holds-dials` end to end, `member-progress`'s monotonic fraction,
`status-on-connect`'s readiness barrier, `reset-tears-down` and `reset-no-stale-hydration` — so the
coverage table in `docs/rallar-group-formation-architecture.md` names an executable pin for each.

**Architecture:** The browser agents that the three-browser Playwright matrix and the Hetzner
distributed lane already drive gain one command family, `formation.*`, that speaks to the shipped
`rallar.rooms.formation(room)` handle through the same runtime bridge `rtc.connect` uses. Every pin
is then a recipe of existing and new commands: the local lane runs them as a Playwright spec under
`playwright.full-stack.config.ts` against the in-memory API, the distributed lane runs them as
Hetzner manifests whose coordinator evaluates group assertions over the agents' results. No server
code changes; no new transport; the SPA's operator panels are untouched.

**Tech Stack:** TypeScript under `packages/shared-test` (the `rallar-bb-test` control protocol and
browser adapter, the `black-box-runner/browser` Rallar runtime), Playwright under
`tests/playwright/rallar-black-box/`, JSON manifests under `apps/rallar-black-box/manifests/hetzner/`,
Vitest under `packages/tests/`, dprint formatting.

**Spec:** `playground/rtc-design/2026-08-22-group-activation-product-plan.md` ("The browser
contract", "The observed connectivity status", "Progress and continuous updates", decisions 30 and
40, and the "Named acceptance scenarios" table), read together with the coverage table in
`docs/rallar-group-formation-architecture.md` ("Acceptance scenarios"). The browser surface it
drives is `docs/rallar-api-reference.md` ("Room formation") as delivered by
`2026-09-05-browser-lifecycle-command-surface-implementation-plan.md`; that plan's settled question
Q8 is the mandate for this one.

Status: **planned, not started.** Written 2026-09-06 against `main` @ `9b3bea7e0`, with the stale-epoch
conflict PR #533 and the connect-fence recipe PR #535 open; nothing here depends on either. The
plan owner is whoever owns the three-browser matrix (settled Q8); the review questions at the end
are the decisions that owner takes before slice 1 starts.

## Global Constraints

- The code standard is `.agents/skills/rallar-code-writing/references/repo-code-style.md`; every
  touched file enters touched-file standards closure (see `AGENTS.md`).
- `room` is the browser term, `group-state` the server term. Recipe commands use the browser
  vocabulary (`formation`, `room`); the HTTP steps they sit beside keep the group-state routes.
- `unknown` stays at the boundary: a command result is decoded once in the adapter into a typed
  result record, never carried as `unknown` into an assertion helper.
- Required fields by default. A `formation.*` command names its room the way `rtc.connect` does
  (an exact `roomRef`, or `applicationId` plus `roomId` with `workspaceId` defaulting to `default`).
- At most three positional parameters; `interface` for object contracts, `type` for unions; one
  canonical name per type; kebab-case filenames matching the primary export.
- Comments only for a non-obvious invariant or deliberate tradeoff; none in tests beyond intent.
- Tests live under `packages/tests/**` mirroring the production path. Playwright specs live under
  `tests/playwright/rallar-black-box/` and are catalogued in
  `apps/rallar-black-box/src/full-stack-qa-matrix.ts`, which
  `packages/tests/rallar-black-box/full-stack-qa-matrix.test.ts` pins.
- Every new command kind is added in the same task to the command union
  (`packages/shared-test/rallar-bb-test/types.ts`), the control validation and dispatch
  (`control-protocol.ts`, `browser-adapter.ts`), the published schema
  (`schema.ts`: `RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA`, checked by
  `packages/tests/shared-test/rallar-bb-test-schema.test.ts` and the golden corpus under
  `fixtures/schema/v1/`), the capability metadata (`distributed/control-agent-capabilities.ts`) and
  `docs/schema-and-capabilities.md`. A kind that exists in fewer than all of them is a bug.
- Identifier discipline for browser recipes is the one `2026-09-05-black-box-coverage-plan.md`
  records: every identifier carries `{runId}` (or the Playwright run's `suffix`), request ids are
  20–128 characters, and a recipe is re-runnable against a dirty server.
- Absence claims follow the runtime's rule: a `wait` with `absent: true` holds its whole window and
  is paired with a same-scope positive control in the same test, so a broken transport cannot pass
  as proven absence.
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
  risk paths, so every slice here triggers Run Hetzner Supported Distributed Manifests on the
  default-branch commit; that run is part of each slice's completion evidence.

---

## Design

### What exists and what is missing

| Exists today                                                                                                                                                                                                                                                                              | Missing for the pins                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rallar.rooms.formation(room)`: the eight commands, `status()`, `waitForStage`, `waitForLayout`, `waitForCondition`, `onChange`, `onLayout`, `readView()`, `toRoomFormationDenial` (`docs/rallar-api-reference.md`)                                                                       | Nothing in the black-box runtime calls it; a browser agent can only reach the lifecycle through `http.request` to the group-state routes, which observes the server, not the browser |
| The browser Rallar runtime `window.__blackBoxRallar` (`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/`) with `authenticate`, `connect`, `send`, `sendWs`, `refreshRoom`, `readRtcMessageNacks`, `crdt`, `director`, `close`, `health`                              | A `formation` runtime beside `crdt` and `director` that wraps the handle and reports the status projection and the RTC room transport status as one JSON-safe record                 |
| The control protocol's command family: `configure`, `parallel`, `loop`, `wait` (with `absent`), `assert` (dot-path operators over the evidence roots), `rtc.connect` (readiness `minReadyPeers`/`timeoutMs`/`intervalMs`), `rtc.send`, `rtc.stream`, `ws.*`, `http.request`, `director.*` | `formation.attach`, `formation.command`, `formation.wait`, `formation.status`, `formation.progress`, validated, schema-published and capability-advertised like the others           |
| The Playwright three-browser matrix (`full-stack-live-rtc-three-browser-matrix.spec.ts`) with `LiveRtcControlClient`, `openLiveRtcBrowserAgent`, `createLiveRtcDeliveryOperations` and the `GroupFormationLifecycleDriver` (`create-group-formation-lifecycle-driver.ts`)                 | A lifecycle acceptance spec that reuses the client, the agents and the driver, its npm scripts, and its row in the full-stack QA matrix                                              |
| Seventeen Hetzner manifests (`apps/rallar-black-box/manifests/hetzner/`), five of them in the supported matrix of `hetzner-supported-distributed-manifests.yml`; coordinator group assertions (`allEqual`, `allMatch`, `noneMatch`) over command result paths                             | A lifecycle manifest for the two live-RTC reset scenarios, and the decision whether it joins the supported matrix                                                                    |
| The coverage table and its documentation test (`packages/tests/repo/rallar-group-documentation.test.ts`), which count the unpinned scenarios                                                                                                                                              | Rows that name the executable pins, and the count paragraph updated by the same edit                                                                                                 |

### Decisions taken at planning

| #  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 | **The pins drive the shipped browser handle, not HTTP.** Every scenario here is about what the browser does — dials, readiness, the local fraction, hydration after reset. Driving the server routes from the agent would observe the server twice and the browser never. So the agents get a `formation` runtime that calls `rallar.rooms.formation(room)`, and the recipes read its `status()` projection plus the RTC room transport status.                                                                                                                                       |
| P2 | **One command family in the control protocol, not new SPA panels.** The three-browser matrix and the Hetzner agents both execute control-protocol commands through `browser-adapter.ts`; the SPA's direct operations (`apps/rallar-black-box/src/direct-rallar-operations.ts`) serve the operator UI and the UI-driven full-stack specs, which none of these scenarios use. The family lives where `rtc.connect` lives, and the SPA panels stay unchanged. _Rejected:_ a `formation` operator panel first — it would add a fourth path to the same facade with no pin using it.       |
| P3 | **Evidence is the status projection, verbatim.** `formation.status` returns `RallarRoomFormationStatus` minus its `snapshot` (the causal revision and the group's `formationEpoch` are lifted out) plus `rallar.rtc.status()`'s `RallarRtcRoomTransportStatus` for the room lane. No derived booleans: the assertions read `stage`, `dialing`, `accepted`, `planned`, `coverageRate`, `desiredPeerIds`, `readyPeerIds`, `acceptedLayoutIdentity` themselves.                                                                                                                          |
| P4 | **The member-progress fraction is sampled in the browser and judged in the test.** A `formation.progress` command subscribes to `formation.onChange` and `rallar.rtc.onStatus` for a bounded window and records `(atEpochMs, groupRevision, layoutIdentity, readyPeerCount, desiredPeerCount)` samples; the fraction is `ready / desired` when `desired > 0`, else `null`. The test asserts monotonicity per layout identity and that at least one increase happened between two samples carrying the same group causal revision — that is the executable form of "no server writes". |
| P5 | **Absence is proven by the runtime's `wait` with `absent: true` over the RTC dial diagnostic**, paired with the positive control of the same diagnostic appearing once `connect` runs. The diagnostic's exact name is verified in Task 2.1 before the wait is written; the scenario is not pinned on a guessed event name.                                                                                                                                                                                                                                                            |
| P6 | **The readiness barrier is pinned positively.** At the instant a reconnecting agent's `rtc.connect` readiness completes, its `formation.status` must already name an accepted layout equal to the transport's `acceptedLayoutIdentity` and equal to what the two surviving agents report. A readiness that could complete before the fenced barrier would leave `accepted` undefined at that instant. _Rejected:_ injecting a stale accepted layout into the cache from the test — it would test the fixture, not the browser.                                                        |
| P7 | **The reset scenarios are pinned twice: locally in Playwright and in a Hetzner manifest.** The local lane is what CI can run on every PR; the distributed lane is what the coverage table asks for ("live-RTC ... the distributed lane"). The manifest is the same sequence expressed as agent commands with coordinator assertions, and the single-issuer steps go through the director role the relay manifests already use.                                                                                                                                                        |
| P8 | **Groups are `managed` with manual `plan` and `connect` triggers** for every scenario except `discovery-holds-dials`, which is `phased` with a manual plan trigger so the lobby holds in `forming` (the repository memory `phased-group-triggers-behavioural-in-recipes` records why a bare `phased` group auto-plans at creation).                                                                                                                                                                                                                                                   |

### Ownership map

| Concern                                                                            | Owner (new files in bold)                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The browser-side formation runtime (facade calls, status record, progress sampler) | **`packages/shared-test/black-box-runner/browser/rallar-browser-runtime/formation-controller.ts`**, wired in `browser-rallar-runtime-composition.ts`, contract in `black-box-rallar-runtime-contract.ts`                |
| The bridge from the agent adapter to that runtime                                  | `packages/shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts`, `browser-adapter.ts` (`RallarBlackBoxBrowserRallarRuntime.formation`)                                                                           |
| The command family: types, validation, dispatch, schema, capabilities, docs        | `packages/shared-test/rallar-bb-test/types.ts`, `control-protocol.ts`, `browser-adapter.ts`, `schema.ts`, `distributed/control-agent-capabilities.ts`, `docs/schema-and-capabilities.md`, `black-box-runner-adapter.ts` |
| The Playwright lifecycle acceptance spec and its client helpers                    | **`tests/playwright/rallar-black-box/full-stack-live-rtc-lifecycle-acceptance.spec.ts`**, **`live-rtc-formation-operations.ts`**, `live-rtc-control-client.ts`, `create-group-formation-lifecycle-driver.ts`            |
| The npm scripts and the QA matrix row                                              | `package.json`, `apps/rallar-black-box/src/full-stack-qa-matrix.ts`                                                                                                                                                     |
| The distributed manifests and the supported matrix                                 | **`apps/rallar-black-box/manifests/hetzner/18-lifecycle-reset-3-agent.json`**, `.github/workflows/hetzner-supported-distributed-manifests.yml` (per Q2)                                                                 |
| Documentation closure                                                              | `docs/rallar-group-formation-architecture.md` (coverage table, count paragraph, recipes-and-profiles section), `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`, `playground/rtc-design/README.md` |

### The scenarios as executable statements

Each row is the statement the test asserts, in the vocabulary of the status record (P3).

| Scenario                   | Executable statement                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `discovery-holds-dials`    | Three agents attached to a `phased` group holding in `forming`: for a 5 s window no RTC dial diagnostic is recorded on any agent, every agent's `formation.status` reads `dialing` with no role and `desiredPeerIds: []`; then the manager's `plan` and `connect` make the same diagnostic appear on every agent within the `rtc.connect` readiness budget.                    |
| `member-progress`          | Agent C's `formation.progress` window, started before the manager's `connect` and ended at `active`: every sample taken while `planned` is undefined has `fraction: null`; within one `layoutIdentity` the fraction never decreases; the last sample is `1`; at least one strict increase separates two samples with the same `groupRevision`.                                 |
| `status-on-connect`        | Agent B reconnects after activation (`reconnectAndWaitForPeerReadiness`): at readiness completion its `formation.status` reads `stage: 'active'`, `accepted` defined, `accepted.identity` equal to the transport's `acceptedLayoutIdentity`, and equal to the `accepted.identity` agents A and C report.                                                                       |
| `reset-tears-down`         | After the manager's `reset` on the active group, every agent reaches `stage: 'dormant'` within the wait budget and reads `readyPeerIds: []`, `desiredPeerIds: []`, `dialing` with no role, `accepted` and `planned` undefined; a 5 s absence wait records no dial diagnostic on any agent; the `start`/`plan`/`connect` that follow are the positive control that dials again. |
| `reset-no-stale-hydration` | Agent C closes and re-attaches after the reset (before `start`): its `formation.status` reads `stage: 'dormant'`, `planned` undefined, `accepted` undefined, `coverageRate` undefined; a `refreshRoom` changes none of them.                                                                                                                                                   |

---

## Slice 1 — The formation command family

Delivers the `formation.*` commands end to end in the browser runtime, the adapter, the control
protocol and the published schema, with unit coverage; no scenario yet. Slice 2 consumes it
unchanged.

### Task 1.1: The browser formation runtime

**Files:**

- Create: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/formation-controller.ts`
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts`
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts`
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts`
- Test: `packages/tests/shared-test/black-box-runner/browser/formation-controller.test.ts`

**Interfaces:**

- Consumes: `rallar.rooms.formation(room)` (`RallarRoomFormation`), `rallar.rtc.status({ laneId })`
  and `rallar.rtc.onStatus` (`RallarRtcRoomTransportStatus`), the runtime's existing room-identity
  resolution used by `connect`/`refreshRoom` (`decode-black-box-rallar-connection-config.ts`).
- Produces: `BlackBoxRallarFormationRuntime` on `BlackBoxRallarRuntime.formation`, with
  `attach`, `command`, `wait`, `status`, `progress`.

- [ ] **Step 1: Declare the contracts** in `black-box-rallar-operation-contracts.ts`:

```ts
export interface BlackBoxRallarFormationRoomInput {
    readonly roomRef?: GroupRef;
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly roomId?: string;
    readonly timeoutMs: number;
}

export type BlackBoxRallarFormationCommandName =
    | 'plan'
    | 'connect'
    | 'activate'
    | 'reconfigure'
    | 'pause'
    | 'resume'
    | 'reset'
    | 'start';

export interface BlackBoxRallarFormationCommandInput extends BlackBoxRallarFormationRoomInput {
    readonly command: BlackBoxRallarFormationCommandName;
    /** `connect` only: the exact layout to dial; the planned slot when omitted. */
    readonly layout?: GroupLayoutIdentity;
    /** `reconfigure` only. */
    readonly landing?: GroupTopologyReconfigureLanding;
    readonly reason?: string;
}

export interface BlackBoxRallarFormationWaitInput extends BlackBoxRallarFormationRoomInput {
    readonly stage?: readonly GroupLifecycleState[];
    readonly layout?: Readonly<{ role: 'planned' | 'accepted'; }>;
    readonly condition?: readonly GroupActivationCondition[];
}

export interface BlackBoxRallarFormationProgressInput extends BlackBoxRallarFormationRoomInput {
    /** Sampling ends at this stage or at `timeoutMs`, whichever comes first. */
    readonly untilStage: GroupLifecycleState;
    readonly sampleEveryMs: number;
}

export interface BlackBoxRallarFormationStatusRecord {
    readonly roomRef: GroupRef;
    readonly stage: GroupLifecycleState;
    readonly formationEpoch: number;
    readonly formationAttemptCount: number;
    readonly causalRevision: GroupStateCausalRevision;
    readonly transportState: GroupTransportState;
    readonly dialing: GroupDialLayoutRoles;
    readonly accepted: GroupLayoutIdentity | null;
    readonly planned: GroupLayoutIdentity | null;
    readonly condition: GroupActivationCondition | null;
    readonly coverageRate: number | null;
    readonly transport: Readonly<{
        state: RallarRoomTransportState;
        acceptedLayoutIdentity: GroupLayoutIdentity | null;
        desiredPeerIds: readonly string[];
        readyPeerIds: readonly string[];
        failedPeerIds: readonly string[];
    }>;
}

export interface BlackBoxRallarFormationProgressSample {
    readonly atEpochMs: number;
    readonly groupRevision: number;
    readonly stage: GroupLifecycleState;
    readonly layoutIdentity: GroupLayoutIdentity | null;
    readonly desiredPeerCount: number;
    readonly readyPeerCount: number;
    readonly fraction: number | null;
}

export interface BlackBoxRallarFormationProgressRecord {
    readonly samples: readonly BlackBoxRallarFormationProgressSample[];
    readonly endedBy: 'stage' | 'timeout';
}
```

The `null`s are deliberate: the record crosses the control protocol as JSON, where `undefined`
disappears, and an assertion must be able to say "the planned layout is absent" with `equals null`.

- [ ] **Step 2: Write the failing controller test** in
      `packages/tests/shared-test/black-box-runner/browser/formation-controller.test.ts`. Build the
      controller with a fake `RallarRoomFormation` (a hand-written object exposing `status`, `plan`,
      `connect`, `reset`, `start`, `waitForStage`, `waitForLayout`, `waitForCondition`, `onChange`) and a
      fake RTC status source, then assert:

```ts
it('reports the status projection and the room transport as one JSON-safe record', () => {
    const status = createFormationController({ formation: fakeFormation, rtc: fakeRtc }).status(
        room
    );

    expect(status).toEqual({
        roomRef: room.roomRef,
        stage: 'planned',
        formationEpoch: 1,
        formationAttemptCount: 0,
        causalRevision: { groupRevision: 3, presenceRevision: 2 },
        transportState: 'halted',
        dialing: { planned: false, accepted: false },
        accepted: null,
        planned: { groupRevision: 3, presenceRevision: 2, version: 1, state: 'active' },
        condition: 'inactive',
        coverageRate: null,
        transport: {
            state: 'idle',
            acceptedLayoutIdentity: null,
            desiredPeerIds: [],
            readyPeerIds: [],
            failedPeerIds: []
        }
    });
    expect(JSON.parse(JSON.stringify(status))).toEqual(status);
});

it('samples the fraction as null until a layout is dialed and ends at the requested stage', async () => {
    const progress = createFormationController({ formation: fakeFormation, rtc: fakeRtc })
        .progress({ ...room, untilStage: 'active', sampleEveryMs: 10, timeoutMs: 1_000 });
    fakeRtc.emit({ desiredPeerIds: ['b', 'c'], readyPeerIds: ['b'] });
    fakeFormation.emit({ stage: 'active' });

    const record = await progress;

    expect(record.endedBy).toBe('stage');
    expect(record.samples.map((sample) => sample.fraction)).toEqual([null, 0.5, 1]);
});
```

The exact shape of `GroupDialLayoutRoles` (`{ planned, accepted }` booleans or a role list) is read
from `rallar-room-formation-contracts.ts` in this step and the expectation adjusted; the
`transportState` and `condition` vocabularies come from `@shared/api/group-lifecycle`.

- [ ] **Step 3: Run the test** — `npx vitest run packages/tests/shared-test/black-box-runner/browser/formation-controller.test.ts`. Expected: FAIL, `formation-controller.ts` does not exist.

- [ ] **Step 4: Implement `formation-controller.ts`**:

```ts
export interface FormationControllerDependencies {
    readonly resolveFormation: (room: BlackBoxRallarFormationRoomInput) => RallarRoomFormation;
    readonly resolveRoomRef: (room: BlackBoxRallarFormationRoomInput) => GroupRef;
    readonly rtcStatus: (roomRef: GroupRef) => RallarRtcRoomTransportStatus | undefined;
    readonly onRtcStatus: (roomRef: GroupRef, listener: () => void) => RallarUnsubscribe;
    readonly now: () => number;
}

export function createFormationController(
    dependencies: FormationControllerDependencies
): BlackBoxRallarFormationRuntime {
    return {
        attach: async (room) => toStatusRecord(dependencies, room),
        command: async (input) => {
            const formation = dependencies.resolveFormation(input);
            const receipt = await runFormationCommand(formation, input);
            return {
                receipt: toReceiptRecord(receipt),
                status: toStatusRecord(dependencies, input)
            };
        },
        wait: async (input) =>
            toWaitRecord(await waitForFormation(dependencies.resolveFormation(input), input)),
        status: async (room) => toStatusRecord(dependencies, room),
        progress: (input) => sampleFormationProgress(dependencies, input)
    };
}
```

`runFormationCommand` is a `switch` over the eight command names calling the handle method by
name (`formation.connect(input.layout ? { layout: input.layout } : {})`,
`formation.reconfigure({ landing })`, the others with `{ reason }` only). `toStatusRecord` reads
`formation.status()` and `dependencies.rtcStatus(roomRef)`, lifting `snapshot.causalRevision` and
`snapshot.group.formationEpoch` and mapping `undefined` to `null`; a status that reads `undefined`
(the room is not held) fails the command with `RALLAR_BLACK_BOX_FORMATION_ROOM_NOT_HELD`.
`waitForFormation` dispatches to `waitForStage`, `waitForLayout({ role })` or `waitForCondition`
and fails on a `timeout`/`not-found` status with the runtime's typed failure.
`sampleFormationProgress` subscribes to `onChange` and `onRtcStatus`, takes a sample on every
event and every `sampleEveryMs` tick, and resolves when the stage reaches `untilStage` (`endedBy:
'stage'`) or the budget elapses (`endedBy: 'timeout'`), always unsubscribing.

`attach` is `status` after the runtime's existing connect-without-readiness: the facade is started
(`rallar.start({ connect: true, refreshRooms: false })`) and the room refreshed once
(`refreshRoom`) by the composition, exactly as `rtc.connect` does before it waits for readiness;
`attach` stops before the readiness wait. This is the presence-only entry that `discovery-holds-dials`
and the post-reset re-attach need.

- [ ] **Step 5: Wire it** in `browser-rallar-runtime-composition.ts` beside `director` and `crdt`,
      resolving `rallar.rooms.formation(roomRef)` and `rallar.rtc.status`/`onStatus` for the room lane,
      and add `readonly formation: BlackBoxRallarFormationRuntime` to `BlackBoxRallarRuntime`.

- [ ] **Step 6: Run the test** — expected: PASS. Then
      `npx tsc -p packages/shared-test/tsconfig.json --noEmit` (the package that owns the runtime; use the
      per-workspace `typecheck` if the package has no standalone tsconfig) and
      `npx vitest run packages/tests/shared-test/black-box-runner`.

- [ ] **Step 7: Commit** — `Add the formation runtime to the browser black-box Rallar runtime`.

### Task 1.2: The command family in the control protocol

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/types.ts` (the `RallarBlackBoxTestCommand` union)
- Modify: `packages/shared-test/rallar-bb-test/control-protocol.ts` (validation)
- Modify: `packages/shared-test/rallar-bb-test/schema.ts` (`RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA`)
- Modify: `packages/shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts`
- Modify: `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`
- Modify: `packages/shared-test/rallar-bb-test/fixtures/schema/v1/golden-compatibility-corpus.json`
- Test: `packages/tests/shared-test/control-protocol-formation-commands.test.ts`,
  `packages/tests/shared-test/rallar-bb-test-schema.test.ts` (existing, extended)

**Interfaces:**

- Consumes: Task 1.1's input contracts (the command payloads mirror them).
- Produces: five command interfaces in the union —
  `RallarBlackBoxTestFormationAttachCommand`, `...FormationCommandCommand`,
  `...FormationWaitCommand`, `...FormationStatusCommand`, `...FormationProgressCommand` — with
  `kind: 'formation.attach' | 'formation.command' | 'formation.wait' | 'formation.status' | 'formation.progress'`,
  plus the capability flag `formation` in `toControlAgentCapabilities`.

- [ ] **Step 1: Write the failing validation test**:

```ts
it.each([
    {
        kind: 'formation.attach',
        commandId: 'formation-attach-1',
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 5_000
    },
    {
        kind: 'formation.command',
        commandId: 'formation-plan-1',
        command: 'plan',
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 5_000
    },
    {
        kind: 'formation.wait',
        commandId: 'formation-wait-1',
        stage: ['active'],
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 30_000
    },
    {
        kind: 'formation.status',
        commandId: 'formation-status-1',
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 5_000
    },
    {
        kind: 'formation.progress',
        commandId: 'formation-progress-1',
        untilStage: 'active',
        sampleEveryMs: 100,
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 60_000
    }
])('accepts a well-formed $kind command', (command) => {
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
        kind: 'formation.wait',
        commandId: 'formation-bad-2',
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 5_000
    },
    {
        kind: 'formation.progress',
        commandId: 'formation-bad-3',
        untilStage: 'active',
        sampleEveryMs: 0,
        roomId: 'room-1',
        applicationId: 'app-1',
        timeoutMs: 5_000
    }
])('rejects $kind with $commandId', (command) => {
    expect(validateRallarBlackBoxTestCommand(command).ok).toBe(false);
});
```

The wait command must name exactly one of `stage`, `layout`, `condition`; `sampleEveryMs` is a
positive integer; `command` is one of the eight names; `layout` is validated with the same shape
check `rtc.connect` uses for its room identity plus the four `GroupLayoutIdentity` fields.

- [ ] **Step 2: Run the test** — expected: FAIL on the first `formation.*` kind (unknown kind).

- [ ] **Step 3: Add the five interfaces to the union in `types.ts`** (each extends the base command
      fields the other kinds share: `commandId`, `timeoutMs`, `metadata`, and the room identity fields
      `roomRef`/`applicationId`/`workspaceId`/`roomId` exactly as `RallarBlackBoxTestRtcConnectCommand`
      declares them), then the `case 'formation.attach':` … `case 'formation.progress':` branches in
      `control-protocol.ts` beside `case 'rtc.connect':`, each a `validateKeys` over the allowed keys and
      the field checks above (`validateStringField`, `validateIntegerField` with `{ minimum: 1 }`,
      `validateKeys`), returning `fail('formation.wait must name exactly one of stage, layout, condition.')`
      in the runtime's existing message style.

- [ ] **Step 4: Publish the schema** — extend `RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA` in `schema.ts`
      with one `oneOf` branch per kind mirroring the validation, add one instance of each kind to the
      golden compatibility corpus, and run
      `npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts` — the corpus test must
      accept the five new instances and the schema test must still reject a `formation.wait` naming two
      targets.

- [ ] **Step 5: Advertise the capability** — `toControlAgentCapabilities` gains `formation: true`
      for the `browser-rallar` runtime, and `validateAgentAssertionCapability`'s sibling for command
      kinds (or the coordinator's target check that already refuses `wait` with `absent` to an agent
      without that capability — read `collectDistributedAssertionFeatures` and follow its pattern) refuses
      a `formation.*` command to an agent that does not advertise it.

- [ ] **Step 6: Document** the family in `docs/schema-and-capabilities.md` under a new
      "Formation Commands" heading: the five kinds, their fields, the status record's fields, the
      `null` convention and the `attach`-is-presence-only rule.

- [ ] **Step 7: Run** the two test files and `npx vitest run packages/tests/shared-test` — expected:
      PASS. Commit — `Add the formation command family to the black-box control protocol`.

### Task 1.3: Dispatch in the browser adapter and the runner adapter

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/browser-adapter.ts`
- Modify: `packages/shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts`
- Modify: `packages/shared-test/rallar-bb-test/black-box-runner-adapter.ts`
- Test: `packages/tests/shared-test/browser-adapter-formation.test.ts`

**Interfaces:**

- Consumes: Task 1.1's `BlackBoxRallarFormationRuntime` through the bridge; Task 1.2's commands.
- Produces: `RallarBlackBoxBrowserRallarRuntime.formation?` (optional like `crdt` and `director`,
  because simulated providers have no facade) and the five `case 'formation.*':` branches in the
  adapter's command switch, each recording `value` as the typed record and `kind`-specific failure
  codes (`RALLAR_BLACK_BOX_FORMATION_ROOM_NOT_HELD`, `RALLAR_BLACK_BOX_FORMATION_WAIT_TIMEOUT`,
  `RALLAR_BLACK_BOX_FORMATION_DENIED` carrying `toRoomFormationDenial(error)` when it classifies).

- [ ] **Step 1: Write the failing adapter test** with a fake runtime whose `formation.status`
      returns a fixed record; execute a `formation.status` command through the adapter and assert the
      result `value` equals the record and the result `status` is `completed`; execute a
      `formation.command` whose fake throws an `ApiHttpError` carrying
      `group-connect-planned-layout-superseded` and assert the failure code
      `RALLAR_BLACK_BOX_FORMATION_DENIED` with `details.denial.kind === 'layout'`.

- [ ] **Step 2: Run it** — expected: FAIL (unknown command kind in the adapter).

- [ ] **Step 3: Implement** the bridge methods (one-liners delegating to
      `resolveBrowserRallarRuntime()).formation`, failing with `browser-rallar provider did not expose
formation commands.` when absent, following `resolveBrowserRallarDirectorRuntime`) and the five
      adapter branches; `black-box-runner-adapter.ts` maps the same kinds for in-process runs. The
      `director` family is the template for both files.

- [ ] **Step 4: Run** the adapter test, `npx vitest run packages/tests/shared-test`, and the
      composite conformance suite (`composite-conformance.ts` lists required command kinds per
      conformance profile; the family is not required by any existing profile, so nothing changes there
      unless step 5 adds one).

- [ ] **Step 5: Add a conformance profile** `formation-lifecycle` with
      `requiredCommandKinds: ['configure', 'formation.attach', 'formation.command', 'formation.wait', 'formation.status']`
      so the composite conformance matrix (`docs/composite-conformance-matrix.md`) lists the family; run
      its local verification command from that document.

- [ ] **Step 6: Commit** — `Dispatch the formation commands in the browser and runner adapters`.

### Task 1.4: Slice 1 closure

- [ ] `npm run typecheck`, `npm run test:unit`, `npm run check:repo-style:changed -- origin/main HEAD`,
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`, `npm run format:check`,
      `npm run test:repo-governance` (the schema docs are governed), and
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` plus
      `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` — the headless agent
      bundles the browser runtime, so `formation-controller.ts` moves its budget; raise it per the Q6
      convention of the browser surface plan (smallest whole KiB above the measurement, recorded beside
      the budget and in the PR).
- [ ] PR with the standard body; `npm run pr:delivery -- status`; the Branch Release Gate on the
      final feature-branch commit and Run Hetzner Supported Distributed Manifests on the resulting
      default-branch commit (the slice touches a distributed-risk path, so the run is not a no-op).

---

## Slice 2 — The local lane: the lifecycle acceptance spec

Pins `discovery-holds-dials`, `member-progress`, `status-on-connect`, `reset-tears-down` and
`reset-no-stale-hydration` in one Playwright spec that runs under the same configuration and
environment gates as the three-browser matrix.

### Task 2.1: The formation operations for the control client

**Files:**

- Create: `tests/playwright/rallar-black-box/live-rtc-formation-operations.ts`
- Modify: `tests/playwright/rallar-black-box/live-rtc-control-client.ts`
- Modify: `tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts`

**Interfaces:**

- Consumes: `LiveRtcControlClient` (`executeOk`, `executeResult`, `resultValue`,
  `waitForPeerReadiness`), `GroupFormationLifecycleDriver.setupGroupMembership` (which already
  creates the group with `planTrigger`/`connectTrigger: { kind: 'manual' }`), the Task 1.2 commands.
- Produces:

```ts
export interface LiveRtcFormationOperations {
    attach(input: FormationAgentInput): Promise<BlackBoxRallarFormationStatusRecord>;
    command(input: FormationCommandInput): Promise<BlackBoxRallarFormationStatusRecord>;
    waitForStage(input: FormationWaitInput): Promise<BlackBoxRallarFormationStatusRecord>;
    status(input: FormationAgentInput): Promise<BlackBoxRallarFormationStatusRecord>;
    startProgress(input: FormationProgressInput): Promise<string>;
    awaitProgress(commandId: string): Promise<BlackBoxRallarFormationProgressRecord>;
    expectNoDialsFor(input: FormationAbsenceInput): Promise<void>;
}
```

- [ ] **Step 1: Find the dial diagnostic** (P5): search the browser RTC layer for the diagnostic
      emitted when a peer connection attempt starts (`packages/shared-web/browser/rtc/` and the
      `emitBrowser*Diagnostic` producers listed in `docs/runtime-diagnostic-contract.md`), run one
      `rtc.connect` through the existing matrix locally with
      `RALLAR_BLACK_BOX_RTC_DIAGNOSTICS_OUT_DIR` set, and read the recorded event's `name`/`kind`/`peerId`
      fields. Record the exact match in this task's code below before writing it.

- [ ] **Step 2: Write `live-rtc-formation-operations.ts`**: each operation issues one command
      through `control.executeOk` under a command id `${prefix}-formation-${operation}-${suffix}` and
      decodes the result with `control.resultValue`; `expectNoDialsFor` issues
      `{ kind: 'wait', absent: true, timeoutMs: windowMs, match: <the dial diagnostic from step 1> }`.
      `startProgress` returns the command id of a `formation.progress` dispatched without awaiting, and
      `awaitProgress` awaits its result — the control client's `executeResult` already separates dispatch
      from completion for long commands; if it does not expose a non-blocking dispatch, add
      `dispatch(command)` returning the command id beside `executeResult`.

- [ ] **Step 3: Extend the driver** with `reattach(input)` — close the agent's page, reopen it with
      `openLiveRtcBrowserAgent` (restored session), and `formation.attach` without any readiness wait —
      the post-reset re-attach that `reconnectAndWaitForPeerReadiness` cannot express because it waits
      for peers.

- [ ] **Step 4: Type-check** with `npm run typecheck:tests` (the Playwright tree is in the tests
      typecheck project; confirm with `node scripts/check-tests-typecheck.mjs`). Commit —
      `Add formation operations to the live RTC control client`.

### Task 2.2: The acceptance spec

**Files:**

- Create: `tests/playwright/rallar-black-box/full-stack-live-rtc-lifecycle-acceptance.spec.ts`
- Modify: `package.json` (scripts), `apps/rallar-black-box/src/full-stack-qa-matrix.ts`
- Test: `packages/tests/rallar-black-box/full-stack-qa-matrix.test.ts` (existing; the row is pinned)

- [ ] **Step 1: Scripts** — add `test:rallar:full-stack:memory:live-rtc-3:lifecycle` and
      `test:rallar:full-stack:postgres:live-rtc-3:lifecycle` with the same environment as their matrix
      siblings and the new spec path, and the `test:e2e:rallar-black-box:full-stack:*` aliases the matrix
      has. Add the QA matrix row (`id: 'lifecycle-acceptance-pins'`, `area: 'formation'`, the five
      scenario names in `evidence`, `skipGate: 'RALLAR_BLACK_BOX_FULL_STACK=1 and RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1'`,
      `liveProvider: true`) and make `full-stack-qa-matrix.test.ts` pass.

- [ ] **Step 2: The spec skeleton** mirrors the matrix's setup (the same env gates, `test.skip`
      message, `LiveRtcControlClient`, `openAgentTrio`, `retireAgents`, diagnostics capture) and four
      tests, one per statement group in "The scenarios as executable statements":

```ts
test(
    'holds every dial while a phased lobby discovers itself, then dials on connect',
    async ({ browser, request }, testInfo) => {
        test.setTimeout(180_000);
        const agents = await openAgents('discovery');
        await deliveryOperations.setupGroupMembership({
            ...membership,
            lifecyclePolicy: PHASED_MANUAL_PLAN
        });
        const attached = await Promise.all(
            agents.map((agent) => formation.attach({ control, runId, agent, groupId, suffix }))
        );
        for (const status of attached) {
            expect(status.stage).toBe('forming');
            expect(status.dialing).toEqual(NO_DIAL_ROLES);
            expect(status.transport.desiredPeerIds).toEqual([]);
        }
        await Promise.all(
            agents.map((agent) =>
                formation.expectNoDialsFor({ control, runId, agent, suffix, windowMs: 5_000 })
            )
        );

        await formation.command({
            control,
            runId,
            agent: agents[0],
            groupId,
            suffix,
            command: 'plan'
        });
        await formation.command({
            control,
            runId,
            agent: agents[0],
            groupId,
            suffix,
            command: 'connect'
        });
        const ready = await deliveryOperations.runGroupFormation({
            ...run,
            agents,
            readinessScope: 'all'
        });
        expect(ready.readinessDurations).toBeDefined();
        for (const agent of agents) {
            expect(
                (await formation.status({ control, runId, agent, groupId, suffix })).transport
                    .readyPeerIds
            ).toHaveLength(2);
        }
    }
);
```

The other three tests follow the statements table verbatim: `member-progress` starts agent C's
sampler before A's `connect` and awaits it after `waitForStage('active')`, then asserts the sample
invariants with a small pure helper `assertMonotonicFraction(samples)` in the spec file;
`status-on-connect` uses `reconnectAndWaitForPeerReadiness` for agent B and compares the three
status records' `accepted`; the reset test issues `reset` from A, waits `dormant` on all three,
asserts the empty transport and absent layouts, runs the 5 s absence wait, re-attaches C
(`reattach`) and asserts `planned: null`, `accepted: null`, `coverageRate: null`, then `start`,
`plan`, `connect` and readiness as the positive control. `PHASED_MANUAL_PLAN` and the managed
policy are literal `lifecyclePolicy` objects taken from the driver's existing membership setup.

- [ ] **Step 3: Run locally** — `npm run test:rallar:full-stack:memory:live-rtc-3:lifecycle`. The
      first run is the calibration of the readiness and wait budgets against the in-memory API; a
      scenario that fails is diagnosed with the diagnostics artifact before any budget moves, and a
      budget that must move is recorded in the spec beside the number with the measured figure.

- [ ] **Step 4: Run the existing matrix once** — `npm run test:rallar:full-stack:memory:live-rtc-3`
      — to prove the shared client and driver changes broke nothing.

- [ ] **Step 5: Commit** — `Pin the browser acceptance scenarios in a live RTC lifecycle spec`.

### Task 2.3: Documentation closure for the local lane

- [ ] Update the coverage table rows for the five scenarios to name the spec and its test titles,
      update the "N scenarios are unpinned" paragraph (the documentation test checks the count against
      the table) and the sentence after it, and add the spec to the "Recipes and profiles" section's
      lane description. Run `npx vitest run packages/tests/repo/rallar-group-documentation.test.ts`.
- [ ] Slice closure as in Task 1.4, plus the Playwright spec's own gate command in the PR body.

---

## Slice 3 — The distributed lane: the reset manifest

### Task 3.1: The lifecycle reset manifest

**Files:**

- Create: `apps/rallar-black-box/manifests/hetzner/18-lifecycle-reset-3-agent.json`
- Modify: `.github/workflows/hetzner-supported-distributed-manifests.yml` (per Q2)
- Test: `packages/tests/rallar-black-box/world-fleet-distributed-manifests.test.ts` and
  `packages/tests/rallar-black-box/distributed-recipes.test.ts` (existing; they validate manifests
  against `RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA` and catalogue them)

- [ ] **Step 1: Read `06-rtc-realtime-3-agent-15s.json`** and the director relay manifest that uses
      `director.appoint`, and confirm how a single agent is chosen for one command (the director role)
      and how `targetPolicy.expectedParticipantCount: 3` gates the barrier.

- [ ] **Step 2: Write the manifest**: `http.request` ensure-group with the managed manual-trigger
      policy and ensure-member (as manifest 06 does), `formation.attach` on every agent,
      `director.appoint` one agent, the director's `formation.command` `plan` and `connect`,
      `rtc.connect` readiness on every agent, `formation.wait` `active`, the director's `formation.command`
      `reset`, `formation.wait` `dormant` on every agent, `formation.status` recorded as
      `lifecycle-reset-status`, a `wait` with `absent: true` over the dial diagnostic for 5 s, then the
      director's `start`, `plan`, `connect` and `rtc.connect` readiness again as the positive control,
      with `formation.status` recorded as `lifecycle-restart-status`. Group assertions:

```json
[
  {
    "groupAssertionId": "reset-stage-dormant-everywhere",
    "aggregate": "allMatch",
    "source": {
      "recipeId": "lifecycle-reset-recipe",
      "commandId": "lifecycle-reset-status",
      "path": "value.stage"
    },
    "predicate": { "operator": "equals", "expected": "dormant" }
  },
  {
    "groupAssertionId": "reset-no-ready-peers",
    "aggregate": "allMatch",
    "source": {
      "recipeId": "lifecycle-reset-recipe",
      "commandId": "lifecycle-reset-status",
      "path": "value.transport.readyPeerIds"
    },
    "predicate": { "operator": "length", "expected": 0 }
  },
  {
    "groupAssertionId": "reset-no-planned-layout",
    "aggregate": "allMatch",
    "source": {
      "recipeId": "lifecycle-reset-recipe",
      "commandId": "lifecycle-reset-status",
      "path": "value.planned"
    },
    "predicate": { "operator": "equals", "expected": null }
  },
  {
    "groupAssertionId": "restart-ready-peers-converge",
    "aggregate": "allMatch",
    "source": {
      "recipeId": "lifecycle-reset-recipe",
      "commandId": "lifecycle-restart-status",
      "path": "value.transport.readyPeerIds"
    },
    "predicate": { "operator": "length", "expected": 2 }
  }
]
```

The predicate operators available to group assertions are read from
`distributed/group-assertions-aggregates.ts` in step 1; `length` and `equals` on `null` are
confirmed or replaced there before the manifest is written.

- [ ] **Step 3: Validate** with the two catalogue tests, then run the manifest through the local
      distributed runner the repository already uses for manifest development
      (`packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md` names the command and the
      `github-free-distributed-recipe.yml` workflow runs a manifest without Hetzner).

- [ ] **Step 4: Supported matrix** — per Q2, add `18-lifecycle-reset-3-agent` to the matrix of
      `hetzner-supported-distributed-manifests.yml` and to its "Reject topology-specific supported
      manifests" allowlist; the reset scenario needs three agents, so the fleet size for that entry is
      three.

- [ ] **Step 5: Commit** — `Add the lifecycle reset manifest to the Hetzner lane`.

### Task 3.2: Documentation closure for the distributed lane

- [ ] Coverage table: `reset-tears-down` and `reset-no-stale-hydration` name both the spec test and
      the manifest; the unpinned paragraph now lists only `pacing-sweep` (and the `apply-landing`
      restart-convergence residue stays where it is).
- [ ] `playground/rtc-design/README.md`: this plan's row reads as landed.
- [ ] Slice closure as in Task 1.4, plus the Run Hetzner Supported Distributed Manifests result for
      the default-branch commit, which now includes the manifest if Q2 says yes.

---

## Questions for review

| #  | Question                                                                                                                                                                                                        | Recommended answer                                                                                                                                                                                                                                        |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 | Where the family lives: the control protocol executed by browser agents (P2), or the SPA's direct operations with a `formation` panel, or both.                                                                 | P2. Every pin is a control-agent scenario, and the Hetzner lane can only run control commands; a panel is a separate operator feature with no pin behind it.                                                                                              |
| Q2 | Whether `18-lifecycle-reset-3-agent` joins the supported matrix that runs on every distributed-risk push to `main` (three agents, roughly a minute), or stays an on-demand manifest run by `workflow_dispatch`. | Join the supported matrix. The scenario is the only live-RTC lifecycle proof the coverage table asks for, and a manifest nobody runs is not a pin; the cost is one three-agent job per risk push. Revisit if it flakes the way `04-provider-parity` does. |
| Q3 | The readiness barrier's proof shape (P6): the positive pin at readiness completion, or additionally an injected stale accepted layout to show readiness waits for the fenced one.                               | Positive pin only. Injection tests the fixture; the server half is already pinned by `api-v1-group-state-reconnect-resync`, and the browser's fence is a pure function with its own unit coverage.                                                        |
| Q4 | Whether `member-progress`'s "no server writes" is pinned as "one strict increase between two samples with the same group causal revision" (P4), or dropped to monotonicity alone.                               | Keep P4. The revision is already in the status record; the assertion is one line and it is the property decision 40 promises.                                                                                                                             |
| Q5 | Whether the new spec runs under `test:rallar:full-stack:memory:live-rtc-3` (the matrix script widened to both files) or under its own script.                                                                   | Its own script, wired into the same `test:e2e:*` aliases. The matrix spec's default test takes six minutes; keeping the lifecycle spec separately addressable keeps the failure attribution clean, and CI's optional live job lists both.                 |
| Q6 | Whether `formation.attach` (presence without readiness) is a distinct command or an option on `rtc.connect` (`readiness: { minReadyPeers: 0 }`).                                                                | A distinct command. `rtc.connect`'s readiness minimum of 1 is deliberate (`schema-and-capabilities.md`), and a lobby that must not dial has nothing to be ready for.                                                                                      |
| Q7 | Whether slice 1 lands before the three-browser-matrix owner reviews slice 2's spec, or the plan waits for one review of all three slices.                                                                       | Land slice 1 first. It is a runtime and protocol change with unit coverage and no scenario; slice 2 is where the owner's judgement is needed and it reads better on top of a merged slice 1.                                                              |

## Validation summary

| Gate                                                                                                               | Slice 1 | Slice 2 | Slice 3 |
| ------------------------------------------------------------------------------------------------------------------ | ------- | ------- | ------- |
| Focused Vitest (`packages/tests/shared-test`, `packages/tests/rallar-black-box`, the headless boundary test)       | yes     | yes     | yes     |
| `npm run typecheck` (includes `typecheck:tests`), `node scripts/check-tests-typecheck.mjs`                         | yes     | yes     | —       |
| `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`                                              | yes     | —       | —       |
| `npm run check:repo-style:changed -- origin/main HEAD`, `node scripts/check-test-structure-coupling.mjs --changed` | yes     | yes     | yes     |
| `npm run format:check`, `npm run test:repo-governance`                                                             | yes     | yes     | yes     |
| `npm run test:unit`, `npm run build`                                                                               | yes     | yes     | —       |
| `npm run test:rallar:full-stack:memory:live-rtc-3` (the existing matrix, unchanged)                                | —       | yes     | —       |
| `npm run test:rallar:full-stack:memory:live-rtc-3:lifecycle` (new)                                                 | —       | yes     | yes     |
| Group documentation test (`packages/tests/repo/rallar-group-documentation.test.ts`)                                | —       | yes     | yes     |
| Branch Release Gate (CI) on the final feature-branch commit                                                        | yes     | yes     | yes     |
| Run Hetzner Supported Distributed Manifests on the default-branch commit (a risk path is touched)                  | yes     | yes     | yes     |
| `npm run pr:delivery -- status` before broad validation, `-- ready` once at handoff                                | yes     | yes     | yes     |

Not required by this plan: medium-scale, state-write, topology-replay and formation-large. No
mutation path, OpenAPI block or server behaviour changes; no api-v1 recipe changes.

## Not in this plan

- `pacing-sweep` (the headless parallelism sweep over `maxConcurrentEdgeSetups`), which is a
  performance harness, not an acceptance pin, and belongs with the RTC benchmark workstream.
- `apply-landing`'s restart-convergence leg, which needs a server restart inside a recipe run and is
  recorded in the coverage table as honest residue.
- A `formation` operator panel in the black-box SPA (Q1).
- Typed WS NACK reasons and the other items the architecture document lists as deliberately not
  built.
