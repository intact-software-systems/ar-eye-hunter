# Rallar API-v1 In-Memory SQL Performance Mode

This document captures the proposed iterations for simplifying `apps/api-v1`
server-side persistence during distributed Rallar middleware performance
testing.

## Goal

Run one `apps/api-v1` server instance without paying for a managed database,
while keeping the server queryable through SQL and avoiding large changes to the
current Postgres-backed repository code.

The desired mode is intentionally ephemeral:

- one API server process
- in-memory SQL database
- Postgres-like SQL behavior where possible
- easy opt-in through environment configuration
- good enough for Rallar middleware behavior and distributed browser performance
  tests

This mode is not intended to measure production Postgres performance.

## Current Persistence Shape

The main database seam is `apps/api-v1/src/db/db.ts`. It exports the `sql` proxy
used by the rest of API-v1 and currently builds a `postgres.js` client from
`DATABASE_URL`.

The middleware wiring in `apps/api-v1/src/middleware.ts` is Postgres-specific
today:

- `ResourceInboxRepository`
- `ResourceInboxResultsRepository`
- `PSqlQueueBox`
- `PSqlRuntimeStateRepository`
- `createPSqlALRuntimeStores`
- Postgres `LISTEN/NOTIFY` queue pub/sub bridge

App data also defaults to Postgres through `PSqlAppDataRepository` in
`apps/api-v1/src/create-rallar-server.ts`.

The useful seam is `packages/shared-server/postgres/PostgresSqlClient.ts`. Its
`PSqlSql` contract is small:

- tagged-template query execution
- array interpolation for `IN (...)` fragments
- `begin(...)` for transactions

That makes a Postgres-compatible in-process adapter realistic.

## Postgres Features That Must Be Preserved

The current SQL uses several Postgres-specific behaviors:

- `ON CONFLICT`
- `RETURNING`
- `now()`
- sequences / `bigserial`
- `SELECT ... FOR UPDATE SKIP LOCKED`
- `pg_advisory_xact_lock(hashtextextended(...))`
- `LISTEN/NOTIFY`

Because of this, SQLite is a poor fit unless the repositories are rewritten. A
Postgres-compatible embedded engine is the better path.

## Recommended Backend

Use PGlite as the first candidate.

Recommended shape:

```text
RALLAR_SQL_BACKEND=postgres | pglite-memory | pglite-file
DATABASE_URL=postgresql://app:app@localhost:5432/appdb?schema=public
RALLAR_PGLITE_DATA_DIR=memory://
RALLAR_PGLITE_SCHEMA_INIT=auto
RALLAR_DB_PUBSUB=postgres | local | disabled
```

For the first implementation, prefer `pglite-memory` and local process pub/sub.

PGlite can also be run behind a socket server so `postgres.js` can connect to it
as if it were a normal Postgres endpoint. That may be the smallest migration
path, but it should be validated with API-v1 concurrency tests because PGlite is
not a production Postgres server.

## Iteration 1: Introduce Database Backend Configuration

Status: completed on 2026-06-01.

Add a small config module for API-v1 persistence mode.

Expected output:

- `RALLAR_SQL_BACKEND` reader with default `postgres`
- validation for allowed values
- startup log showing selected backend
- no behavior change when unset

Acceptance checks:

- `deno task check` still passes for `apps/api-v1`
- current `DATABASE_URL` Postgres path remains the default
- missing `DATABASE_URL` only fails in `postgres` mode

Completed notes:

- Added `apps/api-v1/src/db/database-config.ts` as the API-v1 persistence-mode
  seam.
- `RALLAR_SQL_BACKEND` now defaults to `postgres` and validates `postgres`,
  `pglite-memory`, and `pglite-file`.
- API-v1 startup logs the selected SQL backend and whether `DATABASE_URL` is
  configured without printing the URL value.
