# Rallar Black-box Test Schemas And Capabilities

`packages/shared-test/rallar-bb-test/schema.ts` is the machine-readable contract
for browser-agent commands and recipes. It sits beside `types.ts`:

- `types.ts` defines the TypeScript runtime contract.
- `schema.ts` defines command capability metadata and JSON Schema objects for
  UI validation, control-server documentation, runner handoff, and future
  distributed-run manifests.

Runtime parsing and distributed artifact analysis must stay aligned with these
schemas. For black-box control/distributed-run behavior, update
`control-protocol.ts`, `control-snapshots.ts`, `distributed-artifact-analysis.ts`,
and generated manifest JSON together so the browser agent, CLI analyzer, SPA,
and Hetzner workflow agree.

## Schema Catalog

The exported catalog is `RALLAR_BLACK_BOX_SCHEMA_CATALOG`.

It currently contains:

- `RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA`
- `RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA`
- `RALLAR_BLACK_BOX_CONTROL_COMMAND_ENVELOPE_SCHEMA`
- `RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA`

`packages/shared-test/black-box-runner/schema.ts` owns the separate
`BLACK_BOX_RUNNER_SCENARIO_RECIPE_SCHEMA`. That schema describes runner
scenarios with `variables`, `connections`, and `steps`. It intentionally stays
provider-neutral and does not mirror Rallar facade internals.

The distributed-run manifest and lifecycle contract are documented in
`packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md`.

Prompting guidance for using these schemas with AI recipe generation is in
`packages/shared-test/rallar-bb-test/docs/ai-recipe-prompt-guide.md`.

Schema compatibility guidance for AI prompt authors and external tools is in
`packages/shared-test/rallar-bb-test/docs/schema-compatibility-guide.md`.

Composite browser-agent primitive planning is documented in
`packages/shared-test/rallar-bb-test/docs/rallar-bb-test-composite-primitives-iterations.md`.

Composite result paths, flat summaries, trees, timelines, and redacted display
entries are documented in
`packages/shared-test/rallar-bb-test/docs/composite-result-contract.md`.

Runtime diagnostic payloads for WS/RTC warnings and adapter recoverable
failures are documented in
`packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`.

## Formation Commands

`formation.command` and `formation.readiness` drive the shipped browser room
formation handle, so both are browser-only and both address exactly one room.

`formation.command` issues one of the eight lifecycle commands (`plan`,
`connect`, `activate`, `reconfigure`, `pause`, `resume`, `reset`, `start`) and
returns the group snapshot receipt beside the room formation summary. `layout`
belongs to `connect` and `landing` to `reconfigure`; naming either on any other
command is refused rather than dropped, so a mis-addressed field is reported
instead of silently losing the fence or the landing it asked for.

`formation.readiness` awaits the browser's own room readiness and returns the
summary captured in the tick it resolved. It observes only: it never refreshes
the room and never opens lanes, which is what makes it evidence about the
browser rather than about the harness that drove it. It resolves when the
room's transport state is `open` **and** the room has at least one desired
peer, because an accepted layout with no desired peers reads `open` on the
first tick and would satisfy a bare state check vacuously.

Unlike `rtc.connect`, whose room fields are each independently optional, a
formation command must name its room: an exact `roomRef`, or an
`applicationId` together with a `roomId`. `workspaceId` defaults to `default`
in the browser runtime's own room resolution, not in the control protocol.

## Capability Metadata

`RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` has one entry for every
`RALLAR_BLACK_BOX_TEST_COMMAND_KINDS` value:

- command kind and human title
- required and optional fields
- supported provider modes
- supported runtime surfaces
- live-service requirements
- expected artifacts/evidence
- a validating example command

The capabilities are the source for UI help, catalog filtering, and future
distributed recipe preflight checks.

## RTC Connect Readiness

`rtc.connect.readiness` waits for actual ready-peer health before the command
returns successfully. Its defaults are `minReadyPeers: 1`, `timeoutMs: 5000`,
and `intervalMs: 100`. The command-level timeout should be longer than the
readiness timeout so connection setup does not consume the readiness budget.

