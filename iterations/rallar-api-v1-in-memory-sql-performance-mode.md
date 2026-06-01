# Rallar API-v1 In-Memory SQL Performance Mode

This document captures the proposed iterations for simplifying `apps/api-v1` server-side
persistence during distributed Rallar middleware performance testing.

## Goal

Run one `apps/api-v1` server instance without paying for a managed database, while keeping
the server queryable through SQL and avoiding large changes to the current Postgres-backed
repository code.

The desired mode is intentionally ephemeral:

- one API server process
- in-memory SQL database
- Postgres-like SQL behavior where possible
- easy opt-in through environment configuration
- good enough for Rallar middleware behavior and distributed browser performance tests

This mode is not intended to measure production Postgres performance.

## Current Persistence Shape

The main database seam is `apps/api-v1/src/db/db.ts`. It exports the `sql` proxy used by
the rest of API-v1 and currently builds a `postgres.js` client from `DATABASE_URL`.

The middleware wiring in `apps/api-v1/src/middleware.ts` is Postgres-specific today:

- `ResourceInboxRepository`
- `ResourceInboxResultsRepository`
- `PSqlQueueBox`
- `PSqlRuntimeStateRepository`
- `createPSqlALRuntimeStores`
- Postgres `LISTEN/NOTIFY` queue pub/sub bridge

App data also defaults to Postgres through `PSqlAppDataRepository` in
`apps/api-v1/src/create-rallar-server.ts`.

The useful seam is `packages/shared-server/postgres/PostgresSqlClient.ts`. Its `PSqlSql`
contract is small:

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

PGlite can also be run behind a socket server so `postgres.js` can connect to it as if it
were a normal Postgres endpoint. That may be the smallest migration path, but it should be
validated with API-v1 concurrency tests because PGlite is not a production Postgres server.

## Iteration 1: Introduce Database Backend Configuration

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

## Iteration 2: Add In-Memory Schema Bootstrap

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

## Iteration 3: Implement The PGlite SQL Client Adapter

Add a `PSqlSql` compatible adapter for `pglite-memory`.

Two possible approaches:

- socket mode: start PGlite socket server and keep using `postgres.js`
- direct mode: implement a small tagged-template adapter over PGlite APIs

Recommended starting point: socket mode if it preserves `postgres.js` query behavior with
less code.

Expected output:

- `getSql()` returns Postgres or PGlite based on config
- `sql.begin(...)` works for transactional repository code
- array interpolation supports current `where x in ${sql([...values])}` usage

Acceptance checks:

- `PSqlRuntimeStateRepository` smoke tests pass
- `ResourceInboxRepository` smoke tests pass
- `PSqlAppDataRepository` smoke tests pass

## Iteration 4: Replace Postgres Pub/Sub In Single-Server Mode

For one server instance, Postgres `LISTEN/NOTIFY` is not needed for cross-process
propagation. The current bridge should become configurable.

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

- WebSocket inbox and outbox messages still move through the server in memory mode
- distributed browser agents still receive state sync and message delivery

## Iteration 5: Wire API-v1 Startup For Performance Runs

Make the performance-test mode easy to run locally and in a cheap single-instance deploy.

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

## Iteration 6: Distributed Black-Box Validation

Use `apps/rallar-black-box` as the validation harness for the new persistence mode.

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

## Risks And Constraints

PGlite is useful for reducing cost and simplifying distributed test environments, but it
will not perfectly model managed Postgres under contention.

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

This keeps the blast radius small while proving the hard part: whether the current
Postgres-shaped repositories can run against an embedded in-memory SQL backend without
rewriting the Rallar middleware.
