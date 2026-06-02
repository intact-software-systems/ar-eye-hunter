# Full-stack UI Automation Tests

This document describes the Rallar Black Box browser automation style introduced
around Iterations 21-24 and aligned with the shared-test Iterations 1-19
runner/handoff work. It is meant for humans and AI agents that need to add more
tests without first reverse-engineering the existing Playwright suite.

## Current Readiness

The app is ready for additional full-stack and command-center UI coverage from
an application-shape perspective:

- the SPA has a login gate for `browser-rallar`
- the app shell has stable tabs and URL tab state
- the Auth tab exposes login, register, restore, logout, WS-ticket, and negative
  auth operations
- the Groups/Clients tab exposes authenticated group, client, presence, and
  state-event operations
- the WebSocket tab exposes ticket creation, open/open API WS, send, wait,
  reconnect, close, cleanup, diagnostics, and WS/RTC recipe export operations
- Manual Rallar can configure, join/connect, send, run scoped RTC delivery
  matrices, run NACK probes, inspect received data, and build repeatable command
  snippets
- RTC Diagnostics, Topology, Event Stream, Local Workbench, and Rallar Server
  are separate UI surfaces
- the Rallar Server tab can execute authenticated REST requests, run REST
  collections with assertions/extraction, and export `http.request` commands or
  collection recipes
- the Flow Builder tab can compose HTTP, WS, RTC, wait, and cleanup steps into
  runnable SPA recipes and exported runner scenarios
- the Run Manager tab can inspect bounded control-server snapshots and enqueue
  commands to selected browser agents
- the Run Manager tab can validate exported control-run artifact bundles and
  expose copyable JSONL/failure diagnostics
- the Event Stream has bounded windows and Topology has search/node limits plus
  deterministic route summaries for larger runs
- the control server smoke already proves command enqueueing, result polling,
  and browser-agent registration
- gated live one-agent and two-agent `browser-rallar` smokes already exist
- a gated live three-browser `browser-rallar` matrix now covers direct,
  multicast, broadcast, NACK/min-snapshot probing, stale-send failure, and
  control artifact export across `realtime` and `messages.rtc`
- full-stack QA and live three-browser coverage are tracked by Vitest guard
  modules
- shared-test exposes a recipe catalog, artifact contract, artifact parser,
  versioned fixtures, and deterministic runner patterns for same-connection
  soak, seeded traffic replay, and bounded parallel groups

The main risk is infrastructure, not UI readiness. Full-stack tests need the API
server, control server, SPA, browser dependencies, CORS, and either test users
or restorable auth sessions to be available at the same time.

## Existing Test Families

Use these files as examples:

- `tests/playwright/rallar-black-box/tabbed-navigation.spec.ts` Deterministic
  local UI tests. Uses `provider=simulated`, browser route mocks where needed,
  and verifies tab state, reload-safe state persistence, redacted draft storage,
  the Auth command center, Groups/Clients command center, Rallar Server REST UI
  and collection runner, WebSocket command center, shared-test catalog display,
  and runner artifact import.
- `tests/playwright/rallar-black-box/control-agent-smoke.spec.ts` Control-server
  loop test. Starts the SPA as a remote agent, enqueues a command through the
  control server REST API, polls the run snapshot, and verifies the UI sees the
  command.
- `tests/playwright/rallar-black-box/browser-rallar-real-smoke.spec.ts` Gated
  live one-agent real-provider smoke. Requires real Rallar config and skips when
  not configured.
- `tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts`
  Gated live two-agent real-provider smoke. Creates two isolated browser
  contexts and checks realtime and `messages.rtc` delivery.
- `tests/playwright/rallar-black-box/full-stack-manual-rallar-realtime.spec.ts`
  Gated full-stack UI flow. Starts from login, uses the black-box-runner
  `Manual Rallar` tab in two browsers, sends unique realtime JSON through the
  real `browser-rallar` provider, and asserts the receiving UI shows the payload
  plus real browser event-stream evidence before closing both Manual Rallar
  connections.
