# Black-box Runner Follow-up Iterations

Date: 2026-06-01

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
  `messages.rtc.send`, `realtime.sendJson`, or `data.open`.
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
- `deno check packages/shared-test/black-box-runner/scenario-black-box.ts packages/shared-test/black-box-runner/plan-preflight.ts` passed.

## Runner Iteration 2: Safe Output Transform Layer

Status: proposed.

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

## Runner Iteration 3: Post-run Assertions And Thresholds

Status: proposed.

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

## Runner Iteration 4: Trace Correlation And Server-log Join Keys

Status: proposed.

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

## Runner Iteration 5: Large-run Artifact Indexing And Compaction

Status: proposed.

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

## Runner Iteration 6: Live Environment Preflight Contract

Status: proposed.

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

## Runner Iteration 7: Static Recipe Fragments And Includes

Status: proposed.

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

## Runner Iteration 8: Traffic-plan Failure Reduction

Status: proposed.

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

## Deferred For Now

These are not recommended as immediate black-box-runner functionality:

- Rallar facade commands such as `rooms.join`, `messages.rtc.send`, or
  `realtime.sendJson`.
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
