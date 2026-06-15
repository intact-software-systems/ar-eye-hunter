# Black-box Runner Examples

This directory contains executable JSON recipes for the black-box runner.
The runnable recipe matrix in `../recipe-matrix.json` classifies dry-run,
deterministic, live, remote-browser, and intentional-failure variants for these
examples.

## Example Index

| Recipe | Category | Purpose |
| --- | --- | --- |
| `rallar-server-register-login.json` | Rallar Server integration | Register a runtime user if possible, tolerate already-existing users, login, logout, and verify invalid-password rejection. |
| `rallar-server-auth-group-ws-smoke.json` | Rallar Server integration | Login, derive redacted auth/WS values with safe transforms, add runner correlation headers to HTTP calls, create or reuse `bb-group`, join it, connect group presence, open authenticated WS, send a self-addressed AL message, close WS, disconnect presence, and logout. |
| `rallar-server-negative-auth.json` | Rallar Server integration | Verify missing bearer token, missing `x-client-id`, invalid login, and unauthenticated WS-ticket rejection. |
| `rallar-server-ws-rtc-payload-parity.json` | Rallar Server and browser RTC integration | Send the same payload through authenticated WS and browser-backed `messages.rtc`, then assert parity from the report outputs. |
| `rtc-rallar-memory-delivery-semantics.json` | Generic runner semantics | Use deterministic `rallar-memory` peers to assert direct delivery, room broadcast delivery, delivery metadata, and payload parity between recipients. |
| `rtc-rallar-memory-routing-failures.json` | Generic runner semantics | Intentionally records no-recipient, closed-target, and send-after-close failures with `failFast: false` so report diagnostics can be inspected. |
| `rtc-rallar-memory-same-connection-soak.json` | Generic runner semantics | Keeps two deterministic `rallar-memory` RTC connections open, sends repeated bidirectional payloads, records soak metrics, enforces post-run thresholds, and closes both connections once. |
| `rtc-rallar-memory-seeded-traffic.json` | Generic runner semantics | Generates weighted seeded RTC traffic, records `expanded-plan.json`, and can be replayed exactly from the artifact. |
| `rtc-rallar-memory-inline-loop-pacing.json` | Generic runner semantics | Sends deterministic RTC frame traffic through an inline `type: "loop"` at a configured realtime rate. |
| `rtc-rallar-memory-parallel-groups.json` | Generic runner semantics | Runs bounded parallel RTC groups for concurrent direct delivery, broadcast delivery, close, and reconnect with deterministic reporting. |
| `rtc-rallar-browser-connect.json` | Rallar integration | Connect and close two browser-backed Rallar RTC actors. Use this to validate browser harness startup, Rallar auth/configuration, room join, and provider cleanup. |
| `rtc-rallar-browser-realtime.json` | Rallar integration | Send JSON between two browser-backed actors through Rallar realtime RTC and assert received payloads. |
| `rtc-rallar-browser-messages-rtc.json` | Rallar integration | Send app-level `rallar.messages.rtc` payloads between two browser-backed actors and assert received payloads. |
| `rtc-rallar-browser-messages-rtc-same-connection-soak.json` | Rallar integration | Gated live browser/remote-browser `messages.rtc` same-connection soak using `execution.soak`. |
| `rtc-rallar-browser-messages-rtc-seeded-traffic.json` | Rallar integration | Gated live browser/remote-browser seeded `messages.rtc` traffic with `expanded-plan.json` replay artifacts. |
| `rtc-rallar-browser-messages-rtc-parallel-groups.json` | Rallar integration | Gated live browser/remote-browser bounded parallel `messages.rtc` sends. |
| `rtc-rallar-browser-messages-rtc-multicast.json` | Rallar integration | Send one app-level `messages.rtc` payload without explicit next hops and assert two room peers receive the same data. |
| `rtc-rallar-browser-provider-mode-parity.json` | Rallar integration | Run the same browser RTC recipe locally with `rallar-browser` or through the control server with `rallar-remote-browser`. |
| `rtc-rallar-browser-scoped-workspaces.json` | Rallar integration | Use `roomRef` to connect actors to the same `roomId` in separate workspaces, then assert scoped delivery inside one workspace. |
| `rtc-rallar-browser-not-yet-in-sync.json` | Rallar integration | Send with a future `minSnapshotVersion` and assert the observable `not-yet-in-sync` NACK message. |
| `rtc-rallar-browser-readiness-diagnostics.json` | Rallar integration | Wait for provider readiness diagnostics and health after browser-backed RTC connect. |
| `rtc-rallar-browser-timeout-diagnostics.json` | Rallar integration | Intentionally waits for a missing diagnostic to demonstrate timeout failure diagnostics. |
| `rtc-rallar-two-peer-chat.json` | Signaling-only integration | Uses the explicit `rallar-signaling` provider. This opens WebSocket signaling and exercises runner expectations, but it does not prove a real WebRTC data path. |
| `rallar-crdt-browser-ws-convergence.json` | Rallar CRDT integration | Opens the same CRDT document in two browser actors, applies concurrent WS-backed updates, waits for value/health convergence, reads outputs, and asserts both materialized values. |
| `rallar-crdt-browser-rtc-with-ws-fallback.json` | Rallar CRDT integration | Exercises user-selectable `rtc-with-ws-fallback` CRDT transport with a sequence insert, wait-based convergence, and health assertions. |
| `rallar-crdt-browser-durable-late-join-catchup.json` | Rallar CRDT integration | Writes before a second browser actor joins, then waits for durable HTTP catch-up and asserts the late-join value. |
| `rallar-crdt-browser-local-persistence-reopen.json` | Rallar CRDT integration | Covers local-only CRDT persistence, close, reopen, wait/read, assert, and destroy from a browser-backed provider session. |
| `rallar-crdt-admin-http-integrity.json` | Rallar CRDT admin integration | Uses normal `http.request` steps for CRDT admin document list and integrity endpoints. |

