# API V1 Black-Box Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add no-browser black-box tests for `apps/api-v1` that run locally and in GitHub Actions through `packages/shared-test/black-box-runner`.

**Architecture:** The recipe catalog remains in `packages/shared-test/black-box-runner` and uses only HTTP, WS, SET, and ASSERT runner steps. A small Deno orchestration helper starts `apps/api-v1`, waits for `/api/config`, runs the matrix profile, writes artifacts, and is reused by package scripts and a repo-local GitHub composite action. GitHub Actions runs the Postgres backend by default; pglite-memory stays opt-in.

**Tech Stack:** Deno CLI, Hono API app, Postgres service in GitHub Actions, optional pglite-memory, npm workspace scripts, black-box-runner JSON recipes, Vitest for static matrix/script tests.

## Global Constraints

- Do not use Playwright, browser providers, `rallar-browser`, or `rallar-remote-browser`.
- Do not validate real WebRTC data channels or RTC provider behavior.
- Do not add first-class Rallar facade commands to the runner recipe language.
- Do not make `apps/api-v1` aware of the test recipes.
- Postgres is the required CI backend.
- Pglite-memory is optional and default off.
- Use bundled static demo users for login-driven flows: `alice` / `secret`, `bob` / `secret`, and `charlie` / `secret` only if a later recipe needs a third actor.
- Set `RALLAR_STATE_STRICT_READ_AUTH=1` for API-v1 black-box runs so wrong-principal read assertions are meaningful.
- Registration coverage must use a generated disposable username derived from `RALLAR_BB_RUN_ID`.
- CI matrix execution must use `--require-gates`.
- Recipe authoring validation must use `scenario-black-box.ts --validate --strict`.
- Matrix entries must declare `requires.httpServices` for the Rallar API and must not set `requires.playwright`.
- Generated artifacts stay under `.artifacts/` and must not be committed.

---

## File Structure

- Create `packages/shared-test/black-box-runner/examples/api-v1-auth-session.json`
  - REST-only auth/session black-box recipe.
- Create `packages/shared-test/black-box-runner/examples/api-v1-group-presence.json`
  - REST group lifecycle and group presence recipe.
- Create `packages/shared-test/black-box-runner/examples/api-v1-client-state.json`
  - REST client principal, instance, and session lifecycle recipe.
- Create `packages/shared-test/black-box-runner/examples/api-v1-websocket-topic-routing.json`
  - REST setup plus raw `/api/ws/:sessionId` WS routing recipe.
- Create `packages/shared-test/black-box-runner/examples/api-v1-scope-isolation.json`
  - REST scoped application/workspace isolation and denial recipe.
- Modify `packages/shared-test/black-box-runner/recipe-matrix.json`
  - Add `api-v1-black-box` matrix entries.
- Modify `packages/shared-test/black-box-runner/recipe-matrix.mts`
  - Advertise the `api-v1-black-box` profile in CLI usage text.
- Modify `packages/shared-test/black-box-runner/examples/README.md`
  - Document the new API-v1 recipes.
- Modify `packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md`
  - Document the new no-browser API-v1 matrix profile, final root commands, and API-v1 artifact path.
- Create `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`
  - Shared local/CI orchestration CLI.
- Create `packages/tests/shared-test/api-v1-black-box-run.test.ts`
  - Unit tests for orchestration argument parsing, backend env, and command planning.
- Modify `packages/tests/shared-test/recipe-matrix.test.ts`
  - Static tests for the no-browser API-v1 profile.
- Modify `packages/shared-test/package.json`
  - Add workspace scripts for API-v1 recipes, Postgres, and memory runs.
- Modify root `package.json`
  - Add discoverable root scripts for API-v1 black-box runs.
- Create `.github/actions/api-v1-black-box-test/action.yml`
  - Composite action that invokes the orchestration CLI.
- Modify `.github/workflows/release-gate.yml`
  - Add the required Postgres black-box gate and artifact upload.
- Create `.github/workflows/api-v1-black-box.yml`
  - Manual helper workflow with optional pglite-memory run.
- Modify `packages/shared-test/docs/shared-test-verification.md`
  - Document local commands and artifact locations.

---

## Iteration 1: Recipe Catalog And Matrix Profile

### Task 1: Add API-v1 Recipe Matrix Coverage

**Files:**

- Create: `packages/shared-test/black-box-runner/examples/api-v1-auth-session.json`
- Create: `packages/shared-test/black-box-runner/examples/api-v1-group-presence.json`
- Create: `packages/shared-test/black-box-runner/examples/api-v1-client-state.json`
- Create: `packages/shared-test/black-box-runner/examples/api-v1-websocket-topic-routing.json`
- Create: `packages/shared-test/black-box-runner/examples/api-v1-scope-isolation.json`
- Modify: `packages/shared-test/black-box-runner/recipe-matrix.json`
- Modify: `packages/shared-test/black-box-runner/recipe-matrix.mts`
- Modify: `packages/shared-test/black-box-runner/examples/README.md`
- Modify: `packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md`
- Modify: `packages/tests/shared-test/recipe-matrix.test.ts`

**Interfaces:**

- Produces matrix profile `api-v1-black-box`.
- Produces matrix entry ids:
  - `api-v1-auth-session`
  - `api-v1-group-presence`
  - `api-v1-client-state`
  - `api-v1-websocket-topic-routing`
  - `api-v1-scope-isolation`
- Consumes env variables:
  - `RALLAR_API_BASE_URL`, default `http://127.0.0.1:18080`
  - `RALLAR_WS_BASE_URL`, default `ws://127.0.0.1:18080`
  - `RALLAR_BB_RUN_ID`, default `local`
  - `RALLAR_ALICE_USERNAME`, default `alice`
  - `RALLAR_ALICE_PASSWORD`, default `secret`
  - `RALLAR_BOB_USERNAME`, default `bob`
  - `RALLAR_BOB_PASSWORD`, default `secret`

- [x] **Step 1: Write failing matrix tests**

Add these tests to `packages/tests/shared-test/recipe-matrix.test.ts`:

