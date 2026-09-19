# Distributed Run Contract

`packages/shared-test/rallar-bb-test/distributed-run.ts` defines the shared
contract for distributed recipe execution. It is intentionally a contract only:
it does not open sockets or run browser automation. Its behavior lives beside
it: `distributed-run-validation.ts` decodes and validates manifests,
`distributed/resolve-distributed-run-targets.ts` resolves target agents, and
`distributed/distributed-run-rollup.ts` rolls up run results. The control server now uses
this contract to create distributed-run resources and to enqueue ordinary
`rallar-bb-test` commands to browser agents.

Control snapshot wire types, distributed artifact bundle types, artifact
analysis helpers, and reusable recipe fixtures also live under
`packages/shared-test/rallar-bb-test`. The SPA may re-export compatibility
symbols, but shared distributed-run behavior should start in this package.

## Manifest

`RallarBlackBoxDistributedRunManifest` is the JSON shape used to describe one
distributed recipe test independent of React component state.

Every author setting is required and written explicitly: a manifest that omits
one is rejected by the schema with `Missing required property ...`, and nothing
fills it in with a default. Required fields:

- `schemaVersion: 1`, `distributedRunId`, and `controlRunId` (the lower-level
  control-server run; write the `distributedRunId` when the run has no separate
  control run).
- `group.applicationId`, `group.workspaceId`, and `group.groupId`.
- `recipes`: at least one selection. Each selection writes `recipeId` and
  `variables` (`{}` when none).
- `targetPolicy`: a tagged union on `mode`. `selected-agents` writes `agentIds`,
  and `role-map` writes `roles`. A policy carrying the other mode's field is
  rejected.
- `variables`: shared run-level inputs (`{}` when none).
- `roleAssignments`: per-agent role and recipe assignment (`[]` when roles come
  from `targetPolicy.roles` or a pattern). Each assignment writes `role`,
  `agentId`, `recipeIds` (`[]` when the agent runs every selection for its role),
  and `variables`.
- `ackTimeoutMs`: readiness/ACK timeout before the run is considered failed or
  timed out.
- `barrier`: `{ "enabled": false }`, or `{ "enabled": true, "timeoutMs": ... }`
  for the start-synchronization phase. When enabled, the control server queues
  one `barrier` command per target after all stage ACKs have passed and waits for
  `barrier.ready` evidence for `timeoutMs` before the run can start. A disabled
  barrier carries no `timeoutMs`.
- `startMode`: `manual`, `auto-after-ready`, or `scheduled`. Only `scheduled`
  carries `startDeadlineEpochMs`, and it must.
- `groupAssertions`: coordinator-evaluated invariants over the collected
  evidence of every targeted agent (`[]` when none). See "Group Assertions" below.
- `metadata`: free-form author metadata (`{}` when none).

Fields that stay optional, each absent only with the stated meaning:

- `displayName` and `description`: absent when the author gives the run none.
- `recipes[].recipe`: absent when the selection references a catalog recipe the
  agent loads by `recipeId`.
- `recipes[].role`: absent when the recipe runs on every targeted agent.
- `recipes[].profile`: absent when the selection names no catalog profile.
- `targetPolicy.expectedParticipantCount`: absent when staging accepts however
  many agents the policy resolves.
- `roleAssignmentPolicy`: absent when roles come from `targetPolicy.roles` or
  `roleAssignments`. When present it writes `mode: "ordered-targets"`, a
  `pattern` (`all-agents`, `sender-receiver`, `one-sender-many-receivers`, or
  `three-browser-matrix`), and `orderBy: "agent-id"`.

The schema rejects every other field as `Unexpected property.`, including the
removed `secretRefs` (manifest and recipe selection),
`targetPolicy.includeOfflineExpectedAgents`, and `artifactPolicy`: no reader
ever acted on them. The removed `recipes[].required` and
`roleAssignments[].required` flags are rejected the same way: they never
changed the verdict, and every recipe selection and role assignment counts
toward it.

Use `decodeDistributedRunManifest(value)` from `distributed-run-validation.ts`
to decode JSON: it runs the schema, then
`validateDistributedRunManifestContract(manifest)` for domain checks such as:

- recipe selection `recipeId` must be a non-empty string
- `selected-agents` requires at least one agent ID
- `role-map` requires roles or role assignments
- only the policy mode that owns `agentIds` or `roles` may carry it
- scheduled runs require `startDeadlineEpochMs`, and only they accept it
- ACK timeout and expected participant count must be positive integers
- an enabled barrier requires a positive integer `timeoutMs`; a disabled one
  accepts none