For the `browser-rallar` runtime used by browser control agents and
`rallar-remote-browser` distributed runs, missing peers trigger an immediate
exact-room state and topology refresh and no more than one refresh per second
afterward. The point read hydrates the group-scoped presence used for dialing,
then reads through that room's planned and accepted topology.
Refresh receives cancellation and the remaining readiness deadline. Transient
refresh errors are retried, permanent errors fail, and only a later health
result with enough ready peer IDs satisfies readiness.

The command or its active `configure` command must therefore resolve either an
exact `roomRef`, or `applicationId` plus `roomId`; omitted `workspaceId`
defaults to `default`. Preflight emits a warning rather than an error when that
identity is not recipe-resolvable because simulated providers and external
runtime configuration can remain valid. `refreshRoom` is an internal runtime
bridge operation, not a recipe command or public command-schema field.

## RTC Send Boundary And HTTP Result Evidence

`rtc.send` has no `expect` field on the control path: the command schema and
`validateRallarBlackBoxTestCommand` reject it, because no agent runtime ever
evaluates it and a control-dispatched recipe carrying it would validate green
while asserting nothing. The `RallarBlackBoxTestRtcSendCommand.expect`
TypeScript field exists only for the in-process black-box-runner adapter,
which calls `runtime.execute` directly and records runner-side expectations.
Distributed delivery expectations belong in `wait` and `assert` commands.

`http.request` results record `url`, `status`, `statusText`, `ok`, the full
response header record, and the decoded body. Every recorded result value,
failure detail, and the mirrored `rallar.bb.http.response` event passes the
runtime redaction pipeline, so sensitive header and body names (authorization,
cookie, token, ticket, and the other default key substrings) appear as
`<redacted>` in results, events, failures, and artifacts. Header evidence is
therefore assertable from recorded results without extra capture options.

## Wait Absence

`wait` with `absent: true` asserts non-delivery: the agent holds the full wait
window (`timeoutMs`/`deadlineEpochMs`, default 5000 ms — an absence claim is
only as strong as the time spent listening), then scans the whole event
buffer once. Any matching event — buffered before the wait started or arriving
during the window — fails the command with
`RALLAR_BLACK_BOX_WAIT_ABSENCE_VIOLATED` and the offending redacted event in
the result value and error details; an empty scan succeeds with
`matched: false, absent: true`. Past events match by design, exactly like
positive waits. `absent` accepts only `true`; schema and control validation
reject other values. Semantics mirror the black-box-runner's `expect.absent`
waits. Pair every absence wait with a same-scope positive control delivery so
a broken transport cannot masquerade as proven absence. Evaluation lives in
`wait/wait-for-event.ts`; match semantics live in `wait/wait-event-match.ts`.

## Assert Operators

`assert` evaluates a dot-path `source` over the runtime evidence roots
(`state`, `config`, `lastResult`, `events`, `messages`, `diagnostics`,
`reports`, `recent*`, `stats`, `failures`, `resultCache.<commandId>`).
Operators:

- `equals` / `notEquals` / `contains` / `exists` — historical semantics kept:
  `notEquals` passes when the path is missing, and `gte` / `lte` accept only
  values that are already numbers.
- `gt` / `lt` / `between` — runner-comparator parity: values and bounds are
  coerced with `Number(...)` and must be finite; `between` takes an inclusive
  `[low, high]` pair and fails on a malformed pair.
- `length` — exact length of an array or string; anything else fails.
- `matches` — regular-expression source tested against a string value; a
  non-string value or an invalid pattern fails the assert instead of
  throwing.
- `matchesShape` — `json-compare` `compatible` mode: the expected shape is a
  subset the actual value must satisfy with equal values; extra object keys
  and extra array elements in the actual value are allowed.
- `matchesShapeComplete` — `compatible-complete` mode: like `matchesShape`
  but arrays must be complete, so an unexpected array element fails. Extra
  object keys are still allowed in both shape modes.

Failing asserts fail the command with `RALLAR_BLACK_BOX_ASSERT_FAILED`; the
result value and error details carry the redacted `expected`/`actual`
evidence. Evaluation lives in `assert/assert-value-operators.ts`.

## Loop Until Polling