```ts
it('defines a no-browser API-v1 black-box profile', () => {
    const { entries } = readMatrix();
    const apiEntries = entries.filter((entry) => entry.profiles.includes('api-v1-black-box'));

    expect(apiEntries.map((entry) => entry.id).sort()).toEqual([
        'api-v1-auth-session',
        'api-v1-client-state',
        'api-v1-group-presence',
        'api-v1-scope-isolation',
        'api-v1-websocket-topic-routing'
    ]);

    apiEntries.forEach((entry) => {
        expect(entry.category).toBe('api-v1-black-box');
        expect(entry.mode).toBe('run');
        expect(entry.expectedExitCode).toBe(0);
        expect(entry.profiles).toContain('api-v1-black-box');
        expect(entry.profiles).not.toContain('browser-live');
        expect(entry.profiles).not.toContain('remote-live');
        expect(entry.requires?.playwright).not.toBe(true);
        expect(entry.requires?.httpServices).toEqual([
            {
                name: 'Rallar API',
                env: 'RALLAR_API_BASE_URL',
                default: 'http://127.0.0.1:18080'
            }
        ]);
    });
});

it('keeps API-v1 black-box recipes free of RTC connections', () => {
    const { entries } = readMatrix();
    const apiEntries = entries.filter((entry) => entry.profiles.includes('api-v1-black-box'));

    apiEntries.forEach((entry) => {
        const recipe = readRecipe(entry.recipe);
        const connections = recipe.connections as Record<string, { type?: string; }> | undefined;
        const connectionTypes = Object.values(connections ?? {}).map((connection) =>
            connection.type
        );

        expect(connectionTypes).not.toContain('rtc');
        expect(JSON.stringify(recipe)).not.toContain('rallar-browser');
        expect(JSON.stringify(recipe)).not.toContain('rallar-remote-browser');
    });
});

it('advertises the API-v1 profile in recipe-matrix CLI usage', () => {
    const source = readFileSync(path.join(runnerRoot, 'recipe-matrix.mts'), 'utf8');

    expect(source).toContain('api-v1-black-box');
});
```

- [x] **Step 2: Run the failing matrix tests**

Run:

```bash
npx vitest run packages/tests/shared-test/recipe-matrix.test.ts
```

Expected: FAIL because the `api-v1-black-box` profile entries do not exist.

- [x] **Step 3: Create the recipe common shape**

Use this common recipe structure in all five new recipe files, adjusting only the `steps` section per recipe:

```json
{
  "variables": {
    "rallarApiBaseUrl": {
      "env": "RALLAR_API_BASE_URL",
      "default": "http://127.0.0.1:18080"
    },
    "rallarWsBaseUrl": {
      "env": "RALLAR_WS_BASE_URL",
      "default": "ws://127.0.0.1:18080"
    },
    "runId": {
      "env": "RALLAR_BB_RUN_ID",
      "default": "local"
    },
    "applicationId": {
      "env": "RALLAR_BB_APPLICATION_ID",
      "default": "api-v1-black-box-{runId}"
    },
    "workspaceId": {
      "env": "RALLAR_BB_WORKSPACE_ID",
      "default": "default-{runId}"
    },
    "groupId": {
      "env": "RALLAR_BB_GROUP_ID",
      "default": "api-v1-bb-group-{runId}"
    },
    "groupName": {
      "env": "RALLAR_BB_GROUP_NAME",
      "default": "API v1 black-box {runId}"
    },
    "aliceUsername": {
      "env": "RALLAR_ALICE_USERNAME",
      "default": "alice"
    },
    "alicePassword": {
      "env": "RALLAR_ALICE_PASSWORD",
      "default": "secret",
      "secret": true
    },
    "bobUsername": {
      "env": "RALLAR_BOB_USERNAME",
      "default": "bob"
    },
    "bobPassword": {
      "env": "RALLAR_BOB_PASSWORD",
      "default": "secret",
      "secret": true
    }
  },
  "execution": {
    "correlation": {
      "injectHeaders": true,
      "injectPayloads": false
    }
  },
  "connections": {
    "api": {
      "type": "http",
      "baseUrl": "{rallarApiBaseUrl}",
      "headers": {
        "Content-Type": "application/json"
      },
      "timeoutMs": 10000
    },
    "rallarWs": {
      "type": "ws",
      "timeoutMs": 10000
    }
  },
  "steps": []
}
```

For recipes that do not use WebSocket, omit the `rallarWs` connection.

- [x] **Step 4: Implement `api-v1-auth-session.json`**

Use steps with these exact names and purposes:

```text
setDisposableUsername
registerDisposableUser
loginDisposableUser
deriveDisposableAuthHeader
logoutDisposableUser
rejectWrongPassword
rejectMissingBearerToken
rejectMissingClientIdHeader
rejectWebSocketTicketWithoutAuth
```

Important request details:

```json
{
  "name": "setDisposableUsername",
  "type": "set",
  "output": "disposableUsername",
  "value": "api-v1-bb-user-{runId}"
}
```

`registerDisposableUser` calls `POST /api/auth/register` with body:

```json
{
  "username": "{disposableUsername}",
  "password": "api-v1-bb-password-{runId}",
  "displayName": "API v1 black-box user {runId}"
}
```

Expect `201` with `clientId`, `username`, and `registeredAtEpochMs`. Do not accept `409` for this run-scoped username because a collision should expose a bad `runId` or leftover state.

- [x] **Step 5: Implement `api-v1-group-presence.json`**

Use static `alice` login and steps with these exact names:

```text
loginAlice
deriveAliceAuthHeader
createGroup
joinAliceToGroup
connectAliceGroupPresence
heartbeatAliceGroupPresence
readGroupSnapshot
listGroupEvents
listGroupEventPage
disconnectAliceGroupPresence
logoutAlice
```

Use the group/presence endpoints already exercised by `rallar-server-auth-group-ws-smoke.json`, but derive group/request IDs from `{runId}`. Use `statusCode: [201, 409]` only on `createGroup`; all later lifecycle steps should expect `200`.

- [x] **Step 6: Implement `api-v1-client-state.json`**

Use static `alice` login and steps with these exact names:

```text
loginAlice
deriveAliceAuthHeader
upsertAlicePrincipal
upsertAliceInstance
connectAliceClientSession
heartbeatAliceClientSession
readAliceClientSnapshot
readAliceClientPresence
listAliceClientEvents
listAliceClientEventPage
disconnectAliceClientSession
logoutAlice
```

Use these IDs:

```json
{
  "clientInstanceId": "api-v1-bb-instance-{runId}",
  "sessionId": "{aliceSessionId}"
}
```

The principal path is:

```text
/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{aliceClientId}/principal
```

The session path is:

```text
/api/state/apps/{applicationId}/workspaces/{workspaceId}/clients/{aliceClientId}/instances/api-v1-bb-instance-{runId}/sessions/{aliceSessionId}
```

- [x] **Step 7: Implement `api-v1-websocket-topic-routing.json`**

Use static `alice` login, group/presence setup, and steps with these exact names:

```text
loginAlice
deriveAliceAuthHeader
createGroup
joinAliceToGroup
connectAlicePresence
createWebSocketTicket
deriveWebSocketUrl
openWebSocket
sendSelfAddressedMessage
closeWebSocket
disconnectAlicePresence
logoutAlice
```

`deriveWebSocketUrl` must use a safe transform with URL encoding:

```json
{
  "name": "deriveWebSocketUrl",
  "type": "set",
  "output": "wsUrl",
  "secret": true,
  "redactAs": "wsUrl",
  "transform": {
    "concat": [
      { "path": "variables.rallarWsBaseUrl" },
      "/api/ws/",
      { "path": "outputs.aliceSessionId" },
      "?ticket=",
      { "urlEncode": { "path": "outputs.wsTicket" } }
    ]
  }
}
```

`sendSelfAddressedMessage` sends the same AL shape used by `rallar-server-auth-group-ws-smoke.json`, but with `msgId`, `resourceId`, and `traceId` derived from `{runId}`.

- [x] **Step 8: Implement `api-v1-scope-isolation.json`**

Use static `alice` and `bob` logins. Create two groups with the same logical `groupId` in different scopes:

```text
applicationId: api-v1-black-box-{runId}-a
workspaceId: workspace-a-{runId}
groupId: shared-group-{runId}

applicationId: api-v1-black-box-{runId}-b
workspaceId: workspace-b-{runId}
groupId: shared-group-{runId}
```

Use steps with these exact names:

```text
loginAlice
deriveAliceAuthHeader
loginBob
deriveBobAuthHeader
createScopeAGroup
joinAliceScopeAGroup
createScopeBGroup
joinBobScopeBGroup
readScopeAGroupAsAlice
readScopeBGroupAsBob
rejectBobReadScopeAGroup
rejectAliceReadScopeBGroup
listScopeAEventsAsAlice
listScopeBEventsAsBob
logoutAlice
logoutBob
```

Wrong-principal group reads require `RALLAR_STATE_STRICT_READ_AUTH=1` in the
server environment. Expect status `403` with this body shape:

```json
{
  "error": "Forbidden: Only active group members can read full group state.",
  "code": "group-policy-denied",
  "message": "Only active group members can read full group state.",
  "details": {
    "visibility": "directory"
  }
}
```

- [x] **Step 9: Add matrix entries**

Append entries like this to `packages/shared-test/black-box-runner/recipe-matrix.json`:

```json
{
  "id": "api-v1-auth-session",
  "recipe": "examples/api-v1-auth-session.json",
  "category": "api-v1-black-box",
  "mode": "run",
  "profiles": ["api-v1-black-box"],
  "expectedExitCode": 0,
  "artifactName": "api-v1-auth-session",
  "requires": {
    "httpServices": [
      {
        "name": "Rallar API",
        "env": "RALLAR_API_BASE_URL",
        "default": "http://127.0.0.1:18080"
      }
    ]
  },
  "description": "No-browser API-v1 auth/session black-box recipe."
}
```

Repeat the same shape for the other four entry IDs and recipe paths. Add no `requires.playwright`.

- [x] **Step 10: Update matrix usage and profile documentation**

Modify `packages/shared-test/black-box-runner/recipe-matrix.mts` so the
`--profile=<name>` usage text includes `api-v1-black-box`:

```ts
'  --profile=<name>              quick, dry, deterministic, validation, soak, traffic, parallel, failure-diagnostics, live, live-soak, live-traffic, live-parallel, live-crdt, rallar-server-live, api-v1-black-box, browser-live, remote-live, signaling-live. Default: quick',
```

Add this row to the profile table in
`packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md`:

```markdown
| `api-v1-black-box` | No-browser `apps/api-v1` REST/WS black-box recipes. Requires a running Rallar API and no Playwright/browser gate. |
```

- [x] **Step 11: Update example documentation**

Add five rows to the example index in `packages/shared-test/black-box-runner/examples/README.md` for the new recipe files. Add a short paragraph under Provider Choice:

```markdown
API-v1 black-box recipes are no-browser service tests. They use only HTTP, raw
WS, SET, and ASSERT steps against a running `apps/api-v1`; they must not add
RTC connections or browser provider requirements.
```

- [x] **Step 12: Validate recipe authoring**

Run:

```bash
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/api-v1-auth-session.json \
  --validate --strict
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/api-v1-group-presence.json \
  --validate --strict
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/api-v1-client-state.json \
  --validate --strict
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/api-v1-websocket-topic-routing.json \
  --validate --strict
deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
  -c packages/shared-test/black-box-runner/examples/api-v1-scope-isolation.json \
  --validate --strict
```

Expected: each command exits `0` and prints validation JSON with no blocking issues.

- [x] **Step 13: Run matrix tests**

Run:

```bash
npx vitest run packages/tests/shared-test/recipe-matrix.test.ts
```

Expected: PASS.

- [x] **Step 14: Commit**

```bash
git add \
  packages/shared-test/black-box-runner/examples/api-v1-auth-session.json \
  packages/shared-test/black-box-runner/examples/api-v1-group-presence.json \
  packages/shared-test/black-box-runner/examples/api-v1-client-state.json \
  packages/shared-test/black-box-runner/examples/api-v1-websocket-topic-routing.json \
  packages/shared-test/black-box-runner/examples/api-v1-scope-isolation.json \
  packages/shared-test/black-box-runner/recipe-matrix.json \
  packages/shared-test/black-box-runner/recipe-matrix.mts \
  packages/shared-test/black-box-runner/examples/README.md \
  packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md \
  packages/tests/shared-test/recipe-matrix.test.ts
git commit -m "test: add api-v1 black-box recipes"
```

---

## Iteration 2: Local/CI Orchestration Helper

### Task 2: Add API-v1 Black-Box Run CLI

**Files:**

- Create: `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`
- Create: `packages/tests/shared-test/api-v1-black-box-run.test.ts`
- Modify: `packages/shared-test/package.json`

**Interfaces:**

- Produces `parseApiV1BlackBoxArgs(args: string[]): ApiV1BlackBoxOptions`
- Produces `toApiV1BlackBoxEnvironment(options: ApiV1BlackBoxOptions, baseEnv: Record<string, string | undefined>): Record<string, string>`
- Produces `toApiV1ServerCommand(options: ApiV1BlackBoxOptions): readonly string[]`
- CLI accepts:
  - `--backend=postgres|pglite-memory`
  - `--port=<number>`
  - `--artifact-dir=<path>`
  - `--profile=<profile>`
  - `--run-id=<id>`
  - `--recipes-only`
  - `--no-migrate`
  - `--no-require-gates`

- [x] **Step 1: Write failing unit tests**

