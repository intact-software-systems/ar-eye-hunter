# Black-box Runner Follow-up Iterations

Date: 2026-06-01

Status: implementation history and follow-up backlog. Use
`../../architecture.md`, `black-box-runner-recipe-guide.md`,
`black-box-runner-recipe-matrix.md`, and `black-box-rtc-provider.md` for the
current runner contract before treating any item here as active work.

## Goal

Review the current `black-box-runner` after the composite `rallar-bb-test`
iterations and identify additional runner functionality that helps the broader
Rallar Kit command-center goal:

- write JSON recipes for HTTP, WS, and RTC calls
- run deterministic and live black-box tests
- produce repeatable artifacts
- make failures diagnosable by humans or AI
- keep `black-box-runner` provider-neutral and avoid reimplementing Rallar

## Current State

The runner already has the important foundations:

- JSON scenario recipes with `variables`, env-backed variables, redaction, and
  placeholders.
- `set` steps and output extraction through `output`, `outputPath`, and
  `outputs`.
- HTTP, WS, RTC, ASSERT, SET, and bounded PARALLEL execution.
- RTC providers for `rallar-stub`, `rallar-memory`, `rallar`, `rallar-browser`,
  and `rallar-remote-browser`.
- Retry/timeout support for HTTP and wait support for WS/RTC messages,
  diagnostics, health, and close events.
- Same-connection soak mode.
- Seeded traffic plans with `expanded-plan.json` replay.
- Inline loop steps with pacing.
- Deterministic in-memory examples plus gated live browser and remote-browser
  baselines.
- Matrix execution with live gates and skip-safe summaries.
- Redacted artifact bundles, artifact readers, versioned fixtures, and a
  command-center handoff contract.

This means the next work should not add Rallar facade commands or duplicate
`rallar-bb-test`. The most valuable improvements are around authoring safety,
data transforms, post-run assertions, correlation, artifact scale, and live
environment preflight.

## Recommendation

Yes, add more black-box-runner functionality, but keep it focused on generic
scenario execution and artifacts.

The specific `set` question: `set` already exists and is the right runner-owned
place for variables. It is not worth adding a new primitive named `set`.
It is worth hardening and extending the output/variable layer with safe,
schema-backed transforms, because real Rallar recipes often need to derive
headers, URLs, trace IDs, expected payloads, and replay values from previous
HTTP/WS/RTC results.

## Guardrails

- Do not add first-class recipe commands such as `auth.login`, `rooms.join`,
  `messages.rtc.send`, `messages.room`, `realtime.sendJson`,
  `realtime.room`, or `data.open`.
- Keep Rallar-specific behavior inside provider-owned request fields or
  browser/control adapters.
- Keep transforms declarative and bounded. Do not add arbitrary JavaScript
  execution.
- Keep long-running and large-scale behavior artifact-first: every generated
  plan should be replayable or reducible.
- Keep the SPA as a command center, not a browser shell executor. Execution
  handoff should stay explicit, local, and auditable.

## Runner Iteration 1: Plan Validation And Explain Mode

Status: completed on 2026-06-01.

Goal: Validate and explain a recipe before it performs network calls.

Work:

- Add a `--validate` or `--explain` CLI mode.
- Expand defaults, connections, variables, inline loops, soak, and traffic
  plans without executing HTTP/WS/RTC calls.
- Report:
  - resolved provider modes
  - required env vars and missing env vars
  - live gates and service preflight requirements
  - generated operation count
  - estimated artifact volume
  - referenced connections and missing connections
  - referenced step names and missing step names
  - output names produced and consumed
  - redaction sources
- Add a stricter optional schema/profile mode for known step types while
  preserving the current permissive schema for compatibility.
- Emit machine-readable JSON so the SPA and AI tooling can show preflight
  feedback.

Exit criteria:

- A generated recipe can be checked for obvious authoring errors before a live
  browser or server environment is touched.
- The SPA can display a runner preflight summary without parsing runner
  internals.

Suggested verification:

- Add CLI tests for valid recipes, missing connections, missing step
  references, missing env vars, and traffic-plan expansion.
- Add schema tests for strict profile validation.

Results:

- Added `packages/shared-test/black-box-runner/plan-preflight.ts`, a reusable machine-readable preflight helper for
  runner recipes.
- Added `--explain` and `--validate` CLI modes to `scenario-black-box.ts`.
- Added optional strict profile validation through `--strict` or `--profile strict`.
- Explain/validate now expands variables, defaults, connections, inline loops, soak, and traffic plans through the same
  plan-building path used by normal execution, but stops before HTTP, WS, or RTC calls are made.
- The emitted JSON reports provider/transport modes, env requirements and missing env vars, live service requirements,
  generated operation counts, estimated artifact volume, referenced/missing connections, referenced/missing step names,
  produced/consumed outputs, redaction sources, traffic-plan expansion metadata, operation rows, and structured issues.
- Missing env vars are reported as preflight errors without requiring the runner to throw before JSON output can be
  generated.

Verification:

- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "explains a valid recipe|validates missing env|missing traffic-plan|seeded traffic-plan expansion|strict profile"` passed.
- `deno check packages/shared-test/black-box-runner/scenario-black-box.ts packages/shared-test/black-box-runner/plan-preflight.ts packages/shared-test/black-box-runner/schema.ts` passed.

## Runner Iteration 2: Safe Output Transform Layer

Status: completed on 2026-06-01.

Goal: Extend `set` and output extraction with useful, declarative transforms
without turning recipes into scripts.

Work:

- Support transform specs for `set`, `outputs`, and possibly `variables`:
  - `path`: read a value from result/context
  - `template`: render a string from variables/outputs
  - `concat`: concatenate string parts
  - `coalesce`: first non-empty value
  - `jsonStringify` and `jsonParse`
  - `urlEncode`
  - `number`, `string`, `boolean`
  - `uuid` and `timestamp` for trace/test IDs
- Preserve exact placeholder type behavior.
- Allow transform outputs to be marked `secret` or `redact`.
- Add detailed transform failure reports with the failed path/operator and
  redacted inputs.
- Document which transforms are stable and which are intentionally not
  supported.

Exit criteria:

- Recipes can derive auth headers, WebSocket URLs, trace IDs, expected payloads,
  and assertion values without hard-coded string tricks.
- Transform failures produce actionable, redacted failure evidence.

Suggested verification:

- Add runner tests for each transform and failure case.
- Add an Rallar Server auth/group/WS example that uses transforms instead of
  hand-built intermediate strings where practical.

Results:

- Added a safe transform evaluator to `execute-black-box.ts` for SET steps and successful-step output extraction.
- Supported stable declarative operators: `path`, `template`, `concat`, `coalesce`, `jsonStringify`, `jsonParse`,
  `urlEncode`, `number`, `string`, `boolean`, `uuid`, and `timestamp`.
- Preserved exact placeholder behavior for normal recipe fields while leaving transform specs unresolved until the
  runner has the current result/context.
- Added `secret`, `redact`, and `redactAs` support for direct SET outputs, plus output-transform redaction in reports,
  events, and artifacts through the existing redaction pipeline.
- Transform failures now return step failures with operator/path/input details that are redacted by the report writer.
- Updated the Rallar Server auth/group/WS smoke example to derive auth headers and WS URLs through transforms.

Verification:

- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts` passed.
- `deno check packages/shared-test/black-box-runner/scenario-black-box.ts packages/shared-test/black-box-runner/execute-black-box.ts packages/shared-test/black-box-runner/plan-preflight.ts` passed.

## Runner Iteration 3: Post-run Assertions And Thresholds

Status: completed on 2026-06-01.

Goal: Let soak, traffic, parallel, and scale recipes fail on aggregate evidence,
not only individual step expectations.

Work:

- Add `postRunAssertions` or `execution.thresholds` for final report data.
- Support assertions over:
  - total success/failure counts
  - per-transport counts
  - message delivery count
  - missing expected messages
  - unexpected diagnostics by severity/topic
  - latency p50/p95/p99 thresholds
  - send success ratio
  - reconnect or cleanup failure counts
  - artifact truncation status
- Store post-run assertion results in `report.json`, `events.jsonl`, and
  `failures.json`.
- Keep the assertion language declarative and reuse the existing compare/path
  mechanics where possible.

Exit criteria:

- A realtime traffic recipe can fail because delivery ratio, latency, or
  diagnostics exceed a threshold even when individual sends did not throw.
- Failure bundles explain which aggregate threshold failed.

Suggested verification:

- Add deterministic memory tests for passing/failing post-run thresholds.
- Add one live-gated threshold recipe with loose timings to avoid CI flakes.

Results:

- Added top-level `postRunAssertions`, `execution.postRunAssertions`, and
  path-keyed `execution.thresholds` support in the runner CLI.
- Assertions evaluate against the final report after single, soak, traffic-plan,
  or scale aggregation and can read `summary.*`, `metrics.*`, and
  `artifact.*` paths.
- Supported stable operators: `equals`/`eq`/`expected`, `notEquals`/`ne`,
  `gt`, `gte`/`min`/`atLeast`, `lt`, `lte`/`max`/`atMost`, `between`,
  `includes`/`contains`, `notIncludes`, and `exists`.
- Post-run assertion results are written to `report.json`, emitted as
  `post-run-assertion` events in `events.jsonl`, copied into `failures.json`,
  and included in CLI exit-code decisions.
- Added aggregate metrics needed for threshold paths, including send/wait
  success ratios, p50/p95/p99 latency percentiles, missing expected
  message/diagnostic counts, diagnostics by severity/topic, and artifact
  truncation status.
- Updated the deterministic same-connection memory soak example to enforce
  loose post-run thresholds.

Verification:

- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "post-run|same-connection soak"` passed.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts` passed.
- `deno check packages/shared-test/black-box-runner/scenario-black-box.ts packages/shared-test/black-box-runner/plan-preflight.ts` passed.
- `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-same-connection-soak.json --explain` passed.
- `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-same-connection-soak.json` passed.

## Runner Iteration 4: Trace Correlation And Server-log Join Keys

Status: completed on 2026-06-01.

Goal: Make runner artifacts easy to correlate with Rallar Server HTTP timing,
app-inbox timing, WS, and RTC logs.

Work:

- Generate a stable `runnerRunId` and per-step `runnerStepId`.
- Optionally inject correlation headers into HTTP requests, such as
  `x-rallar-black-box-run-id` and `x-rallar-black-box-step-id`.
- Optionally inject correlation fields into WS/RTC JSON payloads when the
  payload is an object and the recipe opts in.
- Record correlation IDs in all step results, events, expanded plans, and
  failure bundles.
- Document how to search server logs by correlation ID.
- Keep injection opt-in so recipes can test exact wire payloads unchanged.

Exit criteria:

- A failed runner artifact can be joined to server-side timing logs without
  guessing from timestamps alone.
- Correlation IDs do not leak secrets and are present in redacted artifacts.

Suggested verification:

- Add tests for header injection, payload injection, opt-out behavior, and
  artifact output.
- Add a documented example that aligns HTTP timing logs with runner artifacts.

Results:

- Added stable `runnerRunId` and per-step `runnerStepId` fields to runner
  reports, step results, step-result events, failure bundles, metadata, and
  traffic-plan expanded artifacts.
- Added `execution.correlation` support with opt-in HTTP header injection via
  `injectHeaders` and opt-in WS/RTC object-payload injection via
  `injectPayloads`.
- HTTP injection writes `x-rallar-black-box-run-id` and
  `x-rallar-black-box-step-id` by default, with configurable header names.
- WS/RTC payload injection writes a `blackBoxRunner` object by default and
  leaves strings, arrays, and non-object payloads unchanged.
- The Rallar Server auth/group/WS smoke example now enables HTTP correlation
  headers so API timing logs can be joined to runner artifacts without changing
  WS payloads.