`loop` with `until: 'first-success'` is the distributed twin of the runner's
`http.poll-until`: every attempt runs the child commands in order and stops
the attempt at its first failing child; the loop exits successfully on the
first attempt in which every child succeeds. Between failed attempts the
agent sleeps `intervalMs x backoffMultiplier^n` (optional `backoffMultiplier`
of at least 1, default 1, flat). Exhausting `count`, `durationMs`, or the
command deadline fails with `RALLAR_BLACK_BOX_LOOP_UNTIL_EXHAUSTED` carrying
the attempt count and the last failing (redacted) child result.
`continueOnFailure` contradicts until mode and is rejected at every
boundary; `backoffMultiplier` without `until` is rejected too. Pacing
iteration entries record the backoff-aware schedule, so drift/jitter
observability stays valid; configured thresholds still evaluate on success.
Orchestration lives in `loop/loop-until.ts`.

## Group Assertions

Distributed run manifests may declare a `groupAssertions` block evaluated
coordinator-side by the control server after every dispatched recipe result
completed — invariants over the collected evidence of every targeted agent
(`allMatch`, `noneMatch`, `countMatching`, `allEqual`, `allEqualWithin`).
Typed sources are `{ recipeId, commandId, path }`; predicates reuse
`assert/assert-value-operators.ts`, so the agent and coordinator vocabularies
cannot drift. Contract, participation rules, and failure codes live in
`distributed-run-contract.md`; evaluation lives in
`distributed/group-assertions-evaluation.ts` with the schema branch in
`distributed/rallar-black-box-group-assertions-schema.ts`.

### Comparison Vocabulary Boundary

Three comparison vocabularies exist deliberately, and a fourth is prohibited:

- `sameJsonValue` (`wait/wait-event-match.ts`) — `JSON.stringify` equality;
  the agent-side match primitive behind `wait` matching and the historical
  `equals` / `notEquals` / `contains` assert operators.
- `json-compare` (`CompareJson`) — structural shape modes behind
  `matchesShape` (`compatible`) and `matchesShapeComplete`
  (`compatible-complete`); its `exact` mode matches arrays
  order-insensitively.
- `deepEqualJson` (`distributed/group-assertions-aggregates.ts`) — group
  agreement equality for `allEqual`: object-key-order insensitive,
  array-order sensitive. Explicitly not `sameJsonValue` (which is
  key-order sensitive via serialization) and not `json-compare` `exact`
  (which is array-order insensitive).

Pick the vocabulary by claim: event matching -> `sameJsonValue`; shape
containment -> `json-compare` modes; cross-agent agreement ->
`deepEqualJson`. The assertion-outcome parity and group-assertion
conformance suites pin these semantics.

## Validation

Use `validateJsonSchema(schema, value)` for lightweight browser-safe validation.
Use `formatJsonSchemaValidationErrors(errors)` for operator-facing errors.
Use `validateRallarBlackBoxRecipeCompatibility(value)` when a tool needs the
v1 compatibility decision plus warnings for legacy recipes that omit
`schemaVersion`.

Current automated coverage validates:

- every capability example
- app-local SPA recipe examples
- local recipe fixtures
- composite fixture authoring for `loop`, `parallel`, `wait`, and `assert`
- Manual Rallar recipe snippets
- Flow Builder SPA recipe exports
- Flow Builder black-box-runner scenario exports
- Run Manager command presets
- every shared-test black-box-runner example recipe
- control-server OpenAPI command examples
- control command envelopes
- distributed-run manifest examples
- distributed-run lifecycle states, domain validation, and rollup behavior
- distributed-run barrier synchronization, timeout, disconnect, cancellation,
  and scheduled-start orchestration
- group-member to control-agent matching and target-policy filtering
- recursive schema-authoring hints for child commands inside `loop`,
  `parallel`, `recipe.load`, and `recipe.run`
- composite result flattening, source recipe paths, parent/child trees,
  failure summaries, and redacted display entries
- runtime diagnostic normalization, wait/assert matching, browser-adapter
  ingestion, and known live WS/RTC console warning bridging
- composite conformance recipes, provider rows, live requirements, and compact
  report artifacts
- the v1 golden compatibility corpus for valid recipes, invalid recipes,
  distributed manifests with inline recipes, and representative AI-generated
  examples
- group-assertion contract validation, rollup integration, and a conformance
  case per aggregate with a deliberately-broken control
- JSON examples in the schema compatibility guide

## Compatibility Rules

Treat schema changes as public command-center contract changes.