- `tests/playwright/rallar-black-box/full-stack-quick-test-ws.spec.ts` Gated
  full-stack UI flow. Starts from login in two browsers, uses the Rallar-mode
  Quick Test tab to create/join a group, subscribe the receiver, send repeated
  real WS group payloads, and verify receiver-side message display.
- `tests/playwright/rallar-black-box/full-stack-command-center-qa-matrix.spec.ts`
  Gated full-stack command-center cross-checks for bad login, missing-token
  protected REST behavior, authenticated WS-ticket creation, WebSocket
  command-center negative evidence, Shared Test catalog display, and artifact
  import.
- `tests/playwright/rallar-black-box/full-stack-rest-workbench.spec.ts` Gated
  full-stack Rallar Server workbench flow. Logs browsers in through the UI,
  verifies authenticated REST headers, creates-or-accepts existing groups, joins
  groups with the authenticated client ID, checks live missing-body and
  principal-mismatch join failures, runs REST collections, and confirms
  sensitive values remain redacted.
- `tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts`
  Gated live three-browser provider baseline. Creates three isolated browser
  contexts, joins a unique group, runs direct/multicast/broadcast over
  `realtime` and `messages.rtc`, probes not-yet-in-sync/NACK behavior, verifies
  stale-send failure, rejects fake-provider topics, and validates control-server
  artifacts.

Use Vitest for pure helper logic:

- `packages/tests/rallar-black-box/app-tabs.test.ts`
- `packages/tests/rallar-black-box/auth-flow.test.ts`
- `packages/tests/rallar-black-box/full-stack-qa-matrix.test.ts`
- `packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts`
- `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`
- `packages/tests/rallar-black-box/ui-persistence.test.ts`
- `packages/tests/shared-test/rallar-bb-browser-adapter-auth.test.ts`
- `packages/tests/shared-test/black-box-runner-handoff-contract.test.ts`
- `packages/tests/shared-test/black-box-runner-artifact-reader.test.ts`
- `packages/tests/shared-test/recipe-matrix.test.ts`

## Test Layers

Prefer the smallest layer that proves the behavior.

1. Pure helpers with Vitest Use for URL/query building, endpoint preset
   expansion, auth header injection, redaction, command conversion, and response
   classification. UI persistence helpers should be tested here so storage
   redaction can be verified without starting a browser.

2. Simulated SPA Playwright tests Use for tab navigation, UI state persistence,
   local command previews, event filters, diagnostics rendering, and mocked REST
   responses. These tests should run without `apps/api-v1` or real credentials.

3. Control-agent Playwright tests Use when the behavior depends on the control
   server protocol: registration, command enqueueing, duplicate command replay,
   result polling, stats, reports, and graceful disconnect.

4. Full-stack API plus SPA tests Use when the SPA must talk to `apps/api-v1`
   through real HTTP, including login, REST workbench requests, CORS,
   authorization headers, Auth tab operations, Groups/Clients state operations,
   group state, client state, ICE config, and websocket tickets.

5. Live real-provider tests Use only for actual RTC signaling and delivery
   through Rallar. Gate these tests with explicit environment checks and use
   clear skip messages.

6. Shared-test runner and artifact contract tests Use when the behavior belongs
   to external JSON recipes, matrix classification, artifact parsing, schema
   compatibility, same-connection soak, seeded traffic, bounded parallel groups,
   or command-center handoff contracts.

## Required Services For Full-stack UI Tests

A full-stack UI test should start or require:

```text
apps/api-v1                       http://localhost:8080
apps/rallar-black-box-control     http://127.0.0.1:5180 and ws://127.0.0.1:5180/control
apps/rallar-black-box             http://localhost:5176
```

The normal `apps/rallar-black-box/playwright.config.ts` starts the SPA and
control server for deterministic UI and control-agent smokes. The dedicated
full-stack config is:

```text
apps/rallar-black-box/playwright.full-stack.config.ts
```

Run it with:

```sh
npm run test:e2e:rallar-black-box:full-stack
```

Use the convenience root scripts for real-data runs:

```sh
npm run test:e2e:rallar-black-box:full-stack:real
npm run test:e2e:rallar-black-box:full-stack:real:manual
npm run test:e2e:rallar-black-box:full-stack:real:rest
npm run test:e2e:rallar-black-box:full-stack:real:control
npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3
npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3:all
```

Use the memory-mode scripts when the goal is API-v1 middleware/browser
validation without Postgres:

```sh
npm run test:e2e:rallar-black-box:full-stack:memory
npm run test:e2e:rallar-black-box:full-stack:memory:live-rtc-3
```

The memory RTC script provides the static API-v1 fixture users `alice/secret`,
`bob/secret`, and `charlie/secret`, plus
`VITE_RALLAR_APPLICATION_ID=rallar-server` and a disposable room seed.

The config always starts the SPA and control server. It starts `apps/api-v1`
only when `RALLAR_BLACK_BOX_FULL_STACK=1` is set. If a service is already
running on the expected port, Playwright reuses it.

To run the backend servers separately before test execution:

```sh
npm run dev:rallar-black-box:servers
```

To run API, control server, and the SPA together for manual UI testing:

```sh
npm run dev:rallar-black-box:all
```

The full-stack config uses `http://localhost:5176` as the SPA origin because
`apps/api-v1` allows that origin by default when started manually.
`http://127.0.0.1:5176` requires adding that origin to `CORS_ORIGINS`.

The API startup commands load env files from `apps/api-v1/.env.local`,
`apps/api-v1/.env`, and root `.env`, in that order. Existing shell environment
variables still win, and `CORS_ORIGINS` is set by the npm script for the test
SPA origins.

When `RALLAR_BLACK_BOX_API_MODE=memory` is set, the full-stack config starts
API-v1 without env files or `DATABASE_URL`. It sets `RALLAR_API_BASE_URL` and
`RALLAR_WS_BASE_URL` from `VITE_RALLAR_API_BASE_URL`, plus
`RALLAR_SQL_BACKEND=pglite-memory`, `RALLAR_PGLITE_DATA_DIR=memory://`,
`RALLAR_PGLITE_SCHEMA_INIT=auto`, and `RALLAR_DB_PUBSUB=local`, so the API uses
ephemeral SQL plus in-process queue pub/sub and `/api/config` advertises the
same HTTP/WS port as the SPA. It also sets `RALLAR_ICE_MODE=local` and
`RALLAR_LOGIN_USER_RATE_LIMIT=100` so repeated local browser smoke runs do not
require Metered credentials or hit the default per-user login limiter.
`VITE_RALLAR_API_BASE_URL` still selects the API base URL and the config derives
the API `PORT` from it.

## Environment Gate

Do not let full-stack tests fail cryptically when local infrastructure is
missing. Add an explicit gate near the top of the spec.

Recommended required values:

```text
RALLAR_BLACK_BOX_FULL_STACK=1
DATABASE_URL=<Postgres connection URL consumed by apps/api-v1>
VITE_RALLAR_API_BASE_URL=http://localhost:8080
VITE_RALLAR_APPLICATION_ID=ar-eye-hunter
VITE_RALLAR_WORKSPACE_ID=default
VITE_RALLAR_ROOM_ID=<test room/group id>
VITE_RALLAR_USERNAME=<agent A username>
VITE_RALLAR_PASSWORD=<agent A password>
VITE_RALLAR_B_USERNAME=<agent B username>
VITE_RALLAR_B_PASSWORD=<agent B password>
```

For `RALLAR_BLACK_BOX_API_MODE=memory`, omit `DATABASE_URL`; the API server is
bootstrapped from the in-memory schema and static API-v1 test users such as
`alice/secret`, `bob/secret`, and `charlie/secret`.

If `VITE_RALLAR_ROOM_ID` is omitted or still set to the placeholder
`your-room-id`, the full-stack helpers generate a disposable
`rallar-bb-full-stack-...` group id for that test process. Set
`VITE_RALLAR_ROOM_ID` to a real existing group id when you specifically want to
exercise manual existing-group fixtures.

For the live three-browser matrix, also set:

```text
RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1
VITE_RALLAR_AGENT_A_USERNAME=<agent A username>
VITE_RALLAR_AGENT_A_PASSWORD=<agent A password>
VITE_RALLAR_AGENT_B_USERNAME=<agent B username>
VITE_RALLAR_AGENT_B_PASSWORD=<agent B password>
VITE_RALLAR_AGENT_C_USERNAME=<agent C username>
VITE_RALLAR_AGENT_C_PASSWORD=<agent C password>
```

The exhaustive all-scenarios matrix additionally sets or requires:

```text
RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1
```

Optional live matrix values:

```text
VITE_RALLAR_APPLICATION_ID=ar-eye-hunter
VITE_RALLAR_WORKSPACE_ID=default
VITE_RALLAR_MESSAGES_RTC_TYPE_ID=manual.type
VITE_RALLAR_MESSAGES_RTC_TOPIC_ID=manual.topic
```

Alternative restored-session values:

```text
VITE_RALLAR_RESTORE_SESSION=1
VITE_RALLAR_TOKEN=<agent A access token>
VITE_RALLAR_CLIENT_ID=<agent A client id>
VITE_RALLAR_SESSION_ID=<agent A session id>
VITE_RALLAR_EXPIRES_AT_EPOCH_MS=<future epoch ms>
```

For two-agent restored sessions, follow the existing two-agent smoke pattern and
use separate values for each browser context.

For three-agent restored sessions, provide `VITE_RALLAR_AGENT_A_TOKEN`,
`VITE_RALLAR_AGENT_A_CLIENT_ID`, `VITE_RALLAR_AGENT_A_SESSION_ID`, and matching
`B`/`C` values.

Use this pattern:

```ts
const hasFullStackConfig = Boolean(apiBaseUrl && roomId && canLoginOrRestore);

test.skip(
  !hasFullStackConfig,
  "Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and login or restore-session env to run this full-stack test.",
);
```

## Browser Contexts

Use isolated contexts for distinct agents. Never share a browser context between
two logical Rallar clients.

```ts
const contextA = await browser.newContext();
const pageA = await contextA.newPage();

const contextB = await browser.newContext();
const pageB = await contextB.newPage();
```

For restored sessions, seed `auth.session` before navigation:

```ts
await page.addInitScript((session) => {
  window.localStorage.setItem("auth.session", JSON.stringify(session));
}, {
  clientId,
  accessToken,
  username,
  sessionId,
  expiresAtEpochMs,
});
```

Close contexts in `finally`:

```ts
try {
  // test flow
} finally {
  await Promise.all([contextA.close(), contextB.close()]);
}
```

## Navigation URLs

For deterministic local UI tests:

```ts
await page.goto("/?provider=simulated&tab=manual-rallar");
```

For real-provider app-shell tests:

```ts
const query = new URLSearchParams({
  provider: "browser-rallar",
  apiBaseUrl,
  roomId,
  actor,
  sessionId,
  tab: "manual-rallar",
  ...(restoreSession ? { rallarRestoreSession: "1" } : {}),
});

await page.goto(`/?${query.toString()}`);
```

For control-agent tests:

```ts
const query = new URLSearchParams({
  mode: "control",
  provider: "browser-rallar",
  controlUrl: "ws://127.0.0.1:5180/control",
  runId,
  agentId,
  apiBaseUrl,
  roomId,
  actor,
  sessionId,
  tab: "manual-rallar",
});

await page.goto(`/?${query.toString()}`);
await expect(page.locator(".control-panel")).toContainText("registered");
```

## Selector Rules

Prefer accessible roles and stable tab panel IDs:

```ts
await page.getByRole("tab", { name: "Manual Rallar" }).click();
const manualPanel = page.locator("#panel-manual-rallar");
await manualPanel.getByRole("button", { name: "Join" }).click();
```

Useful stable panels:

- `#panel-manual-rallar`
- `#panel-auth`
- `#panel-rooms-clients`
- `#panel-websocket`
- `#panel-topology`
- `#panel-rtc-diagnostics`
- `#panel-local-workbench`
- `#panel-run-manager`
- `#panel-event-stream`
- `#panel-rallar-server`
- `#panel-flow-builder`
- `#panel-shared-test`