- group assertion IDs must be unique; sources must reference a manifest recipe
  key (and, for inline recipes, an authored `commandId`); `scope.role` must be
  a declared role unless a role-assignment pattern policy derives roles;
  `countMatching` needs at least one bound and `allEqualWithin` a tolerance
  `>= 0`; `minParticipants` must be an integer `>= 1`

`validateDistributedRunManifest(manifest)` returns the same issues for an
already typed manifest, empty when it is valid.

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
- Every participant and recipe result blocks the run: timeouts roll up to
  `timed-out` and cancellations to `cancelled`.
- Failures, disconnected participants, or `ok: false` roll up to `failed`.
- Failed group assertion results are blocking failures with
  `kind: 'group-assertion'`; a run whose recipes all passed still rolls up to
  `failed` when any group assertion failed.
- If all recipe results passed, the distributed run is `passed`.
- If any participant or recipe is running, the distributed run is `running`.
- If all participants are ready before recipe execution, the run is `ready`.
- If stage ACKs passed but the optional barrier has not finished, the run is
  `waiting-for-barrier`.
- If any participant has acknowledged but not all are ready, the run is
  `waiting-for-ack`.
- Otherwise the state remains the supplied non-terminal hint or `draft`.

The rollup returns a summary and a `failures` array that can feed the future UI
and artifact export. When the manifest declares `groupAssertions`, the summary
carries `groupAssertions` / `passedGroupAssertions` / `failedGroupAssertions`
counts and the rollup echoes each per-assertion result.

## Group Assertions

`groupAssertions` is the assertion altitude neither per-agent dialect has:
invariants over the collected evidence of every agent in the shared group,
evaluated **coordinator-side** by the control server's distributed-run rollup
after every dispatched recipe result completed. Agents are unchanged, so the
agent capability gate does not apply; an old control server rejects the field
at manifest validation (fail closed), and dispatch tooling validates before
POSTing.

Every assertion reads one result value from every participating agent through
a typed address `{ recipeId, commandId, path }`: the manifest recipe key, the
authored command ID inside that recipe's composite result (loop and parallel
children included), and a payload path into that command result's `value`.
Value predicates reuse the assert operator vocabulary from
`assert/assert-value-operators.ts`, so agent-side and coordinator-side
semantics cannot drift.

The v1 aggregate vocabulary is fixed, strict, and deterministic:

- `allMatch` — every participating agent's value satisfies the predicate.
- `noneMatch` — no participating agent's value satisfies the predicate; kept
  as a named aggregate because the intent and diagnostics are clearer than
  `countMatching == 0`.
- `countMatching` with `count.equals` / `count.gte` / `count.lte` — quorum
  checks against the frozen participant denominator.
- `allEqual` — every agent contributed the same JSON value under
  `deepEqualJson` (object-key-order insensitive, array-order sensitive;
  deliberately not `isSameJsonValue` and not `json-compare` exact).
- `allEqualWithin` — numeric agreement within an absolute `tolerance`;
  non-numeric evidence marks the holder violating.

Authoring rule: when the expected value is known, use `allMatch equals X` —
`allEqual` alone passes when every agent agrees on the same wrong value; the
two compose ("all equal AND the first one matches X").

Participation rules, mandatory on every group assertion:

- The participant set is **frozen at target resolution** from the run
  snapshot's `targetResolution`; late joins and drops never change the
  denominator.
- Missing, duplicate, unresolved, or undecodable evidence at the address
  **fails by default** with
  `RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING`; absence of evidence
  is never a pass. Evidence is `undecodable` when the addressed command is not
  among the agent's decodable command results and one of its recorded command
  results or composite children does not decode, so the command may be hidden
  there.
- `scope.role` narrows participants to a manifest role; `minParticipants` is
  the only explicit relaxation and only excuses missing agents — duplicate,
  unresolved, or undecodable evidence still fails. A scope no frozen
  participant holds fails with
  `RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS`.
- Aggregate violations fail with
  `RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED`; failure details carry a
  redacted per-agent value table identifying missing and violating agents by
  agent ID, and the same codes flow into `failures.json` and the artifact
  analyzer vocabulary.