- `apps/api-v1/src/db/db.ts` now reads the backend config before constructing
  the `postgres.js` client. The existing Postgres path remains unchanged when
  `RALLAR_SQL_BACKEND` is unset.
- Missing `DATABASE_URL` is enforced by the Postgres URL reader for
  `RALLAR_SQL_BACKEND=postgres`; non-Postgres backends can be configured without
  a `DATABASE_URL`, though their SQL client adapter is intentionally still not
  implemented until the later PGlite iteration.

Verification:

- `cd apps/api-v1 && deno test --allow-env test/db/database-config.test.ts`
  passed.
- `cd apps/api-v1 && deno task check` passed.

## Iteration 2: Add In-Memory Schema Bootstrap

Status: completed on 2026-06-01.

Create an idempotent SQL schema for the in-memory backend.

The schema should create these tables directly in their final shape:

- `resource_inbox`
- `resource_inbox_results`
- `runtime_state_store`
- `app_data_store`

Expected output:

- one schema file for ephemeral startup
- no Prisma migration execution during in-memory startup
- indexes matching the current Prisma schema where they matter for tests

Acceptance checks:

- the schema can be applied repeatedly to an empty in-memory database
- repository smoke tests can insert, update, select, delete, and expire rows

Completed notes:

- Added `apps/api-v1/src/db/in-memory-schema.sql` as the ephemeral startup
  schema for `pglite-memory` and `pglite-file`.
- The schema creates `resource_inbox`, `resource_inbox_results`,
  `runtime_state_store`, and `app_data_store` directly in their current final
  Prisma shape.
- The schema includes the primary keys, unique keys, and indexes used by the
  current repository queries and expiration cleanup paths.
- Added `apps/api-v1/src/db/in-memory-schema-bootstrap.ts` so future PGlite
  client wiring can apply the schema only for PGlite backends. It deliberately
  leaves the default Postgres path untouched.
- Added table-level repository-shaped PGlite smoke tests for insert,
  conflict-update/upsert, select, expiry delete, and row delete/count behavior.
  Full repository-class smoke tests remain part of Iteration 3, after the
  `PSqlSql` adapter exists.

Verification:

- `cd apps/api-v1 && deno test --allow-read test/db/in-memory-schema-bootstrap.test.ts`
  passed.

## Iteration 3: Implement The PGlite SQL Client Adapter

Status: completed on 2026-06-01.

Add a `PSqlSql` compatible adapter for `pglite-memory`.

Two possible approaches:

- socket mode: start PGlite socket server and keep using `postgres.js`
- direct mode: implement a small tagged-template adapter over PGlite APIs

Recommended starting point: socket mode if it preserves `postgres.js` query
behavior with less code.

Expected output:

- `getSql()` returns Postgres or PGlite based on config
- `sql.begin(...)` works for transactional repository code
- array interpolation supports current `where x in ${sql([...values])}` usage

Acceptance checks:

- `PSqlRuntimeStateRepository` smoke tests pass
- `ResourceInboxRepository` smoke tests pass
- `PSqlAppDataRepository` smoke tests pass

Completed notes:

- Added `apps/api-v1/src/db/pglite-sql-adapter.ts` as a direct PGlite
  implementation of the shared `PSqlSql` contract.
- The adapter supports tagged-template execution, `sql([...])` array fragments
  for `IN (...)` clauses, transaction callbacks through `begin(...)`, nested
  transaction callbacks inside an active transaction, and small `listen` /
  `notify` compatibility methods for the existing API-v1 SQL facade shape.
- `apps/api-v1/src/db/db.ts` now selects Postgres or PGlite from
  `RALLAR_SQL_BACKEND`. PGlite clients apply the Iteration 2 schema before the
  first query without running Prisma migrations.
- Added `RALLAR_PGLITE_DATA_DIR` config support. `pglite-memory` defaults to
  `memory://`; `pglite-file` requires an explicit filesystem path.