Avoid brittle selectors based on layout order. Use text only when the text is
part of the product contract, such as tab names, button names, command IDs, and
event topics.

## Manual Rallar Flow

A UI-driven Manual Rallar test should usually:

1. Open `Rallar black-box-runner` mode and then `Manual Rallar`.
2. Fill group, connection, transport, target/multicast fields, scoped RTC
   fields, and payload.
3. Click `Create and join group` for the first real RTC client when the group
   should be created by the test.
4. Click `Connect` for additional clients after the group exists.
5. Click `Send`.
6. Assert command IDs appear in completed commands.
7. Assert the received-data inbox contains the expected payload or topic.
8. Open `RTC Diagnostics` and assert stages are observed.
9. Open `Event Stream` and filter by `message` or the command ID.
10. Open `Topology` and assert route/room/session evidence is visible.
11. Run `Close` or `Cleanup`.

Use unique suffixes for rooms, connections, command IDs, and payload fields:

```ts
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const roomId = `rallar-bb-${suffix}`;
```

The Manual Rallar realtime test intentionally uses the visible UI controls
instead of enqueueing control commands. It fills the group, connection, target
session, transport, and payload fields, clicks `Create and join group` for the
first browser, clicks `Connect` for the second browser, clicks `Send payload`,
and treats the receiving page's `Received Data` inbox as the primary proof that
real JSON moved through Rallar. It then clicks `Close connections` on both pages
so the happy path also exercises connection cleanup.

For delivery-matrix tests:

1. Fill `Application`, `Workspace`, `Scope JSON`, `Room Ref JSON`, and
   `Min Snapshot` when the test should exercise scoped addressing.
2. Fill direct and multicast targets with known peer/session IDs.
3. Click `Run Realtime Matrix` or `Run Messages Matrix`.
4. Assert direct, multicast, and broadcast command IDs appear.
5. Open `RTC Diagnostics` and assert ready peers, active peers, missing peers,
   lane health, first-payload latency, and NACK state.
6. Use `NACK Probe` or the copied negative recipe for not-yet-in-sync,
   missing-peer, stale-agent, duplicate-session, permission-denied, or
   closed-transport cases.

## Live Three-browser RTC Matrix

Use the three-browser matrix only when the provisioned Rallar environment is
ready. The spec is intentionally stricter than simulated UI tests:

1. Start or let Playwright start `apps/api-v1`, the control server, and the SPA.
2. Provide three users or three restored sessions.
3. Set `RALLAR_BLACK_BOX_FULL_STACK=1` and `RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1`.
4. Run `npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3`.
5. Confirm the run creates a unique group from `VITE_RALLAR_ROOM_ID` plus a
   suffix.
6. Confirm all three agents join the group before RTC connect.
7. Confirm direct, multicast, and broadcast payloads arrive over both `realtime`
   and `messages.rtc`.
8. Confirm the not-yet-in-sync/NACK probe records NACK or min-snapshot evidence.
9. Confirm a stale send after close fails visibly.
10. Confirm the control artifact bundle includes `report.json` and
    `events.jsonl`.

Coverage accounting lives in `src/live-rtc-three-browser-coverage.ts`. Required
live three-browser coverage is currently above 90 percent. The optional missing
row is permission-denied negative coverage, which needs a stable provisioned
permission fixture before it should become required.

The exhaustive variant is the one to run when live servers are already running
and you want broad coverage instead of a smoke baseline:

```sh
npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3:all
```

It runs 24 RTC delivery scenarios: six direct pairs, three multicasts, and three
broadcasts over `realtime`, then the same over `messages.rtc`. It also
opens/sends/closes the authenticated API WebSocket from all three agents, reads
back the group and group event page over REST, scans for unexpected delivery
leakage, runs NACK/min-snapshot and stale-send negative checks, reconnects a
closed agent, and validates the control artifact bundle.

## Auth Command Center Flow

For the Auth tab:

1. Open `?tab=auth`.
2. Fill API base URL, username, and password.
3. Click `Login` or `Register and login`.
4. Assert the session state, client ID, token redaction, and action log.
5. Click `Create WS ticket` and assert the request carried auth and the ticket
   value stayed redacted.