Group assertions are exclusively run-failing **correctness** gates in v1;
fleet performance and SLO evidence stays in artifact-analysis thresholds.

Evidence retention: the control server stores start-phase recipe results for
group-assertion runs uncompacted (other recipe results keep the compact
`resultCount` projection), because the per-command composite results are the
coordinator's evidence source. Raw values stay in memory only; every value
that reaches results, failures, or artifacts passes the redaction pipeline
first.

## Target Resolution

The shared target-resolution contract is used before a distributed run is
created or staged. It supports both fixed local/Hetzner agent IDs and
already-running world-fleet agents that must be resolved from live control
server state.

Control agents report `RallarBlackBoxControlAgentIdentity` on register and
heartbeat. `sessionLabel` and `updatedAtEpochMs` are always written; the other
facts are absent when the agent's configuration omits them, and `capabilities`
is absent until the agent loads a test configuration:

- `principalId`, `clientId`, and `username`
- `sessionId` and `clientInstanceId`
- `applicationId`, `workspaceId`, and `groupId`
- `providerMode`
- `browserLabel` and `sessionLabel`
- `updatedAtEpochMs`

The agent reads each fact from the configuration keys producers write: the
principal, client and client instance are the configured `actor`, which also
names the user unless `rallar.username` does; `sessionId` is the configured
`sessionId`; application and workspace come from `defaults`, or else `rallar`;
the group is `defaults.groupId`, or else `roomId`; the provider mode is
`control.providerMode`; `browserLabel` is the page's user agent; browser name,
version, OS and the other fleet facts come from `fleet`.

Every register and heartbeat envelope carries an identity. An envelope without
one is rejected (`Control register requires identity.` / `Control heartbeat
requires identity.`), and so is one whose identity does not decode; nothing in
it is read as absent. A configured fleet location that does not decode is left
out of the agent's identity and reported once, as a
`rallar.bb.control.identity_invalid` diagnostic, until it changes.

The operator target-row projection uses a normalized duplicate identity key of
`applicationId`, `workspaceId`, `groupId`, the first reported
`principalId`/`clientId`/`username`, and `sessionId`. String parts are trimmed
and compared case-insensitively. Two fresh connected agents with the same key
are both `duplicate-session`; `clientInstanceId` does not split one authenticated
session into independently targetable agents. Stale, offline, wrong-group, and
incomplete-identity rows keep their more specific evidence status and do not
make an otherwise unique fresh session look duplicated.

`resolveDistributedRunTargets(...)` is the resolver used by the control
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
`computeDistributedAssertionFeatures(...)`. A targeted agent that does not
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
`toRallarBlackBoxCompositeResultFlatEntries(...)`,
`toRallarBlackBoxCompositeResultTree(...)`,
`computeRallarBlackBoxCompositeResultSummary(...)`, and
`toRallarBlackBoxCompositeDisplayResults(...)` from
`packages/shared-test/rallar-bb-test/composite-results.ts` instead of parsing
runtime-specific child arrays directly. The path contract is documented in
`packages/shared-test/rallar-bb-test/docs/composite-result-contract.md`.

## Artifact Analysis

`computeDistributedRunArtifactAnalysis({ files, generatedAtEpochMs })` in
`distributed-artifact-analysis.ts` analyzes a distributed-run artifact folder
and returns an `Either`: a `DistributedRunArtifactRejection` (the file and why
it cannot be analyzed) or a `DistributedRunArtifactAnalysis`. The caller reads
the clock and passes `generatedAtEpochMs`; the analysis never does.

- A `DistributedRunAnalysis` is a `DistributedRunPassedAnalysis` (`ok: true`)
  or a `DistributedRunFailedAnalysis` (`ok: false`, with its required `failure`
  and `fixProposalMarkdown`). The schema version and control run id are always
  written; consumers that read a bounded projection (the Analyze view, tuning
  decisions) declare their own narrower contract.
- `distributed-run.json` is decoded strictly against
  `ControlDistributedRunSnapshot`. A missing, empty, malformed or non-conforming
  file is a rejection; no identity, timestamp, start mode or command link is
  filled in.
- `control-run.json` is decoded just as strictly against `ControlRunSnapshot`,
  but it is optional evidence: the Hetzner runner exports it only when it has a
  control run id and can fetch the run. When it is missing, empty, malformed or
  non-conforming, a parse warning names the file, and the analysis omits only
  what needs the control run: `performance`, `performanceMarkdown` (and so
  `performance.md`), the `spa` report and verdict and, without a fleet report,
  `summary.agents`. `summary.md` says that performance and the SPA report and
  verdict were not analyzed and why. Without that report, the failure focus
  explains the first failure `distributed-run.json` records instead of the
  report's next action.