- The artifact handoff contract and reader now accept post-run assertion events
  and expose assertion events/failures alongside the correlated event stream.

Verification:

- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "correlation"` passed.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts` passed.
- `npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts packages/tests/shared-test/black-box-runner-handoff-contract.test.ts` passed.
- `deno check packages/shared-test/black-box-runner/scenario-black-box.ts packages/shared-test/black-box-runner/execute-black-box.ts packages/shared-test/black-box-runner/rtc-provider.ts packages/shared-test/black-box-runner/plan-preflight.ts packages/shared-test/black-box-runner/schema.ts` passed.
- `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/rallar-server-auth-group-ws-smoke.json --explain` passed.

## Runner Iteration 5: Large-run Artifact Indexing And Compaction

Status: completed on 2026-06-01.

Goal: Keep long soak, traffic, and scale runs usable when artifacts become
large.

Work:

- Add an optional `artifact-index.json` with:
  - event counts by kind/transport/status
  - first failure pointers
  - step-result offsets or sequence numbers
  - per-run and per-connection summaries
  - truncation metadata
- Add configurable JSONL caps per event kind, not just a single global cap.
- Add compact summaries for repeated successes while preserving failures and
  diagnostics.
- Consider optional compressed artifact files while keeping plain JSON/JSONL as
  the default for local debugging.
- Update artifact-reader support for indexed/compacted bundles.

Exit criteria:

- A long runner run can be browsed by the SPA without loading every raw event
  into memory.
- Failure events and diagnostics remain available even when success events are
  compacted.

Suggested verification:

- Add artifact-reader fixture coverage for indexed and truncated bundles.
- Add a large deterministic traffic test with a small cap that verifies failure
  preservation.

Results:

- Added `artifact-index.json` to current runner artifact bundles while keeping
  plain `events.jsonl`, `report.json`, `failures.json`, and `metadata.json` as
  the local-debugging defaults.
- The index records total/emitted/omitted event counts by kind, transport, and
  status, first-failure pointers, step-result sequence numbers with
  emitted/omitted flags, per-run summaries, per-connection summaries,
  truncation metadata, and compact summaries for omitted repeated success
  events.
- Added configurable event caps through `execution.artifacts`,
  `execution.artifact`, or `execution.artifactLimits`, including global
  `maxEvents` and per-kind `maxEventsByKind`.
- Failure step results, failed post-run assertions, and RTC diagnostics are
  preserved in `events.jsonl` even when success events are compacted.
- Updated artifact reader support, schema fixtures, handoff docs, artifact
  docs, matrix docs, and SPA examples docs for indexed/compacted bundles.
- Deferred compressed artifacts; plain JSON/JSONL remains the default until the
  command-center import flow needs compressed bundle support.

Verification:

- `npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts packages/tests/shared-test/black-box-runner-handoff-contract.test.ts` passed.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "artifact indexes|bounded artifacts|redacted report"` passed.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts` passed when allowed to bind a local
  `127.0.0.1` HTTP server for existing correlation tests.
