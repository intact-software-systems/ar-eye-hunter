# Rallar API-v1 In-Memory Performance Mode

Use this mode when running one API-v1 server process for Rallar middleware and
browser-fleet performance tests without an external Postgres database.

This mode uses PGlite in memory, applies the API-v1 repository schema on
startup, and uses a local in-process queue pub/sub bridge.

## Quick Start

From `apps/api-v1`:

```sh
deno task start:memory
```

To use a different port:

```sh
PORT=18080 deno task start:memory
```

When browser clients read `/api/config` from a non-default API URL, also set the
advertised runtime URLs:

```sh
PORT=18080 \
RALLAR_API_BASE_URL=http://localhost:18080 \
RALLAR_WS_BASE_URL=ws://localhost:18080 \
deno task start:memory
```

The task sets:

```text
RALLAR_SQL_BACKEND=pglite-memory
RALLAR_PGLITE_DATA_DIR=memory://
RALLAR_PGLITE_SCHEMA_INIT=auto
RALLAR_DB_PUBSUB=local
RALLAR_ICE_MODE=local
RALLAR_LOGIN_USER_RATE_LIMIT=100
```

`RALLAR_API_BASE_URL` and `RALLAR_WS_BASE_URL` optionally override the static
`/api/config` URL values. The black-box Playwright memory-mode scripts derive
both from `VITE_RALLAR_API_BASE_URL`. Those scripts also set
`RALLAR_ICE_MODE=local` and `RALLAR_LOGIN_USER_RATE_LIMIT=100` for no-cost
repeated browser smoke runs.

Expected startup log shape:

```text
Rallar API-v1 SQL backend: pglite-memory; DATABASE_URL: not configured; RALLAR_PGLITE_DATA_DIR: configured
Rallar API-v1 PGlite schema init: auto
Rallar API-v1 DB pub/sub: local
Server started on port 8080. http://localhost:8080/api/docs
```

If `DATABASE_URL` is present in the environment, PGlite mode reports it as
`ignored`; the in-memory run does not connect to external Postgres.

## Black-Box Validation

Run the API-backed `apps/rallar-black-box` smoke suite against memory mode:

```sh
npm run test:rallar:full-stack:memory
```

Run the gated three-browser RTC baseline against memory mode:

```sh
npm run test:rallar:full-stack:memory:live-rtc-3
```

These scripts start API-v1 with PGlite memory persistence, automatic schema
bootstrap, and local queue pub/sub. They do not require `DATABASE_URL`, Metered
ICE credentials, or an external Postgres process. The RTC memory script uses the
static API-v1 fixture users `alice/secret`, `bob/secret`, and `charlie/secret`,
with isolated local defaults `VITE_RALLAR_API_BASE_URL=http://localhost:18080`
and `VITE_RALLAR_SPA_BASE_URL=http://localhost:5177`.
The gated RTC baseline validates realtime and `messages.rtc` with fresh
three-browser agent trios against the same in-memory API-v1 group, which keeps
the persistence-mode validation independent from same-page close/reconnect
behavior. Detailed coverage and artifact notes live in
[`apps/rallar-black-box/docs/api-v1-memory-mode-validation.md`](../apps/rallar-black-box/docs/api-v1-memory-mode-validation.md).

## Configuration

`RALLAR_SQL_BACKEND` selects the SQL backend:

- `postgres`: production default, requires `DATABASE_URL`.
- `pglite-memory`: ephemeral in-memory SQL for single-process performance runs.
- `pglite-file`: PGlite file-backed mode, requires `RALLAR_PGLITE_DATA_DIR`.

`RALLAR_PGLITE_SCHEMA_INIT` controls schema bootstrapping:

- `auto`: apply the API-v1 in-memory schema for PGlite startup.
- `disabled`: skip schema bootstrapping.

`RALLAR_DB_PUBSUB` controls queue pub/sub:

- `postgres`: default for Postgres SQL mode.
- `local`: default for PGlite SQL mode.
- `disabled`: skip queue pub/sub bridge installation.

`RALLAR_API_BASE_URL` and `RALLAR_WS_BASE_URL` control the runtime config served
from `/api/config`. If `RALLAR_API_BASE_URL` is set and `RALLAR_WS_BASE_URL` is
omitted, the server derives `ws://` or `wss://` from the API URL.

`RALLAR_ICE_MODE` controls `/api/webrtc/ice`:

- `metered`: default, fetch ICE servers from Metered credentials.
- `local`: return an empty local ICE server list for local browser validation.

`RALLAR_LOGIN_USER_RATE_LIMIT` optionally raises the per-user login limit for
test harnesses that create many short-lived browser sessions.

## Limits

This mode is for behavior and load-shape testing, not production Postgres
tuning. Data is ephemeral in `pglite-memory`, and only one API-v1 process should
be used with the local pub/sub bridge.
