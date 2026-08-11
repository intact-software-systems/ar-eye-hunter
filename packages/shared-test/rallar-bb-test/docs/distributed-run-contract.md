# Distributed Run Contract

`packages/shared-test/rallar-bb-test/distributed-run.ts` defines the shared
contract for distributed recipe execution. It is intentionally a contract only:
it does not open sockets or run browser automation. The control server now uses
this contract to create distributed-run resources and to enqueue ordinary
`rallar-bb-test` commands to browser agents.

Control snapshot wire types, distributed artifact bundle types, artifact
analysis helpers, and reusable recipe fixtures also live under
`packages/shared-test/rallar-bb-test`. The SPA may re-export compatibility
symbols, but shared distributed-run behavior should start in this package.

## Manifest

`RallarBlackBoxDistributedRunManifest` is the JSON shape used to describe one
distributed recipe test independent of React component state.

Required fields:

- `distributedRunId`
- `group.applicationId`
- `group.workspaceId`
- `group.groupId`
- `recipes`
- `targetPolicy`

Important optional fields:

- `controlRunId`: link to the lower-level control-server run.
- `variables` and `secretRefs`: shared run-level inputs.
- `recipes[].recipeId` or `recipes[].recipe`: catalog recipe reference or
  inline `rallar-bb-test` recipe.
- `recipes[].role`, `profile`, `variables`, `secretRefs`, and `required`.
- `targetPolicy.mode`: `all-online-group-members`, `selected-agents`, or
  `role-map`.
- `roleAssignments`: per-agent role and recipe assignment.
- `roleAssignmentPolicy`: optional dynamic role derivation. The first policy is
  `{ mode: "ordered-targets", orderBy: "agent-id" }` with patterns
  `all-agents`, `sender-receiver`, `one-sender-many-receivers`, or
  `three-browser-matrix`.
- `ackTimeoutMs`: readiness/ACK timeout before the run is considered failed or
  timed out.
- `barrier`: optional start-synchronization phase. When `enabled` is true, the
  control server queues one `barrier` command per target after all stage ACKs
  have passed and waits for `barrier.ready` evidence before the run can start.
  `barrier.timeoutMs` defaults to `ackTimeoutMs` or 15 seconds.
- `startMode`: `manual`, `auto-after-ready`, or `scheduled`.
- `startDeadlineEpochMs`: required when `startMode` is `scheduled`.
- `artifactPolicy`: event JSONL, result JSONL, failure bundle, and distributed
  metadata retention preferences.

Use `validateDistributedRunManifestContract(manifest)` after JSON Schema
validation for domain checks such as:

- recipe selection must contain `recipeId` or an inline `recipe`
- `selected-agents` requires at least one agent ID
- `role-map` requires roles or role assignments
- scheduled runs require `startDeadlineEpochMs`
- ACK timeout and expected participant count must be positive integers
- barrier timeout must be a positive integer when supplied

## Lifecycle States

The distributed run lifecycle states are:

- `draft`
- `resolving-targets`
- `staging`
- `waiting-for-ack`
- `waiting-for-barrier`
- `ready`
- `running`
- `passed`
- `failed`
- `cancelled`
- `timed-out`

Terminal states are:

- `passed`
- `failed`
- `cancelled`
- `timed-out`

Use `isDistributedRunTerminalState(state)` when UI/server code needs to stop
polling or disable mutating actions.

## Rollup Rules

`rollupDistributedRunResult(input)` combines participant and recipe results into
one distributed-run status.

The rollup rules are deliberately simple and deterministic:

- Explicit terminal `stateHint` wins.
- Required timeouts roll up to `timed-out`.
- Required cancellations roll up to `cancelled`.
- Required failures, disconnected required participants, or `ok: false` roll up
  to `failed`.
- Optional participant or recipe failures are counted as evidence but do not
  fail the distributed run.
- If all required recipe results passed, the distributed run is `passed`.
- If any required participant or recipe is running, the distributed run is
  `running`.
- If all required participants are ready before recipe execution, the run is
  `ready`.