Create `packages/tests/shared-test/api-v1-black-box-run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
    parseApiV1BlackBoxArgs,
    toApiV1BlackBoxEnvironment,
    toApiV1ServerCommand
} from '../../shared-test/black-box-runner/api-v1-black-box-run.mts';

describe('api-v1 black-box run helper', () => {
    it('defaults to Postgres on port 18080', () => {
        expect(parseApiV1BlackBoxArgs([])).toMatchObject({
            backend: 'postgres',
            port: 18080,
            profile: 'api-v1-black-box',
            artifactDir: '.artifacts/api-v1-black-box/postgres',
            requireGates: true,
            runMigrations: true,
            recipesOnly: false
        });
    });

    it('keeps recipes-only mode free of server and migration side effects', () => {
        expect(parseApiV1BlackBoxArgs(['--recipes-only'])).toMatchObject({
            backend: 'postgres',
            requireGates: true,
            runMigrations: false,
            recipesOnly: true
        });
    });

    it('builds Postgres server environment with a local DATABASE_URL default', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres', '--port=18080']);
        const env = toApiV1BlackBoxEnvironment(options, {});

        expect(env.PORT).toBe('18080');
        expect(env.RALLAR_SQL_BACKEND).toBe('postgres');
        expect(env.DATABASE_URL).toBe('postgres://app:app@localhost:5432/appdb');
        expect(env.RALLAR_STATE_STRICT_READ_AUTH).toBe('1');
        expect(env.AUTH_STATIC_CLIENTS_MODE).toBe('demo');
        expect(env.AUTH_REGISTRATION_MODE).toBe('public');
    });

    it('preserves explicit Postgres DATABASE_URL values', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);
        const env = toApiV1BlackBoxEnvironment(options, {
            DATABASE_URL: 'postgres://custom:custom@localhost:15432/customdb'
        });

        expect(env.RALLAR_SQL_BACKEND).toBe('postgres');
        expect(env.DATABASE_URL).toBe('postgres://custom:custom@localhost:15432/customdb');
    });

    it('preserves explicit API URLs in recipes-only mode', () => {
        const options = parseApiV1BlackBoxArgs(['--recipes-only']);
        const env = toApiV1BlackBoxEnvironment(options, {
            RALLAR_API_BASE_URL: 'http://127.0.0.1:19999',
            RALLAR_WS_BASE_URL: 'ws://127.0.0.1:19999'
        });

        expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:19999');
        expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:19999');
    });

    it('builds pglite-memory server environment without Postgres settings', () => {
        const options = parseApiV1BlackBoxArgs([
            '--backend=pglite-memory',
            '--port=19090',
            '--run-id=local-123'
        ]);
        const env = toApiV1BlackBoxEnvironment(options, {});

        expect(env.PORT).toBe('19090');
        expect(env.RALLAR_API_BASE_URL).toBe('http://127.0.0.1:19090');
        expect(env.RALLAR_WS_BASE_URL).toBe('ws://127.0.0.1:19090');
        expect(env.RALLAR_BB_RUN_ID).toBe('local-123');
        expect(env.RALLAR_SQL_BACKEND).toBe('pglite-memory');
        expect(env.RALLAR_PGLITE_DATA_DIR).toBe('memory://');
        expect(env.RALLAR_PGLITE_SCHEMA_INIT).toBe('auto');
        expect(env.RALLAR_DB_PUBSUB).toBe('local');
        expect(env.RALLAR_STATE_STRICT_READ_AUTH).toBe('1');
        expect(env.AUTH_STATIC_CLIENTS_MODE).toBe('demo');
        expect(env.AUTH_REGISTRATION_MODE).toBe('public');
    });

    it('builds the api-v1 Deno server command', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=postgres']);

        expect(toApiV1ServerCommand(options)).toEqual([
            'deno',
            'run',
            '--config',
            'apps/api-v1/deno.json',
            '--allow-net',
            '--allow-env',
            '--allow-read',
            'apps/api-v1/src/main.ts'
        ]);
    });
});
```

- [x] **Step 2: Run the failing helper tests**

Run:

```bash
npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts
```

Expected: FAIL because `api-v1-black-box-run.mts` does not exist.

- [x] **Step 3: Implement exported helper functions**

Create `packages/shared-test/black-box-runner/api-v1-black-box-run.mts` with these exported types and functions:

```ts
export type ApiV1BlackBoxBackend = 'postgres' | 'pglite-memory';

export type ApiV1BlackBoxOptions = Readonly<{
    backend: ApiV1BlackBoxBackend;
    port: number;
    profile: string;
    artifactDir: string;
    runId: string;
    requireGates: boolean;
    runMigrations: boolean;
    recipesOnly: boolean;
}>;

export function parseApiV1BlackBoxArgs(args: readonly string[]): ApiV1BlackBoxOptions {
    const values = new Map<string, string | boolean>();
    for (const arg of args) {
        const [name, value] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, true];
        values.set(name, value);
    }

    const backend = String(values.get('--backend') ?? 'postgres') as ApiV1BlackBoxBackend;
    if (backend !== 'postgres' && backend !== 'pglite-memory') {
        throw new Error('--backend must be postgres or pglite-memory.');
    }

    const port = Number(values.get('--port') ?? '18080');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--port must be an integer from 1 to 65535.');
    }

    const runId = String(values.get('--run-id') ?? defaultRunId());
    const artifactDir = String(
        values.get('--artifact-dir') ?? `.artifacts/api-v1-black-box/${backend}`
    );
    const recipesOnly = values.get('--recipes-only') === true;

    return {
        backend,
        port,
        profile: String(values.get('--profile') ?? 'api-v1-black-box'),
        artifactDir,
        runId,
        requireGates: values.get('--no-require-gates') !== true,
        runMigrations: backend === 'postgres' && !recipesOnly &&
            values.get('--no-migrate') !== true,
        recipesOnly
    };
}

function defaultRunId(): string {
    return `local-${Date.now()}`;
}

export function toApiV1BlackBoxEnvironment(
    options: ApiV1BlackBoxOptions,
    baseEnv: Record<string, string | undefined>
): Record<string, string> {
    const env: Record<string, string> = Object.fromEntries(
        Object.entries(baseEnv).filter((entry): entry is [string, string] =>
            typeof entry[1] === 'string'
        )
    );
    env.PORT = String(options.port);
    const defaultApiBaseUrl = `http://127.0.0.1:${options.port}`;
    const defaultWsBaseUrl = `ws://127.0.0.1:${options.port}`;
    env.RALLAR_API_BASE_URL = options.recipesOnly
        ? env.RALLAR_API_BASE_URL ?? defaultApiBaseUrl
        : defaultApiBaseUrl;
    env.RALLAR_WS_BASE_URL = options.recipesOnly
        ? env.RALLAR_WS_BASE_URL ?? defaultWsBaseUrl
        : defaultWsBaseUrl;
    env.RALLAR_BB_RUN_ID = options.runId;
    env.RALLAR_ICE_MODE = env.RALLAR_ICE_MODE ?? 'local';
    env.RALLAR_LOGIN_USER_RATE_LIMIT = env.RALLAR_LOGIN_USER_RATE_LIMIT ?? '100';
    env.RALLAR_STATE_STRICT_READ_AUTH = env.RALLAR_STATE_STRICT_READ_AUTH ?? '1';
    env.AUTH_STATIC_CLIENTS_MODE = env.AUTH_STATIC_CLIENTS_MODE ?? 'demo';
    env.AUTH_REGISTRATION_MODE = env.AUTH_REGISTRATION_MODE ?? 'public';

    if (options.backend === 'postgres') {
        env.RALLAR_SQL_BACKEND = 'postgres';
        env.DATABASE_URL = env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/appdb';
    }
    else {
        env.RALLAR_SQL_BACKEND = 'pglite-memory';
        env.RALLAR_PGLITE_DATA_DIR = 'memory://';
        env.RALLAR_PGLITE_SCHEMA_INIT = 'auto';
        env.RALLAR_DB_PUBSUB = 'local';
        delete env.DATABASE_URL;
    }

    return env;
}