## Provider Choice

Use `rallar-memory` examples for deterministic runner semantics. Use
`rallar-browser` examples for real browser-backed Rallar RTC. Use the default
`rallar` provider only when the test is specifically about signaling WebSocket
behavior.

`rtc-rallar-memory-routing-failures.json` and
`rtc-rallar-browser-timeout-diagnostics.json` are intentionally failing
diagnostic recipes. They are useful when checking report shape, failure
classification, and copyable diagnostics, not as green smoke tests.

The runner should stay provider-neutral. If a recipe needs Rallar-specific
configuration, keep it under provider-owned fields such as `rallar`, `browser`,
`control`, or `signaling`.

CRDT recipes use generic `crdt.*` step types only with browser-capable
providers. The runner forwards those steps to the provider; the CRDT engine
remains in the browser Rallar facade and `rallar-bb-test` command surface.
CRDT admin workflows should continue to use ordinary HTTP steps.

Use safe transforms for derived generic values such as auth headers, URL-encoded
tickets, trace IDs, JSON conversion, and fallback values. Transforms are
declarative runner plumbing, not Rallar-specific commands.

Use post-run assertions for aggregate pass/fail gates such as send success
ratio, p95 latency, diagnostic warning/error counts, and artifact truncation
status. They are evaluated after the final report metrics are assembled and are
written to both `report.json` and `events.jsonl`.

Use `execution.correlation` when a recipe should be searchable in server logs.
The runner always records `runnerRunId` and `runnerStepId` in artifacts.
`injectHeaders` adds those IDs to HTTP requests, and `injectPayloads` adds them
to object-shaped WS/RTC send payloads under `blackBoxRunner`.

Scoped Rallar RTC recipes can pass `applicationId`, `workspaceId`, `scope`,
`roomRef`, and `minSnapshotVersion` on connection config or send payloads. The
browser-backed providers forward those values to the Rallar browser facade and
preserve the resolved scope diagnostics in RTC step results.

RTC recipes can wait for diagnostics with `expect.diagnostic` or
`expect.diagnostics`, and can poll provider health with `expect.health`. Use
these for sensitive connect/readiness stages where the failure report should
show which phase or readiness signal was missing.

