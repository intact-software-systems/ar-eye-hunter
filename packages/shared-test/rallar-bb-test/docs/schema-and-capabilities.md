# Rallar Black-box Test Schemas And Capabilities

`packages/shared-test/rallar-bb-test/schema.ts` is the machine-readable contract
for browser-agent commands and recipes. It sits beside `types.ts`:

- `types.ts` defines the TypeScript runtime contract.
- `schema.ts` defines command capability metadata and JSON Schema objects for
  UI validation, control-server documentation, runner handoff, and future
  distributed-run manifests.

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
Supported operators are `equals`, `notEquals`, `contains`, `exists`, `gte`, and
`lte`. It is not a JavaScript evaluator; source strings are dot paths into those
read-only roots. Assertion values and errors pass through normal redaction.

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