export function toApiV1ServerCommand(_options: ApiV1BlackBoxOptions): readonly string[] {
    return [
        'deno',
        'run',
        '--config',
        'apps/api-v1/deno.json',
        '--allow-net',
        '--allow-env',
        '--allow-read',
        'apps/api-v1/src/main.ts'
    ];
}
```

- [x] **Step 4: Implement CLI orchestration**

In the same file, add `main()` that:

1. Parses args.
2. Builds the normalized environment with `toApiV1BlackBoxEnvironment(options, Deno.env.toObject())`.
3. Creates the artifact directory.
4. Runs `npm run db:migrate` with that normalized environment when `options.runMigrations` is true.
5. Starts the API process with that normalized environment unless `--recipes-only` is passed.
6. Waits up to 30 seconds for `GET /api/config` only when the helper started
   the API process. In `--recipes-only` mode, let the matrix live preflight own
   the unavailable-API failure.
7. Runs the matrix command with that normalized environment:

```bash
deno run -A packages/shared-test/black-box-runner/recipe-matrix.mts \
  --profile=<profile> \
  --require-gates \
  --artifact-dir=<artifact-dir>
```

Include `--require-gates` when `options.requireGates` is true and omit it only
when the caller passed `--no-require-gates`.

8. Writes API stdout/stderr to `<artifact-dir>/api-v1-server.log`.
9. Kills the API process in a `finally` block.

`--recipes-only` must create the artifact directory and run the matrix only. It
must not run migrations, start the API, or wait for `/api/config`; this keeps
recipe authoring checks usable without local Postgres.

Keep helpers small: `runCommand`, `startServer`, `waitForApiConfig`, `runRecipeMatrix`, and `stopServer`.

Call `main()` only when the file is executed as a Deno script, not when Vitest
imports the helper functions:

```ts
const importMeta = import.meta as ImportMeta & { main?: boolean; };

if (importMeta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        Deno.exit(1);
    });
}
```

- [x] **Step 5: Add helper to Deno check script**

Modify `packages/shared-test/package.json`:

```json
{
  "scripts": {
    "check:deno": "deno check black-box-runner/scenario-black-box.ts black-box-runner/recipe-matrix.mts black-box-runner/live-preflight.ts black-box-runner/rallar-browser-live-validation.mts black-box-runner/artifact-reader.ts black-box-runner/traffic-plan-reducer.ts black-box-runner/api-v1-black-box-run.mts"
  }
}
```

Preserve the existing script entries and only append the new file.

- [x] **Step 6: Run helper tests**

Run:

```bash
npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts
```

Expected: PASS.

- [x] **Step 7: Run Deno check**

Run:

```bash
npm --workspace @ar-eye-hunter/shared-test run check:deno
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add \
  packages/shared-test/black-box-runner/api-v1-black-box-run.mts \
  packages/tests/shared-test/api-v1-black-box-run.test.ts \
  packages/shared-test/package.json
git commit -m "test: add api-v1 black-box runner helper"
```

---

## Iteration 3: Package Scripts

### Task 3: Add Local Convenience Scripts

**Files:**

- Modify: `packages/shared-test/package.json`
- Modify: `package.json`

**Interfaces:**

- Produces workspace scripts:
  - `bb:api-v1:recipes`
  - `bb:api-v1:postgres`
  - `bb:api-v1:memory`
- Produces root scripts:
  - `test:api-v1:black-box:recipes`
  - `test:api-v1:black-box:postgres`
  - `test:api-v1:black-box:memory`
  - `test:api-v1:black-box`

- [x] **Step 1: Add workspace scripts**

Modify `packages/shared-test/package.json` scripts:

```json
{
  "bb:api-v1:recipes": "deno run -A black-box-runner/api-v1-black-box-run.mts --recipes-only --artifact-dir=../../.artifacts/api-v1-black-box/recipes",
  "bb:api-v1:postgres": "deno run -A black-box-runner/api-v1-black-box-run.mts --backend=postgres --artifact-dir=../../.artifacts/api-v1-black-box/postgres",
  "bb:api-v1:memory": "deno run -A black-box-runner/api-v1-black-box-run.mts --backend=pglite-memory --artifact-dir=../../.artifacts/api-v1-black-box/memory"
}
```

- [x] **Step 2: Add root scripts**

Modify root `package.json` scripts:

```json
{
  "test:api-v1:black-box": "npm run test:api-v1:black-box:postgres",
  "test:api-v1:black-box:recipes": "npm --workspace @ar-eye-hunter/shared-test run bb:api-v1:recipes",
  "test:api-v1:black-box:postgres": "npm --workspace @ar-eye-hunter/shared-test run bb:api-v1:postgres",
  "test:api-v1:black-box:memory": "npm --workspace @ar-eye-hunter/shared-test run bb:api-v1:memory"
}
```

- [x] **Step 3: List the profile through the script**

Run:

```bash
npm --workspace @ar-eye-hunter/shared-test run bb:matrix:list -- --profile=api-v1-black-box
```

Expected: output includes the five API-v1 entry IDs.

- [x] **Step 4: Run recipes-only mode against a missing server**

Run:

```bash
npm run test:api-v1:black-box:recipes
```

Expected: FAIL with preflight skip/failure pointing at unavailable `http://127.0.0.1:18080/api/config`. This confirms `--require-gates` is active.

- [x] **Step 5: Run memory backend smoke**

Run:

```bash
npm run test:api-v1:black-box:memory
```

Expected: PASS and artifacts under `.artifacts/api-v1-black-box/memory`.

- [x] **Step 6: Commit**

```bash
git add package.json packages/shared-test/package.json
git commit -m "test: add api-v1 black-box scripts"
```

---

## Iteration 4: GitHub Composite Action

### Task 4: Add Reusable API-v1 Black-Box Action

**Files:**

- Create: `.github/actions/api-v1-black-box-test/action.yml`

**Interfaces:**

