# Rallar Browser RTC Runbook

This runbook covers operational use of the black-box runner with the real browser-backed RTC provider:

```text
rallar-browser
```

Use this provider when the goal is to verify deployed Rallar REST, signaling, room membership, browser WebRTC, and RTC payload delivery end to end.

Use `rallar-memory` for fast deterministic runner semantics tests. Use `rallar-browser` for live integration tests where real browser behavior matters.

## Prerequisites

Install repository dependencies:

```bash
npm install
```

Install Chromium for Playwright:

```bash
npx playwright install chromium
```

On Linux CI images that do not already contain browser system libraries, use:

```bash
npx playwright install --with-deps chromium
```

The provider imports Playwright and Vite lazily. Dry-run mode can list/validate RTC interactions without launching Chromium.

## Required Services

Before running a live `rallar-browser` scenario, the deployed Rallar services must be reachable from the machine running the black-box runner:

- Rallar REST API base URL
- Rallar signaling path behind the browser Rallar facade
- a room that both browser users can join, or credentials allowed to join/create the configured room depending on server policy
- two test users with valid credentials

The browser pages are headless by default and connect to the deployed API from the local Playwright browser process.

## Environment

The scenario CLI does not read environment variables directly. Pass values with `-r` replacements and let the shell expand the environment variables:

```bash
export RALLAR_API_BASE_URL="https://api.example.com"
export RALLAR_ROOM_ID="room-1"
export RALLAR_ALICE_USERNAME="alice"
export RALLAR_ALICE_PASSWORD="secret"
export RALLAR_BOB_USERNAME="bob"
export RALLAR_BOB_PASSWORD="secret"
```

The replacement string must not contain unescaped commas because the current CLI splits replacements on commas.

## Live Validation Harness

Iteration 9 adds a wrapper that runs the provider-mode live validation scenarios through the normal scenario CLI:

```bash
deno run -A packages/shared-test/black-box-runner/rallar-browser-live-validation.mts \
  --mode=dry-run \
  --transport=both
```

The same command is exposed through the shared-test workspace:

```bash
npm --workspace @ar-eye-hunter/shared-test run rtc:browser:validate -- \
  --mode=dry-run \
  --transport=both
```

Supported modes:

| Mode | Meaning |
| --- | --- |
| `dry-run` | Runs the scenario engine with `--dry-run`; no browser/network transport is invoked. |
| `live` | Runs the selected browser RTC scenarios against deployed Rallar services. |
| `both` | Runs dry-run first, then live. |

Supported transports:

| Transport | Scenario |
| --- | --- |
| `realtime` | `examples/rtc-rallar-browser-realtime.json` |
| `messages.rtc` | `examples/rtc-rallar-browser-messages-rtc.json` |
| `both` | Runs both scenarios. |

Live mode fails before starting the scenario runner unless these variables are set:

- `RALLAR_API_BASE_URL`
- `RALLAR_ROOM_ID`
- `RALLAR_ALICE_USERNAME`
- `RALLAR_ALICE_PASSWORD`
- `RALLAR_BOB_USERNAME`
- `RALLAR_BOB_PASSWORD`

Optional variables:

- `RALLAR_MESSAGE_TYPE_ID`, default `black-box.chat.message`
- `RALLAR_TOPIC_ID`, default `black-box.chat`

To capture redacted CI artifacts:

```bash
deno run -A packages/shared-test/black-box-runner/rallar-browser-live-validation.mts \
  --mode=both \
  --transport=both \
  --record-dir=.artifacts/rallar-browser-rtc
```

The wrapper redacts password fields and known password environment values before printing or writing artifacts. Use `--verbose` when the full redacted report is needed in stdout.

## Dry Run

Use dry-run before live browser runs. This checks scenario expansion and RTC provider registration without invoking browser/network transports:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-browser-realtime.json \
  -n \
  -r "rallarApiBaseUrl:=${RALLAR_API_BASE_URL},roomId:=${RALLAR_ROOM_ID},aliceUsername:=${RALLAR_ALICE_USERNAME},alicePassword:=${RALLAR_ALICE_PASSWORD},bobUsername:=${RALLAR_BOB_USERNAME},bobPassword:=${RALLAR_BOB_PASSWORD}"
```

To inspect the executable interactions instead of running the engine:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-browser-realtime.json \
  -e dry \
  -r "rallarApiBaseUrl:=${RALLAR_API_BASE_URL},roomId:=${RALLAR_ROOM_ID},aliceUsername:=${RALLAR_ALICE_USERNAME},alicePassword:=${RALLAR_ALICE_PASSWORD},bobUsername:=${RALLAR_BOB_USERNAME},bobPassword:=${RALLAR_BOB_PASSWORD}"
```

## Live Realtime Run

Run browser-backed realtime data-channel delivery:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-browser-realtime.json \
  -r "rallarApiBaseUrl:=${RALLAR_API_BASE_URL},roomId:=${RALLAR_ROOM_ID},aliceUsername:=${RALLAR_ALICE_USERNAME},alicePassword:=${RALLAR_ALICE_PASSWORD},bobUsername:=${RALLAR_BOB_USERNAME},bobPassword:=${RALLAR_BOB_PASSWORD}"