- If stage ACKs passed but the optional barrier has not finished, the run is
  `waiting-for-barrier`.
- If any required participant has acknowledged but not all are ready, the run is
  `waiting-for-ack`.
- Otherwise the state remains the supplied non-terminal hint or `draft`.

The rollup returns a summary and a `failures` array that can feed the future UI
and artifact export.

## Target Resolution

The shared target-resolution contract is used before a distributed run is
created or staged. It supports both fixed local/Hetzner agent IDs and
already-running world-fleet agents that must be resolved from live control
server state.

Control agents report `RallarBlackBoxControlAgentIdentity` on register and
heartbeat:

- `principalId`, `clientId`, and `username`
- `sessionId` and `clientInstanceId`
- `applicationId`, `workspaceId`, and `groupId`
- `providerMode`
- `browserLabel` and `sessionLabel`
- `updatedAtEpochMs`

`resolveGroupMemberControlAgentMatches(...)` compares observed Rallar group
members with connected control agents for the current group. The result can
explain:

- `matched`: exactly one fresh connected agent maps to the group member
- `unmatched-group-member`: a group member has no matching control agent
- `offline-agent`: the matching control agent is disconnected
- `stale-agent`: the matching control agent heartbeat is too old
- `duplicate-session`: more than one fresh connected agent maps to the same
  group member/session
- `agent-without-group-member`: an agent reports the current group but the group
  member was not observed
- `agent-without-identity`: an agent has not reported enough Rallar identity
  metadata

Only `matched` rows are targetable by default.

The operator target-row projection uses a normalized duplicate identity key of
`applicationId`, `workspaceId`, `groupId`, the first reported
`principalId`/`clientId`/`username`, and `sessionId`. String parts are trimmed
and compared case-insensitively. Two fresh connected agents with the same key
are both `duplicate-session`; `clientInstanceId` does not split one authenticated
session into independently targetable agents. Stale, offline, wrong-group, and
incomplete-identity rows keep their more specific evidence status and do not
make an otherwise unique fresh session look duplicated.

`resolveDistributedTargetAgentIds(...)` applies the manifest target policy to
the match result:

- `all-online-group-members`: every targetable matched agent
- `selected-agents`: selected IDs that are still targetable
- `role-map`: role-map IDs that are still targetable

The helper deliberately filters out stale, offline, unmatched, and duplicate
agents so the UI/control server can show the operator why a browser is not safe
to run.

`resolveDistributedRunTargets(...)` is the richer resolver used by the control
server and operator SPA. It returns `targetResolution` with:

- resolved `targetAgentIds`
- derived `roleAssignments`
- expected/actual participant counts
- stale/offline/wrong-group/missing-identity/assertion-capability blocker
  totals
- blocking agent IDs and reasons
- role, region, and provider counts

### Assertion Capability Gate

Agents advertise an `assertions` block in
`RallarBlackBoxControlAgentCapabilities` beside the established `crdt` block:
`absence` (wait `absent: true`), `untilLoop` (loop `until: 'first-success'`),
and `operators` (the assert operator set the build evaluates). The block is
populated from the runtime feature set by
`toControlAgentCapabilities(...)` in
`distributed/control-agent-capabilities.ts` and survives the
register-envelope parse.

Staging preflight scans every inline manifest recipe (including nested
`loop`/`parallel`/`recipe.load`/`recipe.run` children) with
`collectDistributedAssertionFeatures(...)`. A targeted agent that does not
advertise a required feature becomes a `missing-assertion-capability`
blocker with a named reason listing exactly what is missing, so staging
fails before dispatch instead of the run failing agent-side at
`validateKeys`. Hetzner fleets rebuild from the checkout on rollout and
always advertise the current feature set; world-fleet agents are the
population this gate protects — checked-in world-fleet manifests may adopt
absence waits, until loops, and extended operators only behind this gate.

For `roleAssignmentPolicy.mode === "ordered-targets"`, target IDs are sorted by
`agentId` before roles are derived. For principal multicast, the first resolved
agent becomes `sender` and the remaining agents become `receiver`.

