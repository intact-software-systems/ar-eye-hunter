# API V1 Black-Box Runner Design

## Goal

Add a no-browser black-box test layer for `apps/api-v1` using the existing
`packages/shared-test/black-box-runner` CLI and JSON recipe matrix. The tests
must run locally and in GitHub Actions, and `apps/api-v1` must be running as the
external system under test.

The required CI backend is Postgres. A pglite-memory backend is supported as an
optional fast/local variant and remains off by default.

## Non-Goals

- Do not use Playwright, browser providers, `rallar-browser`, or
  `rallar-remote-browser`.
- Do not validate real WebRTC data channels or RTC provider behavior.
- Do not add first-class Rallar facade commands to the runner recipe language.
- Do not make `apps/api-v1` aware of the test recipes.

## Architecture

The recipe layer stays in `packages/shared-test/black-box-runner`. Recipes treat
`apps/api-v1` as an external service and use only provider-neutral runner steps:

- `http` and `http.request` for REST API calls.
- `ws.open`, `ws.send`, `ws.wait`, and `ws.close` for raw WebSocket behavior.
- `set` for safe value derivation and redacted auth material.
- `assert` for cross-step comparisons.

GitHub Actions owns server orchestration. The action starts `apps/api-v1`, waits
for `/api/config`, runs the black-box recipe matrix profile, captures server
logs and runner artifacts, and stops the server.

Recipe expectations should be backend-neutral. Backend selection belongs in
scripts and action environment, not in recipe JSON, unless a later test covers a
documented backend-specific contract.

## Backends

### Postgres

Postgres is the default and required CI backend.

- Use the existing GitHub Actions Postgres service.
- Run migrations before starting `apps/api-v1`.
- Start `apps/api-v1` with `DATABASE_URL`, `RALLAR_ICE_MODE=local`, and a raised
  login rate limit for deterministic test accounts.
- Run the `api-v1-black-box` recipe profile in strict mode.

This path proves the externally observable API contract against the durable
database path used by deployment gates.

### Pglite Memory

Pglite-memory is optional and default off.

- Start `apps/api-v1` with `RALLAR_SQL_BACKEND=pglite-memory`,
  `RALLAR_PGLITE_DATA_DIR=memory://`, `RALLAR_PGLITE_SCHEMA_INIT=auto`,
  `RALLAR_DB_PUBSUB=local`, `RALLAR_ICE_MODE=local`, and a raised login rate
  limit.
- Use the same recipes and profile as Postgres.
- Expose as a local convenience command and optional manual workflow input.

This path gives quick local feedback without requiring Postgres.

## Recipe Catalog

Create a no-browser API recipe profile named `api-v1-black-box`. The first
catalog should be small and focused:

- `api-v1-auth-session.json`
  - Register or tolerate an existing test user.
  - Login, derive redacted bearer auth, logout.
  - Reject invalid login, missing bearer token, and missing `x-client-id`.

- `api-v1-group-presence.json`
  - Login.
  - Create or reuse a group under `applicationId/workspaceId`.
  - Join the group, connect group presence, heartbeat, read snapshot, read
    events/page, disconnect presence, and logout.

- `api-v1-client-state.json`
  - Login.
  - Upsert client principal and instance.
  - Connect, heartbeat, read, and disconnect a client session.
  - Read client snapshot, presence, and event pages.

- `api-v1-websocket-topic-routing.json`
  - Login.
  - Create/join group and connect presence.
  - Request a WebSocket ticket, open `/api/ws/:sessionId`, send raw AL payloads,
    assert an observable self/unicast routed message, close cleanly, disconnect
    presence, and logout.

- `api-v1-scope-isolation.json`
  - Create the same `groupId` in separate application/workspace scopes.
  - Assert reads and events stay scoped.
  - Assert wrong-principal or unauthorized reads/mutations are rejected.

CRDT admin HTTP coverage is intentionally excluded from the required first
profile unless deterministic admin credentials are provisioned. It can be added
later as a separate optional profile.

## Scripts

Add root/package convenience commands with clear boundaries:

- `npm run test:api-v1:black-box:postgres`
  - Start or target Postgres-backed `apps/api-v1`, run the strict profile, write
    artifacts under `.artifacts/api-v1-black-box/postgres`.

- `npm run test:api-v1:black-box:memory`
  - Start or target pglite-memory `apps/api-v1`, run the same strict profile,
    write artifacts under `.artifacts/api-v1-black-box/memory`.

- `npm run test:api-v1:black-box:recipes`
  - Run the recipe profile against an already-running API using
    `RALLAR_API_BASE_URL` and `RALLAR_WS_BASE_URL`.

Shared-test workspace scripts may wrap the recipe matrix directly, while root
scripts should be the discoverable entry points for local use.

## GitHub Action

Add a repo-local composite action:

```text
.github/actions/api-v1-black-box-test/action.yml
```

Inputs:

- `backend`: `postgres` by default; also accepts `pglite-memory`.
- `api-port`: default `18080`.
- `artifact-dir`: default `.artifacts/api-v1-black-box`.
- `profile`: default `api-v1-black-box`.
- `strict`: default `true`.
- `run-migrations`: default `true` for Postgres and ignored for pglite-memory.

Responsibilities:

1. Build environment variables for the selected backend.
2. Run migrations when the backend is Postgres.
3. Start `apps/api-v1` in the background and capture logs.
4. Wait until `/api/config` responds.
5. Run the black-box runner matrix profile in strict mode.
6. Stop the server process.
7. Leave runner artifacts and server logs in the artifact directory for workflow
   upload.

## GitHub Workflow

Add the required Postgres black-box job to the existing reusable
`.github/workflows/release-gate.yml`. This makes branch builds inherit the job
through `branch-release-gate.yml` and makes main builds inherit it through
`deploy.yml`.

- Default job: Postgres backend only.
- Optional manual workflow input on a dedicated helper workflow:
  `include_memory`.
- When `include_memory` is true, run a second job or matrix entry with
  `backend=pglite-memory`.

CI should fail if the API fails to start, preflight fails, a required recipe is
skipped, or any recipe exits non-zero.

## Artifacts And Diagnostics

Always write artifacts under backend-specific folders:

```text
.artifacts/api-v1-black-box/postgres
.artifacts/api-v1-black-box/memory
```

Keep at least:

- `matrix-summary.json`
- `report.json`
- `events.jsonl`
- `failures.json`
- `metadata.json`
- `artifact-index.json`
- `expanded-recipe.json`
- API server log output

Enable runner correlation headers for HTTP recipes so failures can be matched
to API timing logs. Keep secrets in variables or transforms marked as secret, so
artifacts remain redacted.

## Validation

Before landing the implementation:

1. Run recipe validation with strict mode for the new profile.
2. Run `npm run check:shared-test`.
3. Run the pglite-memory black-box command as a fast smoke.
4. Run the Postgres black-box command locally when Postgres is available, and
   require it in GitHub Actions.

Report skipped checks explicitly. Generated artifacts remain under
`.artifacts/` and should not be committed.

## Deferred Work

CRDT admin HTTP coverage belongs in a later optional profile after deterministic
admin credentials are provisioned for local and CI runs.