- `deno check packages/shared-test/black-box-runner/scenario-black-box.ts packages/shared-test/black-box-runner/execute-black-box.ts packages/shared-test/black-box-runner/plan-preflight.ts packages/shared-test/black-box-runner/schema.ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `git diff --check` passed.

## Runner Iteration 6: Live Environment Preflight Contract

Status: completed on 2026-06-01.

Goal: Fail fast when live Rallar services are not provisioned for a matrix run.

Work:

- Add a runner-level preflight command/profile that validates:
  - Rallar API base URL
  - `/api/config`
  - CORS origin expectations when configured
  - configured users and credentials
  - group create/join permission
  - WS ticket and WebSocket upgrade
  - ICE config availability
  - optional control-server reachability for remote-browser providers
- Emit `preflight-report.json` and matrix skip reasons that the SPA can display.
- Keep this separate from actual recipe execution so long browser matrices do
  not launch when prerequisites are missing.

Exit criteria:

- Live matrix failures caused by environment setup are reported as provisioning
  failures, not as misleading RTC recipe failures.
- Command-center live-environment checks and runner matrix gates share the same
  prerequisite vocabulary.

Suggested verification:

- Add mock/preflight tests for missing env, failed HTTP service, bad auth, bad
  WS upgrade, and successful local API.
- Add docs for local and production preflight commands.

Results:

- Added `live-preflight.ts` with a shared live provisioning report contract and
  stable check vocabulary for env, Rallar API base URL, `/api/config`, CORS,
  auth, group permission, WS ticket, WS upgrade, ICE config, control server,
  and Playwright.
- Added matrix `--preflight-only` / `--live-preflight` mode plus
  `npm run test:shared-black-box:matrix:live:preflight`.
- Matrix live entries now run live preflight before recipe execution, write
  `preflight-report.json`, and copy failed provisioning checks into skip
  reasons instead of launching misleading RTC/browser runs.
- Added artifact-reader and handoff-contract support for optional
  `preflight-report.json`.

Verification:

- `npx vitest run packages/tests/shared-test/black-box-runner-live-preflight.test.ts packages/tests/shared-test/black-box-runner-artifact-reader.test.ts packages/tests/shared-test/black-box-runner-handoff-contract.test.ts packages/tests/shared-test/recipe-matrix.test.ts` passed.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "explains a valid recipe|validates missing env|strict profile"` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:deno` passed.
- `deno check packages/shared-test/black-box-runner/artifact-reader.ts packages/shared-test/black-box-runner/handoff-contract.ts packages/shared-test/black-box-runner/schema.ts packages/shared-test/black-box-runner/live-preflight.ts packages/shared-test/black-box-runner/recipe-matrix.mts` passed.
- `deno run -A packages/shared-test/black-box-runner/recipe-matrix.mts --profile=live --id=browser-connect-live --preflight-only --artifact-dir=/private/tmp/rallar-live-preflight-smoke` passed with a skipped entry and a written `preflight-report.json` for missing live credentials.

## Runner Iteration 7: Static Recipe Fragments And Includes

Status: completed on 2026-06-01.

Goal: Reduce duplication in common Rallar Server setup and cleanup recipes
without adding a programming language.

Work:

- Add static `include` or `fragments` support for recipe snippets.
- Allow included snippets to receive variables from the parent recipe.
- Resolve includes during `--validate`/`--explain`, before execution.
- Record the fully expanded recipe in artifacts for reproducibility.
- Forbid remote includes by default. Use local, repository-relative includes
  unless an explicit safe allowlist is configured.

Exit criteria:

- Common setup patterns such as login, create-or-join group, WS open, RTC
  connect, and cleanup can be reused by recipes and AI-generated scenarios.
- Artifact replay does not require resolving external include files.

Suggested verification:

- Add include expansion tests, circular include detection, missing include
  errors, and artifact replay tests.

Results:

- Added static top-level `fragments` and step-level `include` support for
  inline fragments and local JSON fragment files.
- Include snippets can receive static `variables`, `namePrefix`, and
  `nameSuffix`. Fragment-level `variables`, `connections`, and `defaults` are
  merged into the parent recipe before normal runner variable resolution.
- Includes are resolved before `--validate`, `--explain`, and execution. Missing
  includes, circular includes, remote URLs, absolute paths, and paths escaping
  the recipe root fail preflight with `PLAN_EXPANSION_FAILED`.
- Artifact bundles now include optional `expanded-recipe.json`, which records
  the expanded recipe and include provenance so replay/debug does not need the
  original fragment files.
- Updated artifact reader, handoff contract, schema fixture coverage, recipe
  guide, artifact docs, SPA import docs, and recommended iteration order.

Verification:

- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "static recipe fragments|expanded recipe|static includes"` passed.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts` passed when allowed to bind a local
  `127.0.0.1` HTTP server for existing correlation tests.
- `npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts packages/tests/shared-test/black-box-runner-handoff-contract.test.ts` passed.
- `deno check packages/shared-test/black-box-runner/scenario-black-box.ts packages/shared-test/black-box-runner/execute-black-box.ts packages/shared-test/black-box-runner/plan-preflight.ts packages/shared-test/black-box-runner/schema.ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `git diff --check` passed.