- Consumes inputs:
  - `backend`
  - `api-port`
  - `artifact-dir`
  - `profile`
  - `run-migrations`
  - `run-id`
- Calls `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`.
- Produces artifacts in the configured `artifact-dir`.

- [x] **Step 1: Create composite action**

Create `.github/actions/api-v1-black-box-test/action.yml`:

```yaml
name: API v1 black-box test
description: Start apps/api-v1 and run no-browser black-box-runner recipes.
inputs:
  backend:
    description: Backend to use: postgres or pglite-memory.
      required: false
      default: postgres
  api-port:
    description: Local API port.
    required: false
    default: '18080'
  artifact-dir:
    description: Directory for runner artifacts and API logs.
    required: false
    default: .artifacts/api-v1-black-box/postgres
  profile:
    description: Black-box runner matrix profile.
    required: false
    default: api-v1-black-box
  run-migrations:
    description: Run Postgres migrations before starting API.
    required: false
    default: 'true'
  run-id:
    description: Stable run id for test data isolation.
    required: false
    default: local
runs:
  using: composite
  steps:
    - name: Run API v1 black-box recipes
      shell: bash
      env:
        RALLAR_BB_RUN_ID: '${{ inputs.run-id }}'
      run: |
        set -euo pipefail

        args=(
          "--backend=${{ inputs.backend }}"
          "--port=${{ inputs.api-port }}"
          "--artifact-dir=${{ inputs.artifact-dir }}"
          "--profile=${{ inputs.profile }}"
          "--run-id=${{ inputs.run-id }}"
        )

        if [ "${{ inputs.run-migrations }}" != "true" ]; then
          args+=("--no-migrate")
        fi

        deno run -A packages/shared-test/black-box-runner/api-v1-black-box-run.mts "${args[@]}"
```

- [x] **Step 2: Parse the action YAML**

Run:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/actions/api-v1-black-box-test/action.yml"); puts "ok"'
```

Expected: prints `ok`.

- [x] **Step 3: Commit**

```bash
git add .github/actions/api-v1-black-box-test/action.yml
git commit -m "ci: add api-v1 black-box action"
```

---

## Iteration 5: GitHub Workflow Wiring

### Task 5: Add Required Postgres Gate And Manual Memory Workflow

**Files:**

- Modify: `.github/workflows/release-gate.yml`
- Create: `.github/workflows/api-v1-black-box.yml`

**Interfaces:**

- Release gate invokes `.github/actions/api-v1-black-box-test` with Postgres.
- Manual workflow can run Postgres only or Postgres plus pglite-memory.

- [x] **Step 1: Add release-gate API-v1 black-box step**

In `.github/workflows/release-gate.yml`, after `Run Postgres migrations` and before `Run Postgres full-stack smoke tests`, add:

```yaml
- name: Run API v1 black-box recipes
  uses: ./.github/actions/api-v1-black-box-test
  with:
    backend: postgres
    api-port: '18080'
    artifact-dir: .artifacts/api-v1-black-box/postgres
    profile: api-v1-black-box
    run-migrations: 'false'
    run-id: '${{ github.run_id }}-${{ github.run_attempt }}-postgres'

- name: Upload API v1 black-box artifacts
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: api-v1-black-box-postgres
    path: .artifacts/api-v1-black-box/postgres
    if-no-files-found: warn
```

Keep the existing Postgres service and migration step. The action uses the existing `DATABASE_URL` and does not run migrations again.

- [x] **Step 2: Add manual helper workflow**

Create `.github/workflows/api-v1-black-box.yml`:

```yaml
name: API v1 Black-Box

on:
  workflow_dispatch:
    inputs:
      include_memory:
        description: Run optional pglite-memory backend after Postgres.
        required: false
        default: false
        type: boolean

permissions:
  contents: read

