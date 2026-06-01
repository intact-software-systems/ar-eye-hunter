# Rallar BB Test Composite Primitive Iterations

Date: 2026-05-31

## Goal

Add recipe-level control primitives to `rallar-bb-test` so browser agents can
express repeated and concurrent communication patterns without expanding every
network call into a long flat command list.

The immediate requested primitives are:

- `loop`: repeat one or more browser-agent commands with configurable cadence.
- `parallel`: run bounded groups concurrently, with sequential commands inside
  each group.

These primitives should help the SPA Distributed Recipes surface, the control
server, and remote browser agents. They should not turn `rallar-bb-test` into a
second `black-box-runner` or a second Rallar facade.

## Current State

`rallar-bb-test` currently executes browser-agent recipes as a flat sequential
array of commands. This is enough for simple smoke flows, but it makes realtime
traffic recipes noisy. For example, a 20 Hz RTC position stream currently needs
one generated `rtc.send` command per frame.

`black-box-runner` already has richer scenario-level primitives:

- `execution.soak` for same-connection repeated traffic.
- `execution.trafficPlan` for seeded reproducible traffic.
- `type: "parallel"` for bounded concurrent groups.
- `ASSERT`, `SET`, HTTP/WS/RTC waits, output extraction, artifacts, and reports.

Distributed recipes already provide concurrency across browser agents, because
multiple connected agents can receive and run commands at the same time. The
missing capability is intra-agent recipe structure: looped command sequences
and bounded parallel groups inside one browser-agent recipe.

## Boundary

Keep these guardrails:

- Do not add direct Rallar facade commands such as `rooms.join`,
  `messages.rtc.send`, `realtime.sendJson`, `data.open`, or `media.start`.
- Keep child commands in the existing portable `rallar-bb-test` command
  vocabulary: HTTP, WS, RTC, health, stats, close, reset, and recipe commands.
- Composite commands should be transport-neutral. They orchestrate child
  commands; they do not know Rallar internals.
- Browser-agent recipes should remain safe to ship over the control server as
  JSON and validate with JSON Schema before execution.
- Add command-count, depth, and concurrency safeguards so bad recipes cannot
  accidentally create unbounded browser work.

## Primitive Analysis

### Add To `rallar-bb-test`

`loop` is the highest-value primitive. It reduces generated command noise and
lets tests express repeated WS/RTC/HTTP traffic with a readable cadence.

`parallel` is the second priority. It makes one browser agent able to run
independent command groups concurrently, while preserving simple sequential
reasoning inside each group. This mirrors the existing `black-box-runner`
parallel model.

`wait` is also worth adding after loop/parallel. Today recipes can send and
record events, but they cannot directly wait for a browser-agent event,
diagnostic, message, or result before continuing. A generic wait command would
make distributed live tests less timing-sensitive.

`assert` is useful if it stays small: assert against current runtime state,
last command result, received events/messages, or a simple JSON path. Avoid a
large expression language.

`delay` should not be added first. `metadata.localDelayMs` already covers local
pacing, and `loop.intervalMs` should cover the common repeated-delay case. Add
an explicit `delay` command only if recipes need a visible no-op step.

`set` and general output variables should be deferred. `black-box-runner`
already owns full scenario variables and output extraction. `rallar-bb-test`
may eventually need lightweight loop variables, but not a full runner variable
engine.

### Add Or Refine In `black-box-runner`

`black-box-runner` already has the main primitives. The most useful follow-ups
are refinements, not new Rallar-specific commands:

- Inline `loop` step shape for readability outside global `execution.soak`.
- More explicit pacing/rate controls for traffic plans, so 20 Hz, 30 Hz, and
  burst traffic can be represented without hand-written delay steps.
- Optional barrier/synchronization support for parallel groups and remote
  browser providers, if live concurrent tests need tighter start alignment.

Do not add Rallar facade methods to `black-box-runner`. Continue expressing
Rallar behavior through HTTP, WS, RTC, ASSERT, SET, waits, and providers.

## Iteration 1: Composite Command Contract

Status: completed on 2026-05-31.

Goal: Define the shared type, schema, and execution contract for composite
browser-agent commands.

Work:

- Add `loop` and `parallel` to `RALLAR_BLACK_BOX_TEST_COMMAND_KINDS`.
- Extend `RallarBlackBoxTestCommand` with recursive child-command types.
- Extend the JSON Schema and command capability metadata.
- Define child command ID generation rules.
- Define result rollup shape for composite commands.
- Define cancellation, fail-fast, continue-on-failure, timeout, and deadline
  behavior.
- Add safeguards:
  - maximum recursion depth
  - maximum expanded command count
  - maximum parallel concurrency
  - maximum loop duration/count

Exit criteria:

- Invalid composite recipes fail schema validation with actionable errors.
- The command model can describe `loop` and `parallel` without requiring
  runner-specific fields.
- Docs explain how composite commands differ from `black-box-runner` steps.

Results:

- Added `loop` and `parallel` to the browser-agent command kind contract.
- Added recursive TypeScript command shapes for loop child commands and
  parallel groups.
- Added composite result-value shapes for future runtime rollups.
- Added exported composite safety limits for max depth, expanded command count,
  loop count/duration, and parallel concurrency.
- Added JSON Schema branches and command capability metadata with validating
  examples.
- Updated control-protocol validation so control commands and inline recipes can
  validate composite shapes recursively.
- Added explicit runtime failure for composite commands until execution
  semantics land in later iterations, preventing silent fake success.
- Updated schema/capability docs and companion-coverage boundary text.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts` passed.

## Iteration 2: `loop` Primitive In `rallar-bb-test`

Status: completed on 2026-05-31.

Goal: Run one or more child commands repeatedly inside a browser-agent recipe.

Suggested shape:

```json
{
  "kind": "loop",
  "commandId": "rtc-position-loop",
  "count": 100,
  "intervalMs": 50,
  "continueOnFailure": false,
  "commands": [
    {
      "kind": "rtc.send",
      "commandId": "position-send",
      "send": {
        "roomId": "arena-1",
        "data": {
          "topic": "room.position",
          "seq": "{loop.index}"
        }
      }
    }
  ]
}
```

Work:

- Execute child commands sequentially per iteration.
- Support `count` and bounded `durationMs`.
- Support `intervalMs` or `delayMs` between iterations.
- Add loop placeholders:
  - `{loop.index}` zero-based command-loop index
  - `{loop.iteration}` one-based iteration index
  - `{loop.elapsedMs}`
  - `{loop.commandIndex}`
- Annotate child results with loop metadata.
- Make cancellation stop before the next child command or next iteration.
- Add tests for success, failure, cancellation, placeholder substitution,
  interval timing, and command-count limits.

Exit criteria:

- A recipe can express repeated RTC/WS/HTTP traffic without generating every
  repeated command upfront.
- Composite result payload contains enough detail for the SPA and artifacts to
  show iteration failures.

Results:

- Implemented executable `loop` commands in the in-memory browser-agent runtime.
- Added deterministic child command IDs using parent loop ID, iteration, child
  position, and original child command ID.
- Added recursive placeholder replacement for `{loop.index}`,
  `{loop.iteration}`, `{loop.elapsedMs}`, and `{loop.commandIndex}`.
- Added loop metadata to child commands so adapters and artifacts can connect
  child execution back to the parent loop.
- Added loop result rollups with iteration count, child result count, pass/fail
  counts, cancellation status, and per-child results.
- Added runtime validation for invalid count, duration, interval, delay, and
  max-command settings.
- Added fail-fast behavior by default, `continueOnFailure` support, cancellation
  handling before later child commands, interval pacing, duration-bounded loops,
  and max child command safeguards.
- Kept `parallel` as a contract-only command until its implementation
  iteration.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts` passed.

## Iteration 3: Convert `rtc-realtime` To `loop`

Status: completed on 2026-05-31.

Goal: Use the new `loop` primitive for the SPA `rtc-realtime` distributed
recipe.

Work:

- Replace generated per-frame `rtc.send` commands with one `loop` command.
- Keep the UI duration field in Distributed Recipes.
- Keep the target rate at 20 Hz by default.
- Preserve payload fields:
  - `seq`
  - `rateHz`
  - `durationSeconds`
  - `totalFrames`
  - `position`
- Update manifest preview so users can see both the compact command count and
  the effective frame count.
- Update tests and docs.

Exit criteria:

- `rtc-realtime` remains configurable from the UI but the manifest stays small.
- Live browser-agent execution still sends position frames at the requested
  cadence.

Results:

- Converted the app-local `rtc-realtime` recipe fixture from generated
  per-frame `rtc.send` commands to one `loop` command around a single
  `rtc.send` child command.
- Preserved the Distributed Recipes duration control and default 20 Hz cadence.
- Preserved payload fields for `seq`, `rateHz`, `durationSeconds`,
  `totalFrames`, `tMs`, and `position` using loop placeholders.
- Kept `rtc.connect` and `stats` as normal top-level commands, so the manifest
  now stays at three top-level commands for the recipe.
- Added a Distributed Recipes catalog preview helper that shows compact
  manifest command count, effective operation count, and effective frame count.
- Updated the catalog row to show effective frame count for looped realtime
  recipes.
- Updated SPA docs to describe the compact looped `rtc-realtime` recipe.

Verification:

- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/rallar-black-box/control-client.test.ts` passed.

## Iteration 4: `parallel` Primitive In `rallar-bb-test`

Status: completed on 2026-06-01.

Goal: Run bounded concurrent command groups inside one browser-agent recipe.

Suggested shape:

```json
{
  "kind": "parallel",
  "commandId": "parallel-room-traffic",
  "maxConcurrency": 2,
  "failFast": true,
  "groups": [
    {
      "groupId": "alice-sends",
      "commands": [
        {
          "kind": "rtc.send",
          "commandId": "alice-send-1"
        }
      ]
    },
    {
      "groupId": "bob-sends",
      "commands": [
        {
          "kind": "ws.send",
          "commandId": "bob-send-1"
        }
      ]
    }
  ]
}
```

Work:

- Run groups concurrently up to `maxConcurrency`.
- Run commands sequentially inside each group.
- Preserve deterministic result ordering in the parent result.
- Add per-group result summaries: passed, failed, cancelled, duration.
- Define cancellation and fail-fast behavior.
- Prevent shared child command IDs from colliding across groups.
- Add tests for bounded concurrency, partial failure, timeout, cancellation,
  and event/result ordering.

Exit criteria:

- Browser-agent recipes can model concurrent local activity without using
  `black-box-runner`.
- Result rollup is understandable in the SPA command history and distributed
  artifacts.

Results:

- Implemented executable `parallel` commands in the in-memory browser-agent
  runtime.
- Added bounded worker-slot scheduling using `maxConcurrency`, capped by the
  exported composite parallel limit.
- Kept child commands sequential within each group while allowing different
  groups to run concurrently.
- Added deterministic child command IDs with parent command ID, group index,
  group ID, command index, and original child command ID, so reused child IDs do
  not collide.
- Added per-child `parallel` metadata with parent command ID, group ID, group
  index, command index, and original child command ID.
- Added deterministic parent rollups in original group order even when groups
  complete out of order.
- Added per-group summaries for command count, passed, failed, cancelled,
  duration, and child results.
- Defined default fail-fast behavior, `failFast: false` fail-slow scheduling,
  `continueOnFailure` behavior, cancellation handling, and parent timeout
  handling.
- Updated schema/capability docs to state that both `loop` and `parallel` now
  have runtime execution support.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts` passed.

## Iteration 5: Generic `wait` Primitive In `rallar-bb-test`

Status: completed on 2026-06-01.

Goal: Make browser-agent recipes wait for observable local runtime evidence
instead of relying only on fixed delays.

Suggested shape:

```json
{
  "kind": "wait",
  "commandId": "wait-for-position",
  "timeoutMs": 5000,
  "match": {
    "kind": "message",
    "topic": "rallar.browser.realtime.message",
    "payloadPath": "data.topic",
    "equals": "room.position"
  }
}
```

Work:

- Wait against current and future runtime events/messages/diagnostics.
- Support simple match fields:
  - event kind
  - topic
  - command ID
  - transport
  - connection
  - JSON path equals/contains/exists
- Return matched event/message details in a redacted result.
- Add tests for immediate match, future match, timeout, and redaction.

Results:

- Added `wait` to the shared browser-agent command vocabulary, schema,
  capability metadata, and SPA control-command validation.
- Implemented runtime `wait` execution against already-recorded and future
  runtime events. Matching supports event kind, topic, command ID, transport,
  connection, severity, payload path `equals`, payload path `contains`, and
  payload path `exists`.