## Control Server Orchestration

`apps/rallar-black-box-control-server` exposes distributed-run lifecycle APIs on
top of the existing `/runs` command/result store:

- `POST /distributed-runs`
- `POST /distributed-runs/resolve-targets`
- `GET /distributed-runs`
- `GET /distributed-runs/{distributedRunId}`
- `POST /distributed-runs/{distributedRunId}/stage`
- `POST /distributed-runs/{distributedRunId}/start`
- `POST /distributed-runs/{distributedRunId}/cancel`
- `GET /distributed-runs/{distributedRunId}/artifacts`

`POST /distributed-runs/resolve-targets` accepts `{ "manifest": ... }` or a raw
manifest and returns only target-resolution preview. It does not create a
distributed run and queues no commands.

The artifact endpoint is a bounded metadata bundle. CI/export tooling should
write the full artifact directory by downloading `/runs/{controlRunId}/results.jsonl`
and `/runs/{controlRunId}/events.jsonl` directly, then combining those files with
the distributed-run bundle metadata. Distributed bundles include
`target-resolution.json` when target resolution has been performed.

The distributed-run resource links to a lower-level `controlRunId`. Creating a
run records a target preview. Staging re-resolves immediately, freezes
`targetAgentIds` and derived roles on the distributed-run snapshot, then queues
`recipe.load` commands when the manifest contains inline recipes. For
recipe references without an inline recipe, staging queues a `health` preflight
so the target agent can ACK readiness without the server reimplementing a
recipe catalog. Starting queues `recipe.run`; scheduled manifests pass
`startDeadlineEpochMs` through as the command deadline. When `barrier.enabled`
is true, the control server inserts a `barrier` phase between staging and
starting. Each target receives a `health` command with distributed metadata
identifying `barrier.ready`; successful command results are the ready evidence.
`auto-after-ready` starts as soon as all barrier commands pass. `scheduled`
holds the ready run until `startDeadlineEpochMs`; heartbeat/register/result
traffic or a snapshot refresh can advance and dispatch the start commands.
Cancelling queues `recipe.cancel` for target agents and marks the distributed
run terminal.

ACK/readiness is represented by normal command results, not WebSocket send
success. The control server derives participant readiness, running state, pass,
fail, cancel, and exportable artifacts from the linked control-run commands and
results. Expected participant count mismatches fail during staging/start before
commands are queued. Missing stage ACKs after `ackTimeoutMs` roll up to
`timed-out`. Missing barrier readiness after the barrier timeout also rolls up
to `timed-out`; disconnecting while a required agent is waiting at the barrier
rolls up to `failed`.

Distributed artifacts may contain nested `loop` and `parallel` result payloads
inside ordinary command results. Consumers should use
`flattenRallarBlackBoxCompositeResults(...)`,
`toRallarBlackBoxCompositeResultTree(...)`,
`summarizeRallarBlackBoxCompositeResults(...)`, and
`toRallarBlackBoxCompositeDisplayResults(...)` from
`packages/shared-test/rallar-bb-test/composite-results.ts` instead of parsing
runtime-specific child arrays directly. The path contract is documented in
`packages/shared-test/rallar-bb-test/docs/composite-result-contract.md`.

## JSON Schema

`RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA` is exported from
`packages/shared-test/rallar-bb-test/schema.ts` and is part of
`RALLAR_BLACK_BOX_SCHEMA_CATALOG`.

The schema validates the JSON shape. The contract validator adds cross-field
checks that are awkward to express in the lightweight browser-safe schema
helper.

## Compatibility

Distributed run manifests should include `schemaVersion: 1`. Inline
`rallar-bb-test` recipes inside a manifest should also include
`schemaVersion: 1`; older unversioned recipes remain legacy-compatible v1 only
through the recipe compatibility validator.

Adding optional manifest fields or new artifact policy flags is compatible.

Changing lifecycle state names, target policy modes, start modes, or rollup
semantics is a contract change and should update this document, schema tests,
and the command-center iteration plan.