`rallar-remote-browser` is an execution mode for the same generic HTTP, WS, and
RTC recipe steps. The recipe should still say `http`, `ws.open`, `ws.send`,
`rtc.connect`, and `rtc.send`; the provider forwards those commands to the
control server and maps returned browser events back into `wsMessages`,
`wsCloseEvents`, `rtcMessages`, `rtcDiagnostics`, and `rtcCloseEvents`.

Run the provider-mode parity recipe locally:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-browser-provider-mode-parity.json
```

Run the same recipe through the control server:

```bash
RALLAR_BB_RTC_PROVIDER=rallar-remote-browser \
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-browser-provider-mode-parity.json
```

## Running Examples

Dry-run a recipe without launching browser providers or mutating runtime state:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-browser-realtime.json \
  --dry-run
```

Explain or validate a recipe before dry-run or live execution:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-browser-realtime.json \
  --explain
```

`--explain` and `--validate` emit machine-readable JSON and stop before any
HTTP, WS, or RTC call. The output includes expanded operation counts, live
requirements, env and connection gaps, static include/fragments metadata,
traffic-plan expansion metadata, output wiring, redaction sources, and
structured issues. Add `--strict` to fail known step types with missing
required authoring fields.

Run live-environment preflight before launching a live matrix:

```bash
npm run test:shared-black-box:matrix:live:preflight
```

This writes `preflight-report.json` per selected live entry and checks the
Rallar API, `/api/config`, configured credentials, group permissions, WS ticket
and upgrade, ICE config, optional control server, and Playwright before browser
recipes start.

Run the browser-backed live validation wrapper when a Rallar environment and
test credentials are available:

```bash
deno run -A packages/shared-test/black-box-runner/rallar-browser-live-validation.mts \
  --mode=both \
  --transport=both \
  --record-dir=.artifacts/rallar-browser-rtc
```

For one-off local runs, replace example variables at the CLI:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-browser-connect.json \
  -r rallarApiBaseUrl:=http://localhost:8080,aliceUsername:=alice,alicePassword:=secret,bobUsername:=bob,bobPassword:=secret
```

Run the Rallar Server HTTP/WS smoke recipe against a local `apps/api-v1`
server:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rallar-server-auth-group-ws-smoke.json
```

Write a redacted artifact bundle for any recipe:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-delivery-semantics.json \
  --artifact-dir=.artifacts/shared-test/rallar-memory-delivery
```

Artifact bundles include `artifact-index.json` for large-run browsing and
`expanded-recipe.json` for replaying recipes after static includes/fragments
have been resolved. Use `execution.artifacts.maxEvents` or
`execution.artifacts.maxEventsByKind` to compact repeated success events while
preserving failures and RTC diagnostics.

Root-level convenience commands:

```bash
npm run test:shared-black-box:matrix:quick
npm run test:shared-black-box:matrix:dry
npm run test:shared-black-box:matrix:deterministic
npm run test:shared-black-box:matrix:soak
npm run test:shared-black-box:matrix:traffic
npm run test:shared-black-box:matrix:parallel
npm run test:shared-black-box:matrix:live
npm run test:shared-black-box:matrix:live:soak
npm run test:shared-black-box:matrix:live:traffic
npm run test:shared-black-box:matrix:live:parallel
npm run test:shared-black-box:dry
npm run test:shared-black-box:memory
npm run test:shared-black-box:memory:scale
npm run test:shared-black-box:memory:soak
npm run test:shared-black-box:memory:traffic
npm run test:shared-black-box:memory:parallel
npm run test:shared-black-box:remote:dry
npm run test:shared-black-box:browser:dry
```

Use `npm run test:shared-black-box:matrix:live:strict` or
`npm run test:shared-black-box:browser:live` only when a live Rallar environment
and credentials are configured.

The live soak, traffic, and parallel matrix commands are also gated. They
include local `rallar-browser` entries and remote `rallar-remote-browser`
entries. Remote entries require `RALLAR_BLACK_BOX_CONTROL_BASE_URL` and
`RALLAR_BLACK_BOX_AGENT_ID` in addition to the Rallar API and test credentials.

The matrix command records skip reasons when live gates are missing. See
`../docs/black-box-runner-recipe-matrix.md` for profiles, strict mode, and
baseline refresh instructions.

