# Shared Test Gap Analysis Against Current Rallar

Date: 2026-05-27

This document compares `packages/shared-test/black-box-runner` and
`packages/shared-test/rallar-bb-test` against the updated Rallar/Rallar Server
surface, with an important boundary from the black-box runner docs:

The black-box runner should stay a JSON recipe executor for network behavior.
It should run HTTP, WS, and RTC steps with requests, responses, and expectations.
It should not become a second Rallar implementation or a mirror of the whole
Rallar browser/server facade.

Directories intentionally out of scope for this review:

- `apps/relic-hunters-v1`
- `packages/relic-hunters`
- `apps/relic-hunter-server-v1`

## Sources Reviewed

- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `docs/rallar-troubleshooting-checklist.md`
- `docs/rallar-ai-skill.md`
- `docs/rallar-ai-prompting-guide.md`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-server/**`
- `packages/shared-test/black-box-runner/**`
- `packages/shared-test/black-box-runner/docs/**`
- `packages/shared-test/black-box-runner/examples/**`
- `packages/shared-test/rallar-bb-test/**`

## Runner Boundary

The black-box runner docs are clear about the intended design:

- `black-box-runner` is a scenario execution and reporting tool.
- The runner-level RTC contract is provider-neutral: connect, send, wait, close.
- Real RTC behavior belongs in Rallar and in thin runner providers/adapters.
- The runner should not reimplement WebRTC negotiation, ICE, peer lifecycle,
  data-channel lifecycle, room membership, or Rallar routing.
- `rallar-browser` is the real browser-backed Rallar provider.
- The default `rallar` provider is still WebSocket signaling-only.

That boundary changes how the gaps should be interpreted. Missing Rallar facade
methods are not automatically missing runner step types. For the runner, the
right question is usually:

- Can a JSON recipe express the external network call?
- Can the recipe pass provider-specific config through to the provider?
- Can the recipe assert responses, messages, close events, diagnostics, and
  expected failure modes?
- Can the provider expose enough normalized diagnostics without duplicating
  Rallar internals?

## Current Shared-Test State

`black-box-runner` currently supports these recipe concepts:

- `HTTP` steps for request/response checks.
- `WS` steps for raw WebSocket open/send/wait/close.
- `RTC` steps for provider-backed connect/send/wait/close.
- `ASSERT` and `SET` utility steps.
- JSON placeholders resolved from variables, outputs, and previous results.

Current black-box runner examples now cover these categories:

- browser-backed RTC connect, realtime send, `messages.rtc`, scoped workspaces,
  readiness diagnostics, timeout diagnostics, multicast, and NACK/stale-state
  patterns
- deterministic `rallar-memory` delivery semantics, routing failures, and scale
  smoke runs
- Rallar Server REST/WS auth, group setup, negative auth, and WS/RTC payload
  parity
- local `rallar-browser` versus remote `rallar-remote-browser` provider-mode
  parity

Current RTC providers include:

- `rallar-stub`: fake provider for runner smoke tests.
- `rallar-memory`: deterministic in-memory provider for runner semantics.
- `rallar`: current signaling-only Rallar provider.
- `rallar-browser`: browser-backed provider using Playwright and the browser
  Rallar facade.
- `rallar-remote-browser`: control-server-backed provider that forwards commands
  to a visible/browser agent through `rallar-bb-test`.

`rallar-bb-test` currently exposes a browser command runtime with these command
families:

- `configure`
- `recipe.load`, `recipe.run`, `recipe.cancel`
- `rtc.connect`, `rtc.send`
- `ws.open`, `ws.send`, `ws.close`
- `http.request`
- `health`, `stats`, `close`, `reset`

## Checkpoint After Iteration 10

The first ten improvement iterations have now landed. Iteration 9 is the only
partial item from that batch: repeated scale mode landed first, while
same-connection soak, seeded traffic plans, and bounded parallel step groups
were split into later work. Those follow-ups were completed in Iterations 12,
13, and 14.

Completed shared-test capabilities now include:

- a recipe guide and examples index for the runner boundary
- output extraction, accepted outcome sets, environment variables, secret
  redaction, and generic assertions
- Rallar Server REST/WS recipes for register/login, group setup, authenticated
  WS, and negative auth
- scoped Rallar fields passed through the local and remote browser providers
- generic RTC diagnostics, health waits, connect/send/first-payload latency, and
  provider failure details
- delivery/NACK examples and WS/RTC payload parity examples
- remote-browser provider alignment with the same RTC/HTTP/WS result shapes
- redacted artifact bundles, JSONL event streams, failure bundles, and root
  scripts for common dry-run/live/scale commands
- companion coverage manifest and tests that keep facade coverage outside the
  black-box runner

Remaining follow-ups are no longer about adding Rallar facade commands to the
runner. They are about live validation, deeper scale patterns, package
hardening, and a stable handoff from shared-test artifacts into the SPA command
center.

## Alignment Correction

The previous broad gap list treated many Rallar facade APIs as candidate runner
commands. That is too broad for `black-box-runner`.

Do not add these as first-class black-box runner core step types:

- `rallar.auth.login`
- `rallar.rooms.join`
- `rallar.people.refresh`
- `rallar.messages.ws.send`
- `rallar.data.open`
- `rallar.media.setLocalStream`
- `rallarServer.ws.defineTopic`

Use this split instead:

- In `black-box-runner`, express behavior as HTTP, WS, RTC, ASSERT, SET, and
  generic wait/expectation operations.
- In providers, delegate to Rallar where needed and expose normalized network
  diagnostics.
- In `rallar-bb-test`, keep browser-control operations narrow and useful for
  remote/manual browser execution.
- In examples, show how to test Rallar and Rallar Server externally through
  recipes, not internal facade clones.

## Original Findings That Drove Iterations 1-10

These findings are retained as historical context for why Iterations 1-10 were
created. The result blocks under each completed iteration describe what has
already been fixed. Remaining work after that baseline is listed in
`Follow-up Iterations After Iteration 10`.

### 1. Runner Examples Were Too RTC-Only

At the start of this plan, the examples were valuable but mostly proved browser
RTC connect/send/wait. They did not yet show the intended full JSON recipe style
for mixed network testing.

Missing examples at that point:

- Login/register through REST and extract access tokens.
- Create a group through REST, tolerating "already exists" outcomes.
- Join a group through REST.
- Acquire or use a WS ticket if the server requires it.
- Open a raw WS connection.
- Send and assert WS messages.
- Connect two browser RTC actors.
- Send and assert RTC realtime payloads.
- Send and assert `messages.rtc` payloads.
- Combine HTTP, WS, and RTC in one recipe.

The runner needed more examples and docs here, not Rallar facade commands.

### 2. Generic Recipe Ergonomics Needed To Improve

The runner already had request/response matching, placeholders, and basic output
storage. For Rallar black-box testing, the recipe layer needed stronger generic
features:

- More explicit JSON schema/docs for `HTTP`, `WS`, `RTC`, `ASSERT`, and `SET`.
- Output extraction from response body/header/message paths.
- Environment and secret variable resolution without comma-sensitive CLI
  replacement pitfalls.
- Expected outcome sets, for cases where an idempotent create can return created
  or already-exists.
- Poll/retry/wait patterns for async server state.
- Better negative-case assertions for auth, permission, stale session, and stale
  state.

These were generic runner capabilities and fit the black-box runner goal.

### 3. Rallar Server REST/WS Black-Box Recipes Were Missing

The updated Rallar Server has a wider behavior surface around groups, scoped
state, app inbox, WebSocket lifecycle, and message routing. The runner should
test that through public network surfaces.

Missing recipe coverage at that point:

- Create group and join group via REST.
- Confirm expected vs observed group membership through REST/WS-visible state.
- Open authenticated WS connections.
- Broadcast/multicast/direct JSON over WS where supported by the server API.
- Verify cleanup isolation between recipe runs.
- Verify reconnect/rejoin/stale-session behavior as external black-box flows.
- Verify auth/permission negative cases as HTTP/WS failures.

This needed to be implemented as recipe examples plus generic assertion support,
not server facade commands inside the runner.

### 4. Scoped Rallar Addressing Needs Provider Pass-Through

Current Rallar/Rallar Server behavior uses scoped addressing concepts such as:

- `applicationId`
- `workspaceId`
- `scope`
- `roomRef`
- `minSnapshotVersion`

For the black-box runner, the gap is not "add Rallar room commands". The gap is:

- RTC recipe config and sends should be able to pass these fields through to
  `rallar-browser` and `rallar-remote-browser`.
- Provider diagnostics should report the resolved room/scope/session/peer data.
- Example recipes should prove same room id isolation across workspaces.
- Recipes should be able to assert stale-state outcomes such as
  `not-yet-in-sync`.

The provider can call the existing Rallar facade internally, but the recipe
should remain network-oriented.

### 5. RTC Readiness Diagnostics Should Stay Provider-Neutral

The docs already say `rtc.connect` for `rallar-browser` should mean more than
"page loaded" or "signaling socket opened". That is correct, but the runner
should not learn Rallar's internal lifecycle model.

Useful runner/provider improvements:

- Keep `rtc.connect`, `rtc.send`, `rtc.wait`, and `rtc.close` as the core flow.
- Allow providers to emit normalized readiness diagnostics.
- Let recipes wait for generic diagnostic topics or provider health reports.
- Report partial readiness clearly: which connection, peer, lane, or timeout
  condition failed.
- Measure connect latency and first-payload latency through generic report
  fields.

Rallar-specific readiness calls such as `waitForRoomLane` should live behind the
provider/runtime, not as required generic runner primitives.

### 6. Send Results And NACKs Need Generic Assertions

Rallar now has important delivery outcomes such as queued, dropped, replaced,
closed, no peer, and `not-yet-in-sync`. The runner should not encode all Rallar
application-layer semantics as core logic, but it should make these outcomes
observable.

Useful improvements:

- Preserve provider send results in the normal step result.
- Allow `expect.actual`/`ASSERT` checks against send result fields.
- Emit NACKs and application-layer delivery failures as normalized diagnostics or
  message events.
- Add examples that assert `not-yet-in-sync` through observable response/event
  data.
- Add recipes for direct, multicast, and broadcast semantics over the same JSON
  payload where the external protocol supports it.

### 7. `rallar-bb-test` Should Stay A Bridge, Not Become The Runner

`rallar-bb-test` is useful for visible/remote browser execution and the control
server bridge. It can expose browser actions that the remote provider needs, but
the black-box runner should not mirror every `rallar-bb-test` command.

Alignment needed:

- `rallar-remote-browser` should forward the same generic RTC/HTTP/WS concepts
  that recipes already use.
- New browser-control commands should be added only when they unlock external
  black-box observations.
- Remote-browser events should map back into the same `RTC`/`WS` message and
  diagnostic stores used by local providers.
- Reports should not force recipe authors to understand browser-internal control
  commands.

### 8. Rallar Data, Media, And Server Facade APIs Are Mostly Out Of Runner Scope

Rallar Data, media, and server facade APIs are real product surfaces, but they
should not become black-box runner core commands.

For black-box runner coverage:

- Test them through HTTP/WS/RTC recipes when they have observable network
  behavior.
- Use a small app or browser harness if data/media behavior must be driven from
  the browser.
- Keep any browser-harness details inside the provider or `rallar-bb-test`.

Separate package-level or app-level tests can cover facade method parity more
directly.

### 9. Artifacts And Diagnostics Need Hardening

The runner is meant to help humans and automation debug black-box failures. It
needs stronger artifacts:

- Redacted JSON reports.
- JSONL event streams.
- Copyable failure diagnostics for HTTP, WS, RTC, and provider diagnostics.
- Live baseline recordings for `rallar-browser` realtime and `messages.rtc`.
- Clear provider naming in reports, especially `rallar` vs `rallar-browser`.
- Stable CI commands for dry-run, local fake providers, browser-backed live
  runs, and remote-browser runs.

## Revised Improvement Iterations

### Iteration 1: Boundary And Recipe Contract Documentation

Status: completed on 2026-05-27.

Goal: Make the runner's role explicit and prevent Rallar facade creep.

Work:

- Add or update a top-level black-box runner recipe guide.
- Document the core step families: `HTTP`, `WS`, `RTC`, `ASSERT`, and `SET`.
- Document provider boundaries and the `rallar` vs `rallar-browser` distinction.
- Add an examples index explaining which examples are generic runner tests and
  which are Rallar integration tests.
- Link this gap analysis from the runner docs.

Exit criteria:

- A human or AI can add recipes without assuming the runner should implement
  Rallar facade methods.

Results:

- Added `black-box-runner/docs/black-box-runner-recipe-guide.md` as the
  preferred recipe-authoring guide.
- Documented the `HTTP`, `WS`, `RTC`, `ASSERT`, and `SET` step families.
- Documented provider boundaries, including the important `rallar` versus
  `rallar-browser` distinction.
- Added `black-box-runner/examples/README.md` to classify the current examples.
- Linked the recipe guide, examples index, and this gap analysis from the RTC
  provider/status docs.

### Iteration 2: Generic Recipe Ergonomics

Status: completed on 2026-05-27.

Goal: Make JSON recipes better at expressing request/response expectations.

Work:

- Add path-based output extraction from HTTP responses, WS messages, RTC
  messages, and provider send results.
- Add expected outcome sets for idempotent operations.
- Add environment/secret variable resolution with redaction.
- Improve retry/poll/wait documentation and, if needed, generic helpers.
- Add focused tests for these generic runner capabilities.

Exit criteria:

- A recipe can create resources, capture IDs/tokens, and feed later HTTP/WS/RTC
  steps without custom code.

Results:

- Added `outputPath` and `outputs` extraction for successful step results.
- Output paths work for HTTP response bodies/status, WS matched messages, RTC
  provider send/wait results, ASSERT results, and SET values.
- Missing configured output paths now fail the step instead of silently storing
  `undefined`.
- Added HTTP accepted status sets through `status`, `statusCode`,
  `statusCodes`, and `allowedStatusCodes`.
- Added HTTP accepted body alternatives through `bodyAnyOf`/`anyBodyOf`/`bodyIn`.
- Added ASSERT accepted outcome alternatives through `anyOf`.
- Added environment-backed variables with `env`, `fromEnv`, `default`,
  `fallback`, `required`, and `secret` support.
- Added report redaction for secret variables and secret output extractions.
- Documented output extraction, accepted outcome sets, environment secrets, and
  retry/wait controls in the runner recipe guide.
- Added focused tests for HTTP extraction/outcome sets, RTC send-result
  extraction, WS matched-message extraction, missing output failure behavior,
  ASSERT outcome sets, and environment secret redaction.

### Iteration 3: Rallar Server HTTP/WS Recipe Examples

Status: completed on 2026-05-27.

Goal: Show how to test Rallar Server externally with network recipes.

Work:

- Add examples for login/register, group create, group join, and membership
  verification through REST.
- Add examples for authenticated WS open/send/wait/close.
- Add examples that tolerate "already exists" where appropriate.
- Add negative auth/permission examples.
- Add cleanup examples or documented cleanup expectations.

Exit criteria:

- The runner can execute the basic "create group, join group, open WS" black-box
  flow as JSON.

Results:

- Added `black-box-runner/examples/rallar-server-register-login.json`.
- Added `black-box-runner/examples/rallar-server-auth-group-ws-smoke.json`.
- Added `black-box-runner/examples/rallar-server-negative-auth.json`.
- The smoke recipe logs in, creates or reuses `bb-group`, joins it, connects
  group presence, creates a WS ticket, opens `/api/ws/{sessionId}`, sends an
  AL unicast message to the same session, waits for the echoed message, closes
  WS, disconnects group presence, and logs out.
- The recipes use environment-backed variables and Iteration 2 output
  extraction instead of custom runner code.
- The examples index now documents the new Rallar Server recipes, defaults, and
  cleanup expectations.

### Iteration 4: Rallar Browser Provider Pass-Through For Scoped Delivery

Status: completed on 2026-05-27.

Goal: Keep scoped Rallar behavior testable without adding Rallar commands to the
runner core.

Work:

- Thread `applicationId`, `workspaceId`, `scope`, `roomRef`, and
  `minSnapshotVersion` through `rallar-browser` and `rallar-remote-browser`
  provider config/send payloads.
- Preserve resolved session/peer/room/scope diagnostics in step results.
- Add examples for same room id in separate workspaces.
- Add examples that assert observable stale-state outcomes.

Exit criteria:

- Scoped delivery and stale-state behavior can be tested through normal RTC
  recipe steps.

Results:

- Threaded `applicationId`, `workspaceId`, `scope`, `roomRef`, and
  `minSnapshotVersion` through the local `rallar-browser` provider connect/send
  path.
- The browser runtime now applies scoped Rallar defaults, joins scoped rooms
  with the resolved operation scope, sends realtime payloads with `roomRef`,
  and sends `messages.rtc` payloads with `roomRef` and `minSnapshotVersion`.
- Threaded the same scoped fields through `rallar-remote-browser`,
  `rallar-bb-test` command types, the browser command adapter, and the
  black-box runner adapter.
- Preserved provider diagnostics in RTC step `actual.diagnostics` and send
  diagnostics in `actual.sendResult` when a provider exposes them.
- Added `rtc-rallar-browser-scoped-workspaces.json` to exercise same `roomId`
  delivery in separate workspaces.
- Added `rtc-rallar-browser-not-yet-in-sync.json` as the observable
  stale-state/NACK recipe pattern.

### Iteration 5: Generic RTC Readiness And Failure Diagnostics

Status: completed on 2026-05-27.

Goal: Make the RTC connect stage easier to investigate while keeping provider
logic behind the provider boundary.

Work:

- Standardize provider diagnostic event shape for readiness phases.
- Let `rtc.wait` match diagnostic/health events, not only messages and close
  events, if current support is insufficient.
- Add connect latency and first-payload latency report fields.
- Add examples for partial readiness and timeout diagnosis.

Exit criteria:

- Failed browser RTC setup explains the failing connection/phase without
  requiring runner-side Rallar internals.

Results:

- Added a generic RTC diagnostics store at `rtcDiagnostics[connection]`.
- Provider messages with `kind: "diagnostic"` are normalized into diagnostic
  events while remaining compatible with the existing RTC message store.
- Added `expect.diagnostic` and `expect.diagnostics` for `rtc.wait` and
  `rtc.send` result waits.
- Added `expect.health` to poll the current provider diagnostics snapshot.
- Added `connectLatencyMs`, `sendLatencyMs`, and `firstPayloadLatencyMs` timing
  fields to RTC step results where the runner can measure them.
- Remote-browser diagnostic events now map into the same generic diagnostics
  store.
- Added `rtc-rallar-browser-readiness-diagnostics.json`.
- Added `rtc-rallar-browser-timeout-diagnostics.json` as an intentionally
  failing timeout-diagnostics example.

### Iteration 6: Delivery Semantics And NACK Recipes

Goal: Make delivery decisions observable through recipes.

Work:

- Preserve send result details in RTC and WS step outputs.
- Add examples for direct, multicast, and broadcast delivery.
- Add examples for no-peer, closed, queued/dropped/replaced where externally
  observable.
- Add a `not-yet-in-sync` NACK recipe using observable message/result data.
- Add assertions that compare the same payload over WS and RTC where possible.

Exit criteria:

- Recipes can distinguish routing failure, readiness failure, stale state, and
  transport closure from the report alone.

Status: Completed in this pass.

Results:

- WS sends now preserve `actual.sendResult` with status, ready state, buffered
  amount, wire payload, and send timing fields.
- Generic RTC send failures now preserve provider-owned `sendResult` or
  `response` values when the provider attaches them to the thrown error.
- Browser-backed Rallar send failures attach the browser send response and
  provider diagnostics before rethrowing, so no-peer/closed/dropped-style
  outcomes can survive into the runner report.
- Added `rtc-rallar-memory-delivery-semantics.json` for deterministic direct and
  room broadcast assertions.
- Added `rtc-rallar-memory-routing-failures.json` as an intentional failure
  recipe for no-recipient, closed-target, and send-after-close report shape.
- Added `rtc-rallar-browser-messages-rtc-multicast.json` for real Rallar
  app-level room multicast.
- Added `rallar-server-ws-rtc-payload-parity.json` to compare the same payload
  observed through authenticated WS and browser-backed RTC.
- Kept `rtc-rallar-browser-not-yet-in-sync.json` as the stale-state NACK
  recipe and documented it with the delivery examples.

Verification:

- Added focused tests for WS send-result output extraction and failed RTC
  send-result preservation.
- Dry-run validation covers the new real-service recipes; the deterministic
  `rallar-memory` delivery recipe runs without external services.

### Iteration 7: Remote Browser Bridge Alignment

Goal: Keep `rallar-remote-browser` compatible with generic recipe semantics.

Work:

- Ensure remote RTC events map into the same message/close/diagnostic stores as
  local RTC providers.
- Ensure remote HTTP and WS commands preserve request/response shapes.
- Add examples that run the same recipe locally with `rallar-browser` and
  remotely with `rallar-remote-browser`.
- Keep browser-control-only details out of recipe authoring.

Exit criteria:

- The control-server path feels like another provider execution mode, not a
  separate Rallar command language.

Status: Completed in this pass.

Results:

- Remote RTC messages are now normalized into the same event-shaped payload
  style as local `rallar-browser` messages.
- Remote RTC diagnostics are stored in `rtcDiagnostics` and can be asserted with
  `expect.diagnostic` and `expect.diagnostics`.
- Remote RTC health can be asserted with `expect.health`; the provider polls
  the control server with generic `health` commands and updates the connection
  diagnostics used by the runner.
- Remote RTC connect and send results now expose timing fields and
  `actual.sendResult` data.
- Remote HTTP results preserve command metadata on `actual.remote`,
  `actual.commandId`, and `actual.result` while keeping the ordinary HTTP body
  and status assertions intact.
- Added `rtc-rallar-browser-provider-mode-parity.json`, which can run locally
  with `rallar-browser` or remotely with `rallar-remote-browser` by changing
  `RALLAR_BB_RTC_PROVIDER`.

Verification:

- Added focused tests for remote RTC message normalization, diagnostic waits,
  health waits, send result preservation, and remote HTTP metadata.
- Dry-run validation covers the provider-mode parity example.

### Iteration 8: Artifacts, Redaction, And CI Commands

Goal: Make black-box runs convenient and diagnosable.

Work:

- Emit redacted reports and JSONL event streams.
- Add copyable failure bundles for HTTP/WS/RTC failures.
- Record live baseline artifacts for `rallar-browser` realtime and
  `messages.rtc`.
- Add documented commands for dry-run, fake-provider, browser-backed, and remote
  browser validation.

Exit criteria:

- Developers can run a recipe and attach a useful, redacted artifact bundle to a
  bug report.

Status: Completed in this pass.

Results:

- The scenario CLI now accepts `--artifact-dir`, `--artifacts`, and
  `--record-dir`.
- Artifact bundles contain `report.json`, `events.jsonl`, `failures.json`, and
  `metadata.json`.
- Artifact content is based on the redacted report and redacted command line.
- Failure bundles include summary, failed steps, expected/actual data, details,
  outputs, and stable execution indexes.
- Added `black-box-runner-artifacts.md` with the artifact file contract and
  commands.
- RTC dry-runs now expose synthetic `sendResult` and `matchedMessage` fields
  marked with `dryRun: true`, so provider-mode recipes can validate output
  extraction and downstream assertions before a live run.
- Added shared-test package scripts for dry-run, deterministic memory,
  remote-provider dry-run, browser dry-run, and browser live validation.
- Added root package scripts that call those shared-test commands.

Verification:

- Added a CLI test that writes artifacts for a failing secret-bearing recipe and
  asserts the secret is redacted across every artifact file.
- Added a CLI dry-run test that extracts RTC `sendResult` and `matchedMessage`
  outputs into a downstream `ASSERT` without invoking an RTC provider.
- Ran dry-run and artifact-producing commands for the deterministic and
  provider-mode recipes.

### Iteration 9: Scale Patterns

Goal: Support small-scale to larger black-box testing without changing the
runner's role.

Work:

- Add parallel step groups if recipes need concurrent actors.
- Add seeded random traffic plans with reproducible failures.
- Add a soak/monitor runner mode or wrapper around normal recipes.
- Add summary metrics for latency, failures, reconnects, and cleanup.

Exit criteria:

- Recipes can cover deterministic smoke tests, repeated timing tests, and longer
  traffic runs through the same network-call model.

Status: Partially completed in this pass.

Results:

- Added repeated scale mode to the scenario CLI with `--iterations`/`--runs`,
  `--duration-ms`/`--max-duration-ms`, and `--delay-ms`.
- Added matching recipe config under `execution.scale`.
- Repeated scale mode runs the same executable HTTP/WS/RTC/ASSERT/SET recipe
  independently and returns one aggregate report.
- Aggregate reports include per-run summaries, flattened `resultsList` entries
  with `runIndex` and `stepResultKey`, `outputsByRun`, and metrics for
  transport/action/status counts, run/step/connect/send/first-payload latency,
  failures, reconnects, and cleanup.
- Scale artifact bundles use the same redacted files from Iteration 8.
- Added shared-test and root scripts for deterministic `rallar-memory` scale
  smoke: `npm run test:shared-black-box:memory:scale`.

Deferred:

- Same-connection long-running soak was split out from scale mode and completed
  later in Iteration 12.
- Seeded traffic plans were split out from scale mode and completed later in
  Iteration 13.
- Bounded parallel step groups were split out from scale mode and completed
  later in Iteration 14.

Verification:

- Added a CLI test that runs two scale iterations, checks aggregate metrics, and
  checks aggregate artifacts.
- Ran the deterministic memory scale command through the root package script.

### Iteration 10: Companion Coverage Outside `black-box-runner`

Goal: Put deeper Rallar facade coverage in the right layer.

Work:

- Use package-level tests for direct facade method parity.
- Use `rallar-bb-test` or a browser harness for manual/remote UI-driven browser
  control where needed.
- Use app-specific tests for Rallar Data and media behavior if those require
  browser APIs beyond network calls.
- Keep only the external network observations in black-box runner recipes.

Exit criteria:

- Shared-test coverage improves without making `black-box-runner` a Rallar
  implementation.

Status: Completed in this pass.

Results:

- Added `rallar-bb-test/companion-coverage.ts` as an executable manifest for
  coverage ownership across `black-box-runner`, `rallar-bb-test`,
  shared-web facade tests, shared-server facade tests, and app-specific tests.
- Added runtime command-kind constants in `rallar-bb-test/types.ts` so tests can
  guard the bridge command surface.
- Added `RALLAR_FACADE_METHODS_NOT_RECIPE_COMMANDS` to make facade creep
  explicit: auth, rooms, people, message channel, realtime, RTC wait, data, and
  media methods are not black-box recipe commands.
- Added `rallar-companion-coverage.test.ts` to assert the runner vocabulary and
  direct-facade coverage boundaries.
- Added `rallar-bb-test/docs/companion-coverage.md` explaining which layer owns
  each coverage type.
- Added `npm run test:shared-black-box:companion` as the convenient companion
  coverage command.
- Fixed provider-parity conversion for `rallar-remote-browser` event-shaped RTC
  messages while preserving raw-message expectations for local bridge adapter
  parity tests.

Verification:

- Ran the new companion boundary tests.
- Ran `rallar-bb-test` and provider-parity focused tests with an explicit
  timeout for the remote-provider path.
- Ran the root companion coverage command.

## Follow-up Iterations After Iteration 10

The follow-up work below starts from the completed Iteration 1-10 baseline. It
keeps the same boundary: the runner executes observable HTTP, WS, RTC, ASSERT,
and SET behavior; Rallar-specific internals stay in providers, companion tests,
or app-level tests.

### Iteration 11: Live Recipe Matrix And Baseline Artifacts

Status: completed on 2026-05-28.

Goal: Prove the completed recipe examples against real services with clear
setup gates and durable artifacts.

Work:

- Add a recipe matrix that marks every example as dry-run, deterministic,
  local-browser live, remote-browser live, Rallar Server live, or intentionally
  failing.
- Add or refine root/package scripts that run the dry matrix quickly and the
  live matrix when the required Rallar Server, control server, browser, and env
  variables are present.
- Record redacted baseline artifacts for representative successful and failing
  live runs.
- Make skipped live tests explain the exact missing service, URL, env var, or
  browser dependency.
- Document how to refresh baselines when server behavior intentionally changes.

Exit criteria:

- A developer can run one quick recipe-matrix command for local confidence and
  one gated live command for real Rallar/Rallar Server validation.

Results:

- Added `black-box-runner/recipe-matrix.json` as the runnable catalog for dry,
  deterministic, live, remote-browser, signaling-only, and intentional-failure
  recipe variants.
- Added `black-box-runner/recipe-matrix.mts`, a Deno matrix runner with
  `--profile`, `--id`, `--artifact-dir`, `--list`, `--require-gates`,
  `--fail-fast`, and `--verbose`.
- The matrix records per-entry scenario artifact bundles plus
  `matrix-summary.json`.
- Live entries are gated by exact missing env vars, unavailable service URLs,
  and Playwright availability. Non-strict live mode skips unavailable gates;
  strict mode fails on skipped gates.
- Added package and root scripts for quick, dry, deterministic, live, and strict
  live matrix runs.
- Added `black-box-runner/docs/black-box-runner-recipe-matrix.md` with profiles,
  commands, artifact layout, skip behavior, and baseline refresh instructions.
- Updated older browser examples to use environment-backed variables for live
  API URL, room/group ID, usernames, passwords, message type, topic, and
  signaling URL where relevant.
- Added `recipe-matrix.test.ts` to verify unique entries, recipe coverage,
  profiles, execution modes, and live gates.

Verification:

- `npm run test:shared-black-box:matrix:quick` passed 6/6 entries.
- `npm run test:shared-black-box:matrix:dry` passed 10/10 entries.
- `npm run test:shared-black-box:matrix:deterministic` passed 2/2 entries,
  including the expected-failure routing diagnostics recipe.
- `npm run test:shared-black-box:matrix:live` exited successfully with 14
  skipped live entries because this local session did not have Rallar Server,
  browser credentials, control server, or signaling URL configured.
- `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts` passed.

### Iteration 12: Same-Connection Soak Mode

Status: completed on 2026-05-28.

Goal: Exercise long-lived WS/RTC connections without reducing soak testing to
independent repeated smoke runs.

Work:

- Add a soak mode or wrapper that can keep one set of WS/RTC connections open
  for a configured duration or message count.
- Support periodic sends, waits, heartbeats, reconnect observations, and cleanup
  checks over the same connections.
- Report latency percentiles, dropped/failed sends, reconnects, close events,
  memory-safe event counts, and cleanup status.
- Keep artifacts bounded through sampling, limits, and summary records.
- Add deterministic `rallar-memory` soak tests before live-provider soak tests.

Exit criteria:

- The runner can distinguish "fresh connection smoke passes" from "long-lived
  connection behavior stays healthy under repeated traffic."

Results:

- Added `execution.soak` support to the generic scenario CLI. Soak mode expands
  setup, loop, optional delay, and cleanup steps into one executable scenario so
  WS/RTC connection state stays in the same runner context.
- Added loop annotations in step results: `soakPhase`, `soakIteration`,
  `soakLoopIndex`, and preserved `repeatIndex` values for repeated loop steps.
- Added bounded artifact event output through `artifactLimits.maxEvents` and an
  `artifact-truncated` sentinel when event streams are capped.
- Added `summary.soak` and `metrics.soak` with observed iterations,
  transport/action/status counts, send and wait outcomes, latency percentiles,
  reconnect observations, event counts, and cleanup status.
- Added `messageCount`/`messages` handling that caps loop-step executions while
  `iterations`/`runs` continues to repeat complete loops.
- Added delay support to SET steps so soak loops can pause without adding a
  network-specific sleep primitive.
- Added deterministic same-connection coverage in
  `black-box-runner/examples/rtc-rallar-memory-same-connection-soak.json`.
- Added the `soak` recipe matrix profile plus package and root scripts:
  `bb:memory:soak`, `bb:matrix:soak`,
  `test:shared-black-box:memory:soak`, and
  `test:shared-black-box:matrix:soak`.
- Updated runner recipe, artifact, example, matrix, and shared-test
  verification docs for same-connection soak usage.

Verification:

- `npm run test:shared-black-box:memory:soak` passed.
- `npm run test:shared-black-box:matrix:soak` passed 1/1 entries.
- `npm run test:shared-black-box:matrix:deterministic` passed 3/3 entries,
  including the same-connection soak entry and the expected-failure routing
  diagnostics recipe.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "soak|messageCount"`
  passed 2 focused tests.
- `npm --workspace @ar-eye-hunter/shared-test run check:deno` passed.
- `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts packages/tests/shared-test/scenario-black-box-config.test.ts`
  passed 19 tests.
- `npm run check:shared-test` passed.
- `git diff --check` passed.

### Iteration 13: Seeded Traffic Plans And Replay

Status: completed on 2026-05-28.

Goal: Add reproducible randomized traffic without making failures impossible to
debug.

Work:

- Add a seeded traffic-plan config for actors, rooms, transports, operation
  weights, payload templates, delays, and stop conditions.
- Expand every generated plan into a concrete executable plan before running it.
- Store the seed, generator config, expanded plan, and failure bundle in
  artifacts.
- Add exact replay from a stored expanded plan.
- Start with deterministic `rallar-memory` coverage, then add gated
  browser/Rallar Server coverage.

Exit criteria:

- A failing randomized run can be replayed exactly from its artifact bundle.

Results:

- Added `execution.trafficPlan` support to the scenario CLI. The runner now
  expands weighted operations into concrete HTTP/WS/RTC/ASSERT/SET steps before
  execution.
- Added deterministic seeded generation with operation weights, operation
  count, setup steps, cleanup steps, optional delay steps, and traffic
  placeholders for seed, sequence, operation, operation index, random value, and
  random integer.
- Added `expanded-plan.json` artifacts containing the seed, generator summary,
  operation decisions, expanded concrete steps, and a replay recipe.
- Added exact replay through `execution.trafficPlan.replayFrom` or embedded
  `execution.trafficPlan.expandedPlan`.
- Added `summary.trafficPlan` and `trafficPlan.decisions` to reports.
- Added deterministic `rallar-memory` seeded traffic coverage in
  `black-box-runner/examples/rtc-rallar-memory-seeded-traffic.json`.
- Added `traffic` recipe matrix profile plus package and root scripts:
  `bb:memory:traffic`, `bb:matrix:traffic`,
  `test:shared-black-box:memory:traffic`, and
  `test:shared-black-box:matrix:traffic`.

Verification:

- `npm run test:shared-black-box:memory:traffic` passed.
- `npm run test:shared-black-box:matrix:traffic` passed 1/1 entries.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "traffic|parallel"`
  passed the focused traffic and parallel tests.

### Iteration 14: Bounded Parallel Step Groups

Status: completed on 2026-05-28.

Goal: Support concurrent actors and race-sensitive network behavior while
preserving deterministic reports.

Work:

- Add explicit recipe syntax for bounded parallel step groups.
- Define max concurrency, join behavior, timeout behavior, output scoping, and
  result ordering.
- Make partial failures and cancellation behavior visible in reports.
- Add deterministic memory-provider examples for concurrent direct, multicast,
  broadcast, reconnect, and close flows.
- Add live-provider examples only after the deterministic semantics are stable.

Exit criteria:

- Recipes can model controlled concurrency without relying on ad hoc shell
  scripts or hidden provider behavior.

Results:

- Added `type: "parallel"` recipe steps with named groups, per-group sequential
  child steps, `maxConcurrency`, `timeoutMs`, and group-level fail-fast control.
- Added `PARALLEL` execution support in the runner. Parent results report group
  count, max concurrency, per-group child result keys, success/failure counts,
  timeout status, and duration.
- Sorted report `resultsList` and `resultsByName` deterministically by
  scenario and interaction execution number, so concurrent completion order does
  not make artifacts unstable.
- Made partial failures visible through child step results and parent
  `PARALLEL` failure summaries.
- Added deterministic `rallar-memory` parallel coverage in
  `black-box-runner/examples/rtc-rallar-memory-parallel-groups.json` for
  concurrent direct delivery, broadcast delivery, close, and reconnect. The
  in-memory provider does not model multicast separately from broadcast; live
  browser multicast remains covered by the browser `messages.rtc` examples.
- Added `parallel` recipe matrix profile plus package and root scripts:
  `bb:memory:parallel`, `bb:matrix:parallel`,
  `test:shared-black-box:memory:parallel`, and
  `test:shared-black-box:matrix:parallel`.

Verification:

- `npm run test:shared-black-box:memory:parallel` passed.
- `npm run test:shared-black-box:matrix:parallel` passed 1/1 entries.
- `npm run test:shared-black-box:matrix:deterministic` passed 5/5 entries,
  including seeded traffic and parallel groups.
- `npm run test:shared-black-box:matrix:quick` passed 6/6 entries.
- `npx vitest run packages/tests/shared-test/scenario-black-box-config.test.ts -t "traffic|parallel"`
  passed the focused traffic and parallel tests.
- `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts packages/tests/shared-test/scenario-black-box-config.test.ts`
  passed 21 tests.
- `npm run check:shared-test` passed.
- `git diff --check` passed.

### Iteration 15: Package, Typecheck, And CI Hardening

Status: completed on 2026-05-28.

Goal: Make the shared-test package reliable as a CI target and dependency for
the command center.

Work:

- Split or fix Node, Deno, browser, and Playwright type boundaries so package
  typecheck commands are meaningful.
- Ensure shared-test scripts have clear names for unit, Deno check, dry recipe
  matrix, deterministic recipe matrix, live recipe matrix, scale, and companion
  coverage.
- Keep generated artifacts ignored and reproducible.
- Add CI documentation that separates fast local checks from live integration
  checks.
- Remove or document known typecheck exceptions instead of leaving them implicit.

Exit criteria:

- The shared-test package has a clean, documented verification path that can be
  run from the root package scripts and by CI.

Results:

- Split shared-test verification into `check:ts`, `check:deno`, and `check`.
- Updated `typecheck` to run the full shared-test check path.
- Added root `check:shared-test`.
- Added explicit root/package scripts for recipe matrix quick, dry,
  deterministic, live, strict live, scale, and companion coverage commands.
- Added `docs/shared-test-verification.md` to separate fast local checks,
  deterministic recipe checks, gated live checks, strict live CI checks, and
  generated artifact handling.
- Fixed the existing TypeScript failures in the browser Rallar runtime by
  resolving scoped room operations to a concrete workspace scope, removing an
  unsupported `roomRef` field from `rooms.join`, and adding the
  `minSnapshotVersion` config field used by `messages.rtc` sends.
- Added a minimal Deno global declaration for the TypeScript package check and
  a Deno check script for the Deno CLI entrypoints.

Verification:

- `npm --workspace @ar-eye-hunter/shared-test run check` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:deno` passed.
- `npm run check:shared-test` passed from the repository root.
- `npx vitest run packages/tests/shared-test/rallar-browser-runtime.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
  passed.
- `npm run test:shared-black-box:companion` passed 8 files / 131 tests.

### Iteration 16: Command-center Handoff Contract

Status: completed on 2026-05-28.

Goal: Give `apps/rallar-black-box` a stable way to consume recipes, reports,
artifacts, and coverage ownership without parsing runner internals.

Work:

- Export or document a stable recipe catalog shape with prerequisites, provider
  mode, required env vars, expected result, and live/dry-run support.
- Export or document the artifact bundle contract for report summaries, JSONL
  events, failure bundles, redacted variables, and metadata.
- Add lightweight schemas or TypeScript types that the SPA/control server can use
  for recipe catalogs and artifact browsing.
- Document how companion coverage maps to command-center UI tests so the SPA
  does not duplicate facade-level shared-test coverage.
- Add a small fixture catalog that the SPA can display without needing live
  services.

Exit criteria:

- The command center can build recipe and artifact UI on top of shared-test
  contracts instead of copying runner implementation details.

Results:

- Added `black-box-runner/handoff-contract.ts` with stable TypeScript types for
  recipe catalogs, catalog entries, requirements, provider mode, live/dry-run
  support, expected result, command snippets, artifact bundle contracts, and
  coverage ownership.
- Added `toBlackBoxRunnerRecipeCatalog(matrix)` so server-side tooling can
  normalize `recipe-matrix.json` into a command-center-friendly catalog.
- Added `BLACK_BOX_RUNNER_COMMAND_CENTER_FIXTURE_CATALOG`, a browser-safe static
  fixture catalog that the SPA can display without file access or live services.
- Added `BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT` for `report.json`,
  `events.jsonl`, `failures.json`, `metadata.json`, optional
  `expanded-plan.json`, optional `matrix-summary.json`, JSONL event kinds, and
  redaction placeholders.
- Added `BLACK_BOX_RUNNER_COVERAGE_HANDOFF` to document ownership across
  `black-box-runner`, `rallar-bb-test`, the SPA, the control server, and
  shared-web/shared-server tests.
- Added a SPA re-export in
  `apps/rallar-black-box/src/shared-test-handoff-fixtures.ts`.
- Added `black-box-runner/docs/black-box-runner-command-center-handoff.md` and
  linked it from the artifact and recipe docs.
- Added focused contract coverage in
  `packages/tests/shared-test/black-box-runner-handoff-contract.test.ts`.

Verification:

- `npx vitest run packages/tests/shared-test/black-box-runner-handoff-contract.test.ts`
  passed.
- `npm run check:shared-test` passed.
- `npm run build:rallar-black-box` passed.
- `git diff --check` passed.

## Review After Iterations 1-19

The original shared-test gap is now substantially closed at the deterministic
and contract layers:

- Iterations 1-3 established the runner boundary, generic recipe ergonomics, and
  Rallar Server HTTP/WS examples.
- Iterations 4-7 aligned browser/remote RTC provider behavior, scoped delivery,
  readiness diagnostics, NACK/delivery recipes, and remote-browser parity.
- Iterations 8-11 added redacted artifacts, scale mode, companion coverage,
  recipe matrix gating, and baseline artifact commands.
- Iterations 12-14 added same-connection soak, seeded traffic replay, and
  bounded parallel groups.
- Iterations 15-16 hardened package verification and gave the command center a
  stable recipe/artifact/coverage contract.
- Iteration 17 added gated live browser/remote-browser baselines for
  same-connection soak, seeded traffic, and bounded parallel RTC.
- Iterations 18-19 added browser-safe artifact readers, validation utilities,
  versioned fixtures, compatibility tests, and migration rules.

No additional shared-test iteration is required before the command center starts
recipe catalog and artifact browsing work. The remaining shared-test work is
strict live-baseline capture in a provisioned environment rather than a code
blocker.

## Completed Follow-up Iterations After Iteration 16

### Iteration 17: Live Provider Soak, Traffic, And Parallel Baselines

Status: completed on 2026-05-28.

Goal: Prove the deterministic soak, traffic, and parallel patterns against real
browser/remote-browser providers where the environment is intentionally
provisioned.

Work:

- Add gated live recipes for browser-backed same-connection soak.
- Add gated live recipes for seeded traffic over `messages.rtc` and/or
  `realtime`.
- Add gated live recipes for bounded parallel browser actors.
- Keep deterministic `rallar-memory` recipes as the fast local baseline.
- Record redacted live artifact baselines and skip reasons.

Exit criteria:

- The live recipe matrix covers long-lived, generated, and concurrent RTC
  behavior without weakening local deterministic checks.

Results:

- Added gated live `messages.rtc` recipes for the high-risk RTC patterns:
  `rtc-rallar-browser-messages-rtc-same-connection-soak.json`,
  `rtc-rallar-browser-messages-rtc-seeded-traffic.json`, and
  `rtc-rallar-browser-messages-rtc-parallel-groups.json`.
- Each recipe can run locally with `rallar-browser` or through the control
  server with `rallar-remote-browser` by setting `RALLAR_BB_RTC_PROVIDER`.
- Added recipe-matrix entries for browser and remote-browser variants under
  `live-soak`, `live-traffic`, and `live-parallel` profiles while keeping the
  deterministic `soak`, `traffic`, and `parallel` profiles on `rallar-memory`.
- Added package and root scripts:
  `bb:matrix:live:soak`, `bb:matrix:live:traffic`,
  `bb:matrix:live:parallel`,
  `test:shared-black-box:matrix:live:soak`,
  `test:shared-black-box:matrix:live:traffic`, and
  `test:shared-black-box:matrix:live:parallel`.
- Updated command-center handoff catalog support so the new live profiles
  produce copyable commands and representative fixture entries.
- Updated runner docs, example indexes, artifact docs, the browser RTC runbook,
  shared-test verification docs, and the command-center improvement plan.
- Documented the traffic-plan authoring rule that generated operation steps are
  expanded before normal variable resolution, so generated step templates should
  use `{traffic.*}` placeholders or connection-level defaults.

Verification:

- New recipes passed dry-run scenario execution, including a focused assertion
  that the traffic recipe no longer expands Rallar routing fields to
  `undefined`.
- `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts packages/tests/shared-test/black-box-runner-handoff-contract.test.ts`
  passed 9 tests.
- `npm run check:shared-test` passed.
- `npm run test:shared-black-box:matrix:live:soak` passed in non-strict mode
  with 2 gated skips and explicit missing-env/service reasons.
- `npm run test:shared-black-box:matrix:live:traffic` passed in non-strict mode
  with 2 gated skips and explicit missing-env/service reasons.
- `npm run test:shared-black-box:matrix:live:parallel` passed in non-strict mode
  with 2 gated skips and explicit missing-env/service reasons.

Remaining notes:

- This iteration added gated live baselines and verified recipe shape locally.
  It did not capture a green deployed-service artifact baseline because this
  environment did not have Rallar API credentials, a running API, or a running
  control-server agent.

### Iteration 18: Artifact Reader And Validation Utilities

Status: completed on 2026-05-28.

Goal: Make artifact import safer for the SPA and control server.

Work:

- Add small validators/readers for `report.json`, `events.jsonl`,
  `failures.json`, `metadata.json`, `expanded-plan.json`, and
  `matrix-summary.json`.
- Validate event kinds, required summary fields, redaction placeholders, and
  expanded-plan replay fields.
- Provide typed parse results that the SPA can map into Event Stream, RTC
  Diagnostics, failure focus, and recipe replay UI.
- Add fixture artifact bundles for tests without requiring generated local
  `.artifacts` output.

Exit criteria:

- The command center can reject malformed artifact bundles with actionable
  errors instead of relying on unchecked JSON parsing.

Results:

- Added `black-box-runner/artifact-reader.ts`, a browser-safe parser that
  accepts artifact file text instead of reading from disk.
- Added individual parsers for `report.json`, `events.jsonl`, `failures.json`,
  `metadata.json`, `expanded-plan.json`, and `matrix-summary.json`.
- Added bundle-level parsing with command-center views for Event Stream, RTC
  Diagnostics, RTC messages, WS messages, failures, and traffic replay recipes.
- Validated required summary fields, event kinds, redaction placeholders,
  expanded-plan replay fields, and matrix summary counts.
- Re-exported the artifact parser and validation types through
  `apps/rallar-black-box/src/shared-test-handoff-fixtures.ts`.
- Added `black-box-runner/docs/black-box-runner-artifact-reader.md`.

Verification:

- `npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts`
  passed.
- `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed after adding
  the parser.

### Iteration 19: Versioned Recipe And Artifact Schema Fixtures

Status: completed on 2026-05-28.

Goal: Keep the command-center contract stable as recipe and artifact shapes
evolve.

Work:

- Add explicit schema version fixtures for recipe catalog entries and artifact
  bundles.
- Add compatibility tests for older fixture versions.
- Document migration rules for catalog fields, event kinds, and expanded-plan
  replay data.
- Add a changelog section for command-center consumers.

Exit criteria:

- The SPA/control server can upgrade shared-test without silently breaking
  catalog or artifact import behavior.

Results:

- Added explicit schema fixtures under
  `black-box-runner/fixtures/schema/v1/` for recipe catalog entries and
  artifact bundles.
- Added legacy compatibility fixtures under
  `black-box-runner/fixtures/schema/v0/` for artifacts and catalog entries
  without explicit schema versions.
- Added catalog-entry fixture validation and normalization in
  `artifact-reader.ts`, including migration from legacy `recipe` to
  `recipePath` and defaulting of command-center UI/support fields.
- Added schema version constants for artifact bundles and recipe catalog
  entries.
- Documented migration rules for catalog fields, event kinds, and expanded-plan
  replay data, plus a compatibility changelog.
- Included the artifact reader in shared-test Deno checks.

Verification:

- `npx vitest run packages/tests/shared-test/black-box-runner-artifact-reader.test.ts`
  passed the current and legacy fixture tests.

## Recommended Follow-up Order

Iterations 1-19 are complete. No additional shared-test iteration is required
before the command center starts recipe catalog and artifact browsing work.
The remaining shared-test follow-up is operational rather than a blocker:

- capture a strict live Iteration 17 baseline when a provisioned Rallar
  environment is available

For product work, move to the command-center plan and start with the
recipe/artifact catalog bridge. The command-center docs alignment is now
recorded in `apps/rallar-black-box/command-center-improvement-iterations.md`.
