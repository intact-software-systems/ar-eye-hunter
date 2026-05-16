# Full-stack UI Automation Tests

This document describes the Rallar Black Box browser automation style introduced around Iterations 21-23. It is meant
for humans and AI agents that need to add more tests without first reverse-engineering the existing Playwright suite.

## Readiness

Iteration 23 is ready to start from an application-shape perspective:

- the SPA has a login gate for `browser-rallar`
- the app shell has stable tabs and URL tab state
- Manual Rallar can configure, join/connect, send, inspect received data, and build repeatable command snippets
- RTC Diagnostics, Topology, Event Stream, Local Workbench, and Rallar Server are separate UI surfaces
- the Rallar Server tab can execute authenticated REST requests and export `http.request` commands
- the control server smoke already proves command enqueueing, result polling, and browser-agent registration
- gated live one-agent and two-agent `browser-rallar` smokes already exist

The main Iteration 23 risk is infrastructure, not UI readiness. Full-stack tests need the API server, control server,
SPA, browser dependencies, CORS, and either test users or restorable auth sessions to be available at the same time.

## Existing Test Families

Use these files as examples:

- `tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`
  Deterministic local UI tests. Uses `provider=simulated`, browser route mocks where needed, and verifies tab state,
  state persistence, and the Rallar Server REST UI.
- `tests/playwright/rallar-black-box/control-agent-smoke.spec.ts`
  Control-server loop test. Starts the SPA as a remote agent, enqueues a command through the control server REST API,
  polls the run snapshot, and verifies the UI sees the command.
- `tests/playwright/rallar-black-box/browser-rallar-real-smoke.spec.ts`
  Gated live one-agent real-provider smoke. Requires real Rallar config and skips when not configured.
- `tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts`
  Gated live two-agent real-provider smoke. Creates two isolated browser contexts and checks realtime and
  `messages.rtc` delivery.

Use Vitest for pure helper logic:

- `packages/tests/rallar-black-box/app-tabs.test.ts`
- `packages/tests/rallar-black-box/auth-flow.test.ts`
- `packages/tests/rallar-black-box/rallar-server-workbench.test.ts`
- `packages/tests/shared-test/rallar-bb-browser-adapter-auth.test.ts`

## Test Layers

Prefer the smallest layer that proves the behavior.

1. Pure helpers with Vitest
   Use for URL/query building, endpoint preset expansion, auth header injection, redaction, command conversion, and
   response classification.

2. Simulated SPA Playwright tests
   Use for tab navigation, UI state persistence, local command previews, event filters, diagnostics rendering, and
   mocked REST responses. These tests should run without `apps/api-v1` or real credentials.

3. Control-agent Playwright tests
   Use when the behavior depends on the control server protocol: registration, command enqueueing, duplicate command
   replay, result polling, stats, reports, and graceful disconnect.

4. Full-stack API plus SPA tests
   Use when the SPA must talk to `apps/api-v1` through real HTTP, including login, REST workbench requests, CORS,
   authorization headers, group state, client state, ICE config, and websocket tickets.

5. Live real-provider tests
   Use only for actual RTC signaling and delivery through Rallar. Gate these tests with explicit environment checks and
   use clear skip messages.

## Required Services For Iteration 23

A full-stack Iteration 23 test should start or require:

```text
apps/api-v1                       http://localhost:8080
apps/rallar-black-box-control     http://127.0.0.1:5180 and ws://127.0.0.1:5180/control
apps/rallar-black-box             http://127.0.0.1:5176
```

The normal `apps/rallar-black-box/playwright.config.ts` starts the SPA and control server for deterministic UI and
control-agent smokes. The dedicated Iteration 23 config is:

```text
apps/rallar-black-box/playwright.full-stack.config.ts
```

Run it with:

```sh
npm run test:e2e:rallar-black-box:full-stack
```

The config always starts the SPA and control server. It starts `apps/api-v1` only when
`RALLAR_BLACK_BOX_FULL_STACK=1` is set.

## Environment Gate

Do not let full-stack tests fail cryptically when local infrastructure is missing. Add an explicit gate near the top of
the spec.

Recommended required values:

```text
RALLAR_BLACK_BOX_FULL_STACK=1
DATABASE_URL=<Postgres connection URL consumed by apps/api-v1>
VITE_RALLAR_API_BASE_URL=http://localhost:8080
VITE_RALLAR_ROOM_ID=<test room/group id>
VITE_RALLAR_USERNAME=<agent A username>
VITE_RALLAR_PASSWORD=<agent A password>
VITE_RALLAR_B_USERNAME=<agent B username>
VITE_RALLAR_B_PASSWORD=<agent B password>
```

Alternative restored-session values:

```text
VITE_RALLAR_RESTORE_SESSION=1
VITE_RALLAR_TOKEN=<agent A access token>
VITE_RALLAR_CLIENT_ID=<agent A client id>
VITE_RALLAR_SESSION_ID=<agent A session id>
VITE_RALLAR_EXPIRES_AT_EPOCH_MS=<future epoch ms>
```

For two-agent restored sessions, follow the existing two-agent smoke pattern and use separate values for each browser
context.

Use this pattern:

```ts
const hasFullStackConfig = Boolean(apiBaseUrl && roomId && canLoginOrRestore);

test.skip(
    !hasFullStackConfig,
    'Set VITE_RALLAR_API_BASE_URL, VITE_RALLAR_ROOM_ID, and login or restore-session env to run this full-stack test.',
);
```