- New `rallar-bb-test` recipes should include `schemaVersion: 1`.
- Recipes without `schemaVersion` remain legacy-compatible v1 recipes for now;
  compatibility validation returns a warning so authoring tools can guide users
  toward explicit versioning.
- Unsupported explicit recipe schema versions are invalid.
- Distributed run manifests should include `schemaVersion: 1`, and inline
  recipes inside manifests should also include `schemaVersion: 1`.
- Adding optional fields to an existing command is compatible.
- Tightening a field type is a breaking change unless all shipped recipes and
  examples already satisfy it.
- Adding a new command kind requires:
  - a TypeScript command type in `types.ts`
  - capability metadata
  - a command schema branch
  - at least one validating example
  - command-center and runtime tests
- Removing or renaming a command kind is breaking and should require an
  explicit migration note.
- Runner scenario schema changes should preserve the generic HTTP/WS/RTC/ASSERT
  boundary. Do not add Rallar-specific facade operations to the runner core.

CRDT command kinds are browser-agent commands, not runner-core operations.
`crdt.open`, `crdt.apply`, `crdt.read`, `crdt.sync`, `crdt.health`,
`crdt.wait`, `crdt.undo`, `crdt.redo`, `crdt.close`, and `crdt.destroy` delegate to the
browser Rallar CRDT facade through the optional runtime `crdt` surface. Runner
scenarios may reference these as `crdt.*` steps only when the selected provider
can forward them to a browser agent.

Composite command kinds are browser-agent orchestration primitives. `loop` and
`parallel` may contain child commands from the same `rallar-bb-test` vocabulary,
but they must stay transport-neutral and bounded by the exported composite
limits. Runtime execution for `loop` is available for sequential repeated child
commands. Runtime execution for `parallel` is available for bounded concurrent
groups with sequential child commands inside each group.

Schema-authoring views and catalog previews should inspect nested child
commands recursively. A top-level `loop` or `parallel` can still require live
Rallar services when a child command uses `rtc.*`, `ws.*`, or `http.request`.
The same recursive rule applies to inline recipes under `recipe.load` and
`recipe.run`.

`loop` and `parallel` results can be normalized with the exported helpers in
`composite-results.ts`. Callers can turn nested composite output into a stable
flat tree order, chronological timeline, parent/child tree, failure summary,
and redacted display entries without knowing runtime internals. Result paths
start at `$`; source recipe paths map back to command templates such as
`$.groups[0].commands[0]` while runtime paths include loop iterations and
parallel group IDs.

Loop results also include load-oriented observability. `value.pacing` records
requested interval/rate, actual iteration timestamps, elapsed time, drift,
jitter, skipped iterations, and cancelled iterations. `value.sends` records
send counts, success ratio, duration statistics, queued/enqueued/backpressure
counts, dropped/replaced payload counts, per-transport failure counts, and raw
send observations when the adapter can expose them. `loop.thresholds` can fail
the parent command with `RALLAR_BLACK_BOX_LOOP_THRESHOLD_FAILED` when achieved
rate, drift, jitter, send success ratio, or backpressure evidence misses the
configured limits. The `stats` command mirrors the latest loop under
`stats.load` without raw iteration or send observation arrays for SPA and
artifact summaries.

`rtc.stream` is the high-rate RTC traffic primitive. Use it when a recipe wants
to model a realtime stream, such as 100 frames at 20 Hz, without expanding that
stream into hundreds of sequential `rtc.send` commands. A stream command owns
frame scheduling inside the browser agent, sends frames against a fixed
wall-clock cadence, and returns one aggregate result with planned, attempted,
completed, failed, dropped, and backpressured frame counts. It also records
send duration percentiles (`p50Ms`, `p95Ms`, `p99Ms`, and `maxMs`), achieved
schedule/completion Hz, pacing drift, jitter, threshold failures, and sampled
frame observations.

`rtc.stream` differs from `loop` plus `rtc.send`: `loop` intentionally awaits
each child command and is best for deterministic command-rate workflows,
retries, and evidence trees. `rtc.stream` schedules frames without waiting for
the previous frame to finish before scheduling the next one, so it is the right
shape for realtime performance baselines. Keep using plain `rtc.send` for
single-message smoke tests, provider parity checks, NACK diagnostics, and flows
where each send should be a distinct command result.