Run a repeated deterministic scale smoke locally:

```bash
npm run test:shared-black-box:memory:scale
```

This runs the deterministic `rallar-memory` delivery recipe three times, writes
an aggregate artifact bundle under `.artifacts/shared-test/rallar-memory-scale`,
and reports per-run summaries plus latency/failure/reconnect/cleanup metrics.

Run a deterministic same-connection soak locally:

```bash
npm run test:shared-black-box:memory:soak
```

This keeps Alice and Bob connected through the `rallar-memory` provider, sends
five bidirectional RTC loop iterations over the same connections, writes a
bounded artifact bundle plus `artifact-index.json` under
`.artifacts/shared-test/rallar-memory-soak`, and reports `summary.soak` plus
`metrics.soak`.

Run deterministic seeded traffic and parallel group examples locally:

```bash
npm run test:shared-black-box:memory:traffic
npm run test:shared-black-box:memory:parallel
```

The traffic example writes `expanded-plan.json` under
`.artifacts/shared-test/rallar-memory-traffic`. Reuse that file through
`execution.trafficPlan.replayFrom` to replay the exact generated operation
sequence.

After a failing traffic run, create a smaller replay candidate without rerunning
the scenario:

```bash
deno run -A packages/shared-test/black-box-runner/traffic-plan-reducer.ts \
  --artifact-dir=.artifacts/shared-test/rallar-memory-traffic
```

This writes `reduced-plan.json` and `reduced-plan-summary.json`; replay the
candidate with `execution.trafficPlan.replayFrom`.

The inline loop pacing example is also deterministic and runs without live
services:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-memory-inline-loop-pacing.json
```

Run live-provider baselines when the Rallar API, credentials, Playwright, and
optional control server are intentionally provisioned:

```bash
npm run test:shared-black-box:matrix:live:soak
npm run test:shared-black-box:matrix:live:traffic
npm run test:shared-black-box:matrix:live:parallel
```

The smoke recipe defaults to:

- `RALLAR_API_BASE_URL=http://localhost:8080`
- `RALLAR_WS_BASE_URL=ws://localhost:8080`
- `RALLAR_BB_USERNAME=alice`
- `RALLAR_BB_PASSWORD=secret`
- `RALLAR_BB_GROUP_ID=bb-group`

The group is intentionally not deleted by the recipe. Later runs tolerate the
existing group and rejoin it. The recipe disconnects group presence, closes WS,
and logs out the auth session.

The current comma-separated replacement format is brittle for secrets that
contain commas. Prefer environment-backed variables or environment-specific
wrapper scripts for live credentials.

New recipes can also read environment values directly:

```json
{
  "variables": {
    "rallarApiBaseUrl": {
      "env": "RALLAR_API_BASE_URL",
      "default": "http://localhost:8080"
    },
    "alicePassword": {
      "env": "RALLAR_ALICE_PASSWORD",
      "required": true,
      "secret": true
    }
  }
}
```

Use `outputPath` and `outputs` to pass IDs, tokens, and observed status values
between HTTP, WS, RTC, ASSERT, and SET steps.

WS sends expose `sendResult.status`, `sendResult.readyStateName`,
`sendResult.bufferedAmount`, `sendResult.wirePayload`, and send timing fields.
RTC sends expose provider `sendResult` values when available, including failed
provider responses when the provider attaches them to the thrown error.

## Adding Examples

When adding an example, classify it as one of these:

- Generic runner semantics: validates the runner itself, normally with fake or
  deterministic providers.
- Rallar Server integration: tests public REST or WebSocket behavior against a
  real server.
- Rallar browser integration: tests real browser-backed RTC behavior through
  `rallar-browser` or `rallar-remote-browser`.

Do not add recipe commands that mirror Rallar facade methods. Express the test
as HTTP, WS, RTC, ASSERT, and SET steps, and let providers or browser bridges
own any Rallar-specific implementation detail.

Direct Rallar facade behavior belongs in companion package or app-level tests.
See `../../rallar-bb-test/docs/companion-coverage.md` from
`packages/shared-test/black-box-runner/examples`.