- Added a default 5 second wait timeout when neither `timeoutMs` nor
  `deadlineEpochMs` is supplied.
- Wait results include the matched event on success, and timeout/cancel
  details on failure or cancellation. Result values are redacted through the
  existing runtime redaction pipeline.
- Added focused tests for immediate matches, future matches, timeout,
  cancellation, redaction, schema validation, command-kind coverage, and
  control-client validation.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts packages/tests/rallar-black-box/control-client.test.ts` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts` passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts` passed.

Exit criteria:

- Recipes can send and then wait for received evidence in the same browser
  agent.
- Distributed live tests become less dependent on arbitrary sleeps.

## Iteration 6: Lightweight `assert` Primitive In `rallar-bb-test`

Status: completed on 2026-06-01.

Goal: Add small browser-agent assertions without copying the full
`black-box-runner` assertion engine.

Suggested shape:

```json
{
  "kind": "assert",
  "commandId": "assert-received-count",
  "source": "state.messages.length",
  "operator": "gte",
  "expected": 1
}
```

Work:

- Support a small operator set: `equals`, `notEquals`, `contains`, `exists`,
  `gte`, `lte`.
- Support read-only sources from runtime state, last result, current config,
  and recent events/messages.
- Redact assertion details in visible UI.
- Add tests for pass, fail, missing path, and nested values.

Results:

- Added `assert` to the shared browser-agent command vocabulary, schema,
  capability metadata, and SPA control-command validation.
- Implemented runtime assertions over read-only roots: `state`, `config`,
  `currentConfig`, `lastResult`, `events`, `messages`, `diagnostics`,
  `reports`, `recentEvents`, `recentMessages`, `recentDiagnostics`,
  `latestStats`, `stats`, `failures`, and `resultCache`.
- Added the intentionally small operator set: `equals`, `notEquals`,
  `contains`, `exists`, `gte`, and `lte`.
- Assertion results include source, operator, expected value, actual value,
  existence, and pass/fail status through the normal redaction pipeline.
- Added focused tests for passing assertions, failed assertions, missing paths,
  nested paths, `lastResult`, `contains`, redaction, schema validation,
  command-kind coverage, and control-client validation.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts packages/tests/rallar-black-box/control-client.test.ts` passed.

Exit criteria:

- Browser-agent recipes can make local evidence checks without switching to
  `black-box-runner`.
- The primitive remains intentionally small and does not become a general JS
  evaluator.

## Iteration 7: Distributed Barrier And Start Synchronization

Status: completed on 2026-06-01.

Goal: Support tighter multi-agent coordination for live distributed tests.

This likely belongs partly in the control server, not only in `rallar-bb-test`.

Work:

- Add a control-server-mediated barrier command or distributed-run phase.
- Let agents report `barrier.ready` and wait until all selected agents are
  ready or the barrier times out.
- Integrate with scheduled starts and distributed-run ACK state.
- Add evidence rows in Distributed Recipes monitor.
- Add tests for all-ready, missing-agent timeout, disconnect while waiting, and
  cancellation.

Exit criteria:

- Multi-browser realtime tests can align their start more reliably than with
  static start delays.

Results:

- Added optional `barrier` policy to distributed-run manifests and schema.
- Added lifecycle state `waiting-for-barrier`.
- Added control-server command phase `barrier`, using ordinary linked `health`
  commands as `barrier.ready` evidence so `rallar-bb-test` remains a command
  contract instead of a Rallar reimplementation.
- Added barrier timeout, disconnect-while-waiting failure, cancellation at
  barrier, auto-after-ready start, and scheduled-start integration in the
  control service.
- Updated control-server dispatch so commands queued after result/heartbeat
  processing can be sent immediately to connected agents.
- Exposed barrier enablement and timeout in the Distributed Recipes UI.
- Added monitor evidence for barrier command counts, per-agent barrier
  readiness, and barrier lifecycle timeline rows.
- Updated distributed-run contract, schema/capability docs, current-state docs,
  and the UI manual.

Verification:

- `npm --workspace rallar-black-box run typecheck` passed.
- `npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts` passed.
- `deno test apps/rallar-black-box-control-server/test/control-service.test.ts` passed.
- `deno check apps/rallar-black-box-control-server/src/main.ts apps/rallar-black-box-control-server/src/routes/swagger-routes.ts` passed.
- `npx vitest run packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-companion-coverage.test.ts` passed.

## Iteration 8: Black-box Runner Inline Loop And Pacing Refinements

Status: completed on 2026-06-01.

Goal: Align runner ergonomics with `rallar-bb-test` without duplicating browser
agent internals.

Work:

- Add an inline `type: "loop"` runner step, or document why
  `execution.soak` remains the only loop shape.
- Add explicit traffic-plan pacing fields:
  - `rateHz`
  - `intervalMs`
  - `jitterMs`
  - `burstSize`
  - `maxInFlight`
- Preserve replay determinism in `expanded-plan.json`.
- Add deterministic memory examples before live examples.

Exit criteria:

- Runner recipes can express realtime traffic rates cleanly.
- Existing soak/traffic/parallel artifacts remain backward compatible.

Results:

- Added inline runner `type: "loop"` expansion before execution, keeping the
  executor provider-neutral and preserving ordinary HTTP/WS/RTC/ASSERT/SET/
  PARALLEL execution semantics.
- Added loop pacing controls with `count`, `iterations`, `runs`,
  `messageCount`, `durationMs`, `intervalMs`, `delayMs`, and `rateHz`.
- Added loop placeholders `{loop.name}`, `{loop.index}`, `{loop.iteration}`,
  `{loop.stepIndex}`, `{loop.count}`, and `{loop.elapsedMs}` with exact
  placeholder type preservation.
- Added deterministic traffic-plan pacing fields: `rateHz`, `intervalMs`,
  `jitterMs`, `burstSize`, and `maxInFlight`.
- Recorded traffic pacing decisions and concrete delay steps in
  `expanded-plan.json`, including deterministic jitter from a separate
  seed-derived random stream so operation choices remain stable.
- Expanded inline loops inside generated traffic-plan operations before writing
  replay artifacts.
- Added a deterministic memory example,
  `rtc-rallar-memory-inline-loop-pacing.json`, before live examples in the
  recipe docs and matrix.
- Updated runner schema and black-box-runner docs for inline loops, traffic
  pacing, and artifact replay semantics.

Verification:

- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/recipe-matrix.test.ts` passed.
- `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-inline-loop-pacing.json` passed.

## Iteration 9: Schema, AI Prompting, Examples, And QA

Status: completed on 2026-06-01.

Goal: Make the new primitives easy for humans and AI agents to author safely.

Work:

- Update JSON Schema files and schema docs.
- Update command capability metadata.
- Update the AI recipe prompt guide with examples for looped RTC realtime,
  parallel WS/RTC groups, wait, and assert.
- Add app-local fixtures and Distributed Recipes catalog entries.
- Add unit tests, schema tests, SPA tests, and live-gated Playwright coverage.
- Update `black-box-runner` handoff docs if runner parity fields are added.

Exit criteria:

- A human or AI can generate valid loop/parallel recipes from the schema and
  docs.
- The SPA validates, previews, distributes, runs, and monitors the new
  primitives.

Results:

- Updated schema-authoring helpers to inspect child commands recursively inside
  `loop`, `parallel`, `recipe.load`, and `recipe.run`, so capability hints,
  live requirements, provider modes, and artifact expectations include nested
  RTC/WS/HTTP commands.
- Updated Distributed Recipes catalog classification to use recursive command
  kinds, preventing nested RTC/WS/HTTP recipes from being mislabeled as
  simulated-only.
- Added the app-local `composite-evidence` fixture and
  `apps/rallar-black-box/examples/composite-evidence.recipe.json` covering
  `loop`, `parallel`, `wait`, `assert`, and `stats` without live services.
- Added AI prompt-guide examples for looped RTC realtime, parallel WS/RTC
  groups, wait/assert evidence checks, and black-box-runner inline loop/pacing.
- Updated schema/capability docs and black-box-runner command-center handoff
  docs for recursive composite authoring and expanded-plan pacing artifacts.
- Updated the full-stack distributed-recipes Playwright smoke path to use the
  composite evidence recipe for simulated browser agents; the existing
  live-gated distributed suite remains the real-data WS/RTC coverage path.

Verification:

- `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts` passed.
- `npm --workspace rallar-black-box run typecheck` passed.

## Recommended Order

1. Iteration 1: Composite command contract.
2. Iteration 2: `loop`.
3. Iteration 3: convert `rtc-realtime`.
4. Iteration 5: `wait`.
5. Iteration 4: `parallel`.
6. Iteration 6: `assert`.
7. Iteration 7: distributed barrier if live timing remains hard.
8. Iteration 8: runner pacing refinements.
9. Iteration 9: schema/docs/examples/QA polish runs alongside each iteration.

## Post-Iteration Review

Status: reviewed on 2026-06-01.

The core requested primitive work is complete:

- `loop`, `parallel`, `wait`, and `assert` exist in the shared
  `rallar-bb-test` command contract.
- Runtime execution exists for composite commands in browser-agent recipes.
- Distributed barrier support exists at the control-server/distributed-run
  level without adding a Rallar-specific browser-agent command.
- `black-box-runner` has inline loop and pacing refinements while keeping its
  provider-neutral scenario boundary.
- Schema, AI prompting, docs, app-local examples, and simulated/full-stack
  distributed coverage were updated.

No additional high-level command primitive is required immediately. The most
useful next work is hardening: clearer result contracts, diagnostics,
load/pacing observability, cancellation cleanup, live conformance, and schema
compatibility. SPA-specific presentation work is tracked separately in
`apps/rallar-black-box/docs/distributed-recipe-execution-iterations.md`
Iterations 51-55.

## Iteration 10: Composite Result And Artifact Contract Hardening

Status: completed on 2026-06-01.

Goal: Make composite command output stable enough for SPA drilldowns, control
server artifacts, and future automated analysis.

Context:

- `loop` and `parallel` now return parent rollups and child results.
- The SPA and control server need stable ways to link parent commands, child
  commands, failures, runtime events, and artifacts.
- This iteration should stay in the shared-test contract layer, not implement
  SPA-specific rendering.

Work:

- Define a normalized composite result path format for nested commands, such
  as parent command ID, child command ID, loop iteration, parallel group ID,
  and child index.
- Add helper functions to:
  - flatten nested composite results
  - summarize pass/fail/cancel counts
  - find first failed child result
  - produce redacted display-safe summaries
  - map child result paths back to source recipe command paths
- Add fixture artifacts for successful and failed loop/parallel/wait/assert
  recipes.
- Add schema or type fixtures for composite result payloads if they are part of
  exported control-server artifacts.
- Keep raw child result values available for artifact/debug usage, but ensure
  visible summaries go through the same redaction path as ordinary results.

Exit criteria:

- A caller can reliably turn a nested composite result into a flat timeline,
  a parent/child tree, and a failure summary without knowing runtime internals.
- Result paths remain stable across local browser-agent execution and remote
  control-server execution.

Suggested verification:

- Add Vitest coverage for flattening, summarization, redaction, and failure
  focus using nested loop/parallel recipes.
- Add artifact fixture tests to prevent accidental shape drift.

Result:

- Added `packages/shared-test/rallar-bb-test/composite-results.ts` with the
  composite result path contract and helpers for flattening, chronological
  timelines, parent/child trees, pass/fail summaries, first-failure focus, and
  redacted display-safe result rows.
- Extended composite child result payloads with optional parent/path/source
  metadata while keeping raw child result values available for artifacts and
  debugging.
- Documented the path/source-path contract in
  `packages/shared-test/rallar-bb-test/docs/composite-result-contract.md`.
- Added a fixture-backed Vitest contract test for a nested
  `parallel -> loop -> rtc.send` result with `wait` and `assert` siblings,
  covering stable result paths, source recipe paths, tree shape, failure
  summary, timeline ordering, and redaction.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test-composite-results.test.ts`
- `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts`

## Iteration 11: Runtime Diagnostic Normalization For WS/RTC

Status: completed on 2026-06-01.

Goal: Normalize browser runtime diagnostics so `wait`, `assert`, artifacts, and
the SPA can observe transport warnings consistently.

Context:

- Live browser tests can pass while the browser console still reports useful
  warnings, for example unhandled WebSocket message types or RTC data-channel
  label mismatches.
- Those warnings should become structured browser-agent evidence, not only
  console text.

Work:

- Define a diagnostic event shape for `rallar-bb-test` runtime evidence:
  transport, severity, topic/type ID, command ID when known, connection/group,
  peer ID when known, message, data, and timestamp.
- Normalize diagnostics from:
  - WebSocket message routing warnings
  - RTC data-channel/lane mismatch warnings
  - RTC connect/send health warnings
  - adapter-level recoverable failures
- Ensure `wait` can match these diagnostics by kind, transport, severity,
  topic/type ID, command ID, and payload path.
- Ensure `assert` can read recent diagnostics through existing whitelisted
  state roots.
- Preserve the boundary: diagnostics describe observable runtime behavior; they
  do not add direct Rallar facade commands.

Exit criteria:

- A browser-agent recipe can wait for or assert on a transport diagnostic when
  testing negative or edge-case flows.
- Diagnostics emitted by live Rallar browser adapters and local adapters have a
  consistent shape.

Suggested verification:

- Add unit tests for diagnostic normalization and matching.
- Add browser-adapter tests for WS and RTC diagnostic ingestion.
- Add one simulated distributed recipe that intentionally produces a diagnostic
  and validates it with `wait` or `assert`.

Result:

- Added `packages/shared-test/rallar-bb-test/diagnostics.ts` with a normalized
  runtime diagnostic payload contract, severity inference, redaction support,
  and stable fields such as `diagnosticTypeId`, `message`, `transport`,
  command/connection/group/peer IDs, `data`, and `error`.
- Wired browser-adapter WS/RTC diagnostics through the normalized payload shape
  while keeping existing runtime event topics and compatibility fields.
- Normalized browser Rallar runtime bridge events so live Rallar diagnostic
  events can be matched by ordinary `wait` and `assert` commands.
- Added a scoped browser-console warning bridge for known live WS/RTC warning
  patterns, including `Unhandled WS message: ...` and RTC data-channel/peer
  routing warnings.
- Documented the contract in
  `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`.

Verification:

- `npx vitest run packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts packages/tests/shared-test/rallar-browser-runtime.test.ts`
- `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-browser-adapter-auth.test.ts packages/tests/shared-test/rallar-browser-runtime.test.ts packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts packages/tests/shared-test/rallar-bb-test-composite-results.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts`

## Iteration 12: Pacing Accuracy, Backpressure, And Load Observability

Status: planned.

Goal: Make looped realtime recipes trustworthy for small-scale and larger-scale
traffic tests.

Context:

- `loop` can express 20 Hz RTC position traffic compactly.
- For load-like tests, users need to know whether the requested cadence was
  actually achieved and whether sends were queued, dropped, delayed, or
  backpressured.

Work:

- Record pacing metadata for loop executions:
  - requested interval/rate
  - actual iteration timestamps
  - drift and jitter summary
  - total elapsed time
  - skipped or cancelled iterations
- Record adapter-level send observations when available:
  - send duration
  - queued/enqueued status
  - backpressure status
  - dropped/replaced payload counts
  - per-transport failure counts
- Add optional result thresholds that mark a loop failed when cadence or send
  success falls below configured limits.
- Keep thresholds simple and transport-neutral; avoid duplicating
  black-box-runner traffic-plan analytics.
- Add stats output that the SPA and artifacts can display without parsing raw
  child results.

Exit criteria:

- A looped RTC or WS recipe can report whether it roughly achieved the target
  rate and where time was spent.
- Realtime recipe failures distinguish delivery failure from local pacing or
  backpressure problems.

Suggested verification:

- Add deterministic runtime tests with fake timers for loop cadence summaries.
- Add adapter tests for queued/backpressure reporting where the adapter exposes
  enough information.
- Add a small live-gated smoke that verifies a short `rtc-realtime` run reports
  pacing stats without requiring strict timing on CI.

## Iteration 13: Cancellation, Deadline, And Cleanup Isolation Hardening

Status: planned.

Goal: Ensure composite recipes stop predictably and leave no browser-agent
resources running after cancellation, timeout, logout, or mode changes.

Context:

- `loop`, `parallel`, and `wait` already have cancellation behavior.
- Live distributed tests can run multiple agents, sockets, RTC connections, and
  repeated sends; leaked timers or sockets will make later tests misleading.

Work:

- Audit cancellation and deadline propagation through:
  - nested loops
  - parallel groups
  - waits
  - HTTP requests
  - WebSocket open/send/close
  - RTC connect/send/close
  - recipe cancellation
- Add cleanup hooks that close or detach transport resources owned by the
  browser-agent runtime after failed or cancelled recipes.
- Verify that loop intervals, wait timers, parallel group promises, WebSocket
  handlers, and RTC listeners are not left active after terminal states.
- Add idempotent cleanup behavior so repeated `close`, `reset`, logout, and
  mode changes do not produce false failures.

Exit criteria:

- Cancelling or timing out a composite recipe leaves the browser-agent runtime
  in a known idle state.
- A second recipe can run after a cancelled first recipe without inherited
  events, open sockets, or stale RTC listeners unless the recipe explicitly
  keeps them.

Suggested verification:

- Add fake-timer runtime tests for nested cancellation.
- Add browser-adapter tests that inspect socket/RTC close calls after
  cancellation.
- Add Playwright or control-server tests that cancel a distributed composite
  run, then run a clean ACK or health recipe afterward.

## Iteration 14: Composite Live Conformance Matrix

Status: planned.

Goal: Prove the composite command contract behaves consistently across local,
browser, remote-browser, and live Rallar execution paths.

Context:

- Unit tests and simulated distributed tests cover the contract.
- Live distributed coverage proves ACK, WS, RTC, and realtime paths, but not yet
  a full matrix of composite recipes across provider modes.

Work:

- Add a small matrix of representative recipes:
  - looped `rtc.send`
  - parallel WS and RTC groups
  - wait/assert evidence checks
  - cancellation during loop or wait
  - no-peer/no-route negative case
- Run the matrix across the feasible providers:
  - in-memory/local browser-agent runtime
  - browser-rallar runtime
  - remote-browser/control-server runtime
  - live Rallar Server, gated by environment
- Keep live matrix entries skip-safe and short.
- Emit artifacts that compare requested recipe behavior, observed results,
  diagnostics, and redacted failures.

Exit criteria:

- The same composite recipe semantics are proven across the main execution
  paths.
- Provider differences are documented as explicit capability differences, not
  accidental behavior.

Suggested verification:

- Add deterministic matrix tests for local providers.
- Add gated live matrix commands and documentation for local or production
  server setups.

## Iteration 15: Schema Versioning And Golden Recipe Compatibility

Status: planned.

Goal: Protect the JSON command contract as more tools and AI-generated recipes
start depending on it.

Context:

- The schema is now used by the SPA, control server, examples, AI prompt
  guidance, and tests.
- Future additions should not silently break existing distributed recipes.

Work:

- Add golden valid and invalid recipe fixtures for:
  - each primitive command
  - nested loop/parallel combinations
  - wait/assert evidence checks
  - distributed manifests with inline recipes
  - representative AI-generated examples
- Add schema compatibility tests that prove existing fixtures remain valid
  unless an explicit migration is documented.
- Add an upgrade note template for future schema changes.
- Decide whether `rallar-bb-test` recipe schema needs an explicit version field
  or whether package/schema versioning is sufficient for now.
- Add a small compatibility guide for AI prompt authors and external tools.

Exit criteria:

- Schema changes are deliberate and tested against a stable fixture corpus.
- Existing documented recipes do not drift without a visible failure in tests.

Suggested verification:

- Add Vitest schema fixture tests.
- Add docs checks that example recipe files and prompt-guide examples remain
  schema-valid.

## Deferred For Now: General Variables And `set`

Status: deferred.

General value extraction, `set`, and a full expression/assertion language are
still better owned by `black-box-runner`. `rallar-bb-test` may eventually need
small named evidence aliases for UI convenience, but that should only be added
after Iterations 10-15 show a concrete gap that cannot be solved with existing
command results, `wait`, `assert`, and artifacts.

## Recommended Next Order

1. Iteration 10: Composite result and artifact contract hardening.
2. Iteration 11: Runtime diagnostic normalization for WS/RTC.
3. Iteration 13: Cancellation, deadline, and cleanup isolation hardening.
4. Iteration 12: Pacing accuracy, backpressure, and load observability.
5. Iteration 14: Composite live conformance matrix.
6. Iteration 15: Schema versioning and golden recipe compatibility.