jobs:
  postgres:
    name: API v1 black-box Postgres
    runs-on: ubuntu-latest
    timeout-minutes: 30
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
          POSTGRES_DB: appdb
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U app -d appdb"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 20
    env:
      DATABASE_URL: postgresql://app:app@localhost:5432/appdb
      RALLAR_ICE_MODE: local
      RALLAR_LOGIN_USER_RATE_LIMIT: '100'
      RALLAR_STATE_STRICT_READ_AUTH: '1'
      AUTH_STATIC_CLIENTS_MODE: demo
      AUTH_REGISTRATION_MODE: public
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: package-lock.json
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: npm ci
      - name: Run API v1 black-box recipes
        uses: ./.github/actions/api-v1-black-box-test
        with:
          backend: postgres
          api-port: '18080'
          artifact-dir: .artifacts/api-v1-black-box/postgres
          run-id: '${{ github.run_id }}-${{ github.run_attempt }}-postgres'
      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: api-v1-black-box-postgres
          path: .artifacts/api-v1-black-box/postgres
          if-no-files-found: warn

  memory:
    name: API v1 black-box pglite-memory
    if: ${{ inputs.include_memory }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      RALLAR_ICE_MODE: local
      RALLAR_LOGIN_USER_RATE_LIMIT: '100'
      RALLAR_STATE_STRICT_READ_AUTH: '1'
      AUTH_STATIC_CLIENTS_MODE: demo
      AUTH_REGISTRATION_MODE: public
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: package-lock.json
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: npm ci
      - name: Run API v1 black-box recipes
        uses: ./.github/actions/api-v1-black-box-test
        with:
          backend: pglite-memory
          api-port: '18081'
          artifact-dir: .artifacts/api-v1-black-box/memory
          run-migrations: 'false'
          run-id: '${{ github.run_id }}-${{ github.run_attempt }}-memory'
      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: api-v1-black-box-memory
          path: .artifacts/api-v1-black-box/memory
          if-no-files-found: warn
```

- [x] **Step 3: Parse workflow YAML**

Run:

```bash
ruby -e 'require "yaml"; %w[.github/workflows/release-gate.yml .github/workflows/api-v1-black-box.yml].each { |f| YAML.load_file(f) }; puts "ok"'
```

Expected: prints `ok`.

- [x] **Step 4: Commit**

```bash
git add .github/workflows/release-gate.yml .github/workflows/api-v1-black-box.yml
git commit -m "ci: run api-v1 black-box gate"
```

---

## Iteration 6: Verification And Documentation

### Task 6: Validate End-To-End And Document Commands

**Files:**

- Modify: `packages/shared-test/docs/shared-test-verification.md`
- Modify: `packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md`

**Interfaces:**

- Documents root commands:
  - `npm run test:api-v1:black-box:postgres`
  - `npm run test:api-v1:black-box:memory`
  - `npm run test:api-v1:black-box:recipes`
- Documents artifacts:
  - `.artifacts/api-v1-black-box/postgres`
  - `.artifacts/api-v1-black-box/memory`

- [x] **Step 1: Update verification docs**

Add a section to `packages/shared-test/docs/shared-test-verification.md`:

````markdown
## API-v1 Black-Box Recipes

These commands run no-browser black-box-runner recipes against `apps/api-v1`.
The required CI backend is Postgres; pglite-memory is optional for fast local
feedback.

```bash
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:memory
```

When an API is already running, use:

```bash
RALLAR_API_BASE_URL=http://127.0.0.1:18080 \
RALLAR_WS_BASE_URL=ws://127.0.0.1:18080 \
RALLAR_BB_RUN_ID=manual-$(date +%s) \
npm run test:api-v1:black-box:recipes
```

Artifacts are written under `.artifacts/api-v1-black-box/<backend>` and include
runner reports, event streams, failure bundles, expanded recipes, matrix
summary, and `api-v1-server.log` for orchestrated runs.
````

Add this command block under the Commands section in
`packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md`:

````markdown
Run the no-browser API-v1 black-box profile through the orchestration helper:

```bash
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:recipes
```

These commands write artifacts under `.artifacts/api-v1-black-box/*` instead of
the generic `.artifacts/shared-test/recipe-matrix/*` path because the helper
also captures `apps/api-v1` server logs.
````

- [x] **Step 2: Run static checks**

Run:

```bash
npm run check:shared-test
npx vitest run packages/tests/shared-test/recipe-matrix.test.ts packages/tests/shared-test/api-v1-black-box-run.test.ts
```

Expected: PASS.

- [x] **Step 3: Run recipe validation**

Run:

```bash
for recipe in \
  api-v1-auth-session \
  api-v1-group-presence \
  api-v1-client-state \
  api-v1-websocket-topic-routing \
  api-v1-scope-isolation
do
  deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts \
    -c "packages/shared-test/black-box-runner/examples/${recipe}.json" \
    --validate --strict
done
```

Expected: each command exits `0`.

- [x] **Step 4: Run pglite-memory black-box smoke**

Run:

```bash
npm run test:api-v1:black-box:memory
```

Expected: PASS and `.artifacts/api-v1-black-box/memory/matrix-summary.json` shows five passed entries and zero skipped/failed entries.

- [ ] **Step 5: Run Postgres black-box smoke when Postgres is available**

Run:

```bash
npm run db:up
npm run test:api-v1:black-box:postgres
```

Expected: PASS and `.artifacts/api-v1-black-box/postgres/matrix-summary.json` shows five passed entries and zero skipped/failed entries.

Blocked in this environment: `npm run db:up` could not start Postgres. The
first attempt failed on Docker socket permission in the sandbox; the approved
retry began pulling `postgres:16` but did not complete after several poll
windows and was interrupted. `docker compose ps postgres` then showed no
running Postgres service.

- [x] **Step 6: Inspect artifacts**

Run:

```bash
ls .artifacts/api-v1-black-box/memory
find .artifacts/api-v1-black-box/memory -name failures.json -print
```

Expected: backend artifact folder exists; every `failures.json` either contains an empty failure list or belongs to a run that failed and was already investigated.

- [x] **Step 7: Commit**

```bash
git add \
  packages/shared-test/docs/shared-test-verification.md \
  packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md
git commit -m "docs: document api-v1 black-box validation"
```

---

## Final Verification Checklist

- [x] `npm run check:shared-test` passes.
- [x] `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts packages/tests/shared-test/api-v1-black-box-run.test.ts` passes.
- [x] All five API-v1 recipes pass `scenario-black-box.ts --validate --strict`.
- [x] `npm run test:api-v1:black-box:memory` passes.
- [x] `npm run test:api-v1:black-box:postgres` passes or is explicitly reported as skipped because local Postgres is unavailable.
- [x] `.github/actions/api-v1-black-box-test/action.yml` parses as YAML.
- [x] `.github/workflows/release-gate.yml` and `.github/workflows/api-v1-black-box.yml` parse as YAML.
- [x] `recipe-matrix.mts --help` advertises `api-v1-black-box`.
- [x] `npm run test:api-v1:black-box:recipes` fails on missing API preflight, not on migrations or server startup.
- [x] Generated `.artifacts/` files are not staged.
- [x] No Playwright/browser dependency was added to the API-v1 black-box path.

## Implementation Progress

### Iteration 1: Recipe Catalog And Matrix Profile

- Date/time: 2026-07-08 14:58:00 CEST.
- Completed steps: 1-14.
- Files changed:
  - `packages/tests/shared-test/recipe-matrix.test.ts`
  - `packages/shared-test/black-box-runner/examples/api-v1-auth-session.json`
  - `packages/shared-test/black-box-runner/examples/api-v1-group-presence.json`
  - `packages/shared-test/black-box-runner/examples/api-v1-client-state.json`
  - `packages/shared-test/black-box-runner/examples/api-v1-websocket-topic-routing.json`
  - `packages/shared-test/black-box-runner/examples/api-v1-scope-isolation.json`
  - `packages/shared-test/black-box-runner/recipe-matrix.json`
  - `packages/shared-test/black-box-runner/recipe-matrix.mts`
  - `packages/shared-test/black-box-runner/examples/README.md`
  - `packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md`
- Commands run:
  - `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts` failed as expected after adding tests: missing `api-v1-black-box` entries and CLI usage text.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-auth-session.json --validate --strict` passed.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-group-presence.json --validate --strict` passed.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-client-state.json --validate --strict` passed.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-websocket-topic-routing.json --validate --strict` passed.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-scope-isolation.json --validate --strict` passed.
  - `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts` passed with 12 tests.
- Blockers: none.
- Implementation notes: `runId` is declared after run-scoped variable defaults in the new recipes because the current runner replaces variables in declaration order and does not recursively resolve descriptor defaults.
- Commit: `77a87e7` (`test: add api-v1 black-box recipes`).
- Follow-up validation still required: live API-v1 recipe execution through the orchestration helper in later iterations.

### Iteration 2: Local/CI Orchestration Helper

- Date/time: 2026-07-08 15:03:16 CEST.
- Completed steps: 1-8.
- Files changed:
  - `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`
  - `packages/tests/shared-test/api-v1-black-box-run.test.ts`
  - `packages/shared-test/package.json`
- Commands run:
  - `npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts` failed as expected before the helper existed: import resolution failed for `api-v1-black-box-run.mts`.
  - `npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts` passed with 7 tests after implementation.
  - `npm --workspace @ar-eye-hunter/shared-test run check:deno` passed and now includes `black-box-runner/api-v1-black-box-run.mts`.
- Blockers: none.
- Implementation notes: the helper starts `apps/api-v1` only outside `--recipes-only`; recipes-only mode creates artifacts and delegates unavailable-service failure to the matrix preflight.
- Commit: `4f976fe` (`test: add api-v1 black-box runner helper`).
- Follow-up validation still required: exercise the helper through package/root scripts and live pglite-memory/Postgres runs in later iterations.

### Iteration 3: Package Scripts

- Date/time: 2026-07-08 15:06:34 CEST.
- Completed steps: 1-6.
- Files changed:
  - `packages/shared-test/package.json`
  - `package.json`
- Commands run:
  - `npm --workspace @ar-eye-hunter/shared-test run bb:matrix:list -- --profile=api-v1-black-box` passed and listed `api-v1-auth-session`, `api-v1-group-presence`, `api-v1-client-state`, `api-v1-websocket-topic-routing`, and `api-v1-scope-isolation`.
  - `npm run test:api-v1:black-box:recipes` failed as expected with `--require-gates` active; the sandbox reports local TCP connect to `http://127.0.0.1:18080/api/config` as `Operation not permitted`, which still confirms unavailable API services fail the gated recipes-only run.
  - `npm run test:api-v1:black-box:memory` first failed inside the sandbox while waiting for `/api/config` because local TCP connect was blocked with `Operation not permitted`.
  - `npm run test:api-v1:black-box:memory` passed after approved escalation for local HTTP/WebSocket access: 5 passed, 0 failed, 0 skipped.
- Blockers: local TCP server/client traffic requires approval in this sandbox; approved escalation was sufficient for the memory smoke.
- Implementation notes: root `test:api-v1:black-box` defaults to the Postgres script; pglite-memory remains opt-in through `test:api-v1:black-box:memory`.
- Commit: `3807bd7` (`test: add api-v1 black-box scripts`).
- Follow-up validation still required: Postgres black-box smoke once Postgres is available and CI workflow wiring in later iterations.

### Iteration 4: GitHub Composite Action

- Date/time: 2026-07-08 15:08:00 CEST.
- Completed steps: 1-3.
- Files changed:
  - `.github/actions/api-v1-black-box-test/action.yml`
- Commands run:
  - `ruby -e 'require "yaml"; YAML.load_file(".github/actions/api-v1-black-box-test/action.yml"); puts "ok"'` failed initially because `description: Backend to use: postgres or pglite-memory.` needed quoting around the colon-containing scalar.
  - `ruby -e 'require "yaml"; YAML.load_file(".github/actions/api-v1-black-box-test/action.yml"); puts "ok"'` passed after quoting the description.
- Blockers: none.
- Implementation notes: the composite action defaults to Postgres and leaves pglite-memory opt-in through the `backend` input; `run-migrations` controls whether `--no-migrate` is passed to the helper.
- Commit: `4eec697` (`ci: add api-v1 black-box action`).
- Follow-up validation still required: workflow wiring that invokes the action and uploads artifacts.

### Iteration 5: GitHub Workflow Wiring

- Date/time: 2026-07-08 15:09:28 CEST.
- Completed steps: 1-4.
- Files changed:
  - `.github/workflows/release-gate.yml`
  - `.github/workflows/api-v1-black-box.yml`
- Commands run:
  - `ruby -e 'require "yaml"; %w[.github/workflows/release-gate.yml .github/workflows/api-v1-black-box.yml].each { |f| YAML.load_file(f) }; puts "ok"'` passed.
- Blockers: none.
- Implementation notes: release-gate runs the Postgres API-v1 black-box action after migrations with `run-migrations: "false"`; the manual workflow always runs Postgres and runs pglite-memory only when `include_memory` is true.
- Commit: `f42d0a7` (`ci: run api-v1 black-box gate`).
- Follow-up validation still required: GitHub-hosted workflow execution after push/PR.

### Iteration 6: Verification And Documentation

- Date/time: 2026-07-08 15:16:04 CEST.
- Completed steps: 1-4, 6, and 7; step 5 is blocked because local Postgres is not available.
- Files changed:
  - `packages/shared-test/docs/shared-test-verification.md`
  - `packages/shared-test/black-box-runner/docs/black-box-runner-recipe-matrix.md`
  - `docs/superpowers/plans/2026-07-08-api-v1-black-box-runner-implementation-plan.md`
- Commands run:
  - `npm run check:shared-test` passed.
  - `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts packages/tests/shared-test/api-v1-black-box-run.test.ts` passed with 19 tests.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-auth-session.json --validate --strict` passed.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-group-presence.json --validate --strict` passed.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-client-state.json --validate --strict` passed.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-websocket-topic-routing.json --validate --strict` passed.
  - `deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts -c packages/shared-test/black-box-runner/examples/api-v1-scope-isolation.json --validate --strict` passed.
  - `npm run test:api-v1:black-box:memory` passed after approved local-network escalation: 5 passed, 0 failed, 0 skipped.
  - `npm run db:up` failed inside the sandbox with Docker socket permission denied.
  - `npm run db:up` with approved Docker access began pulling `postgres:16` but did not complete after several poll windows; the command was interrupted.
  - `docker compose ps postgres` showed no running Postgres service after the interrupted pull/start.
  - `ls .artifacts/api-v1-black-box/memory` showed five recipe artifact directories plus `matrix-summary.json` and `api-v1-server.log`.
  - `find .artifacts/api-v1-black-box/memory -name failures.json -print` found five recipe failure bundles.
  - `sed -n '1,220p' .artifacts/api-v1-black-box/memory/matrix-summary.json` showed `PASSED: 5`, `FAILED: 0`, and `SKIPPED: 0`.
  - `rg -n '"failure": [1-9]|"FAILED": [1-9]|"SKIPPED": [1-9]' .artifacts/api-v1-black-box/memory/matrix-summary.json .artifacts/api-v1-black-box/memory -g failures.json` returned no matches.
  - `ruby -e 'require "yaml"; YAML.load_file(".github/actions/api-v1-black-box-test/action.yml"); puts "ok"'` passed.
  - `ruby -e 'require "yaml"; %w[.github/workflows/release-gate.yml .github/workflows/api-v1-black-box.yml].each { |f| YAML.load_file(f) }; puts "ok"'` passed.
  - `deno run -A packages/shared-test/black-box-runner/recipe-matrix.mts --help` passed and advertised `api-v1-black-box`.
  - `npm run test:api-v1:black-box:recipes` failed as expected through required live-gate preflight with unavailable local API responses; it did not run migrations or start the API server.
- Blockers: local Postgres smoke could not run because the Docker-backed Postgres service was unavailable in this environment.
- Implementation notes: docs describe only implemented local/root commands and artifact paths; the manual workflow's pglite-memory job remains opt-in.
- Commit: `d30cefb` (`docs: document api-v1 black-box validation`).
- Follow-up validation still required: run `npm run db:up` and `npm run test:api-v1:black-box:postgres` in an environment with Docker/Postgres available, and validate the new GitHub workflows after pushing.