- A folder with `control-post-error-metadata.json` and no
  `distributed-run.json` is the `control-request-failure` variant: the run id
  from `runner-summary.json` or `manifest.json`, the failed request, its status,
  what the artifacts hold of its response body (none, a JSON body, a body that
  is not JSON, or a named file that is missing), a failure analysis and a fix
  proposal, with no snapshot, performance or monitor sections. `summary.md` and
  `fix-proposal.md` quote a bounded excerpt of a recorded body. Any other folder
  without `distributed-run.json` is rejected. That variant requires a conforming
  request record; its `runner-summary.json` and `manifest.json` are optional
  evidence, so a malformed one is a parse warning and the run is named from the
  other. Beside a distributed run the request record is optional evidence too: a
  malformed record is a parse warning and the failure focus ignores it.
- `target-resolution.json` is decoded with the snapshot's target resolution
  decoder: `null` means no resolution and a non-conforming record is a parse
  warning. `fleet-report.json` must be a JSON object whose verdict, summary
  counts, timing and group have the JSON types the analysis reads;
  `failures.json` must list its failures as JSON objects; `manifest.json`
  beside a distributed run must be a JSON object. A file that is not valid
  JSON or not its contract is a parse warning and its evidence is left out.
  `results.jsonl` and `events.jsonl` are read into typed evidence rows; rows
  that are not JSON objects become parse warnings.
  A fact the artifacts do not record stays absent — without a fleet report the
  missing, stale and flaky agent counts are unknown, not zero. JSONL rows stand
  in for control-run results or events only when `control-run.json` holds
  none. A result row stands in when it names its agent, command and outcome; an
  event row also needs its time, envelope kind and payload. Every other JSON
  object row is a parse warning naming the file, the line and the missing field,
  except the `step-result` rows the recorder mirrors into `events.jsonl`, which
  stand in for no event.
- `toDistributedArtifactSnapshots` rejects when the files hold no readable
  distributed run, and with the control-run.json warning when that file is
  unavailable. `toDistributedArtifactBundle` rejects in the same cases and also
  when `manifest.json` is missing, where the snapshots still form without an
  `artifactBundle`. Snapshots carry the same `parseWarnings` as the analysis,
  including the rejection that explains a missing `artifactBundle`.
  `computeDistributedArtifactWorkspace` reports rejections as workspace issues
  (`analysis-failed`, `control-request-failure`, `missing-generation-time`); a
  workspace without a usable `control-run.json` carries the analysis but no
  snapshots or bundle, and a `control-run.json` that is valid JSON but not a
  control run snapshot makes it `incompatible` with an `incompatible-file` issue
  naming the file.

Capability owners live in `distributed-artifact-analysis/` (content decoding,
evidence row decoders, the pipeline analysis and bundle formation that the
workspace and evidence index share, failure resolution, markdown) and
`distributed-run-performance/` (command timing, the stream sample index, stream
timing and receiver delivery). `mod.ts` exports the analysis contracts, the
three file-level entry points and `computeDistributedRunSnapshotPerformance`
for snapshot-only callers; the pipeline analysis and the evidence-typed
performance computation stay behind their owner modules.

## JSON Schema

`RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA` is exported from
`packages/shared-test/rallar-bb-test/schema.ts` and is part of
`RALLAR_BLACK_BOX_SCHEMA_CATALOG`.

The schema validates the JSON shape. The contract validator adds cross-field
checks that are awkward to express in the lightweight browser-safe schema
helper.

## Compatibility

Distributed run manifests should include `schemaVersion: 1`. Every inline
`rallar-bb-test` recipe must include `schemaVersion: 1`, including recipes nested
inside commands. Missing or unsupported versions fail validation before dispatch;
no automatic conversion or saved-recipe migration is provided.

Author settings are required, so a manifest written before a setting became
required stops validating until it writes that setting explicitly. Adding a new
author setting is therefore a contract change: regenerate the checked-in
manifests and update fixtures, examples, and prompt templates in the same change.

Changing lifecycle state names, target policy modes, start modes, or rollup
semantics is a contract change and should update this document, schema tests,
and the command-center iteration plan.