Stream payloads support stream placeholders after normal config/session
placeholders are resolved: `{stream.index}`, `{stream.iteration}`,
`{stream.elapsedMs}`, `{stream.scheduledElapsedMs}`, and
`{stream.commandId}`. Recipes must provide `count` or `durationMs`, and
`intervalMs` or `rateHz`. `maxInFlight` bounds memory and backpressure; frames
above the in-flight limit are recorded as dropped instead of creating unbounded
promises. `rtc.stream.thresholds` can fail the command when delivery,
backpressure, latency, drift, or jitter misses configured limits.

Composite conformance coverage lives in `composite-conformance.ts`. It defines
the representative `loop`, `parallel`, `wait`, `assert`, cancellation, and
negative delivery recipes plus provider rows for deterministic local,
browser-rallar, and remote-browser/control-server execution. The companion
report shape compares expected recipe behavior with observed command results,
diagnostics, redacted failures, provider capability differences, and compact
composite summaries.

`wait` is a browser-agent evidence primitive. It observes current and future
runtime events, messages, diagnostics, stats, reports, and results without
reimplementing Rallar behavior. Match fields are intentionally simple: event
kind, topic, command ID, connection, transport, severity, and payload-path
`equals`, `contains`, or `exists`. Wait results include the matched event after
the standard redaction pipeline. If neither `timeoutMs` nor `deadlineEpochMs`
is supplied, the runtime uses a 5 second default timeout.

Cancellation and deadlines are part of the runtime contract. `recipe.cancel`
requests cancellation through the active runtime abort signal, so waits, loop
interval sleeps, browser HTTP requests, WebSocket open waits, and browser
Rallar RTC/WS calls can stop before their ordinary timeout when supported by
the host API. Failed, cancelled, or timed-out `recipe.run` execution invokes
the optional runtime cleanup hook; the browser adapter uses that hook to close
owned WebSockets, detach listeners, and close the browser Rallar runtime.

Direct duplicate commands still use `commandId` replay for idempotent retries.
Child commands inside a new `recipe.run` are executed with cache bypass, so a
second recipe run with the same child `commandId` values does not inherit stale
results, messages, sockets, or RTC state from a failed or cancelled prior run.

WS/RTC runtime diagnostics should use
`normalizeRallarBlackBoxRuntimeDiagnostic(...)` before they are recorded as
`kind: "diagnostic"` evidence. Normalized payloads expose
`diagnosticSchemaVersion`, `diagnosticTypeId`, `message`, `transport`,
`severity`, connection/group/peer identifiers, and structured `data`/`error`
details. `wait` can match these diagnostics by event fields and payload paths,
and `assert` can read them through `diagnostics` or `recentDiagnostics`.

`assert` is a small browser-agent evidence check. It reads only whitelisted
runtime sources: `state`, `config`, `currentConfig`, `lastResult`, `events`,
`messages`, `diagnostics`, `reports`, `recentEvents`, `recentMessages`,
`recentDiagnostics`, `latestStats`, `stats`, `failures`, and `resultCache`.
Supported operators are the full set documented under "Assert Operators"
above, from the historical `equals` / `notEquals` / `contains` / `exists` /
`gte` / `lte` through the extended `gt` / `lt` / `between` / `length` /
`matches` / `matchesShape` / `matchesShapeComplete`. It is not a JavaScript
evaluator; source strings are dot paths into those read-only roots. Assertion
values and errors pass through normal redaction.

Distributed-run manifests can opt into a control-server barrier:
`"barrier": { "enabled": true, "timeoutMs": 5000 }`. The barrier is not a new
browser-agent command kind; the control server queues ordinary `health`
commands linked with the distributed `barrier` phase and treats their successful
results as `barrier.ready` evidence before auto or scheduled starts proceed.

## Ownership

`rallar-bb-test` owns browser-agent command and recipe schemas.

`black-box-runner` owns scenario schemas for external runner recipes.

`apps/rallar-black-box` should consume these schemas for JSON editors,
preflight validation, catalog badges, and distributed-run authoring. The SPA
should not keep separate command-shape validators except for UI-specific checks.

`apps/rallar-black-box-control-server` should expose the shared command schema
in OpenAPI and validate inbound command payloads before queueing.