```

This scenario uses:

```json
{
  "rallar": {
    "transport": "realtime",
    "laneId": "realtime"
  }
}
```

The provider resolves `expect.connection` to the target browser's Rallar `sessionId`, then passes it as `peerIds` to `rallar.realtime.sendJson`.

## Live Messages RTC Run

Run browser-backed Rallar app-level RTC messages:

```bash
export RALLAR_MESSAGE_TYPE_ID="black-box.chat.message"
export RALLAR_TOPIC_ID="black-box.chat"

deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/rtc-rallar-browser-messages-rtc.json \
  -r "rallarApiBaseUrl:=${RALLAR_API_BASE_URL},roomId:=${RALLAR_ROOM_ID},aliceUsername:=${RALLAR_ALICE_USERNAME},alicePassword:=${RALLAR_ALICE_PASSWORD},bobUsername:=${RALLAR_BOB_USERNAME},bobPassword:=${RALLAR_BOB_PASSWORD},messageTypeId:=${RALLAR_MESSAGE_TYPE_ID},topicId:=${RALLAR_TOPIC_ID}"
```

This scenario uses:

```json
{
  "rallar": {
    "transport": "messages.rtc",
    "typeId": "black-box.chat.message",
    "topicId": "black-box.chat"
  }
}
```

The provider resolves `expect.connection` to the target browser's Rallar `sessionId`, then passes it as `nextHopPeerIds` to `rallar.messages.rtc.send`.

## Headful Debug Run

For local debugging, set the connection `browser` config to headful mode:

```json
{
  "browser": {
    "headless": false,
    "slowMo": 100,
    "timeoutMs": 30000
  }
}
```

Keep CI headless. Headful mode is only for local investigation.

## Timeout Guidance

Use short timeouts for deterministic fake providers and longer timeouts for real browser RTC:

| Setting | Local suggested value | CI suggested value |
| --- | --- | --- |
| `browser.timeoutMs` | `15000` | `30000` |
| `rallar.timeoutMs` | `15000` | `30000` |
| `rallar.openTimeoutMs` | `10000` | `20000` |
| `expect.withinMs` | `10000` | `20000` |

Increase these only when the deployed service or CI runner is known to be slow. Large timeouts make failed RTC runs expensive.

## Report Signals

On success, expect:

- `rallar.browser.provider.connected`
- `rallar.browser.connect_completed`
- `rallar.browser.realtime.send_completed` or `rallar.browser.messages.rtc.send_completed`
- matched `rtc.wait` results for the receiving connection

For failures, check `rtcMessages[connectionName]` before the top-level result:

- `rallar.browser.provider.page_load_failed`
- `rallar.browser.provider.runtime_connect_failed`
- `rallar.browser.connect.phase_failed`
- `rallar.browser.auth.login_failed`
- `rallar.browser.rallar_request_failed`
- `rallar.browser.realtime.peer_not_found`
- `rallar.browser.realtime.data_channel_not_open`
- `rallar.browser.realtime.send_result_attention`
- `rallar.browser.provider.send_failed`

`rtcCloseEvents` also includes generic runner auto-close events with `autoCloseRequested` and `autoCloseSucceeded`.

## CI Shape

Recommended CI sequence for live RTC jobs:

```bash
npm ci
npx playwright install --with-deps chromium
deno run -A packages/shared-test/black-box-runner/rallar-browser-live-validation.mts \
  --mode=both \
  --transport=both \
  --record-dir=.artifacts/rallar-browser-rtc
```

Run live `rallar-browser` jobs only when deployed-service secrets are present. Keep `rallar-memory` in normal unit/PR jobs for fast deterministic coverage.

## Continuous Runs

Current support can run repeated short validations for hours by looping the validation harness:

```bash
while true; do
  deno run -A packages/shared-test/black-box-runner/rallar-browser-live-validation.mts \
    --mode=live \
    --transport=both \
    --record-dir=".artifacts/rallar-browser-rtc/$(date +%Y%m%d-%H%M%S)"
  sleep 30
done
```

This repeatedly starts browsers, connects, sends, waits, closes, and validates cleanup.

Same-connection soak mode is available for deterministic runner coverage:

```bash
npm run test:shared-black-box:memory:soak
```

That recipe keeps `rallar-memory` RTC connections open across repeated
bidirectional sends and records `summary.soak` plus `metrics.soak`.

Live browser and remote-browser baselines are available as gated recipe-matrix
profiles:

```bash
npm run test:shared-black-box:matrix:live:soak
npm run test:shared-black-box:matrix:live:traffic
npm run test:shared-black-box:matrix:live:parallel
```

These profiles skip with explicit gate reasons unless the Rallar API, test
credentials, Playwright, and optional control-server agent are configured.

## Provider Choice

| Provider | Use when |
| --- | --- |
| `rallar-memory` | Testing runner parsing, matching, routing, reconnect, close, and report behavior without network/browser cost. |
| `rallar` | Checking only the current WebSocket signaling-only provider behavior. It is not a real WebRTC data path. |
| `rallar-browser` | Verifying deployed Rallar auth, room join, browser WebRTC setup, realtime data-channel sends, and `messages.rtc` routing. |