## Runner Iteration 8: Traffic-plan Failure Reduction

Status: completed on 2026-06-01.

Goal: Make seeded traffic failures easier to reduce and replay.

Work:

- Add a reducer that takes a failing `expanded-plan.json` and generates smaller
  replay candidates.
- Start with safe reductions:
  - remove successful operations after the first failure
  - keep setup and cleanup
  - keep required waits around the failure
  - preserve operation order for the remaining plan
- Emit a `reduced-plan.json` candidate and a summary of removed operations.
- Keep this offline and artifact-driven. Do not rerun reductions automatically
  unless explicitly requested.

Exit criteria:

- A large seeded traffic failure can become a smaller repeatable recipe without
  manually editing hundreds of generated steps.

Suggested verification:

- Add reducer tests using deterministic expanded-plan fixtures.
- Add docs showing how to replay the reduced plan.

Results:

- Added `black-box-runner/traffic-plan-reducer.ts` as an offline reducer for
  failing seeded traffic artifacts.
- The reducer reads `expanded-plan.json` plus first-failure evidence from
  `artifact-index.json`, `failures.json`, `report.json`, or an explicit
  `--first-failure` argument.
- The first reduction strategy is `truncate-after-first-failure`: keep setup,
  cleanup, operation order, and all generated traffic through the first failing
  step, then remove later generated operations.
- The reducer writes replay-compatible `reduced-plan.json` and
  `reduced-plan-summary.json` files without rerunning the scenario.
- Added `reduced-plan.json` to the artifact handoff contract and artifact
  reader views so command-center consumers can import reduced replay
  candidates alongside ordinary expanded plans.
- Updated recipe, artifact, matrix, examples, SPA import, and product
  evaluation docs with the reduced-plan workflow.

Verification:

- `npx vitest run packages/tests/shared-test/black-box-runner-traffic-plan-reducer.test.ts packages/tests/shared-test/black-box-runner-artifact-reader.test.ts packages/tests/shared-test/black-box-runner-handoff-contract.test.ts` passed.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "traffic plan"` passed.
- `deno check packages/shared-test/black-box-runner/artifact-reader.ts packages/shared-test/black-box-runner/traffic-plan-reducer.ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:deno` passed.
- `deno run -A packages/shared-test/black-box-runner/traffic-plan-reducer.ts --expanded-plan packages/shared-test/black-box-runner/fixtures/schema/v1/artifact-bundle/expanded-plan.json --first-failure aliceTrafficToBob --out /tmp/rallar-reduced-plan-smoke.json --summary-out /tmp/rallar-reduced-plan-summary-smoke.json` passed.
- `git diff --check` passed.

## Deferred For Now

These are not recommended as immediate black-box-runner functionality:

- Rallar facade commands such as `rooms.join`, `messages.rtc.send`,
  `messages.room`, `realtime.sendJson`, or `realtime.room`.
- Arbitrary JavaScript expressions in recipes.
- Browser-driven shell execution from the SPA.
- Full distributed browser-agent orchestration inside `black-box-runner`; that
  belongs to `rallar-bb-test` plus the control server.
- Automatic live environment mutation beyond explicit recipe steps.

## Recommended Order

1. Runner Iteration 1: Plan validation and explain mode.
2. Runner Iteration 2: Safe output transform layer.
3. Runner Iteration 3: Post-run assertions and thresholds.
4. Runner Iteration 4: Trace correlation and server-log join keys.
5. Runner Iteration 6: Live environment preflight contract.
6. Runner Iteration 5: Large-run artifact indexing and compaction.
7. Runner Iteration 7: Static recipe fragments and includes.
8. Runner Iteration 8: Traffic-plan failure reduction.