## Browser Contexts

Use isolated contexts for distinct agents. Never share a browser context between two logical Rallar clients.

```ts
const contextA = await browser.newContext();
const pageA = await contextA.newPage();

const contextB = await browser.newContext();
const pageB = await contextB.newPage();
```

For restored sessions, seed `auth.session` before navigation:

```ts
await page.addInitScript((session) => {
    window.localStorage.setItem('auth.session', JSON.stringify(session));
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
await page.goto('/?provider=simulated&tab=manual-rallar');
```

For real-provider app-shell tests:

```ts
const query = new URLSearchParams({
    provider: 'browser-rallar',
    apiBaseUrl,
    roomId,
    actor,
    sessionId,
    tab: 'manual-rallar',
    ...(restoreSession ? { rallarRestoreSession: '1' } : {}),
});

await page.goto(`/?${query.toString()}`);
```

For control-agent tests:

```ts
const query = new URLSearchParams({
    mode: 'control',
    provider: 'browser-rallar',
    controlUrl: 'ws://127.0.0.1:5180/control',
    runId,
    agentId,
    apiBaseUrl,
    roomId,
    actor,
    sessionId,
    tab: 'manual-rallar',
});

await page.goto(`/?${query.toString()}`);
await expect(page.locator('.control-panel')).toContainText('registered');
```

## Selector Rules

Prefer accessible roles and stable tab panel IDs:

```ts
await page.getByRole('tab', { name: 'Manual Rallar' }).click();
const manualPanel = page.locator('#panel-manual-rallar');
await manualPanel.getByRole('button', { name: 'Join' }).click();
```

Useful stable panels:

- `#panel-manual-rallar`
- `#panel-topology`
- `#panel-rtc-diagnostics`
- `#panel-local-workbench`
- `#panel-event-stream`
- `#panel-rallar-server`

Avoid brittle selectors based on layout order. Use text only when the text is part of the product contract, such as tab
names, button names, command IDs, and event topics.

## Manual Rallar Flow

A UI-driven Manual Rallar test should usually:

1. Open `Manual Rallar`.
2. Fill group, connection, transport, target/multicast fields, and payload.
3. Click `Configure` or `Join`.
4. Click `Connect` if not already joined.
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
await page.route('http://localhost:8080/api/config', async route => {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ apiBaseUrl: 'http://localhost:8080' }),
    });
});
```

Live full-stack example:

```ts
await page.goto('/?provider=browser-rallar&tab=rallar-server&apiBaseUrl=http%3A%2F%2Flocalhost%3A8080');
const serverPanel = page.locator('#panel-rallar-server');
await serverPanel.getByRole('button', { name: 'Send' }).click();
await expect(serverPanel).toContainText('200');
```

## Control-server Flow

Use Playwright's `request` fixture to enqueue commands and poll run snapshots:

```ts
const enqueue = await request.post(
    `${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/commands`,
    {
        data: {
            commandId,
            command: { kind: 'stats', commandId },
        },
    },
);
expect(enqueue.status()).toBe(202);

await expect.poll(async () => {
    const response = await request.get(`${CONTROL_BASE_URL}/runs/${encodeURIComponent(runId)}`);
    const run = await response.json();
    return run.results?.some((result: { commandId?: string; ok?: boolean }) =>
        result.commandId === commandId && result.ok === true
    ) ?? false;
}).toBe(true);
```

Use control-server tests when you need durable evidence from the server side, not only visible UI state.

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
- RTC Diagnostics reaches auth, runtime, group join, signaling, peer discovery, data channel, and first-payload stages
- Event Stream filters preserve evidence for command IDs and topics
- Topology contains the expected room/session/route nodes
- cleanup closes connections and removes stale session state

## Failure Artifacts

For Iteration 23, keep Playwright traces enabled through config. Add explicit artifacts when failures are hard to
reproduce:

- screenshots of each tab
- control-server run snapshot JSON
- REST response JSON
- redacted auth/session summary
- copied RTC diagnostic bundle
- event stream export
- command report snapshot

Keep artifacts redacted. Never write access tokens or passwords to snapshots, logs, screenshots, or copied cURL output.

## Test Hygiene

- Use `test.setTimeout(120_000)` for live two-browser RTC flows.
- Use `expect.poll` for asynchronous server and RTC state.
- Use unique run IDs, agent IDs, rooms, connections, and payload topics.
- Prefer public or disposable test users.
- Always close browser contexts.
- Run cleanup commands even when assertions fail.
- Skip live tests when environment is incomplete.
- Keep simulated tests deterministic and independent of `apps/api-v1`.
- Do not depend on test order.

## Iteration 23 File Shape

Current files:

```text
tests/playwright/rallar-black-box/full-stack-rest-workbench.spec.ts
tests/playwright/rallar-black-box/full-stack-control-orchestration.spec.ts
tests/playwright/rallar-black-box/full-stack-helpers.ts
apps/rallar-black-box/playwright.full-stack.config.ts
```

Likely next files:

```text
tests/playwright/rallar-black-box/full-stack-ui-flow.spec.ts
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

- the test has a clear layer: helper, simulated UI, control-agent, full-stack API, or live provider
- live tests have explicit `test.skip(...)` gates
- all generated IDs are unique
- auth tokens are never asserted or logged in clear text
- selectors are role-based or stable panel IDs
- browser contexts are closed
- cleanup runs in `finally`
- failure messages tell the next engineer which service or env value is missing