- Repository smoke tests now run the production shared-server repository classes
  against the PGlite adapter: runtime state, resource inbox, resource-inbox
  results, and app data.
- API-v1 still installs the Postgres queue pub/sub bridge by default. Replacing
  that bridge for single-process PGlite runs remains Iteration 4.

Verification:

- `cd apps/api-v1 && deno test --allow-read test/db/pglite-sql-adapter.test.ts`
  passed.
- `cd apps/api-v1 && deno test --allow-read test/db/in-memory-schema-bootstrap.test.ts`
  passed.
- `cd apps/api-v1 && deno test --allow-env test/db/database-config.test.ts`
  passed.
- `cd apps/api-v1 && deno task check` passed.

## Iteration 4: Replace Postgres Pub/Sub In Single-Server Mode

Status: completed on 2026-06-01.

For one server instance, Postgres `LISTEN/NOTIFY` is not needed for
cross-process propagation. The current bridge should become configurable.

Recommended configuration:

```text
RALLAR_DB_PUBSUB=postgres   # production default
RALLAR_DB_PUBSUB=local      # in-process bridge
RALLAR_DB_PUBSUB=disabled   # only if queue polling is proven sufficient
```

Expected output:

- Postgres bridge remains the default
- PGlite mode uses local in-process pub/sub by default
- no dependency on `sql.notify(...)` or `sql.listen(...)` in memory mode

Acceptance checks:

- WebSocket inbox and outbox messages still move through the server in memory
  mode
- distributed browser agents still receive state sync and message delivery

Completed notes:

- Added `apps/api-v1/src/db/database-pubsub-config.ts` for
  `RALLAR_DB_PUBSUB=postgres | local | disabled`.
- The default mode is now `postgres` for `RALLAR_SQL_BACKEND=postgres` and
  `local` for `pglite-memory` / `pglite-file`.
- `RALLAR_DB_PUBSUB=postgres` is rejected for PGlite SQL backends because the
  existing API-v1 Postgres bridge still uses `postgres.js` listener connections.
- Added `apps/api-v1/src/db/local-queue-pubsub-bridge.ts`, an in-process bridge
  that shares messages across publishers on the same local bus while filtering
  the current publisher id to match the old Postgres self-message behavior.
- Added a disabled no-op bridge for runs where queue polling is intentionally
  the only delivery mechanism.
- `apps/api-v1/src/middleware.ts` now installs the queue pub/sub bridge from the
  selected mode and skips bridge installation entirely for `disabled`.
- API-v1 startup logs the selected DB pub/sub mode.

Verification:

- `cd apps/api-v1 && deno test test/db/database-pubsub-config.test.ts` passed.
- `cd apps/api-v1 && deno test test/db/local-queue-pubsub-bridge.test.ts`
  passed.
- `cd apps/api-v1 && deno test --allow-read test/db/pglite-sql-adapter.test.ts`
  passed.
- `cd apps/api-v1 && deno test --allow-env test/db/database-config.test.ts`
  passed.
- `cd apps/api-v1 && deno task check` passed.

## Iteration 5: Wire API-v1 Startup For Performance Runs

Status: completed on 2026-06-01.

Make the performance-test mode easy to run locally and in a cheap
single-instance deploy.

Expected output:

- documented env block for in-memory mode
- optional Deno task such as `deno task start:memory`
- clear startup logs for DB backend, schema init, and pub/sub mode

Example target:

```text
RALLAR_SQL_BACKEND=pglite-memory
RALLAR_PGLITE_DATA_DIR=memory://
RALLAR_PGLITE_SCHEMA_INIT=auto
RALLAR_DB_PUBSUB=local
```

Acceptance checks:

- starting the server requires no external database
- `/api/docs` and `/api/config` still load
- auth, groups, clients, WebSocket, and RTC black-box flows can run against it

Completed notes:

- Added `deno task start:memory` in `apps/api-v1/deno.json`.
- The task sets:

  ```text
  RALLAR_SQL_BACKEND=pglite-memory
  RALLAR_PGLITE_DATA_DIR=memory://
  RALLAR_PGLITE_SCHEMA_INIT=auto
  RALLAR_DB_PUBSUB=local
  ```

- Added `RALLAR_PGLITE_SCHEMA_INIT=auto | disabled` config. PGlite backends
  default to `auto`; Postgres defaults to `disabled`.
- PGlite schema bootstrap now respects `RALLAR_PGLITE_SCHEMA_INIT=disabled`.
- API-v1 startup logs SQL backend, PGlite schema init mode, and DB pub/sub mode.
  When PGlite mode sees a `DATABASE_URL` in the environment, the startup log
  reports it as `ignored` rather than `configured`.
- API-v1 now reads `PORT`, defaulting to `8080`, so local smoke tests and
  single-instance deploys can choose a port without code changes.
- Added `docs/rallar-api-v1-in-memory-performance-mode.md` with the memory-mode
  command, environment block, startup log shape, and limits.

Verification:

- `cd apps/api-v1 && PORT=18080 deno task start:memory` started without
  requiring an external Postgres database.
- Startup logs showed `RALLAR_SQL_BACKEND=pglite-memory`,
  `RALLAR_PGLITE_SCHEMA_INIT=auto`, `RALLAR_DB_PUBSUB=local`, and
  `DATABASE_URL: ignored`.
- `GET http://localhost:18080/api/docs` returned `200` with `text/html`.
- `GET http://localhost:18080/api/config` returned `200` with
  `application/json`.
- Background client-session and group-presence expiry jobs ran successfully
  against the PGlite-backed repositories during the smoke run.
- `cd apps/api-v1 && deno test --allow-env test/db/database-config.test.ts`
  passed.
- `cd apps/api-v1 && deno test --allow-read test/db/in-memory-schema-bootstrap.test.ts`
  passed.
- `cd apps/api-v1 && deno test test/db/database-pubsub-config.test.ts` passed.
- `cd apps/api-v1 && deno test test/db/local-queue-pubsub-bridge.test.ts`
  passed.
- `cd apps/api-v1 && deno test --allow-read test/db/pglite-sql-adapter.test.ts`
  passed.
- `cd apps/api-v1 && deno task check` passed.

Remaining validation:

- Full auth, group/client, WebSocket, and RTC black-box flows are covered by the
  Iteration 6 validation harness.

## Iteration 6: Distributed Black-Box Validation

Status: completed on 2026-06-01.

Use `apps/rallar-black-box` as the validation harness for the new persistence
mode.

Expected output:

- full-stack smoke run against API-v1 in memory mode
- three-browser RTC baseline against API-v1 in memory mode
- artifact notes comparing memory mode to normal Postgres mode

Acceptance checks:

- auth flow works
- group create/join/leave works
- WebSocket ticket and upgrade flow works
- state sync events arrive
- RTC recipe baseline still passes
- no external Postgres process is required

Completed notes:

- Added `apps/rallar-black-box/playwright-full-stack-api-server.ts` as the
  Playwright server-mode seam for full-stack API-v1 tests.
- `RALLAR_BLACK_BOX_API_MODE=memory` now starts API-v1 with
  `RALLAR_SQL_BACKEND=pglite-memory`, `RALLAR_PGLITE_DATA_DIR=memory://`,
  `RALLAR_PGLITE_SCHEMA_INIT=auto`, `RALLAR_DB_PUBSUB=local`,
  `RALLAR_ICE_MODE=local`, and a relaxed login-user limit for repeated browser
  sign-ins.
- The memory full-stack scripts derive API-v1 `PORT`, `RALLAR_API_BASE_URL`, and
  `RALLAR_WS_BASE_URL` from `VITE_RALLAR_API_BASE_URL`, so the SPA and
  `/api/config` agree when tests run on a non-default port.