6. Run at least one negative action such as `Bad credentials` or
   `Missing auth ticket`.

Use mocked routes for deterministic redaction tests. Use full-stack API tests
when checking real CORS, session expiry, forbidden users, or backend auth
behavior.

## Groups/Clients Flow

For the Groups/Clients tab:

1. Seed or create an auth session.
2. Open `?tab=rooms-clients`.
3. Fill application, workspace, group, principal/client, instance, and session
   values.
4. Click `Refresh state` to load group, client, and event evidence.
5. Use focused actions such as `Create group`, `Join group`,
   `Connect client presence`, and `List group events page`.
6. Assert the group table, client table, state events, and expected/observed
   client metrics.

Use mocked routes for deterministic UI tests. Use full-stack API tests when
proving real group membership, presence, heartbeat, disconnect, cleanup, and
state-event pagination behavior.

## WebSocket Command Center Flow

For the WebSocket tab:

1. Seed or create an auth session when testing API-v1 sockets.
2. Open `?tab=websocket`.
3. Fill API base URL, connection name, WS URL, group, target client, timeout,
   and payload.
4. Click `Configure WS`.
5. Click `Create WS ticket` for authenticated real-provider API sockets.
6. Click `Open API WS` when the URL should use `{auth.sessionId}` and
   `{auth.wsTicket}` placeholders, or `Open` for a manually supplied URL.
7. Click `Send JSON`.
8. Assert ready state, outbound count, inbound count or wait state, close
   code/reason, and recent WS event rows.
9. Click `Wait for message` when the test needs a new inbound event after send.
10. Click `Reconnect`, `Close`, or `Cleanup` according to the scenario.

Use mocked routes and the simulated provider for deterministic UI-state tests.
Use full-stack API tests for auth header and ticket creation. Use live
real-provider tests for expired tickets, unauthorized sockets, server
restart/reconnect, and WS-vs-RTC payload parity.

## Rallar Server REST Flow

For the Rallar Server tab:

1. Open `?tab=rallar-server`.
2. Select a preset or set method/path manually.
3. Keep `Attach auth` enabled for protected endpoints.
4. Click `Send`.
5. Assert status, body, and generated command preview.
6. For auth-sensitive tests, intercept or inspect the request and assert:
   - `authorization: Bearer <token>` is present
   - `x-client-id` is present
   - visible exports redact the token

Mocked UI example:

```ts
await page.route("http://localhost:8080/api/config", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ apiBaseUrl: "http://localhost:8080" }),
  });
});
```

Live full-stack example:

```ts
await page.goto(
  "/?provider=browser-rallar&tab=rallar-server&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080",
);
const serverPanel = page.locator("#panel-rallar-server");
await serverPanel.getByRole("button", { name: "Send" }).click();
await expect(serverPanel).toContainText("200");
```

For REST collections:

1. Fill `Variables JSON`.
2. Fill or select `Collection JSON`.
3. Click `Run Collection`.
4. Assert step labels, status chips, assertion chips, and extracted variables.
5. Copy the collection recipe when the flow should move into a repeatable
   recipe.

## Flow Builder Flow

For the Flow Builder tab:

1. Open `?tab=flow-builder`.
2. Select a template.
3. Edit `Variables JSON`.
4. Edit `Flow JSON` or add step templates.
5. Assert the SPA recipe preview contains the expected command IDs.
6. Click `Run Flow`.
7. Assert step rows move to completed or failed states.
8. Copy the SPA recipe for command-center replay or copy the runner scenario for
   black-box-runner work.

Use simulated Playwright coverage for composition, variable substitution, and
visible step status. Use full-stack tests when the flow must prove auth headers,
real REST state, real WS opens, or real RTC delivery.

## Control-server Flow

Use Playwright's `request` fixture to enqueue commands and poll run snapshots:

```ts
const enqueue = await request.post(
  `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/agents/${
    encodeURIComponent(agentId)
  }/commands`,
  {
    data: {
      commandId,
      command: { kind: "stats", commandId },
    },
  },
);
expect(enqueue.status()).toBe(202);

await expect.poll(async () => {
  const response = await request.get(
    `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`,
  );
  const run = await response.json();
  return run.results?.some((result: { commandId?: string; ok?: boolean }) =>
    result.commandId === commandId && result.ok === true
  ) ?? false;
}).toBe(true);
```

Use control-server tests when you need durable evidence from the server side,
not only visible UI state.

## Assertions That Matter

Good full-stack assertions include:

- login screen appears only when expected
- after login, the app shell appears with the expected user/session
- REST calls to protected endpoints include auth headers
- real-provider commands do not emit `rallar.bb.fake.*` topics
- direct send reaches exactly one target
- multicast sends include the intended next-hop targets
- broadcast sends do not accidentally use stale direct targets
- received-data inbox shows the expected payload on the receiving browser
- RTC Diagnostics reaches auth, runtime, group join, signaling, peer discovery,
  data channel, and first-payload stages
- Event Stream filters preserve evidence for command IDs and topics
- persisted UI drafts do not contain raw passwords, bearer tokens, auth tickets,
  API keys, or token/password-shaped JSON values
- Topology contains the expected room/session/route nodes
- cleanup closes connections and removes stale session state

## Failure Artifacts

Keep Playwright traces enabled through config. Add explicit artifacts when
failures are hard to reproduce:

- screenshots of each tab
- control-server run snapshot JSON
- REST response JSON
- redacted auth/session summary
- copied RTC diagnostic bundle
- event stream export
- command report snapshot
- imported or generated shared-test artifact bundles when the failure comes from
  a runner scenario

Keep artifacts redacted. Never write access tokens or passwords to snapshots,
logs, screenshots, or copied cURL output.

For shared-test runner artifacts, validate file text with
`parseRallarBlackBoxSharedTestArtifactBundle(...)` before rendering it in
command-center UI tests.

## Test Hygiene

- Use `test.setTimeout(120_000)` for live two-browser RTC flows and longer
  timeouts, such as `360_000`, for three-browser live matrices.
- Use `expect.poll` for asynchronous server and RTC state.
- Use unique run IDs, agent IDs, rooms, connections, and payload topics.
- Prefer public or disposable test users.
- Always close browser contexts.
- Run cleanup commands even when assertions fail.
- Skip live tests when environment is incomplete.
- Keep simulated tests deterministic and independent of `apps/api-v1`.
- Do not depend on test order.

## Current File Shape

Current files:

```text
tests/playwright/rallar-black-box/full-stack-rest-workbench.spec.ts
tests/playwright/rallar-black-box/full-stack-control-orchestration.spec.ts
tests/playwright/rallar-black-box/full-stack-command-center-qa-matrix.spec.ts
tests/playwright/rallar-black-box/full-stack-manual-rallar-realtime.spec.ts
tests/playwright/rallar-black-box/full-stack-live-rtc-three-browser-matrix.spec.ts
tests/playwright/rallar-black-box/full-stack-helpers.ts
tests/playwright/rallar-black-box/tabbed-navigation.spec.ts
apps/rallar-black-box/playwright.full-stack.config.ts
```

Likely next files:

```text
tests/playwright/rallar-black-box/full-stack-live-negative-permissions.spec.ts
tests/playwright/rallar-black-box/full-stack-live-ws-expiry-reconnect.spec.ts
tests/playwright/rallar-black-box/full-stack-artifact-search-retention.spec.ts
```

Useful helper responsibilities:

- read and validate env
- create run IDs and agent IDs
- seed restored auth sessions
- open a browser agent
- enqueue control commands
- poll command results
- collect redacted failure artifacts
- run cleanup

## Minimal New Test Checklist

Before opening a PR or committing a new test, confirm:

- the test has a clear layer: helper, simulated UI, control-agent, full-stack
  API, or live provider
- live tests have explicit `test.skip(...)` gates
- all generated IDs are unique
- auth tokens are never asserted or logged in clear text
- selectors are role-based or stable panel IDs
- browser contexts are closed
- cleanup runs in `finally`
- failure messages tell the next engineer which service or env value is missing