- Added `RALLAR_API_BASE_URL` / `RALLAR_WS_BASE_URL` runtime config overrides in
  API-v1.
- Added `RALLAR_ICE_MODE=local` so browser RTC validation can run without
  Metered ICE credentials.
- Added `RALLAR_LOGIN_USER_RATE_LIMIT` / `RALLAR_LOGIN_IP_RATE_LIMIT`
  configurability for API-v1 login throttling.
- Added the memory-mode black-box scripts:
  `test:e2e:rallar-black-box:full-stack:memory` and
  `test:e2e:rallar-black-box:full-stack:memory:live-rtc-3`.
- The three-browser RTC memory script uses static API-v1 fixture users
  `alice/secret`, `bob/secret`, and `charlie/secret`.
- The RTC baseline now uses one fresh three-browser trio for realtime and one
  fresh three-browser trio for `messages.rtc`. That validates both live
  transport families against the same in-memory API-v1 group while avoiding
  same-page close/reconnect state from one transport contaminating the other.
- Updated the full-stack Playwright assertions for the current command-center
  labels, raw WebSocket error text, and REST workbench selectors.
- Added `apps/rallar-black-box/docs/api-v1-memory-mode-validation.md` with
  command usage, acceptance coverage, and memory-versus-Postgres artifact notes.

Memory versus Postgres artifact notes:

- Postgres full-stack runs still use `DATABASE_URL`, Prisma-managed schema, and
  the Postgres `LISTEN/NOTIFY` pub/sub bridge by default.
- Memory full-stack runs use PGlite, automatic in-memory schema bootstrap, and
  local in-process queue pub/sub. The control-server reports and Playwright
  artifacts are the same shape as Postgres runs, but timing should be
  interpreted as middleware/browser load shape rather than production database
  performance.
- Memory runs require no external Postgres process, no `DATABASE_URL`, and no
  Metered ICE credentials.

Verification:

- `cd apps/api-v1 && deno test --allow-env --allow-read test/config-repo.test.ts test/ice-route.test.ts`
  passed.
- `cd apps/api-v1 && deno task check` passed.
- `npx vitest run packages/tests/rallar-black-box/full-stack-api-server-mode.test.ts`
  passed.
- `npm --workspace rallar-black-box run typecheck` passed.
- `VITE_RALLAR_API_BASE_URL=http://localhost:18080 npm run test:e2e:rallar-black-box:full-stack:memory -- --project chromium`
  passed with 7 full-stack memory-mode tests.
- `VITE_RALLAR_API_BASE_URL=http://localhost:18080 npm run test:e2e:rallar-black-box:full-stack:memory:live-rtc-3 -- --project chromium`
  passed the three-browser RTC baseline; the exhaustive live scenario matrix
  remains opt-in behind `RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1`.

## Risks And Constraints

PGlite is useful for reducing cost and simplifying distributed test
environments, but it will not perfectly model managed Postgres under contention.

Known risks:

- concurrency semantics may differ from real Postgres
- `FOR UPDATE SKIP LOCKED` behavior must be verified under queue load
- advisory-lock calls may need a compatibility strategy in single-process mode
- socket mode may serialize more than production Postgres would
- large performance runs may become CPU-bound inside the API process

The safest interpretation of this mode is:

- good for Rallar middleware behavior testing
- good for browser fleet and WebSocket/RTC load experiments
- not authoritative for production database tuning

## Recommended First Slice

Start with a minimal vertical slice:

1. Add `RALLAR_SQL_BACKEND`.
2. Add PGlite dependency.
3. Add in-memory schema bootstrap.
4. Run only `runtime_state_store` repository smoke tests.
5. Add `resource_inbox` and `app_data_store` coverage.
6. Wire API-v1 startup.
7. Run `rallar-black-box` full-stack smoke tests.

This keeps the blast radius small while proving the hard part: whether the
current Postgres-shaped repositories can run against an embedded in-memory SQL
backend without rewriting the Rallar middleware.
